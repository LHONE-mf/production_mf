import {db} from '../db';
import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import {inventoryScopeKey,type InventoryScope} from './inventoryOutbox';
import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeInteger,outcomeInstant} from './inventoryOutcomeTypes';
import {sameOutput} from './inventoryOutputTypes';
import {cellSubmissionCopy,cellSubmissionFromIdentity,type CellSubmission} from './inventoryCellOutputTypes';
import {cellOutputClaims,type CellOutputClaim} from '../manufacturing/cellOutputClaims';
import {withInventorySync} from './inventorySyncLock';
import {material,type InventoryMaterial} from './inventoryCatalogClient';
import type {OutputContext,OutputStep} from './inventoryOutputs';
export type CellOutputStep=Omit<OutputStep,'materialLine'>&{materialLine:'cell'};
function context(raw:OutputContext,scope:InventoryScope,epoch?:string):OutputContext {
 if(!raw||raw.organizationId!==scope.organizationId||raw.actorId!==scope.actorId||raw.deviceId!==scope.deviceId||!issueIdValid(raw.epoch)||epoch!==undefined&&raw.epoch!==epoch||typeof raw.postingEnabled!=='boolean')throw Error('Cell output scope/history changed');
 return{organizationId:raw.organizationId,actorId:raw.actorId,deviceId:raw.deviceId,epoch:raw.epoch,postingEnabled:raw.postingEnabled};
}
function cursor(after:string|undefined,limit:number){if(after!==undefined&&!issueIdValid(after)||!outcomeInteger(limit,1,100))throw Error('Invalid cell output cursor');return new URLSearchParams({limit:String(limit),...(after?{after}:{})});}
export async function loadCellOutputs(session:HybridSession,scope:InventoryScope,epoch?:string,after?:string,limit=50){
 const query=cursor(after,limit);query.set('deviceId',scope.deviceId);const response=await inventoryRequest(session,scope,'/inventory/cell-outputs?'+query);
 if(!response.ok)throw Error('Предложения ячеек недоступны: HTTP '+response.status);const raw=await response.json(),ctx=context(raw,scope,epoch);
 if(!Array.isArray(raw.items)||raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('Invalid cell output page');
 let previous=after??'';const items:CellSubmission[]=raw.items.map((r:unknown)=>{const safe=cellSubmissionCopy(r);if(safe.operationId<=previous)throw Error('Invalid cell output order');previous=safe.operationId;return safe;});
 if(raw.hasMore?items.length!==limit||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid cell output continuation');return{...ctx,items,nextAfter:raw.nextAfter as string|null};
}
export function validateCellOutputStep(r:CellOutputStep){
 if(!r||![r.completionId,r.productionBatchId].every(issueIdValid)||![r.batchCode,r.workshopId,r.name].every(issueTextValid)||!outcomeInteger(r.stepNumber,1)||!outcomeInteger(r.quantity,1)||r.unit!=='pieces'||r.materialLine!=='cell'||!outcomeInstant(r.completedAt))throw Error('Invalid completed cell step');
}
export async function loadCellOutputSteps(session:HybridSession,scope:InventoryScope,epoch:string,after?:string,limit=50){
 const query=cursor(after,limit);query.set('deviceId',scope.deviceId);const response=await inventoryRequest(session,scope,'/inventory/cell-outputs/steps?'+query);
 if(!response.ok)throw Error('Завершённые шаги ячеек недоступны: HTTP '+response.status);const raw=await response.json(),ctx=context(raw,scope,epoch);
 if(!Array.isArray(raw.items)||raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('Invalid cell step page');
 let previous=after??'';const items:CellOutputStep[]=raw.items.map((r:CellOutputStep)=>{validateCellOutputStep(r);if(r.completionId<=previous)throw Error('Invalid cell step order');previous=r.completionId;return{completionId:r.completionId,productionBatchId:r.productionBatchId,batchCode:r.batchCode,stepNumber:r.stepNumber,workshopId:r.workshopId,name:r.name,materialLine:'cell',quantity:r.quantity,unit:'pieces',completedAt:r.completedAt};});
 if(raw.hasMore?items.length!==limit||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid cell step continuation');return{...ctx,items,nextAfter:raw.nextAfter as string|null};
}
export async function loadCellOutputMaterials(session:HybridSession,scope:InventoryScope,epoch:string,step:CellOutputStep,after?:string,limit=50){
 validateCellOutputStep(step);const query=cursor(after,limit);for(const[k,v]of Object.entries({deviceId:scope.deviceId,completionId:step.completionId,productionBatchId:step.productionBatchId,stepNumber:String(step.stepNumber)}))query.set(k,v);
 const response=await inventoryRequest(session,scope,'/inventory/cell-outputs/materials?'+query);if(!response.ok)throw Error('Материалы ячеек недоступны: HTTP '+response.status);const raw=await response.json(),ctx=context(raw,scope,epoch);
 if(!Array.isArray(raw.items)||raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('Invalid cell material page');
 let previous=after??'';const items:InventoryMaterial[]=raw.items.map((m:InventoryMaterial)=>{if(!material(m)||m.category!=='cell'||m.baseUnit!=='pieces'||m.id<=previous)throw Error('Invalid cell material');previous=m.id;return{id:m.id,code:m.code,name:m.name,category:'cell',baseUnit:'pieces'};});
 if(raw.hasMore?items.length!==limit||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid cell material continuation');return{...ctx,items,nextAfter:raw.nextAfter as string|null};
}
function validateClaim(claim:CellOutputClaim,scope:InventoryScope,localActorId:string){
 if(claim.version!==1||!['chief','master','technologist'].includes(claim.localActorRole)||!outcomeInstant(claim.createdAt)||claim.localActorId!==localActorId||inventoryScopeKey(claim.scope)!==inventoryScopeKey(scope)||!issueIdValid(claim.epoch)||claim.request.deviceId!==scope.deviceId||claim.runId!==claim.identity.runId||claim.identityId!==claim.identity.id||claim.assemblyOutputId!==claim.identity.assemblyOutputId||!outcomeInteger(claim.revision,1)||!sameOutput(cellSubmissionFromIdentity(claim.identity,claim.request),claim.request))throw Error('Original cell proposal changed');
}
/** Explicit send only. Unknown/unauthorized responses keep the original pending
 * claim; accepted source and exact ACK commit together without warehouse writes. */
export function sendCellOutput(session:HybridSession,scope:InventoryScope,localActorId:string,runId:string){
 return withInventorySync(scope,async()=>{
  const claim=(await cellOutputClaims(scope,localActorId)).find(c=>c.runId===runId);if(!claim||claim.state!=='pending')throw Error('Нет исходного ожидающего предложения ячеек');validateClaim(claim,scope,localActorId);
  const ctx=await loadCellOutputs(session,scope,claim.epoch,undefined,1);if(!ctx.postingEnabled)throw Error('Проведение приостановлено; исходное предложение удержано');
  const actor=await db.users.get(localActorId);if(!actor?.isActive||actor.role!==claim.localActorRole)throw Error('Исходный автор или роль предложения недоступны');
  if(!sameOutput(await db.cellOutputClaims.get(runId),claim))throw Error('Original cell proposal changed before send');
  const response=await inventoryRequest(session,scope,'/inventory/cell-outputs',{method:'POST',headers:{'x-inventory-epoch':claim.epoch},body:JSON.stringify(claim.request)});
  if([400,404,409].includes(response.status)){
   await db.transaction('rw',db.cellOutputClaims,async()=>{if(!sameOutput(await db.cellOutputClaims.get(runId),claim))throw Error('Original cell proposal changed');await db.cellOutputClaims.put({...claim,revision:claim.revision+1,state:response.status===409?'conflict':'rejected',error:'HTTP '+response.status});});
   throw Error('Предложение ячеек не принято; источник и исходный ID удержаны: HTTP '+response.status);
  }
  if(response.status!==200&&response.status!==201)throw Error('Ответ неизвестен или доступ утрачен; повторяйте тот же ID: HTTP '+response.status);
  const raw=await response.json(),expected={...claim.request,quantity:claim.identity.count,unit:'pieces',revision:1,actorId:scope.actorId};
  if(raw?.status!==(response.status===201?'confirmed':'duplicate')||raw.operationId!==claim.request.operationId||!raw.submission||!outcomeInstant(raw.submission.recordedAt)||Object.entries(expected).some(([key,value])=>!sameOutput(raw.submission[key],value)))throw Error('Cell acknowledgement differs from the original source/serials/actor');
  const acknowledgement={...expected,recordedAt:raw.submission.recordedAt} as CellSubmission;
  await db.transaction('rw',db.cellOutputClaims,async()=>{if(!sameOutput(await db.cellOutputClaims.get(runId),claim))throw Error('Original cell proposal changed while awaiting ACK');await db.cellOutputClaims.put({...claim,revision:claim.revision+1,state:'accepted',acknowledgement});});
 });
}
