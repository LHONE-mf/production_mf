import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { inventoryPermission } from './inventory-routes.js';
import { deviceProofError } from './sync-routes.js';
import { currentInventoryWriter, inventoryStream, inventoryWriteFence } from './inventory-stream.js';
import { inventoryStockFromRow } from './inventory-snapshot.js';
const body = z.object({ operationId: z.guid(), stockId: z.guid(), deviceId: z.guid(), expectedRevision: z.number().int().min(1).max(2147483646), disposition: z.enum(['release', 'hold', 'block', 'reject']), reason: z.string().trim().min(1).max(2000), evidence: z.string().trim().min(1).max(2000) }).strict();
const params = z.object({ stockId: z.guid() }).strict();
const page = z.object({ deviceId: z.guid(), after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export function registerInventoryQualityRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/inventory/stocks/:stockId/quality-dispositions', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'chief_quality_required' });
    const parsed = body.safeParse(request.body), target = params.safeParse(request.params);
    if (!parsed.success || !target.success || parsed.data.stockId !== target.data.stockId) return reply.code(400).send({ error: 'invalid_quality_disposition' });
    const data = parsed.data;
    const proof = await deviceProofError(pool, actor, request.headers.authorization!, data.deviceId, request.headers['x-device-proof']);
    if (proof) return reply.code(403).send({ error: proof });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [actor.organization_id + ':inventory-sequence']);
      const currentActor = await currentInventoryWriter(client, actor.organization_id, actor.id, data.deviceId, request.headers.authorization!, request.headers['x-device-proof'], 'manager');
      if (currentActor?.role !== 'chief') { await client.query('ROLLBACK'); return reply.code(403).send({ error: 'chief_quality_required' }); }
      const fence = await inventoryWriteFence(client, actor.organization_id, request.headers['x-inventory-epoch']);
      if (fence) { await client.query('ROLLBACK'); return reply.code(fence === 'inventory_epoch_required' ? 428 : 409).send({ error: fence }); }
      const prior = await client.query(`SELECT organization_id,stock_id,actor_id,device_id,kind,request_payload=$2::jsonb AS identical,result_stock FROM inventory_operations WHERE operation_id=$1`, [data.operationId, JSON.stringify(data)]);
      if (prior.rowCount) {
        const row = prior.rows[0], same = row.organization_id === actor.organization_id && row.stock_id === data.stockId && row.actor_id === actor.id && row.device_id === data.deviceId && row.kind === 'quality_change' && row.identical;
        await client.query('ROLLBACK'); return reply.code(same ? 200 : 409).send(same ? { status: 'duplicate', operationId: data.operationId, stock: row.result_stock } : { error: 'operation_id_reused' });
      }
      const found = await client.query(`SELECT s.*,m.base_unit,(s.expires_at IS NULL OR s.expires_at>clock_timestamp()) AS unexpired FROM inventory_stocks s JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s`, [actor.organization_id, data.stockId]);
      if (!found.rowCount) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'stock_not_found' }); }
      const current = inventoryStockFromRow(found.rows[0]);
      if (current.revision !== data.expectedRevision) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'revision_conflict', currentRevision: current.revision }); }
      if (data.disposition === 'release' && !found.rows[0].unexpired) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'expired' }); }
      if ((await client.query("SELECT 1 FROM inventory_quality_dispositions WHERE organization_id=$1 AND stock_id=$2 AND disposition='reject' LIMIT 1", [actor.organization_id, data.stockId])).rowCount) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'quality_rejected' }); }
      const stock = { ...current, quality: data.disposition === 'release' ? 'released' : 'blocked', disposition: data.disposition, revision: current.revision + 1, available: current.onHand - current.reserved };
      await client.query('UPDATE inventory_stocks SET quality=$3,disposition=$4,revision=$5 WHERE organization_id=$1 AND id=$2', [actor.organization_id, data.stockId, stock.quality, data.disposition, stock.revision]);
      await client.query(`INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock,from_location_id) VALUES($1,$2,$3,$4,$5,'quality_change',0,$6,$7,$8,$9,$10,$11)`, [data.operationId, actor.organization_id, data.stockId, actor.id, data.deviceId, current.revision, stock.revision, data.reason, JSON.stringify(data), JSON.stringify(stock), current.locationId]);
      await client.query(`INSERT INTO inventory_quality_dispositions(operation_id,organization_id,stock_id,actor_id,device_id,disposition,reason,evidence,expected_revision,resulting_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [data.operationId, actor.organization_id, data.stockId, actor.id, data.deviceId, data.disposition, data.reason, data.evidence, current.revision, stock.revision]);
      await client.query('COMMIT'); return reply.code(201).send({ status: 'confirmed', operationId: data.operationId, stock });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') return reply.code(409).send({error:'operation_id_reused'});
      if ((error as { code?: string }).code === '23503') return reply.code(409).send({error:'inventory_reference_changed'});
      if ((error as { code?: string }).code === 'P0001') return reply.code(409).send({ error: 'quality_release_ineligible' });
      throw error;
    } finally { client.release(); }
  });
  app.get('/inventory/stocks/:stockId/quality-history', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = page.safeParse(request.query), target = params.safeParse(request.params);
    if (!parsed.success || !target.success) return reply.code(400).send({ error: 'invalid_quality_history' });
    const data = parsed.data;
    if (!await inventoryPermission(pool, actor, 'operator')) return reply.code(403).send({ error: 'forbidden' });
    const proof = await deviceProofError(pool, actor, request.headers.authorization!, data.deviceId, request.headers['x-device-proof']);
    if (proof) return reply.code(403).send({ error: proof });
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [actor.organization_id + ':inventory-sequence']);
      if (!await currentInventoryWriter(client, actor.organization_id, actor.id, data.deviceId, request.headers.authorization!, request.headers['x-device-proof'], 'operator')) { await client.query('ROLLBACK'); return reply.code(403).send({ error: 'forbidden' }); }
      const stream = await inventoryStream(client, actor.organization_id);
      if (!(await client.query('SELECT 1 FROM inventory_stocks WHERE organization_id=$1 AND id=$2', [actor.organization_id, target.data.stockId])).rowCount) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'stock_not_found' }); }
      const found = await client.query(`SELECT q.*,o.sequence FROM inventory_quality_dispositions q JOIN inventory_operations o ON o.operation_id=q.operation_id AND o.organization_id=q.organization_id WHERE q.organization_id=$1 AND q.stock_id=$2 AND o.sequence>$3 ORDER BY o.sequence LIMIT $4`, [actor.organization_id, target.data.stockId, data.after, data.limit + 1]);
      const rows = found.rows.slice(0, data.limit), hasMore = found.rowCount! > data.limit;
      await client.query('COMMIT');
      return { epoch: stream.epoch, items: rows.map(row => ({ operationId: row.operation_id, stockId: row.stock_id, sequence: Number(row.sequence), disposition: row.disposition, actorId: row.actor_id, deviceId: row.device_id, reason: row.reason, evidence: row.evidence, expectedRevision: row.expected_revision, resultingRevision: row.resulting_revision, recordedAt: row.recorded_at.toISOString() })), hasMore, nextAfter: hasMore ? Number(rows.at(-1)!.sequence) : null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
}
