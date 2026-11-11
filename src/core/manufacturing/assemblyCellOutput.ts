import {db} from '../db';
import {StageId,UserRole,type AssemblyRun,type AssemblyCellOutput,type SerialRange} from '../types';
import {validateAssemblyOperationRun,receiveAssemblyOperationRun} from './assemblyOperations';

export const CELL_OUTPUT_ROLES=[UserRole.TECHNOLOGIST,UserRole.MASTER,UserRole.CHIEF];
export const assemblyOutputTables=()=>[db.assemblyRuns,db.journal,db.users,db.electrolyteIncoming,db.fillRuns,db.walzingIncoming,db.walzRuns,db.formationIncoming,db.formationRuns];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const validRange=(range:SerialRange)=>!!range&&Number.isSafeInteger(range.start)&&Number.isSafeInteger(range.end)&&range.start>=0&&range.end>=range.start&&(range.prefix===undefined||typeof range.prefix==='string'&&range.prefix===range.prefix.trim()&&range.prefix.length<=80);
export function eligibleAssemblyCellOperations(run:AssemblyRun){
 const used=new Set(run.ops.flatMap(op=>op.source?.kind==='operation'?[op.source.operationId]:[]));
 const terminal=run.ops.filter(op=>op.id&&op.source&&Number.isSafeInteger(op.qtyOut)&&op.qtyOut>0&&!used.has(op.id));
 return terminal.length===1&&terminal[0].units?.output==='cells'?terminal:[];
}
export function validateAssemblyCellOutput(run:AssemblyRun,output:AssemblyCellOutput):void {
 validateAssemblyOperationRun(run);
 const leaves=eligibleAssemblyCellOperations(run);
 const op=leaves.find(row=>row.id===output?.operationId);
 if(run.sourceLedger!==1||!output||!op||leaves.length!==1||typeof output.id!=='string'||!output.id.trim()||
  !Number.isSafeInteger(output.count)||output.count<=0||output.count!==op.qtyOut||!['cylindrical','prismatic'].includes(output.cellType)||
  typeof output.recordedBy!=='string'||!output.recordedBy.trim()||!CELL_OUTPUT_ROLES.includes(output.recordedRole)||typeof output.recordedAt!=='string'||!Number.isFinite(Date.parse(output.recordedAt))||
  typeof output.note!=='string'||!output.note.trim()||output.note.length>1000||!validRange(output.serialRange)||!Number.isSafeInteger(output.serialRange.end-output.serialRange.start+1)||output.serialRange.end-output.serialRange.start+1!==output.count)
  throw new Error('Выход требует одной конечной операции в ячейках, полного количества, явного формата, диапазона по числу ячеек и основания подсчёта');
 // Every predecessor in the selected lineage must have explicit provenance.
 let current=op;
 while(current.source?.kind==='operation'){
  const parent=run.ops.find(row=>row.id===(current.source as {operationId:string}).operationId);
  if(!parent?.source)throw new Error('Предшественник не имеет явного источника');current=parent;
 }
 if(!current.source)throw new Error('Источник выхода не подтверждён записью');
 if(run.serialRange&&!same(run.serialRange,output.serialRange))throw new Error('Старый диапазон номеров не заменяется заявлением выхода');
}
export async function assertAssemblySerialAvailability(run:AssemblyRun,rangeToAssign:SerialRange,outputId?:string):Promise<void>{
 if(!validRange(rangeToAssign))throw new Error('Диапазон номеров должен быть целым, неотрицательным и явно заданным');
 const rows=await Promise.all([db.assemblyRuns.toArray(),db.electrolyteIncoming.toArray(),db.fillRuns.toArray(),db.walzingIncoming.toArray(),db.walzRuns.toArray(),db.formationIncoming.toArray(),db.formationRuns.toArray()]);
 for(const [tableIndex,table] of rows.entries())for(const row of table){
  if(tableIndex===0&&row.id===run.id)continue;
  if('cellOutput' in row&&outputId&&row.cellOutput?.id===outputId)throw new Error('ID заявления уже принадлежит другой партии');
  const ranges=[row.serialRange,...('cellOutput' in row?[row.cellOutput?.serialRange]:[])];
  for(const range of ranges){
   if(!range)continue;
   const a=typeof range.prefix==='string'?range.prefix.trim():'',b=rangeToAssign.prefix??'';
   if(a&&b&&a!==b)continue;
   if(!validRange(range)||rangeToAssign.start<=range.end&&range.start<=rangeToAssign.end)throw new Error('Конфликт номеров с сохранённой историей. Проверьте диапазоны; записи не изменены.');
  }
 }
}
export async function declareAssemblyCellOutput(expected:AssemblyRun,output:AssemblyCellOutput,actorId:string):Promise<AssemblyRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const actor=await db.users.get(actorId);
  if(!actor?.isActive||!CELL_OUTPUT_ROLES.includes(actor.role)||actorId!==output.recordedBy||actor.role!==output.recordedRole)throw new Error('Заявить выход может активный локальный технолог, мастер или начальник');
  const current=await db.assemblyRuns.get(expected.id);
  if(!current)throw new Error('Партия не найдена');
  if(current.cellOutput!==undefined){if(same(current.cellOutput,output))return current;throw new Error('Выход уже заявлен; исходная запись сохранена');}
  if(!same(current,expected))throw new Error('Партия изменена. Проверьте журнал перед заявлением выхода');
  validateAssemblyCellOutput(current,output);await assertAssemblySerialAvailability(current,output.serialRange,output.id);
  const next={...current,cellOutput:output,updatedAt:output.recordedAt};await db.assemblyRuns.put(next);
  await db.journal.add({id:output.id,stage:StageId.ASSEMBLY,workerId:actorId,createdAt:new Date(output.recordedAt),summary:`Заявленный выход ячеек: ${current.batchName}`,
   params:{'Партия сборки':current.id,'Операция':output.operationId,'Заявлено ячеек':output.count,'Формат':output.cellType,'Начальный номер':output.serialRange.start,'Конечный номер':output.serialRange.end,'Префикс':output.serialRange.prefix??'','Основание':output.note,'QA':'не подтверждено'}});
  return next;
 });
}
export async function receiveAssemblyCellOutput(run:AssemblyRun,senderRole?:UserRole):Promise<AssemblyRun>{
 return db.transaction('rw',assemblyOutputTables(),async()=>{
  const old=await db.assemblyRuns.get(run.id);
  if(old&&same(old,run))return old;
  if(old?.cellOutput!==undefined)throw new Error('Конфликт заявленного выхода: история сохранена');
  if(!run.cellOutput||!senderRole||!CELL_OUTPUT_ROLES.includes(senderRole))throw new Error('Пакет заявления выхода требует роли технолога, мастера или начальника');
  const {cellOutput,...base}=run;
  const accepted=await receiveAssemblyOperationRun(old?{...base,updatedAt:old.updatedAt}:base);
  validateAssemblyCellOutput(accepted,cellOutput);await assertAssemblySerialAvailability(accepted,cellOutput.serialRange,cellOutput.id);
  await db.assemblyRuns.put(run);return run;
 });
}
