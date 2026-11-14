import type{HybridSession}from'./hybridClient';
import{inventoryOutbox,inventoryScopeKey,type InventoryScope}from'./inventoryOutbox';
import{loadWarehouseAccess}from'./inventoryCatalogClient';
/** Read-only evidence for reconciliation. It is never an import or posting authority. */
export async function inventoryRecoveryEvidence(session:HybridSession,scope:InventoryScope,localActorId:string){
 await loadWarehouseAccess(session,scope);
 const scopeKey=inventoryScopeKey(scope);
 return inventoryOutbox.transaction('r',[inventoryOutbox.operations,inventoryOutbox.stockOperations,inventoryOutbox.acknowledgements,inventoryOutbox.receivingDrafts,inventoryOutbox.streams],async()=>{
  const receipts=await inventoryOutbox.operations.where('scopeKey').equals(scopeKey).toArray();
  const stockChanges=await inventoryOutbox.stockOperations.where('scopeKey').equals(scopeKey).toArray();
  const acknowledgements=await inventoryOutbox.acknowledgements.where('scopeKey').equals(scopeKey).toArray();
  const drafts=await inventoryOutbox.receivingDrafts.filter(row=>{try{const key=JSON.parse(row.key);return key[0]===scopeKey&&key[1]===localActorId;}catch{return false;}}).toArray();
  const stream=await inventoryOutbox.streams.get(scopeKey);
  return{format:'production-mf-inventory-recovery-v1',generatedAt:new Date().toISOString(),scope:{serverUrl:new URL(scope.serverUrl).origin,organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId},lastReviewedEpoch:stream?.epoch??null,receipts,stockChanges,acknowledgements,drafts};
 });
}
