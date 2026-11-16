import { validateInventoryStock, type InventoryStockSnapshot, type InventoryScope } from './inventoryOutbox';
import { issueIdValid, issueTextValid, validateIssue, type InventoryIssue } from './inventoryIssueTypes';
import type { IssueLabels } from './inventoryIssueClient';
export const returnConditions = { untouched_unused: 'Не использован, не изменён, исходная упаковка прослеживается', damaged: 'Повреждён — обычный возврат запрещён', contaminated: 'Загрязнён — обычный возврат запрещён', altered: 'Изменено качество / упаковка — обычный возврат запрещён', untraceable: 'Нет прослеживаемого источника — возврат запрещён', expired: 'Истёк срок — возврат запрещён', blocked: 'Заблокирован — возврат запрещён' };
export interface InventorySettlement { revision: number; issued: number; returned: number; scrapped: number; consumed: number; outstanding: number }
export interface InventoryReturnChoice { issue: InventoryIssue; settlement: InventorySettlement; source: InventoryStockSnapshot; sourceEligible: boolean; labels: IssueLabels }
interface Common { operationId: string; deviceId: string; issueId: string; productionBatchId: string; sourceStockId: string; expectedSettlementRevision: number; quantity: number; reason: string; evidence: string }
export type InventoryOutcomeRequest = Common & ({ kind: 'return'; expectedSourceRevision: number; stockId: string; locationId: string; condition: keyof typeof returnConditions } | { kind: 'scrap' });
export interface InventoryOutcome { operationId: string; issueId: string; productionBatchId: string; sourceStockId: string; actorId: string; deviceId: string; kind: 'return' | 'scrap' | 'consume'; quantity: number; stockId: string | null; condition: 'untouched_unused' | null; expectedRevision: number; resultingRevision: number; reason: string; evidence: string; recordedAt: string; sequence?: number }
export const outcomeInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const outcomeInstant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function validateSettlement(raw: unknown): asserts raw is InventorySettlement {
  if (!raw || typeof raw !== 'object') throw Error('Invalid issue settlement'); const r = raw as InventorySettlement;
  if (![r.issued, r.returned, r.scrapped, r.consumed, r.outstanding].every(n => outcomeInteger(n)) || !outcomeInteger(r.revision, 1) || !outcomeInteger(r.issued, 1) || !Number.isSafeInteger(r.returned + r.scrapped + r.consumed + r.outstanding) || r.returned + r.scrapped + r.consumed + r.outstanding !== r.issued) throw Error('Invalid issue settlement');
}
export function validateReturnChoice(raw: unknown): asserts raw is InventoryReturnChoice {
  if (!raw || typeof raw !== 'object') throw Error('Invalid return choice'); const r = raw as InventoryReturnChoice; validateIssue(r.issue); validateSettlement(r.settlement); validateInventoryStock(r.source);
  if (r.issue.state !== 'received' || r.source.stockId !== r.issue.stockId || r.source.materialId !== r.issue.materialId || r.source.unit !== r.issue.unit || r.source.manufacturerLot !== r.issue.source?.manufacturerLot || r.settlement.issued !== r.issue.quantity || typeof r.sourceEligible !== 'boolean' || !r.labels || ![r.labels.materialName, r.labels.materialCode, r.labels.batchCode, r.labels.recipientName].every(issueTextValid)) throw Error('Invalid return provenance');
}
export function validateOutcomeRequest(r: InventoryOutcomeRequest, scope: InventoryScope) {
  if (!r || ![r.operationId, r.deviceId, r.issueId, r.productionBatchId, r.sourceStockId].every(issueIdValid) || r.deviceId !== scope.deviceId || !outcomeInteger(r.quantity, 1) || !outcomeInteger(r.expectedSettlementRevision, 1, Number.MAX_SAFE_INTEGER - 1) || !issueTextValid(r.reason) || !issueTextValid(r.evidence) || !['return', 'scrap'].includes(r.kind)) throw Error('Invalid outcome intent');
  const keys = ['operationId', 'deviceId', 'issueId', 'productionBatchId', 'sourceStockId', 'expectedSettlementRevision', 'quantity', 'reason', 'evidence', 'kind', ...(r.kind === 'return' ? ['expectedSourceRevision', 'stockId', 'locationId', 'condition'] : [])];
  if (Object.keys(r).some(k => !keys.includes(k)) || r.kind === 'return' && (![r.stockId, r.locationId].every(issueIdValid) || r.stockId === r.sourceStockId || !outcomeInteger(r.expectedSourceRevision, 1, 2147483646) || !Object.prototype.hasOwnProperty.call(returnConditions, r.condition))) throw Error('Invalid return identity/condition');
}
export function validateOutcome(raw: unknown): asserts raw is InventoryOutcome {
  if (!raw || typeof raw !== 'object') throw Error('Invalid issue outcome'); const r = raw as InventoryOutcome;
  if (![r.operationId, r.issueId, r.productionBatchId, r.sourceStockId, r.actorId, r.deviceId].every(issueIdValid) || !outcomeInteger(r.quantity, 1) || !outcomeInteger(r.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) || r.resultingRevision !== r.expectedRevision + 1 || !issueTextValid(r.reason) || !issueTextValid(r.evidence) || !outcomeInstant(r.recordedAt) || (r.sequence !== undefined && !outcomeInteger(r.sequence, 1)) || (r.kind === 'return' ? !issueIdValid(r.stockId) || r.stockId === r.sourceStockId || r.condition !== 'untouched_unused' : !['scrap','consume'].includes(r.kind) || r.stockId !== null || r.condition !== null)) throw Error('Invalid issue outcome fields');
}
/** Keep only recognized stock fields; no arbitrary response properties enter the durable proposal. */
export function outcomeStockCopy(stock: InventoryStockSnapshot): InventoryStockSnapshot {
  validateInventoryStock(stock);
  return { stockId: stock.stockId, materialId: stock.materialId, manufacturerLot: stock.manufacturerLot, locationId: stock.locationId, unit: stock.unit, quality: stock.quality, onHand: stock.onHand, reserved: stock.reserved, available: stock.available, revision: stock.revision, ...(stock.expiresAt ? { expiresAt: stock.expiresAt } : {}), ...(stock.manufacturedOn ? { manufacturedOn: stock.manufacturedOn } : {}), ...(stock.disposition ? { disposition: stock.disposition } : {}) };
}
