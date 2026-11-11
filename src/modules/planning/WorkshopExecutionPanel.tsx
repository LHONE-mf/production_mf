import React, { useEffect, useRef, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type BatchStatus, type WorkshopBatch } from '../../core/planning/planningClient';
import { StepEvidencePanel } from './StepEvidencePanel';
import { WorkshopHandoffPanel } from './WorkshopHandoffPanel';
import { WorkshopOutboundHistoryPanel } from './WorkshopOutboundHistoryPanel';

const statusNames: Record<BatchStatus,string> = {
  created: 'Создана', in_progress: 'В работе', hold: 'Приостановлена',
  completed: 'Завершена', scrapped: 'Списана',
};
const buttonClass = 'rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-100';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type BatchPage={batches:WorkshopBatch[];hasMore:boolean;nextAfter:string|null};
function validList(value:unknown):value is BatchPage {
  if (!value || typeof value !== 'object') return false;
  const result = value as {batches?:unknown;hasMore?:unknown;nextAfter?:unknown};
  return typeof result.hasMore==='boolean' &&
    (result.nextAfter===null || (typeof result.nextAfter==='string' && uuid.test(result.nextAfter))) &&
    result.hasMore===Boolean(result.nextAfter) && Array.isArray(result.batches) &&
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
  const [nextAfter,setNextAfter]=useState<string|null>(null);
  const [loadingMore,setLoadingMore]=useState(false);
  const [moreError,setMoreError]=useState('');
  const epoch=useRef(0);
  const pendingMore=useRef<AbortController|null>(null);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [outboundVersion,setOutboundVersion]=useState(0);
  const [refreshKey,setRefreshKey]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const currentSession=()=>getServerConnection()?.session.accessToken===connection.session.accessToken;
  useEffect(()=>{
    const controller=new AbortController();
    const generation=++epoch.current;
    pendingMore.current?.abort();
    setLoading(true);setLoadingMore(false);setError('');setMoreError('');
    setBatches([]);setNextAfter(null);
    void planningApi.workshopBatches(connection,controller.signal)
      .then(result=>{
        if(controller.signal.aborted || generation!==epoch.current || !currentSession())return;
        if(!validList(result))throw new Error('Сервер вернул неверный список партий цеха');
        setBatches(result.batches);setNextAfter(result.nextAfter);
      }).catch(cause=>{
        if(controller.signal.aborted || generation!==epoch.current || !currentSession())return;
        const message=cause instanceof Error?cause.message:'Не удалось загрузить партии';
        setError(message);
        if(message.startsWith('HTTP 401'))clearServerConnection();
      }).finally(()=>{
        if(!controller.signal.aborted && generation===epoch.current && currentSession())
          setLoading(false);
      });
    return ()=>{
      controller.abort();pendingMore.current?.abort();epoch.current++;
    };
  },[connection.session.accessToken,refreshKey]);
  async function loadMore(){
    const after=nextAfter;
    if(!after || loading || loadingMore || !currentSession())return;
    const controller=new AbortController();
    const generation=epoch.current;
    pendingMore.current=controller;setLoadingMore(true);setMoreError('');
    try{
      const page=await planningApi.workshopBatches(connection,controller.signal,after);
      if(controller.signal.aborted || generation!==epoch.current || !currentSession())return;
      if(!validList(page) || (page.hasMore && page.nextAfter===after))
        throw new Error('Сервер вернул неверную страницу партий цеха');
      setBatches(previous=>{
        const seen=new Set(previous.map(row=>row.id));
        return [...previous,...page.batches.filter(row=>!seen.has(row.id))];
      });
      setNextAfter(page.nextAfter);
    }catch(cause){
      if(controller.signal.aborted || generation!==epoch.current || !currentSession())return;
      const problem=cause instanceof Error?cause.message:'Не удалось загрузить предыдущие партии';
      setMoreError(problem);
      if(problem.startsWith('HTTP 401'))clearServerConnection();
    }finally{
      if(pendingMore.current===controller)pendingMore.current=null;
      if(generation===epoch.current && currentSession())setLoadingMore(false);
    }
  }
  function refreshList(){
    pendingMore.current?.abort();epoch.current++;setRefreshKey(key=>key+1);
  }
  const selected=batches.find(batch=>batch.id===selectedId);
  return <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/70 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold text-white">Операции назначенных цехов</h2>
      <button type="button" className={buttonClass} onClick={refreshList}
        disabled={loading}>Обновить партии</button>
    </div>
    <p className="text-sm text-slate-400">Только партии с этапами маршрута в ваших текущих цехах.
      Записи выполняются онлайн и не меняют остатки материалов или статусы партии.</p>
    {loading && <p role="status" className="text-sm text-slate-300">Загружаем партии цеха…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {!loading && !error && batches.length===0 &&
      <p className="text-sm text-slate-300">Нет партий для назначенных цехов.</p>}
    {moreError && <p role="alert" className="text-sm text-red-200">{moreError}</p>}
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
      {selected?.id===batch.id && <>
        <StepEvidencePanel key={'evidence:'+batch.id} connection={connection} batch={batch} />
        {batch.status==='in_progress' &&
          <WorkshopHandoffPanel key={'handoff:'+batch.id} connection={connection}
            batchId={batch.id} onSent={()=>setOutboundVersion(value=>value+1)} />}
        <WorkshopOutboundHistoryPanel key={'outbound:'+batch.id} connection={connection}
          batchId={batch.id} refreshVersion={outboundVersion} />
      </>}
    </div>)}
    {nextAfter && <button type="button" className={buttonClass} disabled={loading||loadingMore}
      onClick={()=>void loadMore()}>{loadingMore?'Загрузка…':'Загрузить предыдущие партии'}</button>}
  </section>;
}
