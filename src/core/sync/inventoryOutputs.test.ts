import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {UserRole,type SortRun} from '../types';
import {freezeWarehouseOutput,warehouseOutputClaims} from '../manufacturing/warehouseOutputClaims';
import {inventoryOutbox} from './inventoryOutbox';
import {sendWarehouseOutput,offeredOutputCopy,loadInventoryOutputs,loadOutputSteps,loadOutputMaterials} from './inventoryOutputs';
const scope={serverUrl:'https://inventory.example',organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'},epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const cut={id:'cut',incomingId:'roll',electrodeType:'strip' as const,goodCount:10,defectCount:0,workerId:'cutter',createdAt:1,updatedAt:1};
const spec={id:'spec',cutRunId:'cut',batchName:'roll',electrodeType:'strip' as const,parameterName:'Mass',unit:'g',categories:[{name:'A',criteria:'Actual manual count',minMass:1}],authorId:'tech',createdAt:1,updatedAt:1};
const source:SortRun={id:'sort',cutRunId:'cut',cutRunSnapshot:cut,specSnapshot:spec,specId:'spec',batchName:'roll',goodCount:10,buckets:[{categoryName:'PASS',count:7}],rejected:3,workerId:'sorter',createdAt:3,updatedAt:3,
 sortingWorkflow:{id:'cut',cutRunId:'cut',cutRunSnapshot:cut,specSnapshot:spec,mode:'pass-fail',createdBy:'master',createdAt:1,updatedAt:3,finalizedSortRunId:'sort',stages:
  (['visual','thickness','mass'] as const).map((station,i)=>({station,inputCount:10-i,passedCount:9-i,rejectedCount:1,workerId:i===2?'sorter':'operator',recordedAt:i+1}))}};
const request=()=>({operationId:crypto.randomUUID(),deviceId:scope.deviceId,productionBatchId:crypto.randomUUID(),completionId:crypto.randomUUID(),stepNumber:1,outputs:[{grade:'PASS',materialId:'55555555-5555-4555-8555-555555555555',quantity:7}],reason:'Actual offered output',evidence:'Count sheet'});
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const page=(extra:object={})=>({organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,epoch,postingEnabled:true,items:[],hasMore:false,nextAfter:null,...extra});
const accepted=<T extends object>(r:T)=>({...r,revision:1,actorId:scope.actorId,recordedAt:'2026-11-15T08:00:00.000Z'});
beforeEach(async()=>{await db.open();await inventoryOutbox.open();await db.users.add({id:'master',login:'master',fullName:'Master',password:'test-only',role:UserRole.MASTER,isActive:true,createdAt:new Date()});await db.sortRuns.add(source);});
afterEach(async()=>{vi.unstubAllGlobals();db.close();await db.delete();inventoryOutbox.close();await inventoryOutbox.delete();});

it('retains the original source/body across reopen and unknown reply, then archives only its own original ACK without warehouse stock',async()=>{
 const claim=await freezeWarehouseOutput(scope,'master',epoch,source,request()),posts:string[]=[];let lost=true;
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init?:RequestInit)=>{
  if(!init?.method)return response(page());posts.push(String(init.body));if(lost){lost=false;throw Error('Committed response lost');}
  const r=JSON.parse(String(init.body));return response({status:'duplicate',operationId:r.operationId,submission:{...accepted(r),accessToken:'NEVER-SAVE'},deviceProof:'NEVER-SAVE'});
 }));
 db.close();await db.open();await expect(sendWarehouseOutput(session,scope,'master',claim.cutRunId)).rejects.toThrow('Committed response lost');
 expect((await warehouseOutputClaims(scope,'master'))[0]).toEqual(claim);
 await sendWarehouseOutput(session,scope,'master',claim.cutRunId);expect(posts[0]).toBe(posts[1]);
 const row=(await warehouseOutputClaims(scope,'master'))[0];expect(row.state).toBe('accepted');expect(row.request).toEqual(claim.request);expect(row.acknowledgement).toEqual(accepted(claim.request));
 expect(JSON.stringify(row)).not.toContain('NEVER-SAVE');expect(await inventoryOutbox.stocks.count()).toBe(0);expect(await inventoryOutbox.acknowledgements.count()).toBe(0);
});
it('rejects forged source/actor/count ACKs and rolls acknowledgement write failure back without losing the original pending claim',async()=>{
 const claim=await freezeWarehouseOutput(scope,'master',epoch,source,request());let tamper='quantity';
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{
  if(!init?.method)return response(page());const r=JSON.parse(String(init.body)),submission=accepted(r);
  if(tamper==='quantity')submission.outputs=[{...r.outputs[0],quantity:8}];
  if(tamper==='actor')submission.actorId=crypto.randomUUID();
  if(tamper==='source')submission.source={...r.source,runId:'different-source'};
  return response({status:'confirmed',operationId:r.operationId,submission},201);
 }));
 for(tamper of ['quantity','actor','source'])await expect(sendWarehouseOutput(session,scope,'master',claim.cutRunId)).rejects.toThrow('acknowledgement');
 tamper='none';const fail=()=>{throw Error('ACK store unavailable');};db.warehouseOutputClaims.hook('updating',fail);
 try{await expect(sendWarehouseOutput(session,scope,'master',claim.cutRunId)).rejects.toThrow('ACK store unavailable');}finally{db.warehouseOutputClaims.hook('updating').unsubscribe(fail);}
 expect((await warehouseOutputClaims(scope,'master'))[0]).toEqual(claim);await sendWarehouseOutput(session,scope,'master',claim.cutRunId);expect((await warehouseOutputClaims(scope,'master'))[0].state).toBe('accepted');
});
it('holds original offers before POST on wrong actor/history or suspension, and retains explicit conflicts without rebinding the source',async()=>{
 const claim=await freezeWarehouseOutput(scope,'master',epoch,source,request());let extra:object={epoch:crypto.randomUUID()},posts=0;
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{if(!init?.method)return response(page(extra));posts++;return response({error:'source conflict'},409);}));
 for(extra of [{epoch:crypto.randomUUID()},{actorId:crypto.randomUUID()},{postingEnabled:false}])await expect(sendWarehouseOutput(session,scope,'master',claim.cutRunId)).rejects.toThrow();
 expect(posts).toBe(0);extra={};await expect(sendWarehouseOutput(session,scope,'master',claim.cutRunId)).rejects.toThrow('HTTP 409');
 const held=(await warehouseOutputClaims(scope,'master'))[0];expect(held).toMatchObject({request:claim.request,source,epoch,state:'conflict'});
 await expect(freezeWarehouseOutput(scope,'master',epoch,source,request())).rejects.toThrow();
});
it('validates offered pages, removes unknown properties, and rejects wrong scope/grade quantities or mismatched receipt identity',async()=>{
 const claim=await freezeWarehouseOutput(scope,'master',epoch,source,request()),offered={...accepted(claim.request),outputs:claim.request.outputs.map(o=>({...o,stockId:null,acceptanceOperationId:null})),accessToken:'NEVER-SAVE'};
 let item:object=offered;vi.stubGlobal('fetch',vi.fn(async()=>response(page({items:[item]}))));
 const loaded=await loadInventoryOutputs(session,scope,epoch);expect(loaded.items).toHaveLength(1);expect(JSON.stringify(loaded)).not.toContain('NEVER-SAVE');
 item={...offered,outputs:[{...offered.outputs[0],quantity:8}]};await expect(loadInventoryOutputs(session,scope,epoch)).rejects.toThrow();
 item={...offered,outputs:[{...offered.outputs[0],stockId:crypto.randomUUID()}]};await expect(loadInventoryOutputs(session,scope,epoch)).rejects.toThrow();
});
it('rejects duplicate physical receipt identity across distinct offered grades',async()=>{
 const claim=await freezeWarehouseOutput(scope,'master',epoch,source,request()),stockId=crypto.randomUUID(),op=crypto.randomUUID();
 const offered={...accepted(claim.request),source:{...claim.request.source,mode:'grading',categories:[{name:'A',minMass:1},{name:'B',minMass:2}],stages:claim.request.source.stages.map((s,i)=>i===2?{...s,grades:[{categoryName:'A',count:4},{categoryName:'B',count:3}]}:s)},
  outputs:[{grade:'A',materialId:claim.request.outputs[0].materialId,quantity:4,stockId,acceptanceOperationId:op},{grade:'B',materialId:claim.request.outputs[0].materialId,quantity:3,stockId,acceptanceOperationId:crypto.randomUUID()}]};
 expect(()=>offeredOutputCopy(offered)).toThrow();
 offered.outputs[1].stockId=crypto.randomUUID();offered.outputs[1].acceptanceOperationId=op;expect(()=>offeredOutputCopy(offered)).toThrow();
});
it('binds completed step/material discovery to current scope, exact history and real integer piece output',async()=>{
 const step={completionId:crypto.randomUUID(),productionBatchId:crypto.randomUUID(),batchCode:'Actual finished batch',stepNumber:1,workshopId:'sorting',name:'Final sorting',materialLine:'anode' as const,quantity:7,unit:'pieces' as const,completedAt:'2026-11-15T08:00:00.000Z'};
 let invalid=false;vi.stubGlobal('fetch',vi.fn(async(url:URL)=>url.pathname.endsWith('/steps')?response(page({items:[{...step,quantity:invalid?7.5:7}]})):response(page({items:[{id:'55555555-5555-4555-8555-555555555555',code:'bad',name:'Bad material',category:'raw_material',baseUnit:'mg'}]}))));
 expect((await loadOutputSteps(session,scope,epoch)).items).toEqual([step]);invalid=true;await expect(loadOutputSteps(session,scope,epoch)).rejects.toThrow();
 await expect(loadOutputMaterials(session,scope,epoch,step)).rejects.toThrow();
});
