import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {inventoryOutbox} from './inventoryOutbox';
import {loadInventoryOutputs} from './inventoryOutputs';
import {assemblyDrafts,freezeAssemblyOffer,freezeAssemblyReceipt,sendAssemblyDraft,
 loadAssemblyHandoffs,type AssemblyHandoff,type AssemblyReceiptRequest} from './assemblyTransfers';

vi.mock('./inventoryOutputs',()=>({loadInventoryOutputs:vi.fn()}));
const scope={serverUrl:'https://factory.example',organizationId:'11111111-1111-4111-8111-111111111111',
 actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const epoch='44444444-4444-4444-8444-444444444444';
const target={assemblyBatchId:'55555555-5555-4555-8555-555555555555',
 assemblyStepNumber:7,recipientId:'66666666-6666-4666-8666-666666666666'};
const grade={submissionId:'77777777-7777-4777-8777-777777777777',grade:'A',quantity:4,
 materialId:'88888888-8888-4888-8888-888888888888',
 sourceBatchId:'99999999-9999-4999-8999-999999999999',sourceStepNumber:5,sortRunId:'sorted-actual'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),
 deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
function handoff(request:Record<string,unknown>):AssemblyHandoff{
 return{...request as unknown as AssemblyHandoff,sourceBatchId:grade.sourceBatchId,materialId:grade.materialId,
  recipientWorkshopId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actorId:scope.actorId,
  recordedAt:'2026-11-20T09:00:00Z',warehouseEffect:'none',qualityStatus:'unreviewed'};
}
beforeEach(async()=>{
 vi.mocked(loadInventoryOutputs).mockResolvedValue({epoch} as Awaited<ReturnType<typeof loadInventoryOutputs>>);
 await inventoryOutbox.delete();await inventoryOutbox.open();
});
afterEach(async()=>{vi.unstubAllGlobals();vi.resetAllMocks();inventoryOutbox.close();await inventoryOutbox.delete();});

it('freezes offer without sending, survives reopening and retries the same ID after lost ACK without stock changes',async()=>{
 const frozen=await freezeAssemblyOffer(scope,epoch,grade,target,'Actual handover','Grade packet counted');
 expect((await assemblyDrafts(scope,'offer')).map(d=>d.operationId)).toEqual([frozen.operationId]);
 inventoryOutbox.close();await inventoryOutbox.open();
 const bodies:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init:RequestInit)=>{
  expect(init.method).toBe('POST');expect((init.headers as Record<string,string>)['x-inventory-epoch']).toBe(epoch);
  bodies.push(String(init.body));
  if(bodies.length===1)throw Error('Lost Assembly ACK');
  const request=JSON.parse(String(init.body));
  return response({status:'duplicate',operationId:request.operationId,handoff:handoff(request)},200);
 }));
 await expect(sendAssemblyDraft(session,scope,frozen.key)).rejects.toThrow('Lost Assembly ACK');
 expect((await assemblyDrafts(scope,'offer'))[0].fields.state).toBe('pending');
 await sendAssemblyDraft(session,scope,frozen.key);
 expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
 expect((await assemblyDrafts(scope,'offer'))[0].fields.state).toBe('accepted');
 expect(await inventoryOutbox.stocks.count()).toBe(0);
 expect(JSON.stringify(await assemblyDrafts(scope,'offer'))).not.toContain(session.accessToken);
 expect(JSON.stringify(await assemblyDrafts(scope,'offer'))).not.toContain(session.deviceProofToken);
});

it('never posts another actor\'s frozen offer and rejects a forged acknowledgement',async()=>{
 const frozen=await freezeAssemblyOffer(scope,epoch,grade,target,'Transfer','Count');
 const post=vi.fn(async(_url:URL,init:RequestInit)=>response({
  status:'confirmed',operationId:frozen.operationId,
  handoff:{...handoff(JSON.parse(String(init.body))),quantity:100}},201));
 vi.stubGlobal('fetch',post);
 await expect(sendAssemblyDraft(session,{...scope,actorId:target.recipientId},frozen.key)).rejects.toThrow('другого');
 expect(post).not.toHaveBeenCalled();
 await expect(sendAssemblyDraft(session,scope,frozen.key)).rejects.toThrow('исходную передачу');
 expect((await assemblyDrafts(scope,'offer'))[0].fields.state).toBe('pending');
 await expect(freezeAssemblyOffer(scope,epoch,grade,target,'Duplicate','Attempt')).rejects.toThrow('сохранена');
});

