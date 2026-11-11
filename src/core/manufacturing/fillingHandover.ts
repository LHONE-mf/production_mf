import {db} from '../db';
import {StageId,UserRole,type AssemblyRun,type ElectrolyteIncoming,type ElectrolyteBox} from '../types';
import {assemblyOutputTables,CELL_OUTPUT_ROLES,validateAssemblyCellOutput,assertAssemblySerialAvailability} from './assemblyCellOutput';

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const time=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const text=(value:unknown)=>typeof value==='string'&&!!value.trim();
export const fillingStage=(box:ElectrolyteBox)=>box==='dry-room'?StageId.ELECTROLYTE:StageId.ELECTROLYTE_705;
export const hasFillingHandover=(row?:ElectrolyteIncoming)=>!!row&&(row.handover!==undefined||row.sourceAssembly!==undefined||row.receipt!==undefined);
function instruction(row:ElectrolyteIncoming){const {receipt,receivedAt,updatedAt,...rest}=row;return rest;}
export function validateFillingHandover(row:ElectrolyteIncoming):void {
 const source=row?.sourceAssembly,transfer=row?.handover,output=source?.cellOutput;
 if(!source||!transfer||!output)throw new Error('Источник и заявление выхода передачи не указаны');
 validateAssemblyCellOutput(source,output);
 if(!text(row.id)||!['dry-room','floor7-room5'].includes(row.box)||row.fromAssemblyRunId!==source.id||row.batchName!==source.batchName||row.cellsIn!==output.count||row.cellType!==output.cellType||!same(row.serialRange,output.serialRange)||
  transfer.outputId!==output.id||!text(transfer.preparedBy)||!CELL_OUTPUT_ROLES.includes(transfer.preparedRole)||!time(transfer.preparedAt))throw new Error('Передача должна сохранять полный заявленный выход, номера, формат, источник и назначенный бокс');
 if(row.receipt!==undefined){
  const receipt=row.receipt;
  if(!receipt||!text(receipt.id)||receipt.id===row.id||!text(receipt.recordedBy)||receipt.recordedBy===transfer.preparedBy||!time(receipt.recordedAt)||!text(receipt.note)||receipt.note.length>1000||receipt.count!==row.cellsIn||row.receivedAt!==receipt.recordedAt||row.updatedAt!==receipt.recordedAt)throw new Error('Приёмка требует другого получателя, полного количества, времени и основания');
 }else if(row.receivedAt!==undefined||row.updatedAt!==transfer.preparedAt)throw new Error('Передача без квитанции остаётся ожидающей приёмки');
}
async function checkSourceAndAllocation(row:ElectrolyteIncoming):Promise<void>{
 const source=row.sourceAssembly!;
 const current=await db.assemblyRuns.get(source.id);
 if(current&&!same(current,source))throw new Error('Сохранённая сборка отличается от снимка передачи; история сохранена');
 const all=await db.electrolyteIncoming.toArray();
 if(row.receipt&&all.some(other=>other.id!==row.id&&other.receipt?.id===row.receipt!.id))throw new Error('ID квитанции уже принадлежит другой передаче');
 if(all.some(other=>other.id!==row.id&&(other.handover?.outputId===row.handover!.outputId||other.fromAssemblyRunId===source.id||!hasFillingHandover(other)&&other.batchName===row.batchName)))throw new Error('Заявленный выход уже назначен другому боксу или старая история неоднозначна');
 await assertAssemblySerialAvailability(source,row.serialRange!,row.handover!.outputId,source);
}
export async function prepareFillingHandover(source:AssemblyRun,box:ElectrolyteBox,actorId:string,id:string):Promise<ElectrolyteIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const actor=await db.users.get(actorId);
  if(!actor?.isActive||!CELL_OUTPUT_ROLES.includes(actor.role))throw new Error('Назначить передачу может активный локальный технолог, мастер или начальник');
  const output=source.cellOutput;
  if(!output)throw new Error('Сначала запишите отдельное заявление выхода ячеек');
  validateAssemblyCellOutput(source,output);
  const old=(await db.electrolyteIncoming.toArray()).find(row=>row.id===id||row.handover?.outputId===output.id||row.fromAssemblyRunId===source.id);
  if(old){
   if(hasFillingHandover(old)&&old.box===box&&same(old.sourceAssembly,source))return old;
   throw new Error('Выход уже назначен; бокс и исходный снимок не заменяются');
  }
  const current=await db.assemblyRuns.get(source.id);
  if(!current||!same(current,source))throw new Error('Источник изменён или отсутствует. Обновите выбор');
  const now=new Date().toISOString();
  const row:ElectrolyteIncoming={id,box,batchName:source.batchName,fromAssemblyRunId:source.id,sourceAssembly:source,cellsIn:output.count,cellType:output.cellType,serialRange:output.serialRange,handover:{outputId:output.id,preparedBy:actorId,preparedRole:actor.role,preparedAt:now},updatedAt:now};
  validateFillingHandover(row);await checkSourceAndAllocation(row);
  await db.electrolyteIncoming.add(row);await db.journal.add({id,stage:StageId.ASSEMBLY,workerId:actorId,createdAt:new Date(now),summary:`Назначена передача в заливку: ${source.batchName}`,params:{'Сборка':source.id,'Заявление выхода':output.id,'Бокс':box,'Ячеек назначено':row.cellsIn,'Приёмка':'ожидается'}});
  return row;
 });
}
export async function acceptFillingHandover(expected:ElectrolyteIncoming,box:ElectrolyteBox,actorId:string,count:number,note:string,receiptId:string):Promise<ElectrolyteIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const actor=await db.users.get(actorId),row=await db.electrolyteIncoming.get(expected.id);
  if(!actor?.isActive||!row||row.box!==box)throw new Error('Нужен активный профиль и передача в выбранном боксе');
  validateFillingHandover(row);
  if(row.receipt){if(row.receipt.recordedBy===actorId&&row.receipt.count===count&&row.receipt.note===note.trim())return row;throw new Error('Приёмка уже записана; исходная квитанция сохранена');}
  if(!same(row,expected))throw new Error('Передача изменена. Обновите журнал');
  const now=new Date().toISOString(),accepted={...row,receipt:{id:receiptId,count,recordedBy:actorId,recordedAt:now,note:note.trim()},receivedAt:now,updatedAt:now};
  validateFillingHandover(accepted);await checkSourceAndAllocation(accepted);
  await db.electrolyteIncoming.put(accepted);await db.journal.add({id:receiptId,stage:fillingStage(box),workerId:actorId,createdAt:new Date(now),summary:`Записана приёмка в заливку: ${row.batchName}`,params:{'Передача':row.id,'Заявление выхода':row.handover!.outputId,'Бокс':box,'Ячеек принято':count,'Основание':note.trim()}});
  return accepted;
 });
}
export async function receiveFillingHandover(row:ElectrolyteIncoming,role?:UserRole,senderId?:string,stage?:StageId):Promise<ElectrolyteIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  if(!row||!text(row.id)||!text(row.batchName)||!['dry-room','floor7-room5'].includes(row.box)||!Number.isSafeInteger(row.cellsIn)||row.cellsIn<=0)throw new Error('Входящая передача заливки повреждена');
  if(stage!==fillingStage(row.box))throw new Error('Бокс передачи не совпадает с этапом пакета');
  const old=await db.electrolyteIncoming.get(row.id);
  if(hasFillingHandover(old)||hasFillingHandover(row)){
   validateFillingHandover(row);
   if(old){
    if(same(old,row))return old;
    if(!same(instruction(old),instruction(row)))throw new Error('Конфликт передачи: исходный снимок сохранён');
    if(old.receipt){if(!row.receipt||same(old.receipt,row.receipt))return old;throw new Error('Квитанция уже записана и не заменяется');}
    if(!row.receipt)throw new Error('Изменён ожидающий снимок передачи');
    if(!role||(!CELL_OUTPUT_ROLES.includes(role)&&(role!==UserRole.WORKER||senderId!==row.receipt.recordedBy)))throw new Error('Подписант квитанции не совпадает с получателем');
   }else if(!role||!CELL_OUTPUT_ROLES.includes(role))throw new Error('Первый пакет передачи требует роли технолога, мастера или начальника');
   await checkSourceAndAllocation(row);await db.electrolyteIncoming.put(row);return row;
  }
  if(old){if(same(old,row))return old;throw new Error('Старая входящая запись сохранена; автоматическая замена не разрешена');}
  const incoming=await db.electrolyteIncoming.toArray();
  const sources=await db.assemblyRuns.toArray();
  if(incoming.some(other=>hasFillingHandover(other)&&(other.fromAssemblyRunId===row.fromAssemblyRunId&&!!row.fromAssemblyRunId||other.batchName===row.batchName))||sources.some(source=>(source.cellOutput||source.operationLedger||source.intake)&&(source.id===row.fromAssemblyRunId||source.batchName===row.batchName)))throw new Error('Старый пакет не может обойти передачу заявленного выхода');
  if(row.serialRange)await assertAssemblySerialAvailability({id:'legacy-incoming:'+row.id} as AssemblyRun,row.serialRange);
  await db.electrolyteIncoming.add(row);return row;
 });
}
