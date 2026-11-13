import {db} from '../db';
import type {CutRun,SortRun,SortSpec} from '../types';
import {validateSortingWorkflow,validateSortingWorkflowOutput} from './sortingWorkflowValidation';

const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function validateSortPartition(run:SortRun):void {
 if(run?.sortingWorkflow)validateSortingWorkflowOutput(run);
 if(!run||typeof run.id!=='string'||!run.id||!count(run.goodCount)||run.goodCount===0||!count(run.rejected)||!Array.isArray(run.buckets))throw new Error('Количество должно быть целым, неотрицательным и точно представимым');
 const names=new Set<string>();let total=run.rejected;
 for(const bucket of run.buckets){
  if(!bucket||typeof bucket.categoryName!=='string'||!bucket.categoryName.trim()||names.has(bucket.categoryName)||!count(bucket.count))throw new Error('Категории должны быть уникальны, количества — целыми и неотрицательными');
  names.add(bucket.categoryName);total+=bucket.count;
  if(bucket.count===0&&(bucket.avgThicknessUm!==undefined||bucket.avgMassG!==undefined))throw new Error('Нельзя указать среднее измерение для пустой категории');
  for(const value of [bucket.avgThicknessUm,bucket.avgMassG])if(value!==undefined&&(!Number.isFinite(value)||value<=0))throw new Error('Введённые измерения должны быть положительными; неизвестные оставьте пустыми');
 }
 if(!Number.isSafeInteger(total)||total!==run.goodCount)throw new Error('Разнесённые и отбракованные электроды должны точно составлять входное количество');
 if(run.cutRunId!==undefined){
  const source=run.cutRunSnapshot,spec=run.specSnapshot;
  if(typeof run.specId!=='string'||!run.specId||typeof run.cutRunId!=='string'||!run.cutRunId||typeof run.batchName!=='string'||!run.batchName||!source||!spec||source.id!==run.cutRunId||source.goodCount!==run.goodCount||source.incomingId!==run.batchName||
    spec.id!==run.specId||spec.cutRunId!==source.id||!['strip','prismatic'].includes(source.electrodeType)||spec.electrodeType!==source.electrodeType||!Array.isArray(spec.categories)||!spec.categories.length||spec.categories.some(c=>!c||typeof c.name!=='string'||!c.name.trim())||
    typeof run.workerId!=='string'||!run.workerId.trim()||!Number.isFinite(run.createdAt)||run.createdAt<=0||!Number.isFinite(new Date(run.createdAt).getTime()))throw new Error('Источник и версия спецификации сортировки не подтверждены');
  const categories=spec.categories.map(c=>c.name);
  if(new Set(categories).size!==categories.length||run.buckets.some(b=>!categories.includes(b.categoryName)&&!(run.sortingWorkflow?.mode==='pass-fail'&&b.categoryName==='PASS')))throw new Error('Результат не соответствует категориям сохранённой спецификации');
 }
}
/** Called within a transaction shared by local creation and receipt. */
async function insertAllocation(run:SortRun):Promise<SortRun>{
 const existing=await db.sortRuns.get(run.id);
 if(existing){
  if(JSON.stringify(existing)===JSON.stringify(run))return existing;
  throw new Error('ID сортировки уже используется. Исходная запись сохранена.');
 }
 const rows=await db.sortRuns.toArray();
 if(rows.some(row=>run.cutRunId?row.cutRunId===run.cutRunId||!row.cutRunId&&(row.specId===run.specId||row.batchName===run.batchName):
    !!row.cutRunId&&(row.specId===run.specId||row.batchName===run.batchName)))
  throw new Error('Партия уже распределена или есть неоднозначная старая запись. Проверьте историю; повторная запись не создана.');
 await db.sortRuns.add(run);return run;
}
export async function saveSortingAllocation(source:CutRun,spec:SortSpec,result:Pick<SortRun,'id'|'buckets'|'rejected'|'notes'|'defects'>,workerId:string):Promise<SortRun>{
 if(!workerId)throw new Error('Войдите в профиль');
 const now=Date.now();
 const run:SortRun={...result,cutRunId:source.id,cutRunSnapshot:source,specSnapshot:spec,specId:spec.id,
   batchName:source.incomingId,goodCount:source.goodCount,workerId,createdAt:now,updatedAt:now};
 validateSortPartition(run);
 return db.transaction('rw',db.cuttingRuns,db.sortSpecs,db.sortRuns,db.sortingWorkflows,async()=>{
  const previous=await db.sortRuns.get(run.id);
  if(previous)return insertAllocation({...run,createdAt:previous.createdAt,updatedAt:previous.updatedAt});
  if(await db.sortingWorkflows.get(source.id))throw new Error('Партия уже проходит трёхстанционную сортировку; старый одностадийный разнос запрещён');
  const current=await db.cuttingRuns.get(source.id),currentSpec=await db.sortSpecs.get(spec.id);
  if(!current||!currentSpec||JSON.stringify(current)!==JSON.stringify(source)||JSON.stringify(currentSpec)!==JSON.stringify(spec))
   throw new Error('Партия или спецификация изменена. Выберите источник заново и проверьте значения.');
  return insertAllocation(run);
 });
}
export async function receiveSortingAllocation(run:SortRun):Promise<SortRun>{
 return db.transaction('rw',db.sortRuns,db.sortingWorkflows,async()=>{
  validateSortPartition(run);
  const previous=await db.sortRuns.get(run.id);
  if(previous){
   if(JSON.stringify(previous)!==JSON.stringify(run))
    throw new Error('Итог сортировки с этим ID отличается от сохранённого');
   // A replay must not silently reconcile an inconsistent local workflow.
   if(run.cutRunId){
    const local=await db.sortingWorkflows.get(run.cutRunId);
    if(local)assertCompatibleFinalWorkflow(local,run);
   }
   return previous;
  }
  const local=run.cutRunId && await db.sortingWorkflows.get(run.cutRunId);
  if(local)assertCompatibleFinalWorkflow(local,run);
  const saved=await insertAllocation(run);
  // The Visual/Thickness device may already hold an immutable station prefix.
  // Receiving the Mass final report must close that prefix atomically so
  // operators cannot continue an already finalized batch locally.
  if(local && run.sortingWorkflow){
   await db.sortingWorkflows.put(run.sortingWorkflow);
  }
  return saved;
 });
}

/** A final report can extend, but never contradict, locally recorded stations. */
function assertCompatibleFinalWorkflow(local:import('../types').SortingWorkflow,run:SortRun):void {
 validateSortingWorkflow(local);
 const final=run.sortingWorkflow;
 if(!final || !run.cutRunId || local.cutRunId!==run.cutRunId ||
   local.mode!==final.mode || local.createdBy!==final.createdBy ||
   local.createdAt!==final.createdAt ||
   JSON.stringify(local.cutRunSnapshot)!==JSON.stringify(final.cutRunSnapshot) ||
   JSON.stringify(local.specSnapshot)!==JSON.stringify(final.specSnapshot))
  throw new Error('Итог сортировки не соответствует локальной партии, КД или режиму; история сохранена');
 if(local.finalizedSortRunId && local.finalizedSortRunId!==run.id)
  throw new Error('Для партии уже записан другой итог сортировки');
 if(local.stages.length>final.stages.length ||
   local.stages.some((stage,i)=>JSON.stringify(stage)!==JSON.stringify(final.stages[i])))
  throw new Error('Итог сортировки противоречит сохранённым решениям станций; история сохранена');
}
