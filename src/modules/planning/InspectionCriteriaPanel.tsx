import React,{useEffect,useState} from 'react';
import { clearServerConnection,getServerConnection,type ServerConnection }
  from '../../core/sync/serverConnection';
import { planningApi,type InspectionCriterion,type InspectionUnit,type Route,
  type RouteStep } from '../../core/planning/planningClient';

const input='w-full rounded-lg border border-slate-600 bg-slate-900 p-2 text-sm text-white';
const units:InspectionUnit[]=['um','mm','g','mg','mOhm','V','mAh','pct','C'];
type RouteProps={connection:ServerConnection;route:Route;steps:RouteStep[]};
type BatchProps={connection:ServerConnection;batchId:string};

function CriterionRows({criteria}:{criteria:InspectionCriterion[]}) {
  return <div className="space-y-1">
    {!criteria.length&&<p className="text-xs text-slate-400">
      Для этой версии/ветки маршрута контрольные показатели не зарегистрированы.
    </p>}
    <ol className="space-y-1">
      {criteria.map(row=><li key={row.id}
        className="rounded border border-slate-700 bg-slate-950/40 p-2 text-xs text-slate-200">
        <div>Этап {row.stepNumber} · <strong>{row.characteristic}</strong> ({row.unit})</div>
        <div className="text-slate-300">
          {row.lowerLimit===null?'Нижняя граница не задана':'От '+row.lowerLimit}
          {' · '}
          {row.upperLimit===null?'Верхняя граница не задана':'До '+row.upperLimit}
        </div>
        {row.note&&<p className="whitespace-pre-wrap text-slate-400">{row.note}</p>}
      </li>)}
    </ol>
  </div>;
}

