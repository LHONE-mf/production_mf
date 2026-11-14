import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { freezeInventoryAdministration, listInventoryAdministration, sendInventoryAdministration, loadWarehouseUsers } from './inventoryAdministration';
import { inventoryOutbox } from './inventoryOutbox';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const access={level:'chief',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true};
const stream={...scope,organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,epoch,postingEnabled:true,sequence:0};
const draft={resource:'material' as const,code:'TEST',name:'Synthetic test',category:'component' as const,baseUnit:'pieces' as const};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
beforeEach(async()=>{await inventoryOutbox.open();});
afterEach(async()=>{vi.unstubAllGlobals();inventoryOutbox.close();await inventoryOutbox.delete();});
it('freezes one credential-free admin intent, reopens unchanged, and retries a lost ACK with the same ID',async()=>{
 const posts:string[]=[];let lose=true;
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname==='/inventory/access/me')return response(access);
  if(url.pathname==='/inventory/stream')return response(stream);
  posts.push(String(init?.body));
  if(lose){lose=false;throw new TypeError('Lost acknowledgement');}
  const body=JSON.parse(String(init?.body));return response({id:body.id,code:body.code,name:body.name,category:body.category,baseUnit:body.baseUnit});
 }));
 const frozen=await freezeInventoryAdministration(session,scope,'local',draft);
 expect(posts).toEqual([]);
 inventoryOutbox.close();await inventoryOutbox.open();
 const restored=(await listInventoryAdministration(scope,'local'))[0];
 expect(restored).toEqual(frozen);
 expect(JSON.stringify(restored)).not.toMatch(/accessToken|deviceProofToken/);
 await expect(sendInventoryAdministration(session,scope,'local',frozen.key)).rejects.toThrow('Lost acknowledgement');
 expect((await listInventoryAdministration(scope,'local'))[0].fields.state).toBe('pending');
 await sendInventoryAdministration(session,scope,'local',frozen.key);
 expect(posts).toHaveLength(2);expect(posts[0]).toBe(posts[1]);
 expect((await listInventoryAdministration(scope,'local'))[0].fields.state).toBe('accepted');
 expect(await listInventoryAdministration(scope,'other-profile')).toEqual([]);
});
it('operator, history rotation and malformed acknowledgements cannot accept or rebind an admin intent',async()=>{
 let currentAccess=access,currentEpoch=epoch,posts=0;
 vi.stubGlobal('fetch',vi.fn(async(url:URL)=>{
  if(url.pathname==='/inventory/access/me')return response(currentAccess);
  if(url.pathname==='/inventory/stream')return response({...stream,epoch:currentEpoch});
  posts++;return response({id:crypto.randomUUID(),code:'Wrong',name:'Wrong',category:'component',baseUnit:'pieces'});
 }));
 const frozen=await freezeInventoryAdministration(session,scope,'local',draft);
 currentAccess={...access,level:'operator',canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false};
 await expect(sendInventoryAdministration(session,scope,'local',frozen.key)).rejects.toThrow();expect(posts).toBe(0);
 currentAccess=access;currentEpoch='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 await expect(sendInventoryAdministration(session,scope,'local',frozen.key)).rejects.toThrow();expect(posts).toBe(0);
 currentEpoch=epoch;
 await expect(sendInventoryAdministration(session,scope,'local',frozen.key)).rejects.toThrow('acknowledgement');
 expect((await listInventoryAdministration(scope,'local'))[0].fields.state).toBe('pending');
});
it('validates effective grant pages and rejects forged roles, order, cursors and oversized pages',async()=>{
 const row={id:scope.actorId,login:'Chief',role:'chief',active:true,warehouseLevel:'chief'};
 vi.stubGlobal('fetch',vi.fn(async()=>response({users:[row],hasMore:false,nextAfter:null})));
 expect((await loadWarehouseUsers(session,scope)).items).toEqual([row]);
 vi.stubGlobal('fetch',vi.fn(async()=>response({users:[{...row,warehouseLevel:'superadmin'}],hasMore:false,nextAfter:null})));
 await expect(loadWarehouseUsers(session,scope)).rejects.toThrow('grant');
 await expect(loadWarehouseUsers(session,scope,undefined,101)).rejects.toThrow('page');
});
