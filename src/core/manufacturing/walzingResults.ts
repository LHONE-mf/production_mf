import {db} from '../db';
import {StageId,UserRole,type FillRun,type WalzingIncoming,type WalzRun,type AssemblyRun} from '../types';
import {assemblyOutputTables,CELL_OUTPUT_ROLES,assertAssemblySerialAvailability} from './assemblyCellOutput';
import {validateFillingResult,hasFillingResult} from './fillingResults';
import {checkFillingSourceAndAllocation} from './fillingHandover';

export const WALZING_UNITS={diameter:'mm',force:'kgf',speed:'rpm',temperature:'°C',passes:'count'} as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const text=(v:unknown)=>typeof v==='string'&&!!v.trim();
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export const hasWalzingSource=(row?:WalzingIncoming)=>!!row&&(row.sourceFill!==undefined||row.destination!==undefined||row.preparedAt!==undefined);
export const hasWalzingResult=(run?:WalzRun)=>!!run&&(run.sourceLedger!==undefined||run.inputSnapshot!==undefined);
export function validateWalzingIncoming(row:WalzingIncoming):void {
 const fill=row?.sourceFill;if(!fill)throw new Error('Нужен сохранённый результат заливки');validateFillingResult(fill);
 if(fill.box!=='floor7-room5'||fill.cellType!=='cylindrical'||fill.cellsScrap!==0||fill.cellsUnknown!==0||fill.cellsFilled!==fill.cellsIn||row.id!==fill.id||row.fromFillRunId!==fill.id||row.destination!==StageId.WALZING||row.batchName!==fill.batchName||row.cellsIn!==fill.cellsFilled||row.cellType!==fill.cellType||row.electrolyteName!==fill.electrolyteName||!same(row.serialRange,fill.serialRange)||!text(row.preparedBy)||!Object.values(UserRole).includes(row.preparedRole!)||!time(row.preparedAt)||row.updatedAt!==row.preparedAt||row.receivedAt!==undefined)
  throw new Error('Вальцовка требует весь определённый цилиндрический выход 705, исходные номера, автора и явное назначение; пакет не является приёмкой');
}
async function checkFill(fill:FillRun):Promise<void>{
 if(!same(await db.fillRuns.get(fill.id),fill)||!same(await db.electrolyteIncoming.get(fill.sourceReceipt!.id),fill.sourceReceipt))throw new Error('Результат заливки или его квитанция отсутствует/изменён');
 await checkFillingSourceAndAllocation(fill.sourceReceipt!);
}
async function insertIncoming(row:WalzingIncoming):Promise<WalzingIncoming>{
 const old=await db.walzingIncoming.get(row.id);if(old){if(same(old,row))return old;throw new Error('Задание вальцовки уже сохранено; источник не заменяется');}
 if(hasWalzingSource(row)){
  validateWalzingIncoming(row);await checkFill(row.sourceFill!);
  const all=await db.walzingIncoming.toArray();if(all.some(other=>other.fromFillRunId===row.fromFillRunId||!hasWalzingSource(other)&&other.batchName===row.batchName))throw new Error('Источник уже назначен или старая история неоднозначна');
 }else{
  if(!row||!text(row.id)||!text(row.batchName)||!count(row.cellsIn)||row.cellsIn===0)throw new Error('Старая входящая запись повреждена');
  const fills=await db.fillRuns.toArray();if(fills.some(fill=>hasFillingResult(fill)&&(fill.id===row.fromFillRunId||fill.batchName===row.batchName)))throw new Error('Старый пакет не может обойти источник заливки');
  if(row.serialRange)await assertAssemblySerialAvailability({id:'legacy-walzing:'+row.id} as AssemblyRun,row.serialRange);
 }
 await db.walzingIncoming.add(row);return row;
}
export async function prepareWalzingHandover(fill:FillRun,actorId:string):Promise<WalzingIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const actor=await db.users.get(actorId);if(!actor?.isActive||!CELL_OUTPUT_ROLES.includes(actor.role)&&actorId!==fill.workerId)throw new Error('Нужен активный автор заливки или локальный руководитель');
  const old=await db.walzingIncoming.get(fill.id);if(old){if(same(old.sourceFill,fill)){validateWalzingIncoming(old);return old;}throw new Error('Задание уже существует с другим снимком');}
  const now=new Date().toISOString();const row:WalzingIncoming={id:fill.id,sourceFill:fill,destination:StageId.WALZING,preparedBy:actorId,preparedRole:actor.role,preparedAt:now,batchName:fill.batchName,fromFillRunId:fill.id,cellType:fill.cellType,serialRange:fill.serialRange,cellsIn:fill.cellsFilled,electrolyteName:fill.electrolyteName,updatedAt:now};
  await insertIncoming(row);await db.journal.add({id:`walzing-in:${row.id}`,stage:StageId.ELECTROLYTE_705,workerId:actorId,createdAt:new Date(now),summary:`Задание вальцовки: ${row.batchName}`,params:{'Источник заливки':fill.id,'Назначено ячеек':row.cellsIn,'Приёмка':'не подтверждена'}});return row;
 });
}
export async function receiveWalzingIncoming(row:WalzingIncoming,stage?:StageId,role?:UserRole,senderId?:string):Promise<WalzingIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  if(stage!==StageId.WALZING)throw new Error('Неверный этап назначения вальцовки');
  if(hasWalzingSource(row)){validateWalzingIncoming(row);if(!role||!CELL_OUTPUT_ROLES.includes(role)&&(senderId!==row.preparedBy||role!==row.preparedRole))throw new Error('Подписант задания не совпадает с автором');}
  return insertIncoming(row);
 });
}
export function validateWalzingResult(run:WalzRun):void {
 if(!run||!text(run.id)||!text(run.batchName)||!text(run.workerId)||!time(run.createdAt)||run.updatedAt!==run.createdAt||!count(run.cellsIn)||run.cellsIn===0||!count(run.cellsOut)||!count(run.cellsScrap)||!count(run.cellsUnknown??(hasWalzingResult(run)?undefined:0))||!Number.isSafeInteger(run.cellsOut+run.cellsScrap+(run.cellsUnknown??0))||run.cellsIn!==run.cellsOut+run.cellsScrap+(run.cellsUnknown??0)||!Array.isArray(run.defects)||run.defects.some(v=>!text(v))||run.machineNo!==undefined&&!text(run.machineNo))throw new Error('Укажите полные целые количества: подано = обработано + отклонено + не определено, автора и время');
 for(const [key,min] of [['incomingDiameter',0],['finalDiameter',0],['passes',0],['pressureKgf',0],['speedRpm',0],['temperatureC',-273.15]] as const){const value=run[key];if(value!==undefined&&(!Number.isFinite(value)||value<min||['incomingDiameter','finalDiameter','passes'].includes(key)&&value===0||key==='passes'&&!Number.isSafeInteger(value)))throw new Error('Введённые измерения должны быть конечными в указанных единицах; проходы — положительным целым');}
 if(hasWalzingResult(run)){
  const input=run.inputSnapshot;if(run.sourceLedger!==1||!input)throw new Error('Источник вальцовки не указан');validateWalzingIncoming(input);
  if(run.id===input.id||run.batchName!==input.batchName||run.cellsIn!==input.cellsIn||!same(run.serialRange,input.serialRange)||!Object.values(UserRole).includes(run.recordedRole!)||!run.measurementUnits||Object.entries(WALZING_UNITS).some(([key,unit])=>run.measurementUnits![key as keyof typeof WALZING_UNITS]!==unit)||Date.parse(run.createdAt)<Date.parse(input.preparedAt!))throw new Error('Результат должен сохранять источник, полный диапазон, количество, единицы и автора');
 }
}
async function insertResult(run:WalzRun):Promise<WalzRun>{
 const old=await db.walzRuns.get(run.id);if(old){if(same(old,run))return old;throw new Error('ID вальцовки уже сохранён; история не заменяется');}
 validateWalzingResult(run);const rows=await db.walzRuns.toArray();
 if(hasWalzingResult(run)){
  const input=run.inputSnapshot!;if(!same(await db.walzingIncoming.get(input.id),input))throw new Error('Входящее задание отсутствует или изменено');
  if(rows.some(row=>row.inputSnapshot?.id===input.id||row.inputSnapshot?.fromFillRunId===input.fromFillRunId||!hasWalzingResult(row)&&row.batchName===run.batchName))throw new Error('Выход заливки уже распределён или старая история неоднозначна');
  await checkFill(input.sourceFill!);
 }else{
  if(run.legacyInputSnapshot){const input=run.legacyInputSnapshot;if(hasWalzingSource(input)||!same(await db.walzingIncoming.get(input.id),input)||run.cellsIn!==input.cellsIn||run.batchName!==input.batchName||!same(run.serialRange,input.serialRange))throw new Error('Исторический вход изменён или количество не совпадает');}
  const incoming=await db.walzingIncoming.toArray(),fills=await db.fillRuns.toArray();if(rows.some(row=>row.batchName===run.batchName||!!run.legacyInputSnapshot&&row.legacyInputSnapshot?.id===run.legacyInputSnapshot.id)||incoming.some(row=>hasWalzingSource(row)&&row.batchName===run.batchName)||fills.some(row=>hasFillingResult(row)&&row.batchName===run.batchName))throw new Error('Источник уже использован или старая форма обходит защищённый источник');
  if(run.serialRange)await assertAssemblySerialAvailability({id:'legacy-walz:'+run.id} as AssemblyRun,run.serialRange);
 }
 await db.walzRuns.add(run);await db.journal.add({id:run.id,stage:StageId.WALZING,workerId:run.workerId,createdAt:new Date(run.createdAt),summary:`Наблюдение вальцовки: ${run.batchName}; QA не подтверждено`,params:{'Снимок результата':JSON.stringify(run),'Обработано':run.cellsOut,'Отклонено':run.cellsScrap,'Не определено':run.cellsUnknown??0},defects:run.defects.join(', ')});return run;
}
export async function saveWalzingResult(run:WalzRun,actorId:string):Promise<WalzRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{const actor=await db.users.get(actorId);if(!actor?.isActive||actor.id!==run.workerId||hasWalzingResult(run)&&actor.role!==run.recordedRole)throw new Error('Нужен активный профиль автора');return insertResult(run);});
}
export async function receiveWalzingResult(run:WalzRun,role?:UserRole,senderId?:string):Promise<WalzRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{if(hasWalzingResult(run)){validateWalzingResult(run);if(!role||!CELL_OUTPUT_ROLES.includes(role)&&(senderId!==run.workerId||role!==run.recordedRole))throw new Error('Подписант результата не совпадает с автором');}return insertResult(run);});
}
