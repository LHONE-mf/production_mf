import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {inventoryOutbox} from './inventoryOutbox';
import {loadInventoryOutputs} from './inventoryOutputs';
import {
 assemblyDrafts,freezeAssemblyOffer,freezeAssemblyReceipt,loadAssemblyHandoffs,sendAssemblyDraft,
 type AssemblyHandoff,type AssemblyReceiptRequest,
} from './assemblyTransfers';

vi.mock('./inventoryOutputs',()=>({loadInventoryOutputs:vi.fn()}));
const scope={serverUrl:'https://factory.example',organizationId:'11111111-1111-4111-8111-111111111111',
 actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const epoch='44444444-4444-4444-8444-444444444444';
const target={assemblyBatchId:'55555555-5555-4555-8555-555555555555',assemblyStepNumber:7,
 recipientId:'66666666-6666-4666-8666-666666666666'};
const grade={submissionId:'77777777-7777-4777-8777-777777777777',
 grade:'A',quantity:4,materialId:'88888888-8888-4888-8888-888888888888',
 sourceBatchId:'99999999-9999-4999-8999-999999999999',
 sourceStepNumber:5,sortRunId:'sort-run-a'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),
 deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,
 deviceProofExpiresAt:Date.now()+300_000};
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const offerHandoff=(request:Record<string,unknown>):AssemblyHandoff=>({
 ...request as unknown as AssemblyHandoff,sourceBatchId:grade.sourceBatchId,
 materialId:grade.materialId,recipientWorkshopId:'assembly-workshop-west',
 actorId:scope.actorId,recordedAt:'2026-11-20T13:00:00.000Z',
 warehouseEffect:'none',qualityStatus:'unreviewed',
});
const receiver={...scope,actorId:target.recipientId};
const receiptPage=(handoff:AssemblyHandoff,seen:unknown=null)=>({
 organizationId:receiver.organizationId,actorId:receiver.actorId,deviceId:receiver.deviceId,epoch,
 items:[{handoff,received:seen}],hasMore:false,nextAfter:null,
});
beforeEach(async()=>{
 await inventoryOutbox.delete();await inventoryOutbox.open();
 vi.mocked(loadInventoryOutputs).mockResolvedValue({epoch} as Awaited<ReturnType<typeof loadInventoryOutputs>>);
});
afterEach(async()=>{
 vi.unstubAllGlobals();vi.resetAllMocks();
 inventoryOutbox.close();await inventoryOutbox.delete();
});

it('allows recording original handoff and physical count without any network, and restores drafts after app restart',async()=>{
 const online=vi.fn(()=>{throw Error('offline')});vi.stubGlobal('fetch',online);
 const handoffRow=await freezeAssemblyOffer(scope,epoch,grade,target,'Physical handoff','Signed Sorting packet');
 const physical=offerHandoff({...JSON.parse(handoffRow.fields.request)});
 const receiptRow=await freezeAssemblyReceipt(receiver,epoch,physical,4,'Independent physical count','Batch label inspected');
 expect(online).not.toHaveBeenCalled();
 expect((await assemblyDrafts(scope,'offer'))[0].operationId).toBe(handoffRow.operationId);
 expect((await assemblyDrafts(receiver,'receive'))[0].operationId).toBe(receiptRow.operationId);
 expect(await assemblyDrafts(scope,'receive')).toHaveLength(0);
 expect(await assemblyDrafts(receiver,'offer')).toHaveLength(0);
 inventoryOutbox.close();await inventoryOutbox.open();
 expect((await assemblyDrafts(scope,'offer'))[0]).toEqual(handoffRow);
 expect((await assemblyDrafts(receiver,'receive'))[0]).toEqual(receiptRow);
 expect(await inventoryOutbox.stocks.count()).toBe(0);
 expect(await inventoryOutbox.acknowledgements.count()).toBe(0);
 expect(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray())).not.toContain(session.accessToken);
 expect(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray())).not.toContain(session.deviceProofToken);
});

it('keeps exactly one frozen operation through offline POST, restart and duplicate server ACK',async()=>{
 const queued=await freezeAssemblyOffer(scope,epoch,grade,target,'Physical transfer','Signed source evidence');
 const sent:string[]=[];let offline=true;
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init:RequestInit)=>{
  sent.push(String(init.body));
  if(offline)throw Error('Network disconnected after commit');
  const request=JSON.parse(String(init.body));
  return reply({status:'duplicate',operationId:request.operationId,handoff:offerHandoff(request)});
 }));
 await expect(sendAssemblyDraft(session,scope,queued.key)).rejects.toThrow('Network disconnected');
 expect((await inventoryOutbox.receivingDrafts.get(queued.key))?.fields.state).toBe('pending');
 inventoryOutbox.close();await inventoryOutbox.open();
 offline=false;
 await sendAssemblyDraft(session,scope,queued.key);
 expect(sent).toEqual([queued.fields.request,queued.fields.request]);
 expect((await inventoryOutbox.receivingDrafts.get(queued.key))?.fields.state).toBe('accepted');
 await expect(sendAssemblyDraft(session,scope,queued.key)).rejects.toThrow('Нет ожидающей');
 expect(sent).toHaveLength(2);
 expect(await inventoryOutbox.stocks.count()).toBe(0);
});

