import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import {inventoryOutbox,inventoryScopeKey,type InventoryScope,type ReceivingDraft} from './inventoryOutbox';
import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {loadInventoryOutputs} from './inventoryOutputs';
import type {AvailableAssemblyGrade,AssemblyEligibilityTarget} from './assemblyEligibility';

export interface AssemblyHandoffRequest {
 operationId:string;deviceId:string;submissionId:string;grade:string;quantity:number;
 assemblyBatchId:string;assemblyStepNumber:number;recipientId:string;reason:string;evidence:string;
}
export interface AssemblyHandoff extends AssemblyHandoffRequest {
 sourceBatchId:string;materialId:string;recipientWorkshopId:string;actorId:string;
 recordedAt:string;warehouseEffect:'none';qualityStatus:'unreviewed';
}
export interface AssemblyReceiptRequest {
 operationId:string;deviceId:string;handoffId:string;observedQuantity:number;
 observedGrade:string;observedLabel:string;reason:string;evidence:string;
}
export interface AssemblyReceipt extends AssemblyReceiptRequest {
 sourceSnapshot:AssemblyHandoff;actorId:string;recordedAt:string;
 custodyEffect:'received';warehouseEffect:'none';qualityStatus:'unreviewed';
}
export interface AssemblyHandoffListing {handoff:AssemblyHandoff;received:AssemblyReceipt|null}
type Kind='offer'|'receive';
const positive=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const label=(v:unknown,max=2000)=>issueTextValid(v)&&v.length<=max;
const exact=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const scopedKey=(scope:InventoryScope,kind:Kind,id:string,grade?:string)=>
 JSON.stringify([inventoryScopeKey(scope),'assembly-'+kind,id,...(grade?[grade]:[])]);
