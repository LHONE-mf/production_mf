import type {HybridSession} from './hybridClient';
import {
  inventoryOutbox,inventoryScopeKey,validateInventoryStock,
  type InventoryScope,type InventoryStockSnapshot,
} from './inventoryOutbox';

/**
 * Offline stock changes are only PROPOSALS. This queue NEVER changes confirmed
 * stock, reservations or QA status. The server alone decides whether to commit.
 * There is deliberately no automatic synchronization or conflict auto-rebase.
 */
interface Common {
  stockId:string;expectedRevision:number;quantity:number;reason:string;
}
export type InventoryStockChangeDraft =
  | (Common & {kind:'transfer';toLocationId:string})
  | (Common & {kind:'adjust';adjustment:'increase'|'decrease'})
  | (Common & {kind:'reserve'|'release_reservation';
      reservationId:string;productionBatchId:string});
type Wire<T> = T extends unknown
  ? Omit<T,'stockId'> & {operationId:string;deviceId:string}
  : never;
export type InventoryStockChangeRequest=Wire<InventoryStockChangeDraft>;
export interface QueuedInventoryStockChange {
  operationId:string;scopeKey:string;stockId:string;
  request:InventoryStockChangeRequest;
  /** Frozen confirmed snapshot used for exact server-ack verification. */
  base:InventoryStockSnapshot;
  queuedAt:number;
  state:'pending'|'conflict'|'rejected';
  error?:string;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positive=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
const text=(value:unknown,max:number)=>typeof value==='string'&&
  value.trim().length>0&&value.length<=max;

export function validateInventoryStockChangeDraft(draft:InventoryStockChangeDraft){
  if(!draft||typeof draft!=='object'||!uuid.test(draft.stockId)||
      !positive(draft.quantity)||!positive(draft.expectedRevision)||
      draft.expectedRevision>2147483646||!text(draft.reason,2000))
    throw new Error('Invalid provisional inventory stock operation');
  const common=['stockId','expectedRevision','quantity','reason','kind'];
  let extra:string[];
  switch(draft.kind){
    case 'transfer':
      if(!uuid.test(draft.toLocationId))throw new Error('Invalid destination');
      extra=['toLocationId'];break;
    case 'adjust':
      if(!['increase','decrease'].includes(draft.adjustment))
        throw new Error('Invalid correction direction');
      extra=['adjustment'];break;
    case 'reserve':
    case 'release_reservation':
      if(!uuid.test(draft.reservationId)||!uuid.test(draft.productionBatchId))
        throw new Error('Invalid stock reservation identity');
      extra=['reservationId','productionBatchId'];break;
    default:throw new Error('Unsupported inventory stock operation');
  }
  if(Object.keys(draft).some(k=>![...common,...extra].includes(k)))
    throw new Error('Unknown inventory stock operation fields');
}
export function validateChangeAgainstConfirmed(
  base:InventoryStockSnapshot,draft:InventoryStockChangeDraft,
){
  validateInventoryStock(base);
  if(base.stockId!==draft.stockId||base.revision!==draft.expectedRevision)
    throw new Error('Stock changed since the last confirmed version');
  const available=base.onHand-base.reserved;
  switch(draft.kind){
    case 'transfer':
      if(draft.toLocationId===base.locationId||draft.quantity!==base.onHand||
          base.reserved!==0)
        throw new Error('Only a whole unreserved container may move');
      break;
    case 'adjust':
      if(draft.adjustment==='decrease'&&draft.quantity>available)
        throw new Error('Correction cannot consume reserved or absent stock');
      if(draft.adjustment==='increase'&&!Number.isSafeInteger(base.onHand+draft.quantity))
        throw new Error('Unsafe stock quantity');
      break;
    case 'reserve':
      if(base.quality!=='released'||draft.quantity>available)
        throw new Error('Material is not released or available for reservation');
      break;
    case 'release_reservation':
      // Exact reservation ownership is only known to the server.
      if(draft.quantity>base.reserved)
        throw new Error('Insufficient aggregate reservation');
      break;
  }
}
export async function queueInventoryStockChange(
  session:HybridSession,scope:InventoryScope,draft:InventoryStockChangeDraft,
):Promise<string>{
  const scopeKey=inventoryScopeKey(scope);
  if(new URL(session.serverUrl).origin!==new URL(scope.serverUrl).origin||
      session.deviceProofDeviceId!==scope.deviceId)
    throw new Error('Inventory session device or server mismatch');
  if((session.offlineEditExpiresAt??0)<=Date.now()&&
      (session.deviceProofExpiresAt??0)<=Date.now())
    throw new Error('An unexpired server-provisioned offline window is required');
  validateInventoryStockChangeDraft(draft);
  const {stockId,...fields}=draft;
  const operationId=crypto.randomUUID();
  const request={...fields,operationId,deviceId:scope.deviceId} as InventoryStockChangeRequest;
  await inventoryOutbox.transaction('rw',inventoryOutbox.stocks,inventoryOutbox.stockOperations,async()=>{
    const base=await inventoryOutbox.stocks.get([scopeKey,stockId]);
    if(!base)throw new Error('Confirmed stock must be loaded before an offline change');
    validateChangeAgainstConfirmed(base,draft);
    // A second local proposal based on the same confirmed row would have
    // ambiguous physical ordering. Require resolution/sync before queuing it.
    const other=await inventoryOutbox.stockOperations
      .where('[scopeKey+stockId]').equals([scopeKey,stockId]).first();
    if(other)throw new Error('Resolve the existing provisional stock operation first');
    await inventoryOutbox.stockOperations.add({
      operationId,scopeKey,stockId,request,base:{...base},queuedAt:Date.now(),
      state:'pending',
    });
  });
  return operationId;
}
export async function inventoryStockQueueForScope(scope:InventoryScope){
  const scopeKey=inventoryScopeKey(scope);
  return (await inventoryOutbox.stockOperations.where('scopeKey').equals(scopeKey).toArray())
    .sort((a,b)=>a.queuedAt-b.queuedAt||a.operationId.localeCompare(b.operationId));
}
