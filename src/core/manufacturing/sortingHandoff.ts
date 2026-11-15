import {db} from '../db';
import type {SortingWorkflow} from '../types';
import {validateSortingWorkflow} from './sortingWorkflowValidation';

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/**
 * Receive a saved station history from another Sorting device.
 * A shared workshop key authenticates only group membership, not the
 * operator. The receiver must already have the identical Cutting record
 * and an approved local specification; packets never install or edit them.
 *
 * Keep the longest validated immutable station prefix. Retried/stale
 * handoffs are idempotent; contradictory ones never replace local work.
 */
export async function receiveSortingHandoff(payload:unknown):Promise<SortingWorkflow>{
  if(!payload || typeof payload!=='object' || Array.isArray(payload))
    throw new Error('Некорректный пакет станции сортировки');
  const incoming=payload as SortingWorkflow;
  validateSortingWorkflow(incoming);
  // The Mass operator finalizes on the final workstation and transfers the
  // resulting sort-run. Never clone a fully inspected but unfinalized batch to
  // two devices, which could otherwise issue different final report IDs.
  if(incoming.stages.length===0 || incoming.stages.length>2 ||
    incoming.finalizedSortRunId!==undefined)
    throw new Error('Передача станций доступна только после Visual или Thickness; Mass завершает сортировку и передаёт итог');
  return db.transaction('rw',[db.sortingWorkflows,db.cuttingRuns,db.sortSpecs,db.sortRuns],async()=>{
    const source=await db.cuttingRuns.get(incoming.cutRunId);
    const spec=await db.sortSpecs.get(incoming.specSnapshot.id);
    if(!same(source,incoming.cutRunSnapshot) || !same(spec,incoming.specSnapshot))
      throw new Error('Для приёма нужны совпадающая партия нарезки и утверждённая локальная версия КД. Пакет не заменяет КД');
    const existing=await db.sortingWorkflows.get(incoming.id);
    if(existing){
      validateSortingWorkflow(existing);
      if(existing.mode!==incoming.mode ||
        !same(existing.cutRunSnapshot,incoming.cutRunSnapshot) ||
        !same(existing.specSnapshot,incoming.specSnapshot) ||
        existing.createdBy!==incoming.createdBy || existing.createdAt!==incoming.createdAt)
        throw new Error('Режим или исходные данные сортировки расходятся; локальная история сохранена');
      const common=Math.min(existing.stages.length,incoming.stages.length);
      for(let i=0;i<common;i++){
        if(!same(existing.stages[i],incoming.stages[i]))
          throw new Error('Конфликт записей инспекции: принятые решения нельзя заменять');
      }
      // Existing final result and longer history take priority over stale packets.
      if(existing.stages.length>=incoming.stages.length)return existing;
      if(existing.finalizedSortRunId)throw new Error('Сортировка уже завершена');
      const next:SortingWorkflow={...existing,stages:incoming.stages,
        updatedAt:Math.max(Date.now(),existing.updatedAt+1,incoming.updatedAt)};
      validateSortingWorkflow(next);
      await db.sortingWorkflows.put(next);
      return next;
    }
    const old=(await db.sortRuns.toArray()).some(row=>row.cutRunId===incoming.cutRunId ||
      (!row.cutRunId&&(row.batchName===incoming.cutRunSnapshot.incomingId ||
      row.specId===incoming.specSnapshot.id)));
    if(old)throw new Error('Для партии уже есть итог сортировки; импорт станций запрещён');
    await db.sortingWorkflows.add(incoming);
    return incoming;
  });
}
