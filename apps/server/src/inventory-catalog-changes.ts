import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { deviceProofError } from './sync-routes.js';
import { inventoryPermission } from './inventory-routes.js';
import { currentInventoryWriter, inventoryWriteFence } from './inventory-stream.js';
const common = z.object({ id: z.guid(), changeId: z.guid(), deviceId: z.guid(), expectedRevision: z.number().int().min(1).max(2147483646), reason: z.string().trim().min(1).max(2000), active: z.boolean() });
const materialChange = common.extend({ name: z.string().trim().min(1).max(200), supplierReference: z.string().trim().min(1).max(200).nullable() }).strict();
const locationChange = common.extend({ label: z.string().trim().min(1).max(200), parentId: z.guid().nullable() }).strict();
function material(row: Record<string, unknown>) { return { id: row.id, code: row.material_code, name: row.display_name, category: row.category, baseUnit: row.base_unit, active: row.active, supplierReference: row.supplier_reference, revision: row.revision }; }
function location(row: Record<string, unknown>) { return { id: row.id, parentId: row.parent_id, label: row.label, kind: row.kind, active: row.active, revision: row.revision }; }

export function registerInventoryCatalogChanges(app: FastifyInstance, pool: Pool) {
  for (const kind of ['material', 'location'] as const) {
    app.post('/inventory/' + (kind === 'material' ? 'materials' : 'locations') + '/:id/changes', async (request, reply) => {
      const actor = await authenticate(pool, request.headers.authorization);
      if (!actor) return reply.code(401).send({ error: 'unauthorized' });
      const parsed = (kind === 'material' ? materialChange : locationChange).safeParse(request.body);
      const params = z.object({ id: z.guid() }).safeParse(request.params);
      if (!parsed.success || !params.success || parsed.data.id !== params.data.id) return reply.code(400).send({ error: 'invalid_catalog_change' });
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
        const prior = await client.query(`SELECT organization_id,actor_id,device_id,resource_type,request_payload=$2::jsonb AS identical,result_payload FROM inventory_catalog_events WHERE change_id=$1`, [data.changeId, JSON.stringify(data)]);
        if (prior.rowCount) {
          const row = prior.rows[0], same = row.organization_id === actor.organization_id && row.actor_id === actor.id && row.device_id === data.deviceId && row.resource_type === kind && row.identical;
          await client.query('ROLLBACK'); return reply.code(same ? 200 : 409).send(same ? row.result_payload : { error: 'catalog_change_id_reused' });
        }
        // Table names come from this closed server-side enum, never from the request.
        const table = kind === 'material' ? 'inventory_materials' : 'inventory_locations';
        const found = await client.query('SELECT * FROM ' + table + ' WHERE organization_id=$1 AND id=$2 FOR UPDATE', [actor.organization_id, data.id]);
        const before = found.rows[0];
        if (!before) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'catalog_item_not_found' }); }
        if (before.revision !== data.expectedRevision) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'catalog_revision_conflict' }); }
        let result: object, snapshot: object;
        if ('name' in data) {
          snapshot = material(before);
          const updated = await client.query(`UPDATE inventory_materials SET display_name=$3,supplier_reference=$4,active=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING *`, [actor.organization_id, data.id, data.name, data.supplierReference, data.active]);
          result = material(updated.rows[0]);
        } else {
          snapshot = location(before);
          const parents: Record<string, string[]> = { cabinet: ['warehouse'], rack: ['warehouse'], shelf: ['cabinet', 'rack'], container_area: ['shelf'] };
          const parent = data.parentId ? (await client.query('SELECT kind FROM inventory_locations WHERE organization_id=$1 AND id=$2 AND active FOR SHARE', [actor.organization_id, data.parentId])).rows[0] : null;
          if (data.parentId === data.id || (before.kind === 'warehouse') !== (data.parentId === null) || (data.parentId && !parents[before.kind]?.includes(parent?.kind))) {
            await client.query('ROLLBACK'); return reply.code(400).send({ error: 'invalid_location_hierarchy' });
          }
          const ancestry = await client.query(`WITH RECURSIVE ancestors AS (
            SELECT id,parent_id,ARRAY[id] AS path,false AS cycle FROM inventory_locations WHERE organization_id=$1 AND id=$2
            UNION ALL SELECT p.id,p.parent_id,a.path||p.id,p.id=ANY(a.path) FROM inventory_locations p JOIN ancestors a ON p.id=a.parent_id WHERE p.organization_id=$1 AND NOT a.cycle)
            SELECT 1 FROM ancestors WHERE id=$3 OR cycle LIMIT 1`, [actor.organization_id, data.parentId, data.id]);
          if (ancestry.rowCount) { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'invalid_location_hierarchy' }); }
          const changed = data.label !== before.label || data.parentId !== before.parent_id || data.active !== before.active;
          if (changed) {
            const occupied = await client.query(`WITH RECURSIVE subtree AS (
              SELECT id FROM inventory_locations WHERE organization_id=$1 AND id=$2
              UNION SELECT p.id FROM inventory_locations p JOIN subtree s ON p.parent_id=s.id WHERE p.organization_id=$1)
              SELECT 1 FROM inventory_stocks s WHERE s.organization_id=$1 AND s.location_id IN(SELECT id FROM subtree)
              UNION ALL SELECT 1 FROM inventory_operations o WHERE o.organization_id=$1 AND
                (o.from_location_id IN(SELECT id FROM subtree) OR o.to_location_id IN(SELECT id FROM subtree) OR o.result_stock->>'locationId' IN(SELECT id::text FROM subtree)) LIMIT 1`, [actor.organization_id, data.id]);
            if (occupied.rowCount) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'location_history_protected' }); }
          }
          if (!data.active && (await client.query('SELECT 1 FROM inventory_locations WHERE organization_id=$1 AND parent_id=$2 AND active LIMIT 1', [actor.organization_id, data.id])).rowCount) {
            await client.query('ROLLBACK'); return reply.code(409).send({ error: 'location_has_active_children' });
          }
          const updated = await client.query('UPDATE inventory_locations SET label=$3,parent_id=$4,active=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING *', [actor.organization_id, data.id, data.label, data.parentId, data.active]);
          result = location(updated.rows[0]);
        }
        await client.query(`INSERT INTO inventory_catalog_events(change_id,organization_id,resource_id,resource_type,actor_id,device_id,request_payload,result_payload,before_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [data.changeId, actor.organization_id, data.id, kind, actor.id, data.deviceId, JSON.stringify(data), JSON.stringify(result), JSON.stringify(snapshot)]);
        await client.query('COMMIT'); return reply.code(201).send(result);
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    });
  }
}
