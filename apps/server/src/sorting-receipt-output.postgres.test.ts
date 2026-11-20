import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createCuttingOutputFixture} from './cutting-output-test-fixture.js';

const outputs='/inventory/cutting-outputs';
describe.skipIf(!process.env.POSTGRES_TEST_URL)('receipt-bound Sorting to warehouse output',()=>{
 let f:Awaited<ReturnType<typeof createCuttingOutputFixture>>;
 beforeEach(async()=>{
  f=await createCuttingOutputFixture();
  await f.pool.query("UPDATE production_batches SET status='in_progress' WHERE organization_id=$1 AND id=$2",[f.org,f.batch]);
 });
 afterEach(async()=>{await f?.app.close();await f?.pool.end();});
 async function sourceReceipt(){
  const inputs=await f.inputs(),declaration=f.declaration(inputs);
  const declared=await f.post(outputs,declaration,7);
  expect(declared.statusCode,declared.body).toBe(201);
  const offer={operationId:randomUUID(),deviceId:f.actors[7].device,outputLotId:declaration.outputs[0].id,
   quantity:4,unit:'pieces',expectedSourceRevision:1,recipientId:f.actors[8].id,destinationStepNumber:5,
   reason:'Physical counted partial piece offer',evidence:'Independent counted packet'};
  const sent=await f.post(outputs+'/handoffs',offer,7);
  expect(sent.statusCode,sent.body).toBe(201);
  const receipt={operationId:randomUUID(),deviceId:f.actors[8].device,handoffId:offer.operationId,
   kind:'receive',unit:'pieces',observedQuantity:4,observedLotLabel:declaration.outputs[0].label,
   measurementNote:'Independently counted 4',reason:'Actual Sorting custody',evidence:'Physical lot label matched'};
  const accepted=await f.post(outputs+'/acknowledgements',receipt,8);
  expect(accepted.statusCode,accepted.body).toBe(201);
  return {receipt,offer,declaration,inputs};
 }
 async function completed(quantity=2){
  const completionId=randomUUID();
  const inserted=await f.pool.query(`INSERT INTO production_step_evidence
   (organization_id,id,batch_id,order_id,route_id,route_version,step_number,workshop_id,kind,actor_id,quantity,quantity_unit)
   SELECT b.organization_id,$2,b.id,b.order_id,o.route_id,o.route_version,s.step_number,s.workshop_id,'completed',$3,$4,'pieces'
   FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
   JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=5
   WHERE b.organization_id=$1 AND b.id=$5`,[f.org,completionId,f.actors[0].id,quantity,f.batch]);
  expect(inserted.rowCount).toBe(1);
  return completionId;
 }
 const submission=(receiptId:string,completionId:string,quantity=4)=>({
  operationId:randomUUID(),deviceId:f.actors[0].device,productionBatchId:f.batch,stepNumber:5,completionId,
  source:{runId:randomUUID(),cutRunId:'received:'+receiptId,cuttingReceiptId:receiptId,
   specId:randomUUID(),mode:'pass-fail',inputCount:quantity,
   categories:[{name:'PASS'}],stages:[
    {station:'visual',inputCount:quantity,passedCount:quantity-1,rejectedCount:1,workerId:'sort-visual',recordedAt:1000},
    {station:'thickness',inputCount:quantity-1,passedCount:quantity-1,rejectedCount:0,workerId:'sort-thickness',recordedAt:2000},
    {station:'mass',inputCount:quantity-1,passedCount:2,rejectedCount:quantity-3,workerId:'sort-mass',recordedAt:3000},
   ]},
  outputs:[{grade:'PASS',materialId:'',quantity:2}],
  reason:'Actual signed three-station Sorting result',evidence:'Independent station observations and original receipt',
 });
 it('ties a production submission to a real, same-route received partial Cutting lot and replays exactly',async()=>{
  const source=await sourceReceipt(),completionId=await completed(),input=submission(source.receipt.operationId,completionId);
  input.outputs[0].materialId=source.inputs.materialId;
  const sent=await f.post('/inventory/outputs/electrodes',input,0);
  expect(sent.statusCode,sent.body).toBe(201);
  expect(sent.json().submission.source.cuttingReceiptId).toBe(source.receipt.operationId);
  expect((await f.post('/inventory/outputs/electrodes',input,0)).statusCode).toBe(200);
  const after=(await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_submissions WHERE organization_id=$1 AND source_cut_id=$2',[f.org,input.source.cutRunId])).rows[0].n;
  expect(after).toBe(1);
  const second={...input,operationId:randomUUID(),source:{...input.source,runId:randomUUID()}};
  expect((await f.post('/inventory/outputs/electrodes',second,0)).statusCode).toBe(409);
 });
 it('refuses missing, forged, mismatched or ineligible Cutting receipt before any stock posting',async()=>{
  const source=await sourceReceipt(),completionId=await completed();
  const raw=submission(source.receipt.operationId,completionId);
  raw.outputs[0].materialId=source.inputs.materialId;
  const variants=[
   {...raw,operationId:randomUUID(),source:{...raw.source,cuttingReceiptId:randomUUID()}},
   {...raw,operationId:randomUUID(),source:{...raw.source,cutRunId:'received:'+randomUUID(),cuttingReceiptId:randomUUID()}},
   {...raw,operationId:randomUUID(),source:{...raw.source,cuttingReceiptId:undefined}},
   {...raw,operationId:randomUUID(),source:{...raw.source,inputCount:5,stages:[
    {station:'visual',inputCount:5,passedCount:4,rejectedCount:1,workerId:'v',recordedAt:1000},
    {station:'thickness',inputCount:4,passedCount:3,rejectedCount:1,workerId:'t',recordedAt:2000},
    {station:'mass',inputCount:3,passedCount:2,rejectedCount:1,workerId:'m',recordedAt:3000},
   ]}},
  ];
  for(const request of variants){
   const result=await f.post('/inventory/outputs/electrodes',request,0);
   expect([400,409],result.body).toContain(result.statusCode);
  }
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_output_submissions WHERE organization_id=$1 AND completion_id=$2',[f.org,completionId])).rows[0].n).toBe(0);
  const ineligible=await f.pool.query('UPDATE inventory_materials SET active=false WHERE organization_id=$1 AND id=$2',[f.org,source.inputs.materialId]);
  expect(ineligible.rowCount).toBe(1);
  const result=await f.post('/inventory/outputs/electrodes',raw,0);
  expect(result.statusCode).toBe(409);
 });
 it('validates original Cutting custody and approved same-order Assembly route on the transfer POST',async()=>{
  const source=await sourceReceipt(),completionId=await completed(),input=submission(source.receipt.operationId,completionId);
  input.outputs[0].materialId=source.inputs.materialId;
  expect((await f.post('/inventory/outputs/electrodes',input,0)).statusCode).toBe(201);
  const context=(await f.pool.query(`SELECT b.order_id,o.route_id,o.route_version,s.workshop_id
    FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
    JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id
      AND s.route_version=o.route_version AND s.step_number=1
    WHERE b.organization_id=$1 AND b.id=$2`,[f.org,f.batch])).rows[0];
  await f.pool.query(`INSERT INTO process_route_steps
    (organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line)
    VALUES($1,$2,$3,6,'Assembly custody','assembly',$4,'common')`,
   [f.org,context.route_id,context.route_version,context.workshop_id]);
  const cellBatch=randomUUID();
  await f.pool.query(`INSERT INTO production_batches
    (organization_id,id,order_id,batch_code,material_line,status,created_by)
    VALUES($1,$2,$3,$2::uuid::text,'cell','in_progress',$4)`,
    [f.org,cellBatch,context.order_id,f.actors[0].id]);
  const offer={operationId:randomUUID(),deviceId:f.actors[0].device,submissionId:input.operationId,
   grade:'PASS',quantity:2,assemblyBatchId:cellBatch,assemblyStepNumber:6,recipientId:f.actors[4].id,
   reason:'Signed actual Sorting grade transfer',evidence:'Independent Cutting and Sorting counts'};
  const preflight=await f.get('/inventory/assembly-electrodes/eligibility?'+new URLSearchParams({
   deviceId:f.actors[0].device,submissionId:input.operationId,grade:'PASS',
   assemblyBatchId:cellBatch,assemblyStepNumber:'6',recipientId:f.actors[4].id}),0);
  expect(preflight.statusCode,preflight.body).toBe(200);
  const transfer=await f.post('/inventory/assembly-electrodes/handoffs',offer,0);
  expect(transfer.statusCode,transfer.body).toBe(201);
  expect(transfer.json().handoff).toMatchObject({...offer,warehouseEffect:'none',qualityStatus:'unreviewed'});
  expect((await f.post('/inventory/assembly-electrodes/handoffs',offer,0)).statusCode).toBe(200);
  const receipt={operationId:randomUUID(),deviceId:f.actors[4].device,handoffId:offer.operationId,
   observedQuantity:2,observedGrade:'PASS',observedLabel:'production:'+input.operationId+':PASS',
   reason:'Independent physical receipt',evidence:'Two observed electrodes'};
  expect((await f.post('/inventory/assembly-electrodes/acknowledgements',
   {...receipt,observedQuantity:3},4)).statusCode).toBe(409);
  const accepted=await f.post('/inventory/assembly-electrodes/acknowledgements',receipt,4);
  expect(accepted.statusCode,accepted.body).toBe(201);
  expect(accepted.json().receipt).toMatchObject({...receipt,custodyEffect:'received',warehouseEffect:'none'});
  expect((await f.post('/inventory/assembly-electrodes/acknowledgements',receipt,4)).statusCode).toBe(200);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_stocks WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
 });

});