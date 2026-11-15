import { validateInventoryStock, type InventoryScope, type InventoryStockSnapshot } from './inventoryOutbox';
export const issueIdValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const issueTextValid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2000;
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
export const issueStates = { requested: 'Запрошено', reserved: 'Зарезервировано', approved: 'Одобрено — выдача ещё не выполнена', dispatched: 'Выдано — ожидает получателя', received: 'Получено производством — не расход', cancelled: 'Отменено' };
export const issueActions = { request: 'Запросить материал', reserve: 'Зарезервировать', approve: 'Одобрить выдачу', dispatch: 'Подтвердить физическую выдачу', receive: 'Подтвердить получение', cancel: 'Отменить запрос / резерв' };
export type InventoryIssueKind = keyof typeof issueActions;
export interface InventoryIssueContext extends InventoryScope { warehouseLevel: 'chief' | 'manager' | 'operator' | null; epoch: string; postingEnabled: boolean }
export type InventoryIssueSource = Pick<InventoryStockSnapshot, 'stockId' | 'materialId' | 'manufacturerLot' | 'locationId' | 'unit' | 'quality' | 'expiresAt' | 'manufacturedOn'>;
export interface InventoryIssue {
  id: string; materialId: string; productionBatchId: string; stepNumber: number; workshopId: string; recipientId: string; requestedBy: string;
  quantity: number; unit: InventoryStockSnapshot['unit']; state: keyof typeof issueStates; revision: number; stockId: string | null; source: InventoryIssueSource | null;
  approvalOperationId: string | null; approvedStockRevision: number | null; approvedBy: string | null; approvedDeviceId: string | null; dispatchOperationId: string | null; receiptOperationId: string | null;
}
interface Common { operationId: string; deviceId: string; issueId: string; reason: string; evidence: string }
export type InventoryIssueIntent = Common & (
  { kind: 'request'; materialId: string; productionBatchId: string; stepNumber: number; recipientId: string; quantity: number } |
  { kind: 'reserve'; expectedIssueRevision: number; stockId: string; expectedStockRevision: number } |
  { kind: 'approve' | 'dispatch'; expectedIssueRevision: number; expectedStockRevision: number } |
  { kind: 'receive'; expectedIssueRevision: number } |
  { kind: 'cancel'; expectedIssueRevision: number; expectedStockRevision?: number }
);
export const issueManager = (context: InventoryIssueContext) => context.warehouseLevel === 'chief' || context.warehouseLevel === 'manager';
export function validateIssue(raw: unknown): asserts raw is InventoryIssue {
  if (!raw || typeof raw !== 'object') throw Error('Invalid issue'); const r = raw as InventoryIssue;
  if (![r.id, r.materialId, r.productionBatchId, r.recipientId, r.requestedBy].every(issueIdValid) || !integer(r.stepNumber, 1, 2147483647) || !issueTextValid(r.workshopId) || r.workshopId.length > 120 || !integer(r.quantity) || !['mg', 'ul', 'mm', 'pieces'].includes(r.unit) || !Object.prototype.hasOwnProperty.call(issueStates, r.state) || !integer(r.revision, 1, 2147483647) || ![r.stockId, r.approvalOperationId, r.approvedBy, r.approvedDeviceId, r.dispatchOperationId, r.receiptOperationId].every(v => v === null || issueIdValid(v)) || !(r.approvedStockRevision === null || integer(r.approvedStockRevision, 1, 2147483646))) throw Error('Invalid issue fields');
  if (r.source !== null) { validateInventoryStock({ ...r.source, onHand: 0, reserved: 0, available: 0, revision: 1 }); if (r.source.stockId !== r.stockId || r.source.materialId !== r.materialId || r.source.unit !== r.unit || r.source.quality !== 'released') throw Error('Invalid issue provenance'); }
  if ((r.stockId === null) !== (r.source === null) || (['reserved', 'approved', 'dispatched', 'received'].includes(r.state) && !r.stockId) || (['approved', 'dispatched', 'received'].includes(r.state) && (!r.approvalOperationId || !r.approvedStockRevision || !r.approvedBy || !r.approvedDeviceId)) || (['dispatched', 'received'].includes(r.state) && !r.dispatchOperationId) || (r.state === 'received' && !r.receiptOperationId)) throw Error('Invalid issue state/provenance');
}
export function validateIssueIntent(intent: InventoryIssueIntent, scope: InventoryScope) {
  if (!intent || ![intent.operationId, intent.deviceId, intent.issueId].every(issueIdValid) || intent.deviceId !== scope.deviceId || !issueTextValid(intent.reason) || !issueTextValid(intent.evidence) || !Object.prototype.hasOwnProperty.call(issueActions, intent.kind)) throw Error('Invalid issue intent');
  const common = ['operationId', 'deviceId', 'issueId', 'kind', 'reason', 'evidence'];
  const fields = intent.kind === 'request' ? ['materialId', 'productionBatchId', 'stepNumber', 'recipientId', 'quantity'] : intent.kind === 'reserve' ? ['expectedIssueRevision', 'stockId', 'expectedStockRevision'] : intent.kind === 'approve' || intent.kind === 'dispatch' || intent.kind === 'cancel' ? ['expectedIssueRevision', 'expectedStockRevision'] : ['expectedIssueRevision'];
  if (Object.keys(intent).some(k => !common.includes(k) && !fields.includes(k))) throw Error('Unknown issue intent field');
  if (intent.kind === 'request') { if (![intent.materialId, intent.productionBatchId, intent.recipientId].every(issueIdValid) || !integer(intent.stepNumber, 1, 2147483647) || !integer(intent.quantity)) throw Error('Invalid issue request'); }
  else if (!integer(intent.expectedIssueRevision, 1, 2147483646) || ('expectedStockRevision' in intent && intent.expectedStockRevision !== undefined && !integer(intent.expectedStockRevision, 1, 2147483646)) || (intent.kind === 'reserve' && !issueIdValid(intent.stockId))) throw Error('Invalid issue revision');
}
export function issueBody(intent: InventoryIssueIntent) { const { kind, ...rest } = intent; if (kind === 'request') return rest; const { issueId: _issueId, ...body } = intent; return body; }
export function issueSource(stock: InventoryStockSnapshot): InventoryIssueSource { return { stockId: stock.stockId, materialId: stock.materialId, manufacturerLot: stock.manufacturerLot, locationId: stock.locationId, unit: stock.unit, quality: stock.quality, ...(stock.expiresAt ? { expiresAt: stock.expiresAt } : {}), ...(stock.manufacturedOn ? { manufacturedOn: stock.manufacturedOn } : {}) }; }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const sameIssue = (a: InventoryIssue, b: InventoryIssue) => canonical(a) === canonical(b);
