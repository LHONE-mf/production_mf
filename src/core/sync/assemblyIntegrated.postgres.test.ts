import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {inventoryOutbox,type InventoryScope} from './inventoryOutbox';
import {loadAvailableAssemblyGrades} from './assemblyEligibility';
import {
 assemblyDrafts,freezeAssemblyOffer,freezeAssemblyReceipt,
 loadAssemblyHandoffs,sendAssemblyDraft,
} from './assemblyTransfers';
import type {HybridSession} from './hybridClient';

/**
 * Runs only in the dedicated disposable-PostgreSQL CI gate. Importing the
 * backend fixture at runtime keeps ordinary Android/browser tests independent
 * of server node_modules and never connects them to a live server.
 *
 * Executes the SAME TS/IndexedDB flows shipped in the Capacitor Android app,
 * against real authenticated Fastify routes + migrated PostgreSQL. This is
 * not a device/emulator instrumentation test.
 */
describe.skipIf(!process.env.POSTGRES_TEST_URL)('Android client ↔ Cutting → Sorting → Assembly PostgreSQL integration',()=>{
 let f:any;
 const serverUrl='https://production-mf-e2e.invalid';
 let dropHandoff=false,dropReceipt=false;
 const postBodies:{path:string;body:string;status:number}[]=[];

 function actor(index:number):{scope:InventoryScope;session:HybridSession}{
  const member=f.actors[index];
  return{
   scope:{serverUrl,organizationId:f.org,actorId:member.id,deviceId:member.device},
   session:{serverUrl,accessToken:member.token,deviceProofToken:member.proof,
    deviceProofDeviceId:member.device,deviceProofExpiresAt:Date.now()+300000},
  };
 }
 const databaseCount=async(table:string)=>Number((await f.pool.query(
  'SELECT count(*)::int AS n FROM '+table+' WHERE organization_id=$1',[f.org])).rows[0].n);

 async function forwardClientFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
  const url=new URL(String(input)),path=url.pathname+url.search;
  const method=(init?.method??'GET').toUpperCase();
  const headers=Object.fromEntries(new Headers(init?.headers).entries());
  const body=typeof init?.body==='string'?init.body:undefined;
  const response=await f.app.inject({method,url:path,headers,payload:body});
  if(method==='POST'){
   postBodies.push({path:url.pathname,body:body??'',status:response.statusCode});
   // Simulate losing ONLY the HTTP response, after the real SQL commit.
   if(url.pathname.endsWith('/assembly-electrodes/handoffs')&&dropHandoff){
    dropHandoff=false;
    expect(response.statusCode,response.body).toBe(201);
    throw Error('Handoff ACK lost after server commit');
   }
   if(url.pathname.endsWith('/assembly-electrodes/acknowledgements')&&dropReceipt){
    dropReceipt=false;
    expect(response.statusCode,response.body).toBe(201);
    throw Error('Receipt ACK lost after server commit');
   }
  }
  return new Response(response.body,{status:response.statusCode,
   headers:{'content-type':'application/json'}});
 }

 async function makeRealCuttingSortingSource(){
  // Real upstream API events: coating → calendaring → cutting declaration,
  // partial counted Cutting lot handoff and independent Sorting receipt.
  const inputs=await f.inputs(),declaration=f.declaration(inputs);
  const declared=await f.post('/inventory/cutting-outputs',declaration,7);
  expect(declared.statusCode,declared.body).toBe(201);
  const cuttingOffer={
   operationId:randomUUID(),deviceId:f.actors[7].device,
   outputLotId:declaration.outputs[0].id,quantity:4,unit:'pieces',
   expectedSourceRevision:1,recipientId:f.actors[8].id,destinationStepNumber:5,
   reason:'Physically counted Cutting electrodes',
   evidence:'Original Cutting label + four pieces',
  };
  const sent=await f.post('/inventory/cutting-outputs/handoffs',cuttingOffer,7);
  expect(sent.statusCode,sent.body).toBe(201);
  const receipt={
   operationId:randomUUID(),deviceId:f.actors[8].device,handoffId:cuttingOffer.operationId,
   kind:'receive',unit:'pieces',observedQuantity:4,
   observedLotLabel:declaration.outputs[0].label,measurementNote:'Four pieces checked',
   reason:'Independent Sorting intake',evidence:'Observed Cutting source lot label',
  };
  const accepted=await f.post('/inventory/cutting-outputs/acknowledgements',receipt,8);
  expect(accepted.statusCode,accepted.body).toBe(201);

  const completionId=randomUUID();
  const completion=await f.pool.query(`INSERT INTO production_step_evidence
    (organization_id,id,batch_id,order_id,route_id,route_version,step_number,workshop_id,kind,actor_id,quantity,quantity_unit)
    SELECT b.organization_id,$2,b.id,b.order_id,o.route_id,o.route_version,s.step_number,s.workshop_id,
      'completed',$3,2,'pieces'
    FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
    JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id
      AND s.route_version=o.route_version AND s.step_number=5
    WHERE b.organization_id=$1 AND b.id=$4`,[f.org,completionId,f.actors[0].id,f.batch]);
  expect(completion.rowCount).toBe(1);
  const output={
   operationId:randomUUID(),deviceId:f.actors[0].device,productionBatchId:f.batch,
   stepNumber:5,completionId,
   source:{runId:randomUUID(),cutRunId:'received:'+receipt.operationId,
    cuttingReceiptId:receipt.operationId,specId:randomUUID(),mode:'pass-fail',
    inputCount:4,categories:[{name:'PASS'}],
    stages:[
     {station:'visual',inputCount:4,passedCount:3,rejectedCount:1,workerId:'sorting-visual',recordedAt:1000},
     {station:'thickness',inputCount:3,passedCount:3,rejectedCount:0,workerId:'sorting-thickness',recordedAt:2000},
     {station:'mass',inputCount:3,passedCount:2,rejectedCount:1,workerId:'sorting-mass',recordedAt:3000},
    ]},
   outputs:[{grade:'PASS',materialId:inputs.materialId,quantity:2}],
   reason:'Physical three-stage Sorting measurements',
   evidence:'Original Cutting receipt and Sorting count sheet',
  };
  const submitted=await f.post('/inventory/outputs/electrodes',output,0);
  expect(submitted.statusCode,submitted.body).toBe(201);

  // Destination is an actual cell batch under the SAME approved order/route.
  const cellBatchId=randomUUID();
  const order=(await f.pool.query('SELECT order_id FROM production_batches WHERE organization_id=$1 AND id=$2',
   [f.org,f.batch])).rows[0].order_id;
  await f.pool.query(`INSERT INTO production_batches
    (organization_id,id,order_id,batch_code,material_line,status,created_by)
    VALUES($1,$2,$3,$2::uuid::text,'cell','in_progress',$4)`,
   [f.org,cellBatchId,order,f.actors[0].id]);
  return{sourceId:output.operationId,materialId:inputs.materialId,cuttingReceiptId:receipt.operationId,
   cellBatchId,sourceBatchId:f.batch,quantity:2,grade:'PASS'};
 }

 beforeEach(async()=>{
  // Only disposable database is permitted by the server fixture and migration gate.
  const fixturePath='../../../apps/server/src/cutting-output-test-fixture.ts';
  const {createCuttingOutputFixture}=await import(/* @vite-ignore */ fixturePath);
  f=await createCuttingOutputFixture();
  await f.pool.query("UPDATE production_batches SET status='in_progress' WHERE organization_id=$1 AND id=$2",[f.org,f.batch]);
  await inventoryOutbox.delete();await inventoryOutbox.open();
  postBodies.length=0;dropHandoff=false;dropReceipt=false;
 });
 afterEach(async()=>{
  vi.unstubAllGlobals();
  inventoryOutbox.close();await inventoryOutbox.delete();
  if(f){await f.app.close();await f.pool.end();}
 });

 it('replays one physical grade + recipient count across two lost ACKs, device restart and user switch',async()=>{
  const source=await makeRealCuttingSortingSource();
  const sender=actor(0),recipient=actor(4),stranger=actor(5);
  vi.stubGlobal('fetch',vi.fn(forwardClientFetch));
  const target={assemblyBatchId:source.cellBatchId,assemblyStepNumber:6,
   recipientId:recipient.scope.actorId};

  // Actual Android API reads real persisted grade and backend eligibility;
  // no client-asserted quantity is trusted as availability.
  const candidate=await loadAvailableAssemblyGrades(sender.session,sender.scope,target);
  expect(candidate.items).toHaveLength(1);
  expect(candidate.items[0]).toMatchObject({
   submissionId:source.sourceId,grade:'PASS',quantity:2,sourceBatchId:source.sourceBatchId,
   materialId:source.materialId,
  });
  expect(await databaseCount('inventory_assembly_electrode_handoffs')).toBe(0);

  // A disconnected Android save must not make ANY network request.
  const countBefore=vi.mocked(fetch).mock.calls.length;
  const frozen=await freezeAssemblyOffer(sender.scope,candidate.epoch,candidate.items[0],
   target,'Actual physical handoff','Counted and labelled two PASS electrodes');
  expect(vi.mocked(fetch).mock.calls.length).toBe(countBefore);
  expect((await assemblyDrafts(sender.scope,'offer'))[0].operationId).toBe(frozen.operationId);

  // Server committed, phone never received acknowledgement.
  dropHandoff=true;
  await expect(sendAssemblyDraft(sender.session,sender.scope,frozen.key))
   .rejects.toThrow('Handoff ACK lost');
  expect(await databaseCount('inventory_assembly_electrode_handoffs')).toBe(1);
  expect((await assemblyDrafts(sender.scope,'offer'))[0].fields.state).toBe('pending');

  // Simulate Android WebView/process restart: no credentials in IndexedDB,
  // but the frozen operation ID and exact payload survive.
  inventoryOutbox.close();await inventoryOutbox.open();
  await sendAssemblyDraft(sender.session,sender.scope,frozen.key);
  const handoffRequests=postBodies.filter(p=>p.path.endsWith('/assembly-electrodes/handoffs'));
  expect(handoffRequests.map(p=>p.status)).toEqual([201,200]);
  expect(handoffRequests[0].body).toBe(handoffRequests[1].body);
  expect(await databaseCount('inventory_assembly_electrode_handoffs')).toBe(1);
  expect((await assemblyDrafts(sender.scope,'offer'))[0].fields.state).toBe('accepted');

  // A different signed-in actor sees no assigned handoffs.
  const other=await loadAssemblyHandoffs(stranger.session,stranger.scope);
  expect(other.items).toHaveLength(0);
  const assigned=await loadAssemblyHandoffs(recipient.session,recipient.scope);
  expect(assigned.items).toHaveLength(1);
  expect(assigned.items[0].handoff).toMatchObject({
   operationId:frozen.operationId,grade:'PASS',quantity:2,recipientId:recipient.scope.actorId,
   warehouseEffect:'none',qualityStatus:'unreviewed',
  });
  expect(assigned.items[0].received).toBeNull();

  const counter=await freezeAssemblyReceipt(recipient.scope,assigned.epoch,
   assigned.items[0].handoff,2,'Independent physical receiving','Counted two actual pieces');
  expect((await assemblyDrafts(recipient.scope,'receive'))[0].operationId).toBe(counter.operationId);
  expect(await databaseCount('inventory_assembly_electrode_receipts')).toBe(0);
  expect(await assemblyDrafts(sender.scope,'receive')).toHaveLength(0);

  dropReceipt=true;
  await expect(sendAssemblyDraft(recipient.session,recipient.scope,counter.key))
   .rejects.toThrow('Receipt ACK lost');
  expect(await databaseCount('inventory_assembly_electrode_receipts')).toBe(1);
  expect((await assemblyDrafts(recipient.scope,'receive'))[0].fields.state).toBe('pending');
  inventoryOutbox.close();await inventoryOutbox.open();
  await sendAssemblyDraft(recipient.session,recipient.scope,counter.key);
  const receiptRequests=postBodies.filter(p=>p.path.endsWith('/assembly-electrodes/acknowledgements'));
  expect(receiptRequests.map(p=>p.status)).toEqual([201,200]);
  expect(receiptRequests[0].body).toBe(receiptRequests[1].body);
  expect((await assemblyDrafts(recipient.scope,'receive'))[0].fields.state).toBe('accepted');
  expect((await loadAssemblyHandoffs(recipient.session,recipient.scope)).items[0]
   .received?.operationId).toBe(counter.operationId);

  // No automatic retry/duplicate movement; submitted grade cannot also be
  // booked to warehouse. No saleable electrode stock or QA release created.
  await expect(sendAssemblyDraft(recipient.session,recipient.scope,counter.key))
   .rejects.toThrow('Нет ожидающей');
  expect(await databaseCount('inventory_assembly_electrode_handoffs')).toBe(1);
  expect(await databaseCount('inventory_assembly_electrode_receipts')).toBe(1);
  const existingStock=await f.pool.query(
   'SELECT count(*)::int AS n FROM inventory_stocks WHERE organization_id=$1 AND material_id=$2',
   [f.org,source.materialId]);
  expect(existingStock.rows[0].n).toBe(0);
  expect(await inventoryOutbox.stocks.count()).toBe(0);
  expect(await inventoryOutbox.acknowledgements.count()).toBe(0);
  expect(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray()))
   .not.toContain(sender.session.accessToken);
  expect(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray()))
   .not.toContain(recipient.session.deviceProofToken);
 });
});
