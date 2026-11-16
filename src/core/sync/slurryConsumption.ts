import {db} from '../db';
import type {MixBatch} from '../types';
import type {HybridSession} from './hybridClient';
import {validateMeasuredSlurryBatch} from '../manufacturing/slurryBatch';
import {inventoryRequest} from './inventoryClient';
import {loadInventoryIssueContext} from './inventoryIssueClient';
import {issueIdValid,validateIssue,type InventoryIssue} from './inventoryIssueTypes';
import {validateSettlement,type InventorySettlement,outcomeInstant} from './inventoryOutcomeTypes';
import {toInventoryBaseUnits} from './inventoryReceiving';
import {inventoryOutbox,inventoryScopeKey,type InventoryScope,type ReceivingDraft} from './inventoryOutbox';
import {withInventorySync} from './inventorySyncLock';
import {sameOutput as same} from './inventoryOutputTypes';
export interface SlurryAllocation {operationId:string;issueId:string;materialId:string;componentId:string;quantity:number;expectedSettlementRevision:number}
export interface SlurryConsumptionRequest {
 operationId:string;deviceId:string;productionBatchId:string;stepNumber:number;
 source:{id:string;recordedAt:number;recordedBy:string;recordedRole:string;batchCode:string;recipeId:string|null;recipeRevision:number|null;recipeName:string;measurementNote:string;components:{componentId:string;componentVersion:number;actualMg:number}[]};
 allocations:SlurryAllocation[];reason:string;evidence:string;
}
export interface RoomMaterial {issue:InventoryIssue;room:string;materialName:string;materialCode:string;batchCode:string;eligible:boolean;settlement:InventorySettlement}
export function buildSlurryConsumption(batch:MixBatch,input:Omit<SlurryConsumptionRequest,'source'>):SlurryConsumptionRequest{
 validateMeasuredSlurryBatch(batch);
 const source={id:batch.id,recordedAt:batch.createdAt,recordedBy:batch.workerId,recordedRole:batch.recordedRole!,batchCode:batch.batchCode!,recipeId:batch.recipeId??null,recipeRevision:batch.recipeSnapshot?.updatedAt??null,recipeName:batch.recipeName,measurementNote:batch.measurementNote!,components:batch.weighings.map(w=>({componentId:w.componentId,componentVersion:batch.componentSnapshots!.find(c=>c.id===w.componentId)!.updatedAt,actualMg:w.actualG===0?0:toInventoryBaseUnits(String(w.actualG),'g','mg')}))};
 if(![input.operationId,input.deviceId,input.productionBatchId].every(issueIdValid)||!Number.isSafeInteger(input.stepNumber)||input.stepNumber<1||!input.reason.trim()||!input.evidence.trim()||input.reason.length>2000||input.evidence.length>2000||input.allocations.length<1||input.allocations.length>100)throw Error('Заполните партию, шаг, основание и свидетельство расхода');
 if(new Set([input.operationId,...input.allocations.map(a=>a.operationId)]).size!==input.allocations.length+1||new Set(input.allocations.map(a=>a.issueId)).size!==input.allocations.length||input.allocations.some(a=>![a.operationId,a.issueId,a.materialId].every(issueIdValid)||!Number.isSafeInteger(a.quantity)||a.quantity<=0||!Number.isSafeInteger(a.expectedSettlementRevision)||a.expectedSettlementRevision<1||!source.components.some(c=>c.componentId===a.componentId)))throw Error('Некорректные исходные выдачи или количества');
 for(const c of source.components)if(input.allocations.filter(a=>a.componentId===c.componentId).reduce((n,a)=>n+BigInt(a.quantity),0n)!==BigInt(c.actualMg))throw Error('По каждому компоненту распределите ровно фактическую навеску, а не план');
 return{operationId:input.operationId,deviceId:input.deviceId,productionBatchId:input.productionBatchId,stepNumber:input.stepNumber,source,allocations:input.allocations.map(a=>({...a})),reason:input.reason,evidence:input.evidence};
}
export async function loadRoomMaterials(session:HybridSession,scope:InventoryScope,room='slurry',after?:string){
 const response=await inventoryRequest(session,scope,`/inventory/room-materials/${room}?`+new URLSearchParams({deviceId:scope.deviceId,...(after?{after}:{})}));
 if(!response.ok)throw Error('Материалы комнаты недоступны: HTTP '+response.status);const raw=await response.json();
 if(raw?.organizationId!==scope.organizationId||raw.actorId!==scope.actorId||raw.deviceId!==scope.deviceId||!issueIdValid(raw.epoch)||typeof raw.postingEnabled!=='boolean'||!Array.isArray(raw.items)||raw.items.length>50||typeof raw.hasMore!=='boolean')throw Error('Invalid room custody context');
 let previous=after??'';
 const items:RoomMaterial[]=raw.items.map((r:RoomMaterial)=>{validateIssue(r.issue);validateSettlement(r.settlement);if(r.room!==room||r.issue.id<=previous||r.issue.state!=='received'||r.settlement.issued!==r.issue.quantity||typeof r.eligible!=='boolean'||![r.materialName,r.materialCode,r.batchCode].every(s=>typeof s==='string'&&s.length<=2000))throw Error('Invalid room source');previous=r.issue.id;return{issue:r.issue,room:r.room,materialName:r.materialName,materialCode:r.materialCode,batchCode:r.batchCode,eligible:r.eligible,settlement:r.settlement};});
 if(raw.hasMore?items.length!==50||raw.nextAfter!==previous:raw.nextAfter!==null)throw Error('Invalid room cursor');
 return{epoch:raw.epoch as string,postingEnabled:raw.postingEnabled as boolean,items,nextAfter:raw.nextAfter as string|null};
}
export function slurryConsumptionProposals(scope:InventoryScope,actor:string){return inventoryOutbox.receivingDrafts.filter(row=>{try{const k=JSON.parse(row.key);return k[0]===inventoryScopeKey(scope)&&k[1]===actor&&k[2]==='slurry-consumption';}catch{return false;}}).toArray();}
export async function freezeSlurryConsumption(scope:InventoryScope,localActorId:string,epoch:string,batch:MixBatch,request:SlurryConsumptionRequest){
 const user=await db.users.get(localActorId);
 if(!user?.isActive||user.role!==batch.recordedRole||batch.workerId!==localActorId||!same(await db.mixBatches.get(batch.id),batch)||!issueIdValid(epoch)||request.deviceId!==scope.deviceId||!same(buildSlurryConsumption(batch,request),request))throw Error('Исходный замес, автор или область изменены');
 return inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
  const key=JSON.stringify([inventoryScopeKey(scope),localActorId,'slurry-consumption',batch.id]);
  const existing=await inventoryOutbox.receivingDrafts.filter(row=>{try{return JSON.parse(row.key)[2]==='slurry-consumption'&&JSON.parse(row.fields.source).id===batch.id;}catch{return false;}}).first();
  if(existing){if(existing.key===key&&existing.fields.request===JSON.stringify(request)&&existing.fields.epoch===epoch)return existing;throw Error('Замес уже удержан исходным предложением; перенос источника запрещён');}
  const row:ReceivingDraft={key,revision:1,operationId:request.operationId,fields:{state:'pending',epoch,source:JSON.stringify(batch),localRole:user.role,request:JSON.stringify(request)}};
  await inventoryOutbox.receivingDrafts.add(row);return row;
 });
}
export function sendSlurryConsumption(session:HybridSession,scope:InventoryScope,actor:string,key:string){
 return withInventorySync(scope,async()=>{
  const row=(await slurryConsumptionProposals(scope,actor)).find(r=>r.key===key);if(!row||row.fields.state!=='pending')throw Error('Нет исходного ожидающего расхода');
  const batch:MixBatch=JSON.parse(row.fields.source),request:SlurryConsumptionRequest=JSON.parse(row.fields.request),user=await db.users.get(actor);
  if(!user?.isActive||user.role!==row.fields.localRole||batch.workerId!==actor||!same(await db.mixBatches.get(batch.id),batch)||!same(buildSlurryConsumption(batch,request),request)||request.deviceId!==scope.deviceId||request.operationId!==row.operationId)throw Error('Исходный автор, замес или запрос изменён');
  const context=await loadInventoryIssueContext(session,scope);if(context.epoch!==row.fields.epoch||!context.postingEnabled)throw Error('История изменилась; исходный расход удержан');
  const response=await inventoryRequest(session,scope,'/inventory/room-materials/slurry/consumptions',{method:'POST',headers:{'x-inventory-epoch':row.fields.epoch},body:row.fields.request});
  async function commit(fields:Record<string,string>){await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{if(!same(await inventoryOutbox.receivingDrafts.get(key),row))throw Error('Исходное предложение изменилось при ожидании ответа');await inventoryOutbox.receivingDrafts.put({...row!,revision:row!.revision+1,fields:{...row!.fields,...fields}});});}
  if([400,404,409].includes(response.status)){await commit({state:response.status===409?'conflict':'rejected',error:'HTTP '+response.status});throw Error('Расход не принят; исходный ID и данные сохранены: HTTP '+response.status);}
  if(![200,201].includes(response.status))throw Error('Ответ неизвестен / доступ утрачен; повторите исходный ID: HTTP '+response.status);
  const raw=await response.json(),expected={...request,room:'slurry',actorId:scope.actorId,recordedAt:raw?.consumption?.recordedAt,warehouseEffect:'none'};
  if(raw?.status!==(response.status===201?'confirmed':'duplicate')||raw.operationId!==request.operationId||!outcomeInstant(expected.recordedAt)||Object.entries(expected).some(([k,v])=>!same(raw.consumption?.[k],v)))throw Error('Ответ расхода не совпадает с исходными навесками/лотами');
  await commit({state:'accepted',acknowledgement:JSON.stringify({status:raw.status,operationId:request.operationId,consumption:expected})});
 });
}
