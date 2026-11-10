import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const uuid = z.string().uuid();
const paramsSchema = z.object({ id: uuid }).strict();
const pageSchema = z.object({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
}).strict();
const positiveDecimal = z.string().regex(/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const unit = z.enum(['cells', 'pieces', 'kg', 'm', 'm2']);
const linkSchema = z.object({
  // Stable client-generated identity for safe retry when the HTTP reply is lost.
  declarationId: uuid.optional(),
  sourceBatchId: uuid,
  kind: z.enum(['assembly', 'split', 'merge', 'consumption']),
  sourceQuantity: positiveDecimal,
  sourceUnit: unit,
  targetQuantity: positiveDecimal,
  targetUnit: unit,
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();

/**
 * Provenance declaration only: never invent a material balance, deduct stock,
 * complete a batch, or allow unapproved workshop actors to claim handovers.
 * The two batch identities and their common order are locked and verified by
 * the database; actual inventory moves remain for M4.
 */
export function registerBatchGenealogyRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/planning/batches/:id/links', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = paramsSchema.safeParse(request.params);
    const parsed = linkSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: 'invalid_batch_link' });

    const targetId = params.data.id, data = parsed.data;
    if (data.sourceBatchId === targetId)
      return reply.code(400).send({ error: 'self_link_forbidden' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT b.id,b.order_id,b.status,b.material_line,
          o.status AS order_status
        FROM production_batches b
        JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
        WHERE b.organization_id=$1 AND b.id = ANY($2::uuid[])
        ORDER BY b.id FOR UPDATE OF b`,
        [actor.organization_id,[targetId,data.sourceBatchId]]);
      if (result.rowCount !== 2) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'batch_not_found' });
      }
      const source = result.rows.find(row => row.id === data.sourceBatchId);
      const target = result.rows.find(row => row.id === targetId);
      if (!source || !target || source.order_id !== target.order_id) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'batch_order_mismatch' });
      }
      // The two batch row locks serialize competing declarations for the same
      // endpoints. A retry of a confirmed declaration must return its prior
      // result even if the destination has subsequently left the editable state.
      const linkId = data.declarationId ?? randomUUID();
      if (data.declarationId) {
        const existing = await client.query(`SELECT
          source_batch_id=$3 AND target_batch_id=$4 AND link_kind=$5
          AND source_quantity=$6::numeric AND source_unit=$7
          AND target_quantity=$8::numeric AND target_unit=$9
          AND actor_id=$10 AND note IS NOT DISTINCT FROM $11::text
          AS same_declaration
          FROM production_batch_links
          WHERE organization_id=$1 AND id=$2`,
          [actor.organization_id,linkId,data.sourceBatchId,targetId,data.kind,
            data.sourceQuantity,data.sourceUnit,data.targetQuantity,data.targetUnit,
            actor.id,data.note ?? null]);
        if (existing.rowCount) {
          await client.query('ROLLBACK');
          if (!existing.rows[0].same_declaration)
            return reply.code(409).send({ error: 'declaration_id_reused' });
          return { id:linkId,sourceBatchId:data.sourceBatchId,targetBatchId:targetId,
            kind:data.kind,alreadyRecorded:true };
        }
      }
      if (!['released','in_progress'].includes(source.order_status) ||
          source.status !== 'completed' ||
          !['created','in_progress'].includes(target.status)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'batch_link_not_permitted_by_status' });
      }
      if ((data.kind === 'assembly' &&
           (target.material_line !== 'cell' ||
             !['cathode','anode'].includes(source.material_line))) ||
          (['split','merge'].includes(data.kind) && source.material_line !== target.material_line)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'batch_link_kind_mismatch' });
      }

      // All genealogy additions within one order are serialized. Otherwise
      // two concurrent cross-links could each observe no cycle and both commit.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [actor.organization_id + ':' + source.order_id + ':genealogy']);
      const cycle = await client.query(`WITH RECURSIVE downstream(id) AS (
          SELECT target_batch_id FROM production_batch_links
          WHERE organization_id=$1 AND order_id=$2 AND source_batch_id=$3
          UNION
          SELECT links.target_batch_id FROM production_batch_links links
          JOIN downstream d ON links.source_batch_id=d.id
          WHERE links.organization_id=$1 AND links.order_id=$2
        )
        SELECT EXISTS(SELECT 1 FROM downstream WHERE id=$4) AS found`,
        [actor.organization_id,source.order_id,targetId,data.sourceBatchId]);
      if (cycle.rows[0].found) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'batch_genealogy_cycle' });
      }
      await client.query(`INSERT INTO production_batch_links
        (organization_id,id,order_id,source_batch_id,target_batch_id,
          link_kind,source_quantity,source_unit,target_quantity,target_unit,actor_id,note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [actor.organization_id,linkId,source.order_id,data.sourceBatchId,targetId,
          data.kind,data.sourceQuantity,data.sourceUnit,
          data.targetQuantity,data.targetUnit,actor.id,data.note ?? null]);
      await client.query('COMMIT');
      return reply.code(201).send({ id:linkId,sourceBatchId:data.sourceBatchId,
        targetBatchId:targetId,kind:data.kind });
    } catch (error) {
      await client.query('ROLLBACK');
      // Another target may race with the same client declaration UUID. Never
      // surface a database error or create a second link on that collision.
      if (data.declarationId && error && typeof error === 'object' &&
          'code' in error && error.code === '23505')
        return reply.code(409).send({ error: 'declaration_id_reused' });
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/batches/:id/links', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_batch_id' });
    const page = pageSchema.safeParse(request.query);
    if (!page.success) return reply.code(400).send({ error: 'invalid_genealogy_page' });
    const batch = await pool.query(`SELECT id FROM production_batches
      WHERE organization_id=$1 AND id=$2`, [actor.organization_id,params.data.id]);
    if (!batch.rowCount) return reply.code(404).send({ error: 'batch_not_found' });
    if (page.data.after) {
      const cursor = await pool.query(`SELECT id FROM production_batch_links
        WHERE organization_id=$1 AND id=$3 AND (source_batch_id=$2 OR target_batch_id=$2)`,
        [actor.organization_id,params.data.id,page.data.after]);
      if (!cursor.rowCount)
        return reply.code(400).send({ error: 'invalid_genealogy_page' });
    }
    const links = await pool.query(`SELECT l.id,l.source_batch_id,l.target_batch_id,
        l.link_kind,l.source_quantity::text,l.source_unit,
        l.target_quantity::text,l.target_unit,l.actor_id,l.note,l.occurred_at,
        source.batch_code AS source_code, target.batch_code AS target_code
      FROM production_batch_links l
      JOIN production_batches source ON source.organization_id=l.organization_id
        AND source.id=l.source_batch_id
      JOIN production_batches target ON target.organization_id=l.organization_id
        AND target.id=l.target_batch_id
      WHERE l.organization_id=$1 AND (l.source_batch_id=$2 OR l.target_batch_id=$2)
        AND ($3::uuid IS NULL OR (l.occurred_at,l.id) > (
          SELECT occurred_at,id FROM production_batch_links
          WHERE organization_id=$1 AND id=$3
        ))
      ORDER BY l.occurred_at,l.id LIMIT $4`,
      [actor.organization_id,params.data.id,page.data.after ?? null,page.data.limit+1]);
    // Resolve the cursor's exact database timestamp rather than round it through
    // JavaScript Date, which would skip links separated by microseconds.
    const rows = links.rows.slice(0,page.data.limit);
    const hasMore = links.rows.length > page.data.limit;
    return { batchId:params.data.id, hasMore,
      nextAfter:hasMore ? rows[rows.length-1].id : null,
      links:rows.map(row => ({
      id:row.id,sourceBatchId:row.source_batch_id,targetBatchId:row.target_batch_id,
      sourceCode:row.source_code,targetCode:row.target_code,kind:row.link_kind,
      sourceQuantity:row.source_quantity,sourceUnit:row.source_unit,
      targetQuantity:row.target_quantity,targetUnit:row.target_unit,
      actorId:row.actor_id,note:row.note,occurredAt:row.occurred_at,
    })) };
  });
}
