import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {inventoryLabel} from './inventoryIdentification';
import {loadInventoryIdentity,lookupCachedInventoryIdentity,resolveInventoryIdentityInput} from './inventoryLookup';
import {inventoryOutbox} from './inventoryOutbox';
import {beginInventoryOfflineView,cacheInventoryOfflineView} from './inventoryOfflineView';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'},epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id='44444444-4444-4444-8444-444444444444',session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const item={id,batchCode:'Batch42',materialLine:'cathode',status:'created',orderCode:'Order42',productCode:'NMC'};
beforeEach(async()=>{await inventoryOutbox.open();});afterEach(async()=>{vi.unstubAllGlobals();localStorage.clear();inventoryOutbox.close();await inventoryOutbox.delete();});
it('scopes typed/manual UUID lookups and strips extra fields before retaining only safe batch lookup data',async()=>{
 expect(resolveInventoryIdentityInput(id.toUpperCase(),scope.organizationId,'batch')).toEqual({kind:'batch',id});
 const fetch=vi.fn(async()=>new Response(JSON.stringify({epoch,organizationId:scope.organizationId,kind:'batch',item:{...item,accessToken:'DO-NOT-SAVE'}})));vi.stubGlobal('fetch',fetch);
 await expect(loadInventoryIdentity(session,scope,'local',epoch,inventoryLabel(id,'batch',id))).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();const result=await loadInventoryIdentity(session,scope,'local',epoch,inventoryLabel(scope.organizationId,'batch',id));expect(result.item).toEqual(item);expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray())).not.toContain('DO-NOT-SAVE');
});
it('denies forged kind/identity/tenant/epoch data and never mutates stock through a scan',async()=>{
 for(const patch of [{kind:'container'},{organizationId:id},{epoch:id},{item:{...item,id:epoch}},{item:{...item,status:'automatically_released'}}]){vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({epoch,organizationId:scope.organizationId,kind:'batch',item,...patch}))));await expect(loadInventoryIdentity(session,scope,'local',epoch,inventoryLabel(scope.organizationId,'batch',id))).rejects.toThrow();}expect(await inventoryOutbox.stocks.count()).toBe(0);expect(await inventoryOutbox.receivingDrafts.count()).toBe(0);
});
it('reopens only original-profile cached batch identity under a current verified offline lease and history',async()=>{
 const now=Date.now(),issued=now-1000;await inventoryOutbox.streams.put({scopeKey:[scope.serverUrl,scope.organizationId,scope.actorId,scope.deviceId].join('::'),epoch});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({epoch,organizationId:scope.organizationId,kind:'batch',item}))));await loadInventoryIdentity(session,scope,'local',epoch,inventoryLabel(scope.organizationId,'batch',id));
 const input={scope,access:{level:'operator' as const,canRecordReceipts:true,canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false,offlineView:{organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,issuedAt:new Date(now-500).toISOString(),expiresAt:new Date(now+60000).toISOString()}},materials:[],locations:[],localActorId:'local',localSessionIssuedAt:issued,localSessionExpiresAt:now+60000,syncedAt:now,generation:beginInventoryOfflineView()};await cacheInventoryOfflineView(input);inventoryOutbox.close();await inventoryOutbox.open();
 expect((await lookupCachedInventoryIdentity('local',issued,inventoryLabel(scope.organizationId,'batch',id),now)).item).toEqual(item);await expect(lookupCachedInventoryIdentity('another',issued,inventoryLabel(scope.organizationId,'batch',id),now)).rejects.toThrow();await expect(lookupCachedInventoryIdentity('local',issued,inventoryLabel(scope.organizationId,'batch',id),now+60001)).rejects.toThrow();
});
