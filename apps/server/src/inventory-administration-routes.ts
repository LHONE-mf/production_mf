import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { deviceProofError } from './sync-routes.js';
import { inventoryPermission } from './inventory-routes.js';
import { currentInventoryWriter, inventoryWriteFence } from './inventory-stream.js';

const material = z.object({ deviceId: z.guid(), id: z.guid(), code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200), category: z.enum(['raw_material', 'component', 'electrode', 'cell']), baseUnit: z.enum(['mg', 'ul', 'mm', 'pieces']) }).strict();
const location = z.object({ deviceId: z.guid(), id: z.guid(), parentId: z.guid().nullable(), label: z.string().trim().min(1).max(200),
  kind: z.enum(['warehouse', 'cabinet', 'rack', 'shelf', 'container_area']) }).strict();
const page = z.object({ deviceId: z.guid(), after: z.guid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

/** Creation uses the caller's resource ID as its stable idempotency key. */
export function registerInventoryAdministrationRoutes(app: FastifyInstance, pool: Pool) {
  for (const kind of ['material', 'location'] as const) {
    app.post('/inventory/' + (kind === 'material' ? 'materials' : 'locations'), async (request, reply) => {
      const actor = await authenticate(pool, request.headers.authorization);
      if (!actor) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = (kind === 'material' ? material : location).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const data = parsed.data;
      if (!await inventoryPermission(pool, actor, 'manager')) return reply.code(403).send({ error: 'forbidden' });
      const proof = await deviceProofError(pool, actor, request.headers.authorization!, data.deviceId, request.headers['x-device-proof']);
      if (proof) return reply.code(403).send({ error: proof });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [actor.organization_id + ':inventory-sequence']);
        if (!await currentInventoryWriter(client, actor.organization_id, actor.id, data.deviceId, request.headers.authorization!, request.headers['x-device-proof'], 'manager')) {
          await client.query('ROLLBACK'); return reply.code(403).send({ error: 'forbidden' });
        }
        const fence = await inventoryWriteFence(client, actor.organization_id, request.headers['x-inventory-epoch']);
        if (fence) { await client.query('ROLLBACK'); return reply.code(fence === 'inventory_epoch_required' ? 428 : 409).send({ error: fence }); }
        const prior = await client.query(`SELECT organization_id,actor_id,device_id,resource_type,request_payload=$2::jsonb AS identical,result_payload
          FROM inventory_catalog_events WHERE change_id=$1`, [data.id, JSON.stringify(data)]);
        if (prior.rowCount) {
          const row = prior.rows[0], same = row.organization_id === actor.organization_id && row.actor_id === actor.id && row.device_id === data.deviceId && row.resource_type === kind && row.identical;
          await client.query('ROLLBACK'); return reply.code(same ? 200 : 409).send(same ? row.result_payload : { error: 'catalog_identity_reused' });
        }
        let result: object;
        if ('code' in data) {
          await client.query(`INSERT INTO inventory_materials(id,organization_id,material_code,display_name,category,base_unit) VALUES($1,$2,$3,$4,$5,$6)`,
            [data.id, actor.organization_id, data.code, data.name, data.category, data.baseUnit]);
          result = { id: data.id, code: data.code, name: data.name, category: data.category, baseUnit: data.baseUnit };
        } else {
          const parents: Record<string, string[]> = { cabinet: ['warehouse'], rack: ['warehouse'], shelf: ['cabinet', 'rack'], container_area: ['shelf'] };
          const parent = data.parentId ? (await client.query('SELECT kind FROM inventory_locations WHERE organization_id=$1 AND id=$2 AND active FOR SHARE', [actor.organization_id, data.parentId])).rows[0] : null;
          if ((data.kind === 'warehouse') !== (data.parentId === null) || (data.parentId && !parents[data.kind]?.includes(parent?.kind))) {
            await client.query('ROLLBACK'); return reply.code(400).send({ error: 'invalid_location_hierarchy' });
          }
          await client.query('INSERT INTO inventory_locations(id,organization_id,parent_id,label,kind) VALUES($1,$2,$3,$4,$5)', [data.id, actor.organization_id, data.parentId, data.label, data.kind]);
          result = { id: data.id, parentId: data.parentId, label: data.label, kind: data.kind };
        }
        await client.query(`INSERT INTO inventory_catalog_events(change_id,organization_id,resource_id,resource_type,actor_id,device_id,request_payload,result_payload) VALUES($1,$2,$1,$3,$4,$5,$6,$7)`,
          [data.id, actor.organization_id, kind, actor.id, data.deviceId, JSON.stringify(data), JSON.stringify(result)]);
        await client.query('COMMIT'); return reply.code(201).send(result);
      } catch (error) {
        await client.query('ROLLBACK');
        const code = (error as { code?: string }).code;
        if (code === '23505') return reply.code(409).send({ error: kind + '_identity_conflict' });
        if (code === '23503') return reply.code(409).send({ error: 'location_parent_changed' });
        throw error;
      } finally { client.release(); }
    });
  }
  app.get('/inventory/access/users', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = page.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const data = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await currentInventoryWriter(client, actor.organization_id, actor.id, data.deviceId, request.headers.authorization!, request.headers['x-device-proof'], 'manager');
      if (current?.role !== 'chief') { await client.query('ROLLBACK'); return reply.code(403).send({ error: 'forbidden' }); }
      const found = await client.query(`SELECT u.id,u.login,u.role,u.active,CASE WHEN u.role='chief' THEN 'chief' ELSE a.level END AS warehouse_level
        FROM users u LEFT JOIN inventory_access a ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.active
        WHERE u.organization_id=$1 AND ($2::uuid IS NULL OR u.id>$2) ORDER BY u.id LIMIT $3`, [actor.organization_id, data.after ?? null, data.limit + 1]);
      const rows = found.rows.slice(0, data.limit), hasMore = found.rowCount! > data.limit;
      await client.query('COMMIT');
      return { users: rows.map(row => ({ id: row.id, login: row.login, role: row.role, active: row.active, warehouseLevel: row.warehouse_level })), hasMore, nextAfter: hasMore ? rows.at(-1)!.id : null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
}
