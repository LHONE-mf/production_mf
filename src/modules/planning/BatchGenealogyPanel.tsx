import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type Batch, type BatchGenealogyLink, type GenealogyKind } from '../../core/planning/planningClient';

const buttonClass = 'min-h-11 rounded-lg border border-slate-600 px-3 py-2 text-sm text-sky-200 disabled:opacity-40';
const kinds: Record<GenealogyKind,string> = {
  assembly:'Сборка из электродов',split:'Разделение партии',
  merge:'Объединение партий',consumption:'Связь расходования',
};
type BatchIdentity = Pick<Batch,'id'|'batchCode'>;

/** Read-only navigation; the operation forms remain bound to the original batch. */
export function BatchGenealogyPanel({connection,batch}: {connection:ServerConnection;batch:BatchIdentity}) {
  const [trail,setTrail] = useState<BatchIdentity[]>([batch]);
  const focus = trail[trail.length-1];
  const [links,setLinks] = useState<BatchGenealogyLink[]>([]);
  const [after,setAfter] = useState<string>();
  const [nextAfter,setNextAfter] = useState<string|null>(null);
  const [attempt,setAttempt] = useState(0);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    if (!after) { setLinks([]); setNextAfter(null); }
    void (async () => {
      try {
        const page = await planningApi.batchGenealogy(connection,focus.id,controller.signal,after);
        if (controller.signal.aborted ||
            getServerConnection()?.session.accessToken !== connection.session.accessToken) return;
        if (after && page.links.some(link => links.some(existing => existing.id === link.id)))
          throw new Error('Сервер повторил уже загруженные связи; обновите историю');
        setLinks(previous => after ? [...previous,...page.links] : page.links);
        setNextAfter(page.nextAfter);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : 'Не удалось загрузить связи';
        setError(message);
        if (message.startsWith('HTTP 401')) clearServerConnection();
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [focus.id,connection.session.accessToken,after,attempt]);

  function navigate(path: BatchIdentity[]) {
    setTrail(path); setAfter(undefined); setNextAfter(null);
    setLinks([]); setError(''); setLoading(true);
  }
  function open(id: string, batchCode: string) {
    const index = trail.findIndex(item => item.id === id);
    navigate(index < 0 ? [...trail,{id,batchCode}] : trail.slice(0,index+1));
  }

  return <section className="space-y-3" aria-label="Просмотр происхождения партии">
    <p className="text-xs text-slate-400">
      Декларации связывают партии одного заказа. Они не списывают материалы,
      не рассчитывают выход и не подтверждают физический расход.
      Нажмите на связанную партию, чтобы проследить её источники и результаты.
      Просмотр связей не меняет партию в формах операций ниже.
    </p>
    <nav aria-label="Путь просмотра происхождения" className="flex flex-wrap items-center gap-1">
      {trail.map((item,index) => <React.Fragment key={item.id}>
        {index > 0 && <span className="text-slate-500" aria-hidden="true"> / </span>}
        {index === trail.length-1
          ? <span aria-current="page" className="break-all text-sm text-white">{item.batchCode}</span>
          : <button type="button" className={buttonClass}
              onClick={() => navigate(trail.slice(0,index+1))}>{item.batchCode}</button>}
      </React.Fragment>)}
    </nav>
    <h5 className="font-medium text-white break-all">Просматривается: {focus.batchCode}</h5>
    <div className="flex flex-wrap gap-2">
      {trail.length > 1 && <>
        <button type="button" className={buttonClass}
          onClick={() => navigate(trail.slice(0,-1))}>Назад по связям</button>
        <button type="button" className={buttonClass}
          onClick={() => navigate(trail.slice(0,1))}>К исходной партии</button>
      </>}
      <button type="button" className={buttonClass} disabled={loading}
        onClick={() => { setAfter(undefined); setAttempt(value => value+1); }}>Обновить связи</button>
    </div>
    {loading && <p role="status" className="text-sm text-slate-400">Загрузка связей…</p>}
    {error && <div role="alert" className="text-sm text-red-200 space-y-2">
      <p>{error}</p>
      <button type="button" className={buttonClass} disabled={loading}
        onClick={() => setAttempt(value => value+1)}>Повторить загрузку</button>
    </div>}
    {!loading && !error && !links.length &&
      <p className="text-slate-400 text-sm">Связей с другими партиями пока нет.</p>}
    <ol className="space-y-2">
      {links.map(link => <li key={link.id}
        className="rounded-md border-l-2 border-emerald-600 bg-slate-950/50 p-2 text-sm space-y-1">
        <div className="flex flex-wrap items-center gap-1 text-slate-100">
          {link.sourceBatchId === focus.id ? <span className="break-all">{link.sourceCode}</span>
            : <button type="button" className={buttonClass + ' break-all text-left'}
                onClick={() => open(link.sourceBatchId,link.sourceCode)}>{link.sourceCode}</button>}
          {' → '}
          {link.targetBatchId === focus.id ? <span className="break-all">{link.targetCode}</span>
            : <button type="button" className={buttonClass + ' break-all text-left'}
                onClick={() => open(link.targetBatchId,link.targetCode)}>{link.targetCode}</button>}
          {' · '}{kinds[link.kind]}
        </div>
        <p className="text-slate-300">
          Источник: {link.sourceQuantity} {link.sourceUnit} ·
          Результат: {link.targetQuantity} {link.targetUnit}
        </p>
        <p className="text-slate-400 text-xs">
          {link.targetBatchId === focus.id ? 'Входящая связь' : 'Исходящая связь'}
          {' · '}{new Date(link.occurredAt).toLocaleString('ru-RU')}
        </p>
        <p className="text-slate-400 text-xs break-all">Автор: {link.actorId}</p>
        {link.note && <p className="text-slate-400 text-xs whitespace-pre-wrap break-words">{link.note}</p>}
      </li>)}
    </ol>
    {nextAfter && <div className="space-y-2">
      <p className="text-xs text-amber-200">Есть ещё связи: показана часть истории.</p>
      <button type="button" className={buttonClass} disabled={loading || Boolean(error)}
        onClick={() => setAfter(nextAfter)}>Загрузить ещё связи</button>
    </div>}
  </section>;
}
