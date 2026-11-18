import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {prepareInventorySplit,sendInventorySplit,inventorySplitProposals} from './inventorySplits';
import {inventoryOutbox,inventoryScopeKey,type InventoryStockSnapshot} from './inventoryOutbox';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const base:InventoryStockSnapshot={stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'SPLIT',quality:'released',disposition:'release',unit:'mg',onHand:1000,reserved:500,available:500,revision:3,expiresAt:'2099-01-01T00:00:00.000Z'};
const epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',access={level:'manager',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
beforeEach(async()=>{await inventoryOutbox.open();await inventoryOutbox.streams.put({scopeKey:inventoryScopeKey(scope),epoch});});afterEach(async()=>{vi.unstubAllGlobals();inventoryOutbox.close();await inventoryOutbox.delete();});
it('retains original approved split across reopen/lost ACK and accepts both exact stock snapshots/ACKs atomically',async()=>{
 let lost=true;const posts:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return response(access);if(url.pathname==='/inventory/stream')return response({...scope,epoch,postingEnabled:true,sequence:0});
  posts.push(String(init?.body));if(lost){lost=false;throw Error('Lost committed split ACK');}const r=JSON.parse(String(init?.body));return response({status:'duplicate',operationId:r.operationId,parent:{...base,onHand:700,available:200,revision:4},child:{...base,stockId:r.childStockId,locationId:r.locationId,onHand:300,reserved:0,available:300,revision:1},accessToken:'MUST-NOT-PERSIST'});
 }));
 const row=await prepareInventorySplit(session,scope,'local',base,epoch,300,base.locationId,'Authorized physical repack','Sealed child weight');expect(posts).toHaveLength(0);expect(await inventoryOutbox.stocks.count()).toBe(0);
 inventoryOutbox.close();await inventoryOutbox.open();expect((await inventorySplitProposals(scope,'local',base.stockId))[0]).toEqual(row);
 await expect(sendInventorySplit(session,scope,'local',row.key)).rejects.toThrow('Lost committed');await sendInventorySplit(session,scope,'local',row.key);expect(posts[0]).toBe(posts[1]);expect(await inventoryOutbox.stocks.count()).toBe(2);expect(await inventoryOutbox.acknowledgements.count()).toBe(2);expect((await inventorySplitProposals(scope,'local'))[0].fields.state).toBe('accepted');expect(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray())).not.toContain('MUST-NOT-PERSIST');
});
it('rejects forged child/parent quantities, QA/dates and conflicting retained ACK without partial local acceptance',async()=>{
 let tamper='quantity';vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return response(access);if(url.pathname==='/inventory/stream')return response({...scope,epoch,postingEnabled:true,sequence:0});const r=JSON.parse(String(init?.body));return response({status:'confirmed',operationId:r.operationId,parent:{...base,onHand:700,available:200,revision:4},child:{...base,stockId:r.childStockId,onHand:tamper==='quantity'?301:300,reserved:0,available:tamper==='quantity'?301:300,revision:1,...(tamper==='expiry'?{expiresAt:'2100-01-01T00:00:00.000Z'}:{})}},201);
 }));const row=await prepareInventorySplit(session,scope,'local',base,epoch,300,base.locationId,'Reason','Evidence');for(tamper of ['quantity','expiry'])await expect(sendInventorySplit(session,scope,'local',row.key)).rejects.toThrow();expect(await inventoryOutbox.stocks.count()).toBe(0);expect(await inventoryOutbox.acknowledgements.count()).toBe(0);
 tamper='none';const request=JSON.parse(row.fields.request);await inventoryOutbox.acknowledgements.add({operationId:request.childOperationId,scopeKey:inventoryScopeKey(scope),epoch,kind:'split_in',stockId:request.childStockId,request,stock:base,receivedAt:Date.now()});await expect(sendInventorySplit(session,scope,'local',row.key)).rejects.toThrow('Conflicting retained');expect(await inventoryOutbox.stocks.count()).toBe(0);expect((await inventorySplitProposals(scope,'local'))[0].fields.state).toBe('pending');
});
it('never authorizes operators or binds an original split screen to a restored epoch; conflicts stay inspectable',async()=>{
 let level='operator',currentEpoch=epoch;let posts=0;vi.stubGlobal('fetch',vi.fn(async(url:URL)=>url.pathname.endsWith('/me')?response({...access,level,canCorrectStock:level==='manager',canManageCatalog:level==='manager',correctionRoleEligible:level==='manager'}):url.pathname==='/inventory/stream'?response({...scope,epoch:currentEpoch,postingEnabled:true,sequence:0}):(posts++,response({error:'revision_conflict'},409))));
 await expect(prepareInventorySplit(session,scope,'local',base,epoch,300,base.locationId,'Reason','Evidence')).rejects.toThrow();level='manager';const row=await prepareInventorySplit(session,scope,'local',base,epoch,300,base.locationId,'Reason','Evidence');currentEpoch=crypto.randomUUID();await expect(sendInventorySplit(session,scope,'local',row.key)).rejects.toThrow();expect(posts).toBe(0);currentEpoch=epoch;await expect(sendInventorySplit(session,scope,'local',row.key)).rejects.toThrow();expect((await inventorySplitProposals(scope,'local'))[0].fields).toMatchObject({state:'conflict',request:row.fields.request});
});


it('rejects blocked stock and requires a persisted quarantine acknowledgement before proposal creation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:URL)=>url.pathname.endsWith('/me')?response(access):response({...scope,epoch,postingEnabled:true,sequence:0})));
 const quarantined={...base,quality:'quarantine' as const,disposition:undefined,reserved:0,available:1000};
 await expect(prepareInventorySplit(session,scope,'local',quarantined,epoch,300,base.locationId,'Quarantine repack','Counted',false))
  .rejects.toThrow('Требуется явное подтверждение карантина');
 expect(await inventorySplitProposals(scope,'local')).toHaveLength(0);
 const row=await prepareInventorySplit(session,scope,'local',quarantined,epoch,300,base.locationId,'Quarantine repack','Counted',true);
 expect(JSON.parse(row.fields.request).quarantineAcknowledged).toBe(true);
 inventoryOutbox.close();await inventoryOutbox.open();
 expect((await inventorySplitProposals(scope,'local'))[0].fields.request).toBe(row.fields.request);
 await expect(prepareInventorySplit(session,scope,'local',{...quarantined,quality:'blocked' as const,disposition:'hold' as const},epoch,300,base.locationId,'Blocked repack','Counted',true))
  .rejects.toThrow('Заблокированный материал нельзя разделять');
 expect(await inventorySplitProposals(scope,'local')).toHaveLength(1);
});
