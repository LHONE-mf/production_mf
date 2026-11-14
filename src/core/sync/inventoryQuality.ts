import type { HybridSession } from './hybridClient';
import { inventoryRequest, preflightInventoryStream } from './inventoryClient';
import { loadWarehouseAccess } from './inventoryCatalogClient';
import { archiveInventoryAcknowledgement, inventoryOutbox, inventoryScopeKey, sameInventoryStock, validateInventoryStock, type InventoryScope, type InventoryStockSnapshot, type InventoryQualityRequest, type ReceivingDraft } from './inventoryOutbox';
import { withInventorySync } from './inventorySyncLock';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const qualityDispositionLabels = { release: 'Разрешить использование', hold: 'Удержать для проверки', block: 'Заблокировать', reject: 'Отклонить окончательно' };
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2000;
function validateRequest(request: InventoryQualityRequest, base: InventoryStockSnapshot, scope: InventoryScope) {
  validateInventoryStock(base);
  if (![request.operationId, request.stockId, request.deviceId].every(value => typeof value === 'string' && uuid.test(value)) || request.stockId !== base.stockId || request.deviceId !== scope.deviceId || request.expectedRevision !== base.revision || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || request.expectedRevision > 2147483646 || !['release', 'hold', 'block', 'reject'].includes(request.disposition) || !text(request.reason) || !text(request.evidence)) throw Error('Invalid quality disposition proposal');
}
export function inventoryQualityProposals(scope: InventoryScope, localActorId: string, stockId?: string) {
  const scopeKey = inventoryScopeKey(scope);
  return inventoryOutbox.receivingDrafts.filter(row => { try { const key = JSON.parse(row.key); return key[0] === scopeKey && key[1] === localActorId && key[2] === 'quality' && (!stockId || row.fields.stockId === stockId); } catch { return false; } }).toArray();
}
/** Online-only Chief preparation; the original version/evidence/epoch are durable intent. */
export async function prepareInventoryQuality(session: HybridSession, scope: InventoryScope, localActorId: string, base: InventoryStockSnapshot, disposition: InventoryQualityRequest['disposition'], reason: string, evidence: string) {
  const request: InventoryQualityRequest = { operationId: crypto.randomUUID(), stockId: base.stockId, deviceId: scope.deviceId, expectedRevision: base.revision, disposition, reason: reason.trim(), evidence: evidence.trim() };
  validateRequest(request, base, scope);
  if (!localActorId.trim() || base.disposition === 'reject' || (disposition === 'release' && base.expiresAt && Date.parse(base.expiresAt) <= Date.now())) throw Error('Материал отклонён или срок годности истёк');
  if ((await loadWarehouseAccess(session, scope)).level !== 'chief') throw Error('Решение о качестве подтверждает только Chief');
  const epoch = await preflightInventoryStream(session, scope);
  const row: ReceivingDraft = { key: JSON.stringify([inventoryScopeKey(scope), localActorId, 'quality', request.operationId]), revision: 1, operationId: request.operationId,
    fields: { stockId: base.stockId, request: JSON.stringify(request), base: JSON.stringify(base), epoch, state: 'pending', createdAt: new Date().toISOString() } };
  await inventoryOutbox.receivingDrafts.add(row); return row;
}
export function sendInventoryQuality(session: HybridSession, scope: InventoryScope, localActorId: string, key: string) {
  return withInventorySync(scope, async () => {
    const row = (await inventoryQualityProposals(scope, localActorId)).find(row => row.key === key);
    if (!row || row.fields.state !== 'pending' || !uuid.test(row.fields.epoch)) throw Error('Нет ожидающего исходного решения о качестве');
    const request: InventoryQualityRequest = JSON.parse(row.fields.request), base: InventoryStockSnapshot = JSON.parse(row.fields.base);
    validateRequest(request, base, scope); if (row.operationId !== request.operationId) throw Error('Quality intent changed');
    if ((await loadWarehouseAccess(session, scope)).level !== 'chief') throw Error('Только Chief может подтвердить качество');
    if (await preflightInventoryStream(session, scope) !== row.fields.epoch) throw Error('История изменилась. Решение сохранено для сверки');
    const response = await inventoryRequest(session, scope, '/inventory/stocks/' + request.stockId + '/quality-dispositions', { method: 'POST', headers: { 'x-inventory-epoch': row.fields.epoch }, body: row.fields.request });
    if ([400, 404, 409].includes(response.status)) {
      await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, async () => { const current = await inventoryOutbox.receivingDrafts.get(key); if (JSON.stringify(current) !== JSON.stringify(row)) throw Error('Quality intent changed'); await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: response.status === 409 ? 'conflict' : 'rejected', error: 'HTTP ' + response.status } }); });
      throw Error('Решение не принято; исходная версия и свидетельства сохранены: HTTP ' + response.status);
    }
    if (!response.ok) throw Error('Ответ неизвестен или доступ утрачен; повторяйте тот же ID: HTTP ' + response.status);
    const raw = await response.json();
    if (!raw || raw.operationId !== request.operationId || raw.status !== (response.status === 201 ? 'confirmed' : 'duplicate')) throw Error('Invalid quality acknowledgement');
    validateInventoryStock(raw.stock);
    const expected: InventoryStockSnapshot = { ...base, quality: request.disposition === 'release' ? 'released' : 'blocked', disposition: request.disposition, revision: base.revision + 1 };
    if (!sameInventoryStock(raw.stock, expected)) throw Error('Quality acknowledgement differs from the frozen stock/evidence intent');
    await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, inventoryOutbox.stocks, inventoryOutbox.acknowledgements, async () => {
      if (JSON.stringify(await inventoryOutbox.receivingDrafts.get(key)) !== JSON.stringify(row)) throw Error('Quality intent changed while awaiting acknowledgement');
      const scopeKey = inventoryScopeKey(scope), prior = await inventoryOutbox.stocks.get([scopeKey, request.stockId]);
      if (prior && prior.revision === raw.stock.revision && !sameInventoryStock(prior, raw.stock)) throw Error('Quality stock cache conflicts with acknowledged version');
      if (!prior || prior.revision < raw.stock.revision) await inventoryOutbox.stocks.put({ ...raw.stock, scopeKey });
      await archiveInventoryAcknowledgement({ operationId: request.operationId, scopeKey, epoch: row.fields.epoch, kind: 'quality_change', stockId: request.stockId, request, base, stock: raw.stock, receivedAt: Date.now() });
      await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: 'accepted', acknowledgement: JSON.stringify(raw), acceptedAt: new Date().toISOString() } });
    });
  });
}
export interface InventoryQualityHistory { operationId: string; stockId: string; sequence: number; disposition: InventoryQualityRequest['disposition']; actorId: string; deviceId: string; reason: string; evidence: string; expectedRevision: number; resultingRevision: number; recordedAt: string }
export async function loadInventoryQualityHistory(session: HybridSession, scope: InventoryScope, stockId: string, after = 0, limit = 50) {
  if (!uuid.test(stockId) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid quality history page');
  const response = await inventoryRequest(session, scope, '/inventory/stocks/' + stockId + '/quality-history?' + new URLSearchParams({ deviceId: scope.deviceId, after: String(after), limit: String(limit) }));
  if (!response.ok) throw Error('История качества недоступна: HTTP ' + response.status);
  const raw = await response.json(), epoch = (await inventoryOutbox.streams.get(inventoryScopeKey(scope)))?.epoch;
  if (!raw || raw.epoch !== epoch || !Array.isArray(raw.items) || raw.items.length > limit || typeof raw.hasMore !== 'boolean') throw Error('Invalid quality history scope/epoch');
  let previous = after; const items: InventoryQualityHistory[] = [];
  for (const item of raw.items) {
    if (!item || item.stockId !== stockId || ![item.operationId, item.actorId, item.deviceId].every(value => typeof value === 'string' && uuid.test(value)) || !Number.isSafeInteger(item.sequence) || item.sequence <= previous || !['release', 'hold', 'block', 'reject'].includes(item.disposition) || !text(item.reason) || !text(item.evidence) || !Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1 || item.resultingRevision !== item.expectedRevision + 1 || typeof item.recordedAt !== 'string' || !Number.isFinite(Date.parse(item.recordedAt))) throw Error('Invalid quality history row');
    items.push(item); previous = item.sequence;
  }
  if (raw.hasMore ? items.length !== limit || raw.nextAfter !== previous : raw.nextAfter !== null) throw Error('Invalid quality history continuation');
  return { items, nextAfter: raw.nextAfter as number | null };
}
