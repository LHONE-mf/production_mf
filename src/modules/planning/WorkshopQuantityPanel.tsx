import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type WorkshopQuantityStep } from '../../core/planning/planningClient';

type Comparison={batchId:string;hasMore:boolean;steps:WorkshopQuantityStep[]};
const units=['kg','m','m2','cells','pieces'];
const decimal=/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const positive=/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const buttonClass='rounded-lg border border-slate-600 px-3 py-2 text-sm text-white disabled:opacity-40';

// Exact base-10 arithmetic, no floating-point rounding in the verification UI.
function scaled(value:string):bigint{
  const [whole,fraction='']=value.split('.');
  const sign=whole.startsWith('-')?-1n:1n;
  return sign*(BigInt(whole.startsWith('-')?whole.slice(1):whole)*1000000n+
    BigInt(fraction.padEnd(6,'0')));
}
function validComparison(data:unknown,batchId:string):data is Comparison{
  if(!data || typeof data!=='object')return false;
  const result=data as Partial<Comparison>;
  return result.batchId===batchId && typeof result.hasMore==='boolean' &&
    Array.isArray(result.steps) && result.steps.length<=200 &&
    result.steps.every((row:unknown)=>{
      if(!row || typeof row!=='object')return false;
      const s=row as Partial<WorkshopQuantityStep>;
      if(!Number.isSafeInteger(s.number) || (s.number??0)<=0 ||
        typeof s.name!=='string' || !s.name ||
        typeof s.workshopId!=='string' || !s.workshopId ||
        !(s.nextStep===null ||
          (Number.isSafeInteger(s.nextStep) && (s.nextStep??0)>(s.number??0))))return false;
      const amount=(v:unknown):v is {quantity:string;unit:string}=>{
        if(!v || typeof v!=='object')return false;
        const q=v as {quantity?:unknown;unit?:unknown};
        return typeof q.quantity==='string' && positive.test(q.quantity) &&
          typeof q.unit==='string' && units.includes(q.unit);
      };
      if(s.output!==null && !amount(s.output))return false;
      if(s.handoff!==null && (!amount(s.handoff) ||
        typeof s.handoff.id!=='string' || !s.handoff.id ||
        typeof s.handoff.received!=='boolean'))return false;
      if(s.input!==null && (!amount(s.input) ||
        typeof s.input.id!=='string' || !s.input.id ||
        typeof s.input.received!=='boolean'))return false;
      if(s.difference!==null && (typeof s.difference!=='string' ||
        !decimal.test(s.difference)))return false;
      if(s.inputDifference!==null && (typeof s.inputDifference!=='string' ||
        !decimal.test(s.inputDifference)))return false;
      const outboundOk=s.output && s.handoff && s.output.unit===s.handoff.unit
        ? s.difference!==null &&
          scaled(s.output.quantity)-scaled(s.handoff.quantity)===scaled(s.difference)
        : s.difference===null;
      // A sent-but-not-received quantity is not yet accepted material input.
      const incomingOk=s.output && s.input && s.input.received &&
        s.output.unit===s.input.unit
        ? s.inputDifference!==null &&
          scaled(s.input.quantity)-scaled(s.output.quantity)===scaled(s.inputDifference)
        : s.inputDifference===null;
      return outboundOk && incomingOk;
    });
}

/** Comparison of documented declarations only, never material accounting. */
export function WorkshopQuantityPanel({connection,batchId,refreshVersion=0}:{
  connection:ServerConnection;batchId:string;refreshVersion?:number;
}){
  const [steps,setSteps]=useState<WorkshopQuantityStep[]>([]);
  const [hasMore,setHasMore]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const active=()=>getServerConnection()?.session.accessToken===connection.session.accessToken;
  useEffect(()=>{
    const controller=new AbortController();
    setSteps([]);setHasMore(false);setLoading(true);setError('');
    void planningApi.workshopQuantityComparison(connection,batchId,controller.signal)
      .then(data=>{
        if(controller.signal.aborted || !active())return;
        if(!validComparison(data,batchId))
          throw new Error('Сервер вернул неверное сравнение количеств');
        setSteps(data.steps);setHasMore(data.hasMore);
      })
      .catch(cause=>{
        if(controller.signal.aborted || !active())return;
        const message=cause instanceof Error?cause.message:'Не удалось сверить количества';
        setError(message);
        if(message.startsWith('HTTP 401'))clearServerConnection();
      })
      .finally(()=>{if(!controller.signal.aborted && active())setLoading(false);});
    return ()=>controller.abort();
  },[connection.session.accessToken,batchId,refreshVersion,refresh]);
  return <section className="space-y-2 rounded-lg border border-slate-700 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium text-white">Сверка заявленных количеств</h4>
      <button className={buttonClass} type="button" disabled={loading}
        onClick={()=>setRefresh(value=>value+1)}>Обновить сверку</button>
    </div>
    <p className="text-xs text-slate-400">Только ваши этапы. Разности между
      принятым входом, заявленным выходом операции и исходящей передачей
      не доказывают потери, брак или движение склада. Передача без приёмки
      не считается принятым входом. Разные единицы не пересчитываются.</p>
    {loading && <p role="status" className="text-sm text-slate-400">Проверяем количества…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {!loading && !error && steps.length===0 &&
      <p className="text-sm text-slate-400">Нет доступных этапов для сверки.</p>}
    {hasMore && <p className="text-sm text-amber-200">Показаны первые 200 этапов. Сверка неполная.</p>}
    {steps.map(step=><div key={step.number} className="space-y-1 rounded-md bg-slate-950/50 p-2 text-sm">
      <p className="font-medium text-slate-200">{step.number}. {step.name}</p>
      <p className="text-xs text-slate-400">{step.workshopId}</p>
      <p className="text-slate-300">Входящая передача: {step.input?
        step.input.quantity+' '+step.input.unit:'Не зарегистрирована'}</p>
      {step.input && <p className="text-xs text-slate-400">
        {step.input.received?'Входящая приёмка подтверждена':'Входящая приёмка ожидается'}
      </p>}
      {step.inputDifference!==null && <p className="text-sky-200">
        Разность принятого входа и выхода: {step.inputDifference} {step.input?.unit}
      </p>}
      <p className="text-slate-300">Заявленный выход: {step.output?
        step.output.quantity+' '+step.output.unit:'Нет записи о завершении'}</p>
      <p className="text-slate-300">{step.nextStep===null?'Конечный этап маршрута':
        'Передано дальше: '+(step.handoff?
          step.handoff.quantity+' '+step.handoff.unit:
          'Передача ещё не записана')}</p>
      {step.handoff && <p className="text-xs text-slate-400">
        {step.handoff.received?'Приёмка подтверждена':'Ожидает приёмки'}
      </p>}
      {step.difference!==null && <p className="text-sky-200">
        Разность деклараций: {step.difference} {step.output?.unit}
      </p>}
    </div>)}
  </section>;
}
