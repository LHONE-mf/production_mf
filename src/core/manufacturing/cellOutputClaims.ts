import {db} from '../db';
import {UserRole} from '../types';
import type {FormationSerialIdentity} from './formationSerialIdentity';
import {inventoryScopeKey,type InventoryScope} from '../sync/inventoryOutbox';
import {issueIdValid} from '../sync/inventoryIssueTypes';
import {sameOutput} from '../sync/inventoryOutputTypes';
import {cellSubmissionFromIdentity,type CellSubmissionInput,type CellSubmissionRequest,type CellSubmission} from '../sync/inventoryCellOutputTypes';
export interface CellOutputClaim {
 version:1;runId:string;identityId:string;assemblyOutputId:string;identity:FormationSerialIdentity;
 scope:InventoryScope;localActorId:string;localActorRole:UserRole;epoch:string;
 request:CellSubmissionRequest;createdAt:string;revision:number;
 state:'pending'|'accepted'|'conflict'|'rejected';error?:string;acknowledgement?:CellSubmission;
}
export async function cellOutputClaims(scope:InventoryScope,localActorId:string){
 const key=inventoryScopeKey(scope);
 return db.cellOutputClaims.filter(c=>c.localActorId===localActorId&&inventoryScopeKey(c.scope)===key).toArray();
}
/** Exclusive whole-source claim and original body share the manufacturing DB.
 * No stock write, token persistence, automatic send or epoch rebase. */
export async function freezeCellOutput(scope:InventoryScope,localActorId:string,epoch:string,identity:FormationSerialIdentity,input:CellSubmissionInput):Promise<CellOutputClaim>{
 inventoryScopeKey(scope);
 if(!issueIdValid(epoch)||input.deviceId!==scope.deviceId||!localActorId.trim())throw Error('Invalid original cell scope/history');
 const original=structuredClone(identity),request=cellSubmissionFromIdentity(original,input),safeScope={serverUrl:scope.serverUrl,organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId};
 return db.transaction('rw',[db.users,db.formationSerialIdentities,db.cellOutputClaims],async()=>{
  const actor=await db.users.get(localActorId);
  if(!actor?.isActive||![UserRole.CHIEF,UserRole.MASTER,UserRole.TECHNOLOGIST].includes(actor.role))throw Error('Нужен активный локальный руководитель производства');
  const old=await db.cellOutputClaims.get(original.runId);
  if(old){
   if(old.localActorId===localActorId&&old.localActorRole===actor.role&&inventoryScopeKey(old.scope)===inventoryScopeKey(safeScope)&&old.epoch===epoch&&sameOutput(old.identity,original)&&sameOutput(old.request,request))return old;
   throw Error('Источник уже предложен; исходные ID, автор, устройство и история удержаны');
  }
  const saved=await db.formationSerialIdentities.get(original.runId);
  if(!saved||!sameOutput(saved,original))throw Error('Сохранённое заявление номеров изменено или отсутствует');
  const claim:CellOutputClaim={version:1,runId:original.runId,identityId:original.id,assemblyOutputId:original.assemblyOutputId,identity:structuredClone(saved),scope:safeScope,localActorId,localActorRole:actor.role,epoch,request,createdAt:new Date().toISOString(),revision:1,state:'pending'};
  await db.cellOutputClaims.add(claim);return claim;
 });
}
