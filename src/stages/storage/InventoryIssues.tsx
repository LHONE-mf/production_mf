import React, { useEffect, useRef, useState } from 'react';
import { useServerConnection } from '../../core/sync/serverConnection';
import { requireFreshDeviceProof } from '../../core/sync/deviceProofClient';
import { useAuthStore } from '../../core/store/authStore';
import type { HybridSession } from '../../core/sync/hybridClient';
import { inventoryScopeKey, type InventoryScope, type ReceivingDraft } from '../../core/sync/inventoryOutbox';
import { freezeInventoryIssue, sendInventoryIssue, inventoryIssueProposals, loadInventoryIssueContext, loadInventoryIssues, loadIssueBatches, loadIssueOptions, issueActions, issueManager, type InventoryIssue, type InventoryIssueContext, type InventoryIssueIntent, type IssueBatch, type IssueOption, type IssueLabels } from '../../core/sync/inventoryIssues';
import { InventoryIssueCard, issueButton, issueControl } from './InventoryIssueCard';
import { InventoryIdentificationPanel } from './InventoryIdentificationPanel';
function visibleProposal(row: ReceivingDraft, context: InventoryIssueContext) { if (issueManager(context)) return true; try { return !['reserve', 'approve', 'dispatch'].includes(row.fields.kind) && !(row.fields.kind === 'cancel' && JSON.parse(row.fields.bases ?? '{}').issue?.stockId); } catch { return false; } }
export function InventoryIssues() {
  const connection = useServerConnection(), user = useAuthStore(s => s.currentUser), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  let proven = false;
  try { if (connection) proven = requireFreshDeviceProof(connection.session).deviceId === connection.selectedDeviceId && now < (connection.session.deviceProofExpiresAt ?? 0) - 5000; } catch { /* Existing connection screen owns proof renewal. */ }
  const scope = connection ? { serverUrl: connection.serverUrl, organizationId: connection.organizationId, actorId: connection.serverActorId, deviceId: connection.selectedDeviceId } : null;
  return <section aria-label="Запросы и выдача в производство" className="min-w-0 space-y-3 rounded bg-slate-800 p-3 break-words"><h3 className="font-semibold">Запросы и выдача в производство</h3>
    {connection && scope && user && proven ? <InventoryIssuesPanel key={inventoryScopeKey(scope) + user.id + connection.session.deviceProofExpiresAt} session={connection.session} scope={scope} localActorId={user.id} /> : <p>Подключитесь и подтвердите устройство в разделе Синхронизация. Исходные запросы сохраняются на устройстве. Производственные сотрудники видят только свои запросы и назначенные передачи в своём цехе.</p>}
  </section>;
}
export function InventoryIssuesPanel({ session, scope, localActorId }: { session: HybridSession; scope: InventoryScope; localActorId: string }) {
  const [context, setContext] = useState<InventoryIssueContext | null>(null), [issues, setIssues] = useState<InventoryIssue[]>([]), [issueAfter, setIssueAfter] = useState<string | null>(null), [batches, setBatches] = useState<IssueBatch[]>([]), [batchAfter, setBatchAfter] = useState<{ id: string; step: number } | null>(null);
  const [batchKey, setBatchKey] = useState(''), [materials, setMaterials] = useState<IssueOption[]>([]), [recipients, setRecipients] = useState<IssueOption[]>([]), [materialAfter, setMaterialAfter] = useState<string | null>(null), [recipientAfter, setRecipientAfter] = useState<string | null>(null);
  const [labels,setLabels]=useState<Record<string,IssueLabels>>({});
  const [materialId, setMaterialId] = useState(''), [recipientId, setRecipientId] = useState(''), [quantity, setQuantity] = useState(''), [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [proposals, setProposals] = useState<ReceivingDraft[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [at, setAt] = useState<number | null>(null);
  const running = useRef(false), mounted = useRef(true), scopeIdentity = inventoryScopeKey(scope);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [scopeIdentity, localActorId, session]);
  const batch = batches.find(b => b.id + ':' + b.stepNumber === batchKey), material = materials.find(m => m.id === materialId);
  async function refreshProposals() { const rows = await inventoryIssueProposals(scope, localActorId); if (mounted.current) setProposals(rows); }
  async function work(task: () => Promise<void>) { if (running.current) return; running.current = true; setBusy(true); setError(''); try { await task(); } catch (e) { if (mounted.current) {setError(String(e));if(/HTTP (401|403)|утрачены/.test(String(e)))setContext(null);} } finally { if (mounted.current) { await refreshProposals().catch(() => setError('Исходные запросы сохранены, но не прочитаны')); setBusy(false); } running.current = false; } }
  async function refresh() {
    const ctx = await loadInventoryIssueContext(session, scope), [items, options] = await Promise.all([loadInventoryIssues(session, scope, ctx), loadIssueBatches(session, scope, ctx)]);
    if (!mounted.current) return;
    setContext(ctx); setIssues(items.items); setLabels(items.labels); setIssueAfter(items.nextAfter); setBatches(options.items); setBatchAfter(options.nextAfter ? { id: options.nextAfter, step: options.nextStep } : null); setBatchKey(''); setMaterials([]); setRecipients([]); setMaterialAfter(null); setRecipientAfter(null); setAt(Date.now());
  }
  async function options(resource: 'materials' | 'recipients', next?: string) {
    if (!context || !batch) throw Error('Выберите партию и её шаг'); const page = await loadIssueOptions(session, scope, context, batch, resource, next);
    if (resource === 'materials') { setMaterials(rows => next ? [...rows, ...page.items] : page.items); setMaterialAfter(page.nextAfter); } else { setRecipients(rows => next ? [...rows, ...page.items] : page.items); setRecipientAfter(page.nextAfter); }
  }
  return <div className="space-y-3">
    <p>Запрос → резерв → одобрение Chief / Manager → физическая выдача → получение назначенным сотрудником. Выдача и получение не означают расход в производстве.</p>
    <button type="button" className={issueButton} disabled={busy} onClick={() => void work(refresh)}>Обновить запросы и доступные партии</button>
    {context && <>
      {!context.warehouseLevel&&<InventoryIdentificationPanel scope={scope} session={session} localActorId={localActorId} epoch={context.epoch} batchOnly/>}
      <p>Данные прочитаны: {at && new Date(at).toLocaleString('ru-RU')}. Для новых состояний обновите вручную. Доступ: {context.warehouseLevel ?? 'Только свои передачи в цехе'}. {context.postingEnabled ? 'Подтверждение выполняется сервером.' : 'Проведение приостановлено.'}</p>
      <form aria-label="Запрос материала в производство" className="space-y-2" onSubmit={e => { e.preventDefault(); void work(async () => {
        if (!batch || !material?.unit || !recipients.some(r => r.id === recipientId) || !/^[1-9]\d*$/.test(quantity) || !Number.isSafeInteger(Number(quantity))) throw Error('Выберите материал, партию, назначенного получателя и целое количество');
        await freezeInventoryIssue(scope, localActorId, context, { kind: 'request', operationId: crypto.randomUUID(), issueId: crypto.randomUUID(), deviceId: scope.deviceId, materialId, productionBatchId: batch.id, stepNumber: batch.stepNumber, recipientId, quantity: Number(quantity), reason: reason.trim(), evidence: evidence.trim() }, { unit: material.unit, workshopId: batch.workshopId });
      }); }}>
        <fieldset disabled={busy} className="space-y-2"><legend>Новый запрос — отдельная отправка после сохранения</legend>
          <label>Производственная партия и шаг<select aria-label="Производственная партия и шаг" className={issueControl} value={batchKey} onChange={e => { setBatchKey(e.target.value); setMaterials([]); setRecipients([]); setMaterialId(''); setRecipientId(''); setMaterialAfter(null); setRecipientAfter(null); }}><option value="">Выберите доступный шаг партии</option>{batches.map(b => <option key={b.id + ':' + b.stepNumber} value={b.id + ':' + b.stepNumber}>{b.batchCode} · {b.stepNumber}. {b.name} · {b.workshopId}</option>)}</select></label>
          {batchAfter && <button type="button" className={issueButton} onClick={() => void work(async () => { const p = await loadIssueBatches(session, scope, context, batchAfter.id, batchAfter.step); setBatches(rows => [...rows, ...p.items]); setBatchAfter(p.nextAfter ? { id: p.nextAfter, step: p.nextStep } : null); })}>Следующие партии / шаги</button>}
          <button type="button" className={issueButton} disabled={!batch} onClick={() => void work(async () => { await options('materials'); await options('recipients'); })}>Загрузить материалы и получателей шага</button>
          <label>Материал для производства<select aria-label="Материал для производства" required className={issueControl} value={materialId} onChange={e => setMaterialId(e.target.value)}><option value="">Выберите материал</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name} ({m.code}) · {m.unit}</option>)}</select></label>
          {materialAfter && <button type="button" className={issueButton} onClick={() => void work(() => options('materials', materialAfter))}>Следующие материалы запроса</button>}
          <label>Назначенный получатель<select aria-label="Назначенный получатель" required className={issueControl} value={recipientId} onChange={e => setRecipientId(e.target.value)}><option value="">Выберите сотрудника цеха</option>{recipients.map(r => <option key={r.id} value={r.id}>{r.name} · {r.id}</option>)}</select></label>
          {recipientAfter && <button type="button" className={issueButton} onClick={() => void work(() => options('recipients', recipientAfter))}>Следующие получатели</button>}
          <label>Запрашиваемое количество ({material?.unit ?? 'базовые единицы'})<input aria-label="Запрашиваемое количество" required inputMode="numeric" className={issueControl} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
          <label>Основание запроса материала<input aria-label="Основание запроса материала" required maxLength={2000} className={issueControl} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <label>Документ потребности<input aria-label="Документ потребности" required maxLength={2000} className={issueControl} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
          <p>После загрузки вариантов запрос можно сохранить без сети. Он сохранит исходный ID и историю; отправка и проверки выполняются отдельно онлайн.</p>
          <button className={issueButton}>Сохранить запрос без выдачи</button>
        </fieldset>
      </form>
      <h4>Сохранённые действия выдачи</h4><p>Если ответ неизвестен, повторяйте исходный ID. Конфликт не перепроводится. После восстановления истории сохраните исходный запрос и сверяйте результат перед созданием нового.</p>
      {proposals.filter(r => visibleProposal(r, context)).map(row => {
        let intent: InventoryIssueIntent | undefined; try { intent = JSON.parse(row.fields.intent); } catch { /* Retain malformed evidence. */ }
        return <div key={row.key} className="rounded border border-slate-600 p-2"><p>{intent ? issueActions[intent.kind] : 'Повреждённое исходное действие'} · Операция: {row.operationId} · {row.fields.state === 'accepted' ? 'Сервер подтвердил' : row.fields.state === 'pending' ? 'Ожидает отдельного подтверждения / точного повтора' : 'Конфликт / отклонено — исходный запрос сохранён'}</p>{intent && <p>Запрос {intent.issueId} · {intent.kind === 'request' ? `${intent.quantity} · Партия ${intent.productionBatchId} · Получатель ${intent.recipientId}` : `Исходная версия ${intent.expectedIssueRevision}`} · {intent.reason} · Свидетельство: {intent.evidence}</p>}
          {row.fields.epoch !== context.epoch && <p role="alert">История изменилась. Исходный запрос удержан для сверки, отправка запрещена.</p>}
          {row.fields.state === 'pending' && row.fields.epoch === context.epoch && <button type="button" className={issueButton} disabled={busy || !context.postingEnabled} onClick={() => void work(async () => { await sendInventoryIssue(session, scope, localActorId, row.key); await refresh(); })}>Отправить сохранённое действие {row.operationId?.slice(0, 8)}</button>}
        </div>;
      })}
      {!issues.length && <p>Доступных запросов пока нет.</p>}
      {issues.map(issue => <InventoryIssueCard key={issue.id + ':' + context.epoch} {...{ session, scope, context, localActorId, issue }} labels={labels[issue.id]} onPrepared={refreshProposals} />)}
      {issueAfter && <button type="button" className={issueButton} disabled={busy} onClick={() => void work(async () => { const p = await loadInventoryIssues(session, scope, context, issueAfter); setIssues(rows => [...rows, ...p.items]); setLabels(rows=>({...rows,...p.labels})); setIssueAfter(p.nextAfter); })}>Следующие запросы выдачи</button>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
