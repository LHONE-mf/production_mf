import type { InventoryStock, InventoryUnit } from './inventoryDomain.js';
export function inventoryStockFromRow(row: Record<string, unknown>): InventoryStock {
  const count = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('unsafe_inventory_balance'); return n; };
  return { stockId: String(row.id), materialId: String(row.material_id), manufacturerLot: String(row.manufacturer_lot), unit: row.base_unit as InventoryUnit,
    locationId: String(row.location_id), quality: row.quality as InventoryStock['quality'], onHand: count(row.on_hand), reserved: count(row.reserved), revision: count(row.revision),
    ...(row.expires_at ? { expiresAt: new Date(String(row.expires_at)).toISOString() } : {}),
    ...(row.manufactured_on ? { manufacturedOn: String(row.manufactured_on) } : {}),
    ...(row.disposition ? { disposition: row.disposition as InventoryStock['disposition'] } : {}) };
}
/** An expiry date is inclusive in UTC; the next midnight is the exclusive instant. */
export function inventoryExpiryInstant(expiresOn: string) { return new Date(Date.parse(expiresOn + 'T00:00:00.000Z') + 86_400_000).toISOString(); }
