import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';

describe.skipIf(!process.env.POSTGRES_TEST_URL)('received issue reconciliation report',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 beforeEach(async()=>{f=await createInventoryHandoffFixture();});
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 const get=(query:Record<string,string>={},i=2)=>f.get('/inventory/reports/reconciliation?'+
  new URLSearchParams({deviceId:f.actors[i].device,...query}),i);
 async function received(){
  const {id,issue}=await f.reserved();
  for(const [kind,revision,actor,extras] of [
   ['approve',2,1,{expectedStockRevision:3}],['dispatch',3,1,{expectedStockRevision:3}],
   ['receive',4,4,{}],
  ] as const){const r=await f.act(issue.id,f.operation(kind,revision,actor,extras),actor);expect(r.statusCode,r.body).toBe(201);}
  return{id,issue};
 }
 async function scrap(issueId:string,stockId:string,quantity=50,revision=1){
  const r=await f.post('/inventory/issues/'+issueId+'/outcomes',{
   operationId:randomUUID(),deviceId:f.actors[1].device,issueId,sourceStockId:stockId,
   productionBatchId:f.batch,kind:'scrap',expectedSettlementRevision:revision,quantity,
   reason:'SYNTHETIC issued scrap',evidence:'CI disposal witness',
  },1);expect(r.statusCode,r.body).toBe(201);
 }
 it('reconciles immutable returns and issued scrap without inventing measurements or another debit',async()=>{
  const {id,issue}=await received();
  const returned=randomUUID();
  const r=await f.post('/inventory/issues/'+issue.id+'/outcomes',{
   operationId:randomUUID(),deviceId:f.actors[2].device,issueId:issue.id,sourceStockId:id,
   productionBatchId:f.batch,kind:'return',expectedSettlementRevision:1,quantity:200,
   stockId:returned,locationId:f.location,expectedSourceRevision:4,condition:'untouched_unused',
   reason:'SYNTHETIC unused return',evidence:'CI package inspection',
  },2);expect(r.statusCode,r.body).toBe(201);
  await scrap(issue.id,id,50,2);
  const count=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n;
  const report=await get({productionBatchId:f.batch,recipientId:f.actors[4].id,materialId:f.material,stockId:id});
  expect(report.statusCode,report.body).toBe(200);
  expect(report.json()).toMatchObject({epoch:f.epoch,hasMore:false,nextAfter:null,items:[{
   issueId:issue.id,stockId:id,productionBatchId:f.batch,recipientId:f.actors[4].id,
   materialId:f.material,manufacturerLot:'SAME-MAKER-LOT',unit:'mg',
   issued:500,returned:200,scrapped:50,consumed:null,consumptionStatus:'not_recorded',outstanding:250,
  }]});
  expect(JSON.stringify(report.json())).not.toMatch(/token_hash|password_hash|request_payload|proofToken/);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(count);
  expect((await f.pool.query('SELECT on_hand::text FROM inventory_stocks WHERE id=$1',[id])).rows[0].on_hand).toBe('500');
  for(const filter of ['productionBatchId','recipientId','materialId','stockId'])expect((await get({[filter]:randomUUID()})).json().items).toEqual([]);
 });
 it('freezes both event streams across pages, later settlements and newly received issues',async()=>{
  await received();await received();
  const first=await get({limit:'1'});expect(first.statusCode,first.body).toBe(200);
  const p=first.json();expect(p.hasMore).toBe(true);
  const bounds={untilIssue:String(p.throughIssueSequence),untilOutcome:String(p.throughOutcomeSequence)};
  const ids=(await get(bounds)).json().items.map((r:{issueId:string})=>r.issueId);
  const target=(await get(bounds)).json().items[1];
  await scrap(target.issueId,target.stockId);await received();
  const next=await get({...bounds,after:p.nextAfter,limit:'1'});
  expect(next.statusCode,next.body).toBe(200);
  expect(next.json()).toMatchObject({hasMore:false,items:[{issueId:ids[1],returned:0,scrapped:0,outstanding:500}]});
  expect((await get(bounds)).json().items.map((r:{issueId:string})=>r.issueId)).toEqual(ids);
  const latest=await get();expect(latest.json().items).toHaveLength(3);
  expect(latest.json().items.find((r:{issueId:string})=>r.issueId===target.issueId).scrapped).toBe(50);
 });
 it('excludes requested/reserved/dispatched issues until actual assigned receipt',async()=>{
  const {issue}=await f.reserved();
  expect((await get()).json().items).toEqual([]);
  await f.act(issue.id,f.operation('approve',2,1,{expectedStockRevision:3}));
  await f.act(issue.id,f.operation('dispatch',3,1,{expectedStockRevision:3}));
  expect((await get()).json().items).toEqual([]);
 });
 it('rejects partial/future snapshot bounds, malformed filters and unbounded pages',async()=>{
  const invalid:Record<string,string>[]=[{untilIssue:'0'},{untilOutcome:'0'},{untilIssue:'999999',untilOutcome:'0'},
   {limit:'101'},{recipientId:'bad'},{after:'bad'},{stockId:'bad'},{unknown:'1'}];
  for(const query of invalid){
   expect((await get(query)).statusCode).toBeGreaterThanOrEqual(400);
  }
 });
 it('denies production Master/recipient, revoked device/grant, and isolates tenants',async()=>{
  await received();
  expect((await get({},3)).statusCode).toBe(403);expect((await get({},4)).statusCode).toBe(403);
  const other=await createInventoryHandoffFixture();
  try{const r=await other.get('/inventory/reports/reconciliation?'+new URLSearchParams({deviceId:other.actors[2].device,productionBatchId:f.batch}),2);expect(r.statusCode,r.body).toBe(200);expect(r.json().items).toEqual([]);}
  finally{await other.app.close();await other.pool.end();}
  await f.pool.query('UPDATE devices SET revoked_at=now() WHERE id=$1',[f.actors[1].device]);
  expect((await get({},1)).statusCode).toBe(403);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[2].id]);
  expect((await get()).statusCode).toBe(403);
 });
 it('rechecks warehouse authority after a real inventory lock wait',async()=>{
  const blocker=await f.pool.connect();let pending:ReturnType<typeof get>|undefined;
  try{
   await blocker.query('BEGIN');
   await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.org+':inventory-sequence']);
   await blocker.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[2].id]);
   pending=get();
   const deadline=Date.now()+4000;
   while(!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock_shared%'",[f.applicationName])).rowCount){
    if(Date.now()>deadline)throw Error('Report did not wait for inventory lock');await new Promise(resolve=>setTimeout(resolve,10));
   }
   await blocker.query('COMMIT');expect((await pending).statusCode).toBe(403);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
 },10000);
});
