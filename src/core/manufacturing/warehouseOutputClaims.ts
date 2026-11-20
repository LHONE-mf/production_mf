import {db} from '../db';
import {UserRole,type AssemblyRun,type SortRun} from '../types';
import {inventoryScopeKey,type InventoryScope} from '../sync/inventoryOutbox';
import {issueIdValid} from '../sync/inventoryIssueTypes';
import {submissionFromSortRun,sameOutput,type ElectrodeSubmissionRequest,type ElectrodeSubmissionInput,type ElectrodeSubmission} from '../sync/inventoryOutputTypes';

export interface WarehouseOutputClaim {
 version:1;cutRunId:string;runId:string;batchName:string;scope:InventoryScope;localActorId:string;epoch:string;
 source:SortRun;request:ElectrodeSubmissionRequest;createdAt:string;revision:number;
 state:'pending'|'accepted'|'conflict'|'rejected';error?:string;acknowledgement?:ElectrodeSubmission;
}
/** Must run inside a main-database transaction that includes source claims. */
export async function assertAssemblySourceNotOffered(run:AssemblyRun){
 const references=run.ops.flatMap(op=>op.source?.kind==='declared'?[op.source.reference]:[]);
 const runs=[...references,run.intake?.sortRunId,run.sourceSort?.id].filter((id):id is string=>!!id),cuts=[...references,run.sourceSort?.cutRunId].filter((id):id is string=>!!id);
 if(await db.warehouseOutputClaims.where('runId').anyOf(runs).count()||await db.warehouseOutputClaims.where('cutRunId').anyOf(cuts).count()||
  !run.intake&&await db.warehouseOutputClaims.where('batchName').equals(run.batchName).count())
  throw Error('Источник предложен на склад; исходное предложение удержано для сверки');
}
export async function warehouseOutputClaims(scope:InventoryScope,localActorId:string){
 const key=inventoryScopeKey(scope);
 return db.warehouseOutputClaims.filter(c=>c.localActorId===localActorId&&inventoryScopeKey(c.scope)===key).toArray();
}
export async function freezeWarehouseOutput(scope:InventoryScope,localActorId:string,epoch:string,source:SortRun,input:ElectrodeSubmissionInput):Promise<WarehouseOutputClaim>{
 inventoryScopeKey(scope);
 const receiptScope=source.cutRunSnapshot?.receivedCustody?.scopeKey;
 if(receiptScope && !receiptScope.startsWith(new URL(scope.serverUrl).origin+'::'+scope.organizationId+'::'))
  throw Error('Подтверждённая приёмка относится к другой организации или серверу');
 if(!issueIdValid(epoch)||input.deviceId!==scope.deviceId||!localActorId.trim())throw Error('Invalid original output scope/history');
 const request=submissionFromSortRun(source,input),safeScope={serverUrl:scope.serverUrl,organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId};
 return db.transaction('rw',[db.users,db.sortRuns,db.assemblyRuns,db.warehouseOutputClaims],async()=>{
  const actor=await db.users.get(localActorId);
  if(!actor?.isActive||![UserRole.CHIEF,UserRole.MASTER,UserRole.TECHNOLOGIST].includes(actor.role))throw Error('Нужен активный локальный руководитель производства');
  const old=await db.warehouseOutputClaims.get(request.source.cutRunId);
  if(old){
   if(old.localActorId===localActorId&&inventoryScopeKey(old.scope)===inventoryScopeKey(scope)&&old.epoch===epoch&&sameOutput(old.source,source)&&sameOutput(old.request,request))return old;
   throw Error('Источник уже предложен на склад; исходный ID, автор, сервер и история не заменены');
  }
  if(!sameOutput(await db.sortRuns.get(source.id),source))throw Error('Источник сортировки изменён или отсутствует');
  const allocated=await db.assemblyRuns.filter(r=>r.intake?.sortRunId===source.id||r.sourceSort?.id===source.id||r.sourceSort?.cutRunId===source.cutRunId||
   !r.intake&&r.batchName===source.batchName||r.ops.some(op=>op.source?.kind==='declared'&&[source.id,source.cutRunId].includes(op.source.reference))).first();
  if(allocated)throw Error('Источник уже распределён в сборку или имеет неоднозначную историю');
  const claim:WarehouseOutputClaim={version:1,cutRunId:request.source.cutRunId,runId:source.id,batchName:source.batchName,
   scope:safeScope,localActorId,epoch,source,request,createdAt:new Date().toISOString(),revision:1,state:'pending'};
  await db.warehouseOutputClaims.add(claim);return claim;
 });
}
