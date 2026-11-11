import {hasAssemblyOperationLedger,receiveAssemblyOperationRun} from './assemblyOperations';
import {db} from '../db';
import {StageId,type AssemblyRun,type SortRun} from '../types';
import {validateSortPartition} from './sortingAllocation';

export function validateAssemblyIntake(run:AssemblyRun):void {
 if(!run?.intake||!run.sourceSort)throw new Error('Источник приёмки не указан');
 validateSortPartition(run.sourceSort);
 const count=run.sourceSort.buckets.reduce((n,b)=>n+b.count,0);
 if(typeof run.id!=='string'||!run.id||typeof run.intake.recordedAt!=='string'||typeof run.intake.recordedBy!=='string'||!run.intake.recordedBy.trim()||run.workerId!==run.intake.recordedBy||run.createdAt!==run.intake.recordedAt||run.updatedAt!==run.createdAt||!Number.isFinite(new Date(run.intake.recordedAt).getTime())||
  !Array.isArray(run.defects)||run.defects.length>0||run.electrodesPerCell!==undefined||run.coatingType!==run.sourceSort.specSnapshot?.coatingType||run.cellType!=='unassigned'||run.electrodeType!==run.sourceSort.specSnapshot?.electrodeType||run.intake.sortRunId!==run.sourceSort.id||!run.sourceSort.cutRunId||!run.sourceSort.specSnapshot||
  !Number.isSafeInteger(count)||count<=0||run.intake.electrodeCount!==count||run.batchName!==run.sourceSort.batchName||
  !Array.isArray(run.ops)||run.ops.length||run.cellsOut!==0||run.cellsScrap!==0||run.serialRange)
  throw new Error('Приёмка должна сохранять источник и электроды без выдуманного выхода ячеек или станционных операций');
}
async function existingIntake(run:AssemblyRun):Promise<AssemblyRun|undefined>{
 const rows=await db.assemblyRuns.toArray();
 const old=rows.find(r=>r.id===run.id||r.intake?.sortRunId===run.intake!.sortRunId||!r.intake&&r.batchName===run.batchName);
 if(old){
  if(old.intake&&JSON.stringify(old.sourceSort)===JSON.stringify(run.sourceSort))return old;
  throw new Error('Источник уже принят или есть неоднозначная старая запись. Исходная история сохранена.');
 }
}
export async function takeAssemblySource(source:SortRun,workerId:string,id:string):Promise<AssemblyRun>{
 if(!workerId)throw new Error('Войдите в профиль');
 const count=source.buckets.reduce((n,b)=>n+b.count,0),now=new Date().toISOString();
 const spec=source.specSnapshot;
 const run:AssemblyRun={id,batchName:source.batchName,sourceSort:source,
  intake:{sortRunId:source.id,electrodeCount:count,recordedBy:workerId,recordedAt:now},
  cellType:'unassigned',electrodeType:spec?.electrodeType,coatingType:spec?.coatingType,
  ops:[],cellsOut:0,cellsScrap:0,defects:[],workerId,createdAt:now,updatedAt:now};
 validateAssemblyIntake(run);
 return db.transaction('rw',db.sortRuns,db.assemblyRuns,db.journal,async()=>{
  const old=await existingIntake(run);if(old)return old;
  const current=await db.sortRuns.get(source.id);
  if(!current||JSON.stringify(current)!==JSON.stringify(source))throw new Error('Источник изменён. Обновите выбор.');
  await db.assemblyRuns.add(run);
  await db.journal.add({id:run.id,stage:StageId.ASSEMBLY,workerId,createdAt:new Date(now),summary:`Приёмка электродов: ${source.id}`,
   params:{'Источник сортировки':source.id,'Электродов принято, шт':count,'Выход ячеек':'не определён'}});
  return run;
 });
}
export async function receiveAssemblyIntake(run:AssemblyRun):Promise<AssemblyRun>{
 return db.transaction('rw',db.assemblyRuns,async()=>{
  const previous=await db.assemblyRuns.get(run.id);
  if(previous?.intake||run.intake){
   if(previous&&JSON.stringify(previous)===JSON.stringify(run))return previous;
   validateAssemblyIntake(run);
   const old=await existingIntake(run);
   if(old){if(JSON.stringify(old)===JSON.stringify(run))return old;throw new Error('Конфликт приёмки сборки; запись сохранена');}
  }else{
   if(hasAssemblyOperationLedger(previous)||hasAssemblyOperationLedger(run))return receiveAssemblyOperationRun(run);
   if((await db.assemblyRuns.toArray()).some(r=>(r.intake||hasAssemblyOperationLedger(r))&&r.batchName===run.batchName))throw new Error('Нельзя заменить приёмку старым пакетом');
   if(previous&&previous.updatedAt>=run.updatedAt)return previous;
  }
  await db.assemblyRuns.put(run);return run;
 });
}
