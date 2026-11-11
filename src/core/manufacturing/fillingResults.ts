import {db} from '../db';
import {type FillRun,type AssemblyRun,type StageId,UserRole} from '../types';
import {assemblyOutputTables,CELL_OUTPUT_ROLES,assertAssemblySerialAvailability} from './assemblyCellOutput';
import {fillingStage,validateFillingHandover,checkFillingSourceAndAllocation,hasFillingHandover} from './fillingHandover';

export const FILLING_UNITS={dose:'mg',vacuum:'kPa',pressure:'kPa',duration:'min',temperature:'°C',humidity:'ppm'} as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const text=(v:unknown)=>typeof v==='string'&&!!v.trim();
const time=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export const hasFillingResult=(run?:FillRun)=>!!run&&(run.resultVersion!==undefined||run.sourceReceipt!==undefined||run.measurementUnits!==undefined||run.cellsUnknown!==undefined);

export function validateFillingResult(run:FillRun):void {
 const source=run?.sourceReceipt;
 if(run?.resultVersion!==1||!source?.receipt)throw new Error('Результат требует сохранённой независимой приёмки');
 validateFillingHandover(source);
 if(!text(run.id)||[source.id,source.receipt.id,source.handover!.outputId,source.fromAssemblyRunId].includes(run.id)||run.box!==source.box||run.batchName!==source.batchName||run.cellType!==source.cellType||!same(run.serialRange,source.serialRange)||run.cellsIn!==source.receipt.count||!text(run.workerId)||!Object.values(UserRole).includes(run.recordedRole!)||!time(run.createdAt)||run.updatedAt!==run.createdAt||Date.parse(run.createdAt)<Date.parse(source.receipt.recordedAt))
  throw new Error('Результат должен сохранять источник, бокс, формат, номера, количество, автора и время');
 if(!count(run.cellsFilled)||!count(run.cellsScrap)||!count(run.cellsUnknown)||!Number.isSafeInteger(run.cellsFilled+run.cellsScrap+run.cellsUnknown)||run.cellsFilled+run.cellsScrap+run.cellsUnknown!==run.cellsIn)
  throw new Error('Залито + отклонено + не определено должны точно составлять весь принятый выход, целыми ячейками');
 if(!run.measurementUnits||Object.entries(FILLING_UNITS).some(([key,unit])=>run.measurementUnits![key as keyof typeof FILLING_UNITS]!==unit))throw new Error('Единицы измерений: мг, кПа, мин, °C, ppm; точка росы не является ppm');
 if(!text(run.electrolyteName)||!text(run.measurementBasis)||run.measurementBasis!.length>1000||!Array.isArray(run.defects)||run.defects.some(v=>!text(v))||(run.comment!==undefined&&!text(run.comment))||(run.machineNo!==undefined&&!text(run.machineNo)))throw new Error('Укажите электролит и основание измерений: к чему относится доза, как измерены вакуум/давление и среда');
 for(const [key,min] of [['doseActual',0],['vacuumKpa',0],['pressureKpa',0],['dwellMin',0],['temperatureC',-273.15],['humidityPpm',0]] as const){
  const value=run[key];if(typeof value!=='number'||!Number.isFinite(value)||value<min||key==='doseActual'&&value===0)throw new Error('Введите конечные измеренные дозу, вакуум, давление, выдержку, температуру и влажность в указанных единицах');
 }
 if(run.doseMin!==undefined&&(!Number.isFinite(run.doseMin)||run.doseMin<=0))throw new Error('Введённая целевая доза должна быть положительной; это не измерение');
}

async function insertResult(run:FillRun):Promise<FillRun>{
 const old=await db.fillRuns.get(run.id);
 if(old){if(same(old,run))return old;throw new Error('ID результата уже сохранён; исходная запись не заменяется');}
 const rows=await db.fillRuns.toArray();
 if(hasFillingResult(run)){
  validateFillingResult(run);
  const source=run.sourceReceipt!,saved=await db.electrolyteIncoming.get(source.id);
  if(!saved||!same(saved,source))throw new Error('Приёмка отсутствует или изменена. Обновите выбор источника');
  if(rows.some(row=>row.sourceReceipt?.id===source.id||row.sourceReceipt?.receipt?.id===source.receipt!.id||row.sourceReceipt?.handover?.outputId===source.handover!.outputId||row.sourceReceipt?.fromAssemblyRunId===source.fromAssemblyRunId||!hasFillingResult(row)&&row.batchName===run.batchName))throw new Error('Источник уже использован или старая история неоднозначна');
  await checkFillingSourceAndAllocation(source);
 }else{
  if(!run||!text(run.id)||!text(run.batchName)||!['dry-room','floor7-room5'].includes(run.box)||!count(run.cellsFilled)||!count(run.cellsScrap))throw new Error('Старая запись заливки повреждена');
  const incoming=await db.electrolyteIncoming.toArray(),assembly=await db.assemblyRuns.toArray();
  if(rows.some(row=>hasFillingResult(row)&&row.batchName===run.batchName)||incoming.some(row=>hasFillingHandover(row)&&row.batchName===run.batchName)||assembly.some(row=>(row.cellOutput||row.intake||row.operationLedger)&&row.batchName===run.batchName))throw new Error('Старый пакет не может обойти связь с приёмкой');
  if(run.serialRange)await assertAssemblySerialAvailability({id:'legacy-fill:'+run.id} as AssemblyRun,run.serialRange);
 }
 await db.fillRuns.add(run);
 // Imported and locally entered observations retain the same actor and identity.
 if(hasFillingResult(run))await db.journal.add({id:run.id,stage:fillingStage(run.box),workerId:run.workerId,createdAt:new Date(run.createdAt),summary:`Измерения заливки: ${run.batchName}; QA не подтверждено`,params:{'Передача':run.sourceReceipt!.id,'Квитанция':run.sourceReceipt!.receipt!.id,'Залито':run.cellsFilled,'Отклонено':run.cellsScrap,'Не определено':run.cellsUnknown!,'Снимок результата':JSON.stringify(run)},defects:run.defects.join(', ')});
 return run;
}

export async function saveFillingResult(run:FillRun,actorId:string):Promise<FillRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const actor=await db.users.get(actorId);
  if(!actor?.isActive||actorId!==run.workerId||actor.role!==run.recordedRole)throw new Error('Нужен активный профиль автора результата');
  validateFillingResult(run);return insertResult(run);
 });
}
export async function receiveFillingResult(run:FillRun,stage?:StageId,role?:UserRole,senderId?:string):Promise<FillRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  if(!run||!['dry-room','floor7-room5'].includes(run.box)||stage!==fillingStage(run.box))throw new Error('Бокс результата не совпадает с этапом пакета');
  if(hasFillingResult(run)){
   validateFillingResult(run);
   if(!role||!CELL_OUTPUT_ROLES.includes(role)&&(role!==run.recordedRole||senderId!==run.workerId))throw new Error('Подписант результата не совпадает с автором');
  }
  return insertResult(run);
 });
}