const fields=(row:ReceivingDraft,kind:Kind)=>{
 if(row.fields.kind!==kind||!issueIdValid(row.fields.epoch))throw Error('Неверная история исходной передачи');
 return row.fields;
};
function validHandoff(raw:unknown):AssemblyHandoff {
 const r=raw as AssemblyHandoff;
 if(!r||![r.operationId,r.deviceId,r.submissionId,r.assemblyBatchId,r.recipientId,
  r.sourceBatchId,r.materialId,r.recipientWorkshopId,r.actorId].every(issueIdValid)||
  !label(r.grade,120)||!positive(r.quantity)||!positive(r.assemblyStepNumber)||
  !label(r.reason)||!label(r.evidence)||!Number.isFinite(Date.parse(r.recordedAt))||
  r.warehouseEffect!=='none'||r.qualityStatus!=='unreviewed')throw Error('Некорректная серверная передача электродов');
 return{operationId:r.operationId,deviceId:r.deviceId,submissionId:r.submissionId,grade:r.grade,quantity:r.quantity,
  assemblyBatchId:r.assemblyBatchId,assemblyStepNumber:r.assemblyStepNumber,recipientId:r.recipientId,
  reason:r.reason,evidence:r.evidence,sourceBatchId:r.sourceBatchId,materialId:r.materialId,
  recipientWorkshopId:r.recipientWorkshopId,actorId:r.actorId,recordedAt:r.recordedAt,
  warehouseEffect:'none',qualityStatus:'unreviewed'};
}
function validReceipt(raw:unknown,handoff:AssemblyHandoff):AssemblyReceipt {
 const r=raw as AssemblyReceipt;
 if(!r||![r.operationId,r.deviceId,r.handoffId,r.actorId].every(issueIdValid)||
  r.handoffId!==handoff.operationId||r.actorId!==handoff.recipientId||
  r.observedGrade!==handoff.grade||r.observedQuantity!==handoff.quantity||
  r.observedLabel!=='production:'+handoff.submissionId+':'+handoff.grade||
  !label(r.reason)||!label(r.evidence)||!Number.isFinite(Date.parse(r.recordedAt))||
  r.custodyEffect!=='received'||r.warehouseEffect!=='none'||r.qualityStatus!=='unreviewed'||
  !exact(validHandoff(r.sourceSnapshot),handoff))throw Error('Некорректная физическая приёмка Assembly');
 return{operationId:r.operationId,deviceId:r.deviceId,handoffId:r.handoffId,actorId:r.actorId,
  observedQuantity:r.observedQuantity,observedGrade:r.observedGrade,observedLabel:r.observedLabel,
  reason:r.reason,evidence:r.evidence,recordedAt:r.recordedAt,sourceSnapshot:handoff,
  custodyEffect:'received',warehouseEffect:'none',qualityStatus:'unreviewed'};
}
/** Recipient-scoped read from authoritative server. No local WIP or stock writes. */
export async function loadAssemblyHandoffs(
 session:HybridSession,scope:InventoryScope,epoch?:string,after?:string,limit=50,
){
 if(after!==undefined&&!issueIdValid(after)||!positive(limit)||limit>100)throw Error('Неверная страница передач');
 const query=new URLSearchParams({deviceId:scope.deviceId,limit:String(limit),...(after?{after}:{})});
 const response=await inventoryRequest(session,scope,'/inventory/assembly-electrodes/handoffs?'+query);
 if(!response.ok)throw Error('Список передач Assembly недоступен: HTTP '+response.status);
 const raw=await response.json();
 if(raw?.organizationId!==scope.organizationId||raw?.actorId!==scope.actorId||
  raw?.deviceId!==scope.deviceId||!issueIdValid(raw?.epoch)||
  epoch!==undefined&&raw.epoch!==epoch||!Array.isArray(raw.items)||
  raw.items.length>limit||typeof raw.hasMore!=='boolean')throw Error('История или владелец передач Assembly изменены');
 let previous=after??'';
 const items:AssemblyHandoffListing[]=raw.items.map((item:unknown)=>{
  const data=item as AssemblyHandoffListing;
  const handoff=validHandoff(data?.handoff);
  if(handoff.recipientId!==scope.actorId||handoff.operationId<=previous)
   throw Error('Неверный порядок или адресат передачи');
  previous=handoff.operationId;
  return{handoff,received:data.received===null?null:validReceipt(data.received,handoff)};
 });
 if(raw.hasMore?(items.length!==limit||raw.nextAfter!==previous):raw.nextAfter!==null)
  throw Error('Неверная следующая страница передач');
 return{epoch:raw.epoch as string,items,nextAfter:raw.nextAfter as string|null};
}
export async function assemblyDrafts(scope:InventoryScope,kind:Kind){
 const prefix=inventoryScopeKey(scope);
 const all=await inventoryOutbox.receivingDrafts.toArray();
 return all.filter(r=>{try{const p=JSON.parse(r.key);return p[0]===prefix&&p[1]==='assembly-'+kind;}catch{return false;}});
}
/** Freeze an immutable grade-specific offer before *any* network write. */
export async function freezeAssemblyOffer(scope:InventoryScope,epoch:string,grade:AvailableAssemblyGrade,
 target:AssemblyEligibilityTarget,reason:string,evidence:string){
 const key=scopedKey(scope,'offer',grade.submissionId,grade.grade);
 if(!issueIdValid(epoch)||!issueIdValid(grade.submissionId)||!label(grade.grade,120)||
  !positive(grade.quantity)||!issueIdValid(target.assemblyBatchId)||!issueIdValid(target.recipientId)||
  !positive(target.assemblyStepNumber)||!label(reason)||!label(evidence))
  throw Error('Неверные данные предложения Assembly');
 const request:AssemblyHandoffRequest={operationId:crypto.randomUUID(),deviceId:scope.deviceId,
  submissionId:grade.submissionId,grade:grade.grade,quantity:grade.quantity,
  assemblyBatchId:target.assemblyBatchId,assemblyStepNumber:target.assemblyStepNumber,
  recipientId:target.recipientId,reason:reason.trim(),evidence:evidence.trim()};
 const row:ReceivingDraft={key,revision:1,operationId:request.operationId,
  fields:{kind:'offer',epoch,state:'pending',request:JSON.stringify(request)}};
 return inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
  if(await inventoryOutbox.receivingDrafts.get(key))
   throw Error('Для этого сорта уже сохранена передача; повторяйте исходный ID');
  await inventoryOutbox.receivingDrafts.add(row);return row;
 });
}
/** A receiver records their own observed pieces; never auto-accept on send. */
export async function freezeAssemblyReceipt(scope:InventoryScope,epoch:string,handoff:AssemblyHandoff,
 observed:number,reason:string,evidence:string){
 const source=validHandoff(handoff),key=scopedKey(scope,'receive',source.operationId);
 if(!issueIdValid(epoch)||source.recipientId!==scope.actorId||!positive(observed)||
  observed!==source.quantity||!label(reason)||!label(evidence))
  throw Error('Получатель должен физически пересчитать полный сорт');
 const request:AssemblyReceiptRequest={operationId:crypto.randomUUID(),deviceId:scope.deviceId,
  handoffId:source.operationId,observedQuantity:observed,observedGrade:source.grade,
  observedLabel:'production:'+source.submissionId+':'+source.grade,
  reason:reason.trim(),evidence:evidence.trim()};
 const row:ReceivingDraft={key,revision:1,operationId:request.operationId,
  fields:{kind:'receive',epoch,state:'pending',request:JSON.stringify(request),
   source:JSON.stringify(source)}};
 return inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
  if(await inventoryOutbox.receivingDrafts.get(key))
   throw Error('Этот физический подсчёт уже сохранён; повторяйте его исходный ID');
  await inventoryOutbox.receivingDrafts.add(row);return row;
 });
}
export async function sendAssemblyDraft(session:HybridSession,scope:InventoryScope,key:string){
 const row=await inventoryOutbox.receivingDrafts.get(key);
 if(!row||row.fields.state!=='pending'||row.operationId===undefined)
  throw Error('Нет ожидающей исходной передачи');
 const kind=row.fields.kind as Kind;
 if(kind!=='offer'&&kind!=='receive'||scopedKey(scope,kind,
  kind==='offer'?(JSON.parse(row.fields.request) as AssemblyHandoffRequest).submissionId:
   (JSON.parse(row.fields.request) as AssemblyReceiptRequest).handoffId,
  kind==='offer'?(JSON.parse(row.fields.request) as AssemblyHandoffRequest).grade:undefined)!==key)
  throw Error('Исходная передача другого пользователя или сервера');
 const original=fields(row,kind),request=JSON.parse(original.request) as AssemblyHandoffRequest|AssemblyReceiptRequest;
 if(request.operationId!==row.operationId||request.deviceId!==scope.deviceId)
  throw Error('Исходный ID передачи изменился');
 // Check the current server epoch, but never replace the original immutable payload.
 if(kind==='offer')await loadInventoryOutputs(session,scope,original.epoch,undefined,1);
 else await loadAssemblyHandoffs(session,scope,original.epoch,undefined,1);
 const response=await inventoryRequest(session,scope,
  kind==='offer'?'/inventory/assembly-electrodes/handoffs':'/inventory/assembly-electrodes/acknowledgements',
  {method:'POST',headers:{'x-inventory-epoch':original.epoch},body:original.request});
 if([400,404,409].includes(response.status)){
  await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
   const saved=await inventoryOutbox.receivingDrafts.get(key);
   if(!saved||!exact(saved,row))throw Error('Исходный подсчёт изменён');
   await inventoryOutbox.receivingDrafts.put({...row,revision:row.revision+1,
    fields:{...original,state:response.status===409?'conflict':'rejected',error:'HTTP '+response.status}});
  });
  throw Error('Сервер отклонил передачу; исходные данные сохранены: HTTP '+response.status);
 }
 if(response.status!==201&&response.status!==200)
  throw Error('Нет подтверждения передачи; повторите сохранённый ID: HTTP '+response.status);
 const raw=await response.json(),expected=response.status===201?'confirmed':'duplicate';
 if(raw?.operationId!==request.operationId||raw.status!==expected)
  throw Error('Серверное подтверждение не соответствует исходной операции');
 const originalRequest=JSON.parse(original.request);
 let acknowledgement:AssemblyHandoff|AssemblyReceipt;
 if(kind==='offer'){
  const value=validHandoff(raw.handoff);
  if(Object.entries(originalRequest).some(([field,v])=>
   !exact(value[field as keyof AssemblyHandoff],v))||value.actorId!==scope.actorId)
   throw Error('Сервер изменил исходную передачу электродов');
  acknowledgement=value;
 }else{
  const source=validHandoff(JSON.parse(original.source));
  const value=validReceipt(raw.receipt,source);
  if(Object.entries(originalRequest).some(([field,v])=>
   !exact(value[field as keyof AssemblyReceipt],v))||value.actorId!==scope.actorId)
   throw Error('Сервер изменил исходную физическую приёмку');
  acknowledgement=value;
 }
 await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
  const saved=await inventoryOutbox.receivingDrafts.get(key);
  if(!saved||!exact(saved,row))throw Error('Исходная передача изменена во время подтверждения');
  await inventoryOutbox.receivingDrafts.put({...row,revision:row.revision+1,
   fields:{...original,state:'accepted',acknowledgement:JSON.stringify(acknowledgement)}});
 });
 return acknowledgement;
}
