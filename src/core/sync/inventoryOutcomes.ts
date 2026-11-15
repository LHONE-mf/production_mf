import type { HybridSession } from './hybridClient';
import { inventoryRequest, preflightInventoryStream } from './inventoryClient';
import { loadInventoryIssueContext } from './inventoryIssueClient';
import { issueIdValid, issueManager, type InventoryIssueContext } from './inventoryIssueTypes';
import { outcomeStockCopy, outcomeInstant, validateOutcomeRequest, validateReturnChoice, validateSettlement, validateOutcome, type InventoryOutcomeRequest, type InventoryReturnChoice, type InventorySettlement } from './inventoryOutcomeTypes';
import { archiveInventoryAcknowledgement, inventoryOutbox, inventoryScopeKey, sameInventoryStock, validateInventoryStock, type InventoryScope, type InventoryStockSnapshot, type ReceivingDraft } from './inventoryOutbox';
import { withInventorySync } from './inventorySyncLock';
export * from './inventoryOutcomeTypes';
export * from './inventoryOutcomeClient';
interface Base { issueId: string; productionBatchId: string; source: InventoryStockSnapshot; originalExpiresAt?: string; settlement: InventorySettlement; sourceEligible: boolean }
export const inventoryOutcomeErrors:Record<string,string>={invalid_issue_outcome:'Некорректное исходное действие',issue_not_found:'Выдача недоступна в этой организации',destination_not_found:'Место возврата недоступно или отключено',operation_id_reused:'ID уже использован для другого действия',accepted_issue_provenance_required:'Нет совпадающей полученной выдачи, партии и исходной упаковки',issue_outstanding_changed:'Остаток выданного изменился; обновите историю и сверьте исходное количество',return_condition_ineligible:'Состояние не допускает обычный возврат. Изолируйте упаковку для решения Chief',return_source_ineligible:'Источник удержан, заблокирован или просрочен. Изолируйте упаковку для решения Chief',revision_conflict:'Версия исходного контейнера изменилась',inventory_reference_changed:'Связанный объект изменился',outcome_warehouse_authority_required:'Требуются текущие складские полномочия',inventory_return_pair_required:'Сервер не подтвердил согласованный источник и движение',issue_handoff_ineligible:'Выдача или источник больше не допускают проведение'};
export function inventoryOutcomeProposals(scope: InventoryScope, localActorId: string) { return inventoryOutbox.receivingDrafts.filter(row => { try { const k = JSON.parse(row.key); return k[0] === inventoryScopeKey(scope) && k[1] === localActorId && k[2] === 'outcome'; } catch { return false; } }).toArray(); }
function validateBase(base: Base, request: InventoryOutcomeRequest) {
  validateSettlement(base.settlement); validateInventoryStock(base.source);
  if (base.issueId !== request.issueId || base.productionBatchId !== request.productionBatchId || base.source.stockId !== request.sourceStockId || base.settlement.revision !== request.expectedSettlementRevision || request.quantity > base.settlement.outstanding || typeof base.sourceEligible !== 'boolean' || base.originalExpiresAt !== undefined && !outcomeInstant(base.originalExpiresAt) || request.kind === 'return' && request.expectedSourceRevision !== base.source.revision) throw Error('Outcome intent differs from original issue/source/remaining quantity');
}
function returnedStock(base: Base, request: Extract<InventoryOutcomeRequest, { kind: 'return' }>): InventoryStockSnapshot {
  const expiresAt = [base.source.expiresAt, base.originalExpiresAt].filter((x): x is string => !!x).sort()[0];
  const stock: InventoryStockSnapshot = { ...outcomeStockCopy(base.source), stockId: request.stockId, locationId: request.locationId, quality: 'released', disposition: 'release', onHand: request.quantity, available: request.quantity, reserved: 0, revision: 1 }; delete stock.expiresAt; if (expiresAt) stock.expiresAt = expiresAt; return stock;
}
export async function freezeInventoryOutcome(scope: InventoryScope, localActorId: string, context: InventoryIssueContext, choice: InventoryReturnChoice, request: InventoryOutcomeRequest) {
  validateOutcomeRequest(request, scope); validateReturnChoice(choice);
  if (!localActorId.trim() || inventoryScopeKey(context) !== inventoryScopeKey(scope) || !issueIdValid(context.epoch) || !context.postingEnabled || !context.warehouseLevel || request.kind === 'scrap' && !issueManager(context)) throw Error('Требуется действующий складской доступ / Manager для списания');
  const base: Base = { issueId: choice.issue.id, productionBatchId: choice.issue.productionBatchId, source: outcomeStockCopy(choice.source), settlement: { revision: choice.settlement.revision, issued: choice.settlement.issued, returned: choice.settlement.returned, scrapped: choice.settlement.scrapped, consumed: choice.settlement.consumed, outstanding: choice.settlement.outstanding }, sourceEligible: choice.sourceEligible, ...(choice.issue.source?.expiresAt ? { originalExpiresAt: choice.issue.source.expiresAt } : {}) }; validateBase(base, request);
  const row: ReceivingDraft = { key: JSON.stringify([inventoryScopeKey(scope), localActorId, 'outcome', request.operationId]), revision: 1, operationId: request.operationId, fields: { kind: request.kind, request: JSON.stringify(request), base: JSON.stringify(base), epoch: context.epoch, state: 'pending', createdAt: new Date().toISOString() } }; await inventoryOutbox.receivingDrafts.add(row); return row;
}
export async function prepareInventoryScrap(session: HybridSession, scope: InventoryScope, localActorId: string, context: InventoryIssueContext, choice: InventoryReturnChoice, request: Extract<InventoryOutcomeRequest, { kind: 'scrap' }>) {
  const current = await loadInventoryIssueContext(session, scope); if (current.epoch !== context.epoch) throw Error('История изменилась; исходное списание не перепривязано'); if (!issueManager(current)) throw Error('Требуется Chief / Warehouse Manager'); if (await preflightInventoryStream(session, scope) !== current.epoch) throw Error('История изменилась'); return freezeInventoryOutcome(scope, localActorId, current, choice, request);
}
export function sendInventoryOutcome(session: HybridSession, scope: InventoryScope, localActorId: string, key: string) {
  return withInventorySync(scope, async () => {
    const row = (await inventoryOutcomeProposals(scope, localActorId)).find(r => r.key === key); if (!row || row.fields.state !== 'pending' || !issueIdValid(row.fields.epoch)) throw Error('Нет исходного ожидающего возврата / списания');
    const context = await loadInventoryIssueContext(session, scope); if (context.epoch !== row.fields.epoch || !context.postingEnabled) throw Error('История изменилась; исходное действие сохранено для сверки');
    const request: InventoryOutcomeRequest = JSON.parse(row.fields.request), base: Base = JSON.parse(row.fields.base); validateOutcomeRequest(request, scope); validateBase(base, request);
    if (request.operationId !== row.operationId || row.fields.kind !== request.kind || row.fields.request !== JSON.stringify(request)) throw Error('Outcome intent changed');
    if (!context.warehouseLevel || request.kind === 'scrap' && !issueManager(context)) throw Error('Складские полномочия утрачены; исходное действие сохранено');
    if (await preflightInventoryStream(session, scope) !== row.fields.epoch) throw Error('История изменилась');
    const response = await inventoryRequest(session, scope, '/inventory/issues/' + request.issueId + '/outcomes', { method: 'POST', headers: { 'x-inventory-epoch': row.fields.epoch }, body: row.fields.request });
    if ([400, 404, 409].includes(response.status)) {
      const raw = await response.json(); if (!raw || typeof raw.error !== 'string' || !Object.prototype.hasOwnProperty.call(inventoryOutcomeErrors,raw.error)) throw Error('Invalid outcome rejection');
      await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, async () => { if (JSON.stringify(await inventoryOutbox.receivingDrafts.get(key)) !== JSON.stringify(row)) throw Error('Outcome intent changed'); await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: response.status === 409 ? 'conflict' : 'rejected', error: raw.error } }); }); throw Error(inventoryOutcomeErrors[raw.error]+'. Исходные ID, количество и свидетельства сохранены');
    }
    if (!response.ok) throw Error('Результат неизвестен или доступ утрачен; повторяйте тот же ID: HTTP ' + response.status);
    const raw = await response.json(); validateOutcome(raw?.outcome); validateSettlement(raw?.settlement);
    const expectedSettlement = { ...base.settlement, revision: base.settlement.revision + 1, returned: base.settlement.returned + (request.kind === 'return' ? request.quantity : 0), scrapped: base.settlement.scrapped + (request.kind === 'scrap' ? request.quantity : 0), outstanding: base.settlement.outstanding - request.quantity };
    const expectedOutcome = { operationId: request.operationId, issueId: request.issueId, productionBatchId: request.productionBatchId, sourceStockId: request.sourceStockId, actorId: scope.actorId, deviceId: scope.deviceId, kind: request.kind, quantity: request.quantity, stockId: request.kind === 'return' ? request.stockId : null, condition: request.kind === 'return' ? request.condition : null, expectedRevision: base.settlement.revision, resultingRevision: base.settlement.revision + 1, reason: request.reason, evidence: request.evidence };
    if (raw.operationId !== request.operationId || raw.status !== (response.status === 201 ? 'confirmed' : 'duplicate') || Object.entries(expectedOutcome).some(([k, v]) => raw.outcome[k] !== v) || Object.entries(expectedSettlement).some(([k, v]) => raw.settlement[k] !== v)) throw Error('Invalid outcome acknowledgement');
    if (request.kind === 'return') {
      validateInventoryStock(raw.stock); const expected = returnedStock(base, request);
      if (request.condition !== 'untouched_unused' || !base.sourceEligible || base.source.quality !== 'released' || !sameInventoryStock(raw.stock, expected) || expected.expiresAt && Date.parse(raw.outcome.recordedAt) >= Date.parse(expected.expiresAt)) throw Error('Invalid return provenance/QA/quantity acknowledgement');
    } else if (raw.stock !== undefined) throw Error('Scrap acknowledgement must not create warehouse stock');
    await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, inventoryOutbox.stocks, inventoryOutbox.acknowledgements, async () => {
      if (JSON.stringify(await inventoryOutbox.receivingDrafts.get(key)) !== JSON.stringify(row)) throw Error('Outcome intent changed while awaiting acknowledgement');
      if (request.kind === 'return') { const stock = outcomeStockCopy(raw.stock), scopeKey = inventoryScopeKey(scope), before = await inventoryOutbox.stocks.get([scopeKey, stock.stockId]); if (before && before.revision === stock.revision && !sameInventoryStock(before, stock)) throw Error('Return stock cache conflicts with acknowledgement'); if (!before || before.revision < stock.revision) await inventoryOutbox.stocks.put({ ...stock, scopeKey }); await archiveInventoryAcknowledgement({ operationId: request.operationId, scopeKey, epoch: row.fields.epoch, kind: 'return', stockId: stock.stockId, request, stock, receivedAt: Date.now() }); }
      const acknowledgement={status:raw.status,operationId:request.operationId,outcome:{...expectedOutcome,recordedAt:raw.outcome.recordedAt},settlement:expectedSettlement,...(request.kind==='return'?{stock:outcomeStockCopy(raw.stock)}:{})};
      await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: 'accepted', acknowledgement: JSON.stringify(acknowledgement), acceptedAt: new Date().toISOString() } });
    });
  });
}
