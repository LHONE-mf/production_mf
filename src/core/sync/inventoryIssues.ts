import type { HybridSession } from './hybridClient';
import { inventoryRequest, preflightInventoryStream } from './inventoryClient';
import { loadInventoryIssueContext } from './inventoryIssueClient';
import { archiveInventoryAcknowledgement, inventoryOutbox, inventoryScopeKey, sameInventoryStock, validateInventoryStock, type InventoryScope, type InventoryStockSnapshot, type ReceivingDraft } from './inventoryOutbox';
import { withInventorySync } from './inventorySyncLock';
import { issueIdValid, issueBody, issueManager, issueSource, sameIssue, validateIssue, validateIssueIntent, type InventoryIssue, type InventoryIssueContext, type InventoryIssueIntent } from './inventoryIssueTypes';
export * from './inventoryIssueTypes';
export * from './inventoryIssueClient';
export function inventoryIssueProposals(scope: InventoryScope, localActorId: string) {
  return inventoryOutbox.receivingDrafts.filter(row => { try { const key = JSON.parse(row.key); return key[0] === inventoryScopeKey(scope) && key[1] === localActorId && key[2] === 'issue'; } catch { return false; } }).toArray();
}
interface Bases { issue?: InventoryIssue; stock?: InventoryStockSnapshot; unit?: InventoryStockSnapshot['unit']; workshopId?: string }
function expectedIssue(scope: InventoryScope, intent: InventoryIssueIntent, bases: Bases, checkExpiry = false): InventoryIssue {
  validateIssueIntent(intent, scope);
  if (intent.kind === 'request') {
    const result: InventoryIssue = { id: intent.issueId, materialId: intent.materialId, productionBatchId: intent.productionBatchId, stepNumber: intent.stepNumber, workshopId: bases.workshopId!, recipientId: intent.recipientId, requestedBy: scope.actorId, quantity: intent.quantity, unit: bases.unit!, state: 'requested', revision: 1, stockId: null, source: null, approvalOperationId: null, approvedStockRevision: null, approvedBy: null, approvedDeviceId: null, dispatchOperationId: null, receiptOperationId: null }; validateIssue(result); return result;
  }
  validateIssue(bases.issue); const base = bases.issue; if (base.id !== intent.issueId || base.revision !== intent.expectedIssueRevision) throw Error('Issue intent changed');
  const result = { ...base, revision: base.revision + 1 };
  if (intent.kind === 'reserve') { if (base.state !== 'requested' || !bases.stock || bases.stock.stockId !== intent.stockId) throw Error('Invalid reservation'); result.state = 'reserved'; result.stockId = intent.stockId; result.source = issueSource(bases.stock); }
  if (intent.kind === 'approve') { if (!['reserved', 'approved'].includes(base.state)) throw Error('Invalid approval'); Object.assign(result, { state: 'approved', approvalOperationId: intent.operationId, approvedStockRevision: intent.expectedStockRevision, approvedBy: scope.actorId, approvedDeviceId: scope.deviceId }); }
  if (intent.kind === 'dispatch') { if (base.state !== 'approved' || base.approvedStockRevision !== intent.expectedStockRevision) throw Error('Одобрение устарело. Требуется явное повторное одобрение'); result.state = 'dispatched'; result.dispatchOperationId = intent.operationId; }
  if (intent.kind === 'receive') { if (base.state !== 'dispatched' || base.recipientId !== scope.actorId) throw Error('Только назначенный получатель подтверждает получение'); result.state = 'received'; result.receiptOperationId = intent.operationId; }
  if (intent.kind === 'cancel') { if (!['requested', 'reserved', 'approved'].includes(base.state)) throw Error('Нельзя отменить физически выданное'); result.state = 'cancelled'; }
  if (intent.kind === 'reserve' || intent.kind === 'approve' || intent.kind === 'dispatch' || intent.kind === 'cancel' && base.stockId) {
    validateInventoryStock(bases.stock); const stock = bases.stock;
    if (stock.materialId !== base.materialId || stock.unit !== base.unit || stock.stockId !== result.stockId || !('expectedStockRevision' in intent) || stock.revision !== intent.expectedStockRevision) throw Error('Stock intent changed');
    if (intent.kind !== 'cancel' && (stock.quality !== 'released' || checkExpiry && stock.expiresAt && Date.parse(stock.expiresAt) <= Date.now())) throw Error('Материал не разрешён или срок годности истёк');
    if (intent.kind === 'reserve' ? stock.available < base.quantity : stock.reserved < base.quantity) throw Error('Недостаточно доступного / зарезервированного количества');
  }
  validateIssue(result); return result;
}
/** Request/recipient intent can be frozen offline from the last explicitly loaded scope. */
export async function freezeInventoryIssue(scope: InventoryScope, localActorId: string, context: InventoryIssueContext, intent: InventoryIssueIntent, bases: Bases = {}) {
  if (!localActorId.trim() || inventoryScopeKey(context) !== inventoryScopeKey(scope) || !issueIdValid(context.epoch) || !context.postingEnabled) throw Error('Invalid issue scope/history');
  if (['reserve', 'approve', 'dispatch'].includes(intent.kind) && !issueManager(context) || intent.kind === 'cancel' && !!bases.issue?.stockId && !issueManager(context)) throw Error('Требуется Chief / Warehouse Manager');
  const expected = expectedIssue(scope, intent, bases, true);
  const row: ReceivingDraft = { key: JSON.stringify([inventoryScopeKey(scope), localActorId, 'issue', intent.operationId]), revision: 1, operationId: intent.operationId, fields: { kind: intent.kind, intent: JSON.stringify(intent), request: JSON.stringify(issueBody(intent)), epoch: context.epoch, bases: JSON.stringify(bases), expected: JSON.stringify(expected), state: 'pending', createdAt: new Date().toISOString() } };
  await inventoryOutbox.receivingDrafts.add(row); return row;
}
/** Restricted approval/debit proposals require a fresh live permission and stock-history check. */
export async function prepareInventoryIssue(session: HybridSession, scope: InventoryScope, localActorId: string, intent: InventoryIssueIntent, bases: Bases, expectedEpoch: string) {
  const context = await loadInventoryIssueContext(session, scope);
  if(context.epoch!==expectedEpoch)throw Error('История изменилась. Обновите запрос и контейнер; исходное действие не перепривязано');
  if (['reserve', 'approve', 'dispatch'].includes(intent.kind) || intent.kind === 'cancel' && bases.issue?.stockId) { if (!issueManager(context)) throw Error('Требуется Chief / Warehouse Manager'); if (await preflightInventoryStream(session, scope) !== context.epoch) throw Error('История изменилась'); }
  return freezeInventoryIssue(scope, localActorId, context, intent, bases);
}
export function sendInventoryIssue(session: HybridSession, scope: InventoryScope, localActorId: string, key: string) {
  return withInventorySync(scope, async () => {
    const row = (await inventoryIssueProposals(scope, localActorId)).find(r => r.key === key); if (!row || row.fields.state !== 'pending' || !issueIdValid(row.fields.epoch)) throw Error('Нет исходного ожидающего запроса выдачи');
    const context = await loadInventoryIssueContext(session, scope);
    if (context.epoch !== row.fields.epoch || !context.postingEnabled) throw Error('История изменилась. Исходный запрос сохранён для сверки; не создавайте замену без проверки результата');
    const intent: InventoryIssueIntent = JSON.parse(row.fields.intent); validateIssueIntent(intent, scope);
    const bases: Bases = JSON.parse(row.fields.bases), restricted = ['reserve', 'approve', 'dispatch'].includes(intent.kind) || intent.kind === 'cancel' && !!bases.issue?.stockId;
    if (restricted && !issueManager(context)) throw Error('Полномочия Chief / Warehouse Manager утрачены; исходный запрос сохранён');
    if (restricted && await preflightInventoryStream(session, scope) !== row.fields.epoch) throw Error('История изменилась');
    const expected = expectedIssue(scope, intent, bases);
    if (row.operationId !== intent.operationId || row.fields.kind !== intent.kind || row.fields.request !== JSON.stringify(issueBody(intent)) || !sameIssue(JSON.parse(row.fields.expected), expected)) throw Error('Issue intent changed');
    const response = await inventoryRequest(session, scope, intent.kind === 'request' ? '/inventory/issues' : '/inventory/issues/' + intent.issueId + '/operations', { method: 'POST', headers: { 'x-inventory-epoch': row.fields.epoch }, body: row.fields.request });
    if ([400, 404, 409].includes(response.status)) {
      await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, async () => { if (JSON.stringify(await inventoryOutbox.receivingDrafts.get(key)) !== JSON.stringify(row)) throw Error('Issue intent changed'); await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: response.status === 409 ? 'conflict' : 'rejected', error: 'HTTP ' + response.status } }); });
      throw Error('Операция выдачи не принята; исходные ID, версии и свидетельства сохранены: HTTP ' + response.status);
    }
    if (!response.ok) throw Error('Результат неизвестен или доступ утрачен. Повторите тот же ID: HTTP ' + response.status);
    const raw = await response.json(); validateIssue(raw?.issue);
    if (raw.operationId !== intent.operationId || raw.status !== (response.status === 201 ? 'confirmed' : 'duplicate') || !sameIssue(raw.issue, expected)) throw Error('Invalid issue acknowledgement');
    const stockEffect = intent.kind === 'reserve' || intent.kind === 'dispatch' || intent.kind === 'cancel' && !!bases.issue?.stockId;
    if (stockEffect) { validateInventoryStock(raw.stock); validateInventoryStock(bases.stock); const base = bases.stock, quantity = expected.quantity;
      const stock = { ...base, revision: base.revision + 1, onHand: base.onHand - (intent.kind === 'dispatch' ? quantity : 0), reserved: base.reserved + (intent.kind === 'reserve' ? quantity : -quantity), available: base.available + (intent.kind === 'reserve' ? -quantity : intent.kind === 'cancel' ? quantity : 0) };
      if (!sameInventoryStock(raw.stock, stock)) throw Error('Invalid issue stock acknowledgement');
    } else if (raw.stock !== undefined) throw Error('Unexpected issue stock acknowledgement');
    await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, inventoryOutbox.stocks, inventoryOutbox.acknowledgements, async () => {
      if (JSON.stringify(await inventoryOutbox.receivingDrafts.get(key)) !== JSON.stringify(row)) throw Error('Issue intent changed while awaiting acknowledgement');
      if (stockEffect) {
        const scopeKey = inventoryScopeKey(scope), before = await inventoryOutbox.stocks.get([scopeKey, raw.stock.stockId]);
        if (before && before.revision === raw.stock.revision && !sameInventoryStock(before, raw.stock)) throw Error('Issue stock cache conflicts with acknowledged version');
        if (!before || before.revision < raw.stock.revision) await inventoryOutbox.stocks.put({ ...raw.stock, scopeKey });
        await archiveInventoryAcknowledgement({ operationId: intent.operationId, scopeKey, epoch: row.fields.epoch, kind: 'issue_' + intent.kind, stockId: raw.stock.stockId, request: intent, base: bases.stock, stock: raw.stock, receivedAt: Date.now() });
      }
      await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: 'accepted', acknowledgement: JSON.stringify(raw), acceptedAt: new Date().toISOString() } });
    });
  });
}
