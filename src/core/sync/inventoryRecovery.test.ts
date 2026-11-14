import{beforeEach,afterEach,it,expect,vi}from'vitest';
import{inventoryOutbox,inventoryScopeKey,queueInventoryReceipt}from'./inventoryOutbox';
import{queueInventoryStockChange,reviewInventoryConflict}from'./inventoryStockOutbox';
import{inventoryRecoveryEvidence,applyInventoryRecovery,approveInventoryRecovery,latestInventoryRecoveryArchive}from'./inventoryRecovery';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'},scopeKey=inventoryScopeKey(scope),oldEpoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',newEpoch='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',approvalId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofToken:'B'.repeat(43),deviceProofExpiresAt:Date.now()+60000,offlineEditExpiresAt:Date.now()+60000};
const request={stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'A',quantity:2125000,expectedRevision:0 as const,reason:'Original physical evidence'};
let approvedDigest='',approvalAvailable=true;
beforeEach(async()=>{await inventoryOutbox.open();await inventoryOutbox.streams.put({scopeKey,epoch:oldEpoch});await inventoryOutbox.metadata.put({key:scopeKey+':cursor',value:9});await inventoryOutbox.stocks.put({...request,scopeKey,unit:'mg',quality:'quarantine',onHand:2125000,reserved:0,available:2125000,revision:1});approvalAvailable=true;vi.stubGlobal('fetch',vi.fn(async(url:URL)=>new Response(JSON.stringify(url.pathname.endsWith('/me')?{level:'chief',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true}:{organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,epoch:newEpoch,postingEnabled:false,approval:approvalAvailable?{approvalId,organizationId:scope.organizationId,targetActorId:scope.actorId,targetDeviceId:scope.deviceId,epoch:newEpoch,approvedBy:scope.actorId,approvalDeviceId:scope.deviceId,evidenceDigest:approvedDigest,reason:'Compared restored ledger',evidence:'Signed count reference',approvedAt:new Date().toISOString()}:null}),{status:200})));});
afterEach(async()=>{inventoryOutbox.close();await inventoryOutbox.delete();vi.unstubAllGlobals();});
it('archives the full old state atomically, holds original intent and adopts only a Chief-approved history',async()=>{
 const id=await queueInventoryReceipt(session,scope,request),packet=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=packet.evidenceDigest;
 const result=await applyInventoryRecovery(session,scope,'local',packet.evidenceDigest);expect(result.epoch).toBe(newEpoch);expect((await inventoryOutbox.streams.get(scopeKey))?.epoch).toBe(newEpoch);expect((await inventoryOutbox.metadata.get(scopeKey+':cursor'))?.value).toBe(0);expect(await inventoryOutbox.stocks.count()).toBe(0);
 expect(await inventoryOutbox.operations.get(id)).toMatchObject({state:'review',recoveryApprovalId:approvalId,request});const archive=await inventoryOutbox.recoveryArchives.get(approvalId);expect(archive?.evidence.stocks[0].onHand).toBe(2125000);expect(archive?.evidence.receipts[0].operationId).toBe(id);expect(archive?.epoch).toBe(oldEpoch);expect((await latestInventoryRecoveryArchive(session,scope)).evidenceDigest).toBe(packet.evidenceDigest);
});
it('refuses changed local evidence or missing approval without losing original data',async()=>{
 await queueInventoryReceipt(session,scope,request);const packet=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=packet.evidenceDigest;await queueInventoryReceipt(session,scope,{...request,stockId:'77777777-7777-4777-8777-777777777777'});
 await expect(applyInventoryRecovery(session,scope,'local',packet.evidenceDigest)).rejects.toThrow('измен');expect(await inventoryOutbox.recoveryArchives.count()).toBe(0);expect(await inventoryOutbox.operations.count()).toBe(2);expect(await inventoryOutbox.stocks.count()).toBe(1);
 const latest=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=latest.evidenceDigest;approvalAvailable=false;await expect(applyInventoryRecovery(session,scope,'local',latest.evidenceDigest)).rejects.toThrow('подтверж');expect((await inventoryOutbox.streams.get(scopeKey))?.epoch).toBe(oldEpoch);
});
it('rechecks local evidence inside the archive transaction and preserves changes made during approval lookup',async()=>{
 await queueInventoryReceipt(session,scope,request);const packet=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=packet.evidenceDigest;
 const original=fetch;vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{const result=await original(url,init);if(url.pathname.endsWith('/recovery-approvals'))await inventoryOutbox.metadata.put({key:scopeKey+':cursor',value:10});return result;}));
 await expect(applyInventoryRecovery(session,scope,'local',packet.evidenceDigest)).rejects.toThrow('измен');expect(await inventoryOutbox.recoveryArchives.count()).toBe(0);expect(await inventoryOutbox.stocks.count()).toBe(1);expect((await inventoryOutbox.operations.toArray())[0].state).toBe('pending');
});
it('rejects a response for another device and preserves other scopes during an approved reset',async()=>{
 await queueInventoryReceipt(session,scope,request);const packet=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=packet.evidenceDigest;
 const original=fetch;vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{const response=await original(url,init);if(!url.pathname.endsWith('/recovery-approvals'))return response;const raw=await response.json();raw.approval.targetDeviceId=approvalId;return new Response(JSON.stringify(raw));}));
 await expect(applyInventoryRecovery(session,scope,'local',packet.evidenceDigest)).rejects.toThrow('подтверж');expect(await inventoryOutbox.recoveryArchives.count()).toBe(0);
 vi.stubGlobal('fetch',original);const otherKey=inventoryScopeKey({...scope,actorId:approvalId});await inventoryOutbox.stocks.put({...request,scopeKey:otherKey,unit:'mg',quality:'quarantine',onHand:2125000,reserved:0,available:2125000,revision:1});
 await applyInventoryRecovery(session,scope,'local',packet.evidenceDigest);expect(await inventoryOutbox.stocks.count()).toBe(1);expect((await inventoryOutbox.stocks.toArray())[0].scopeKey).toBe(otherKey);
});

