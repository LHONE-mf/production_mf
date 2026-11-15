import {db} from '../../core/db';
import {StageId,type CalenderRun,type CalenderParams,type RollSpec} from '../../core/types';

export interface CalenderDraft {gaps:string;totalLen:string;thickAfter:string;defects:string;hasDef:boolean;notes:string}
export function validateCalenderResult(run:CalenderRun):void {
  if(!run.gapsMm?.length||run.gapsMm.some(n=>!Number.isFinite(n)||n<=0)||
    !Number.isFinite(run.totalLengthM)||!run.totalLengthM||run.totalLengthM<=0||
    !Number.isFinite(run.thicknessAfterUm)||!run.thicknessAfterUm||run.thicknessAfterUm<=0)
    throw new Error('Укажите положительные зазоры, измеренную длину и толщину после прокатки');
}
export function hasCalenderResult(run:CalenderRun):boolean {
  try{validateCalenderResult(run);return true;}catch{return false;}
}
export async function saveCalenderResult(base:CalenderRun,draft:CalenderDraft,workerId:string,journalId:string):Promise<CalenderRun>{
  if(!workerId)throw new Error('Войдите в профиль');
  const tokens=draft.gaps.trim().split(/[;\s]+/);
  if(tokens.some(t=>! /^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(t)))
    throw new Error('Зазоры: разделяйте проходы пробелом или точкой с запятой; дроби — точкой или запятой');
  const measured={gapsMm:tokens.map(t=>Number(t.replace(',','.'))),totalLengthM:Number(draft.totalLen.replace(',','.')),
    thicknessAfterUm:Number(draft.thickAfter.replace(',','.'))};
  validateCalenderResult({...base,...measured});
  return db.transaction('rw',db.calenderRuns,db.journal,db.rollSpecs,async()=>{
    const current=await db.calenderRuns.get(base.id);
    if(!current||current.rollId!==base.rollId||current.updatedAt!==base.updatedAt)
      throw new Error('Запись изменена. Сбросьте черновик и проверьте сохранённые значения перед повторной записью.');
    const updated:CalenderRun={...current,...measured,hasDefects:draft.hasDef||!!draft.defects.trim(),
      defects:draft.defects.trim()||undefined,notes:draft.notes.trim()||undefined,workerId,
      updatedAt:Math.max(Date.now(),current.updatedAt+1)};
    await db.calenderRuns.put(updated);
    const roll=await db.rollSpecs.get(current.rollId);
    await db.journal.add({id:journalId,stage:StageId.CALENDARING,workerId,
      summary:`Прокатка: ${roll?.mixName??current.rollId}${updated.hasDefects?' ⚠ дефекты':''}`,
      params:{'Результат прокатки':updated.id,'Зазоры, мм':updated.gapsMm.join('/'),
        'Длина, м':updated.totalLengthM!,'Толщина после, мкм':updated.thicknessAfterUm!,
        'Усилие прокатки, тс':current.params?.pressureTons??'','Нагрев, °C':current.params?.heatTempC??''},
      defects:updated.defects??'',createdAt:new Date(updated.updatedAt)});
    return updated;
  });
}

/** IndexedDB is the authoritative assignment store; legacy localStorage stays untouched. */
export async function saveCalenderAssignment(roll:RollSpec,params:CalenderParams,workerId:string):Promise<void>{
  await db.transaction('rw',db.calenderRuns,async()=>{
    const current=await db.calenderRuns.get(roll.id);
    const now=Math.max(Date.now(),(current?.updatedAt??0)+1);
    await db.calenderRuns.put(current?{...current,params,updatedAt:now}:{id:roll.id,rollId:roll.id,params,
      gapsMm:[],hasDefects:false,workerId,createdAt:now,updatedAt:now});
  });
}
