import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type BatchHandoff } from '../../core/planning/planningClient';

const buttonClass='rounded-lg border border-slate-600 px-3 py-2 text-sm text-white disabled:opacity-40';
type OutboundHistory={batchId:string;handoffs:BatchHandoff[];hasMore:boolean};
function validHistory(data:unknown,batchId:string):data is OutboundHistory{
  if(!data || typeof data!=='object')return false;
  const response=data as Partial<OutboundHistory>;
  return response.batchId===batchId && typeof response.hasMore==='boolean' &&
    Array.isArray(response.handoffs) && response.handoffs.length<=200 &&
    response.handoffs.every((record:unknown)=>{
      if(!record || typeof record!=='object')return false;
      const h=record as Partial<BatchHandoff>;
      return typeof h.id==='string' && h.id.length>0 &&
        Number.isSafeInteger(h.fromStep) && (h.fromStep??0)>0 &&
        Number.isSafeInteger(h.toStep) && (h.toStep??0)>(h.fromStep??0) &&
        typeof h.fromWorkshopId==='string' && h.fromWorkshopId.length>0 &&
        typeof h.toWorkshopId==='string' && h.toWorkshopId.length>0 &&
        typeof h.quantity==='string' && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(h.quantity) &&
        ['cells','pieces','kg','m','m2'].includes(h.quantityUnit??'') &&
        typeof h.sentBy==='string' && h.sentBy.length>0 &&
        typeof h.sentAt==='string' && !Number.isNaN(Date.parse(h.sentAt)) &&
        (h.note===null || typeof h.note==='string') &&
        (h.receivedBy===null || typeof h.receivedBy==='string') &&
        (h.receivedAt===null ||
          (typeof h.receivedAt==='string' && !Number.isNaN(Date.parse(h.receivedAt)))) &&
        (h.receivedBy===null)===(h.receivedAt===null) &&
        (h.receiptNote===null || typeof h.receiptNote==='string');
    });
}

/** Outbound audit read only. Membership filtering lives on the server. */
export function WorkshopOutboundHistoryPanel({connection,batchId,refreshVersion=0}:{
  connection:ServerConnection;batchId:string;refreshVersion?:number;
}){
  const [rows,setRows]=useState<BatchHandoff[]>([]);
  const [hasMore,setHasMore]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [refresh,setRefresh]=useState(0);
  const active=()=>getServerConnection()?.session.accessToken===connection.session.accessToken;
  useEffect(()=>{
    const controller=new AbortController();
    setRows([]);setHasMore(false);setError('');setLoading(true);
    void planningApi.workshopOutboundHandoffs(connection,batchId,controller.signal)
      .then(result=>{
        if(controller.signal.aborted || !active())return;
        if(!validHistory(result,batchId))
          throw new Error('Сервер вернул неверный журнал передач');
        setRows(result.handoffs);setHasMore(result.hasMore);
      })
      .catch(cause=>{
        if(controller.signal.aborted || !active())return;
        const message=cause instanceof Error?cause.message:'Не удалось загрузить передачи';
        setError(message);
        if(message.startsWith('HTTP 401'))clearServerConnection();
      })
      .finally(()=>{if(!controller.signal.aborted && active())setLoading(false);});
    return ()=>controller.abort();
  },[connection.session.accessToken,batchId,refreshVersion,refresh]);
  return <section className="space-y-2 rounded-lg border border-slate-700 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium text-white">Передачи из моих цехов</h4>
      <button type="button" className={buttonClass} disabled={loading}
        onClick={()=>setRefresh(value=>value+1)}>Обновить историю</button>
    </div>
    <p className="text-xs text-slate-400">Только исходящие передачи из назначенных вам цехов.
      Приёмка фиксируется другим сотрудником; остатки материалов здесь не меняются.</p>
    {loading && <p role="status" className="text-sm text-slate-400">Загружаем передачи…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {!loading && !error && rows.length===0 &&
      <p className="text-sm text-slate-400">Исходящих передач пока нет.</p>}
    {hasMore && <p className="text-sm text-amber-200">Отображены первые 200 передач. Журнал может быть неполным.</p>}
    {rows.map(h=><div key={h.id} className="space-y-1 rounded-md bg-slate-950/50 p-2 text-sm text-slate-200">
      <p>{h.fromStep} → {h.toStep} · {h.quantity} {h.quantityUnit}</p>
      <p className="text-xs text-slate-400">{h.fromWorkshopId} → {h.toWorkshopId}</p>
      <p className="text-xs text-slate-300">Отправлено: {new Date(h.sentAt).toLocaleString('ru-RU')}
        {' '}· {h.receivedAt?'Получено':'Ожидает приёмки'}
      </p>
      <p className="text-xs text-slate-400">Отправитель: {h.sentBy}</p>
      {h.note && <p className="text-xs whitespace-pre-wrap text-slate-300">{h.note}</p>}
      {h.receivedAt && <p className="text-xs text-slate-300">
        Получатель: {h.receivedBy} · {new Date(h.receivedAt).toLocaleString('ru-RU')}
      </p>}
      {h.receiptNote && <p className="text-xs whitespace-pre-wrap text-slate-300">
        Приёмка: {h.receiptNote}
      </p>}
    </div>)}
  </section>;
}
