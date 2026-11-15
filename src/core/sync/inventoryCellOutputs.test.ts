import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {db} from '../db';
import {UserRole,type FormationRun} from '../types';
import {syntheticFormationLineage} from '../../../tests/fixtures/formation-lineage';
import {createFormationSerialIdentity,declareFormationSerialIdentity,type FormationSerialIdentity} from '../manufacturing/formationSerialIdentity';
import {freezeCellOutput} from '../manufacturing/cellOutputClaims';
import {inventoryOutbox} from './inventoryOutbox';
import {sendCellOutput,loadCellOutputs,loadCellOutputSteps,loadCellOutputMaterials} from './inventoryCellOutputs';
const scope={serverUrl:'https://inventory.example',organizationId:crypto.randomUUID(),actorId:crypto.randomUUID(),deviceId:crypto.randomUUID()},epoch=crypto.randomUUID();
const session={serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const page=(extra:object={})=>({organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,epoch,postingEnabled:true,items:[],hasMore:false,nextAfter:null,...extra});
let run:FormationRun,identity:FormationSerialIdentity;
const input=()=>({operationId:crypto.randomUUID(),deviceId:scope.deviceId,productionBatchId:crypto.randomUUID(),completionId:crypto.randomUUID(),stepNumber:1,materialId:crypto.randomUUID(),reason:'Actual final cell output',evidence:'Explicit channel sheet'});
const accepted=<T extends object>(r:T)=>({...r,revision:1,actorId:scope.actorId,quantity:2,unit:'pieces',recordedAt:'2026-11-15T19:00:00.000Z'});
beforeEach(async()=>{await db.open();await inventoryOutbox.open();await db.users.bulkAdd([{id:'chief',login:'chief',fullName:'Chief',password:'SYNTHETIC-test-only',role:UserRole.CHIEF,isActive:true,createdAt:new Date()},{id:'worker',login:'worker',fullName:'Worker',password:'SYNTHETIC-test-only',role:UserRole.WORKER,isActive:true,createdAt:new Date()}]);run=await syntheticFormationLineage('chief','worker');identity=createFormationSerialIdentity(run,[{start:10,end:10},{start:12,end:12}],'Explicit processed channels',(await db.users.get('chief'))!,crypto.randomUUID(),new Date().toISOString());await declareFormationSerialIdentity(identity,'chief');});
afterEach(async()=>{vi.unstubAllGlobals();db.close();await db.delete();inventoryOutbox.close();await inventoryOutbox.delete();});
it('retains the original scope/epoch/body across lost reply and reopen, then atomically archives only the exact ACK without warehouse writes',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input()),posts:string[]=[];let lost=true;
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{if(!init?.method)return response(page());posts.push(String(init.body));expect((init.headers as Record<string,string>)['x-inventory-epoch']).toBe(epoch);if(lost){lost=false;throw Error('Committed response lost');}const r=JSON.parse(String(init.body));return response({status:'duplicate',operationId:r.operationId,submission:{...accepted(r),accessToken:'NEVER-SAVE'},deviceProof:'NEVER-SAVE'});}));
 await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('Committed response lost');db.close();await db.open();expect(await db.cellOutputClaims.get(run.id)).toEqual(claim);
 await sendCellOutput(session,scope,'chief',run.id);expect(posts[0]).toBe(posts[1]);const row=await db.cellOutputClaims.get(run.id);expect(row).toMatchObject({state:'accepted',request:claim.request,identity,acknowledgement:accepted(claim.request)});expect(JSON.stringify(row)).not.toContain('NEVER-SAVE');expect(await inventoryOutbox.stocks.count()).toBe(0);expect(await inventoryOutbox.acknowledgements.count()).toBe(0);expect(await db.formationRuns.get(run.id)).toEqual(run);
});
it('refuses forged ACK source/quantity/unit/material/actor/status and rolls archive failure back to the same pending proposal',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input());let tamper:Record<string,unknown>={};let status='confirmed';
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{if(!init?.method)return response(page());return response({status,operationId:claim.request.operationId,submission:{...accepted(claim.request),...tamper}},201);}));
 for(tamper of [{quantity:4},{unit:'mg'},{materialId:crypto.randomUUID()},{actorId:crypto.randomUUID()},{revision:2},{source:{...claim.request.source,ranges:[{start:10,end:11}]}},{recordedAt:'bad'}])await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('acknowledgement');
 tamper={};status='duplicate';await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('acknowledgement');status='confirmed';
 const fail=()=>{throw Error('ACK storage unavailable');};db.cellOutputClaims.hook('updating',fail);try{await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('ACK storage unavailable');}finally{db.cellOutputClaims.hook('updating').unsubscribe(fail);}
 expect(await db.cellOutputClaims.get(run.id)).toEqual(claim);await sendCellOutput(session,scope,'chief',run.id);expect((await db.cellOutputClaims.get(run.id))?.state).toBe('accepted');
});
it('holds changed history, suspension, expired proof and lost authority without POST or scope adoption; explicit conflicts retain the source',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input());let extra:object={},posts=0,postStatus=403;
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{if(!init?.method)return response(page(extra));posts++;return response({error:'authority or source unavailable'},postStatus);}));
 for(extra of [{epoch:crypto.randomUUID()},{actorId:crypto.randomUUID()},{deviceId:crypto.randomUUID()},{postingEnabled:false}])await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow();extra={};
 await expect(sendCellOutput({...session,deviceProofExpiresAt:Date.now()-1},scope,'chief',run.id)).rejects.toThrow();await expect(sendCellOutput(session,scope,'worker',run.id)).rejects.toThrow();await db.users.update('chief',{role:UserRole.MASTER});await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow();await db.users.update('chief',{role:UserRole.CHIEF});expect(posts).toBe(0);
 await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('HTTP 403');expect(await db.cellOutputClaims.get(run.id)).toEqual(claim);postStatus=409;await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('HTTP 409');expect(await db.cellOutputClaims.get(run.id)).toMatchObject({state:'conflict',request:claim.request,identity,epoch});
});
it('does not overwrite a proposal changed while its response is in flight',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input());const changed={...claim,revision:2,error:'Held by another local review'};
 vi.stubGlobal('fetch',vi.fn(async(_url:URL,init?:RequestInit)=>{if(!init?.method)return response(page());await db.cellOutputClaims.put(changed);return response({status:'confirmed',operationId:claim.request.operationId,submission:accepted(claim.request)},201);}));
 await expect(sendCellOutput(session,scope,'chief',run.id)).rejects.toThrow('changed');expect(await db.cellOutputClaims.get(run.id)).toEqual(changed);
});
it('validates bounded ordered source history and strips unknown metadata without accepting guessed serial output',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input());let raw:object=page({items:[{...accepted(claim.request),accessToken:'NEVER-SAVE',source:{...claim.request.source,accessToken:'NEVER-SAVE',formation:{...claim.request.source.formation,mode:{...claim.request.source.formation.mode,accessToken:'NEVER-SAVE'}}}}]});
 vi.stubGlobal('fetch',vi.fn(async()=>response(raw)));const loaded=await loadCellOutputs(session,scope,epoch);expect(loaded.items).toEqual([accepted(claim.request)]);expect(JSON.stringify(loaded)).not.toContain('NEVER-SAVE');
 for(raw of [page({items:[{...accepted(claim.request),quantity:4}]}),page({items:[{...accepted(claim.request),source:{...claim.request.source,ranges:[{start:10,end:13}]}}]}),page({items:[accepted(claim.request),accepted(claim.request)]}),page({hasMore:true,nextAfter:claim.request.operationId}),page({epoch:crypto.randomUUID()})])await expect(loadCellOutputs(session,scope,epoch)).rejects.toThrow();
});
it('binds cell step/material discovery to scope, history, exact integer quantities and actual cell piece catalog',async()=>{
 const step={completionId:crypto.randomUUID(),productionBatchId:crypto.randomUUID(),batchCode:'Actual final batch',stepNumber:1,workshopId:'formation',name:'Final Formation',materialLine:'cell' as const,quantity:2,unit:'pieces' as const,completedAt:'2026-11-15T19:00:00.000Z'};let invalid=false;
 vi.stubGlobal('fetch',vi.fn(async(url:URL)=>url.pathname.endsWith('/steps')?response(page({items:[{...step,quantity:invalid?2.5:2}]})):response(page({items:[{id:crypto.randomUUID(),code:'wrong',name:'Electrode',category:'electrode',baseUnit:'pieces'}]}))));
 expect((await loadCellOutputSteps(session,scope,epoch)).items).toEqual([step]);invalid=true;await expect(loadCellOutputSteps(session,scope,epoch)).rejects.toThrow();await expect(loadCellOutputMaterials(session,scope,epoch,step)).rejects.toThrow();
});
it('accepts original source timestamps with explicit offsets while refusing malformed lineage, ranges, units and measurements',async()=>{
 const claim=await freezeCellOutput(scope,'chief',epoch,identity,input()),source=claim.request.source;
 let candidate={...source,formation:{...source.formation,recordedAt:'2026-11-15T10:00:00+03:00'},declaration:{...source.declaration,recordedAt:'2026-11-15T10:01:00+03:00'}};
 vi.stubGlobal('fetch',vi.fn(async()=>response(page({items:[accepted({...claim.request,source:candidate})]}))));
 expect((await loadCellOutputs(session,scope,epoch)).items[0].source).toEqual(candidate);
 candidate={...candidate,formation:{...candidate.formation,startDate:'9999-12-30',endDate:'9999-12-31'}};expect((await loadCellOutputs(session,scope,epoch)).items[0].source).toEqual(candidate);
 for(const extra of [{lineage:{...source.lineage,walzingRunId:'guessed-walz'}},{formation:{...source.formation,measurementUnits:{...source.formation.measurementUnits,capacity:'mAh'}}},{formation:{...source.formation,mode:{...source.formation.mode,currentA:null}}},{formation:{...source.formation,coulombEfficiencyPct:101}},{formation:{...source.formation,endDate:'2026-02-30'}},{formation:{...source.formation,recordedAt:'2026-11-15T25:00:00+03:00'}},{declaration:{...source.declaration,recordedRole:'worker',recordedBy:'unrelated'}},{ranges:[{start:10,end:10},{start:10,end:10}]}]){
  candidate={...source,...extra} as typeof candidate;await expect(loadCellOutputs(session,scope,epoch)).rejects.toThrow();
 }
});
