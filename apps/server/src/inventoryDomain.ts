/**
 * Inventory domain contract for the future authoritative server.
 *
 * No existing local Storage journal is promoted to stock by this module.
 * Quantities are positive safe integers in an explicitly defined base unit
 * (e.g. mg, microlitres, mm or pieces), never floating-point stock balances.
 *
 * This is a pure, server-side transition function. It is NOT an API or a
 * production inventory service until authenticated transactional persistence
 * and synchronization are implemented.
 */
export type InventoryUnit = 'mg' | 'ul' | 'mm' | 'pieces';
export type InventoryQuality = 'quarantine' | 'released' | 'blocked';
export type InventoryOperationKind =
  | 'receive' | 'reserve' | 'release_reservation' | 'issue'
  | 'return' | 'transfer' | 'adjust';

export interface InventoryStock {
  /** Internal receipt/container identity; never infer uniqueness from maker lot. */
  stockId: string;
  materialId: string;
  manufacturerLot: string;
  unit: InventoryUnit;
  locationId: string;
  quality: InventoryQuality;
  onHand: number;
  reserved: number;
  revision: number;
}

export interface InventoryOperation {
  operationId: string;
  stockId: string;
  kind: InventoryOperationKind;
  expectedRevision: number;
  quantity: number;
  actorId: string;
  reason: string;
  /** Mandatory for consumption and reservation to production. */
  productionBatchId?: string;
  /** Target for a transfer. */
  toLocationId?: string;
  /** Only initial receive defines stock identity and unit. */
  materialId?: string;
  manufacturerLot?: string;
  unit?: InventoryUnit;
  locationId?: string;
  quality?: InventoryQuality;
  /** Adjustment direction; quantity itself is always positive. */
  adjustment?: 'increase' | 'decrease';
}

export type InventoryResult =
  | { ok: true; stock: InventoryStock; available: number }
  | { ok: false; code: 'invalid' | 'revision_conflict' | 'insufficient_stock' | 'blocked' | 'missing'; message: string };

const validText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const positiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const nonnegativeInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const validUnit = (u: unknown): u is InventoryUnit =>
  u === 'mg' || u === 'ul' || u === 'mm' || u === 'pieces';
const validQuality = (q: unknown): q is InventoryQuality =>
  q === 'quarantine' || q === 'released' || q === 'blocked';
const fail = (code: Extract<InventoryResult, {ok:false}>['code'], message: string): InventoryResult =>
  ({ok:false,code,message});

/**
 * Validate a proposed operation against one server-confirmed stock row.
 * The caller MUST enforce organization scope, authenticated actor permissions,
 * idempotency, and row-level transactional locking before committing the result.
 */
export function transitionInventory(
  current: InventoryStock | undefined,
  op: InventoryOperation,
  options: { mayAdjust: boolean } = { mayAdjust: false },
): InventoryResult {
  if (!validText(op.operationId) || !validText(op.stockId) ||
      !validText(op.actorId) || !validText(op.reason) ||
      !nonnegativeInt(op.expectedRevision) || !positiveInt(op.quantity)) {
    return fail('invalid', 'Invalid operation identity, revision, reason or quantity');
  }
  const supported: InventoryOperationKind[] =
    ['receive','reserve','release_reservation','issue','return','transfer','adjust'];
  if (!supported.includes(op.kind)) return fail('invalid', 'Unknown operation');
  if (op.kind === 'receive') {
    if (current || op.expectedRevision !== 0) return fail('revision_conflict', 'Receipt already exists');
    if (!validText(op.materialId) || !validText(op.manufacturerLot) ||
        !validText(op.locationId) || !validUnit(op.unit) ||
        !validQuality(op.quality)) return fail('invalid', 'Missing receipt identity');
    const stock: InventoryStock = {
      stockId: op.stockId, materialId: op.materialId, manufacturerLot: op.manufacturerLot,
      unit: op.unit, locationId: op.locationId, quality: op.quality,
      onHand: op.quantity, reserved: 0, revision: 1,
    };
    return {ok:true,stock,available:stock.onHand};
  }
  if (!current) return fail('missing', 'Unknown stock identity');
  if (current.stockId !== op.stockId || !positiveInt(current.revision) ||
      !nonnegativeInt(current.onHand) || !nonnegativeInt(current.reserved) ||
      current.reserved > current.onHand || !validUnit(current.unit) ||
      !validQuality(current.quality)) return fail('invalid', 'Invalid current stock');
  if (current.revision !== op.expectedRevision)
    return fail('revision_conflict', 'Stock changed since last confirmed revision');

  const available = current.onHand - current.reserved;
  const next = {...current, revision:current.revision + 1};
  if (!Number.isSafeInteger(next.revision)) return fail('invalid', 'Revision overflow');

  switch (op.kind) {
    case 'reserve':
      if (!validText(op.productionBatchId)) return fail('invalid', 'Production batch required');
      if (current.quality !== 'released') return fail('blocked', 'Stock not released for production');
      if (op.quantity > available) return fail('insufficient_stock', 'Not enough available stock');
      next.reserved += op.quantity;
      break;
    case 'release_reservation':
      if (!validText(op.productionBatchId)) return fail('invalid', 'Production batch required');
      if (op.quantity > current.reserved) return fail('insufficient_stock', 'Not enough reserved stock');
      next.reserved -= op.quantity;
      break;
    case 'issue':
      if (!validText(op.productionBatchId)) return fail('invalid', 'Production batch required');
      if (current.quality !== 'released') return fail('blocked', 'Stock not released for production');
      // Consume the batch reservation first, when explicitly identified.
      // Reservation ownership MUST be validated by the persistent server ledger.
      return fail('invalid', 'Issue requires server-side reservation ownership validation');
    case 'return':
      return fail('invalid', 'Return requires verified original issue reference');
    case 'transfer':
      if (!validText(op.toLocationId) || op.toLocationId === current.locationId)
        return fail('invalid', 'A distinct target location is required');
      if (op.quantity !== current.onHand || current.reserved !== 0)
        return fail('invalid', 'Partial/container transfers require split stock identities');
      next.locationId = op.toLocationId;
      break;
    case 'adjust':
      if (!options.mayAdjust) return fail('blocked', 'Stock correction requires privileged server approval');
      if (op.adjustment !== 'increase' && op.adjustment !== 'decrease')
        return fail('invalid', 'Adjustment direction required');
      if (op.adjustment === 'decrease' && op.quantity > available)
        return fail('insufficient_stock', 'Cannot remove reserved or absent stock');
      next.onHand += op.adjustment === 'increase' ? op.quantity : -op.quantity;
      if (!nonnegativeInt(next.onHand)) return fail('invalid', 'Quantity overflow');
      break;
  }
  if (!nonnegativeInt(next.reserved) || next.reserved > next.onHand)
    return fail('invalid', 'Invalid reservation balance');
  return {ok:true,stock:next,available:next.onHand-next.reserved};
}
