import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {inventoryOutbox} from './inventoryOutbox';
import {autoSyncLocalReceipts,localReceiptsForUser,saveUnboundReceipt} from './localWarehouseReceipts';
import {setServerConnection,type ServerConnection} from './serverConnection';
import {useAuthStore} from '../store/authStore';
import {UserRole,type User} from '../types';

const organizationId='11111111-1111-4111-8111-111111111111';
const actorId='22222222-2222-4222-8222-222222222222';
const deviceId='33333333-3333-4333-8333-333333333333';
const materialId='55555555-5555-4555-8555-555555555555';
const locationId='66666666-6666-4666-8666-666666666666';
const epoch='77777777-7777-4777-8777-777777777777';
const user:User={id:'local-operator',login:'local-operator',fullName:'Warehouse operator',password:'test-only',
 role:UserRole.WORKER,isActive:true,createdAt:new Date()};
const connection:ServerConnection={
 serverUrl:'https://storage.example',organizationId,serverActorId:actorId,selectedDeviceId:deviceId,
 enrolledDeviceId:deviceId,myDevices:[deviceId],serverRole:'worker',
 session:{serverUrl:'https://storage.example',accessToken:'A'.repeat(43),
  deviceProofToken:'B'.repeat(43),deviceProofDeviceId:deviceId,
  deviceProofExpiresAt:Date.now()+300_000},
};
const draft={
 materialCode:'PVDF',locationPath:'Склад / Полка 2',manufacturerLot:'LOT-22',quantity:'1.25',unit:'kg',
 reason:'Фактически принято и пересчитано',receiptReference:'IN-005',supplier:'Supplier A',
};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{
 status,headers:{'content-type':'application/json'},
});
const goodMaterial={id:materialId,code:'PVDF',name:'Polyvinylidene fluoride',category:'raw_material',baseUnit:'mg',active:true};
const goodLocation={id:locationId,parentId:null,label:'Склад',kind:'warehouse',active:true};
const shelf={id:'88888888-8888-4888-8888-888888888888',parentId:locationId,label:'Полка 2',kind:'shelf',active:true};
function mockApi(options:{ambiguous?:boolean;lostAck?:boolean}={}){
 let replyLost=false,stored:any=null;
 const posts:string[]=[];
 const fetch=vi.fn(async(url:URL|string,init:RequestInit)=>{
  const path=new URL(String(url)).pathname;
  if(path==='/inventory/access/me')return response({
   level:'operator',canRecordReceipts:true,canManageCatalog:false,
   canCorrectStock:false,correctionRoleEligible:false,
  });
  if(path==='/inventory/materials')return response({
   materials:options.ambiguous?[goodMaterial,{...goodMaterial,id:'99999999-9999-4999-8999-999999999999',code:'OTHER',name:'PVDF'}]:[goodMaterial],
   hasMore:false,nextAfter:null,
  });
  if(path==='/inventory/locations')return response({
   locations:[goodLocation,shelf],hasMore:false,nextAfter:null,
  });
  if(path==='/inventory/stream')return response({
   organizationId,actorId,deviceId,sequence:0,epoch,postingEnabled:true,
  });
  if(path==='/inventory/receipts'){
   const raw=String(init?.body);posts.push(raw);
   const request=JSON.parse(raw);
   const status=stored?200:201;
   if(!stored)stored={stockId:request.stockId,materialId:request.materialId,
    locationId:request.locationId,manufacturerLot:request.manufacturerLot,
    unit:'mg',quality:'quarantine',onHand:request.quantity,reserved:0,revision:1,
    available:request.quantity};
   if(options.lostAck&&!replyLost){replyLost=true;throw Error('Network dropped after PostgreSQL commit');}
   return response({status:status===200?'duplicate':'confirmed',
    operationId:request.operationId,stock:stored},status);
  }
  throw Error('Unexpected API: '+path);
 });
 vi.stubGlobal('fetch',fetch);
 return{fetch,posts};
}

beforeEach(async()=>{
 await inventoryOutbox.delete();await inventoryOutbox.open();
 useAuthStore.getState().login(user);
 setServerConnection(null);
});
afterEach(async()=>{
 setServerConnection(null);useAuthStore.getState().logout();
 vi.unstubAllGlobals();inventoryOutbox.close();await inventoryOutbox.delete();
});

it('saves an offline physical receipt without credentials, binds unique catalog IDs on connection, and replays lost ACK after app restart',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const saved=await saveUnboundReceipt(user.id,draft);
 expect(fetch).not.toHaveBeenCalled();
 expect(saved.state).toBe('pending');
 expect(await inventoryOutbox.operations.count()).toBe(0);
 expect((await localReceiptsForUser('another-operator'))).toHaveLength(0);
 const api=mockApi({lostAck:true});
 setServerConnection(connection);
 await expect(autoSyncLocalReceipts(connection,user.id)).rejects.toThrow('Network dropped');
 expect(api.posts).toHaveLength(1);
 const original=JSON.parse(api.posts[0]);
 expect(original).toMatchObject({
  operationId:saved.operationId,stockId:saved.stockId,deviceId,
  materialId,locationId:shelf.id,manufacturerLot:'LOT-22',
  quantity:1250000,expectedRevision:0,receiptReference:'IN-005',
 });
 expect((await inventoryOutbox.localReceipts.get(saved.operationId))?.state).toBe('queued');
 expect((await inventoryOutbox.operations.get(saved.operationId))?.state).toBe('pending');
 expect(await inventoryOutbox.stocks.count()).toBe(0);
 inventoryOutbox.close();await inventoryOutbox.open();
 await autoSyncLocalReceipts(connection,user.id);
 expect(api.posts).toHaveLength(2);
 expect(api.posts[0]).toBe(api.posts[1]);
 expect((await inventoryOutbox.localReceipts.get(saved.operationId))?.state).toBe('confirmed');
 expect(await inventoryOutbox.operations.count()).toBe(0);
 expect(await inventoryOutbox.acknowledgements.count()).toBe(1);
 expect((await inventoryOutbox.stocks.toArray())[0].quality).toBe('quarantine');
 const serialized=JSON.stringify(await inventoryOutbox.localReceipts.toArray());
 expect(serialized).not.toContain(connection.session.accessToken);
 expect(serialized).not.toContain(connection.session.deviceProofToken);
});

it('never guesses duplicate material and retains unmatched receipt locally without posting',async()=>{
 const record=await saveUnboundReceipt(user.id,{...draft,materialCode:'PVDF'});
 const api=mockApi({ambiguous:true});
 setServerConnection(connection);
 await autoSyncLocalReceipts(connection,user.id);
 const after=await inventoryOutbox.localReceipts.get(record.operationId);
 expect(after?.state).toBe('needs_review');
 expect(after?.error).toContain('несколько материалов');
 expect(await inventoryOutbox.operations.count()).toBe(0);
 expect(api.posts).toHaveLength(0);
 expect(await inventoryOutbox.stocks.count()).toBe(0);
});

it('never lets another local user auto-post a previous user\'s saved physical receipt',async()=>{
 const row=await saveUnboundReceipt(user.id,draft);
 useAuthStore.getState().login({...user,id:'other-local-user',login:'other-local-user'});
 const api=mockApi();
 setServerConnection(connection);
 await autoSyncLocalReceipts(connection,'other-local-user');
 expect(api.fetch).not.toHaveBeenCalled();
 expect((await inventoryOutbox.localReceipts.get(row.operationId))?.state).toBe('pending');
 expect(await inventoryOutbox.operations.count()).toBe(0);
});
