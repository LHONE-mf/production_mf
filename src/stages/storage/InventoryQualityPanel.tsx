import React, { useEffect, useRef, useState } from 'react';
import type { HybridSession } from '../../core/sync/hybridClient';
import type { InventoryScope, InventoryStockSnapshot, InventoryQualityRequest, ReceivingDraft } from '../../core/sync/inventoryOutbox';
import { prepareInventoryQuality, sendInventoryQuality, inventoryQualityProposals, loadInventoryQualityHistory, qualityDispositionLabels, type InventoryQualityHistory } from '../../core/sync/inventoryQuality';
const control = 'block min-h-11 w-full rounded bg-slate-900 p-2';
const button = 'min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50';
function summary(row: ReceivingDraft) { try { const request: InventoryQualityRequest = JSON.parse(row.fields.request); return `${qualityDispositionLabels[request.disposition]} · исходная версия ${request.expectedRevision} · ${request.reason} · Свидетельство: ${request.evidence}`; } catch { return 'Повреждённый исходный запрос сохранён для сверки'; } }
export function InventoryQualityPanel({ session, scope, localActorId, stock, canDecide, onChanged }: { session: HybridSession; scope: InventoryScope; localActorId: string; stock: InventoryStockSnapshot; canDecide: boolean; onChanged: () => void }) {
  const [disposition, setDisposition] = useState<InventoryQualityRequest['disposition']>('hold'), [reason, setReason] = useState(''), [evidence, setEvidence] = useState('');
  const [proposals, setProposals] = useState<ReceivingDraft[]>([]), [history, setHistory] = useState<InventoryQualityHistory[]>([]), [after, setAfter] = useState<number | null>(null), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = useRef(false), generation = useRef(0);
  useEffect(() => { const run = ++generation.current; void inventoryQualityProposals(scope, localActorId, stock.stockId).then(rows => { if (run === generation.current) setProposals(rows); }).catch(() => { if (run === generation.current) setError('Не удалось прочитать сохранённые решения'); }); return () => { generation.current++; }; }, [scope.serverUrl, scope.organizationId, scope.actorId, scope.deviceId, localActorId, stock.stockId]);
  async function work(task: () => Promise<void>) {
    if (running.current) return; running.current = true; setBusy(true); setError(''); const run = generation.current;
    try { await task(); } catch (error) { if (run === generation.current) setError(String(error)); }
    finally { if (run === generation.current) { try { setProposals(await inventoryQualityProposals(scope, localActorId, stock.stockId)); } catch { setError('Исходные решения сохранены, но не прочитаны'); } setBusy(false); } running.current = false; }
  }
  const expired = !!stock.expiresAt && Date.parse(stock.expiresAt) <= Date.now();
  return <details aria-label={'Качество контейнера ' + stock.stockId} className="space-y-2 rounded border border-slate-600 p-2">
    <summary className="min-h-11 cursor-pointer py-2">Решения о качестве / история</summary>
    <p>Приёмка остаётся в карантине до документированного решения Chief. QA не перемещает количество. Окончательное отклонение запрещает последующий выпуск.</p>
    {stock.manufacturedOn && <p>Изготовлено (дата UTC): {stock.manufacturedOn}</p>}
    {stock.expiresAt && <p>Истечение годности (UTC): {new Date(stock.expiresAt).toLocaleString('ru-RU', { timeZone: 'UTC' })}. {expired ? 'Срок истёк. Использование запрещено.' : 'Срок проверяется сервером при каждом решении и резервировании.'}</p>}
    {canDecide && <form aria-label={'Решение Chief по контейнеру ' + stock.stockId} className="space-y-2" onSubmit={event => { event.preventDefault(); void work(async () => { await prepareInventoryQuality(session, scope, localActorId, stock, disposition, reason, evidence); }); }}>
      <p>Только Chief. Подготовка доступна онлайн; отдельная отправка подтвердит исходную версию {stock.revision}. При неизвестном ответе повторяйте исходный ID.</p>
      <fieldset disabled={busy || stock.disposition === 'reject'} className="space-y-2">
        <label>Решение о качестве<select aria-label="Решение о качестве" className={control} value={disposition} onChange={event => setDisposition(event.target.value as typeof disposition)}>{Object.entries(qualityDispositionLabels).map(([value, label]) => <option key={value} value={value} disabled={value === 'release' && expired}>{label}</option>)}</select></label>
        <label>Основание решения Chief<input aria-label="Основание решения Chief" required maxLength={2000} className={control} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label>Документ / свидетельство QA<input aria-label="Документ / свидетельство QA" required maxLength={2000} className={control} value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
        <button className={button}>Проверить решение о качестве</button>
      </fieldset>
    </form>}
    {canDecide && proposals.map(row => <div key={row.key} className="rounded border border-slate-600 p-2"><p>{summary(row)}</p><p>Операция QA: {row.operationId} · {row.fields.state === 'accepted' ? 'Сервер подтвердил' : row.fields.state === 'conflict' ? 'Конфликт — исходная версия сохранена' : row.fields.state === 'rejected' ? 'Отклонено — свидетельства сохранены' : 'Ожидает отдельной отправки / точного повтора'}</p>{row.fields.state === 'pending' && <button type="button" disabled={busy} className={button} onClick={() => void work(async () => { await sendInventoryQuality(session, scope, localActorId, row.key); onChanged(); })}>Подтвердить решение Chief {row.operationId?.slice(0, 8)}</button>}</div>)}
    <button type="button" disabled={busy} className={button} onClick={() => void work(async () => { const page = await loadInventoryQualityHistory(session, scope, stock.stockId); setHistory(page.items); setAfter(page.nextAfter); setLoaded(true); })}>Загрузить историю качества</button>
    {after !== null && <button type="button" disabled={busy} className={button} onClick={() => void work(async () => { const page = await loadInventoryQualityHistory(session, scope, stock.stockId, after); setHistory(rows => [...rows, ...page.items]); setAfter(page.nextAfter); })}>Следующие решения QA</button>}
    {loaded && !history.length && <p>Решений QA на сервере пока нет.</p>}
    {history.map(item => <p key={item.operationId}>{qualityDispositionLabels[item.disposition]} · {new Date(item.recordedAt).toLocaleString('ru-RU')} · Chief {item.actorId} · Устройство {item.deviceId} · Версия {item.resultingRevision} · {item.reason} · Свидетельство: {item.evidence}</p>)}
    {error && <p role="alert">{error}</p>}
  </details>;
}