it('Chief approval binds a stable ID and exact digest, and rejects changed or foreign imported packages before posting',async()=>{
 const packet=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=packet.evidenceDigest;const original=fetch,posts:Record<string,unknown>[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{if(init?.method==='POST'){const body=JSON.parse(init.body as string);posts.push(body);return new Response(JSON.stringify({approval:{...body,organizationId:scope.organizationId,approvedBy:scope.actorId,approvalDeviceId:scope.deviceId,approvedAt:new Date().toISOString()}}));}return original(url,init);}));
 await approveInventoryRecovery(session,scope,packet,'Compared ledger','Document reference',approvalId);await approveInventoryRecovery(session,scope,packet,'Compared ledger','Document reference',approvalId);expect(posts).toHaveLength(2);expect(posts[0]).toEqual(posts[1]);expect(posts[0]).toMatchObject({epoch:newEpoch,evidenceDigest:packet.evidenceDigest,targetDeviceId:scope.deviceId,approvalId});
 await expect(approveInventoryRecovery(session,scope,{...packet,cursor:99},'Reason','Reference',approvalId)).rejects.toThrow('измен');
 await expect(approveInventoryRecovery(session,scope,{...packet,scope:{...scope,serverUrl:'https://other.example'}},'Reason','Reference',approvalId)).rejects.toThrow();expect(posts).toHaveLength(2);
});
it('does not offer approval authority to an operator even with valid original evidence',async()=>{
 const packet=await inventoryRecoveryEvidence(session,scope,'local'),original=fetch;let posts=0;
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{if(init?.method==='POST')posts++;if(url.pathname.endsWith('/me'))return new Response(JSON.stringify({level:'operator',canRecordReceipts:true,canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false}));return original(url,init);}));
 await expect(approveInventoryRecovery(session,scope,packet,'Reason','Reference',approvalId)).rejects.toThrow('Chief');expect(posts).toBe(0);
});

it('keeps a held stock proposal frozen until explicit review without claiming it was posted',async()=>{
 const id=await queueInventoryStockChange(session,scope,{stockId:request.stockId,kind:'transfer',toLocationId:'77777777-7777-4777-8777-777777777777',expectedRevision:1,quantity:2125000,reason:'Physical container move intent'});
 const original=(await inventoryOutbox.stockOperations.get(id))!,packet=await inventoryRecoveryEvidence(session,scope,'local');approvedDigest=packet.evidenceDigest;
 await expect(reviewInventoryConflict(scope,id,'Not yet reviewed')).rejects.toThrow();await applyInventoryRecovery(session,scope,'local',packet.evidenceDigest);
 expect(await inventoryOutbox.stockOperations.get(id)).toMatchObject({state:'review',request:original.request,base:original.base,recoveryApprovalId:approvalId});
 await reviewInventoryConflict(scope,id,'Compared physical location and restored ledger; outcome documented');
 expect(await inventoryOutbox.stockOperations.get(id)).toMatchObject({state:'review',request:original.request,reviewReason:'Compared physical location and restored ledger; outcome documented'});expect((await inventoryOutbox.recoveryArchives.get(approvalId))?.evidence.stockChanges[0].request).toEqual(original.request);
});
