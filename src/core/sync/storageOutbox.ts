import Dexie,{type Table} from 'dexie';
import { requireFreshDeviceProof } from './deviceProofClient';
import type { ServerConnection } from './serverConnection';

export type StorageCommandKind =
  'material'|'location'|'receipt'|'release'|'issue'|'move'|'reconcile'|'warehouse_manager';
export type StorageOperationState='pending'|'accepted'|'conflict'|'rejected';
export interface StorageQueuedOperation {
  operationId:string;
  organizationId:string;
  actorId:string;
  deviceId:string;
  kind:StorageCommandKind;
  path:string;
  payload:Record<string,unknown>&{operationId:string;deviceId:string};
  queuedAt:number;
  state:StorageOperationState;
  serverResponse?:Record<string,unknown>;
  error?:string;
  acknowledgedAt?:number;
}
class StorageOutboxDb extends Dexie {
  operations!:Table<StorageQueuedOperation,string>;
  constructor() {
    super('ProductionMfStorageOutbox');
    this.version(1).stores({operations:'operationId, [organizationId+actorId+deviceId], state, queuedAt'});
  }
}
export const storageOutbox=new StorageOutboxDb();

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertPath(kind:StorageCommandKind,path:string) {
  const exact:{[K in StorageCommandKind]?:string}={
    material:'/storage/materials',location:'/storage/locations',receipt:'/storage/receipts',
    warehouse_manager:'/storage/warehouse-managers',
  };
  if(exact[kind]) {
    if(exact[kind]!==path)throw Error('Неверный путь складской операции');
    return;
  }
  const parsed=/^\/storage\/stock\/([0-9a-f-]{36})\/(release|issue|move|reconcile)$/.exec(path);
  if(!parsed||!uuidPattern.test(parsed[1])||parsed[2]!==kind)
    throw Error('Неверная идентичность складской операции');
}
function assertScope(connection:ServerConnection,op:StorageQueuedOperation) {
  if(connection.organizationId!==op.organizationId ||
    connection.serverActorId!==op.actorId ||
    connection.selectedDeviceId!==op.deviceId)
    throw Error('Операция принадлежит другому серверному сотруднику, организации или устройству');
}
function endpoint(origin:string,path:string) {
  const url=new URL(origin);
  if(url.protocol!=='https:' &&
    !(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))
    throw Error('Для складского сервера требуется HTTPS');
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw Error('Адрес склада должен содержать только адрес сервера');
  return new URL(path,url).toString();
}
function sessionHeaders(connection:ServerConnection) {
  const proof=requireFreshDeviceProof(connection.session);
  if(proof.deviceId!==connection.selectedDeviceId)
    throw Error('Подтверждение устройства не совпадает с выбранным устройством');
  return {Authorization:'Bearer '+connection.session.accessToken,
    'x-device-proof':proof.token,'Content-Type':'application/json'};
}
/** Store exact intent before attempting any network request. Never include bearer tokens. */
export async function queueStorageCommand(connection:ServerConnection,kind:StorageCommandKind,
  path:string,payload:StorageQueuedOperation['payload']) {
  assertPath(kind,path);
  if(!uuidPattern.test(payload.operationId)||
    payload.deviceId!==connection.selectedDeviceId||
    !uuidPattern.test(payload.deviceId))
    throw Error('ID операции и устройства должны быть постоянными UUID');
  const op:StorageQueuedOperation={
    operationId:payload.operationId,organizationId:connection.organizationId,
    actorId:connection.serverActorId,deviceId:connection.selectedDeviceId,
    kind,path,payload,queuedAt:Date.now(),state:'pending',
  };
  await storageOutbox.operations.add(op);
  return op;
}
function verifyAcknowledgement(op:StorageQueuedOperation,response:unknown) {
  if(!response||typeof response!=='object')throw Error('Ответ сервера склада повреждён');
  const body=response as Record<string,unknown>;
  if(typeof body.alreadyRecorded!=='boolean')
    throw Error('Ответ сервера не содержит подтверждения транзакции');
  const expected=op.kind==='material'||op.kind==='location'
    ? op.payload.id
    : op.kind==='receipt'?op.payload.receiptId
    : op.kind==='warehouse_manager'?op.payload.userId
    : op.kind==='move'?op.payload.destinationStockUnitId
    : op.path.split('/')[3];
  const actual=op.kind==='material'||op.kind==='location'?body.id
    :op.kind==='receipt'?body.receiptId
    :op.kind==='warehouse_manager'?body.userId
    :op.kind==='move'?body.destinationStockUnitId
    :body.stockUnitId;
  if(actual!==expected||typeof actual!=='string')
    throw Error('Ответ сервера не совпадает с отправленной транзакцией');
  if(op.kind==='receipt'&&body.stockUnitId!==op.payload.stockUnitId)
    throw Error('Сервер подтвердил другой контейнер');
  if(op.kind==='move'&&body.sourceStockUnitId!==op.path.split('/')[3])
    throw Error('Сервер подтвердил другой исходный контейнер');
  if(['release','issue','move','reconcile'].includes(op.kind)&&
    (!Number.isSafeInteger(body.revision??body.sourceRevision)||Number(body.revision??body.sourceRevision)<=0))
    throw Error('Ответ сервера не содержит достоверной версии остатка');
  return body;
}
async function mark(op:StorageQueuedOperation,patch:Partial<StorageQueuedOperation>) {
  await storageOutbox.transaction('rw',storageOutbox.operations,async()=>{
    const current=await storageOutbox.operations.get(op.operationId);
    if(!current||current.state!=='pending'||
      current.organizationId!==op.organizationId||current.actorId!==op.actorId||
      current.deviceId!==op.deviceId||current.kind!==op.kind||current.path!==op.path||
      JSON.stringify(current.payload)!==JSON.stringify(op.payload))
      throw Error('Очередь изменилась во время ответа; исходное действие сохранено');
    await storageOutbox.operations.update(op.operationId,patch);
  });
}
export async function pushStorageOperation(connection:ServerConnection,operationId:string) {
  const op=await storageOutbox.operations.get(operationId);
  if(!op)throw Error('Складская операция не найдена');
  assertScope(connection,op);
  assertPath(op.kind,op.path);
  if(op.state!=='pending')return {state:op.state,alreadySent:true};
  const response=await fetch(endpoint(connection.serverUrl,op.path),{
    method:'POST',headers:sessionHeaders(connection),body:JSON.stringify(op.payload),
  });
  if(response.status===401||response.status===403&&response.headers.get('content-type')===null)
    throw Error('Сессия/подтверждение устройства недействительно; очередь сохранена');
  let json:unknown;
  try {json=await response.json();}catch{
    throw Error('Невозможно проверить ответ сервера; очередь сохранена');
  }
  if((response.status===201||response.status===200)&&response.ok) {
    const confirmed=verifyAcknowledgement(op,json);
    await mark(op,{state:'accepted',serverResponse:confirmed,acknowledgedAt:Date.now(),error:undefined});
    return {state:'accepted' as const,alreadySent:confirmed.alreadyRecorded};
  }
  const error=json&&typeof json==='object'&&'error' in json&&typeof (json as {error:unknown}).error==='string'
    ?(json as {error:string}).error:'http_'+response.status;
  if(response.status===409) {
    await mark(op,{state:'conflict',error});
    return {state:'conflict' as const,error};
  }
  if(response.status===400||response.status===404||response.status===403&&error==='forbidden') {
    await mark(op,{state:'rejected',error});
    return {state:'rejected' as const,error};
  }
  // Network, 5xx, auth/proof expiry and malformed replies never discard intent.
  throw Error('Складской сервер недоступен: '+error+'; очередь сохранена');
}
export async function pushPendingStorage(connection:ServerConnection,limit=10) {
  const all=await storageOutbox.operations.where('state').equals('pending').sortBy('queuedAt');
  const own=all.filter(op=>op.organizationId===connection.organizationId &&
    op.actorId===connection.serverActorId && op.deviceId===connection.selectedDeviceId);
  let accepted=0,conflicts=0,rejected=0;
  for(const op of own.slice(0,limit)) {
    const result=await pushStorageOperation(connection,op.operationId);
    if(result.state==='accepted')accepted++;
    else if(result.state==='conflict')conflicts++;
    else if(result.state==='rejected')rejected++;
  }
  return {accepted,conflicts,rejected,pending:Math.max(0,own.length-Math.min(limit,own.length))};
}
export async function readStoragePage<T>(connection:ServerConnection,
  segment:'materials'|'locations'|'stock',after?:string):Promise<{items:T[];hasMore:boolean;nextAfter:string|null}> {
  const path='/storage/'+segment+'?deviceId='+encodeURIComponent(connection.selectedDeviceId)+
    (after?'&after='+encodeURIComponent(after):'');
  const response=await fetch(endpoint(connection.serverUrl,path),{
    headers:sessionHeaders(connection),
  });
  if(!response.ok)throw Error('Не удалось обновить склад: HTTP '+response.status);
  const data=await response.json();
  if(!data||!Array.isArray(data.items)||data.items.length>100||
    typeof data.hasMore!=='boolean'||
    (data.nextAfter!==null&&typeof data.nextAfter!=='string'))
    throw Error('Ответ реестра склада повреждён');
  if(data.hasMore && (!data.items.length||!data.nextAfter))
    throw Error('Неверная страница складского реестра');
  return data;
}
export async function readStorageCapabilities(connection:ServerConnection):Promise<{
  canManageCatalog:boolean;canRelease:boolean;canMoveIssue:boolean;canReconcile:boolean;
}> {
  const path='/storage/capabilities?deviceId='+encodeURIComponent(connection.selectedDeviceId);
  const response=await fetch(endpoint(connection.serverUrl,path),{headers:sessionHeaders(connection)});
  if(!response.ok)throw Error('Не удалось проверить права склада: HTTP '+response.status);
  const body=await response.json();
  if(body.actorId!==connection.serverActorId||body.organizationId!==connection.organizationId||
    !['canManageCatalog','canRelease','canMoveIssue','canReconcile']
      .every(k=>typeof body[k]==='boolean'))
    throw Error('Права доступа склада не подтверждены сервером');
  return body;
}
