import {inventoryOutbox,inventoryScopeKey,inventoryQueueForScope,type InventoryScope,
 type InventoryReceiptRequest,type LocalUnboundReceipt} from './inventoryOutbox';
import {loadWarehouseAccess,loadInventoryMaterials,loadInventoryLocations,inventoryLocationPath,
 type InventoryMaterial,type InventoryLocation} from './inventoryCatalogClient';
import {toInventoryBaseUnits} from './inventoryReceiving';
import {pushInventoryReceipts} from './inventoryClient';
import {requireFreshDeviceProof} from './deviceProofClient';
import {getServerConnection,type ServerConnection} from './serverConnection';
import {useAuthStore,currentLocalSession} from '../store/authStore';

export interface LocalReceiptFields {
 materialCode:string;locationPath:string;manufacturerLot:string;
 quantity:string;unit:string;reason:string;receiptReference:string;supplier:string;
}
const nonempty=(s:string,max:number)=>!!s.trim()&&s.length<=max;
const normalized=(s:string)=>s.trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU');
const allowedUnits=['mg','g','kg','ul','ml','L','mm','m','pieces','rolls'];
const pendingStates=['pending','needs_review'];

/** Save a locally observed physical package. No server contact or guessed stock. */
export async function saveUnboundReceipt(localActorId:string,fields:LocalReceiptFields):Promise<LocalUnboundReceipt>{
 const actor=useAuthStore.getState();
 if(!localActorId||actor.currentUser?.id!==localActorId||!actor.currentUser.isActive||
    !currentLocalSession(actor.session)||actor.session?.userId!==localActorId)
  throw Error('Для записи поступления нужен действующий локальный профиль');
 if(!nonempty(fields.materialCode,200)||!nonempty(fields.locationPath,300)||
    !nonempty(fields.manufacturerLot,200)||!nonempty(fields.reason,2000)||
    !nonempty(fields.receiptReference,200)||!allowedUnits.includes(fields.unit)||
    !nonempty(fields.quantity,30)||fields.supplier.length>200)
  throw Error('Укажите материал (код или точное имя), место, партию, количество, единицу, документ и основание');
 // Validate decimal spelling now, but convert only once a server material's
 // authoritative base unit is known. No floating-point rounding.
 if(!/^\d{1,16}(?:[.,]\d{1,9})?$/.test(fields.quantity.trim())||
    !Number.isFinite(Number(fields.quantity.replace(',','.')))||
    Number(fields.quantity.replace(',','.'))<=0)
  throw Error('Количество должно быть положительным числом');
 const row:LocalUnboundReceipt={
  operationId:crypto.randomUUID(),stockId:crypto.randomUUID(),
  localActorId,recordedAt:Date.now(),
  materialCode:fields.materialCode.trim(),locationPath:fields.locationPath.trim(),
  manufacturerLot:fields.manufacturerLot.trim(),quantity:fields.quantity.trim(),unit:fields.unit,
  reason:fields.reason.trim(),receiptReference:fields.receiptReference.trim(),
  supplier:fields.supplier.trim(),state:'pending',
 };
 await inventoryOutbox.localReceipts.add(row);
 return row;
}

