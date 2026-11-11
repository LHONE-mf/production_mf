import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import {
  planningApi, type WorkshopHandoffCandidate,
} from '../../core/planning/planningClient';

const fieldClass='w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white';
const buttonClass='rounded-lg border border-sky-600 bg-sky-900/40 px-3 py-2 text-sm text-white disabled:opacity-40';
const quantityPattern=/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;

function validResponse(data:unknown,batchId:string):data is {batchId:string;candidate:WorkshopHandoffCandidate|null}{
  if(!data || typeof data!=='object')return false;
  const value=data as {batchId?:unknown;candidate?:unknown};
  if(value.batchId!==batchId || !('candidate' in value))return false;
  if(value.candidate===null)return true;
  if(!value.candidate || typeof value.candidate!=='object')return false;
  const c=value.candidate as Partial<WorkshopHandoffCandidate>;
  return Number.isSafeInteger(c.fromStep) && (c.fromStep ?? 0)>0 &&
    Number.isSafeInteger(c.toStep) && (c.toStep ?? 0)>(c.fromStep ?? 0) &&
    typeof c.fromName==='string' && c.fromName.length>0 && c.fromName.length<=300 &&
    typeof c.toName==='string' && c.toName.length>0 && c.toName.length<=300 &&
    ['kg','m','m2','cells','pieces'].includes(c.quantityUnit ?? '');
}

/** A transfer declaration is not stock movement; receiver acknowledgement is separate. */
export function WorkshopHandoffPanel({connection,batchId,onSent}:{
  connection:ServerConnection;batchId:string;onSent?:()=>void;
}){
  const [candidate,setCandidate]=useState<WorkshopHandoffCandidate|null>(null);
  const [quantity,setQuantity]=useState('');
  const [note,setNote]=useState('');
  // Keep the same UUID after a lost server reply, until the user edits intent.
  const [handoffId,setHandoffId]=useState(()=>crypto.randomUUID());
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const active=()=>getServerConnection()?.session.accessToken===connection.session.accessToken;
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError('');setCandidate(null);
    void planningApi.workshopHandoffCandidate(connection,batchId,controller.signal)
      .then(data=>{
        if(controller.signal.aborted || !active())return;
        if(!validResponse(data,batchId))throw new Error('Сервер вернул неверную доступную передачу');
        setCandidate(data.candidate);
      })
      .catch(cause=>{
        if(controller.signal.aborted || !active())return;
        const problem=cause instanceof Error?cause.message:'Не удалось проверить передачу';
        setError(problem);
        if(problem.startsWith('HTTP 401'))clearServerConnection();
      })
      .finally(()=>{if(!controller.signal.aborted && active())setLoading(false);});
    return ()=>controller.abort();
  },[connection.session.accessToken,batchId,refresh]);
  const canSend=Boolean(candidate) && quantityPattern.test(quantity.trim()) &&
    (!['cells','pieces'].includes(candidate?.quantityUnit ?? '') || /^\d+$/.test(quantity.trim()));
  async function submit(event:React.FormEvent){
    event.preventDefault();
    if(!candidate || !canSend || busy || !active())return;
    setBusy(true);setError('');setMessage('');
    try{
      const result=await planningApi.sendHandoff(connection,batchId,{
        handoffId,fromStep:candidate.fromStep,toStep:candidate.toStep,
        quantity:quantity.trim(),quantityUnit:candidate.quantityUnit,
        ...(note.trim()?{note:note.trim()}:{}),
      });
      if(!active())return;
      if(!result || result.id!==handoffId ||
        !['sent','already_sent'].includes(result.status))
        throw new Error('Сервер вернул неверное подтверждение передачи');
      setMessage('Передача записана. Другой сотрудник должен подтвердить приёмку.');
      setQuantity('');setNote('');setHandoffId(crypto.randomUUID());
      setRefresh(value=>value+1);
      onSent?.();
    }catch(cause){
      if(!active())return;
      const problem=cause instanceof Error?cause.message:'Не удалось записать передачу';
      setError(problem);
      if(problem.startsWith('HTTP 401'))clearServerConnection();
    }finally{setBusy(false);}
  }
  return <section className="space-y-2 rounded-lg border border-slate-700 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium text-white">Передача на следующий этап</h4>
      <button className={buttonClass} type="button" disabled={loading||busy}
        onClick={()=>setRefresh(value=>value+1)}>Проверить доступность</button>
    </div>
    <p className="text-xs text-slate-400">Проверка выполняется на сервере. Передача не списывает складские остатки.</p>
    {loading && <p role="status" className="text-sm text-slate-300">Проверяем этап…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-200">{message}</p>}
    {!loading && !error && !candidate &&
      <p className="text-sm text-slate-400">Нет доступной передачи: дождитесь завершения этапа и подтверждения предыдущей приёмки.</p>}
    {!loading && candidate &&
      <form className="space-y-2" onSubmit={event=>void submit(event)}>
        <p className="text-sm text-sky-100">{candidate.fromStep}. {candidate.fromName} →
          {' '}{candidate.toStep}. {candidate.toName}</p>
        <label className="block text-xs text-slate-300">Передаваемое количество ({candidate.quantityUnit})
          <input className={fieldClass+' mt-1'} aria-label="Количество передачи цеха" required
            inputMode="decimal" value={quantity}
            onChange={event=>{setQuantity(event.target.value);setHandoffId(crypto.randomUUID());}}/>
        </label>
        <label className="block text-xs text-slate-300">Примечание
          <textarea className={fieldClass+' mt-1'} aria-label="Примечание передачи цеха"
            rows={2} maxLength={2000} value={note}
            onChange={event=>{setNote(event.target.value);setHandoffId(crypto.randomUUID());}}/>
        </label>
        <button type="submit" className={buttonClass} disabled={busy||!canSend}>
          Отправить передачу
        </button>
      </form>}
  </section>;
}
