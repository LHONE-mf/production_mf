import type {InventoryRecoveryBundle,InventoryRecoveryApproval} from './inventoryRecovery';
import Dexie, {type Table} from 'dexie';
import type {InventoryOfflineView} from './inventoryOfflineView';
import type {HybridSession} from './hybridClient';
import type {QueuedInventoryStockChange,InventoryStockChangeRequest} from './inventoryStockOutbox';

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
  receiptReference?: string;expiresOn?:string;manufacturedOn?:string;
}
export interface InventoryStockSnapshot {
  stockId: string;materialId: string;manufacturerLot: string;
  unit: 'mg'|'ul'|'mm'|'pieces';locationId: string;
  quality: 'quarantine'|'released'|'blocked';
  onHand: number;reserved: number;revision: number;available: number;
  expiresAt?:string;manufacturedOn?:string;disposition?:'release'|'hold'|'block'|'reject';
}
export interface InventoryQualityRequest {operationId:string;stockId:string;deviceId:string;expectedRevision:number;disposition:'release'|'hold'|'block'|'reject';reason:string;evidence:string}
export interface QueuedInventoryReceipt {
  operationId: string;scopeKey: string;request: InventoryReceiptRequest;
  queuedAt: number;state: 'pending'|'conflict'|'rejected'|'review';recoveryApprovalId?:string;error?: string;requiresStreamReview?:boolean;
}
export interface ConfirmedInventoryStock extends InventoryStockSnapshot {
  scopeKey: string;
}
interface InventorySyncMetadata {key:string;value:number;}

export interface ReceivingDraft {key:string;revision:number;fields:Record<string,string>;operationId?:string}
export interface InventoryHistory {scopeKey:string;stockId:string;sequence:number;operationId:string;kind:string;stock:InventoryStockSnapshot;recordedAt:string;actorId?:string;deviceId?:string|null;reason?:string;quantity?:number}
export interface InventoryStreamState {scopeKey:string;epoch:string}
export interface InventoryAcknowledgement {operationId:string;scopeKey:string;epoch:string;kind:string;stockId:string;request:InventoryReceiptRequest|InventoryStockChangeRequest|InventoryQualityRequest;stock:InventoryStockSnapshot;base?:InventoryStockSnapshot;receivedAt:number}
export class InventoryOutboxDatabase extends Dexie {
  recoveryArchives!:Table<{approvalId:string;scopeKey:string;epoch:string|null;evidence:InventoryRecoveryBundle;approval:InventoryRecoveryApproval;archivedAt:number},string>;
  streams!:Table<InventoryStreamState,string>;
  acknowledgements!:Table<InventoryAcknowledgement,string>;
  offlineViews!:Table<InventoryOfflineView,string>;
  history!:Table<InventoryHistory,[string,number]>;
  receivingDrafts!:Table<ReceivingDraft,string>;
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
    this.version(3).stores({receivingDrafts:'key'});
    this.version(4).stores({history:'[scopeKey+sequence],scopeKey,[scopeKey+stockId]'});
    this.version(5).stores({offlineViews:'localActorId,scopeKey'});
    this.version(6).stores({streams:'scopeKey',acknowledgements:'operationId,scopeKey,epoch'}).upgrade(async tx=>{
      for(const name of ['operations','stockOperations'])await tx.table(name).where('state').equals('pending').modify({requiresStreamReview:true});
    });
    this.version(7).stores({recoveryArchives:'approvalId,scopeKey,epoch'});
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

export function validInventoryDate(value:unknown):value is string{
 return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='0001-01-01'&&value<'9999-12-31'&&Number.isFinite(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value;
}
export function inventoryExpiryAt(expiresOn:string){if(!validInventoryDate(expiresOn))throw Error('Invalid inventory expiry date');return new Date(Date.parse(expiresOn+'T00:00:00.000Z')+86400000).toISOString();}
export function sameInventoryStock(a:InventoryStockSnapshot,b:InventoryStockSnapshot){return (['stockId','materialId','manufacturerLot','locationId','unit','quality','onHand','reserved','revision','available','expiresAt','manufacturedOn','disposition'] as const).every(key=>a[key]===b[key]);}

export function validateInventoryStock(stock:unknown):asserts stock is InventoryStockSnapshot{
  if(!stock||typeof stock!=='object')throw new Error('Invalid inventory stock');
  const s=stock as InventoryStockSnapshot;
  if(!uuid.test(s.stockId)||!uuid.test(s.materialId)||!uuid.test(s.locationId)||
      !text(s.manufacturerLot,200)||!['mg','ul','mm','pieces'].includes(s.unit)||
      !['quarantine','released','blocked'].includes(s.quality)||
      !Number.isSafeInteger(s.onHand)||s.onHand<0||!Number.isSafeInteger(s.reserved)||
      s.reserved<0||s.reserved>s.onHand||!positive(s.revision)||
      s.available!==s.onHand-s.reserved||
      (s.expiresAt!==undefined&&(typeof s.expiresAt!=='string'||!Number.isFinite(Date.parse(s.expiresAt))||new Date(s.expiresAt).toISOString()!==s.expiresAt))||
      (s.manufacturedOn!==undefined&&!validInventoryDate(s.manufacturedOn))||
      (s.disposition!==undefined&&(!['release','hold','block','reject'].includes(s.disposition)||(s.disposition==='release'?s.quality!=='released':s.quality!=='blocked'))))
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
      (draft.receiptReference!==undefined&&!text(draft.receiptReference,200))||
      (draft.expiresOn!==undefined&&!validInventoryDate(draft.expiresOn))||
      (draft.manufacturedOn!==undefined&&!validInventoryDate(draft.manufacturedOn))||
      (draft.expiresOn&&draft.manufacturedOn&&draft.manufacturedOn>draft.expiresOn))
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

export const inventoryOfflineGenerationKey='inventory-offline-view-generation';
export function beginInventoryOfflineView():string|null{
 try{let generation=localStorage.getItem(inventoryOfflineGenerationKey);if(!generation||!uuid.test(generation)){generation=crypto.randomUUID();localStorage.setItem(inventoryOfflineGenerationKey,generation);}return generation;}catch{return null;}
}
/** Synchronous durable generation revocation also covers a failed IndexedDB clear. */
export function invalidateInventoryOfflineViews(){
 try{localStorage.removeItem(inventoryOfflineGenerationKey);}catch{/* Blocked localStorage also prevents restoring a view. */}
 return inventoryOutbox.offlineViews.clear().catch(()=>{});
}

/** Called inside the same transaction as projection and pending-row acknowledgement. */
export async function archiveInventoryAcknowledgement(record:InventoryAcknowledgement){
 const prior=await inventoryOutbox.acknowledgements.get(record.operationId);
 if(prior){const {receivedAt:_old,...old}=prior,{receivedAt:_new,...next}=record;if(JSON.stringify(old)!==JSON.stringify(next))throw Error('Conflicting retained inventory acknowledgement');}
 else await inventoryOutbox.acknowledgements.add(record);
}