it('a separate assigned recipient counts the exact grade, sends a distinct operation and cannot manufacture stock',async()=>{
 const receiverScope={...scope,actorId:target.recipientId};
 const original=handoff({operationId:crypto.randomUUID(),deviceId:scope.deviceId,
  submissionId:grade.submissionId,grade:grade.grade,quantity:grade.quantity,
  assemblyBatchId:target.assemblyBatchId,assemblyStepNumber:target.assemblyStepNumber,
  recipientId:target.recipientId,reason:'Actual transfer',evidence:'Observed lot'});
 await expect(freezeAssemblyReceipt(receiverScope,epoch,original,3,'Wrong','Count')).rejects.toThrow('пересчитать');
 await expect(freezeAssemblyReceipt(scope,epoch,original,4,'Wrong actor','Count')).rejects.toThrow('Получатель');
 const frozen=await freezeAssemblyReceipt(receiverScope,epoch,original,4,'Physical receipt','Counted four');
 let posts=0;
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(!init?.method)return response({organizationId:scope.organizationId,actorId:receiverScope.actorId,
   deviceId:scope.deviceId,epoch,items:[{handoff:original,received:null}],hasMore:false,nextAfter:null});
  posts++;
  expect(url.pathname).toContain('acknowledgements');
  const body=JSON.parse(String(init.body)) as AssemblyReceiptRequest;
  expect(body.handoffId).toBe(original.operationId);
  expect(body.observedLabel).toBe('production:'+grade.submissionId+':A');
  return response({status:'confirmed',operationId:body.operationId,receipt:{...body,
   sourceSnapshot:original,actorId:receiverScope.actorId,recordedAt:'2026-11-20T09:01:00Z',
   custodyEffect:'received',warehouseEffect:'none',qualityStatus:'unreviewed'}},201);
 }));
 await sendAssemblyDraft(session,receiverScope,frozen.key);
 expect(posts).toBe(1);expect((await assemblyDrafts(receiverScope,'receive'))[0].fields.state).toBe('accepted');
 expect(await inventoryOutbox.stocks.count()).toBe(0);
});

it('rejects forged recipient pages and mismatched server receipt evidence',async()=>{
 const receiverScope={...scope,actorId:target.recipientId};
 const original=handoff({operationId:crypto.randomUUID(),deviceId:scope.deviceId,
  submissionId:grade.submissionId,grade:'A',quantity:4,assemblyBatchId:target.assemblyBatchId,
  assemblyStepNumber:target.assemblyStepNumber,recipientId:target.recipientId,
  reason:'Transfer',evidence:'Count'});
 let actor=scope.actorId;
 vi.stubGlobal('fetch',vi.fn(async()=>response({organizationId:scope.organizationId,actorId:actor,
  deviceId:scope.deviceId,epoch,items:[{handoff:original,received:null}],hasMore:false,nextAfter:null})));
 await expect(loadAssemblyHandoffs(session,receiverScope)).rejects.toThrow('владелец');
 actor=target.recipientId;
 expect((await loadAssemblyHandoffs(session,receiverScope)).items[0].handoff).toEqual(original);
 const frozen=await freezeAssemblyReceipt(receiverScope,epoch,original,4,'Receipt','Counted');
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{
  if(!init?.method)return response({organizationId:scope.organizationId,actorId:receiverScope.actorId,
   deviceId:scope.deviceId,epoch,items:[{handoff:original,received:null}],hasMore:false,nextAfter:null});
  const r=JSON.parse(String(init.body));
  return response({status:'confirmed',operationId:r.operationId,receipt:{...r,
   sourceSnapshot:original,actorId:receiverScope.actorId,recordedAt:'2026-11-20T09:01:00Z',
   custodyEffect:'received',warehouseEffect:'none',qualityStatus:'unreviewed',
   observedQuantity:5}},201);
 }));
 await expect(sendAssemblyDraft(session,receiverScope,frozen.key)).rejects.toThrow('Некорректная физическая приёмка');
 expect((await assemblyDrafts(receiverScope,'receive'))[0].fields.state).toBe('pending');
});
