import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';

describe.skipIf(!process.env.POSTGRES_TEST_URL)('finished electrode submission and separate Storage acceptance',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
 let batch:string,completion:string;
 beforeEach(async()=>{
  f=await createInventoryHandoffFixture();
  const route=randomUUID(),order=randomUUID();batch=randomUUID();completion=randomUUID();
  const workshop=(await f.pool.query('SELECT workshop_id FROM user_workshop_memberships WHERE user_id=$1',[f.actors[3].id])).rows[0].workshop_id;
  await f.pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic final sorting',$3)",[f.org,route,f.actors[0].id]);
  await f.pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)',[f.org,route]);
  await f.pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Final sorting','sorting',$3,'cathode')",[f.org,route,workshop]);
  await f.pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",[f.org,route,f.actors[0].id]);
  await f.pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic electrode',$3,1,'released',999,'pieces',$4)",[f.org,order,route,f.actors[0].id]);
  await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cathode','in_progress',$4)",[f.org,batch,order,f.actors[0].id]);
  for(const body of [{eventId:randomUUID(),kind:'started'},{eventId:completion,kind:'completed',quantity:'7',quantityUnit:'pieces'}]){
   const r=await f.post('/planning/batches/'+batch+'/steps/1/evidence',body,3);expect(r.statusCode,r.body).toBe(201);
  }
  const r=await f.post('/inventory/materials',{id:randomUUID(),deviceId:f.actors[0].device,code:'ELECTRODE',name:'Synthetic counted electrode',category:'electrode',baseUnit:'pieces'});
  expect(r.statusCode,r.body).toBe(201);
 });
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 async function proposal(){
  const material=(await f.pool.query("SELECT id FROM inventory_materials WHERE organization_id=$1 AND category='electrode'",[f.org])).rows[0].id;
  return{operationId:randomUUID(),deviceId:f.actors[3].device,productionBatchId:batch,stepNumber:1,completionId:completion,
   source:{runId:randomUUID(),cutRunId:randomUUID(),specId:randomUUID(),mode:'grading',inputCount:10,
    categories:[{name:'A',minMass:1,maxMass:2},{name:'B',minMass:2,maxMass:3}],
    stages:[{station:'visual',inputCount:10,passedCount:9,rejectedCount:1,workerId:'synthetic-visual',recordedAt:1000},
     {station:'thickness',inputCount:9,passedCount:8,rejectedCount:1,workerId:'synthetic-thickness',recordedAt:2000},
     {station:'mass',inputCount:8,passedCount:7,rejectedCount:1,workerId:'synthetic-mass',recordedAt:3000,grades:[{categoryName:'A',count:4},{categoryName:'B',count:3}]}]},
   outputs:[{grade:'A',materialId:material,quantity:4},{grade:'B',materialId:material,quantity:3}],
   reason:'Actual completed counted output offered to Storage',evidence:'Synthetic three station physical count sheet'};
 }
 const submit=async(body:object,i=3)=>f.post('/inventory/outputs/electrodes',body,i);
 function acceptance(id:string,grade='A',quantity=4,i=2){return{operationId:randomUUID(),deviceId:f.actors[i].device,submissionId:id,grade,expectedRevision:1,stockId:randomUUID(),locationId:f.location,quantity,reason:'Separate actual physical Storage acceptance',evidence:'Synthetic receiving count sheet'};}
 const accept=(body:object,i=2)=>f.post('/inventory/outputs/accept',body,i);

 it('submits actual grades without stock, accepts once into quarantine, then requires separate Chief QA',async()=>{
  const body=await proposal(),sent=await submit(body);expect(sent.statusCode,sent.body).toBe(201);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
  expect((await submit(body)).json()).toEqual({...sent.json(),status:'duplicate'});
  const a=acceptance(body.operationId),received=await accept(a);expect(received.statusCode,received.body).toBe(201);
  expect(received.json().stock).toMatchObject({onHand:4,available:4,reserved:0,quality:'quarantine',revision:1,unit:'pieces'});
  const qa=await f.post('/inventory/stocks/'+a.stockId+'/quality-dispositions',{operationId:randomUUID(),stockId:a.stockId,deviceId:f.actors[0].device,expectedRevision:1,disposition:'release',reason:'Separate Chief review of real output evidence',evidence:'Synthetic independent QA inspection'});
  expect(qa.statusCode,qa.body).toBe(201);
  expect((await accept(a)).json()).toEqual({...received.json(),status:'duplicate'});
  expect((await accept(acceptance(body.operationId))).statusCode).toBe(409);
  const b=await accept(acceptance(body.operationId,'B',3));expect(b.statusCode,b.body).toBe(201);
  const page=await f.get('/inventory/outputs?deviceId='+f.actors[2].device,2);expect(page.statusCode,page.body).toBe(200);
  expect(page.json().items[0]).toMatchObject({operationId:body.operationId,source:body.source,outputs:[{grade:'A',stockId:a.stockId},{grade:'B',stockId:b.json().stock.stockId}]});
  const report=await f.get('/inventory/reports/movements?deviceId='+f.actors[2].device+'&productionBatchId='+batch,2);expect(report.json().items.filter((r:{kind:string})=>r.kind==='receive')).toHaveLength(2);
 });

 it('rejects incomplete, invented, reordered and nonconserving station grades before posting anything',async()=>{
  const body=await proposal();
  const variants=[
   {...body,quantity:999},
   {...body,source:{...body.source,stages:body.source.stages.slice(1)}},
   {...body,source:{...body.source,stages:[body.source.stages[1],body.source.stages[0],body.source.stages[2]]}},
   {...body,source:{...body.source,stages:body.source.stages.map((s,i)=>i===1?{...s,passedCount:9}:s)}},
   {...body,source:{...body.source,stages:body.source.stages.map((s,i)=>i===1?{...s,grades:[{categoryName:'A',count:8}]}:s)}},
   {...body,source:{...body.source,mode:'pass-fail'}},
   {...body,outputs:[{...body.outputs[0],quantity:7}]},
   {...body,outputs:body.outputs.map(o=>({...o,quantity:o.quantity+1}))},
   {...body,source:{...body.source,categories:[body.source.categories[0],body.source.categories[0]]}},
   {...body,source:{...body.source,inputCount:Number.MAX_SAFE_INTEGER+1}},
  ];
  for(const v of variants)expect((await submit(v)).statusCode).toBe(400);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_submissions WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
 });

 it('requires the real completed final sorting quantity and an electrode pieces catalog item',async()=>{
  const body=await proposal();
  expect((await submit({...body,completionId:randomUUID()})).statusCode).toBe(409);
  expect((await submit({...body,productionBatchId:f.batch})).statusCode).toBe(409);
  expect((await submit({...body,outputs:body.outputs.map(o=>({...o,materialId:f.material}))})).statusCode).toBe(409);
  const other=await proposal();other.source.stages[2].passedCount=6;other.source.stages[2].rejectedCount=2;
  other.source.stages[2].grades![0].count=3;other.outputs[0].quantity=3;
  expect((await submit(other)).statusCode).toBe(409);
  expect((await submit(body)).statusCode).toBe(201);
  expect((await submit({...body,operationId:randomUUID()})).statusCode).toBe(409);
  expect((await submit({...body,evidence:'Reassigned original ID'})).statusCode).toBe(409);
  const anotherBatch=randomUUID(),anotherCompletion=randomUUID();
  await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) SELECT organization_id,$2,order_id,$2::uuid::text,material_line,'in_progress',created_by FROM production_batches WHERE organization_id=$1 AND id=$3",[f.org,anotherBatch,batch]);
  for(const event of [{eventId:randomUUID(),kind:'started'},{eventId:anotherCompletion,kind:'completed',quantity:'7',quantityUnit:'pieces'}])expect((await f.post('/planning/batches/'+anotherBatch+'/steps/1/evidence',event,3)).statusCode).toBe(201);
  for(const source of [{...body.source,runId:randomUUID()},{...body.source,cutRunId:randomUUID()}])
   expect((await submit({...body,operationId:randomUUID(),productionBatchId:anotherBatch,completionId:anotherCompletion,source})).statusCode).toBe(409);
 });

 it('enforces workshop production authority independently of warehouse access',async()=>{
  const body=await proposal();
  for(const i of [1,2,4,5])expect((await submit({...body,deviceId:f.actors[i].device},i)).statusCode).toBe(403);
  expect((await submit(body)).statusCode).toBe(201);
  expect((await accept(acceptance(body.operationId,'A',4,3),3)).statusCode).toBe(403);
  await f.pool.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[3].id]);
  expect((await submit(body)).statusCode).toBe(403);
  expect((await f.get('/inventory/outputs?deviceId='+f.actors[3].device,3)).json().items).toEqual([]);
  expect((await f.get('/inventory/outputs?deviceId='+f.actors[4].device,4)).statusCode).toBe(403);
 });

 it('serializes competing physical receipts and retains the original result after later movement',async()=>{
  const body=await proposal();expect((await submit(body)).statusCode).toBe(201);
  const a=acceptance(body.operationId),b=acceptance(body.operationId,'A',4,1);
  const responses=await Promise.all([accept(a),accept(b,1)]);expect(responses.map(r=>r.statusCode).sort()).toEqual([201,409]);
  const winner=responses[0].statusCode===201?{body:a,index:2,result:responses[0]}:{body:b,index:1,result:responses[1]};
  expect((await accept({...winner.body,quantity:5},winner.index)).statusCode).toBe(409);
  expect((await accept(acceptance(body.operationId,'B',2))).statusCode).toBe(409);
  expect((await accept({...acceptance(body.operationId,'B',3),quality:'released'})).statusCode).toBe(400);
  const changed=await f.post('/inventory/stocks/'+winner.body.stockId+'/quality-dispositions',{operationId:randomUUID(),stockId:winner.body.stockId,deviceId:f.actors[0].device,expectedRevision:1,disposition:'hold',reason:'Later physical hold',evidence:'Synthetic QA hold'});
  expect(changed.statusCode,changed.body).toBe(201);
  expect((await accept(winner.body,winner.index)).json()).toEqual({...winner.result.json(),status:'duplicate'});
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_acceptances WHERE organization_id=$1',[f.org])).rows[0].n).toBe(1);
 });

 it('never leaks or accepts a source from another tenant and prevents cross-endpoint ID reuse',async()=>{
  const body=await proposal();expect((await submit(body)).statusCode).toBe(201);
  const other=await createInventoryHandoffFixture();try{
   const a=acceptance(body.operationId);expect((await other.post('/inventory/outputs/accept',{...a,deviceId:other.actors[2].device,locationId:other.location},2)).statusCode).toBe(404);
   expect((await other.get('/inventory/outputs?deviceId='+other.actors[2].device,2)).json().items).toEqual([]);
  }finally{await other.app.close();await other.pool.end();}
  const reused=await f.post('/inventory/receipts',{operationId:body.operationId,deviceId:f.actors[2].device,stockId:randomUUID(),materialId:f.material,locationId:f.location,manufacturerLot:'Synthetic conflict',expectedRevision:0,quantity:1,reason:'Cannot recycle production intent'},2);
  expect(reused.statusCode,reused.body).toBe(409);
  const opened={operationId:randomUUID(),countId:randomUUID(),deviceId:f.actors[2].device,kind:'open',reason:'Count intent stays original',evidence:'Synthetic record'};
  expect((await f.post('/inventory/counts/operations',opened,2)).statusCode).toBe(201);
  expect((await accept({...acceptance(body.operationId),operationId:opened.operationId})).statusCode).toBe(409);
 });

 it('rechecks device, grants, epoch and posting fence before even exact accepted retries',async()=>{
  const body=await proposal();expect((await submit(body)).statusCode).toBe(201);
  const a=acceptance(body.operationId);expect((await accept(a)).statusCode).toBe(201);
  await f.pool.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[2].id]);
  expect((await accept(a)).statusCode).toBe(403);
  await f.pool.query('UPDATE inventory_streams SET posting_enabled=false WHERE organization_id=$1',[f.org]);
  expect((await submit(body)).statusCode).toBe(409);
  await f.pool.query('UPDATE inventory_streams SET posting_enabled=true,epoch=$2 WHERE organization_id=$1',[f.org,randomUUID()]);
  expect((await submit(body)).statusCode).toBe(409);
  await f.pool.query('UPDATE devices SET revoked_at=clock_timestamp() WHERE id=$1',[f.actors[3].device]);
  expect((await submit(body)).statusCode).toBe(403);
 });

 it('retains append-only source/grade/receipt evidence and refuses an added grade outside the original source',async()=>{
  const body=await proposal();expect((await submit(body)).statusCode).toBe(201);
  const a=acceptance(body.operationId);expect((await accept(a)).statusCode).toBe(201);
  for(const table of ['inventory_output_submissions','inventory_output_lines','inventory_output_acceptances'])
   await expect(f.pool.query('DELETE FROM '+table+' WHERE organization_id=$1',[f.org])).rejects.toThrow('immutable');
  await expect(f.pool.query("INSERT INTO inventory_output_lines(organization_id,submission_id,grade,material_id,quantity) VALUES($1,$2,'invented',$3,1)",[f.org,body.operationId,body.outputs[0].materialId])).rejects.toThrow('finished_output_line_mismatch');
 });

 it('supports explicit pass/fail output without assigning a mass grade',async()=>{
  const body=await proposal(),mass=body.source.stages[2];
  const {grades:_grades,...station}=mass;
  const request={...body,source:{...body.source,mode:'pass-fail',stages:[...body.source.stages.slice(0,2),station]},outputs:[{grade:'PASS',materialId:body.outputs[0].materialId,quantity:7}]};
  const r=await submit(request);expect(r.statusCode,r.body).toBe(201);
  const accepted=await accept(acceptance(body.operationId,'PASS',7));expect(accepted.statusCode,accepted.body).toBe(201);
  expect(accepted.json().stock.onHand).toBe(7);
 });

 it('holds new physical acceptance when the batch is held while preserving previously accepted retries',async()=>{
  const body=await proposal();expect((await submit(body)).statusCode).toBe(201);
  const a=acceptance(body.operationId),first=await accept(a);expect(first.statusCode).toBe(201);
  const hold=await f.post('/planning/batches/'+batch+'/status',{expectedStatus:'in_progress',status:'hold',reason:'Independent physical investigation'});
  expect(hold.statusCode,hold.body).toBe(200);
  expect((await accept(acceptance(body.operationId,'B',3))).statusCode).toBe(409);
  expect((await accept(a)).json()).toEqual({...first.json(),status:'duplicate'});
  expect((await submit(body)).statusCode).toBe(200);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_acceptances WHERE organization_id=$1',[f.org])).rows[0].n).toBe(1);
 });

 it('does not turn an intermediate completed sorting step into finished output',async()=>{
  const route=randomUUID(),order=randomUUID(),intermediate=randomUUID(),event=randomUUID();
  const workshop=(await f.pool.query('SELECT workshop_id FROM user_workshop_memberships WHERE user_id=$1',[f.actors[3].id])).rows[0].workshop_id;
  await f.pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic unfinished route',$3)",[f.org,route,f.actors[0].id]);
  await f.pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)',[f.org,route]);
  await f.pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Intermediate sorting','sorting',$3,'cathode'),($1,$2,1,2,'Applicable later processing','cutting',$3,'common')",[f.org,route,workshop]);
  await f.pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",[f.org,route,f.actors[0].id]);
  await f.pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic intermediate',$3,1,'released',7,'pieces',$4)",[f.org,order,route,f.actors[0].id]);
  await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cathode','in_progress',$4)",[f.org,intermediate,order,f.actors[0].id]);
  for(const body of [{eventId:randomUUID(),kind:'started'},{eventId:event,kind:'completed',quantity:'7',quantityUnit:'pieces'}]){
   const r=await f.post('/planning/batches/'+intermediate+'/steps/1/evidence',body,3);expect(r.statusCode,r.body).toBe(201);
  }
  expect((await submit({...await proposal(),productionBatchId:intermediate,completionId:event})).statusCode).toBe(409);
 });

 it('rejects a forged ledger receipt without paired acceptance at database commit',async()=>{
  const body=await proposal();expect((await submit(body)).statusCode).toBe(201);
  const a=acceptance(body.operationId);expect((await accept(a)).statusCode).toBe(201);
  const client=await f.pool.connect();try{
   await client.query('BEGIN');
   await client.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,production_batch_id,request_payload,result_stock) SELECT $1,organization_id,stock_id,actor_id,device_id,'receive',quantity,0,1,reason,production_batch_id,$2,result_stock FROM inventory_operations WHERE operation_id=$3",[randomUUID(),JSON.stringify({...a,operationId:randomUUID()}),a.operationId]);
   await expect(client.query('COMMIT')).rejects.toThrow('finished_output_pair_required');
  }finally{await client.query('ROLLBACK');client.release();}
 });

 it('never adopts an existing ledger ID as a zero-stock production submission, even with identical payload/actor/device',async()=>{
  const body=await proposal(),id=await f.stock();
  await f.pool.query(`INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock)
   SELECT $1,organization_id,stock_id,$2,$3,'receive',quantity,0,1,reason,$4,result_stock FROM inventory_operations WHERE stock_id=$5 AND kind='receive'`,
   [body.operationId,f.actors[3].id,f.actors[3].device,JSON.stringify(body),id]);
  expect((await submit(body)).statusCode).toBe(409);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_submissions WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
 });

 it('denies production membership revoked while waiting for the inventory commit lock',async()=>{
  const body=await proposal(),client=await f.pool.connect();let pending:ReturnType<typeof submit>|undefined;
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.org+':inventory-sequence']);
   pending=submit(body);
   let waiting=false;
   for(let n=0;n<100&&!waiting;n++){
    waiting=!!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'",[f.applicationName])).rowCount;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);
   await client.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[3].id]);
   await client.query('COMMIT');expect((await pending).statusCode).toBe(403);
  }finally{await client.query('ROLLBACK');client.release();if(pending)await pending;}
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_submissions WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
 });

 it('discovers only completed final sorting steps and active electrode-piece materials for the current production workshop',async()=>{
  const page=await f.get('/inventory/outputs/steps?deviceId='+f.actors[3].device,3);
  expect(page.statusCode,page.body).toBe(200);expect(page.json()).toMatchObject({organizationId:f.org,actorId:f.actors[3].id,deviceId:f.actors[3].device,epoch:f.epoch,postingEnabled:true,items:[{completionId:completion,productionBatchId:batch,quantity:7,unit:'pieces',materialLine:'cathode'}],nextAfter:null});
  const q=new URLSearchParams({deviceId:f.actors[3].device,completionId:completion,productionBatchId:batch,stepNumber:'1'});
  const materials=await f.get('/inventory/outputs/materials?'+q,3);expect(materials.statusCode,materials.body).toBe(200);
  expect(materials.json().items).toHaveLength(1);expect(materials.json().items[0]).toMatchObject({category:'electrode',baseUnit:'pieces'});
  expect((await f.get('/inventory/outputs/steps?deviceId='+f.actors[2].device,2)).statusCode).toBe(403);
  expect((await submit(await proposal())).statusCode).toBe(201);
  expect((await f.get('/inventory/outputs/steps?deviceId='+f.actors[3].device,3)).json().items).toEqual([]);
  expect((await f.get('/inventory/outputs/materials?'+q,3)).statusCode).toBe(404);
 });
 it('does not discover another tenant, revoked workshop or held output, and validates source/material cursors',async()=>{
  expect((await f.get('/inventory/outputs/steps?deviceId='+f.actors[3].device+'&after=bad',3)).statusCode).toBe(400);
  const other=await createInventoryHandoffFixture();try{
   expect((await other.get('/inventory/outputs/steps?deviceId='+other.actors[3].device,3)).json().items).toEqual([]);
   const q=new URLSearchParams({deviceId:other.actors[3].device,completionId:completion,productionBatchId:batch,stepNumber:'1'});
   expect((await other.get('/inventory/outputs/materials?'+q,3)).statusCode).toBe(404);
  }finally{await other.app.close();await other.pool.end();}
  await f.pool.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[3].id]);
  expect((await f.get('/inventory/outputs/steps?deviceId='+f.actors[3].device,3)).json().items).toEqual([]);
  expect((await f.get('/inventory/outputs/steps?deviceId='+f.actors[0].device)).json().items).toHaveLength(1);
  expect((await f.post('/planning/batches/'+batch+'/status',{expectedStatus:'in_progress',status:'hold',reason:'Hold before offering actual output'})).statusCode).toBe(200);
  expect((await f.get('/inventory/outputs/steps?deviceId='+f.actors[0].device)).json().items).toEqual([]);
 });
 it('pages actual completions and eligible materials without duplicates or planned quantity substitution',async()=>{
  const secondBatch=randomUUID(),secondCompletion=randomUUID(),secondMaterial=randomUUID();
  await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) SELECT organization_id,$2,order_id,$2::uuid::text,material_line,'in_progress',created_by FROM production_batches WHERE organization_id=$1 AND id=$3",[f.org,secondBatch,batch]);
  for(const event of [{eventId:randomUUID(),kind:'started'},{eventId:secondCompletion,kind:'completed',quantity:'7',quantityUnit:'pieces'}])expect((await f.post('/planning/batches/'+secondBatch+'/steps/1/evidence',event,3)).statusCode).toBe(201);
  const p='/inventory/outputs/steps?deviceId='+f.actors[3].device+'&limit=1',first=await f.get(p,3),next=await f.get(p+'&after='+first.json().nextAfter,3);
  expect(first.json().hasMore).toBe(true);expect(next.json().hasMore).toBe(false);expect(new Set([...first.json().items,...next.json().items].map((r:{completionId:string})=>r.completionId))).toEqual(new Set([completion,secondCompletion]));
  expect([...first.json().items,...next.json().items].every((r:{quantity:number})=>r.quantity===7)).toBe(true);
  expect((await f.post('/inventory/materials',{id:secondMaterial,deviceId:f.actors[0].device,code:'SECOND-ELECTRODE',name:'Second eligible synthetic electrode',category:'electrode',baseUnit:'pieces'})).statusCode).toBe(201);
  const q=new URLSearchParams({deviceId:f.actors[3].device,completionId:completion,productionBatchId:batch,stepNumber:'1',limit:'1'}),a=await f.get('/inventory/outputs/materials?'+q,3);q.set('after',a.json().nextAfter);const b=await f.get('/inventory/outputs/materials?'+q,3);
  expect(a.json().hasMore).toBe(true);expect(b.json().hasMore).toBe(false);expect(new Set([...a.json().items,...b.json().items].map((r:{id:string})=>r.id)).size).toBe(2);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
 });
 it.each(['read','submit'] as const)('rejects proof that expires while %s waits for the production batch lock',async(kind)=>{
  const body=await proposal(),client=await f.pool.connect();let pending:Promise<Awaited<ReturnType<typeof f.get>>>|undefined;
  try{
   await client.query('BEGIN');await client.query('SELECT id FROM production_batches WHERE organization_id=$1 AND id=$2 FOR UPDATE',[f.org,batch]);
   await f.pool.query("UPDATE device_proof_grants SET expires_at=clock_timestamp()+interval '2 seconds' WHERE organization_id=$1 AND device_id=$2",[f.org,f.actors[3].device]);
   pending=Promise.resolve(kind==='read'?f.get('/inventory/outputs/steps?deviceId='+f.actors[3].device,3):f.post('/inventory/outputs/electrodes',body,3));
   const deadline=Date.now()+4000;let blocked=false;
   while(!blocked&&Date.now()<deadline){blocked=!!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%production_batches b%'",[f.applicationName])).rowCount;if(!blocked)await new Promise(r=>setTimeout(r,10));}
   expect(blocked).toBe(true);
   while(!(await f.pool.query('SELECT 1 FROM device_proof_grants WHERE organization_id=$1 AND device_id=$2 AND expires_at<=clock_timestamp()',[f.org,f.actors[3].device])).rowCount){if(Date.now()>deadline)throw Error('Disposable proof expiry deadline missed');await new Promise(r=>setTimeout(r,20));}
   await client.query('COMMIT');expect((await pending).statusCode).toBe(403);
  }finally{await client.query('ROLLBACK');client.release();if(pending)await pending;}
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_submissions WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
 });
});
