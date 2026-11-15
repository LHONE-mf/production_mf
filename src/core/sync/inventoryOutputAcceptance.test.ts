import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {inventoryOutbox,inventoryScopeKey,type InventoryStockSnapshot} from './inventoryOutbox';
import {freezeOutputAcceptance,sendOutputAcceptance,outputAcceptanceProposals} from './inventoryOutputAcceptance';
import type {OfferedOutput} from './inventoryOutputs';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'},epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const id='44444444-4444-4444-8444-444444444444',material='55555555-5555-4555-8555-555555555555',location='66666666-6666-4666-8666-666666666666';
const offered:OfferedOutput={operationId:id,deviceId:scope.deviceId,productionBatchId:id,completionId:id,stepNumber:1,revision:1,actorId:scope.actorId,reason:'Actual output',evidence:'Physical count sheet',recordedAt:'2026-11-15T08:00:00.000Z',
 source:{runId:'sort',cutRunId:'cut',specId:'spec',mode:'pass-fail',inputCount:10,categories:[{name:'A',minMass:1}],stages:(['visual','thickness','mass'] as const).map((station,i)=>({station,inputCount:10-i,passedCount:9-i,rejectedCount:1,workerId:'operator',recordedAt:i+1}))},
 outputs:[{grade:'PASS',materialId:material,quantity:7,stockId:null,acceptanceOperationId:null}]};
const response=(r:unknown,status=200)=>new Response(JSON.stringify(r),{status,headers:{'content-type':'application/json'}});
const access={level:'operator',canRecordReceipts:true,canManageCatalog:false,canCorrectStock:false,correctionRoleEligible:false};
const fields={grade:'PASS',locationId:location,quantity:7,reason:'Separate physical Storage count',evidence:'Signed receiving sheet',manufacturedOn:'2026-01-01',expiresOn:'2099-12-31'};
const stock=(request:{stockId:string}):InventoryStockSnapshot=>({stockId:request.stockId,materialId:material,locationId:location,manufacturerLot:'production:'+id+':PASS',unit:'pieces',quality:'quarantine',onHand:7,reserved:0,available:7,revision:1,manufacturedOn:'2026-01-01',expiresAt:'2100-01-01T00:00:00.000Z'});
beforeEach(async()=>{await inventoryOutbox.open();await inventoryOutbox.streams.put({scopeKey:inventoryScopeKey(scope),epoch});});
afterEach(async()=>{vi.unstubAllGlobals();inventoryOutbox.close();await inventoryOutbox.delete();});
it('freezes a separately counted complete grade offline, then atomically accepts its exact original quarantine receipt after a lost reply',async()=>{
 const row=await freezeOutputAcceptance(scope,'local',epoch,offered,fields);expect(await inventoryOutbox.stocks.count()).toBe(0);
 inventoryOutbox.close();await inventoryOutbox.open();expect((await outputAcceptanceProposals(scope,'local'))[0]).toEqual(row);
 let lost=true;const bodies:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return response(access);
  if(!init?.method)return response({...scope,epoch,postingEnabled:true,items:[],hasMore:false,nextAfter:null});
  bodies.push(String(init.body));if(lost){lost=false;throw Error('Lost actual acceptance reply');}
  const r=JSON.parse(String(init.body));return response({status:'duplicate',operationId:r.operationId,stock:{...stock(r),accessToken:'NEVER-SAVE'}});
 }));
 await expect(sendOutputAcceptance(session,scope,'local',row.key)).rejects.toThrow('Lost actual');
 await sendOutputAcceptance(session,scope,'local',row.key);expect(bodies[0]).toBe(bodies[1]);
 expect((await inventoryOutbox.stocks.toArray())[0]).toMatchObject({onHand:7,quality:'quarantine',revision:1});expect(await inventoryOutbox.acknowledgements.count()).toBe(1);
 const accepted=(await outputAcceptanceProposals(scope,'local'))[0];expect(accepted.fields.state).toBe('accepted');expect(accepted.fields.request).toBe(row.fields.request);expect(JSON.stringify(accepted)).not.toContain('NEVER-SAVE');
});
it('retains the original count/source on mismatch or bad ACK and never permits a second local intent for an offered grade',async()=>{
 await expect(freezeOutputAcceptance(scope,'local',epoch,offered,{...fields,quantity:6})).rejects.toThrow();
 const row=await freezeOutputAcceptance(scope,'local',epoch,offered,fields);await expect(freezeOutputAcceptance(scope,'local',epoch,offered,fields)).rejects.toThrow();
 let tamper='quality';vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return response(access);if(!init?.method)return response({...scope,epoch,postingEnabled:true,items:[],hasMore:false,nextAfter:null});
  const r=JSON.parse(String(init.body));return response({status:'confirmed',operationId:r.operationId,stock:{...stock(r),...(tamper==='quality'?{quality:'released'}:{expiresAt:'2101-01-01T00:00:00.000Z'})}},201);
 }));
 for(tamper of ['quality','expiry'])await expect(sendOutputAcceptance(session,scope,'local',row.key)).rejects.toThrow();
 expect(await inventoryOutbox.stocks.count()).toBe(0);expect(await inventoryOutbox.acknowledgements.count()).toBe(0);expect((await outputAcceptanceProposals(scope,'local'))[0]).toEqual(row);
});
it('rechecks warehouse authority/history before sending and retains conflicts and changed local proposals without partial stock',async()=>{
 const row=await freezeOutputAcceptance(scope,'local',epoch,offered,fields);let state='epoch',posts=0;
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(url.pathname.endsWith('/me'))return state==='access'?response({error:'forbidden'},403):response(access);
  if(!init?.method)return response({...scope,epoch:state==='epoch'?crypto.randomUUID():epoch,postingEnabled:true,items:[],hasMore:false,nextAfter:null});
  posts++;return response({error:'already accepted'},409);
 }));
 for(state of ['epoch','access'])await expect(sendOutputAcceptance(session,scope,'local',row.key)).rejects.toThrow();expect(posts).toBe(0);
 state='conflict';await expect(sendOutputAcceptance(session,scope,'local',row.key)).rejects.toThrow('HTTP 409');expect((await outputAcceptanceProposals(scope,'local'))[0].fields).toMatchObject({state:'conflict',request:row.fields.request});expect(await inventoryOutbox.stocks.count()).toBe(0);
});
it('rolls back stock and accepted state when a conflicting retained acknowledgement prevents the atomic archive',async()=>{
 const row=await freezeOutputAcceptance(scope,'local',epoch,offered,fields),request=JSON.parse(row.fields.request),originalStock=stock(request);
 await inventoryOutbox.acknowledgements.add({operationId:request.operationId,scopeKey:inventoryScopeKey(scope),epoch,kind:'receive',stockId:request.stockId,request,stock:{...originalStock,onHand:8,available:8},receivedAt:1});
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>url.pathname.endsWith('/me')?response(access):!init?.method?response({...scope,epoch,postingEnabled:true,items:[],hasMore:false,nextAfter:null}):response({status:'duplicate',operationId:request.operationId,stock:originalStock})));
 await expect(sendOutputAcceptance(session,scope,'local',row.key)).rejects.toThrow('Conflicting retained');
 expect(await inventoryOutbox.stocks.count()).toBe(0);expect((await outputAcceptanceProposals(scope,'local'))[0]).toEqual(row);expect((await inventoryOutbox.acknowledgements.get(request.operationId))?.stock.onHand).toBe(8);
});