it('preserves a pending original after authorization/proof expiry, server errors and epoch review, with no unwanted second ID',async()=>{
 const queued=await freezeAssemblyOffer(scope,epoch,grade,target,'Original handoff','Signed record');
 const post=vi.fn(async()=>reply({error:'temporarily_unavailable'},503));
 vi.stubGlobal('fetch',post);
 await expect(sendAssemblyDraft({...session,deviceProofExpiresAt:Date.now()-10},scope,queued.key)).rejects.toThrow('Fresh device proof');
 expect(post).not.toHaveBeenCalled();
 await expect(sendAssemblyDraft(session,scope,queued.key)).rejects.toThrow('HTTP 503');
 vi.mocked(loadInventoryOutputs).mockRejectedValueOnce(Error('Inventory epoch changed'));
 await expect(sendAssemblyDraft(session,scope,queued.key)).rejects.toThrow('Inventory epoch changed');
 expect(post).toHaveBeenCalledTimes(1);
 expect((await inventoryOutbox.receivingDrafts.get(queued.key))?.fields.request).toBe(queued.fields.request);
 expect((await inventoryOutbox.receivingDrafts.get(queued.key))?.fields.state).toBe('pending');
 expect(await assemblyDrafts({...scope,organizationId:crypto.randomUUID()},'offer')).toHaveLength(0);
 expect(await assemblyDrafts({...scope,deviceId:crypto.randomUUID()},'offer')).toHaveLength(0);
});

it('separately replays the recipient\'s counted receipt after restart, while retaining no warehouse stock',async()=>{
 const offered=await freezeAssemblyOffer(scope,epoch,grade,target,'Offer','Actual packet');
 const handoff=offerHandoff(JSON.parse(offered.fields.request));
 const count=await freezeAssemblyReceipt(receiver,epoch,handoff,4,'Confirmed actual pieces','Observed matching source label');
 const sent:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(!init?.method)return reply(receiptPage(handoff));
  expect(url.pathname).toContain('acknowledgements');
  sent.push(String(init.body));
  if(sent.length===1)return reply({error:'server_busy'},502);
  const request=JSON.parse(String(init.body)) as AssemblyReceiptRequest;
  return reply({status:'confirmed',operationId:request.operationId,receipt:{
   ...request,sourceSnapshot:handoff,actorId:receiver.actorId,recordedAt:'2026-11-20T13:05:00.000Z',
   custodyEffect:'received',warehouseEffect:'none',qualityStatus:'unreviewed',
  }},201);
 }));
 await expect(sendAssemblyDraft(session,receiver,count.key)).rejects.toThrow('HTTP 502');
 inventoryOutbox.close();await inventoryOutbox.open();
 const read=await loadAssemblyHandoffs(session,receiver);
 expect(read.items[0].handoff.recipientWorkshopId).toBe('assembly-workshop-west');
 await sendAssemblyDraft(session,receiver,count.key);
 expect(sent).toEqual([count.fields.request,count.fields.request]);
 expect((await inventoryOutbox.receivingDrafts.get(count.key))?.fields.state).toBe('accepted');
 expect((await inventoryOutbox.receivingDrafts.get(offered.key))?.fields.state).toBe('pending');
 expect(await inventoryOutbox.stocks.count()).toBe(0);
});

it('blocks concurrent submissions for one scope while keeping the exact original pending ID',async()=>{
 const queued=await freezeAssemblyOffer(scope,epoch,grade,target,'Guarded send','Single operation');
 let release!:()=>void,started!:()=>void;
 const announced=new Promise<void>(resolve=>{started=resolve;});
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init:RequestInit)=>{
  started();await blocked;const request=JSON.parse(String(init.body));
  return reply({status:'confirmed',operationId:request.operationId,handoff:offerHandoff(request)},201);
 }));
 const first=sendAssemblyDraft(session,scope,queued.key);
 await announced;
 await expect(sendAssemblyDraft(session,scope,queued.key)).rejects.toThrow('already in progress');
 release();
 await first;
 expect(fetch).toHaveBeenCalledTimes(1);
 expect((await inventoryOutbox.receivingDrafts.get(queued.key))?.fields.state).toBe('accepted');
});