/** Reference values only, not QA pass criteria automatically applied to runs. */
export function RouteInspectionCriteriaPanel({connection,route,steps}:RouteProps){
  const [criteria,setCriteria]=useState<InspectionCriterion[]>([]);
  const [frozen,setFrozen]=useState(false);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [step,setStep]=useState(1);
  const [characteristic,setCharacteristic]=useState('');
  const [unit,setUnit]=useState<InspectionUnit>('um');
  const [lower,setLower]=useState('');
  const [upper,setUpper]=useState('');
  const [note,setNote]=useState('');
  const [criterionId,setCriterionId]=useState(()=>crypto.randomUUID());
  const sameSession=()=>getServerConnection()?.session.accessToken===
    connection.session.accessToken;
  async function reload(signal?:AbortSignal) {
    const r=await planningApi.routeInspectionCriteria(connection,route.id,
      route.version,signal);
    if(!Array.isArray(r.criteria))throw new Error('Некорректные требования контроля');
    if(!signal?.aborted&&sameSession()) {
      setCriteria(r.criteria);setFrozen(r.frozen);
    }
  }
  useEffect(()=>{
    const controller=new AbortController();
    setCriteria([]);setError('');setLoading(true);
    void reload(controller.signal).catch(cause=>{
      if(controller.signal.aborted||!sameSession())return;
      const msg=cause instanceof Error?cause.message:'Ошибка загрузки критериев';
      setError(msg);
      if(msg.startsWith('HTTP 401'))clearServerConnection();
    }).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[route.id,route.version,connection.session.accessToken]);
  function changed() {
    setCriterionId(crypto.randomUUID());setMessage('');
  }
  const editable=route.state==='approved'&&!frozen&&
    connection.serverRole==='chief';
  const valid=editable&&!busy&&!loading&&step>0&&
    step<=steps.length&&!!characteristic.trim()&&
    (!!lower.trim()||!!upper.trim());
  async function submit(event:React.FormEvent) {
    event.preventDefault();
    if(!valid||!sameSession())return;
    setError('');setMessage('');setBusy(true);
    try {
      await planningApi.addInspectionCriterion(connection,route.id,route.version,step,{
        criterionId,characteristic:characteristic.trim(),unit,
        ...(lower.trim()?{lowerLimit:lower.trim()}:{}),
        ...(upper.trim()?{upperLimit:upper.trim()}:{}),
        ...(note.trim()?{note:note.trim()}:{}),
      });
      if(!sameSession())return;
      setCriterionId(crypto.randomUUID());
      setCharacteristic('');setLower('');setUpper('');setNote('');
      setMessage('Контрольный показатель сохранён в неизменяемом журнале версии маршрута.');
      try{await reload();}
      catch(cause){if(!sameSession())return;setError('Показатель создан, но обновление не удалось: '+
        (cause instanceof Error?cause.message:'ошибка связи'));}
    }catch(cause){
      if(!sameSession())return;
      const msg=cause instanceof Error?cause.message:'Ошибка записи';
      setError(msg);if(msg.startsWith('HTTP 401'))clearServerConnection();
    }finally{setBusy(false);}
  }
  return <section className="space-y-2 rounded border border-slate-600 p-3">
    <h4 className="font-medium text-white">Контрольные показатели · версия {route.version}</h4>
    <p className="text-xs text-amber-200">
      Справочные границы, не утверждённая методика ОТК и не автоматическая
      приёмка. Новые показатели можно добавить только после утверждения
      маршрута, но до создания первого заказа на эту версию.
    </p>
    {loading&&<p role="status" className="text-xs text-slate-400">Загрузка показателей…</p>}
    {error&&<p role="alert" className="text-xs text-red-200">{error}</p>}
    {message&&<p role="status" className="text-xs text-emerald-200">{message}</p>}
    {!loading&&<CriterionRows criteria={criteria}/>}
    {frozen&&<p className="text-xs text-slate-300">
      Перечень закрыт для добавлений: на эту версию уже создан заказ.
    </p>}
    {editable&&steps.length>0&&<form className="space-y-2"
      onSubmit={event=>void submit(event)}>
      <label className="block text-xs text-slate-300">Этап маршрута
        <select aria-label="Этап для критерия" className={input+' mt-1'}
          disabled={busy} value={step}
          onChange={event=>{setStep(Number(event.target.value));changed();}}>
          {steps.map((s,i)=><option key={i+1} value={i+1}>{i+1}. {s.name}</option>)}
        </select>
      </label>
      <label className="block text-xs text-slate-300">Контролируемый параметр
        <input aria-label="Название критерия" className={input+' mt-1'}
          maxLength={120} value={characteristic} required disabled={busy}
          onChange={event=>{setCharacteristic(event.target.value);changed();}}/>
      </label>
      <label className="block text-xs text-slate-300">Единицы измерения
        <select aria-label="Единицы критерия" className={input+' mt-1'}
          disabled={busy} value={unit}
          onChange={event=>{setUnit(event.target.value as InspectionUnit);changed();}}>
          {units.map(v=><option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-slate-300">Нижняя граница
          <input aria-label="Нижняя граница" className={input+' mt-1'}
            placeholder="Не задана" inputMode="decimal" disabled={busy}
            value={lower} onChange={event=>{setLower(event.target.value);changed();}}/>
        </label>
        <label className="block text-xs text-slate-300">Верхняя граница
          <input aria-label="Верхняя граница" className={input+' mt-1'}
            placeholder="Не задана" inputMode="decimal" disabled={busy}
            value={upper} onChange={event=>{setUpper(event.target.value);changed();}}/>
        </label>
      </div>
      <label className="block text-xs text-slate-300">Пояснение (необязательно)
        <textarea aria-label="Примечание к критерию" className={input+' mt-1'}
          maxLength={2000} value={note} disabled={busy} rows={2}
          onChange={event=>{setNote(event.target.value);changed();}}/>
      </label>
      <button type="submit" disabled={!valid}
        className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40">
        Зафиксировать показатель
      </button>
    </form>}
  </section>;
}

export function BatchInspectionCriteriaPanel({connection,batchId}:BatchProps) {
  const [criteria,setCriteria]=useState<InspectionCriterion[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    setCriteria([]);setLoading(true);setError('');
    void planningApi.batchInspectionCriteria(connection,batchId,controller.signal)
      .then(response=>{
        if(!Array.isArray(response.criteria))throw new Error('Некорректные критерии');
        if(!controller.signal.aborted&&getServerConnection()?.session.accessToken===
          connection.session.accessToken)setCriteria(response.criteria);
      })
      .catch(cause=>{
        if(controller.signal.aborted||getServerConnection()?.session.accessToken!==connection.session.accessToken)return;
        const msg=cause instanceof Error?cause.message:'Критерии недоступны';
        setError(msg);if(msg.startsWith('HTTP 401'))clearServerConnection();
      })
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[connection.session.accessToken,batchId]);
  return <section className="space-y-2 rounded border border-slate-700 p-3">
    <h4 className="font-medium text-white">Справочные критерии для ветки партии</h4>
    <p className="text-xs text-amber-200">
      Перечень версии маршрута; приложение не определяет соответствие
      измерений допускам и не подтверждает выпуск продукции.
    </p>
    {loading&&<p role="status" className="text-xs text-slate-400">Загрузка критериев…</p>}
    {error&&<p role="alert" className="text-xs text-red-200">{error}</p>}
    {!loading&&!error&&<CriterionRows criteria={criteria}/>}
  </section>;
}
