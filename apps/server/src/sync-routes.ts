import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, tokenHash, type Principal } from './auth.js';
import { taskPayloadV1, type TaskPayloadV1 } from './task-schema.js';
import { validateTaskCreator, validateTaskComments, validateTaskAttachments, validateTaskTimestamps, validateTaskStatusTransition, validateWorkerTaskEdit } from './task-authorization.js';

const operation = z.object({
  operationId: z.string().uuid(), deviceId: z.string().uuid(),
  entityType: z.literal('task'), entityId: z.string().uuid(),
  operationType: z.enum(['upsert']), expectedRevision: z.number().int().nonnegative().nullable(),
  payload: taskPayloadV1
}).strict();
const pushSchema = z.object({ operations: z.array(operation).min(1).max(50) }).strict();
const pullSchema = z.object({ cursor: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(200).default(100), deviceId: z.string().uuid() }).strict();
const comparisonSchema = z.object({ deviceId: z.string().uuid() }).strict();

/** Every shared sync read/write requires the same short-lived, actor/session/device-bound grant. */
async function deviceProofError(pool: Pool, principal: Principal, authorization: string, deviceId: string, proof: unknown) {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof))
    return 'device_proof_required';
  const grant = await pool.query(`SELECT g.token_hash FROM device_proof_grants g
    JOIN devices d ON d.id=g.device_id AND d.organization_id=g.organization_id AND d.user_id=g.user_id
    JOIN sessions s ON s.token_hash=g.session_token_hash AND s.organization_id=g.organization_id AND s.user_id=g.user_id
    WHERE g.token_hash=$1 AND g.organization_id=$2 AND g.user_id=$3 AND g.device_id=$4
      AND g.session_token_hash=$5 AND g.expires_at>now() AND g.revoked_at IS NULL
      AND d.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>now()`,
    [tokenHash(proof), principal.organization_id, principal.id, deviceId, tokenHash(authorization.slice(7))]);
  return grant.rowCount ? null : 'device_proof_invalid';
}


/** Masters may access only tasks in their enrolled workshops. A null workshop
 * or a transfer outside their membership is denied, even for exact retries. */
async function masterTaskScopeError(client: PoolClient, principal: Principal, incoming: TaskPayloadV1, existing?: TaskPayloadV1) {
  if (principal.role === 'chief') return null;
  // Preserve an existing null workshop: ?? would silently replace it with the
  // incoming assignment and let a master claim a formerly unscoped task.
  const ids = [incoming.workshopId, existing ? existing.workshopId : incoming.workshopId];
  if (ids.some(id => !id)) return 'workshop_access_denied';
  const result = await client.query(
    'SELECT workshop_id FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2 AND workshop_id = ANY($3::text[])',
    [principal.organization_id, principal.id, ids],
  );
  return new Set(result.rows.map(row => row.workshop_id)).size === new Set(ids).size
    ? null : 'workshop_access_denied';
}

