import React, { useEffect, useState } from 'react';
import { db } from '../../core/db';
import { localSourceCandidates, localKindLabels, metricLabels, type LocalSourceCandidate }
  from '../../core/planning/localSourceCandidates';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type Batch, type BatchStepRecord, type LocalJournalLink } from '../../core/planning/planningClient';

type Props = { connection: ServerConnection; batch: Batch };
const inputClass = 'w-full rounded-lg border border-slate-600 bg-slate-900 p-2 text-sm text-white';

/** Manual online association of a local journal snapshot with one route step.
 *  A reference is not completion evidence or validated material consumption.
 */
export function LocalJournalLinkPanel({ connection, batch }: Props) {
  const [steps, setSteps] = useState<BatchStepRecord[]>([]);
  const [links, setLinks] = useState<LocalJournalLink[]>([]);
  const [local, setLocal] = useState<LocalSourceCandidate[]>([]);
  const [stepChoice, setStepChoice] = useState<number | null>(null);
  const [entryChoice, setEntryChoice] = useState('');
  const [linkId, setLinkId] = useState(() => crypto.randomUUID());
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function sameSession() {
    return getServerConnection()?.session.accessToken === connection.session.accessToken;
  }
  async function load(signal?: AbortSignal) {
    const [route, history, entries, mixes, coatings, calenders, cuts, sorts, assemblies] =
      await Promise.all([
      planningApi.stepEvidence(connection, batch.id, signal),
      planningApi.journalLinks(connection, batch.id, signal),
      db.journal.orderBy('createdAt').reverse().limit(150).toArray(),
      db.mixBatches.orderBy('createdAt').reverse().limit(150).toArray(),
      db.coatRuns.orderBy('createdAt').reverse().limit(150).toArray(),
      db.calenderRuns.orderBy('createdAt').reverse().limit(150).toArray(),
      db.cuttingRuns.orderBy('createdAt').reverse().limit(150).toArray(),
      db.sortRuns.orderBy('createdAt').reverse().limit(150).toArray(),
      db.assemblyRuns.orderBy('createdAt').reverse().limit(150).toArray(),
    ]);
    if (!Array.isArray(route.steps) || !Array.isArray(history.links))
      throw new Error('Сервер вернул неверную историю журнала');
    if (!signal?.aborted && sameSession()) {
      setSteps(route.steps.filter((row,index,list) =>
        list.findIndex(other => other.number === row.number) === index));
      setLinks(history.links);
      setLocal(localSourceCandidates(entries,mixes,coatings,calenders,cuts,sorts,assemblies));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setSteps([]); setLinks([]); setLocal([]);
    setLoading(true); setError(''); setMessage('');
    void load(controller.signal).catch(cause => {
      if (controller.signal.aborted) return;
      const text = cause instanceof Error ? cause.message : 'Записи недоступны';
      setError(text);
      if (text.startsWith('HTTP 401')) clearServerConnection();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [batch.id, connection.session.accessToken]);

  const number = stepChoice !== null && steps.some(step => step.number === stepChoice)
    ? stepChoice : steps[0]?.number;
  const stage = steps.find(step => step.number === number)?.stage;
  const linkedIds = new Set(links.map(link =>
    (link.sourceKind ?? 'journal') + ':' + link.sourceEntryId));
  const candidates = local.filter(entry =>
    entry.sourceStage === stage && !linkedIds.has(entry.key));
  const chosen = candidates.find(entry => entry.key === entryChoice);

  function resetSelection() {
    setEntryChoice('');
    setLinkId(crypto.randomUUID());
    setConfirmed(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || number === undefined || batch.status !== 'in_progress' ||
        !confirmed || busy || !sameSession()) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await planningApi.attachLocalJournal(connection,batch.id,number,{
        linkId,sourceEntryId:chosen.sourceEntryId,sourceKind:chosen.sourceKind,
        sourceStage:chosen.sourceStage,sourceCreatedAt:chosen.sourceCreatedAt,
        summary:chosen.summary,
        ...(chosen.defects ? {defects:chosen.defects} : {}),
        ...(chosen.sourceMeasure ? {sourceMeasure:chosen.sourceMeasure} : {}),
      });
      if (!sameSession()) return;
      // Do not repeat a successful append if refreshing failed.
      resetSelection();
      setMessage('Ссылка записана на сервере. Исходный локальный журнал не изменён.');
      try { await load(); }
      catch (cause) {
        setError('Ссылка создана, но обновить список не удалось: ' +
          (cause instanceof Error ? cause.message : 'ошибка связи'));
      }
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'Ссылка не сохранена';
      setError(text);
      if (text.startsWith('HTTP 401')) clearServerConnection();
    } finally { setBusy(false); }
  }

  return <section className="rounded-lg border border-slate-700 p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium text-white">Связи с локальным журналом</h4>
      <button type="button" disabled={loading || busy}
        onClick={() => { setLoading(true);setError('');void load()
          .catch(cause => setError(cause instanceof Error ? cause.message : 'Ошибка обновления'))
          .finally(()=>setLoading(false)); }}
        className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40">
        Обновить связи
      </button>
    </div>
    <p className="text-xs text-slate-400">
      Выберите запись работ, замеса, нанесения покрытия, каландрирования,
      нарезки, сортировки или сборки с этого устройства. Подтвердите привязку
      к конкретной партии и этапу маршрута.
      Передаются только краткое описание, дата, замечания и обозначенный
      заявленный параметр, если он есть. Это не доказательство выполнения,
      измерение сервера, приёмка качества или списание материалов.
      Демонстрационные записи не предлагаются.
    </p>
    {loading && <p role="status" className="text-xs text-slate-400">Загрузка журнала…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-200">{message}</p>}
    {links.length > 0 && <ol className="space-y-1">
      {links.map(link => <li key={link.id} className="border-l-2 border-slate-600 pl-2 text-xs text-slate-300">
        Этап {link.stepNumber} · {localKindLabels[link.sourceKind ?? 'journal']}: {link.summary}
        {' · '}{new Date(link.sourceCreatedAt).toLocaleString('ru-RU')}
        {link.sourceMeasure && <span className="block text-slate-400">
          {metricLabels[link.sourceMeasure.kind]}: {link.sourceMeasure.value}
        </span>}
        {link.defects && <span className="block text-amber-200">Замечание: {link.defects}</span>}
      </li>)}
    </ol>}
    {!loading && !links.length && !error &&
      <p className="text-xs text-slate-400">К этой партии пока нет ссылок на локальные записи.</p>}
    {batch.status === 'in_progress' && steps.length > 0 && <form onSubmit={event => void submit(event)}
      className="space-y-2 border-t border-slate-700 pt-3">
      <label className="block text-xs text-slate-400">Этап утверждённого маршрута
        <select aria-label="Этап для ссылки" className={inputClass + ' mt-1'}
          value={number ?? ''} onChange={event => {
            setStepChoice(Number(event.target.value));resetSelection();
          }}>
          {steps.map(step => <option key={step.number} value={step.number}>
            {step.number}. {step.name} ({step.stage})</option>)}
        </select>
      </label>
      <label className="block text-xs text-slate-400">Локальная запись (до 150 из каждого журнала операций)
        <select aria-label="Локальная запись" className={inputClass + ' mt-1'}
          value={entryChoice} onChange={event => {
            setEntryChoice(event.target.value);
            setLinkId(crypto.randomUUID());setConfirmed(false);
          }}>
          <option value="">Выберите запись</option>
          {candidates.map(entry => <option key={entry.key} value={entry.key}>
            {localKindLabels[entry.sourceKind]} · {new Date(entry.sourceCreatedAt).toLocaleString('ru-RU')}
            {' · '}{entry.summary.slice(0,90)}
          </option>)}
        </select>
      </label>
      {chosen && <div className="rounded-md bg-slate-900/60 p-2 text-xs text-slate-200">
        <p>Передаётся на сервер ({localKindLabels[chosen.sourceKind]}): {chosen.summary}</p>
        {chosen.sourceMeasure && <p>
          {metricLabels[chosen.sourceMeasure.kind]}: {chosen.sourceMeasure.value}
        </p>}
        {chosen.defects && <p>Замечания: {chosen.defects}</p>}
      </div>}
      {!candidates.length && <p className="text-xs text-amber-200">
        На этом устройстве нет подходящих недублированных записей для выбранного этапа.
      </p>}
      <label className="flex gap-2 items-start text-xs text-slate-300">
        <input type="checkbox" checked={confirmed}
          onChange={event => setConfirmed(event.target.checked)} />
        Подтверждаю ручную привязку этой записи к выбранной партии и этапу.
      </label>
      <button type="submit" disabled={busy || !chosen || !confirmed}
        className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40">
        Привязать запись
      </button>
    </form>}
  </section>;
}