export async function localReceiptsForUser(localActorId:string){
 return (await inventoryOutbox.localReceipts.where('localActorId').equals(localActorId).toArray())
  .sort((a,b)=>b.recordedAt-a.recordedAt||a.operationId.localeCompare(b.operationId));
}
/** Only correct SERVER CATALOG MATCHING, never the physical quantity or original evidence. */
export async function correctUnboundReceiptMatch(
 localActorId:string,operationId:string,materialCode:string,locationPath:string,
):Promise<void>{
 const actor=useAuthStore.getState();
 if(actor.currentUser?.id!==localActorId||!actor.currentUser.isActive||
    !currentLocalSession(actor.session)||actor.session?.userId!==localActorId)
  throw Error('Требуется локальный профиль автора');
 if(!nonempty(materialCode,200)||!nonempty(locationPath,300))
  throw Error('Укажите точный серверный код материала и путь места хранения');
 await inventoryOutbox.transaction('rw',inventoryOutbox.localReceipts,async()=>{
  const row=await inventoryOutbox.localReceipts.get(operationId);
  if(!row||row.localActorId!==localActorId||row.boundScopeKey||
      !pendingStates.includes(row.state))throw Error('Операция уже привязана к серверу или не принадлежит пользователю');
  await inventoryOutbox.localReceipts.put({...row,matchMaterialCode:materialCode.trim(),
   matchLocationPath:locationPath.trim(),matchReviewedAt:Date.now(),state:'pending',error:undefined});
 });
}
function checkIdentity(localActorId:string,connection:ServerConnection){
 const state=useAuthStore.getState();
 if(state.currentUser?.id!==localActorId||!state.currentUser.isActive||
    !currentLocalSession(state.session)||state.session?.userId!==localActorId||
    getServerConnection()!==connection)
  throw Error('Локальный пользователь или серверное подключение изменились. Очередь сохранена.');
}
async function catalogue<T>(
 load:(session:ServerConnection['session'],scope:InventoryScope,after?:string,limit?:number)=>Promise<{items:T[];hasMore:boolean;nextAfter:string|null}>,
 connection:ServerConnection,scope:InventoryScope,
){
 const result:T[]=[];let after:string|undefined;
 for(let page=0;page<100;page++){
  const next=await load(connection.session,scope,after,100);
  result.push(...next.items);
  if(!next.hasMore)return result;
  if(!next.nextAfter)throw Error('Некорректный курсор справочника склада');
  after=next.nextAfter;
 }
 throw Error('Справочник слишком большой; автоматическая привязка отложена');
}
function selectMaterial(receipt:LocalUnboundReceipt,materials:InventoryMaterial[]){
 const key=normalized(receipt.matchMaterialCode??receipt.materialCode);
 const eligible=materials.filter(material=>material.active!==false&&
  ['raw_material','component','cell'].includes(material.category));
 const codes=eligible.filter(material=>normalized(material.code)===key);
 // Exact manufacturer/server code has precedence over a coincidental name.
 const matches=codes.length?codes:eligible.filter(material=>normalized(material.name)===key);
 if(matches.length!==1)throw Error(matches.length
  ?'Найдено несколько материалов. Нужна ручная сверка с серверным справочником.'
  :'Материал не найден в серверном справочнике. Уточните код или создайте материал.');
 return matches[0];
}
function selectLocation(receipt:LocalUnboundReceipt,locations:InventoryLocation[]){
 const key=normalized(receipt.matchLocationPath??receipt.locationPath);
 const matches=locations.filter(place=>place.active&&
  (normalized(inventoryLocationPath(locations,place.id))===key||
   normalized(place.label)===key));
 if(matches.length!==1)throw Error(matches.length
  ?'Место неоднозначно. Для синхронизации нужен полный путь места.'
  :'Место не найдено в серверном справочнике.');
 return matches[0];
}

const active=new Map<string,Promise<void>>();
/** Automatic once a user explicitly establishes a verified server session.
 * Never promote old historical storage journal observations, nor decide QA.
 * A failed ACK retains the original body and ID for the next reconnect. */
