import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { taskPayloadV1 } from './task-schema.js';
import { validateTaskCreator } from './task-authorization.js';

const operation = z.object({
  operationId: z.string().uuid(), deviceId: z.string().uuid(),
  entityType: z.literal('task'), entityId: z.string().uuid(),
  operationType: z.enum(['upsert']), expectedRevision: z.number().int().nonnegative().nullable(),
  payload: taskPayloadV1
}).strict();
const pushSchema = z.object({ operations: z.array(operation).min(1).max(50) }).strict();
const pullSchema = z.object({ cursor: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(200).default(100) });

// The first sync slice intentionally supports only tasks, never arbitrary table writes.
// All changes are transactional, tenant-scoped and idempotent.
export function registerSyncRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/sync/push', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (principal.role !== 'chief' && principal.role !== 'master') return reply.code(403).send({ error: 'forbidden' });
    const parsed = pushSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const results = [];
    for (const op of parsed.data.operations) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize all writes to the same entity, including initial creation.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal.organization_id + ':sync-sequence']);
        const device = await client.query('SELECT id FROM devices WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL', [op.deviceId, principal.organization_id, principal.id]);
        if (!device.rowCount) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'device_not_enrolled' }); continue; }
        const duplicate = await client.query('SELECT operation_id, organization_id, entity_id, entity_type, device_id, actor_id, payload, revision, result_payload FROM sync_operations WHERE operation_id=$1', [op.operationId]);
        if (duplicate.rowCount) {
          const prev = duplicate.rows[0];
          await client.query('ROLLBACK');
          results.push(prev.organization_id === principal.organization_id && prev.entity_id === op.entityId && prev.entity_type === op.entityType && prev.device_id === op.deviceId && prev.actor_id === principal.id && JSON.stringify(prev.payload) === JSON.stringify(op.payload) ? { operationId: op.operationId, status: 'duplicate', revision: prev.revision } : { operationId: op.operationId, status: 'rejected', reason: 'operation_id_reused' });
          continue;
        }
        if (op.payload.assignedTo) {
          const assignee = await client.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND active=true', [op.payload.assignedTo, principal.organization_id]);
          if (!assignee.rowCount) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'invalid_assignee' }); continue; }
        }
        if (op.payload.comments.some(c => c.taskId !== op.entityId) || op.payload.attachments.some(a => a.taskId !== op.entityId)) {
          await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'invalid_task_children' }); continue;
        }
        const creator = await client.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2', [op.payload.createdBy, principal.organization_id]);
        if (!creator.rowCount) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'invalid_creator' }); continue; }
        const current = await client.query('SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3', [principal.organization_id, op.entityType, op.entityId]);
        const creatorError = validateTaskCreator(principal, op.payload, current.rows[0]?.payload);
        if (creatorError) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: creatorError }); continue; }
        const actualRevision = current.rows[0]?.revision ?? 0;
        if (op.expectedRevision !== actualRevision) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'conflict', actualRevision }); continue; }
        const revision = actualRevision + 1;
        await client.query(`INSERT INTO sync_entities(organization_id,entity_type,entity_id,revision,payload) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT(organization_id,entity_type,entity_id) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,updated_at=now()`, [principal.organization_id, op.entityType, op.entityId, revision, op.payload]);
        await client.query(`INSERT INTO sync_operations(operation_id,organization_id,device_id,actor_id,entity_type,entity_id,operation_type,expected_revision,payload,revision,result_payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [op.operationId,principal.organization_id,op.deviceId,principal.id,op.entityType,op.entityId,op.operationType,op.expectedRevision,op.payload,revision,op.payload]);
        await client.query('COMMIT');
        results.push({ operationId: op.operationId, status: 'accepted', revision });
      } catch (error) {
        await client.query('ROLLBACK');
        request.log.error(error);
        return reply.code(503).send({ error: 'sync_temporarily_unavailable' });
      } finally { client.release(); }
    }
    return { results };
  });
  // Read-only comparison endpoint. Never resolves conflicts or changes server data.
  app.get('/sync/task/:id', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (principal.role !== 'chief' && principal.role !== 'master') return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_task_id' });
    const result = await pool.query(
      'SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3',
      [principal.organization_id, 'task', parsed.data],
    );
    if (!result.rows.length) return reply.code(404).send({ error: 'task_not_found' });
    return { revision: result.rows[0].revision, payload: result.rows[0].payload };
  });
  app.get('/sync/pull', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = pullSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (principal.role !== 'chief' && principal.role !== 'master') return reply.code(403).send({ error: 'forbidden' });
    const { cursor, limit } = parsed.data;
    const result = await pool.query(`SELECT sequence,operation_id,entity_type,entity_id,revision,result_payload AS payload
      FROM sync_operations WHERE organization_id=$1 AND sequence>$2 AND entity_type='task' ORDER BY sequence ASC LIMIT $3`, [principal.organization_id,cursor,limit]);
    const changes = result.rows;
    return { changes, nextCursor: changes.length ? Number(changes[changes.length - 1].sequence) : cursor, hasMore: changes.length === limit };
  });
}
