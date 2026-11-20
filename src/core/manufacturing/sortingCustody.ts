import {db} from '../db';
import type {CutRun, ElectrodeShape} from '../types';
import {copyCutOutputHandoffRead, type CutOutputHandoffRead} from '../sync/cuttingOutputTypes';
import {inventoryScopeKey, type InventoryScope} from '../sync/inventoryOutbox';

const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
const invalid = ():never => { throw Error('Подтверждённая приёмка Cutting не соответствует источнику сортировки'); };

/** Existing local Cutting journals remain separate from a server-confirmed piece receipt. */
export function validateReceivedCuttingSource(source:CutRun):void {
 const binding=source.receivedCustody;
 if(!binding)return;
 if(binding.kind!=='server-confirmed-cutting-receipt' ||
    typeof binding.scopeKey!=='string'||!binding.scopeKey.trim()||
    typeof binding.localActorId!=='string'||!binding.localActorId.trim()||
    !['strip','prismatic'].includes(source.electrodeType))
   invalid();
 const checked=copyCutOutputHandoffRead(binding.snapshot),receipt=checked.received;
 if(!receipt||!checked.eligible||receipt.actorId!==checked.handoff.recipientId||
    receipt.observedQuantity<=0||
    source.id!=='received:'+receipt.operationId||
    binding.receiptId!==receipt.operationId||
    binding.handoffId!==checked.operationId||
    binding.sourceLotId!==checked.handoff.outputLotId||
    binding.count!==receipt.observedQuantity||
    binding.label!==receipt.observedLotLabel||
    binding.receivedAt!==receipt.recordedAt||
    source.incomingId!==receipt.observedLotLabel||
    source.goodCount!==receipt.observedQuantity||
    source.defectCount!==null||
    source.workerId!==binding.localActorId||
    source.createdAt!==Date.parse(receipt.recordedAt)||
    source.updatedAt!==source.createdAt)
   invalid();
}

/** Explicit user-selected electrode geometry: a server lot does not encode it. */
export function prepareReceivedCuttingSource(
 raw:CutOutputHandoffRead,scope:InventoryScope,localActorId:string,
 electrodeType:ElectrodeShape,
):CutRun {
 const snapshot=copyCutOutputHandoffRead(raw),receipt=snapshot.received;
 if(!receipt||!snapshot.eligible||receipt.actorId!==scope.actorId||
    snapshot.handoff.recipientId!==scope.actorId||
    !['strip','prismatic'].includes(electrodeType)||
    !localActorId?.trim()||receipt.observedQuantity<=0)
  throw Error('Нужна актуальная подтверждённая приёмка, её получатель и выбранная форма электрода');
 const receivedAt=Date.parse(receipt.recordedAt);
 const source:CutRun={
  id:'received:'+receipt.operationId,
  incomingId:receipt.observedLotLabel,
  electrodeType,
  goodCount:receipt.observedQuantity,
  defectCount:null, // Not zero. Cutting rejects were not measured at Sorting.
  workerId:localActorId,
  createdAt:receivedAt,
  updatedAt:receivedAt,
  receivedCustody:{
   kind:'server-confirmed-cutting-receipt',
   scopeKey:inventoryScopeKey(scope),
   localActorId,
   receiptId:receipt.operationId,
   handoffId:snapshot.operationId,
   sourceLotId:snapshot.handoff.outputLotId,
   count:receipt.observedQuantity,
   label:receipt.observedLotLabel,
   receivedAt:receipt.recordedAt,
   snapshot,
  },
 };
 validateReceivedCuttingSource(source);
 return source;
}

/** Exact same receipt retries are idempotent; no hidden replacement or stock posting. */
export async function saveReceivedCuttingSource(
 raw:CutOutputHandoffRead,scope:InventoryScope,localActorId:string,
 electrodeType:ElectrodeShape,
):Promise<CutRun> {
 const source=prepareReceivedCuttingSource(raw,scope,localActorId,electrodeType);
 return db.transaction('rw',db.cuttingRuns,db.users,async()=>{
  const user=await db.users.get(localActorId);
  if(!user?.isActive)throw Error('Активный локальный профиль необходим для записи источника');
  const previous=await db.cuttingRuns.get(source.id);
  if(previous){
   if(same(previous,source))return previous;
   throw Error('Приёмка уже закреплена с другой формой или источником; исходная запись сохранена');
  }
  await db.cuttingRuns.add(source);
  return source;
 });
}
