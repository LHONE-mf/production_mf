import { inventoryRequest, preflightInventoryStream } from './inventoryClient';
import { loadWarehouseAccess, material, location, type InventoryMaterial, type InventoryLocation, type InventoryPage } from './inventoryCatalogClient';
import { inventoryOutbox, inventoryScopeKey, type InventoryScope, type ReceivingDraft } from './inventoryOutbox';
import { withInventorySync } from './inventorySyncLock';
import type { HybridSession } from './hybridClient';

export type InventoryAdminDraft =
  | ({ resource: 'material' } & Omit<InventoryMaterial, 'id'>)
  | ({ resource: 'location' } & Omit<InventoryLocation, 'id' | 'active'>)
  | { resource: 'access'; userId: string; level: 'operator' | 'manager'; action: 'grant' | 'revoke' };
export interface WarehouseUser { id: string; login: string; role: string; active: boolean; warehouseLevel: 'chief' | 'manager' | 'operator' | null }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validatedBody(kind: string, body: unknown, scope: InventoryScope): asserts body is Record<string, unknown> {
  if (!record(body) || body.deviceId !== scope.deviceId || typeof (kind === 'access' ? body.changeId : body.id) !== 'string' || !uuid.test(String(kind === 'access' ? body.changeId : body.id))) throw Error('Invalid administration identity');
  if (kind === 'material' ? !material(body) : kind === 'location' ? !location({ ...body, active: true }) : kind !== 'access' || !uuid.test(String(body.userId)) || !['manager', 'operator'].includes(String(body.level)) || !['grant', 'revoke'].includes(String(body.action))) throw Error('Invalid administration request');
  const allowed = kind === 'material' ? ['id', 'deviceId', 'code', 'name', 'category', 'baseUnit'] : kind === 'location' ? ['id', 'deviceId', 'label', 'kind', 'parentId'] : ['changeId', 'deviceId', 'userId', 'level', 'action'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw Error('Unknown administration field');
}
export async function listInventoryAdministration(scope: InventoryScope, localActorId: string) {
  const scopeKey = inventoryScopeKey(scope);
  return inventoryOutbox.receivingDrafts.filter(row => {
    try { const key = JSON.parse(row.key); return key[0] === scopeKey && key[1] === localActorId && key[2] === 'administration'; } catch { return false; }
  }).toArray();
}
/** Privileged preparation is online-only. The original body/ID/epoch then survive restart. */
export async function freezeInventoryAdministration(session: HybridSession, scope: InventoryScope, localActorId: string, draft: InventoryAdminDraft) {
  if (!localActorId.trim()) throw Error('Original local profile required');
  const access = await loadWarehouseAccess(session, scope);
  if (!access.canManageCatalog || (draft.resource === 'access' && access.level !== 'chief')) throw Error('Недостаточно полномочий для администрирования');
  const epoch = await preflightInventoryStream(session, scope), id = crypto.randomUUID();
  const { resource: kind, ...values } = draft;
  const body = { ...values, deviceId: scope.deviceId, ...(kind === 'access' ? { changeId: id } : { id }) };
  validatedBody(kind, body, scope);
  const row: ReceivingDraft = { key: JSON.stringify([inventoryScopeKey(scope), localActorId, 'administration', id]), revision: 1, operationId: id,
    fields: { kind, epoch, request: JSON.stringify(body), state: 'pending', createdAt: new Date().toISOString() } };
  await inventoryOutbox.receivingDrafts.add(row);
  return row;
}
/** Manual exact retry only. Rejection/unknown outcome never deletes or rewrites intent. */
export function sendInventoryAdministration(session: HybridSession, scope: InventoryScope, localActorId: string, key: string) {
  return withInventorySync(scope, async () => {
    const row = (await listInventoryAdministration(scope, localActorId)).find(row => row.key === key);
    if (!row || row.fields.state !== 'pending' || !uuid.test(row.fields.epoch)) throw Error('Нет ожидающего исходного запроса');
    const body: unknown = JSON.parse(row.fields.request);
    validatedBody(row.fields.kind, body, scope);
    if ((body.id ?? body.changeId) !== row.operationId) throw Error('Administration intent changed');
    const access = await loadWarehouseAccess(session, scope);
    if (!access.canManageCatalog || (row.fields.kind === 'access' && access.level !== 'chief')) throw Error('Недостаточно полномочий для администрирования');
    if (await preflightInventoryStream(session, scope) !== row.fields.epoch) throw Error('История изменена; исходный запрос сохранён для сверки');
    const path = row.fields.kind === 'access' ? '/inventory/access' : row.fields.kind === 'material' ? '/inventory/materials' : '/inventory/locations';
    const response = await inventoryRequest(session, scope, path, { method: 'POST', headers: { 'x-inventory-epoch': row.fields.epoch }, body: row.fields.request });
    if (!response.ok) throw Error('Запрос сохранён; отправка не подтверждена: HTTP ' + response.status);
    const result: unknown = await response.json();
    const correct = record(result) && (row.fields.kind === 'access' ? result.changeId === body.changeId && ['confirmed', 'duplicate'].includes(String(result.status)) :
      row.fields.kind === 'material' ? material(result) && ['id', 'code', 'name', 'category', 'baseUnit'].every(key => result[key] === body[key]) :
        ['id', 'parentId', 'label', 'kind'].every(key => result[key] === body[key]));
    if (!correct) throw Error('Invalid administration acknowledgement; original request retained');
    await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, async () => {
      const current = await inventoryOutbox.receivingDrafts.get(key);
      if (JSON.stringify(current) !== JSON.stringify(row)) throw Error('Administration intent changed while awaiting acknowledgement');
      await inventoryOutbox.receivingDrafts.put({ ...row, revision: row.revision + 1, fields: { ...row.fields, state: 'accepted', acknowledgement: JSON.stringify(result), acceptedAt: new Date().toISOString() } });
    });
  });
}
export async function loadWarehouseUsers(session: HybridSession, scope: InventoryScope, after?: string, limit = 50): Promise<InventoryPage<WarehouseUser>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after !== undefined && !uuid.test(after))) throw Error('Invalid warehouse grant page');
  const query = new URLSearchParams({ deviceId: scope.deviceId, limit: String(limit) }); if (after) query.set('after', after);
  const response = await inventoryRequest(session, scope, '/inventory/access/users?' + query);
  if (!response.ok) throw Error('Доступ к сотрудникам недоступен: HTTP ' + response.status);
  const raw: unknown = await response.json();
  if (!record(raw) || !Array.isArray(raw.users) || raw.users.length > limit || typeof raw.hasMore !== 'boolean') throw Error('Invalid warehouse grant response');
  let previous = after ?? '';
  const rows: WarehouseUser[] = [];
  for (const row of raw.users) {
    if (!record(row) || typeof row.id !== 'string' || !uuid.test(row.id) || row.id <= previous || typeof row.login !== 'string' || !row.login.trim() || row.login.length > 128 || !['chief', 'master', 'technologist', 'worker'].includes(String(row.role)) || typeof row.active !== 'boolean' || ![null, 'chief', 'manager', 'operator'].includes(row.warehouseLevel as string | null) || (row.role === 'chief') !== (row.warehouseLevel === 'chief')) throw Error('Invalid warehouse grant row');
    rows.push(row as unknown as WarehouseUser); previous = row.id;
  }
  if (raw.hasMore ? rows.length !== limit || raw.nextAfter !== previous : raw.nextAfter !== null) throw Error('Invalid warehouse grant continuation');
  return { items: rows, hasMore: raw.hasMore, nextAfter: raw.nextAfter as string | null };
}
