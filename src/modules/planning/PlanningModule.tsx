import React, { useEffect, useState } from 'react';
import { StepEvidencePanel } from './StepEvidencePanel';
import { QuantityFlowPanel } from './QuantityFlowPanel';
import { LocalJournalLinkPanel } from './LocalJournalLinkPanel';
import { InspectionObservationPanel } from './InspectionObservationPanel';
import { RouteInspectionCriteriaPanel, BatchInspectionCriteriaPanel }
  from './InspectionCriteriaPanel';
import { ClipboardList, Factory, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { StageId, STAGE_LABELS } from '../../core/types';
import { clearServerConnection, getServerConnection, useServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import {
  planningApi, type Batch, type BatchEvent, type BatchStatus, type MaterialLine,
  type ProductionOrder, type QuantityUnit, type Route, type RouteStep, type Workshop,
  type HandoffInboxItem, type BatchHandoff, type StepDetail,
  type BatchGenealogyLink, type GenealogyKind,
} from '../../core/planning/planningClient';

const fieldClass = 'w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white';
const validGenealogyQuantity = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const buttonClass = 'rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40';
const secondaryClass = 'rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 disabled:opacity-40';
const statusNames: Record<BatchStatus, string> = {
  created: 'Создана', in_progress: 'В работе', hold: 'Остановлена',
  completed: 'Завершена', scrapped: 'Списана',
};
const transitions: Record<BatchStatus, BatchStatus[]> = {
  created: ['in_progress', 'hold', 'scrapped'],
  in_progress: ['hold', 'completed', 'scrapped'],
  hold: ['in_progress', 'scrapped'],
  completed: [], scrapped: [],
};
const lineNames: Record<MaterialLine, string> = {
  cathode: 'Катод', anode: 'Анод', cell: 'Ячейка',
};
const genealogyKinds: Record<GenealogyKind, string> = {
  assembly: 'Сборка из электродов', split: 'Разделение партии',
  merge: 'Объединение партий', consumption: 'Связь расходования',
};
const emptyStep = (): RouteStep => ({
  name: '', stage: StageId.COATING, workshopId: '', electrodeLine: 'cathode',
});

function formatProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Операция не выполнена';
  const explanations: Record<string, string> = {
    batch_route_steps_missing: 'Нельзя завершить партию: для её линии в маршруте нет этапов.',
    batch_route_step_incomplete: 'Нельзя завершить партию: сначала подтвердите выполнение всех этапов маршрута.',
    inspection_review_pending: 'Нельзя завершить партию: есть наблюдения качества, требующие проверки. Откройте журнал контроля качества и зафиксируйте решение по каждому замечанию.',
    handoff_receipt_pending: 'Нельзя завершить партию: одна из передач ещё не подтверждена получателем.',
  };
  const errorCode = /^HTTP 409: ([a-z_]+)$/.exec(message)?.[1];
  return errorCode && explanations[errorCode] ? explanations[errorCode] : message;
}

export function PlanningModule({ onOpenSync }: { onOpenSync: () => void }) {
  const connection = useServerConnection();
  const allowed = connection && ['chief', 'master', 'technologist'].includes(connection.serverRole);
  if (!connection || !allowed) {
    return <section className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Планирование производства</h1>
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
        <p className="text-amber-100">Для просмотра производственных заказов подключитесь к серверу под учётной записью с правами планирования.</p>
        <p className="text-slate-400 text-sm">Локальный демонстрационный вход не даёт доступ к данным сервера.</p>
        <button className={buttonClass} onClick={onOpenSync}>Открыть подключение к серверу</button>
      </div>
    </section>;
  }
  // A new authenticated server actor gets a fresh component, preventing
  // even one frame of a previous account's planning data being shown.
  return <PlanningWorkspace key={connection.session.accessToken} connection={connection} onOpenSync={onOpenSync} />;
}

function PlanningWorkspace({ connection, onOpenSync }: {
  connection: ServerConnection; onOpenSync: () => void;
}) {
  const isChief = connection.serverRole === 'chief';
  const canEditRoutes = isChief || connection.serverRole === 'technologist';
  const [tab, setTab] = useState<'orders' | 'routes' | 'handoffs'>('orders');
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [events, setEvents] = useState<BatchEvent[]>([]);
  const [incoming, setIncoming] = useState<HandoffInboxItem[]>([]);
  const [handoffHistory, setHandoffHistory] = useState<BatchHandoff[]>([]);
  const [handoffRoute, setHandoffRoute] = useState<StepDetail[]>([]);
  const [genealogyLinks, setGenealogyLinks] = useState<BatchGenealogyLink[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [routePreview, setRoutePreview] = useState<Route | null>(null);
  const [routeSteps, setRouteSteps] = useState<RouteStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [workshopCode, setWorkshopCode] = useState('');
  const [workshopName, setWorkshopName] = useState('');
  const [routeCode, setRouteCode] = useState('');
  const [routeName, setRouteName] = useState('');
  const [newSteps, setNewSteps] = useState<RouteStep[]>([emptyStep()]);
  const [orderCode, setOrderCode] = useState('');
  const [productCode, setProductCode] = useState('');
  const [routeChoice, setRouteChoice] = useState('');
  const [orderQuantity, setOrderQuantity] = useState('');
  const [orderUnit, setOrderUnit] = useState<QuantityUnit>('cells');
  const [batchCode, setBatchCode] = useState('');
  const [batchLine, setBatchLine] = useState<MaterialLine>('cathode');
  const [batchQuantity, setBatchQuantity] = useState('');
  const [batchUnit, setBatchUnit] = useState<QuantityUnit>('kg');
  const [nextStatus, setNextStatus] = useState<BatchStatus>('in_progress');
  const [statusReason, setStatusReason] = useState('');
  const [handoffQuantity, setHandoffQuantity] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  const [linkKind, setLinkKind] = useState<GenealogyKind>('assembly');
  const [linkSourceId, setLinkSourceId] = useState('');
  const [linkSourceQuantity, setLinkSourceQuantity] = useState('');
  const [linkTargetQuantity, setLinkTargetQuantity] = useState('');
  const [linkNote, setLinkNote] = useState('');
  // The ID stays stable across a lost HTTP response so a retry cannot create
  // a duplicate, irreversible provenance declaration.
  const [linkDeclarationId, setLinkDeclarationId] = useState(() => crypto.randomUUID());

  async function refresh(signal?: AbortSignal) {
    const [w, r, o, h] = await Promise.all([
      planningApi.workshops(connection, signal),
      planningApi.routes(connection, signal),
      isChief ? planningApi.orders(connection, signal) : Promise.resolve({ orders: [] as ProductionOrder[] }),
      isChief || connection.serverRole === 'master'
        ? planningApi.handoffInbox(connection, signal)
        : Promise.resolve({ handoffs: [] as HandoffInboxItem[] }),
    ]);
    if (signal?.aborted || getServerConnection()?.session.accessToken !== connection.session.accessToken) return;
    if (!Array.isArray(w.workshops) || !Array.isArray(r.routes) || !Array.isArray(o.orders) ||
        !Array.isArray(h.handoffs)) {
      throw new Error('Сервер вернул неверный список заказов или маршрутов');
    }
    setWorkshops(w.workshops);
    setRoutes(r.routes);
    setOrders(o.orders);
    setIncoming(h.handoffs);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void refresh(controller.signal)
      .catch(cause => {
        if (!controller.signal.aborted) {
          setWorkshops([]); setRoutes([]); setOrders([]); setIncoming([]);
          setError(formatProblem(cause));
          if (formatProblem(cause).startsWith('HTTP 401')) clearServerConnection();
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection.session.accessToken]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      await action();
      if (getServerConnection()?.session.accessToken !== connection.session.accessToken) return;
      await refresh();
      if (selectedOrder) await loadBatches(selectedOrder, false);
      if (selectedBatch) await loadEvents(selectedBatch);
      setMessage(success);
    } catch (cause) {
      const problem = formatProblem(cause);
      setError(problem);
      if (problem.startsWith('HTTP 401')) clearServerConnection();
    } finally { setBusy(false); }
  }

  async function loadBatches(orderId: string, resetDetail = true) {
    setSelectedOrder(orderId);
    if (resetDetail) {
      setSelectedBatch(null);
      setBatches([]);
      setEvents([]); setHandoffHistory([]); setHandoffRoute([]); setGenealogyLinks([]);
      setLinkSourceId(''); setLinkSourceQuantity(''); setLinkTargetQuantity(''); setLinkNote('');
      setLinkDeclarationId(crypto.randomUUID());
    }
    try {
      const response = await planningApi.batches(connection, orderId);
      if (getServerConnection()?.session.accessToken === connection.session.accessToken) {
        setBatches(response.batches);
      }
    } catch (cause) { setError(formatProblem(cause)); }
  }

  async function loadEvents(batchId: string) {
    if (selectedBatch !== batchId) {
      setLinkSourceId(''); setLinkSourceQuantity(''); setLinkTargetQuantity(''); setLinkNote('');
      setLinkKind('assembly'); setLinkDeclarationId(crypto.randomUUID());
    }
    setSelectedBatch(batchId);
    setEvents([]); setHandoffHistory([]); setHandoffRoute([]); setGenealogyLinks([]);
    try {
      const [response, ledger, steps, genealogy] = await Promise.all([
        planningApi.batchEvents(connection, batchId),
        planningApi.batchHandoffs(connection, batchId),
        (async () => { const order = orders.find(o => o.id === selectedOrder);
          return order ? planningApi.routeSteps(connection, order.routeId, order.routeVersion) : { steps: [] as StepDetail[] }; })(),
        planningApi.batchGenealogy(connection, batchId),
      ]);
      if (getServerConnection()?.session.accessToken === connection.session.accessToken) {
        if (!Array.isArray(genealogy.links)) throw new Error('Сервер вернул неверную историю партий');
        setEvents(response.events);
        setHandoffHistory(ledger.handoffs);
        setHandoffRoute(steps.steps);
        setGenealogyLinks(genealogy.links);
      }
    } catch (cause) { setError(formatProblem(cause)); }
  }

  async function inspectRoute(route: Route) {
    setRoutePreview(route);
    setRouteSteps([]);
    setError('');
    try {
      const response = await planningApi.routeSteps(connection, route.id, route.version);
      if (getServerConnection()?.session.accessToken === connection.session.accessToken) {
        setRouteSteps(response.steps.map(step => ({
          name: step.name, stage: step.stage,
          workshopId: step.workshopId, electrodeLine: step.electrodeLine,
        })));
      }
    } catch (cause) { setError(formatProblem(cause)); }
  }

  function editStep(
    source: RouteStep[], setSource: React.Dispatch<React.SetStateAction<RouteStep[]>>,
    index: number, field: keyof RouteStep, value: string,
  ) {
    setSource(source.map((step, n) => n === index ? { ...step, [field]: value } : step));
  }

  function stepEditor(steps: RouteStep[], setSteps: React.Dispatch<React.SetStateAction<RouteStep[]>>) {
    return <div className="space-y-3">
      {steps.map((step, index) => <div key={index} className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-300">Шаг {index + 1}</span>
          {steps.length > 1 && <button type="button" className="text-red-300 text-xs" onClick={() => setSteps(steps.filter((_, n) => n !== index))}>Удалить</button>}
        </div>
        <label className="block text-xs text-slate-400">Название операции
          <input className={fieldClass + ' mt-1'} value={step.name} required maxLength={300}
            onChange={event => editStep(steps, setSteps, index, 'name', event.target.value)} />
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-xs text-slate-400">Этап
            <select className={fieldClass + ' mt-1'} value={step.stage}
              onChange={event => editStep(steps, setSteps, index, 'stage', event.target.value)}>
              {Object.entries(STAGE_LABELS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">Цех
            <select className={fieldClass + ' mt-1'} value={step.workshopId} required
              onChange={event => editStep(steps, setSteps, index, 'workshopId', event.target.value)}>
              <option value="">Выберите</option>
              {workshops.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">Линия
            <select className={fieldClass + ' mt-1'} value={step.electrodeLine}
              onChange={event => editStep(steps, setSteps, index, 'electrodeLine', event.target.value)}>
              <option value="cathode">Катод</option><option value="anode">Анод</option><option value="common">Общая</option>
            </select>
          </label>
        </div>
      </div>)}
      <button type="button" className={secondaryClass} disabled={steps.length >= 50}
        onClick={() => setSteps([...steps, emptyStep()])}>+ Добавить операцию</button>
    </div>;
  }

  const approved = routes.filter(route => route.state === 'approved');
  const chosenRoute = approved.find(route => route.id + ':' + route.version === routeChoice);
  const selectedOrderRow = orders.find(order => order.id === selectedOrder);
  const selectedBatchRow = batches.find(batch => batch.id === selectedBatch);
  // Only batches within the selected order are eligible; the server checks
  // tenant, order, lifecycle, branches and cycles independently.
  const genealogySources = batches.filter(batch => selectedBatchRow &&
    batch.id !== selectedBatchRow.id && batch.status === 'completed' &&
    ['created', 'in_progress'].includes(selectedBatchRow.status) &&
    (linkKind === 'assembly'
      ? selectedBatchRow.materialLine === 'cell' &&
        ['cathode', 'anode'].includes(batch.materialLine)
      : linkKind === 'split' || linkKind === 'merge'
        ? batch.materialLine === selectedBatchRow.materialLine : true));
  const chosenGenealogySource = genealogySources.find(batch => batch.id === linkSourceId);
  const applicableSteps = handoffRoute.filter(step => step.electrodeLine ===
    (selectedBatchRow?.materialLine === 'cell' ? 'common' : selectedBatchRow?.materialLine));
  const latestTransfer = handoffHistory[handoffHistory.length - 1];
  const originNumber = latestTransfer?.toStep ?? applicableSteps[0]?.number;
  const originIndex = applicableSteps.findIndex(step => step.number === originNumber);
  const proposedHandoff = selectedBatchRow?.status === 'in_progress' &&
    originIndex >= 0 && originIndex + 1 < applicableSteps.length &&
    (!latestTransfer || Boolean(latestTransfer.receivedBy))
      ? { fromStep: applicableSteps[originIndex], toStep: applicableSteps[originIndex + 1] }
      : null;

  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-white">Планирование производства</h1>
        <p className="text-sm text-slate-400">Сервер: {connection.serverUrl} · роль: {connection.serverRole}</p>
      </div>
      <button type="button" className={secondaryClass} disabled={busy || loading}
        onClick={() => void run(() => refresh(), 'Данные обновлены')}>
        <RefreshCw className="inline h-4 w-4 mr-1" /> Обновить
      </button>
    </div>
    <div className="flex items-start gap-2 rounded-lg border border-sky-600/30 bg-sky-950/40 p-3 text-sm text-sky-100">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <p>Планирование работает только онлайн. Здесь нет офлайн-очереди M1. Не отправляйте изменения при нестабильной сети без проверки результата на сервере.</p>
    </div>
    <div className="flex gap-2" role="tablist">
      <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? buttonClass : secondaryClass}
        onClick={() => setTab('orders')}>Заказы и партии</button>
      <button role="tab" aria-selected={tab === 'routes'} className={tab === 'routes' ? buttonClass : secondaryClass}
        onClick={() => setTab('routes')}>Маршруты</button>
      <button role="tab" aria-selected={tab === 'handoffs'} className={tab === 'handoffs' ? buttonClass : secondaryClass}
        onClick={() => setTab('handoffs')}>Приёмка передач ({incoming.length})</button>
    </div>
    {loading && <p className="text-slate-300" role="status">Загружаем данные с сервера…</p>}
    {error && <p role="alert" className="rounded-lg border border-red-600/40 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-green-600/40 bg-green-950/40 p-3 text-sm text-green-200">{message}</p>}

    {tab === 'handoffs' && <div className="space-y-3">
      <h2 className="text-white font-semibold">Передачи на приёмку ({incoming.length})</h2>
      <p className="text-slate-400 text-sm">
        Здесь показаны только передачи в доступные вам цеха. Приёмку должен подтвердить
        другой сотрудник, не тот, кто отправил партию. Это журнал передачи, а не движение склада.
      </p>
      {!incoming.length && <p className="text-slate-400 text-sm">Нет передач, ожидающих приёмки.</p>}
      {incoming.map(ticket => <div key={ticket.id}
        className="rounded-xl border border-slate-700 bg-slate-800/70 p-4 space-y-2">
        <h3 className="font-medium text-white">{ticket.batchCode}</h3>
        <p className="text-sm text-slate-300">
          Этап {ticket.fromStep} → {ticket.toStep} · {ticket.fromWorkshopId} → {ticket.toWorkshopId}
        </p>
        <p className="text-sm text-slate-300">Передано: {ticket.quantity} {ticket.quantityUnit}</p>
        {ticket.note && <p className="text-slate-400 text-sm whitespace-pre-wrap">{ticket.note}</p>}
        <label className="block text-xs text-slate-400">Примечание принимающего
          <textarea className={fieldClass + ' mt-1'} value={receiptNote} maxLength={2000}
            onChange={event => setReceiptNote(event.target.value)} rows={2} />
        </label>
        <button type="button" className={buttonClass} disabled={busy ||
          ticket.sentBy === connection.serverActorId}
          onClick={() => void run(async () => {
            await planningApi.receiveHandoff(connection, ticket.id, receiptNote);
            setReceiptNote('');
          }, 'Приёмка записана на сервере')}>
          {ticket.sentBy === connection.serverActorId ? 'Нужен другой принимающий' : 'Подтвердить приёмку'}
        </button>
      </div>)}
    </div>}

    {tab === 'routes' && <div className="space-y-5">
      {isChief && <form className="rounded-xl border border-slate-700 bg-slate-800/70 p-4 space-y-3"
        onSubmit={event => { event.preventDefault();
          void run(async () => { await planningApi.createWorkshop(connection, { id: workshopCode.trim(), name: workshopName.trim() });
            setWorkshopCode(''); setWorkshopName(''); }, 'Цех добавлен'); }}>
        <h2 className="font-semibold text-white">Новый цех</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input aria-label="Код цеха" className={fieldClass} value={workshopCode}
            onChange={event => setWorkshopCode(event.target.value)} placeholder="Код: coating" required
            pattern="[a-z0-9][a-z0-9_-]*" maxLength={120} />
          <input aria-label="Название цеха" className={fieldClass} value={workshopName}
            onChange={event => setWorkshopName(event.target.value)} placeholder="Название цеха" required maxLength={300} />
        </div>
        <button type="submit" className={buttonClass} disabled={busy}>Создать цех</button>
      </form>}
      {canEditRoutes && <form className="rounded-xl border border-slate-700 bg-slate-800/70 p-4 space-y-3"
        onSubmit={event => { event.preventDefault(); void run(async () => {
          await planningApi.createRoute(connection, { code: routeCode.trim(), name: routeName.trim(), steps: newSteps });
          setRouteCode(''); setRouteName(''); setNewSteps([emptyStep()]);
        }, 'Новый маршрут сохранён как черновик'); }}>
        <h2 className="font-semibold text-white flex gap-2 items-center"><Factory size={18} /> Новый технологический маршрут</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input className={fieldClass} aria-label="Код маршрута" placeholder="Код маршрута" required maxLength={80}
            value={routeCode} onChange={event => setRouteCode(event.target.value)} />
          <input className={fieldClass} aria-label="Название маршрута" placeholder="Название маршрута" required maxLength={300}
            value={routeName} onChange={event => setRouteName(event.target.value)} />
        </div>
        {workshops.length ? stepEditor(newSteps, setNewSteps) :
          <p className="text-amber-200 text-sm">Сначала зарегистрируйте цех на сервере.</p>}
        <button type="submit" disabled={busy || !workshops.length || newSteps.some(s => !s.workshopId || !s.name.trim())}
          className={buttonClass}>Создать черновик</button>
      </form>}
      <div className="space-y-2">
        <h2 className="font-semibold text-white">Версии маршрутов ({routes.length})</h2>
        {!routes.length && <p className="text-slate-400 text-sm">Пока нет доступных маршрутов.</p>}
        {routes.map(route => <div key={route.id + ':' + route.version}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-800/70 border border-slate-700 p-3">
          <div>
            <div className="text-white font-medium">{route.code} · v{route.version}</div>
            <p className="text-slate-400 text-sm">{route.name} · {route.stepCount} операций · {route.state === 'approved' ? 'Утверждён' : 'Черновик'}</p>
          </div>
          <button type="button" className={secondaryClass} onClick={() => void inspectRoute(route)}>Открыть</button>
        </div>)}
      </div>
      {routePreview && <div className="rounded-xl border border-sky-800 bg-slate-800/70 p-4 space-y-3">
        <h3 className="text-white font-semibold">{routePreview.code}, версия {routePreview.version}</h3>
        {routePreview.state === 'draft' && canEditRoutes ?
          <>{stepEditor(routeSteps, setRouteSteps)}
            <button type="button" className={buttonClass} disabled={busy || !routeSteps.length ||
              routeSteps.some(step => !step.name.trim() || !step.workshopId)}
              onClick={() => void run(() => planningApi.replaceRouteSteps(connection, routePreview.id, routePreview.version, routeSteps),
                'Операции черновика обновлены')}>Сохранить операции</button>
          </> :
          <ol className="space-y-1 text-sm text-slate-300 list-decimal list-inside">
            {routeSteps.map((s, i) => <li key={i}>{s.name} · {STAGE_LABELS[s.stage as StageId] || s.stage}</li>)}
          </ol>}
        <RouteInspectionCriteriaPanel
          key={routePreview.id + ':' + routePreview.version}
          connection={connection} route={routePreview} steps={routeSteps} />
        <div className="flex flex-wrap gap-2">
          {isChief && routePreview.state === 'draft' &&
            <button className={buttonClass} disabled={busy}
              onClick={() => void run(async () => { await planningApi.approveRoute(connection, routePreview.id, routePreview.version); setRoutePreview(null); },
                'Маршрут утверждён')}>Утвердить версию</button>}
          {canEditRoutes && routePreview.state === 'approved' &&
            <button className={secondaryClass} disabled={busy}
              onClick={() => void run(async () => { await planningApi.forkRoute(connection, routePreview.id); setRoutePreview(null); },
                'Новая версия маршрута создана')}>Новая версия</button>}
          <button className={secondaryClass} onClick={() => setRoutePreview(null)}>Закрыть</button>
        </div>
      </div>}
    </div>}

    {tab === 'orders' && !isChief && <div className="rounded-xl border border-slate-700 bg-slate-800/70 p-4">
      <p className="text-slate-200">Управление заказами и партиями пока доступно только начальнику производства на сервере.</p>
      <button className={secondaryClass + ' mt-3'} onClick={onOpenSync}>Проверить серверную учётную запись</button>
    </div>}

    {tab === 'orders' && isChief && <div className="space-y-5">
      <form className="rounded-xl border border-slate-700 bg-slate-800/70 p-4 space-y-3"
        onSubmit={event => { event.preventDefault(); if (!chosenRoute) return;
          void run(async () => {
            await planningApi.createOrder(connection, {
              orderCode: orderCode.trim(), productCode: productCode.trim(),
              routeId: chosenRoute.id, routeVersion: chosenRoute.version,
              plannedQuantity: orderQuantity.trim(), quantityUnit: orderUnit,
            });
            setOrderCode(''); setProductCode(''); setOrderQuantity('');
          }, 'Производственный заказ создан'); }}>
        <h2 className="font-semibold text-white flex gap-2 items-center"><ClipboardList size={18} /> Новый производственный заказ</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input className={fieldClass} aria-label="Код заказа" placeholder="Код заказа" required maxLength={80}
            value={orderCode} onChange={event => setOrderCode(event.target.value)} />
          <input className={fieldClass} aria-label="Код продукта" placeholder="Код продукта: 18650-NMC" required maxLength={120}
            value={productCode} onChange={event => setProductCode(event.target.value)} />
          <select className={fieldClass} aria-label="Утверждённый маршрут" required value={routeChoice}
            onChange={event => setRouteChoice(event.target.value)}>
            <option value="">Утверждённый маршрут</option>
            {approved.map(route => <option key={route.id + ':' + route.version} value={route.id + ':' + route.version}>
              {route.code} · версия {route.version}</option>)}
          </select>
          <div className="flex gap-2">
            <input className={fieldClass} aria-label="Плановое количество" placeholder="Количество" required
              inputMode="decimal" value={orderQuantity} onChange={event => setOrderQuantity(event.target.value)} />
            <select aria-label="Единица измерения заказа" className={fieldClass + ' max-w-28'}
              value={orderUnit} onChange={event => setOrderUnit(event.target.value as QuantityUnit)}>
              <option value="cells">шт. ячеек</option><option value="pieces">шт.</option>
              <option value="kg">кг</option><option value="m">м</option><option value="m2">м²</option>
            </select>
          </div>
        </div>
        {!approved.length && <p className="text-amber-200 text-sm">Сначала создайте и утвердите технологический маршрут во вкладке «Маршруты».</p>}
        <button disabled={busy || !chosenRoute} className={buttonClass} type="submit"><Plus className="h-4 w-4 inline mr-1" /> Создать заказ</button>
      </form>
      <div className="space-y-2">
        <h2 className="font-semibold text-white">Заказы ({orders.length})</h2>
        {!orders.length && <p className="text-slate-400 text-sm">Заказов пока нет.</p>}
        {orders.map(order => <div key={order.id} className="rounded-lg border border-slate-700 bg-slate-800/70 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div><h3 className="text-white font-medium">{order.orderCode}</h3>
              <p className="text-sm text-slate-400">{order.productCode} · {order.plannedQuantity} {order.quantityUnit} · {order.status}</p>
            </div>
            {order.status === 'draft' && <button className={buttonClass} disabled={busy}
              onClick={() => void run(() => planningApi.releaseOrder(connection, order.id), 'Заказ выпущен')}>Выпустить</button>}
          </div>
          <button className={secondaryClass} type="button" onClick={() => void loadBatches(order.id)}>
            {selectedOrder === order.id ? 'Обновить партии' : 'Открыть партии'}</button>
        </div>)}
      </div>
      {selectedOrderRow && <div className="rounded-xl border border-sky-800 bg-slate-800/70 p-4 space-y-4">
        <h2 className="text-lg font-semibold text-white">Партии заказа {selectedOrderRow.orderCode}</h2>
        {['released', 'in_progress'].includes(selectedOrderRow.status) &&
          <form className="space-y-2" onSubmit={event => { event.preventDefault();
            void run(async () => {
              await planningApi.createBatch(connection, selectedOrderRow.id, {
                batchCode: batchCode.trim(), materialLine: batchLine,
                plannedQuantity: batchQuantity.trim(), quantityUnit: batchUnit,
              });
              setBatchCode(''); setBatchQuantity('');
            }, 'Партия создана'); }}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input className={fieldClass} placeholder="Код партии" aria-label="Код партии" required maxLength={100}
                value={batchCode} onChange={event => setBatchCode(event.target.value)} />
              <select className={fieldClass} aria-label="Тип партии" value={batchLine}
                onChange={event => setBatchLine(event.target.value as MaterialLine)}>
                <option value="cathode">Катод</option><option value="anode">Анод</option><option value="cell">Ячейка</option>
              </select>
              <input className={fieldClass} aria-label="Плановое количество партии" inputMode="decimal"
                placeholder="Количество партии" required value={batchQuantity}
                onChange={event => setBatchQuantity(event.target.value)} />
              <select className={fieldClass} aria-label="Единица измерения партии" value={batchUnit}
                onChange={event => setBatchUnit(event.target.value as QuantityUnit)}>
                <option value="kg">кг</option><option value="cells">шт. ячеек</option>
                <option value="pieces">шт.</option><option value="m">м</option><option value="m2">м²</option>
              </select>
            </div>
            <button type="submit" className={buttonClass} disabled={busy}>Создать партию</button>
          </form>}
        {!batches.length && <p className="text-slate-400 text-sm">Партии пока не зарегистрированы.</p>}
        {batches.map(batch => <div key={batch.id}
          className="rounded-lg bg-slate-900/80 border border-slate-700 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="text-white font-medium">{batch.batchCode} · {lineNames[batch.materialLine]}</h3>
              <p className="text-slate-400 text-sm">{batch.plannedQuantity} {batch.quantityUnit} · {statusNames[batch.status]}</p>
            </div>
            <button className={secondaryClass} onClick={() => {
              setNextStatus(transitions[batch.status][0] ?? batch.status);
              setStatusReason('');
              void loadEvents(batch.id);
            }}>История и статус</button>
          </div>
        </div>)}
        {selectedBatchRow && <div className="rounded-lg border border-slate-600 p-3 space-y-3">
          <h3 className="text-white font-medium">{selectedBatchRow.batchCode} · История</h3>
          <StepEvidencePanel key={selectedBatchRow.id} connection={connection} batch={selectedBatchRow} />
          <QuantityFlowPanel key={selectedBatchRow.id} connection={connection} batchId={selectedBatchRow.id} />
          <LocalJournalLinkPanel key={selectedBatchRow.id} connection={connection} batch={selectedBatchRow} />
          <BatchInspectionCriteriaPanel key={selectedBatchRow.id}
            connection={connection} batchId={selectedBatchRow.id} />
          <InspectionObservationPanel key={selectedBatchRow.id} connection={connection} batch={selectedBatchRow} />
          <div className="space-y-3 rounded-lg border border-slate-700 p-3">
            <h4 className="font-medium text-white">Происхождение партии</h4>
            <p className="text-xs text-slate-400">
              Декларации связывают партии одного заказа. Они не списывают материалы,
              не рассчитывают выход и не подтверждают физический расход.
              Если подтверждение пропало из-за сети, сначала обновите историю, не создавайте его повторно.
            </p>
            {!genealogyLinks.length &&
              <p className="text-slate-400 text-sm">Связей с другими партиями пока нет.</p>}
            <ol className="space-y-2">
              {genealogyLinks.map(link => <li key={link.id}
                className="rounded-md border-l-2 border-emerald-600 bg-slate-950/50 p-2 text-sm">
                <div className="text-slate-100">
                  {link.sourceCode} → {link.targetCode} · {genealogyKinds[link.kind]}
                </div>
                <p className="text-slate-300">
                  Источник: {link.sourceQuantity} {link.sourceUnit} ·
                  Результат: {link.targetQuantity} {link.targetUnit}
                </p>
                <p className="text-slate-400 text-xs">
                  {link.targetBatchId === selectedBatchRow.id ? 'Входящая связь' : 'Исходящая связь'}
                  {' · '}{new Date(link.occurredAt).toLocaleString('ru-RU')}
                </p>
                {link.note && <p className="text-slate-400 text-xs whitespace-pre-wrap">{link.note}</p>}
              </li>)}
            </ol>
            {['created', 'in_progress'].includes(selectedBatchRow.status) &&
              <form className="space-y-2 border-t border-slate-700 pt-3"
                onSubmit={event => { event.preventDefault();
                  if (!chosenGenealogySource) return;
                  void run(async () => {
                    await planningApi.declareGenealogy(connection, selectedBatchRow.id, {
                      declarationId: linkDeclarationId,
                      sourceBatchId: chosenGenealogySource.id, kind: linkKind,
                      sourceQuantity: linkSourceQuantity.trim(),
                      sourceUnit: chosenGenealogySource.quantityUnit,
                      targetQuantity: linkTargetQuantity.trim(),
                      targetUnit: selectedBatchRow.quantityUnit,
                      ...(linkNote.trim() ? { note: linkNote.trim() } : {}),
                    });
                    setLinkSourceId('');
                    setLinkSourceQuantity('');
                    setLinkTargetQuantity('');
                    setLinkNote('');
                    setLinkDeclarationId(crypto.randomUUID());
                  }, 'Связь происхождения записана на сервере');
                }}>
                <h5 className="font-medium text-slate-200 text-sm">Добавить связь происхождения</h5>
                <label className="block text-xs text-slate-400">Тип связи
                  <select aria-label="Тип связи партии" className={fieldClass + ' mt-1'}
                    value={linkKind} onChange={event => {
                      setLinkKind(event.target.value as GenealogyKind);
                      setLinkSourceId(''); setLinkSourceQuantity('');
                      setLinkDeclarationId(crypto.randomUUID());
                    }}>
                    {Object.entries(genealogyKinds).map(([kind, title]) =>
                      <option key={kind} value={kind}>{title}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-slate-400">Исходная завершённая партия
                  <select aria-label="Исходная партия" className={fieldClass + ' mt-1'}
                    value={genealogySources.some(source => source.id === linkSourceId) ? linkSourceId : ''}
                    onChange={event => {
                      setLinkSourceId(event.target.value);
                      setLinkSourceQuantity('');
                      setLinkDeclarationId(crypto.randomUUID());
                    }} required>
                    <option value="">Выберите партию</option>
                    {genealogySources.map(source => <option key={source.id} value={source.id}>
                      {source.batchCode} · {lineNames[source.materialLine]}
                    </option>)}
                  </select>
                </label>
                {!genealogySources.length &&
                  <p className="text-amber-200 text-xs">
                    Для этого типа связи нет завершённых исходных партий в данном заказе.
                  </p>}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block text-xs text-slate-400">
                    Количество из источника ({chosenGenealogySource?.quantityUnit ?? '—'})
                    <input aria-label="Количество из источника" className={fieldClass + ' mt-1'}
                      inputMode="decimal" required value={linkSourceQuantity}
                      onChange={event => {
                        setLinkSourceQuantity(event.target.value);
                        setLinkDeclarationId(crypto.randomUUID());
                      }}
                      placeholder="Например, 12.5" />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Количество результата ({selectedBatchRow.quantityUnit})
                    <input aria-label="Количество результата" className={fieldClass + ' mt-1'}
                      inputMode="decimal" required value={linkTargetQuantity}
                      onChange={event => {
                        setLinkTargetQuantity(event.target.value);
                        setLinkDeclarationId(crypto.randomUUID());
                      }}
                      placeholder="Например, 100" />
                  </label>
                </div>
                <label className="block text-xs text-slate-400">Основание / примечание
                  <textarea aria-label="Примечание о происхождении" className={fieldClass + ' mt-1'}
                    rows={2} maxLength={2000} value={linkNote}
                    onChange={event => {
                      setLinkNote(event.target.value);
                      setLinkDeclarationId(crypto.randomUUID());
                    }} />
                </label>
                <button type="submit" className={buttonClass}
                  disabled={busy || !chosenGenealogySource ||
                    !validGenealogyQuantity.test(linkSourceQuantity.trim()) ||
                    !validGenealogyQuantity.test(linkTargetQuantity.trim())}>
                  Записать связь
                </button>
              </form>}
          </div>
          <div className="space-y-2 rounded-lg border border-slate-700 p-3">
            <h4 className="font-medium text-white">Передачи между этапами</h4>
            {!handoffHistory.length && <p className="text-slate-400 text-sm">Передач пока нет.</p>}
            {handoffHistory.map(ticket => <div key={ticket.id}
              className="rounded-md border-l-2 border-blue-500 bg-slate-950/50 p-2 text-sm text-slate-200">
              Этап {ticket.fromStep} → {ticket.toStep} · {ticket.quantity} {ticket.quantityUnit}
              <p className="text-slate-400 text-xs">
                {ticket.receivedBy ? 'Получено' : 'Ожидает подтверждения приёмки'}
              </p>
              {ticket.note && <p className="text-slate-400 text-xs whitespace-pre-wrap">{ticket.note}</p>}
            </div>)}
            {proposedHandoff ? <form className="space-y-2" onSubmit={event => {
              event.preventDefault();
              const ticketId = crypto.randomUUID();
              void run(async () => {
                await planningApi.sendHandoff(connection, selectedBatchRow.id, {
                  handoffId: ticketId,
                  fromStep: proposedHandoff.fromStep.number,
                  toStep: proposedHandoff.toStep.number,
                  quantity: handoffQuantity.trim(),
                  quantityUnit: selectedBatchRow.quantityUnit,
                  ...(handoffNote.trim() ? { note: handoffNote.trim() } : {}),
                });
                setHandoffQuantity(''); setHandoffNote('');
              }, 'Передача отправлена. Получатель должен подтвердить приёмку.');
            }}>
              <p className="text-sky-200 text-sm">
                Следующая передача: {proposedHandoff.fromStep.name} → {proposedHandoff.toStep.name}
              </p>
              <label className="block text-xs text-slate-400">Передаваемое количество ({selectedBatchRow.quantityUnit})
                <input className={fieldClass + ' mt-1'} required inputMode="decimal"
                  value={handoffQuantity} onChange={event => setHandoffQuantity(event.target.value)}
                  placeholder="Количество" />
              </label>
              <label className="block text-xs text-slate-400">Примечание к передаче
                <textarea className={fieldClass + ' mt-1'} maxLength={2000} rows={2}
                  value={handoffNote} onChange={event => setHandoffNote(event.target.value)} />
              </label>
              <button className={buttonClass} disabled={busy || !handoffQuantity.trim()}>
                Передать на следующий этап
              </button>
            </form> : <p className="text-slate-400 text-xs">
              Новая передача доступна только для активной партии с подходящим следующим
              шагом, после подтверждения предыдущей передачи.
            </p>}
          </div>
          {transitions[selectedBatchRow.status].length > 0 && <form className="space-y-2"
            onSubmit={event => { event.preventDefault(); void run(async () => {
              await planningApi.changeBatchStatus(connection, selectedBatchRow.id, {
                expectedStatus: selectedBatchRow.status, status: nextStatus,
                ...(statusReason.trim() ? { reason: statusReason.trim() } : {}),
              });
              setStatusReason('');
            }, 'Статус партии обновлён'); }}>
            <label className="block text-xs text-slate-400">Новый статус
              <select className={fieldClass + ' mt-1'} value={nextStatus}
                onChange={event => setNextStatus(event.target.value as BatchStatus)}>
                {transitions[selectedBatchRow.status].map(s => <option key={s} value={s}>{statusNames[s]}</option>)}
              </select>
            </label>
            {selectedBatchRow.status === 'in_progress' && <p className="text-xs text-sky-200">
              Перед завершением партии подтвердите выполнение всех этапов маршрута
              и приёмку каждой отправленной передачи. Проверка проводится сервером.
            </p>}
            <label className="block text-xs text-slate-400">Причина (обязательно при остановке/списании)
              <textarea className={fieldClass + ' mt-1'} rows={2} maxLength={2000}
                value={statusReason} onChange={event => setStatusReason(event.target.value)} />
            </label>
            <button type="submit" className={buttonClass} disabled={busy ||
              !transitions[selectedBatchRow.status].includes(nextStatus) ||
              (['hold', 'scrapped'].includes(nextStatus) && !statusReason.trim())}>
              Сохранить статус</button>
          </form>}
          <ol className="space-y-2 text-sm">
            {events.map(event => <li key={event.number} className="border-l-2 border-slate-600 pl-3 text-slate-300">
              #{event.number} · {statusNames[event.toStatus]} · {new Date(event.occurredAt).toLocaleString('ru-RU')}
              {event.reason && <p className="text-slate-400 whitespace-pre-wrap">{event.reason}</p>}
            </li>)}
          </ol>
        </div>}
      </div>}
    </div>}
  </section>;
}
