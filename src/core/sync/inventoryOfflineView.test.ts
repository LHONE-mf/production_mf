import{beforeEach,afterEach,it,expect}from'vitest';
import{inventoryOutbox,inventoryScopeKey}from'./inventoryOutbox';
import{beginInventoryOfflineView,cacheInventoryOfflineView,loadInventoryOfflineView,invalidateInventoryOfflineViews}from'./inventoryOfflineView';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const now=Date.now(),login=now-1000;
const access={level:'operator' as const,canRecordReceipts:true,canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false,offlineView:{organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString()}};
const input=()=>({scope,access,materials:[],locations:[],localActorId:'local-user',localSessionIssuedAt:login,localSessionExpiresAt:now+7200000,syncedAt:now,generation:beginInventoryOfflineView()});
beforeEach(async()=>{await inventoryOutbox.open();await inventoryOutbox.streams.put({scopeKey:inventoryScopeKey(scope),epoch:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});});afterEach(async()=>{await invalidateInventoryOfflineViews();inventoryOutbox.close();await inventoryOutbox.delete();localStorage.clear();});
it('restores a bounded original scope after reopen without bearer/proof credentials',async()=>{
 await cacheInventoryOfflineView(input());inventoryOutbox.close();await inventoryOutbox.open();
 const cached=await loadInventoryOfflineView('local-user',login,now+1000);
 expect(cached?.scopeKey).toBe(inventoryScopeKey(scope));expect(JSON.stringify(cached)).not.toMatch(/accessToken|deviceProofToken|password/);
 expect(await loadInventoryOfflineView('another-user',login,now)).toBeNull();expect(await loadInventoryOfflineView('local-user',login+1,now)).toBeNull();expect(await loadInventoryOfflineView('local-user',login,now+3600001)).toBeNull();expect(await loadInventoryOfflineView('local-user',login,now)).toBeNull();
});
it('refuses wrong identities, excessive lifetime, clock rollback and revoked generations without deleting queues',async()=>{
 const value=input();await expect(cacheInventoryOfflineView({...value,access:{...access,offlineView:{...access.offlineView,deviceId:scope.actorId}}})).rejects.toThrow();
 await expect(cacheInventoryOfflineView({...value,access:{...access,offlineView:{...access.offlineView,expiresAt:new Date(now+28800001).toISOString()}}})).rejects.toThrow();
 await cacheInventoryOfflineView(value);expect(await loadInventoryOfflineView('local-user',login,now-300000)).toBeNull();
 invalidateInventoryOfflineViews();expect(await loadInventoryOfflineView('local-user',login,now)).toBeNull();await expect(cacheInventoryOfflineView(value)).rejects.toThrow();
 expect(await inventoryOutbox.operations.count()).toBe(0);
});
it('bounds expiry by the local login and fails closed on corrupt catalogue data',async()=>{
 await cacheInventoryOfflineView({...input(),localSessionExpiresAt:now+1000});expect(await loadInventoryOfflineView('local-user',login,now+1001)).toBeNull();
 await inventoryOutbox.offlineViews.update('local-user',{materials:[{id:'corrupt'}] as never});expect(await loadInventoryOfflineView('local-user',login,now)).toBeNull();expect(await inventoryOutbox.offlineViews.count()).toBe(1);
});
it('revokes cached access on an authenticated denial while retaining the original pending receipt',async()=>{
 const {queueInventoryReceipt}=await import('./inventoryOutbox');const {loadWarehouseAccess}=await import('./inventoryCatalogClient');const {vi}=await import('vitest');
 const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofToken:'B'.repeat(43),deviceProofExpiresAt:Date.now()+60000,offlineEditExpiresAt:Date.now()+60000};
 await cacheInventoryOfflineView(input());const id=await queueInventoryReceipt(session,scope,{stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'A',quantity:1,expectedRevision:0,reason:'Preserved evidence'});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403,json:async()=>({error:'forbidden'})}));
 try{await expect(loadWarehouseAccess(session,scope)).rejects.toThrow('HTTP 403');expect(await loadInventoryOfflineView('local-user',login,now)).toBeNull();expect((await inventoryOutbox.operations.get(id))?.request.reason).toBe('Preserved evidence');}finally{vi.unstubAllGlobals();}
});
