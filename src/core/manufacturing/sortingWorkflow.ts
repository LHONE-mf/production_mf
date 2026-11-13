import {db} from '../db';
import {StageId,type CutRun,type SortRun,type SortSpec,type SortingMode,type SortingStationResult,type SortingWorkflow} from '../types';
import {validateSortPartition} from './sortingAllocation';
import {validateSortingWorkflow} from './sortingWorkflowValidation';

type StationDecision=Omit<SortingStationResult,'inputCount'|'recordedAt'>;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const nonempty=(v:string)=>typeof v==='string'&&v.trim().length>0;

/** Locks the selected mode, physical cutting source, and specification version. */
export async function startSortingWorkflow(source:CutRun,spec:SortSpec,mode:SortingMode,createdBy:string):Promise<SortingWorkflow>{
  if(!nonempty(createdBy))throw new Error('Укажите оператора/автора');
  const now=Date.now();
  const draft:SortingWorkflow={id:source.id,cutRunId:source.id,cutRunSnapshot:source,
    specSnapshot:spec,mode,stages:[],createdBy,createdAt:now,updatedAt:now};
  validateSortingWorkflow(draft);
  return db.transaction('rw',db.cuttingRuns,db.sortSpecs,db.sortRuns,db.sortingWorkflows,async()=>{
    const previous=await db.sortingWorkflows.get(source.id);
    if(previous){
      if(previous.mode===mode && same(previous.cutRunSnapshot,source) && same(previous.specSnapshot,spec))
        return previous; // exact retry or resume, never reset completed station decisions
      throw new Error('Для партии уже назначен другой режим или версия КД');
    }
    const old=(await db.sortRuns.toArray()).some(row=>row.cutRunId===source.id ||
      (!row.cutRunId && (row.batchName===source.incomingId || row.specId===spec.id)));
    if(old)throw new Error('Партия уже имеет историю сортировки; нельзя начинать новый разнос');
    const current=await db.cuttingRuns.get(source.id),currentSpec=await db.sortSpecs.get(spec.id);
    if(!same(current,source)||!same(currentSpec,spec))
      throw new Error('Источник или спецификация изменены; откройте актуальную версию');
    await db.sortingWorkflows.add(draft);
    return draft;
  });
}

/** Saves an operator's completed station result; incoming count comes only from predecessor. */
export async function recordSortingStation(workflowId:string,decision:StationDecision):Promise<SortingWorkflow>{
  return db.transaction('rw',db.sortingWorkflows,async()=>{
    const current=await db.sortingWorkflows.get(workflowId);
    if(!current)throw new Error('Партия сортировки не найдена');
    validateSortingWorkflow(current);
    const previous=current.stages.find(s=>s.station===decision.station);
    if(previous){
      const {inputCount:unusedInput,recordedAt:unusedTime,...savedDecision}=previous;
      if(same(savedDecision,decision))return current; // exact retry
      throw new Error('Сохранённое решение станции нельзя незаметно изменить');
    }
    if(current.finalizedSortRunId)throw new Error('Партия уже завершена');
    const index=current.stages.length;
    if(decision.station !== (['visual','thickness','mass'] as const)[index])
      throw new Error('Нельзя пропустить станцию или поменять порядок контроля');
    const inputCount=index===0?current.cutRunSnapshot.goodCount:current.stages[index-1].passedCount;
    const next:SortingWorkflow={...current,updatedAt:Math.max(Date.now(),current.updatedAt+1),
      stages:[...current.stages,{...decision,inputCount,recordedAt:Date.now()}]};
    validateSortingWorkflow(next);
    await db.sortingWorkflows.put(next);
    return next;
  });
}

/** Commits the immutable station history and ordinary sort-run handover as one transaction. */
export async function completeSortingWorkflow(workflowId:string,resultId:string):Promise<SortRun>{
  if(!nonempty(resultId))throw new Error('Укажите ID результата сортировки');
  return db.transaction('rw',db.sortingWorkflows,db.sortRuns,db.cuttingRuns,async()=>{
    const current=await db.sortingWorkflows.get(workflowId);
    if(!current)throw new Error('Партия сортировки не найдена');
    validateSortingWorkflow(current);
    if(current.finalizedSortRunId){
      if(current.finalizedSortRunId!==resultId)throw new Error('Результат сортировки уже сохранён с другим ID');
      const saved=await db.sortRuns.get(resultId);
      if(!saved)throw new Error('Итоговая запись отсутствует; нужна проверка журнала');
      validateSortPartition(saved);
      return saved;
    }
    if(current.stages.length!==3)throw new Error('Все три станции должны быть завершены');
    const source=await db.cuttingRuns.get(current.cutRunId);
    if(!same(source,current.cutRunSnapshot))
      throw new Error('Исходная запись нарезки изменилась; остановите завершение для проверки');
    const existing=(await db.sortRuns.toArray()).some(r=>r.id===resultId ||
      r.cutRunId===current.cutRunId || (!r.cutRunId &&
      (r.batchName===current.cutRunSnapshot.incomingId||r.specId===current.specSnapshot.id)));
    if(existing)throw new Error('Партия уже распределена или есть конфликт с историей');
    const complete:SortingWorkflow={...current,finalizedSortRunId:resultId,
      updatedAt:Math.max(Date.now(),current.updatedAt+1)};
    validateSortingWorkflow(complete);
    const mass=complete.stages[2],now=Date.now();
    const buckets=complete.mode==='grading'
      ? mass.grades!.map(grade=>({categoryName:grade.categoryName,count:grade.count}))
      : [{categoryName:'PASS',count:mass.passedCount}];
    const run:SortRun={id:resultId,sortingWorkflow:complete,cutRunId:complete.cutRunId,
      cutRunSnapshot:complete.cutRunSnapshot,specSnapshot:complete.specSnapshot,
      specId:complete.specSnapshot.id,batchName:complete.cutRunSnapshot.incomingId,
      goodCount:complete.cutRunSnapshot.goodCount,buckets,
      rejected:complete.stages.reduce((n,s)=>n+s.rejectedCount,0),workerId:mass.workerId,
      createdAt:now,updatedAt:now};
    validateSortPartition(run);
    await db.sortRuns.add(run);
    await db.sortingWorkflows.put(complete);
    return run;
  });
}
