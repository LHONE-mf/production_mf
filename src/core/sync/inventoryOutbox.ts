import Dexie, {type Table} from 'dexie';
import type {HybridSession} from './hybridClient';
import type {QueuedInventoryStockChange} from './inventoryStockOutbox';

/**
 * Independent, opt-in inventory queue. Existing local Storage history and the
 * task outbox must not be rewritten or silently promoted into confirmed stock.
 * No bearer token or device proof is persisted in this database.
 */
export interface InventoryScope {
  serverUrl: string;
  organizationId: string;
  actorId: string;
  deviceId: string;
}
export interface InventoryReceiptRequest {
  operationId: string;
  deviceId: string;
  stockId: string;
  materialId: string;
  locationId: string;
  manufacturerLot: string;
  quantity: number;
  expectedRevision: 0;
  reason: string;
  supplier?: string;
  receiptReference?: string;
}
export interface InventoryStockSnapshot {
  stockId: string;materialId: string;manufacturerLot: string;
  unit: 'mg'|'ul'|'mm'|'pieces';locationId: string;
  quality: 'quarantine'|'released'|'blocked';
  onHand: number;reserved: number;revision: number;available: number;
}
export interface QueuedInventoryReceipt {
  operationId: string;scopeKey: string;request: InventoryReceiptRequest;
  queuedAt: number;state: 'pending'|'conflict'|'rejected';error?: string;
}
export interface ConfirmedInventoryStock extends InventoryStockSnapshot {
  scopeKey: string;
}
interface InventorySyncMetadata {key:string;value:number;}

export class InventoryOutboxDatabase extends Dexie {
  operations!: Table<QueuedInventoryReceipt,string>;
  stocks!: Table<ConfirmedInventoryStock,[string,string]>;
  metadata!: Table<InventorySyncMetadata,string>;
  stockOperations!: Table<QueuedInventoryStockChange,string>;
  constructor(){
    super('ProductionMfInventoryOutbox');
    this.version(1).stores({
      operations:'operationId,scopeKey,state,queuedAt',
      stocks:'[scopeKey+stockId],scopeKey',
      metadata:'key',
    });
    // Additive migration: existing receipts, confirmed stocks and cursor stay intact.
    this.version(2).stores({
      stockOperations:'operationId,scopeKey,[scopeKey+stockId],stockId,state,queuedAt',
    });
  }
}
export const inventoryOutbox = new InventoryOutboxDatabase();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max;
const positive=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;

export function inventoryScopeKey(scope:InventoryScope):string{
  const origin=new URL(scope.serverUrl);
  if(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&
      ['localhost','127.0.0.1'].includes(origin.hostname)))
    throw new Error('Inventory server requires HTTPS outside localhost');
  if(origin.username||origin.password||origin.search||origin.hash||
      origin.pathname!=='/')
    throw new Error('Inventory server must be an origin without credentials or path');
  for(const key of ['organizationId','actorId','deviceId'] as const)
    if(!uuid.test(scope[key]))throw new Error('Invalid inventory '+key);
  return [origin.origin,scope.organizationId,scope.actorId,scope.deviceId].join('::');
}

export function validateInventoryStock(stock:unknown):asserts stock is InventoryStockSnapshot{
  if(!stock||typeof stock!=='object')throw new Error('Invalid inventory stock');
  const s=stock as InventoryStockSnapshot;
  if(!uuid.test(s.stockId)||!uuid.test(s.materialId)||!uuid.test(s.locationId)||
      !text(s.manufacturerLot,200)||!['mg','ul','mm','pieces'].includes(s.unit)||
      !['quarantine','released','blocked'].includes(s.quality)||
      !Number.isSafeInteger(s.onHand)||s.onHand<0||!Number.isSafeInteger(s.reserved)||
      s.reserved<0||s.reserved>s.onHand||!positive(s.revision)||
      s.available!==s.onHand-s.reserved)
    throw new Error('Invalid inventory stock');
}

/** Queue a provisional receipt only for a known server session and device. */
export async function queueInventoryReceipt(
  session:HybridSession,scope:InventoryScope,
  draft:Omit<InventoryReceiptRequest,'operationId'|'deviceId'>,
):Promise<string>{
  const scopeKey=inventoryScopeKey(scope);
  if(new URL(session.serverUrl).origin!==new URL(scope.serverUrl).origin||
      session.deviceProofDeviceId!==scope.deviceId)
    throw new Error('Inventory session device or server mismatch');
  if((session.offlineEditExpiresAt??0)<=Date.now()&&
      (session.deviceProofExpiresAt??0)<=Date.now())
    throw new Error('A current server-provisioned offline editing window is required');
  if(!uuid.test(draft.stockId)||!uuid.test(draft.materialId)||!uuid.test(draft.locationId)||
      !text(draft.manufacturerLot,200)||!text(draft.reason,2000)||
      !positive(draft.quantity)||draft.expectedRevision!==0||
      (draft.supplier!==undefined&&!text(draft.supplier,200))||
      (draft.receiptReference!==undefined&&!text(draft.receiptReference,200)))
    throw new Error('Invalid provisional receipt');
  const operationId=crypto.randomUUID();
  const request:InventoryReceiptRequest={
    ...draft,operationId,deviceId:scope.deviceId,
  };
  await inventoryOutbox.operations.add({
    operationId,scopeKey,request,queuedAt:Date.now(),state:'pending',
  });
  return operationId;
}
export async function inventoryQueueForScope(scope:InventoryScope){
  const scopeKey=inventoryScopeKey(scope);
  return (await inventoryOutbox.operations.where('scopeKey').equals(scopeKey).toArray())
    .sort((a,b)=>a.queuedAt-b.queuedAt||a.operationId.localeCompare(b.operationId));
}
export async function confirmedInventoryForScope(scope:InventoryScope){
  const scopeKey=inventoryScopeKey(scope);
  return inventoryOutbox.stocks.where('scopeKey').equals(scopeKey).toArray();
}
