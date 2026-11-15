import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';

describe.skipIf(!process.env.POSTGRES_TEST_URL)('immutable movement audit detail',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 const report=(q:Record<string,string>={},i=2)=>f.get('/inventory/reports/movements?'+new URLSearchParams({deviceId:f.actors[i].device,...q}),i);
 const action=(kind:string,countId:string,i=2,extra:object={})=>({operationId:randomUUID(),deviceId:f.actors[i].device,kind,countId,reason:'SYNTHETIC actual count decision',evidence:'=CI signed count sheet',...extra});
 it('shows original count observation and separate approval, QA decision and conserved split after later changes',async()=>{
  const stockId=await f.stock(),initial=await report({stockId});
  expect(initial.statusCode,initial.body).toBe(200);
  expect(initial.json().items[0].audit).toBeNull();
  expect(initial.json().items[1].audit).toEqual({type:'quality',disposition:'release',evidence:'QA certificate CI'});
  const opening=action('open',randomUUID());
  expect((await f.post('/inventory/counts/operations',opening,2)).statusCode).toBe(201);
  const stock=(await f.get('/inventory/changes?deviceId='+f.actors[2].device+'&cursor=0&limit=100',2)).json().changes.at(-1).stock;
  const observation=action('observe',opening.countId,2,{stock,quantity:950});
  const observed=await f.post('/inventory/counts/operations',observation,2);expect(observed.statusCode,observed.body).toBe(201);
  expect((await report({stockId})).json()).toEqual(initial.json());
  const correction=action('correct',opening.countId,1,{observationId:observation.operationId,expectedRevision:2});
  const approved=await f.post('/inventory/counts/operations',correction,1);expect(approved.statusCode,approved.body).toBe(201);
  const split={operationId:randomUUID(),childOperationId:randomUUID(),parentStockId:stockId,childStockId:randomUUID(),deviceId:f.actors[1].device,locationId:f.location,quantity:300,expectedRevision:3,reason:'SYNTHETIC partial package',evidence:'CI sealed child weight'};
  const divided=await f.post('/inventory/stocks/'+stockId+'/splits',split,1);expect(divided.statusCode,divided.body).toBe(201);
  const frozen=await report(),upper=String(frozen.json().throughSequence);
  expect(frozen.statusCode,frozen.body).toBe(200);
  const corrected=frozen.json().items.find((r:{kind:string})=>r.kind==='count_adjustment');
  expect(corrected).toMatchObject({quantity:50,onHandAfter:950,actorId:f.actors[1].id,audit:{
   type:'count',countId:opening.countId,observationId:observation.operationId,
   recordedOnHand:1000,countedOnHand:950,observedRevision:2,
   observedBy:f.actors[2].id,observedDeviceId:f.actors[2].device,
   observedAt:observed.json().event.recordedAt,observationEvidence:'=CI signed count sheet',evidence:'=CI signed count sheet',
  }});
  const genealogy={type:'split',parentStockId:stockId,childStockId:split.childStockId,parentOperationId:split.operationId,childOperationId:split.childOperationId,parentOnHandBefore:950,parentOnHandAfter:650,evidence:'CI sealed child weight'};
  expect(frozen.json().items.filter((r:{kind:string})=>r.kind.startsWith('split')).map((r:{audit:unknown})=>r.audit)).toEqual([genealogy,genealogy]);
  const held=await f.post('/inventory/stocks/'+stockId+'/quality-dispositions',{operationId:randomUUID(),stockId,deviceId:f.actors[0].device,expectedRevision:4,disposition:'hold',reason:'SYNTHETIC later QA hold',evidence:'CI later recall'});expect(held.statusCode,held.body).toBe(201);
  const retained=await report({until:upper});expect(retained.json()).toEqual(frozen.json());
  const pages=[];let after='0';
  do{const p=await report({until:upper,after,limit:'1'},1);expect(p.statusCode,p.body).toBe(200);pages.push(...p.json().items);after=String(p.json().nextAfter);if(!p.json().hasMore)break;}while(true);
  expect(pages).toEqual(frozen.json().items);
  expect((await report({kind:'quality_change'})).json().items.at(-1).audit).toEqual({type:'quality',disposition:'hold',evidence:'CI later recall'});
  expect(JSON.stringify(retained.json())).not.toMatch(/request_payload|password_hash|proofToken/);
 });
 it('links an eligible unused return to its actual received issue and original source package',async()=>{
  const {id,issue}=await f.reserved();
  for(const [kind,revision,i,extra] of [['approve',2,1,{expectedStockRevision:3}],['dispatch',3,1,{expectedStockRevision:3}],['receive',4,4,{}]] as const){const r=await f.act(issue.id,f.operation(kind,revision,i,extra),i);expect(r.statusCode,r.body).toBe(201);}
  const child=randomUUID(),body={operationId:randomUUID(),deviceId:f.actors[2].device,issueId:issue.id,sourceStockId:id,productionBatchId:f.batch,kind:'return',expectedSettlementRevision:1,quantity:200,stockId:child,locationId:f.location,expectedSourceRevision:4,condition:'untouched_unused',reason:'SYNTHETIC unused material',evidence:'CI original package inspected'};
  const r=await f.post('/inventory/issues/'+issue.id+'/outcomes',body,2);expect(r.statusCode,r.body).toBe(201);
  const result=await report({kind:'return'});expect(result.statusCode,result.body).toBe(200);
  expect(result.json().items).toMatchObject([{stockId:child,productionBatchId:f.batch,quantity:200,audit:{type:'return',sourceStockId:id,issueId:issue.id,evidence:'CI original package inspected'}}]);
  const before=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;
  await report();expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(before);
 });
 it('keeps a multi-page audited snapshot exact across later receiving activity',async()=>{
  await f.stock();
  const ids=new Set<string>();
  for(let i=0;i<205;i++){
   const operationId=randomUUID();ids.add(operationId);
   const r=await f.post('/inventory/receipts',{operationId,stockId:randomUUID(),deviceId:f.actors[2].device,
    materialId:f.material,locationId:f.location,manufacturerLot:'SYNTHETIC-SCALE-'+i,quantity:i+1,expectedRevision:0,reason:'CI-only pagination acceptance'},2);
   expect(r.statusCode,r.body).toBe(201);
  }
  const first=await report({limit:'100'});expect(first.statusCode,first.body).toBe(200);
  const upper=String(first.json().throughSequence);expect(first.json().hasMore).toBe(true);
  await f.stock();
  const items=[...first.json().items];let after=String(first.json().nextAfter);
  while(true){const p=await report({limit:'100',until:upper,after},1);expect(p.statusCode,p.body).toBe(200);items.push(...p.json().items);if(!p.json().hasMore)break;expect(p.json().nextAfter).toBeGreaterThan(Number(after));after=String(p.json().nextAfter);}
  expect(items).toHaveLength(207);expect(new Set(items.map(r=>r.operationId)).size).toBe(207);
  expect(items.filter(r=>ids.has(r.operationId))).toHaveLength(205);
  expect(items.filter(r=>r.audit!==null)).toHaveLength(1);
  const ledger=(await f.pool.query('SELECT operation_id FROM inventory_operations WHERE organization_id=$1 AND sequence<=$2 ORDER BY sequence',[f.org,upper])).rows;
  expect(items.map(r=>r.operationId)).toEqual(ledger.map(r=>r.operation_id));
 },15000);
});
