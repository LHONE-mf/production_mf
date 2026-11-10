import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import {
  planningApi, type Batch, type BatchStepRecord, type InspectionKind,
  type InspectionObservation, type InspectionUnit, type InspectionInput,
} from '../../core/planning/planningClient';

type Props={connection:ServerConnection;batch:Batch};
const field='w-full rounded-lg border border-slate-600 bg-slate-900 p-2 text-sm text-white';
const units:InspectionUnit[]=['um','mm','g','mg','mOhm','V','mAh','pct','C'];

/** Online-only, chief-attested findings. Never claims formal QA release. */
export function InspectionObservationPanel({connection,batch}:Props){
  const [steps,setSteps]=useState<BatchStepRecord[]>([]);
  const [records,setRecords]=useState<InspectionObservation[]>([]);
  const [step,setStep]=useState<number|null>(null);
  const [kind,setKind]=useState<InspectionKind>('measurement');
  const [characteristic,setCharacteristic]=useState('');
  const [value,setValue]=useState('');
  const [unit,setUnit]=useState<InspectionUnit>('um');
  const [note,setNote]=useState('');
  const [needsReview,setNeedsReview]=useState(false);
  const [observationId,setObservationId]=useState(()=>crypto.randomUUID());
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');

  const sameSession=()=>getServerConnection()?.session.accessToken===
    connection.session.accessToken;
  async function reload(signal?:AbortSignal){
    const [route,response]=await Promise.all([
      planningApi.stepEvidence(connection,batch.id,signal),
      planningApi.inspections(connection,batch.id,signal),
    ]);
    if(!Array.isArray(route.steps)||!Array.isArray(response.observations))
      throw new Error('Сервер вернул неверный журнал инспекций');
    if(!signal?.aborted&&sameSession()){
      setSteps(route.steps.filter((r,i,all)=>all.findIndex(x=>x.number===r.number)===i));
      setRecords(response.observations);
    }
  }
  useEffect(()=>{
    const controller=new AbortController();
    setSteps([]);setRecords([]);setLoading(true);setError('');setMessage('');
    void reload(controller.signal).catch(cause=>{
      if(controller.signal.aborted)return;
      const msg=cause instanceof Error?cause.message:'Журнал инспекций недоступен';
      setError(msg);
      if(msg.startsWith('HTTP 401'))clearServerConnection();
    }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[batch.id,connection.session.accessToken]);

  function changed(){
    // Never reuse an event ID if the user modifies what it would record.
    setObservationId(crypto.randomUUID());
    setMessage('');
  }
  const selected=step!==null&&steps.some(s=>s.number===step)
    ? step : steps[0]?.number;
  const writable=['in_progress','hold'].includes(batch.status);
  const canSubmit=writable&&!busy&&selected!==undefined&&
    characteristic.trim().length>0 &&
    (kind==='measurement'?value.trim().length>0:note.trim().length>0) &&
    (!needsReview||note.trim().length>0);

  async function submit(event:React.FormEvent){
    event.preventDefault();
    if(!canSubmit||selected===undefined||!sameSession())return;
    const common={
      observationId,characteristic:characteristic.trim(),attentionRequired:needsReview,
    };
    const body:InspectionInput=kind==='measurement'
      ? {...common,kind,observedValue:value.trim(),observedUnit:unit,
          ...(note.trim()?{note:note.trim()}:{})}
      : {...common,kind,note:note.trim()};
    setBusy(true);setError('');setMessage('');
    try{
      await planningApi.recordInspection(connection,batch.id,selected,body);
      if(!sameSession())return;
      setObservationId(crypto.randomUUID());
      setCharacteristic('');setValue('');setNote('');setNeedsReview(false);
      setMessage('Наблюдение сохранено. Формальное решение о качестве не вынесено.');
      try{await reload();}
      catch(cause){
        setError('Запись создана, но обновление списка не удалось: '+
          (cause instanceof Error?cause.message:'ошибка связи'));
      }
    }catch(cause){
      const msg=cause instanceof Error?cause.message:'Не удалось записать наблюдение';
      setError(msg);
      if(msg.startsWith('HTTP 401'))clearServerConnection();
    }finally{setBusy(false);}
  }

  async function refresh(){
    setLoading(true);setError('');
    try{await reload();}
    catch(cause){
      const msg=cause instanceof Error?cause.message:'Не удалось обновить наблюдения';
      setError(msg);
      if(msg.startsWith('HTTP 401'))clearServerConnection();
    }finally{setLoading(false);}
  }

  return <section className="rounded-lg border border-slate-700 p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium text-white">Журнал контроля качества — наблюдения</h4>
      <button type="button" disabled={loading||busy} onClick={()=>void refresh()}
        className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40">
        Обновить наблюдения
      </button>
    </div>
    <p className="text-xs text-amber-200">
      Наблюдения — не протокол официальной приёмки и не разрешение выпускать партию.
      Нет автоматического сравнения с допусками. При критическом замечании
      отдельно переведите партию в статус «Приостановлена».
      Если ответ сервера потерян, сперва обновите историю, не создавайте новую запись.
    </p>
    {loading&&<p role="status" className="text-sm text-slate-400">Загрузка инспекций…</p>}
    {error&&<p role="alert" className="text-sm text-red-200">{error}</p>}
    {message&&<p role="status" className="text-sm text-emerald-200">{message}</p>}
    {!loading&&records.length===0&&!error&&
      <p className="text-xs text-slate-400">Для этой партии нет зарегистрированных наблюдений.</p>}
    <ol className="space-y-2">
      {records.map(r=><li key={r.id} className="rounded border border-slate-700 bg-slate-950/40 p-2 text-xs text-slate-200">
        <div className="font-medium">
          Этап {r.stepNumber} · {r.characteristic} ·
          {' '}{r.attentionRequired?'Требуется проверка':'Наблюдение'}
        </div>
        <div className="text-slate-300">
          {r.kind==='measurement'?'Измерение':'Визуальное наблюдение'}
          {r.observedValue!==null&&
            <> · {r.observedValue} {r.observedUnit}</>}
          {' · '}{new Date(r.recordedAt).toLocaleString('ru-RU')}
        </div>
        {r.note&&<p className="whitespace-pre-wrap text-slate-400">{r.note}</p>}
      </li>)}
    </ol>
    {writable&&steps.length>0&&<form onSubmit={event=>void submit(event)}
      className="space-y-2 border-t border-slate-700 pt-3">
      <label className="block text-xs text-slate-300">Этап маршрута
        <select aria-label="Этап инспекции" className={field+' mt-1'}
          value={selected??''} disabled={busy}
          onChange={event=>{setStep(Number(event.target.value));changed();}}>
          {steps.map(s=><option key={s.number} value={s.number}>
            {s.number}. {s.name}</option>)}
        </select>
      </label>
      <label className="block text-xs text-slate-300">Тип наблюдения
        <select aria-label="Тип инспекции" className={field+' mt-1'}
          value={kind} disabled={busy}
          onChange={event=>{setKind(event.target.value as InspectionKind);changed();}}>
          <option value="measurement">Измерение</option>
          <option value="visual">Визуальное наблюдение</option>
        </select>
      </label>
      <label className="block text-xs text-slate-300">Контролируемый параметр
        <input aria-label="Параметр инспекции" className={field+' mt-1'}
          maxLength={120} value={characteristic} disabled={busy} required
          onChange={event=>{setCharacteristic(event.target.value);changed();}}
          placeholder="Например, толщина покрытия"/>
      </label>
      {kind==='measurement'&&<div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-slate-300">Измеренное значение
          <input aria-label="Значение инспекции" className={field+' mt-1'}
            inputMode="decimal" value={value} required disabled={busy}
            onChange={event=>{setValue(event.target.value);changed();}}
            placeholder="0.012345"/>
        </label>
        <label className="block text-xs text-slate-300">Единицы
          <select aria-label="Единица инспекции" className={field+' mt-1'}
            value={unit} disabled={busy}
            onChange={event=>{setUnit(event.target.value as InspectionUnit);changed();}}>
            {units.map(x=><option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>}
      <label className="block text-xs text-slate-300">
        Примечание {kind==='visual'||needsReview?'(обязательно)':'(необязательно)'}
        <textarea aria-label="Примечание инспекции" className={field+' mt-1'}
          maxLength={2000} value={note} disabled={busy}
          required={kind==='visual'||needsReview} rows={2}
          onChange={event=>{setNote(event.target.value);changed();}}/>
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-300">
        <input aria-label="Требуется проверка" type="checkbox"
          checked={needsReview} disabled={busy}
          onChange={event=>{setNeedsReview(event.target.checked);changed();}}/>
        Отметить наблюдение как требующее дополнительной проверки
      </label>
      <button type="submit" disabled={!canSubmit}
        className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40">
        Сохранить наблюдение
      </button>
    </form>}
  </section>;
}
