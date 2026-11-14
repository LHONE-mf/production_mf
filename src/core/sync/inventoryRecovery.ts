import type {HybridSession} from './hybridClient';
import {inventoryOutbox,inventoryScopeKey,invalidateInventoryOfflineViews,type InventoryScope} from './inventoryOutbox';
import {loadWarehouseAccess} from './inventoryCatalogClient';
import {inventoryRequest} from './inventoryClient';
import {withInventorySync} from './inventorySyncLock';

export interface InventoryRecoveryApproval {
 approvalId:string;organizationId:string;epoch:string;targetActorId:string;targetDeviceId:string;
 approvedBy:string;approvalDeviceId:string;evidenceDigest:string;reason:string;evidence:string;approvedAt:string;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonical(value:unknown,depth=0):string {
 if(depth>50)throw Error('Пакет слишком сложный');
 if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v,depth+1)).join(',')+'}';
 return JSON.stringify(value);
}
function content(packet:Record<string,unknown>){const {generatedAt:_at,evidenceDigest:_digest,...data}=packet;return canonical(data);}
async function digest(data:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data))),b=>b.toString(16).padStart(2,'0')).join('');}
const evidenceTables=()=>[inventoryOutbox.operations,inventoryOutbox.stockOperations,inventoryOutbox.acknowledgements,inventoryOutbox.receivingDrafts,inventoryOutbox.streams,inventoryOutbox.stocks,inventoryOutbox.history,inventoryOutbox.metadata];
async function localEvidence(scope:InventoryScope,localActorId:string){
 const scopeKey=inventoryScopeKey(scope);
 const receipts=await inventoryOutbox.operations.where('scopeKey').equals(scopeKey).toArray();
 const stockChanges=await inventoryOutbox.stockOperations.where('scopeKey').equals(scopeKey).toArray();
 const acknowledgements=await inventoryOutbox.acknowledgements.where('scopeKey').equals(scopeKey).toArray();
 const drafts=await inventoryOutbox.receivingDrafts.filter(row=>{try{const key=JSON.parse(row.key);return key[0]===scopeKey&&key[1]===localActorId;}catch{return false;}}).toArray();
 const stream=await inventoryOutbox.streams.get(scopeKey);
 const stocks=await inventoryOutbox.stocks.where('scopeKey').equals(scopeKey).toArray();
 const history=await inventoryOutbox.history.where('scopeKey').equals(scopeKey).toArray();
 const cursor=(await inventoryOutbox.metadata.get(scopeKey+':cursor'))?.value??0;
 return {format:'production-mf-inventory-recovery-v1' as const,scope:{serverUrl:new URL(scope.serverUrl).origin,organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId},lastReviewedEpoch:stream?.epoch??null,cursor,stocks,history,receipts,stockChanges,acknowledgements,drafts};
}
/** Read-only evidence: the digest binds the complete original device state, without credentials. */
export async function inventoryRecoveryEvidence(session:HybridSession,scope:InventoryScope,localActorId:string){
 await loadWarehouseAccess(session,scope);
 const data=await inventoryOutbox.transaction('r',evidenceTables(),()=>localEvidence(scope,localActorId));
 return {...data,generatedAt:new Date().toISOString(),evidenceDigest:await digest(canonical(data))};
}
export type InventoryRecoveryBundle=Awaited<ReturnType<typeof inventoryRecoveryEvidence>>;
async function validatedPacket(packet:unknown,scope:InventoryScope):Promise<InventoryRecoveryBundle>{
 if(!packet||typeof packet!=='object')throw Error('Неверный пакет сверки');
 const p=packet as InventoryRecoveryBundle;
 if(p.format!=='production-mf-inventory-recovery-v1'||!p.scope)throw Error('Неверный пакет сверки');
 inventoryScopeKey(p.scope);
 if(new URL(p.scope.serverUrl).origin!==new URL(scope.serverUrl).origin||p.scope.organizationId!==scope.organizationId||!['receipts','stockChanges','acknowledgements','drafts','stocks','history'].every(k=>Array.isArray((p as unknown as Record<string,unknown>)[k]))||await digest(content(p))!==p.evidenceDigest)throw Error('Пакет изменён или относится к другому серверу / организации');
 return p;
}
function validateStream(raw:Record<string,unknown>,scope:InventoryScope){
 if(raw.organizationId!==scope.organizationId||raw.actorId!==scope.actorId||raw.deviceId!==scope.deviceId||typeof raw.epoch!=='string'||!uuid.test(raw.epoch)||typeof raw.postingEnabled!=='boolean')throw Error('Неверная область ответа сверки');
 return {epoch:raw.epoch,postingEnabled:raw.postingEnabled};
}
function validateApproval(raw:unknown,scope:InventoryScope,epoch:string,evidenceDigest:string):InventoryRecoveryApproval{
 const a=raw as InventoryRecoveryApproval|null;
 if(!a||a.organizationId!==scope.organizationId||a.targetActorId!==scope.actorId||a.targetDeviceId!==scope.deviceId||a.epoch!==epoch||a.evidenceDigest!==evidenceDigest||![a.approvalId,a.approvedBy,a.approvalDeviceId].every(v=>typeof v==='string'&&uuid.test(v))||![a.reason,a.evidence].every(v=>typeof v==='string'&&!!v.trim()&&v.length<=2000)||typeof a.approvedAt!=='string'||!Number.isFinite(Date.parse(a.approvedAt)))throw Error('Нет действующего подтверждения Chief для этого пакета и истории');
 return a;
}
/** Chief approval is an immutable review record. It does not enable posting. */
export async function approveInventoryRecovery(session:HybridSession,scope:InventoryScope,packet:unknown,reason:string,evidence:string,approvalId:string){
 const p=await validatedPacket(packet,scope);
 if((await loadWarehouseAccess(session,scope)).level!=='chief')throw Error('Требуются полномочия Chief');
 const state=await inventoryRequest(session,scope,'/inventory/stream?deviceId='+encodeURIComponent(scope.deviceId));
 if(!state.ok)throw Error('Не удалось проверить историю');
 const stream=validateStream(await state.json(),scope);
 const response=await inventoryRequest(session,scope,'/inventory/recovery-approvals',{method:'POST',body:JSON.stringify({approvalId,deviceId:scope.deviceId,targetActorId:p.scope.actorId,targetDeviceId:p.scope.deviceId,epoch:stream.epoch,evidenceDigest:p.evidenceDigest,reason:reason.trim(),evidence:evidence.trim()})});
 if(!response.ok)throw Error('Подтверждение не записано: HTTP '+response.status);
 const approval=validateApproval((await response.json()).approval,p.scope,stream.epoch,p.evidenceDigest);
 if(approval.approvalId!==approvalId||approval.approvedBy!==scope.actorId||approval.approvalDeviceId!==scope.deviceId)throw Error('Неверное подтверждение');
 return approval;
}
/** Adopt only a reviewed stream; atomically archive all old facts and hold uncertain intents. */
export function applyInventoryRecovery(session:HybridSession,scope:InventoryScope,localActorId:string,expectedDigest:string){
 return withInventorySync(scope,async()=>{
  const packet=await inventoryRecoveryEvidence(session,scope,localActorId);
  if(packet.evidenceDigest!==expectedDigest)throw Error('Данные изменились. Подготовьте новый пакет и повторите сверку');
  const response=await inventoryRequest(session,scope,'/inventory/recovery-approvals?'+new URLSearchParams({deviceId:scope.deviceId,evidenceDigest:expectedDigest}));
  if(!response.ok)throw Error('Не удалось получить подтверждение сверки');
  const raw=await response.json(),stream=validateStream(raw,scope),approval=validateApproval(raw.approval,scope,stream.epoch,expectedDigest),scopeKey=inventoryScopeKey(scope);
  await inventoryOutbox.transaction('rw',[...evidenceTables(),inventoryOutbox.recoveryArchives],async()=>{
   if(canonical(await localEvidence(scope,localActorId))!==content(packet))throw Error('Данные изменились во время сверки');
   await inventoryOutbox.recoveryArchives.add({approvalId:approval.approvalId,scopeKey,epoch:packet.lastReviewedEpoch,evidence:packet,approval,archivedAt:Date.now()});
   const held={state:'review' as const,requiresStreamReview:true,recoveryApprovalId:approval.approvalId,error:'history_reconciliation_required'};
   await inventoryOutbox.operations.where('scopeKey').equals(scopeKey).and(row=>row.state==='pending').modify(held);
   await inventoryOutbox.stockOperations.where('scopeKey').equals(scopeKey).and(row=>row.state==='pending').modify(held);
   await inventoryOutbox.stocks.where('scopeKey').equals(scopeKey).delete();
   await inventoryOutbox.history.where('scopeKey').equals(scopeKey).delete();
   await inventoryOutbox.metadata.put({key:scopeKey+':cursor',value:0});
   await inventoryOutbox.streams.put({scopeKey,epoch:stream.epoch});
  });
  await invalidateInventoryOfflineViews();
  return {...stream,approvalId:approval.approvalId};
 });
}

/** Archived evidence remains downloadable after the active read cache has been rebuilt. */
export async function latestInventoryRecoveryArchive(session:HybridSession,scope:InventoryScope){
 await loadWarehouseAccess(session,scope);
 const rows=await inventoryOutbox.recoveryArchives.where('scopeKey').equals(inventoryScopeKey(scope)).sortBy('archivedAt');
 const archive=rows[rows.length-1];if(!archive)throw Error('Архив сверки ещё не создан');return archive.evidence;
}
