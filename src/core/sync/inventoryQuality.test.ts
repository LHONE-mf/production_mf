import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {prepareInventoryQuality,sendInventoryQuality,inventoryQualityProposals} from './inventoryQuality';
import {inventoryOutbox,type InventoryStockSnapshot} from './inventoryOutbox';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const base:InventoryStockSnapshot={stockId:'44444444-4444-4444-8444-444444444444',materialId:'55555555-5555-4555-8555-555555555555',locationId:'66666666-6666-4666-8666-666666666666',manufacturerLot:'QA',quality:'quarantine',unit:'mg',onHand:2125000,reserved:0,available:2125000,revision:1,expiresAt:'2099-01-01T00:00:00.000Z'};
const epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',access={level:'chief',canRecordReceipts:true,canManageCatalog:true,canCorrectStock:true,correctionRoleEligible:true};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
beforeEach(async()=>{await inventoryOutbox.open();});afterEach(async()=>{vi.unstubAllGlobals();inventoryOutbox.close();await inventoryOutbox.delete();});
it('retains Chief frozen QA intent across restart/lost ACK and atomically retains the exact acknowledgement without changing quantity',async()=>{
 let lost=true;const posts:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return response(access);
  if(url.pathname==='/inventory/stream')return response({...scope,epoch,postingEnabled:true,sequence:0});
  posts.push(String(init?.body));if(lost){lost=false;throw new TypeError('Lost QA ACK');}const body=JSON.parse(String(init?.body));return response({status:'duplicate',operationId:body.operationId,stock:{...base,quality:'released',disposition:'release',revision:2}});
 }));
 const row=await prepareInventoryQuality(session,scope,'local',base,'release','Reviewed certificate','Evidence 42');expect(posts).toHaveLength(0);
 inventoryOutbox.close();await inventoryOutbox.open();expect((await inventoryQualityProposals(scope,'local',base.stockId))[0]).toEqual(row);
 await expect(sendInventoryQuality(session,scope,'local',row.key)).rejects.toThrow('Lost QA ACK');expect((await inventoryQualityProposals(scope,'local',base.stockId))[0].fields.state).toBe('pending');
 await sendInventoryQuality(session,scope,'local',row.key);expect(posts[0]).toBe(posts[1]);expect(await inventoryOutbox.acknowledgements.count()).toBe(1);expect((await inventoryOutbox.stocks.toArray())[0]).toMatchObject({onHand:2125000,quality:'released',revision:2});expect((await inventoryQualityProposals(scope,'local',base.stockId))[0].fields.state).toBe('accepted');
});
it('never freezes release with missing evidence, expired stock or operator powers; conflicts retain original reason/version',async()=>{
 let chief=true,status=409;
 vi.stubGlobal('fetch',vi.fn(async(url:URL)=>url.pathname.endsWith('/me')?response(chief?access:{...access,level:'operator',canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false}):url.pathname==='/inventory/stream'?response({...scope,epoch,postingEnabled:true,sequence:0}):response({error:'revision_conflict'},status)));
 await expect(prepareInventoryQuality(session,scope,'local',base,'release','Reason','')).rejects.toThrow();
 await expect(prepareInventoryQuality(session,scope,'local',{...base,expiresAt:'2000-01-01T00:00:00.000Z'},'release','Reason','Evidence')).rejects.toThrow();
 chief=false;await expect(prepareInventoryQuality(session,scope,'local',base,'release','Reason','Evidence')).rejects.toThrow();chief=true;
 const row=await prepareInventoryQuality(session,scope,'local',base,'hold','Original reason','Original evidence');
 await expect(sendInventoryQuality(session,scope,'local',row.key)).rejects.toThrow();const held=(await inventoryQualityProposals(scope,'local',base.stockId))[0];expect(held.fields.state).toBe('conflict');expect(held.fields.request).toBe(row.fields.request);expect(await inventoryOutbox.acknowledgements.count()).toBe(0);status=201;
 await expect(sendInventoryQuality(session,scope,'local',row.key)).rejects.toThrow();
});

it('never overwrites a conflicting retained acknowledgement and rolls back local stock acceptance atomically',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return response(access);
  if(url.pathname==='/inventory/stream')return response({...scope,epoch,postingEnabled:true,sequence:0});
  const body=JSON.parse(String(init?.body));return response({status:'confirmed',operationId:body.operationId,stock:{...base,quality:'released',disposition:'release',revision:2}},201);
 }));
 const row=await prepareInventoryQuality(session,scope,'local',base,'release','Reason','Evidence');
 const request=JSON.parse(row.fields.request),{inventoryScopeKey}=await import('./inventoryOutbox');
 await inventoryOutbox.acknowledgements.add({operationId:row.operationId!,scopeKey:inventoryScopeKey(scope),epoch,kind:'quality_change',stockId:base.stockId,request:{...request,evidence:'Conflicting retained evidence'},base,stock:base,receivedAt:Date.now()});
 await expect(sendInventoryQuality(session,scope,'local',row.key)).rejects.toThrow('Conflicting retained');
 expect(await inventoryOutbox.stocks.count()).toBe(0);expect((await inventoryQualityProposals(scope,'local',base.stockId))[0].fields.state).toBe('pending');expect((await inventoryOutbox.acknowledgements.get(row.operationId!))?.request).toMatchObject({evidence:'Conflicting retained evidence'});
});