// The first sync slice intentionally supports only tasks, never arbitrary table writes.
// All changes are transactional, tenant-scoped and idempotent.
export function registerSyncRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/sync/push', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    if (!['chief', 'master', 'worker'].includes(principal.role)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = pushSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    // Proof tokens are short-lived and bound to this exact login session, actor and device.
    // Reject mixed-device batches before any transaction can mutate shared state.
    const deviceIds = new Set(parsed.data.operations.map(op => op.deviceId));
    if (deviceIds.size !== 1) return reply.code(400).send({ error: 'mixed_device_batch' });
    const proofError = await deviceProofError(pool, principal, request.headers.authorization!, parsed.data.operations[0].deviceId, request.headers['x-device-proof']);
    if (proofError) return reply.code(403).send({ error: proofError });
    const results = [];
    for (const op of parsed.data.operations) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize all writes to the same entity, including initial creation.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal.organization_id + ':sync-sequence']);
        const device = await client.query('SELECT id FROM devices WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL', [op.deviceId, principal.organization_id, principal.id]);
        if (!device.rowCount) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'device_not_enrolled' }); continue; }
        const current = await client.query('SELECT revision, payload FROM sync_entities WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3', [principal.organization_id, op.entityType, op.entityId]);
        const scopeError = await masterTaskScopeError(client, principal, op.payload, current.rows[0]?.payload);
        if (scopeError) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: scopeError }); continue; }
        const duplicate = await client.query('SELECT organization_id, entity_id, entity_type, device_id, actor_id, operation_type, expected_revision, revision, payload = $2::jsonb AS same_payload FROM sync_operations WHERE operation_id=$1', [op.operationId, JSON.stringify(op.payload)]);
        if (duplicate.rowCount) {
          const prev = duplicate.rows[0];
          await client.query('ROLLBACK');
          results.push(prev.organization_id === principal.organization_id && prev.entity_id === op.entityId && prev.entity_type === op.entityType && prev.device_id === op.deviceId && prev.actor_id === principal.id && prev.operation_type === op.operationType && prev.expected_revision === op.expectedRevision && prev.same_payload === true ? { operationId: op.operationId, status: 'duplicate', revision: prev.revision } : { operationId: op.operationId, status: 'rejected', reason: 'operation_id_reused' });
          continue;
        }
        const workerError = validateWorkerTaskEdit(principal, op.payload, current.rows[0]?.payload);
        if (workerError) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: workerError }); continue; }
        if (op.payload.assignedTo) {
          const assignee = await client.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND active=true', [op.payload.assignedTo, principal.organization_id]);
          if (!assignee.rowCount) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'invalid_assignee' }); continue; }
          // A scoped task must not be assigned to someone outside its workshop.
          // The check applies to chiefs as well as masters; reassignment cannot
          // bypass the workshop membership policy.
          if (op.payload.workshopId) {
            const membership = await client.query(
              'SELECT 1 FROM user_workshop_memberships WHERE organization_id=$1 AND user_id=$2 AND workshop_id=$3',
              [principal.organization_id, op.payload.assignedTo, op.payload.workshopId],
            );
            if (!membership.rowCount) {
              await client.query('ROLLBACK');
              results.push({ operationId: op.operationId, status: 'rejected', reason: 'assignee_outside_workshop' });
              continue;
            }
          }
        }
        if (op.payload.comments.some(c => c.taskId !== op.entityId) || op.payload.attachments.some(a => a.taskId !== op.entityId)) {
          await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'invalid_task_children' }); continue;
        }
        const creator = await client.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2', [op.payload.createdBy, principal.organization_id]);
        if (!creator.rowCount) { await client.query('ROLLBACK'); results.push({ operationId: op.operationId, status: 'rejected', reason: 'invalid_creator' }); continue; }

        const creatorError = validateTaskCreator(principal, op.payload, current.rows[0]?.payload) 
          || validateTaskComments(principal, op.payload, current.rows[0]?.payload)
          || validateTaskAttachments(op.payload, current.rows[0]?.payload)
          || validateTaskTimestamps(op.payload, current.rows[0]?.payload)
          || validateTaskStatusTransition(op.payload, current.rows[0]?.payload);
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
    if (!['chief', 'master', 'worker'].includes(principal.role)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_task_id' });
    const device = comparisonSchema.safeParse(request.query);
    if (!device.success) return reply.code(400).send({ error: 'invalid_request' });
    const proofError = await deviceProofError(pool, principal, request.headers.authorization!, device.data.deviceId, request.headers['x-device-proof']);
    if (proofError) return reply.code(403).send({ error: proofError });
    const result = await pool.query(
      `SELECT e.revision, e.payload FROM sync_entities e
        WHERE e.organization_id=$1 AND e.entity_type=$2 AND e.entity_id=$3
        AND ($4::boolean
          OR ($6::boolean AND e.payload->>'assignedTo'=$5)
          OR (NOT $6::boolean AND EXISTS (
            SELECT 1 FROM user_workshop_memberships m
            WHERE m.organization_id=e.organization_id AND m.user_id=$5
              AND m.workshop_id=e.payload->>'workshopId')))`,
      [principal.organization_id, 'task', parsed.data, principal.role === 'chief', principal.id, principal.role === 'worker'],
    );
    if (!result.rows.length) return reply.code(404).send({ error: 'task_not_found' });
    return { revision: result.rows[0].revision, payload: result.rows[0].payload };
  });
  app.get('/sync/pull', async (request, reply) => {
    const principal = await authenticate(pool, request.headers.authorization);
    if (!principal) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = pullSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!['chief', 'master', 'worker'].includes(principal.role)) return reply.code(403).send({ error: 'forbidden' });
    const { cursor, limit, deviceId } = parsed.data;
    const proofError = await deviceProofError(pool, principal, request.headers.authorization!, deviceId, request.headers['x-device-proof']);
    if (proofError) return reply.code(403).send({ error: proofError });
    const result = await pool.query(`SELECT o.sequence,o.operation_id,o.entity_type,o.entity_id,o.revision,o.result_payload AS payload
      FROM sync_operations o
      JOIN sync_entities e ON e.organization_id=o.organization_id AND e.entity_type=o.entity_type AND e.entity_id=o.entity_id
      WHERE o.organization_id=$1 AND o.sequence>$2 AND o.entity_type='task'
      AND ($4::boolean
        OR ($6::boolean AND o.result_payload->>'assignedTo'=$5 AND e.payload->>'assignedTo'=$5)
        OR (NOT $6::boolean AND EXISTS (
          SELECT 1 FROM user_workshop_memberships m
          WHERE m.organization_id=o.organization_id AND m.user_id=$5
            AND m.workshop_id=o.result_payload->>'workshopId'
            AND m.workshop_id=e.payload->>'workshopId')))
      ORDER BY o.sequence ASC LIMIT $3`, [principal.organization_id,cursor,limit,principal.role === 'chief',principal.id,principal.role === 'worker']);
    const changes = result.rows;
    return { changes, nextCursor: changes.length ? Number(changes[changes.length - 1].sequence) : cursor, hasMore: changes.length === limit };
  });
}
