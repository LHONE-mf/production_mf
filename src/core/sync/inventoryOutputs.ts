import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import {inventoryScopeKey,type InventoryScope} from './inventoryOutbox';
import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeInteger,outcomeInstant} from './inventoryOutcomeTypes';
import {outputSourceCopy,finishedBuckets,submissionFromSortRun,sameOutput,type ElectrodeSubmission,type ElectrodeOutputLine} from './inventoryOutputTypes';
import {db} from '../db';
import {UserRole} from '../types';
import {warehouseOutputClaims,type WarehouseOutputClaim} from '../manufacturing/warehouseOutputClaims';
import {withInventorySync} from './inventorySyncLock';
import {material,type InventoryMaterial} from './inventoryCatalogClient';

export interface OfferedOutput extends Omit<ElectrodeSubmission,'outputs'> {outputs:(ElectrodeOutputLine&{stockId:string|null;acceptanceOperationId:string|null})[]}
export interface OutputContext {organizationId:string;actorId:string;deviceId:string;epoch:string;postingEnabled:boolean}
export interface OutputStep {completionId:string;productionBatchId:string;batchCode:string;stepNumber:number;workshopId:string;name:string;materialLine:'cathode'|'anode';quantity:number;unit:'pieces';completedAt:string}
function context(raw:OutputContext,scope:InventoryScope,epoch?:string):OutputContext {
 if(!raw||raw.organizationId!==scope.organizationId||raw.actorId!==scope.actorId||raw.deviceId!==scope.deviceId||!issueIdValid(raw.epoch)||epoch!==undefined&&raw.epoch!==epoch||typeof raw.postingEnabled!=='boolean')throw Error('Finished output scope/history changed');
 return{organizationId:raw.organizationId,actorId:raw.actorId,deviceId:raw.deviceId,epoch:raw.epoch,postingEnabled:raw.postingEnabled};
}
export function offeredOutputCopy(raw:unknown):OfferedOutput {
 const r=raw as OfferedOutput;
 if(!r||![r.operationId,r.deviceId,r.productionBatchId,r.completionId,r.actorId].every(issueIdValid)||r.revision!==1||!outcomeInteger(r.stepNumber,1)||!issueTextValid(r.reason)||!issueTextValid(r.evidence)||!outcomeInstant(r.recordedAt))throw Error('Invalid offered output');
 const source=outputSourceCopy(r.source),buckets=finishedBuckets(source);
 if(!Array.isArray(r.outputs)||r.outputs.length!==buckets.length||new Set(r.outputs.map(o=>o.grade)).size!==buckets.length||r.outputs.some(o=>!issueIdValid(o.materialId)||!buckets.some(g=>g.categoryName===o.grade&&g.count===o.quantity)||
  (o.stockId===null?o.acceptanceOperationId!==null:!issueIdValid(o.stockId)||!issueIdValid(o.acceptanceOperationId))))throw Error('Invalid offered grade quantities/receipts');
 const outputs=r.outputs.map(o=>({grade:o.grade,materialId:o.materialId,quantity:o.quantity,stockId:o.stockId,acceptanceOperationId:o.acceptanceOperationId}));
 const received=outputs.filter(o=>o.stockId!==null);
 if(new Set(received.map(o=>o.stockId)).size!==received.length||new Set(received.map(o=>o.acceptanceOperationId)).size!==received.length)throw Error('Duplicate finished receipt identity');
 return{operationId:r.operationId,deviceId:r.deviceId,productionBatchId:r.productionBatchId,stepNumber:r.stepNumber,completionId:r.completionId,source,outputs,revision:1,actorId:r.actorId,reason:r.reason,evidence:r.evidence,recordedAt:r.recordedAt};
}
export async function loadInventoryOutputs(session:HybridSession,scope:InventoryScope,epoch?:string,after?:string,limit=50){
 if(after!==undefined&&!issueIdValid(after)||!outcomeInteger(limit,1,100))throw Error('Invalid output cursor');
 const response=await inventoryRequest(session,scope,'/inventory/outputs?'+new URLSearchParams({deviceId:scope.deviceId,limit:String(limit),...(after?{after}:{})}));
 if(!response.ok)throw Error('Предложения склада недоступны: HTTP '+response.status);
 const raw=await response.json(),ctx=context(raw,scope,epoch);
 if(!Array.isArray(raw.items)||raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('Invalid output page');
 let previous=after??'';const items=raw.items.map((r:unknown)=>{const safe=offeredOutputCopy(r);if(safe.operationId<=previous)throw Error('Invalid output page order');previous=safe.operationId;return safe;});
 if(raw.hasMore?items.length!==limit||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid output continuation');
 return{...ctx,items,nextAfter:raw.nextAfter as string|null};
}
export async function preflightOutput(session:HybridSession,scope:InventoryScope,epoch:string){
 const ctx=await loadInventoryOutputs(session,scope,epoch,undefined,1);
 if(!ctx.postingEnabled)throw Error('Проведение приостановлено; исходное предложение сохранено');return ctx;
}
export function validateOutputStep(r:OutputStep){
 if(!r||![r.completionId,r.productionBatchId].every(issueIdValid)||![r.batchCode,r.workshopId,r.name].every(issueTextValid)||!outcomeInteger(r.stepNumber,1)||!outcomeInteger(r.quantity,1)||r.unit!=='pieces'||!['cathode','anode'].includes(r.materialLine)||!outcomeInstant(r.completedAt))throw Error('Invalid completed output step');
}
export async function loadOutputSteps(session:HybridSession,scope:InventoryScope,epoch:string,after?:string,limit=50){
 if(after!==undefined&&!issueIdValid(after)||!outcomeInteger(limit,1,100))throw Error('Invalid output step cursor');
 const response=await inventoryRequest(session,scope,'/inventory/outputs/steps?'+new URLSearchParams({deviceId:scope.deviceId,limit:String(limit),...(after?{after}:{})}));
 if(!response.ok)throw Error('Завершённые шаги недоступны: HTTP '+response.status);const raw=await response.json(),ctx=context(raw,scope,epoch);
 if(!Array.isArray(raw.items)||raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('Invalid completed step page');
 let previous=after??'';const items:OutputStep[]=raw.items.map((r:OutputStep)=>{validateOutputStep(r);if(r.completionId<=previous)throw Error('Invalid output step order');previous=r.completionId;return{completionId:r.completionId,productionBatchId:r.productionBatchId,batchCode:r.batchCode,stepNumber:r.stepNumber,workshopId:r.workshopId,name:r.name,materialLine:r.materialLine,quantity:r.quantity,unit:'pieces',completedAt:r.completedAt};});
 if(raw.hasMore?items.length!==limit||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid output step continuation');return{...ctx,items,nextAfter:raw.nextAfter as string|null};
}
export async function loadOutputMaterials(session:HybridSession,scope:InventoryScope,epoch:string,step:OutputStep,after?:string,limit=50){
 validateOutputStep(step);if(after!==undefined&&!issueIdValid(after)||!outcomeInteger(limit,1,100))throw Error('Invalid output material cursor');
 const response=await inventoryRequest(session,scope,'/inventory/outputs/materials?'+new URLSearchParams({deviceId:scope.deviceId,completionId:step.completionId,productionBatchId:step.productionBatchId,stepNumber:String(step.stepNumber),limit:String(limit),...(after?{after}:{})}));
 if(!response.ok)throw Error('Материалы завершённого шага недоступны: HTTP '+response.status);const raw=await response.json(),ctx=context(raw,scope,epoch);
 if(!Array.isArray(raw.items)||raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('Invalid output material page');
 let previous=after??'';const items:InventoryMaterial[]=raw.items.map((m:InventoryMaterial)=>{if(!material(m)||m.category!=='electrode'||m.baseUnit!=='pieces'||m.id<=previous)throw Error('Invalid electrode material');previous=m.id;return{id:m.id,code:m.code,name:m.name,category:'electrode',baseUnit:'pieces'};});
 if(raw.hasMore?items.length!==limit||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid output material continuation');return{...ctx,items,nextAfter:raw.nextAfter as string|null};
}
function validateClaim(claim:WarehouseOutputClaim,scope:InventoryScope,localActorId:string){
 if(claim.version!==1||claim.localActorId!==localActorId||inventoryScopeKey(claim.scope)!==inventoryScopeKey(scope)||!issueIdValid(claim.epoch)||claim.request.deviceId!==scope.deviceId||claim.cutRunId!==claim.source.cutRunId||claim.runId!==claim.source.id||claim.batchName!==claim.source.batchName||!outcomeInteger(claim.revision,1)||
  !sameOutput(submissionFromSortRun(claim.source,claim.request),claim.request))throw Error('Original output proposal changed');
}
/** Submission affects no warehouse stock. Claim + immutable original ACK stay
 * atomically in the same manufacturing database, without a cross-DB commit. */
export function sendWarehouseOutput(session:HybridSession,scope:InventoryScope,localActorId:string,cutRunId:string){
 return withInventorySync(scope,async()=>{
  const claim=(await warehouseOutputClaims(scope,localActorId)).find(c=>c.cutRunId===cutRunId);
  if(!claim||claim.state!=='pending')throw Error('Нет исходного ожидающего предложения');validateClaim(claim,scope,localActorId);
  const actor=await db.users.get(localActorId);if(!actor?.isActive||![UserRole.CHIEF,UserRole.MASTER,UserRole.TECHNOLOGIST].includes(actor.role))throw Error('Автор исходного предложения недоступен');
  await preflightOutput(session,scope,claim.epoch);
  if(!sameOutput(await db.warehouseOutputClaims.get(cutRunId),claim))throw Error('Original output proposal changed before send');
  const response=await inventoryRequest(session,scope,'/inventory/outputs/electrodes',{method:'POST',headers:{'x-inventory-epoch':claim.epoch},body:JSON.stringify(claim.request)});
  if([400,404,409].includes(response.status)){
   await db.transaction('rw',db.warehouseOutputClaims,async()=>{
    if(!sameOutput(await db.warehouseOutputClaims.get(cutRunId),claim))throw Error('Original output proposal changed');
    await db.warehouseOutputClaims.put({...claim,revision:claim.revision+1,state:response.status===409?'conflict':'rejected',error:'HTTP '+response.status});
   });throw Error('Предложение не принято; источник и исходный ID сохранены: HTTP '+response.status);
  }
  if(response.status!==200&&response.status!==201)throw Error('Ответ неизвестен или доступ утрачен; повторяйте тот же ID: HTTP '+response.status);
  const raw=await response.json(),expected={...claim.request,revision:1 as const,actorId:scope.actorId};
  if(raw?.status!==(response.status===201?'confirmed':'duplicate')||raw.operationId!==claim.request.operationId||!raw.submission||!outcomeInstant(raw.submission.recordedAt)||
   Object.entries(expected).some(([key,value])=>!sameOutput(raw.submission[key],value)))throw Error('Output acknowledgement differs from the original source/actor/grade');
  const acknowledgement={...expected,recordedAt:raw.submission.recordedAt} as ElectrodeSubmission;
  await db.transaction('rw',db.warehouseOutputClaims,async()=>{
   if(!sameOutput(await db.warehouseOutputClaims.get(cutRunId),claim))throw Error('Original output proposal changed while awaiting ACK');
   await db.warehouseOutputClaims.put({...claim,revision:claim.revision+1,state:'accepted',acknowledgement});
  });
 });
}
