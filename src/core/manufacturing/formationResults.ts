import {db} from '../db';
import {StageId,UserRole,type FillRun,type WalzRun,type FormationIncoming,type FormationRun,type AssemblyRun} from '../types';
import {assemblyOutputTables,CELL_OUTPUT_ROLES,assertAssemblySerialAvailability} from './assemblyCellOutput';
import {validateFillingResult,hasFillingResult} from './fillingResults';
import {validateWalzingResult,hasWalzingResult} from './walzingResults';
import {checkFillingSourceAndAllocation} from './fillingHandover';

export const FORMATION_UNITS={current:'A',voltage:'V',capacity:'Ah',efficiency:'%',cycles:'count'} as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const text=(v:unknown)=>typeof v==='string'&&!!v.trim();
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
export const hasFormationSource=(row?:FormationIncoming)=>!!row&&(row.sourceFill!==undefined||row.sourceWalz!==undefined||row.destination!==undefined||row.preparedAt!==undefined);
export const hasFormationResult=(run?:FormationRun)=>!!run&&(run.sourceLedger!==undefined||run.inputSnapshot!==undefined);
export function validateFormationIncoming(row:FormationIncoming):void {
 const source=row?.sourceFill??row?.sourceWalz;
 if(!source||!!row.sourceFill===!!row.sourceWalz)throw new Error('Укажите один сохранённый источник формирования');
 if(row.sourceFill){validateFillingResult(row.sourceFill);if(row.sourceFill.box!=='dry-room'||row.sourceFill.cellsScrap!==0||row.sourceFill.cellsUnknown!==0||row.sourceFill.cellsFilled!==row.sourceFill.cellsIn||row.sourceBox!=='dry-room'||row.fromFillRunId!==source.id||row.fromWalzRunId!==undefined)throw new Error('Прямой вход формирования требует полного определённого выхода сухой комнаты');}
 else{const walz=row.sourceWalz!;validateWalzingResult(walz);if(!hasWalzingResult(walz)||walz.cellsScrap!==0||walz.cellsUnknown!==0||walz.cellsOut!==walz.cellsIn||row.sourceBox!=='walzing'||row.fromWalzRunId!==source.id||row.fromFillRunId!==undefined)throw new Error('Вход формирования требует полного определённого выхода вальцовки');}
 const cellType=row.sourceFill?.cellType??row.sourceWalz?.inputSnapshot?.cellType;
 if(row.id!==source.id||row.destination!==StageId.FORMATION||row.batchName!==source.batchName||row.cellsIn!==source.cellsIn||row.cellType!==cellType||!same(row.serialRange,source.serialRange)||!text(row.preparedBy)||!Object.values(UserRole).includes(row.preparedRole!)||!time(row.preparedAt)||row.updatedAt!==row.preparedAt||row.receivedAt!==undefined)throw new Error('Назначение формирования должно сохранять полный источник, формат, номера, количество и автора; пакет не является приёмкой');
}
async function checkSource(row:FormationIncoming):Promise<void>{
 if(row.sourceWalz){const walz=row.sourceWalz;if(!same(await db.walzRuns.get(walz.id),walz)||!same(await db.walzingIncoming.get(walz.inputSnapshot!.id),walz.inputSnapshot))throw new Error('Источник вальцовки отсутствует или изменён');}
 const fill=row.sourceFill??row.sourceWalz!.inputSnapshot!.sourceFill!;
 if(!same(await db.fillRuns.get(fill.id),fill)||!same(await db.electrolyteIncoming.get(fill.sourceReceipt!.id),fill.sourceReceipt))throw new Error('Источник заливки или квитанция отсутствует/изменён');
 await checkFillingSourceAndAllocation(fill.sourceReceipt!);
}
async function insertIncoming(row:FormationIncoming):Promise<FormationIncoming>{
 const old=await db.formationIncoming.get(row.id);if(old){if(same(old,row))return old;throw new Error('Задание формирования уже сохранено; источник не заменяется');}
 const rows=await db.formationIncoming.toArray();
 if(hasFormationSource(row)){
  validateFormationIncoming(row);await checkSource(row);
  if(rows.some(other=>!!row.fromFillRunId&&other.fromFillRunId===row.fromFillRunId||!!row.fromWalzRunId&&other.fromWalzRunId===row.fromWalzRunId||!hasFormationSource(other)&&other.batchName===row.batchName))throw new Error('Источник уже назначен или старая история неоднозначна');
 }else{
  if(!text(row.id)||!text(row.batchName)||!count(row.cellsIn)||row.cellsIn===0||!['dry-room','floor7-room5','walzing'].includes(row.sourceBox))throw new Error('Исторический вход формирования повреждён');
  const fills=await db.fillRuns.toArray(),walz=await db.walzRuns.toArray();if(fills.some(source=>hasFillingResult(source)&&(source.id===row.fromFillRunId||source.batchName===row.batchName))||walz.some(source=>hasWalzingResult(source)&&(source.id===row.fromWalzRunId||source.batchName===row.batchName)))throw new Error('Старый пакет не может обойти защищённый источник');
  if(row.serialRange)await assertAssemblySerialAvailability({id:'legacy-formation-in:'+row.id} as AssemblyRun,row.serialRange);
 }
 await db.formationIncoming.add(row);return row;
}
export async function prepareFormationHandover(source:FillRun|WalzRun,actorId:string):Promise<FormationIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const actor=await db.users.get(actorId);if(!actor?.isActive||!CELL_OUTPUT_ROLES.includes(actor.role)&&actorId!==source.workerId)throw new Error('Нужен активный автор источника или локальный руководитель');
  const fill='box' in source?source:undefined,walz='box' in source?undefined:source;
  const old=await db.formationIncoming.get(source.id);if(old){if(same(old.sourceFill??old.sourceWalz,source)){validateFormationIncoming(old);return old;}throw new Error('Задание уже существует с другим снимком');}
  const now=new Date().toISOString();const row:FormationIncoming={id:source.id,sourceFill:fill,sourceWalz:walz,destination:StageId.FORMATION,preparedBy:actorId,preparedRole:actor.role,preparedAt:now,sourceBox:fill?'dry-room':'walzing',batchName:source.batchName,serialRange:source.serialRange,cellType:fill?.cellType??walz?.inputSnapshot?.cellType,cellsIn:source.cellsIn!,fromFillRunId:fill?.id,fromWalzRunId:walz?.id,updatedAt:now};
  await insertIncoming(row);await db.journal.add({id:`formation-in:${row.id}`,stage:fill?StageId.ELECTROLYTE:StageId.WALZING,workerId:actorId,createdAt:new Date(now),summary:`Задание формирования: ${row.batchName}`,params:{'Источник':source.id,'Назначено ячеек':row.cellsIn,'Приёмка':'не подтверждена'}});return row;
 });
}
export async function receiveFormationIncoming(row:FormationIncoming,stage?:StageId,role?:UserRole,senderId?:string):Promise<FormationIncoming>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  if(stage!==StageId.FORMATION)throw new Error('Неверный этап назначения формирования');
  if(hasFormationSource(row)){validateFormationIncoming(row);if(!role||!CELL_OUTPUT_ROLES.includes(role)&&(senderId!==row.preparedBy||role!==row.preparedRole))throw new Error('Подписант задания не совпадает с автором');}
  return insertIncoming(row);
 });
}
export function validateFormationResult(run:FormationRun):void {
 if(!run||!text(run.id)||!text(run.batchName)||!text(run.workerId)||!time(run.createdAt)||run.updatedAt!==run.createdAt||!date(run.startDate)||run.endDate!==undefined&&(!date(run.endDate)||run.endDate<run.startDate)||!run.mode||!count(run.mode.cycles)||run.mode.cycles===0)throw new Error('Введите действительные даты по календарю (окончание не раньше начала) и явное положительное целое число циклов');
 if(!count(run.cellsIn)||run.cellsIn===0||!count(run.cellsOut)||!count(run.cellsScrap)||!count(run.cellsUnknown??(hasFormationResult(run)?undefined:0))||!Number.isSafeInteger(run.cellsOut+run.cellsScrap+(run.cellsUnknown??0))||run.cellsIn!==run.cellsOut+run.cellsScrap+(run.cellsUnknown??0))throw new Error('Укажите полные целые количества: подано = обработано + отклонено + не определено');
 if(run.serialRange&&(!count(run.serialRange.start)||!count(run.serialRange.end)||run.serialRange.end-run.serialRange.start+1!==run.cellsIn))throw new Error('Диапазон должен содержать ровно весь поданный вход; номера обработанной части не выводятся');
 if(!Array.isArray(run.defects)||run.defects.some(v=>!text(v))||run.equipmentRef!==undefined&&!text(run.equipmentRef))throw new Error('Введённое оборудование и дефекты не должны быть пустыми');
 if(run.mode.currentA!==undefined&&!Number.isFinite(run.mode.currentA)||run.mode.voltageV!==undefined&&(!Number.isFinite(run.mode.voltageV)||run.mode.voltageV<0)||run.capacityCycle5Ah!==undefined&&(!Number.isFinite(run.capacityCycle5Ah)||run.capacityCycle5Ah<0||run.mode.cycles<5)||run.coulombEfficiencyPct!==undefined&&(!Number.isFinite(run.coulombEfficiencyPct)||run.coulombEfficiencyPct<0||run.coulombEfficiencyPct>100))throw new Error('Введённые наблюдения должны быть конечными: ток А, напряжение В ≥ 0, ёмкость А·ч ≥ 0 после 5 циклов, эффективность 0–100 %');
 if(hasFormationResult(run)){
  const input=run.inputSnapshot;if(run.sourceLedger!==1||!input)throw new Error('Источник формирования не указан');validateFormationIncoming(input);
  if(run.id===input.id||run.batchName!==input.batchName||run.cellsIn!==input.cellsIn||!same(run.serialRange,input.serialRange)||!Object.values(UserRole).includes(run.recordedRole!)||!text(run.measurementBasis)||run.measurementBasis!.length>1000||!run.measurementUnits||Object.entries(FORMATION_UNITS).some(([key,unit])=>run.measurementUnits![key as keyof typeof FORMATION_UNITS]!==unit)||Date.parse(run.createdAt)<Date.parse(input.preparedAt!))throw new Error('Результат должен сохранять источник, полный диапазон, единицы, основание наблюдений и автора');
 }
}
async function insertResult(run:FormationRun):Promise<FormationRun>{
 const old=await db.formationRuns.get(run.id);if(old){if(same(old,run))return old;throw new Error('ID формирования уже сохранён; история не заменяется');}
 validateFormationResult(run);const rows=await db.formationRuns.toArray();
 if(hasFormationResult(run)){
  const input=run.inputSnapshot!;if(!same(await db.formationIncoming.get(input.id),input))throw new Error('Входящее задание отсутствует или изменено');
  if(rows.some(row=>row.inputSnapshot?.id===input.id||!hasFormationResult(row)&&row.batchName===run.batchName))throw new Error('Источник уже распределён или старая история неоднозначна');await checkSource(input);
 }else{
  if(run.legacyInputSnapshot){const input=run.legacyInputSnapshot;if(hasFormationSource(input)||!same(await db.formationIncoming.get(input.id),input)||run.cellsIn!==input.cellsIn||run.batchName!==input.batchName||!same(run.serialRange,input.serialRange))throw new Error('Исторический вход изменён или количество не совпадает');}
  const incoming=await db.formationIncoming.toArray(),fills=await db.fillRuns.toArray(),walz=await db.walzRuns.toArray();if(rows.some(row=>row.batchName===run.batchName)||incoming.some(row=>hasFormationSource(row)&&row.batchName===run.batchName)||fills.some(row=>hasFillingResult(row)&&row.batchName===run.batchName)||walz.some(row=>hasWalzingResult(row)&&row.batchName===run.batchName))throw new Error('Старая форма не может обойти защищённый источник или повторить учёт');
  if(run.serialRange)await assertAssemblySerialAvailability({id:'legacy-formation:'+run.id} as AssemblyRun,run.serialRange);
 }
 await db.formationRuns.add(run);await db.journal.add({id:run.id,stage:StageId.FORMATION,workerId:run.workerId,createdAt:new Date(run.createdAt),summary:`Наблюдение формирования: ${run.batchName}; QA не подтверждено`,params:{'Снимок результата':JSON.stringify(run),'Обработано':run.cellsOut,'Отклонено':run.cellsScrap,'Не определено':run.cellsUnknown??0},defects:run.defects.join(', ')});return run;
}
export async function saveFormationResult(run:FormationRun,actorId:string):Promise<FormationRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{const actor=await db.users.get(actorId);if(!actor?.isActive||actor.id!==run.workerId||hasFormationResult(run)&&actor.role!==run.recordedRole)throw new Error('Нужен активный профиль автора');return insertResult(run);});
}
export async function receiveFormationResult(run:FormationRun,role?:UserRole,senderId?:string):Promise<FormationRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{if(hasFormationResult(run)){validateFormationResult(run);if(!role||!CELL_OUTPUT_ROLES.includes(role)&&(senderId!==run.workerId||role!==run.recordedRole))throw new Error('Подписант результата не совпадает с автором');}return insertResult(run);});
}
