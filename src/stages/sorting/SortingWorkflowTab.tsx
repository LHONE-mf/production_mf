import React, {useEffect, useRef, useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {v4 as uuidv4} from 'uuid';
import {db} from '../../core/db';
import {completeSortingWorkflow, recordSortingStation, startSortingWorkflow} from '../../core/manufacturing/sortingWorkflow';
import type {CutRun, DefectEntry, SortRun, SortSpec, SortingMode, SortingStation, SortingWorkflow} from '../../core/types';
import {LocalDraftStatus, useLocalFormDraft} from '../_common/useLocalFormDraft';
import {emptySortingDraft, emptyStationDraft, parseSortingDraft, sortingDraftKey, type SortingStationDraft} from './sortingDraft';

const stationOrder: SortingStation[] = ['visual', 'thickness', 'mass'];
const stationName: Record<SortingStation, string> = {
  visual: '1. Визуальный контроль',
  thickness: '2. Контроль толщины',
  mass: '3. Контроль массы',
};
const inputCls = 'w-full min-h-11 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-base text-white focus:outline-none focus:border-blue-400';
const labelCls = 'block text-sm text-slate-300 mb-1';
const count = (value:string):boolean => /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
const message = (reason:unknown):string => reason instanceof Error ? reason.message : 'Не удалось сохранить запись';

interface Props {
  batches:CutRun[];
  specs:SortSpec[];
  defects:DefectEntry[];
  runs:SortRun[];
  selectedBatchId:string|null;
  onSelectBatch:(id:string)=>void;
  workerId?:string;
  onComplete:(run:SortRun)=>void;
  onHandoff:(workflow:SortingWorkflow)=>void;
}

/** Operator entry is based on immutable three-station records, not old summary allocation. */
export function SortingWorkflowTab({batches,specs,defects,runs,selectedBatchId,onSelectBatch,workerId,onComplete,onHandoff}:Props) {
  const [mode,setMode] = useState<SortingMode>('pass-fail');
  const [specId,setSpecId] = useState('');
  const draft=useLocalFormDraft(workerId??'','sorting',emptySortingDraft,parseSortingDraft);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [success,setSuccess] = useState('');
  const lock=useRef(false);
  const batch=batches.find(b=>b.id===selectedBatchId);
  const batchSpecs=specs.filter(s=>s.cutRunId===selectedBatchId && s.batchName===batch?.incomingId &&
    s.electrodeType===batch?.electrodeType).sort((a,b)=>b.updatedAt-a.updatedAt);
  const chosenSpec=batchSpecs.find(s=>s.id===specId)??batchSpecs[0];
  const workflow=useLiveQuery(async()=>
    selectedBatchId ? (await db.sortingWorkflows.get(selectedBatchId)??null) : null,
  [selectedBatchId],null);
  const active=workflow && !workflow.finalizedSortRunId ? stationOrder[workflow.stages.length] : undefined;
  const formKey=workflow&&active ? sortingDraftKey(workflow.id,workflow.stages.length) : null;
  const form=formKey ? draft.value.entries[formKey]??emptyStationDraft() : emptyStationDraft();
  const {passed,rejected,grades,reasonCounts,notes}=form;
  function editForm(patch:Partial<SortingStationDraft>){
    if(!formKey||!draft.ready)return;
    draft.edit(old=>({
      ...old,entries:{...old.entries,[formKey]:{...(old.entries[formKey]??emptyStationDraft()),...patch}},
    }));
  }
  const inputCount=workflow && active
    ? (workflow.stages.length===0 ? workflow.cutRunSnapshot.goodCount : workflow.stages[workflow.stages.length-1].passedCount)
    : 0;
  const gradedMass=active==='mass' && workflow?.mode==='grading';
  const gradeSpecs=workflow?.specSnapshot.categories??[];
  const validGrades=gradedMass && gradeSpecs.every(c=>count(grades[c.name]??''));
  const accepted=gradedMass
    ? gradeSpecs.reduce((sum,c)=>sum+Number(grades[c.name]||0),0)
    : Number(passed||0);
  const typedReasons=Object.entries(reasonCounts).filter(([,v])=>v!=='');
  const validReasons=typedReasons.length===0 || (typedReasons.every(([,v])=>count(v)) &&
    typedReasons.reduce((sum,[,v])=>sum+Number(v),0)===Number(rejected));
  const balanceTotal=accepted+(count(rejected)?Number(rejected):0);
  const balanced=!!active && count(rejected) && (gradedMass?!!validGrades:count(passed)) &&
    Number.isSafeInteger(accepted+Number(rejected)) && accepted+Number(rejected)===inputCount && validReasons;
  const previousStation=workflow && workflow.stages.length>0
    ? workflow.stages[workflow.stages.length-1] : undefined;
  const canFillPassed=!!active && !gradedMass && count(rejected) && Number(rejected)<=inputCount;
  const historical=runs.find(r=>r.cutRunId===batch?.id || (!r.cutRunId && batch &&
    (r.batchName===batch.incomingId || batchSpecs.some(s=>s.id===r.specId))));
  const finalRun=runs.find(r=>workflow?.finalizedSortRunId===r.id);

  useEffect(()=>{
    setError('');setSuccess('');
  },[selectedBatchId,workflow?.stages.length]);

  const changeBatch=(id:string)=>{
    if(busy)return;
    setSpecId('');setMode('pass-fail');onSelectBatch(id);
  };
  const runAction=async(operation:()=>Promise<void>)=>{
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');setSuccess('');
    try{await operation();}
    catch(cause){setError(message(cause));}
    finally{lock.current=false;setBusy(false);}
  };
  const start=()=>runAction(async()=>{
    if(!batch || !chosenSpec || !workerId)throw Error('Выберите партию, КД и профиль оператора');
    await startSortingWorkflow(batch,chosenSpec,mode,workerId);
    setSuccess('Режим и версия КД закреплены за партией.');
  });
  const saveStage=()=>runAction(async()=>{
    if(!workflow || !active || !workerId || !balanced)throw Error('Проверьте баланс и заполненные количества');
    const decisions=gradedMass
      ? gradeSpecs.map(c=>({categoryName:c.name,count:Number(grades[c.name])}))
      : undefined;
    // Flush every queued operator edit before committing a production decision.
    // A failed local checkpoint must not turn an unsaved form into a station record.
    await draft.checkpoint(current=>current);
    await recordSortingStation(workflow.id,{
      station:active,passedCount:accepted,rejectedCount:Number(rejected),workerId,
      grades:decisions,
      rejectionReasons:typedReasons.length
        ? typedReasons.map(([id,value])=>({reason:id,count:Number(value)}))
        : undefined,
      notes:notes.trim()||undefined,
    });
    // The station is already committed. A cleanup failure is not a failed inspection.
    if(formKey)try{
      await draft.checkpoint(old=>{
        const entries={...old.entries};delete entries[formKey];return {...old,entries};
      });
    }catch{
      setSuccess('Результат станции сохранён, но черновик не очищен. Запись производства не потеряна.');
      return;
    }
    setSuccess('Результат станции сохранён. Отбракованные электроды исключены из следующего этапа.');
  });
  const finalize=()=>runAction(async()=>{
    if(!workflow || !workerId || workflow.stages.length!==3)throw Error('Завершите все три станции');
    const saved=await completeSortingWorkflow(workflow.id,uuidv4());
    onComplete(saved);
    setSuccess('Сортировка завершена. Итог сохранён в журнале.');
  });

  return <div className="space-y-4">
    <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4 space-y-3">
      <h3 className="text-white font-semibold">Партия сортировки</h3>
      <div>
        <label className={labelCls} htmlFor="sort-workflow-batch">Партия с нарезки</label>
        <select id="sort-workflow-batch" aria-label="Партия для сортировки" className={inputCls}
          value={selectedBatchId??''} disabled={busy} onChange={e=>changeBatch(e.target.value)}>
          <option value="">— выберите партию —</option>
          {batches.map(b=><option value={b.id} key={b.id}>{b.incomingId} · {b.goodCount} шт · {b.id}</option>)}
        </select>
      </div>
      {!batch && <p className="text-slate-400 text-sm">Выберите партию с нарезки, чтобы начать или продолжить сортировку.</p>}
      {batch && <>
        <p className="text-sm text-slate-300">Поступило с нарезки: <strong className="text-white">{batch.goodCount} шт</strong></p>
        {workflow ? <div className="rounded-lg bg-slate-900 p-3 text-sm space-y-1">
          <p className="text-emerald-300">Партия создана · {workflow.mode==='grading'?'градация по массе':'годен / брак'}</p>
          <p className="text-slate-300">КД: {workflow.specSnapshot.parameterName} · {workflow.specSnapshot.id}</p>
          <p className="text-xs text-slate-400">Режим и версия спецификации закреплены. Уже записанные решения станций не изменяются незаметно.</p>
        </div> : <>
          <div>
            <label className={labelCls} htmlFor="sort-spec">Спецификация технолога (КД)</label>
            <select id="sort-spec" aria-label="Спецификация сортировки" className={inputCls}
              value={chosenSpec?.id??''} onChange={e=>setSpecId(e.target.value)}>
              {batchSpecs.length===0 && <option value="">— нет подходящей КД —</option>}
              {batchSpecs.map(s=><option key={s.id} value={s.id}>{s.parameterName} · {s.id}</option>)}
            </select>
          </div>
          {batchSpecs.length===0 && <p className="text-amber-200 text-sm">Для этой партии нет локальной спецификации. Попросите технолога создать её в разделе «Спецификации КД». Импорт через общий ключ недоступен.</p>}
          <fieldset className="space-y-2">
            <legend className={labelCls}>Режим для этой партии</legend>
            <label className="flex items-center gap-3 min-h-11 text-white">
              <input type="radio" name="sort-mode" value="pass-fail" checked={mode==='pass-fail'}
                onChange={()=>setMode('pass-fail')}/> Годен / брак
            </label>
            <label className="flex items-center gap-3 min-h-11 text-white">
              <input type="radio" name="sort-mode" value="grading" checked={mode==='grading'}
                onChange={()=>setMode('grading')}/> Градация по массе
            </label>
          </fieldset>
          {mode==='grading' && chosenSpec && <div className="rounded-lg bg-slate-900 p-3 space-y-1">
            <p className="text-sm text-white">Массовые диапазоны из КД:</p>
            {chosenSpec.categories.map(c=><p className="text-xs text-slate-300" key={c.name}>
              {c.name}: {c.minMass??'—'}–{c.maxMass??'—'} г
            </p>)}
            <p className="text-xs text-amber-200">Каждый сорт должен иметь заданный массовый диапазон. Оператор назначает сорт вручную на третьей станции.</p>
          </div>}
          {historical && <p className="text-amber-200 text-sm">Для партии уже есть запись в журнале. Новый процесс для неё не создаётся.</p>}
          <button className="w-full sm:w-auto min-h-11 rounded-lg px-4 bg-blue-600 text-white font-medium disabled:opacity-40"
            disabled={busy||!workerId||!chosenSpec||!!historical||batch.goodCount<=0}
            onClick={()=>void start()}>Начать сортировку</button>
        </>}
      </>}
    </div>

    {workflow && <div className="space-y-3">
      <h3 className="text-white font-semibold">Ход контроля · Visual → Thickness → Mass</h3>
      {stationOrder.map((station,index)=>{
        const saved=workflow.stages[index];
        const current=station===active;
        return <div key={station} className={'rounded-xl border p-4 ' +
          (current?'border-blue-500 bg-slate-800':'border-slate-700 bg-slate-800/50')}>
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold text-white">{stationName[station]}</h4>
            <span className={'text-xs '+(saved?'text-emerald-300':current?'text-blue-300':'text-slate-400')}>
              {saved?'Завершено':current?'В работе':'Ожидает'}
            </span>
          </div>
          {saved ? <div className="mt-2 space-y-1 text-sm text-slate-300">
            <p>На входе: {saved.inputCount} · прошло: <b className="text-emerald-300">{saved.passedCount}</b> · брак: <b className="text-rose-300">{saved.rejectedCount}</b></p>
            {saved.grades?.map(g=><p key={g.categoryName}>{g.categoryName}: {g.count} шт</p>)}
            <p className="text-xs text-slate-400">Оператор: {saved.workerId} · {new Date(saved.recordedAt).toLocaleString('ru-RU')}</p>
            {saved.notes && <p className="text-xs text-slate-400">Примечание: {saved.notes}</p>}
            {index===workflow.stages.length-1 && index<2 && !workflow.finalizedSortRunId &&
              <div className="mt-3 space-y-2 rounded-lg border border-blue-700/50 bg-blue-950/20 p-3">
                <p className="text-xs text-slate-300">
                  Следующая станция работает на другом телефоне? Передайте сохранённую историю партии.
                  Получатель должен иметь точно такую же партию нарезки и утверждённую локальную КД.
                  Для приёма откройте «Синхронизация» на другом устройстве.
                </p>
                <button type="button" className="min-h-11 w-full rounded-lg bg-blue-700 px-3 text-sm font-semibold text-white"
                  onClick={()=>onHandoff(workflow)}>
                  📤 Передать станции ({workflow.stages.length}/3) · QR / Bluetooth
                </button>
                <p className="text-[11px] text-amber-200">
                  Общий ключ цеха подтверждает целостность пакета, но не личность оператора.
                  Получатель должен сверить фактическую партию перед инспекцией.
                </p>
              </div>}
          </div> : current && !draft.ready ? <div className="mt-3"><LocalDraftStatus draft={draft} disabled={busy}/></div> : current && <div className="space-y-3 mt-3">
            <div className="rounded-lg bg-blue-950/30 border border-blue-800/60 p-3 space-y-1">
              <p className="text-sm text-white">На входе станции: <strong>{inputCount} шт</strong></p>
              {previousStation && <p className="text-xs text-blue-200">
                По журналу {stationName[previousStation.station]}: прошло {previousStation.passedCount} шт,
                брак {previousStation.rejectedCount} шт · оператор {previousStation.workerId}.
              </p>}
              <p className="text-xs text-slate-400">
                Это количество по журналу предыдущей станции, а не подтверждение физической передачи.
                Перед записью проверьте фактически полученные электроды.
              </p>
            </div>
            <p className="text-xs text-slate-400">Каждый электрод оператор проверяет вручную по КД. Брак сразу удаляется из потока.</p>
            {station==='visual' && <>
              <p className="text-sm text-slate-300">Проверьте внешний вид и допустимые дефекты по утверждённой КД.</p>
              {workflow.specSnapshot.techNotes && <p className="text-xs text-amber-200">{workflow.specSnapshot.techNotes}</p>}
            </>}
            {station==='thickness' && <div className="rounded-lg bg-slate-900 p-3 text-sm space-y-1">
              <p className="text-white">Допуски толщины из КД (мкм):</p>
              {workflow.specSnapshot.categories.map(c=><p key={c.name} className="text-slate-300">
                {c.name}: {c.minUm??'—'}–{c.maxUm??'—'}
              </p>)}
              <p className="text-xs text-amber-200">Толщина проверяется только на годен / брак; сорт здесь не назначается.</p>
            </div>}
            {station==='mass' && <div className="rounded-lg bg-slate-900 p-3 text-sm space-y-1">
              <p className="text-white">Диапазоны массы из КД (г):</p>
              {workflow.specSnapshot.categories.map(c=><p key={c.name} className="text-slate-300">
                {c.name}: {c.minMass??'—'}–{c.maxMass??'—'}
              </p>)}
              <p className="text-xs text-amber-200">{gradedMass?'Распределите электроды по сортам вручную.':'Определите годные и брак вручную.'}</p>
            </div>}
            {!gradedMass && <div>
              <label htmlFor="sort-passed" className={labelCls}>Прошло контроль, шт</label>
              <input id="sort-passed" aria-label="Прошло контроль" type="number" min="0" step="1"
                inputMode="numeric" className={inputCls} value={passed} onChange={e=>editForm({passed:e.target.value})} disabled={busy}/>
            </div>}
            {gradedMass && gradeSpecs.map(c=><div key={c.name}>
              <label className={labelCls} htmlFor={'grade-'+c.name}>{c.name}, шт · {c.minMass??'—'}–{c.maxMass??'—'} г</label>
              <input id={'grade-'+c.name} aria-label={'Количество сорта '+c.name} type="number" min="0" step="1"
                inputMode="numeric" className={inputCls} value={grades[c.name]??''} disabled={busy}
                onChange={e=>editForm({grades:{...grades,[c.name]:e.target.value}})}/>
            </div>)}
            <div>
              <label htmlFor="sort-rejected" className={labelCls}>Отбраковано на станции, шт (включая 0)</label>
              <input id="sort-rejected" aria-label="Отбраковано на станции" type="number" min="0" step="1"
                inputMode="numeric" className={inputCls} value={rejected} onChange={e=>editForm({rejected:e.target.value})} disabled={busy}/>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="min-h-11 rounded-lg border border-slate-600 px-3 text-sm text-white disabled:opacity-40"
                disabled={busy||!draft.ready} onClick={()=>editForm({rejected:'0'})}>
                Указать брак = 0
              </button>
              {!gradedMass && <button type="button" className="min-h-11 rounded-lg border border-slate-600 px-3 text-sm text-white disabled:opacity-40"
                disabled={busy||!draft.ready||!canFillPassed}
                onClick={()=>editForm({passed:String(inputCount-Number(rejected))})}>
                Подставить годные = вход − брак
              </button>}
              {gradedMass && <button type="button" className="min-h-11 rounded-lg border border-slate-600 px-3 text-sm text-white disabled:opacity-40"
                disabled={busy||!draft.ready} onClick={()=>editForm({
                  grades:Object.fromEntries(gradeSpecs.map(c=>[c.name,grades[c.name]===''||grades[c.name]===undefined?'0':grades[c.name]])),
                })}>
                Пустые сорта = 0
              </button>}
            </div>
            <p className="text-xs text-slate-400">Быстрые кнопки только заполняют поля по вашему явному действию. Решение о качестве остаётся за оператором.</p>
            {station==='visual' && defects.length>0 && <details className="rounded-lg border border-slate-700 p-3">
              <summary className="text-sm text-slate-200 cursor-pointer">Причины визуального брака (необязательно)</summary>
              <p className="text-xs text-slate-400 mt-2">Если указываете причины, сумма должна совпадать с количеством брака.</p>
              {defects.map(d=><div key={d.id} className="mt-2">
                <label className={labelCls} htmlFor={'reason-'+d.id}>{d.title} · шт</label>
                <input id={'reason-'+d.id} aria-label={'Брак: '+d.title} type="number" min="0" step="1" inputMode="numeric"
                  className={inputCls} value={reasonCounts[d.id]??''} disabled={busy}
                  onChange={e=>editForm({reasonCounts:{...reasonCounts,[d.id]:e.target.value}})}/>
              </div>)}
            </details>}
            <div>
              <label htmlFor="sort-notes" className={labelCls}>Комментарий оператора (необязательно)</label>
              <textarea id="sort-notes" className={inputCls} rows={2} value={notes} disabled={busy}
                onChange={e=>editForm({notes:e.target.value})}/>
            </div>
            <div className={'rounded-lg p-3 text-sm border '+(balanced
              ?'border-emerald-700 bg-emerald-950/40 text-emerald-200'
              :'border-slate-600 bg-slate-900 text-slate-300')}>
              Учтено: {balanceTotal} из {inputCount} шт.
              {balanced?' ✓ Баланс сходится':' Укажите целые количества без пропусков; сумма должна совпасть с входом.'}
              {!balanced && Number.isSafeInteger(balanceTotal) && balanceTotal!==inputCount && 
                <p className={balanceTotal>inputCount?'text-rose-300':'text-amber-200'}>
                  {balanceTotal<inputCount?'Осталось распределить: '+(inputCount-balanceTotal)+' шт':
                    'Превышение входа: '+(balanceTotal-inputCount)+' шт'}
                </p>}
              {!validReasons&&<p className="text-amber-200">Количество по причинам брака не совпадает с общим браком.</p>}
            </div>
            <p className="text-xs text-slate-400">Оператор: {workerId??'не выбран'}. После записи станция блокируется от незаметного редактирования.</p>
            <LocalDraftStatus draft={draft} disabled={busy}/>
            <button className="w-full min-h-12 rounded-lg bg-blue-600 px-4 text-white font-semibold disabled:opacity-40"
              disabled={busy||!workerId||!draft.ready||!!draft.error||!balanced} onClick={()=>void saveStage()}>
              Сохранить {stationName[station]}
            </button>
          </div>}
          {!saved&&!current && <p className="mt-2 text-xs text-slate-400">Откроется после завершения предыдущей станции.</p>}
        </div>;
      })}
      {workflow.stages.length===3 && <div className="rounded-xl border border-emerald-700/70 bg-slate-800 p-4 space-y-3">
        <h4 className="text-white font-semibold">Итоги сортировки</h4>
        <p className="text-sm text-slate-300">Пришло: {workflow.cutRunSnapshot.goodCount} · брак по всем станциям: {workflow.stages.reduce((n,s)=>n+s.rejectedCount,0)} · годных: {workflow.stages[2].passedCount}</p>
        {workflow.stages[2].grades?.map(g=><p key={g.categoryName} className="text-sm text-slate-200">{g.categoryName}: {g.count} шт</p>)}
        {workflow.finalizedSortRunId ?
          <div className="space-y-2">
            <p className="text-emerald-200 text-sm">Результат в журнале: {workflow.finalizedSortRunId}</p>
            {finalRun && <button className="min-h-11 rounded-lg bg-slate-700 px-4 text-white"
              onClick={()=>onComplete(finalRun)}>Передать сохранённый результат</button>}
          </div> :
          <button className="w-full min-h-12 rounded-lg bg-emerald-700 px-4 text-white font-semibold disabled:opacity-40"
            disabled={busy||!workerId} onClick={()=>void finalize()}>Завершить сортировку и записать в журнал</button>}
        <p className="text-xs text-slate-400">Разнообразные сорта по массе сохраняются отдельно; сборка не смешивает их автоматически.</p>
      </div>}
    </div>}
    {error && <p role="alert" className="rounded-lg bg-rose-950/50 border border-rose-700 p-3 text-sm text-rose-200">{error}</p>}
    {success && <p role="status" className="rounded-lg bg-emerald-950/40 p-3 text-sm text-emerald-200">{success}</p>}
  </div>;
}
