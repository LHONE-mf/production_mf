import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
import {syntheticCellSource} from './inventory-cell-test-source.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('authenticated actual cell output submission without warehouse stock',()=>{
 let f:Awaited<ReturnType<typeof createInventoryHandoffFixture>>,batch:string,completion:string,material:string;
 async function completedBatch(){const id=randomUUID(),event=randomUUID();await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) SELECT organization_id,$2,order_id,$2::uuid::text,'cell','in_progress',created_by FROM production_batches WHERE organization_id=$1 AND id=$3",[f.org,id,batch]);
  for(const body of [{eventId:randomUUID(),kind:'started'},{eventId:event,kind:'completed',quantity:'2',quantityUnit:'pieces'}])expect((await f.post('/planning/batches/'+id+'/steps/1/evidence',body,3)).statusCode).toBe(201);return{batch:id,completion:event};}
 beforeEach(async()=>{
  f=await createInventoryHandoffFixture();const route=randomUUID(),order=randomUUID();batch=randomUUID();completion=randomUUID();material=randomUUID();
  const workshop=(await f.pool.query('SELECT workshop_id FROM user_workshop_memberships WHERE user_id=$1',[f.actors[3].id])).rows[0].workshop_id;
  await f.pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic final Formation',$3)",[f.org,route,f.actors[0].id]);await f.pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)',[f.org,route]);
  await f.pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Final Formation','formation',$3,'common')",[f.org,route,workshop]);await f.pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",[f.org,route,f.actors[0].id]);
  await f.pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'SYNTHETIC cell',$3,1,'released',999,'pieces',$4)",[f.org,order,route,f.actors[0].id]);await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cell','in_progress',$4)",[f.org,batch,order,f.actors[0].id]);
  for(const body of [{eventId:randomUUID(),kind:'started'},{eventId:completion,kind:'completed',quantity:'2',quantityUnit:'pieces'}])expect((await f.post('/planning/batches/'+batch+'/steps/1/evidence',body,3)).statusCode).toBe(201);
  expect((await f.post('/inventory/materials',{id:material,deviceId:f.actors[0].device,code:'CELL',name:'SYNTHETIC finished cell',category:'cell',baseUnit:'pieces'})).statusCode).toBe(201);
 });
 afterEach(async()=>{await f.app.close();await f.pool.end();});
 function proposal(){const source=syntheticCellSource();for(const key of ['assemblyRunId','assemblyOutputId','assemblyOperationId','fillingRunId','fillingReceiptId'] as const)source.lineage[key]=randomUUID();source.lineage.formationInputId=source.lineage.fillingRunId;source.identityId=randomUUID();source.formationRunId=randomUUID();return{operationId:randomUUID(),deviceId:f.actors[3].device,productionBatchId:batch,stepNumber:1,completionId:completion,materialId:material,source,reason:'Actual completed cell output offered',evidence:'SYNTHETIC complete explicit serial sheet'};}
 const submit=(body:object,i=3)=>f.post('/inventory/cell-outputs',body,i);
 const rows=async()=>(await f.pool.query('SELECT * FROM inventory_cell_submissions WHERE organization_id=$1',[f.org])).rows;
 it('submits explicit actual cells and original attribution once, with no stock, warehouse ledger or automatic QA',async()=>{
  const body=proposal(),response=await submit(body);expect(response.statusCode,response.body).toBe(201);expect(response.json().submission).toMatchObject({...body,quantity:2,unit:'pieces',revision:1,actorId:f.actors[3].id});
  expect((await submit(body)).json()).toEqual({...response.json(),status:'duplicate'});for(const table of ['inventory_stocks','inventory_operations','inventory_quality_dispositions'])expect((await f.pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
  const page=await f.get('/inventory/cell-outputs?deviceId='+f.actors[2].device,2);expect(page.statusCode,page.body).toBe(200);expect(page.json().items).toEqual([response.json().submission]);expect(await rows()).toHaveLength(1);
  await f.pool.query("UPDATE production_batches SET status='hold' WHERE organization_id=$1 AND id=$2",[f.org,batch]);expect((await submit(body)).json()).toEqual({...response.json(),status:'duplicate'});
 });
 it('separates production membership from warehouse grants and refuses changed bodies, catalogues and completions',async()=>{
  const body=proposal();for(const i of [1,2,4,5])expect((await submit({...body,deviceId:f.actors[i].device},i)).statusCode).toBe(403);
  expect((await submit({...body,materialId:f.material})).statusCode).toBe(409);expect((await submit({...body,completionId:randomUUID()})).statusCode).toBe(409);
  expect((await submit(body)).statusCode).toBe(201);expect((await submit({...body,evidence:'Changed original intent'})).statusCode).toBe(409);
  await f.pool.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[3].id]);expect((await submit(body)).statusCode).toBe(403);
  expect((await submit({...body,operationId:randomUUID(),deviceId:f.actors[0].device},0)).statusCode).toBe(409);
 });
 it('serializes competing devices and reserves the full original input against aliases, without guessing which unknown cells were processed',async()=>{
  const first=proposal(),other=proposal(),next=await completedBatch();other.productionBatchId=next.batch;other.completionId=next.completion;
  const results=await Promise.all([submit(first),submit({...other,deviceId:f.actors[0].device},0)]);expect(results.map(r=>r.statusCode).sort()).toEqual([201,409]);expect(await rows()).toHaveLength(1);
  const alias=proposal(),third=await completedBatch();alias.productionBatchId=third.batch;alias.completionId=third.completion;alias.source.ranges=[{start:11,end:11},{start:13,end:13}];expect((await submit(alias)).statusCode).toBe(409);
 }); it('discovers only actual final cell completions/materials and separates production discovery from warehouse history',async()=>{
  const path='/inventory/cell-outputs/steps?deviceId='+f.actors[3].device,page=await f.get(path,3);expect(page.statusCode,page.body).toBe(200);expect(page.json()).toMatchObject({epoch:f.epoch,postingEnabled:true,items:[{completionId:completion,productionBatchId:batch,quantity:2,unit:'pieces',materialLine:'cell'}]});
  const q=new URLSearchParams({deviceId:f.actors[3].device,productionBatchId:batch,completionId:completion,stepNumber:'1'}),materials=await f.get('/inventory/cell-outputs/materials?'+q,3);expect(materials.statusCode,materials.body).toBe(200);expect(materials.json().items).toEqual([{id:material,code:'CELL',name:'SYNTHETIC finished cell',category:'cell',baseUnit:'pieces'}]);
  for(const i of [1,2,4,5])expect((await f.get('/inventory/cell-outputs/steps?deviceId='+f.actors[i].device,i)).statusCode).toBe(403);
  expect((await f.get(path+'&after=not-a-uuid',3)).statusCode).toBe(400);expect((await f.get(path+'&limit=101',3)).statusCode).toBe(400);
  expect((await submit(proposal())).statusCode).toBe(201);expect((await f.get(path,3)).json().items).toEqual([]);
  expect((await f.get('/inventory/cell-outputs/materials?'+q,3)).statusCode).toBe(404);
 });
 it('pages actual completions, eligible materials and immutable source history without including planned targets',async()=>{
  const next=await completedBatch(),secondMaterial=randomUUID();expect((await f.post('/inventory/materials',{id:secondMaterial,deviceId:f.actors[0].device,code:'CELL-2',name:'SYNTHETIC second cell',category:'cell',baseUnit:'pieces'})).statusCode).toBe(201);
  const path='/inventory/cell-outputs/steps?deviceId='+f.actors[3].device+'&limit=1',a=await f.get(path,3),b=await f.get(path+'&after='+a.json().nextAfter,3);expect([a.json().items[0].completionId,b.json().items[0].completionId]).toEqual([completion,next.completion].sort());expect(a.json().hasMore).toBe(true);expect(b.json().hasMore).toBe(false);
  const q='/inventory/cell-outputs/materials?'+new URLSearchParams({deviceId:f.actors[3].device,productionBatchId:batch,completionId:completion,stepNumber:'1',limit:'1'}),m=await f.get(q,3),n=await f.get(q+'&after='+m.json().nextAfter,3);expect([m.json().items[0].id,n.json().items[0].id]).toEqual([material,secondMaterial].sort());
  const first=proposal(),second=proposal();second.productionBatchId=next.batch;second.completionId=next.completion;second.source.inputSerialRange.prefix='OTHER-SYNTHETIC-';expect((await submit(first)).statusCode).toBe(201);expect((await submit(second)).statusCode).toBe(201);
  const p='/inventory/cell-outputs?deviceId='+f.actors[2].device+'&limit=1',x=await f.get(p,2),y=await f.get(p+'&after='+x.json().nextAfter,2);expect([x.json().items[0].operationId,y.json().items[0].operationId]).toEqual([first.operationId,second.operationId].sort());expect(y.json().nextAfter).toBeNull();
  expect((await f.get(p+'&productionBatchId='+batch,2)).json().items).toHaveLength(1);expect((await f.get('/inventory/cell-outputs?deviceId='+f.actors[4].device,4)).statusCode).toBe(403);
 });
 it('rejects planned or unavailable output and cannot treat an intermediate Formation step as finished cell output',async()=>{
  const body=proposal(),source={...body.source,inputSerialRange:{prefix:'SYNTHETIC-',start:10,end:1008},ranges:[{start:10,end:1008}],formation:{...body.source.formation,cellsIn:999,cellsOut:999,cellsScrap:0,cellsUnknown:0}};
  expect((await submit({...body,source})).statusCode).toBe(409);await f.pool.query('UPDATE inventory_materials SET active=false WHERE organization_id=$1 AND id=$2',[f.org,material]);expect((await submit(body)).statusCode).toBe(409);await f.pool.query('UPDATE inventory_materials SET active=true WHERE organization_id=$1 AND id=$2',[f.org,material]);
  await f.pool.query("UPDATE production_batches SET status='hold' WHERE organization_id=$1 AND id=$2",[f.org,batch]);expect((await submit(body)).statusCode).toBe(409);expect((await f.get('/inventory/cell-outputs/steps?deviceId='+f.actors[3].device,3)).json().items).toEqual([]);
  await f.pool.query("UPDATE production_batches SET status='in_progress' WHERE organization_id=$1 AND id=$2",[f.org,batch]);
  const route=randomUUID(),order=randomUUID(),intermediate=randomUUID(),event=randomUUID(),workshop=(await f.pool.query('SELECT workshop_id FROM user_workshop_memberships WHERE user_id=$1',[f.actors[3].id])).rows[0].workshop_id;
  await f.pool.query("INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic intermediate Formation',$3)",[f.org,route,f.actors[0].id]);await f.pool.query('INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)',[f.org,route]);
  for(const number of [1,2])await f.pool.query("INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,$3,'Formation observation','formation',$4,'common')",[f.org,route,number,workshop]);await f.pool.query("UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",[f.org,route,f.actors[0].id]);
  await f.pool.query("INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic cell',$3,1,'released',999,'pieces',$4)",[f.org,order,route,f.actors[0].id]);await f.pool.query("INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cell','in_progress',$4)",[f.org,intermediate,order,f.actors[0].id]);
  for(const e of [{eventId:randomUUID(),kind:'started'},{eventId:event,kind:'completed',quantity:'2',quantityUnit:'pieces'}])expect((await f.post('/planning/batches/'+intermediate+'/steps/1/evidence',e,3)).statusCode).toBe(201);
  expect((await submit({...body,productionBatchId:intermediate,completionId:event})).statusCode).toBe(409);expect(await rows()).toEqual([]);
 });
 it('keeps original no-prefix domains conservative and permits distinct actual serial domains without expanding ranges',async()=>{
  const body=proposal();body.source.inputSerialRange.prefix=undefined;expect((await submit(body)).statusCode).toBe(201);
  const next=await completedBatch(),other=proposal();other.productionBatchId=next.batch;other.completionId=next.completion;other.source.inputSerialRange.prefix='EXPLICIT-NEW-PREFIX-';expect((await submit(other)).statusCode).toBe(409);
  other.source.inputSerialRange={prefix:'EXPLICIT-NEW-PREFIX-',start:20,end:23};other.source.ranges=[{start:20,end:20},{start:22,end:22}];expect((await submit(other)).statusCode).toBe(201);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_cell_serial_ranges WHERE organization_id=$1',[f.org])).rows[0].n).toBe(4);
 });
 it('isolates source discovery and submission by tenant and refuses missing/expired/revoked proof',async()=>{
  const body=proposal(),badHeaders={...f.headers(3),'x-device-proof':'not-a-device-proof'};expect((await f.app.inject({method:'POST',url:'/inventory/cell-outputs',headers:badHeaders,payload:body})).statusCode).toBe(403);
  expect((await submit(body)).statusCode).toBe(201);const other=await createInventoryHandoffFixture();try{
   expect((await other.post('/inventory/cell-outputs',{...body,operationId:randomUUID(),deviceId:other.actors[0].device})).statusCode).toBe(404);
   expect((await other.get('/inventory/cell-outputs?deviceId='+other.actors[0].device)).json().items).toEqual([]);
  }finally{await other.app.close();await other.pool.end();}
  await f.pool.query('UPDATE devices SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',[f.org,f.actors[3].device]);expect((await submit(body)).statusCode).toBe(403);
 });
 it('preserves accepted claims across changed history and suspended posting without automatically replaying an old epoch',async()=>{
  const body=proposal();expect((await submit(body)).statusCode).toBe(201);const replacement=randomUUID();await f.pool.query('UPDATE inventory_streams SET epoch=$2,posting_enabled=false WHERE organization_id=$1',[f.org,replacement]);
  expect((await submit(body)).statusCode).toBe(409);const response=await f.app.inject({method:'POST',url:'/inventory/cell-outputs',headers:{...f.headers(3),'x-inventory-epoch':replacement},payload:body});expect(response.statusCode).toBe(409);expect(response.json().error).toBe('inventory_posting_suspended');expect(await rows()).toHaveLength(1);
 });
 it('checks membership revoked during a real inventory lock wait before reserving any source',async()=>{
  const body=proposal(),client=await f.pool.connect();let pending:ReturnType<typeof submit>|undefined;
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.org+':inventory-sequence']);pending=submit(body);
   const deadline=Date.now()+5000;let waiting=false;while(!waiting&&Date.now()<deadline){waiting=!!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'",[f.applicationName])).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
   await client.query('DELETE FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[3].id]);await client.query('COMMIT');expect((await pending).statusCode).toBe(403);
  }finally{await client.query('ROLLBACK');client.release();if(pending)await pending;}expect(await rows()).toEqual([]);
 });
 it.each(['submit','discovery','history'] as const)('rejects proof expiring while %s waits for the production batch lock',async(kind)=>{
  const body=proposal();if(kind==='history')expect((await submit(body)).statusCode).toBe(201);const client=await f.pool.connect();let pending:Promise<Awaited<ReturnType<typeof f.get>>>|undefined;
  try{await client.query('BEGIN');await client.query('SELECT id FROM production_batches WHERE organization_id=$1 AND id=$2 FOR UPDATE',[f.org,batch]);await f.pool.query("UPDATE device_proof_grants SET expires_at=clock_timestamp()+interval '2 seconds' WHERE organization_id=$1 AND device_id=$2",[f.org,f.actors[3].device]);
   pending=Promise.resolve(kind==='submit'?submit(body):f.get('/inventory/cell-outputs'+(kind==='discovery'?'/steps':'')+'?deviceId='+f.actors[3].device,3));const deadline=Date.now()+5000;let waiting=false;
   while(!waiting&&Date.now()<deadline){waiting=!!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%production_batches b%'",[f.applicationName])).rowCount;if(!waiting)await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
   while(!(await f.pool.query('SELECT 1 FROM device_proof_grants WHERE organization_id=$1 AND device_id=$2 AND expires_at<=clock_timestamp()',[f.org,f.actors[3].device])).rowCount){if(Date.now()>deadline)throw Error('Disposable proof expiry missed');await new Promise(r=>setTimeout(r,20));}
   await client.query('COMMIT');expect((await pending).statusCode).toBe(403);
  }finally{await client.query('ROLLBACK');client.release();if(pending)await pending;}expect(await rows()).toHaveLength(kind==='history'?1:0);
 });
 it('keeps cell operation IDs disjoint from stock ledger IDs in both directions, even with identical actor/device/body',async()=>{
  const body=proposal();expect((await submit(body)).statusCode).toBe(201);const stock=await f.stock();
  const forged=(id:string,request:object)=>f.pool.query(`INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock)
   SELECT $1,organization_id,stock_id,$2,$3,'receive',quantity,0,1,reason,$4,result_stock FROM inventory_operations WHERE stock_id=$5 AND kind='receive' LIMIT 1`,[id,f.actors[3].id,f.actors[3].device,JSON.stringify(request),stock]);
  await expect(forged(body.operationId,body)).rejects.toThrow('operation_id_reused');
  const other=proposal(),next=await completedBatch();other.productionBatchId=next.batch;other.completionId=next.completion;other.source.inputSerialRange.prefix='SYNTHETIC-NAMESPACE-';await forged(other.operationId,other);
  const rejected=await submit(other);expect(rejected.statusCode,rejected.body).toBe(409);expect(rejected.json().error).toBe('operation_id_reused');expect(await rows()).toHaveLength(1);
 });
 it('requires all exact serial rows at commit and rejects orphan, append and immutable-history rewrites',async()=>{
  const original=proposal();expect((await submit(original)).statusCode).toBe(201);const next=await completedBatch(),body=proposal();body.productionBatchId=next.batch;body.completionId=next.completion;body.source.inputSerialRange.prefix='SYNTHETIC-ORPHAN-';
  const ack={operationId:body.operationId,submission:{...body,quantity:2,unit:'pieces',revision:1,actorId:f.actors[3].id,recordedAt:new Date().toISOString()}},client=await f.pool.connect();
  const insert=(payload:unknown)=>client.query(`INSERT INTO inventory_cell_submissions(operation_id,organization_id,production_batch_id,step_number,completion_id,source_identity_id,source_run_id,assembly_output_id,assembly_run_id,material_id,serial_prefix,serial_start,serial_end,quantity,actor_id,device_id,epoch,reason,evidence,request_payload,result_payload,recorded_at)
    SELECT $1,organization_id,$10,step_number,$9,$2,$3,$4,$5,material_id,$6,serial_start,serial_end,quantity,actor_id,device_id,epoch,reason,evidence,$7,$8,($8::jsonb#>>'{submission,recordedAt}')::timestamptz FROM inventory_cell_submissions WHERE operation_id=$11`,[body.operationId,body.source.identityId,body.source.formationRunId,body.source.lineage.assemblyOutputId,body.source.lineage.assemblyRunId,body.source.inputSerialRange.prefix,JSON.stringify(body),JSON.stringify(payload),body.completionId,body.productionBatchId,original.operationId]);
  try{await client.query('BEGIN');await expect(insert({...ack,submission:{...ack.submission,revision:2}})).rejects.toThrow('cell_output_source_required');await client.query('ROLLBACK');
   await client.query('BEGIN');await insert(ack);
   await expect(client.query('COMMIT')).rejects.toThrow('cell_output_serial_pair_required');
  }finally{await client.query('ROLLBACK');client.release();}
  expect(await rows()).toHaveLength(1);expect((await submit(body)).statusCode).toBe(201);
  for(const table of ['inventory_cell_submissions','inventory_cell_serial_ranges'])await expect(f.pool.query('DELETE FROM '+table+' WHERE organization_id=$1',[f.org])).rejects.toThrow('immutable');
  await expect(f.pool.query('UPDATE inventory_cell_submissions SET serial_end=serial_end+1 WHERE organization_id=$1',[f.org])).rejects.toThrow('immutable');
  await expect(f.pool.query('INSERT INTO inventory_cell_serial_ranges(organization_id,submission_id,ordinal,range_start,range_end) VALUES($1,$2,2,11,11)',[f.org,body.operationId])).rejects.toThrow('cell_serial_range_mismatch');
 });

});
