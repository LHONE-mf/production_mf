import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type BatchStatus, type WorkshopBatch } from '../../core/planning/planningClient';
import { StepEvidencePanel } from './StepEvidencePanel';

const statusNames: Record<BatchStatus,string> = {
  created: 'Создана', in_progress: 'В работе', hold: 'Приостановлена',
  completed: 'Завершена', scrapped: 'Списана',
};
const buttonClass = 'rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-100';

function validList(value: unknown): value is {batches: WorkshopBatch[];hasMore:boolean} {
  if (!value || typeof value !== 'object') return false;
  const result = value as {batches?:unknown;hasMore?:unknown};
  return typeof result.hasMore === 'boolean' && Array.isArray(result.batches) &&
    result.batches.length <= 100 && result.batches.every((row:unknown) => {
      if (!row || typeof row !== 'object') return false;
      const item = row as Partial<WorkshopBatch>;
      return typeof item.id==='string' && item.id.length>0 &&
        typeof item.batchCode==='string' && item.batchCode.length>0 &&
        ['created','in_progress','hold','completed','scrapped'].includes(item.status ?? '') &&
        ['cells','pieces','kg','m','m2'].includes(item.quantityUnit ?? '');
    });
}

/** Server-only execution list: no chief order metadata or local demo records. */
export function WorkshopExecutionPanel({connection}:{connection:ServerConnection}) {
  const [batches,setBatches]=useState<WorkshopBatch[]>([]);
  const [hasMore,setHasMore]=useState(false);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [refreshKey,setRefreshKey]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const currentSession=()=>getServerConnection()?.session.accessToken===connection.session.accessToken;
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError('');setBatches([]);setHasMore(false);
    void planningApi.workshopBatches(connection,controller.signal)
      .then(result=>{
        if(controller.signal.aborted || !currentSession())return;
        if(!validList(result))throw new Error('Сервер вернул неверный список партий цеха');
        setBatches(result.batches);setHasMore(result.hasMore);
      }).catch(cause=>{
        if(controller.signal.aborted || !currentSession())return;
        const message=cause instanceof Error?cause.message:'Не удалось загрузить партии';
        setError(message);
        if(message.startsWith('HTTP 401'))clearServerConnection();
      }).finally(()=>{
        if(!controller.signal.aborted && currentSession())setLoading(false);
      });
    return ()=>controller.abort();
  },[connection.session.accessToken,refreshKey]);
  const selected=batches.find(batch=>batch.id===selectedId);
  return <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/70 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold text-white">Операции назначенных цехов</h2>
      <button type="button" className={buttonClass} onClick={()=>setRefreshKey(key=>key+1)}
        disabled={loading}>Обновить партии</button>
    </div>
    <p className="text-sm text-slate-400">Только партии с этапами маршрута в ваших текущих цехах.
      Записи выполняются онлайн и не меняют остатки материалов или статусы партии.</p>
    {loading && <p role="status" className="text-sm text-slate-300">Загружаем партии цеха…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {!loading && !error && batches.length===0 &&
      <p className="text-sm text-slate-300">Нет партий для назначенных цехов.</p>}
    {hasMore && <p className="text-sm text-amber-200">Показаны последние 100 партий. Более старые пока не загружены.</p>}
    {batches.map(batch=><div className="rounded-lg border border-slate-600 p-3 space-y-2" key={batch.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-white">{batch.batchCode}</p>
          <p className="text-xs text-slate-300">{statusNames[batch.status]} · {batch.quantityUnit}</p>
        </div>
        <button className={buttonClass} type="button"
          onClick={()=>setSelectedId(id=>id===batch.id?null:batch.id)}>
          {selected?.id===batch.id?'Закрыть журнал':'Открыть журнал'}
        </button>
      </div>
      {selected?.id===batch.id &&
        <StepEvidencePanel key={batch.id} connection={connection} batch={batch} />}
    </div>)}
  </section>;
}
