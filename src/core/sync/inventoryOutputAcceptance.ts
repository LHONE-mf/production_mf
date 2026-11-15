import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import {loadWarehouseAccess} from './inventoryCatalogClient';
import {issueIdValid,issueTextValid} from './inventoryIssueTypes';
import {outcomeStockCopy} from './inventoryOutcomeTypes';
import {offeredOutputCopy,preflightOutput,type OfferedOutput} from './inventoryOutputs';
import {sameOutput} from './inventoryOutputTypes';
import {inventoryOutbox,inventoryScopeKey,validInventoryDate,inventoryExpiryAt,validateInventoryStock,sameInventoryStock,archiveInventoryAcknowledgement,type InventoryScope,type InventoryStockSnapshot,type ReceivingDraft} from './inventoryOutbox';
import {withInventorySync} from './inventorySyncLock';
export interface OutputAcceptanceRequest {
 operationId:string;deviceId:string;submissionId:string;grade:string;expectedRevision:1;
 stockId:string;locationId:string;quantity:number;reason:string;evidence:string;manufacturedOn?:string;expiresOn?:string;
}
export type OutputAcceptanceInput=Pick<OutputAcceptanceRequest,'grade'|'locationId'|'quantity'|'reason'|'evidence'|'manufacturedOn'|'expiresOn'>;
export async function outputAcceptanceProposals(scope:InventoryScope,localActorId:string){
 const key=inventoryScopeKey(scope);return inventoryOutbox.receivingDrafts.filter(r=>{try{const k=JSON.parse(r.key);return k[0]===key&&k[1]===localActorId&&k[2]==='output-accept';}catch{return false;}}).toArray();
}
function validate(request:OutputAcceptanceRequest,source:OfferedOutput,scope:InventoryScope){
 const line=source.outputs.find(o=>o.grade===request.grade);
 if(![request.operationId,request.deviceId,request.submissionId,request.stockId,request.locationId].every(issueIdValid)||request.deviceId!==scope.deviceId||request.submissionId!==source.operationId||request.expectedRevision!==1||
  !line||line.stockId!==null||request.quantity!==line.quantity||!issueTextValid(request.reason)||!issueTextValid(request.evidence)||
  request.manufacturedOn!==undefined&&!validInventoryDate(request.manufacturedOn)||request.expiresOn!==undefined&&!validInventoryDate(request.expiresOn)||
  request.manufacturedOn&&request.expiresOn&&request.manufacturedOn>request.expiresOn||
  Object.keys(request).some(k=>!['operationId','deviceId','submissionId','grade','expectedRevision','stockId','locationId','quantity','reason','evidence','manufacturedOn','expiresOn'].includes(k)))throw Error('Физическая приёмка должна сохранить исходный сорт, полное фактически посчитанное количество и свидетельство');
 return line;
}
/** Offline proposal only; no stock/cache changes until an authenticated ACK. */
export async function freezeOutputAcceptance(scope:InventoryScope,localActorId:string,epoch:string,original:OfferedOutput,input:OutputAcceptanceInput){
 const scopeKey=inventoryScopeKey(scope),source=offeredOutputCopy(original);
 if(!localActorId.trim()||!issueIdValid(epoch))throw Error('Invalid original acceptance scope/history');
 const request:OutputAcceptanceRequest={operationId:crypto.randomUUID(),deviceId:scope.deviceId,submissionId:source.operationId,grade:input.grade,expectedRevision:1,stockId:crypto.randomUUID(),locationId:input.locationId,quantity:input.quantity,reason:input.reason.trim(),evidence:input.evidence.trim(),
  ...(input.manufacturedOn?{manufacturedOn:input.manufacturedOn}:{}),...(input.expiresOn?{expiresOn:input.expiresOn}:{})};validate(request,source,scope);
 return inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
  const previous=await outputAcceptanceProposals(scope,localActorId);
  if(previous.some(r=>{const old:OutputAcceptanceRequest=JSON.parse(r.fields.request);return old.submissionId===request.submissionId&&old.grade===request.grade;}))throw Error('Исходная приёмка этого сорта уже сохранена; используйте её ID или сверку');
  const row:ReceivingDraft={key:JSON.stringify([scopeKey,localActorId,'output-accept',request.operationId]),revision:1,operationId:request.operationId,fields:{epoch,state:'pending',source:JSON.stringify(source),request:JSON.stringify(request),createdAt:new Date().toISOString()}};
  await inventoryOutbox.receivingDrafts.add(row);return row;
 });
}
export function sendOutputAcceptance(session:HybridSession,scope:InventoryScope,localActorId:string,key:string){return withInventorySync(scope,async()=>{
 const row=(await outputAcceptanceProposals(scope,localActorId)).find(r=>r.key===key);
 if(!row||row.fields.state!=='pending'||!issueIdValid(row.fields.epoch))throw Error('Нет исходной ожидающей приёмки');
 const request:OutputAcceptanceRequest=JSON.parse(row.fields.request),source=offeredOutputCopy(JSON.parse(row.fields.source)),line=validate(request,source,scope);
 if(request.operationId!==row.operationId)throw Error('Original acceptance ID changed');
 await loadWarehouseAccess(session,scope);await preflightOutput(session,scope,row.fields.epoch);
 const response=await inventoryRequest(session,scope,'/inventory/outputs/accept',{method:'POST',headers:{'x-inventory-epoch':row.fields.epoch},body:row.fields.request});
 if([400,404,409].includes(response.status)){
  await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
   if(!sameOutput(await inventoryOutbox.receivingDrafts.get(key),row))throw Error('Original acceptance changed');
   await inventoryOutbox.receivingDrafts.put({...row,revision:row.revision+1,fields:{...row.fields,state:response.status===409?'conflict':'rejected',error:'HTTP '+response.status}});
  });throw Error('Приёмка не принята; исходный подсчёт и источник сохранены: HTTP '+response.status);
 }
 if(response.status!==200&&response.status!==201)throw Error('Ответ неизвестен или доступ утрачен; повторяйте исходный ID: HTTP '+response.status);
 const raw=await response.json();validateInventoryStock(raw?.stock);const stock=outcomeStockCopy(raw.stock);
 const expected:InventoryStockSnapshot={stockId:request.stockId,materialId:line.materialId,manufacturerLot:'production:'+request.submissionId+':'+request.grade,unit:'pieces',locationId:request.locationId,quality:'quarantine',onHand:request.quantity,reserved:0,available:request.quantity,revision:1,
  ...(request.manufacturedOn?{manufacturedOn:request.manufacturedOn}:{}),...(request.expiresOn?{expiresAt:inventoryExpiryAt(request.expiresOn)}:{})};
 if(raw.operationId!==request.operationId||raw.status!==(response.status===201?'confirmed':'duplicate')||!sameInventoryStock(stock,expected))throw Error('Acceptance ACK changed original source/grade/count/quarantine/dates');
 await inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,inventoryOutbox.stocks,inventoryOutbox.acknowledgements,async()=>{
  if(!sameOutput(await inventoryOutbox.receivingDrafts.get(key),row))throw Error('Original acceptance changed while awaiting ACK');
  const scopeKey=inventoryScopeKey(scope),before=await inventoryOutbox.stocks.get([scopeKey,stock.stockId]);
  if(before&&before.revision===stock.revision&&!sameInventoryStock(before,stock))throw Error('Acceptance cache conflicts with original ACK');
  if(!before||before.revision<stock.revision)await inventoryOutbox.stocks.put({...stock,scopeKey});
  await archiveInventoryAcknowledgement({operationId:request.operationId,scopeKey,epoch:row.fields.epoch,kind:'receive',stockId:stock.stockId,request,stock,receivedAt:Date.now()});
  await inventoryOutbox.receivingDrafts.put({...row,revision:row.revision+1,fields:{...row.fields,state:'accepted',acknowledgement:JSON.stringify({status:raw.status,operationId:request.operationId,stock}),acceptedAt:new Date().toISOString()}});
 });
});}
