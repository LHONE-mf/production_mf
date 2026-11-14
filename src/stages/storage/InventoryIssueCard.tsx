import React, { useState } from 'react';
import type { HybridSession } from '../../core/sync/hybridClient';
import type { InventoryScope, InventoryStockSnapshot } from '../../core/sync/inventoryOutbox';
import { freezeInventoryIssue, prepareInventoryIssue, loadIssueSources, loadIssueHistory, issueActions, issueManager, issueStates, type InventoryIssue, type InventoryIssueContext, type InventoryIssueIntent, type InventoryIssueKind, type IssueHistory, type IssueLabels } from '../../core/sync/inventoryIssues';
export const issueControl = 'block min-h-11 w-full rounded bg-slate-900 p-2';
export const issueButton = 'min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50';
export function InventoryIssueCard({ session, scope, context, localActorId, issue, labels, onPrepared }: { session: HybridSession; scope: InventoryScope; context: InventoryIssueContext; localActorId: string; issue: InventoryIssue; labels?: IssueLabels; onPrepared: () => Promise<void> }) {
  const [sources, setSources] = useState<InventoryStockSnapshot[]>([]), [after, setAfter] = useState<string | null>(null), [stockId, setStockId] = useState('');
  const [kind, setKind] = useState<Exclude<InventoryIssueKind, 'request'>>('reserve'), [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [history, setHistory] = useState<IssueHistory[]>([]), [historyAfter, setHistoryAfter] = useState<number | null>(null);
  const manager = issueManager(context), stock = sources.find(s => s.stockId === (issue.stockId ?? stockId));
  const allowed: Exclude<InventoryIssueKind, 'request'>[] = [];
  if (manager) { if (issue.state === 'requested') allowed.push('reserve'); if (issue.state === 'reserved' || issue.state === 'approved') allowed.push('approve'); if (issue.state === 'approved') allowed.push('dispatch'); }
  if (issue.recipientId === scope.actorId && issue.state === 'dispatched') allowed.push('receive');
  if (['requested', 'reserved', 'approved'].includes(issue.state) && (manager || issue.state === 'requested' && issue.requestedBy === scope.actorId)) allowed.push('cancel');
  const selected = allowed.includes(kind) ? kind : allowed[0];
  async function work(task: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await task(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  async function loadSources(next?: string) { const page = await loadIssueSources(session, scope, context, issue, next); setSources(rows => next ? [...rows, ...page.items] : page.items); setAfter(page.nextAfter); }
  return <article aria-label={'Выдача ' + issue.id} className="min-w-0 space-y-2 break-words rounded border border-slate-600 p-3">
    <h4 className="font-semibold">{issueStates[issue.state]} · {issue.quantity} {issue.unit}</h4>
    <p>Запрос: {issue.id} · Версия {issue.revision}</p><p>Материал: {labels ? `${labels.materialName} (${labels.materialCode})` : issue.materialId} · Производственная партия: {labels?.batchCode ?? issue.productionBatchId} · Шаг {issue.stepNumber} · Цех: {issue.workshopId}</p>
    <p>Заявитель: {issue.requestedBy} · Назначенный получатель: {labels?.recipientName ?? issue.recipientId} ({issue.recipientId})</p>
    {issue.source && <p>Контейнер: {issue.source.stockId} · Партия производителя: {issue.source.manufacturerLot} · Место: {issue.source.locationId} {issue.source.expiresAt && <>· Годность до (UTC): {issue.source.expiresAt}</>}</p>}
    {issue.approvalOperationId && <p>Одобрение: {issue.approvalOperationId} · Chief / Manager: {issue.approvedBy} · Версия контейнера {issue.approvedStockRevision}. Изменение контейнера требует повторного одобрения.</p>}
    {manager && !['dispatched', 'received', 'cancelled'].includes(issue.state) && <><button type="button" className={issueButton} disabled={busy} onClick={() => void work(() => loadSources())}>Загрузить контейнеры материала</button>{after && <button type="button" className={issueButton} disabled={busy} onClick={() => void work(() => loadSources(after))}>Следующие контейнеры</button>}
      {issue.state === 'requested' && <label>Исходный контейнер<select aria-label="Исходный контейнер" className={issueControl} value={stockId} onChange={e => setStockId(e.target.value)}><option value="">Выберите отдельный контейнер</option>{sources.map(s => <option key={s.stockId} value={s.stockId} disabled={s.quality !== 'released' || s.available < issue.quantity || !!s.expiresAt && Date.parse(s.expiresAt) <= Date.now()}>{s.stockId} · {s.manufacturerLot} · {s.locationId} · {s.quality} · свободно {s.available} {s.unit}</option>)}</select></label>}
      {stock && <p>Последний прочитанный контейнер: {stock.stockId} · На руках {stock.onHand} · Резерв {stock.reserved} · Свободно {stock.available} {stock.unit} · Версия {stock.revision} · Качество {stock.quality}</p>}
    </>}
    {!!allowed.length && <form aria-label={'Действие выдачи ' + issue.id} className="space-y-2" onSubmit={e => { e.preventDefault(); void work(async () => {
      if (!selected) return;
      const common = { operationId: crypto.randomUUID(), deviceId: scope.deviceId, issueId: issue.id, expectedIssueRevision: issue.revision, reason: reason.trim(), evidence: evidence.trim() };
      let intent: InventoryIssueIntent;
      if (selected === 'reserve') { if (!stock) throw Error('Загрузите и выберите разрешённый контейнер'); intent = { ...common, kind: 'reserve', stockId: stock.stockId, expectedStockRevision: stock.revision }; }
      else if (selected === 'approve' || selected === 'dispatch') { if (!stock) throw Error('Загрузите актуальный контейнер перед одобрением / выдачей'); intent = { ...common, kind: selected, expectedStockRevision: stock.revision }; }
      else if (selected === 'cancel') { if (issue.stockId && !stock) throw Error('Загрузите контейнер для снятия резерва'); intent = { ...common, kind: 'cancel', ...(stock ? { expectedStockRevision: stock.revision } : {}) }; }
      else intent = { ...common, kind: 'receive' };
      const bases = { issue, ...(stock ? { stock } : {}) };
      if (selected === 'receive' || selected === 'cancel' && !issue.stockId) await freezeInventoryIssue(scope, localActorId, context, intent, bases);
      else await prepareInventoryIssue(session, scope, localActorId, intent, bases, context.epoch);
      await onPrepared();
    }); }}>
      <fieldset disabled={busy} className="space-y-2"><label>Действие выдачи<select aria-label="Действие выдачи" className={issueControl} value={selected} onChange={e => setKind(e.target.value as typeof kind)}>{allowed.map(k => <option key={k} value={k}>{issueActions[k]}</option>)}</select></label>
        <p>Резервирование и одобрение не выдают материал. Физическую передачу подтверждает Chief / Manager. Получение подтверждает назначенный сотрудник. Ни один шаг не записывает расход.</p>
        <label>Основание выдачи<input aria-label="Основание выдачи" required maxLength={2000} className={issueControl} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <label>Свидетельство передачи / одобрения<input aria-label="Свидетельство передачи / одобрения" required maxLength={2000} className={issueControl} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
        <button className={issueButton}>Сохранить действие для отдельного подтверждения</button>
      </fieldset>
    </form>}
    <button type="button" className={issueButton} disabled={busy} onClick={() => void work(async () => { const p = await loadIssueHistory(session, scope, context, issue.id); setHistory(p.items); setHistoryAfter(p.nextAfter); })}>История выдачи</button>
    {historyAfter !== null && <button type="button" className={issueButton} disabled={busy} onClick={() => void work(async () => { const p = await loadIssueHistory(session, scope, context, issue.id, historyAfter); setHistory(h => [...h, ...p.items]); setHistoryAfter(p.nextAfter); })}>Следующие события выдачи</button>}
    {history.map(h => <p key={h.operationId}>{issueActions[h.kind as InventoryIssueKind]} · {h.recordedAt} · Автор {h.actorId} · Устройство {h.deviceId} · Версия {h.resultingRevision} · {h.reason} · Свидетельство: {h.evidence}</p>)}
    {error && <p role="alert">{error}</p>}
  </article>;
}