export function autoSyncLocalReceipts(connection:ServerConnection,localActorId:string):Promise<void>{
 const scope:InventoryScope={serverUrl:connection.serverUrl,organizationId:connection.organizationId,
  actorId:connection.serverActorId,deviceId:connection.selectedDeviceId};
 const scopeKey=inventoryScopeKey(scope),guard=JSON.stringify([scopeKey,localActorId]);
 const previous=active.get(guard);if(previous)return previous;
 const work=syncOnce(connection,scope,scopeKey,localActorId).finally(()=>{active.delete(guard);});
 active.set(guard,work);return work;
}
async function syncOnce(connection:ServerConnection,scope:InventoryScope,scopeKey:string,localActorId:string){
 checkIdentity(localActorId,connection);
 const candidates=(await localReceiptsForUser(localActorId)).filter(row=>row.state!=='confirmed');
 if(!candidates.length)return;
 if(requireFreshDeviceProof(connection.session).deviceId!==scope.deviceId)
  throw Error('Требуется повторно подтвердить устройство');
 const access=await loadWarehouseAccess(connection.session,scope);
 if(!access.canRecordReceipts)throw Error('У пользователя нет права приёмки');
 const unresolved=candidates.filter(row=>pendingStates.includes(row.state)&&!row.boundScopeKey);
 let materials:InventoryMaterial[]=[],locations:InventoryLocation[]=[];
 if(unresolved.length){
  [materials,locations]=await Promise.all([
   catalogue(loadInventoryMaterials,connection,scope),
   catalogue(loadInventoryLocations,connection,scope),
  ]);
 }
 checkIdentity(localActorId,connection);
 for(const row of unresolved){
  // One unmatched row must not prevent independent valid receipts from syncing.
  try{
   const material=selectMaterial(row,materials),location=selectLocation(row,locations);
   const quantity=toInventoryBaseUnits(row.quantity,row.unit,material.baseUnit);
   const request:InventoryReceiptRequest={operationId:row.operationId,stockId:row.stockId,
    deviceId:scope.deviceId,materialId:material.id,locationId:location.id,
    manufacturerLot:row.manufacturerLot,quantity,expectedRevision:0,
    reason:row.reason,receiptReference:row.receiptReference,
    ...(row.supplier?{supplier:row.supplier}:{}),
   };
   checkIdentity(localActorId,connection);
   await inventoryOutbox.transaction('rw',inventoryOutbox.localReceipts,inventoryOutbox.operations,async()=>{
    const saved=await inventoryOutbox.localReceipts.get(row.operationId);
    if(!saved||JSON.stringify(saved)!==JSON.stringify(row))throw Error('Локальная запись изменилась; требуется проверка');
    if(await inventoryOutbox.operations.get(row.operationId))throw Error('Операция уже существует в очереди');
    await inventoryOutbox.operations.add({operationId:row.operationId,scopeKey,request,queuedAt:Date.now(),state:'pending'});
    await inventoryOutbox.localReceipts.put({...row,state:'queued',boundScopeKey:scopeKey,error:undefined});
   });
  }catch(cause){
   const reason=cause instanceof Error?cause.message:String(cause);
   await inventoryOutbox.transaction('rw',inventoryOutbox.localReceipts,async()=>{
    const saved=await inventoryOutbox.localReceipts.get(row.operationId);
    if(saved&&saved.state!=='queued'&&saved.state!=='confirmed')
     await inventoryOutbox.localReceipts.update(row.operationId,{state:'needs_review',error:reason});
   });
  }
 }
 checkIdentity(localActorId,connection);
 const bound=(await localReceiptsForUser(localActorId)).filter(row=>row.boundScopeKey===scopeKey&&row.state==='queued');
 if(!bound.length)return;
 // Do not silently post another local user's or legacy manual queue entries.
 const pending=(await inventoryQueueForScope(scope)).filter(item=>item.state==='pending');
 const ourIds=new Set(bound.map(row=>row.operationId));
 if(pending.some(row=>!ourIds.has(row.operationId)))throw Error('Есть другие ожидающие складские операции: автоматическая отправка отложена до ручной сверки');
 if(pending.length)await pushInventoryReceipts(connection.session,scope,20);
 checkIdentity(localActorId,connection);
 for(const row of bound){
  const ack=await inventoryOutbox.acknowledgements.get(row.operationId);
  if(!ack)continue;
  if(ack.scopeKey!==scopeKey||ack.kind!=='receive'||
     ack.stockId!==row.stockId||ack.request.operationId!==row.operationId)
   throw Error('Подтверждение сервера не совпадает с локальной записью');
  await inventoryOutbox.localReceipts.update(row.operationId,{state:'confirmed',error:undefined});
 }
}
