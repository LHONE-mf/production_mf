import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import type {InventoryScope} from './inventoryOutbox';
import {issueIdValid} from './inventoryIssueTypes';
import {loadInventoryOutputs,type OfferedOutput} from './inventoryOutputs';

export interface AssemblyEligibilityTarget {
 assemblyBatchId:string;
 assemblyStepNumber:number;
 recipientId:string;
}

export interface AvailableAssemblyGrade {
 submissionId:string;
 grade:string;
 quantity:number;
 materialId:string;
 sourceBatchId:string;
 sourceStepNumber:number;
 sortRunId:string;
}

const unavailable=new Set([
 'sorting_output_grade_not_found',
 'sorting_source_step_unavailable',
 'sorting_grade_quantity_invalid',
 'confirmed_cutting_receipt_required',
 'cutting_receipt_source_unavailable',
 'assembly_route_or_receiver_required',
 'sorting_assembly_route_mismatch',
 'electrode_material_required',
 'sorting_grade_already_claimed',
]);

function validTarget(t:AssemblyEligibilityTarget){
 return !!t&&issueIdValid(t.assemblyBatchId)&&issueIdValid(t.recipientId)&&
  Number.isSafeInteger(t.assemblyStepNumber)&&t.assemblyStepNumber>0;
}

/** Read-only, point-in-time server check. A positive result never grants custody
 * or substitutes for rechecking an offer in the next mini-step (B2.4). */
export async function loadAvailableAssemblyGrades(
 session:HybridSession,scope:InventoryScope,target:AssemblyEligibilityTarget,
 epoch?:string,after?:string,limit=20,
){
 if(!validTarget(target))throw Error('Укажите серверную партию Assembly, номер шага и назначенного получателя');
 const page=await loadInventoryOutputs(session,scope,epoch,after,limit);
 const candidates:( {source:OfferedOutput;line:OfferedOutput['outputs'][number]} )[]=
  (page.items as OfferedOutput[]).flatMap(source=>
   source.outputs.filter(line=>line.stockId===null).map(line=>({source,line})));
 const items:AvailableAssemblyGrade[]=[];
 // Keep the network bounded even for multi-grade Sorting submissions.
 for(let i=0;i<candidates.length;i+=4){
  const checked=await Promise.all(candidates.slice(i,i+4).map(async({source,line})=>
   checkGrade(session,scope,target,page.epoch,source,line)));
  for(const result of checked)if(result)items.push(result);
 }
 return {epoch:page.epoch,items,nextAfter:page.nextAfter};
}

async function checkGrade(
 session:HybridSession,scope:InventoryScope,target:AssemblyEligibilityTarget,epoch:string,
 source:OfferedOutput,line:OfferedOutput['outputs'][number],
):Promise<AvailableAssemblyGrade|null>{
 const params=new URLSearchParams({
  deviceId:scope.deviceId,submissionId:source.operationId,grade:line.grade,
  assemblyBatchId:target.assemblyBatchId,
  assemblyStepNumber:String(target.assemblyStepNumber),recipientId:target.recipientId,
 });
 const response=await inventoryRequest(session,scope,'/inventory/assembly-electrodes/eligibility?'+params);
 if(response.status===404||response.status===409){
  const error=(await response.clone().json().catch(()=>null))?.error;
  if(typeof error==='string'&&unavailable.has(error))return null;
 }
 if(!response.ok)throw Error('Проверка Assembly недоступна: HTTP '+response.status);
 const result=await response.json();
 if(!result||result.eligible!==true||result.reservationEffect!=='none'||
  result.organizationId!==scope.organizationId||result.actorId!==scope.actorId||
  result.deviceId!==scope.deviceId||result.epoch!==epoch||
  result.submissionId!==source.operationId||result.grade!==line.grade||
  result.quantity!==line.quantity||result.unit!=='pieces'||
  result.materialId!==line.materialId||result.sourceBatchId!==source.productionBatchId||
  result.sourceStepNumber!==source.stepNumber||
  result.assemblyBatchId!==target.assemblyBatchId||
  result.assemblyStepNumber!==target.assemblyStepNumber||
  result.recipientId!==target.recipientId)
  throw Error('Ответ сервера о доступности электродов не совпадает с исходным предложением');
 return{
  submissionId:source.operationId,grade:line.grade,quantity:line.quantity,
  materialId:line.materialId,sourceBatchId:source.productionBatchId,
  sourceStepNumber:source.stepNumber,sortRunId:source.source.runId,
 };
}
