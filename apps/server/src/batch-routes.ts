import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

// Execution and shop-floor permissions are deliberately out of scope for this
// planning slice. Only a server-authenticated chief may release orders or
// change a batch. M1 task synchronization never touches these tables.
const uuidParam = z.object({ id: z.guid() }).strict();
const quantity = z.string().regex(/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const batchSchema = z.object({
  batchCode: z.string().trim().min(1).max(100),
  materialLine: z.enum(['cathode', 'anode', 'cell']),
  plannedQuantity: quantity,
  quantityUnit: z.enum(['cells', 'pieces', 'kg', 'm', 'm2']),
}).strict();
const state = z.enum(['created', 'in_progress', 'hold', 'completed', 'scrapped']);
const transitionSchema = z.object({
  expectedStatus: state,
  status: state,
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();
const allowedTransitions: Record<z.infer<typeof state>, ReadonlyArray<z.infer<typeof state>>> = {
  created: ['in_progress', 'hold', 'scrapped'],
  in_progress: ['hold', 'completed', 'scrapped'],
  hold: ['in_progress', 'scrapped'],
  completed: [],
  scrapped: [],
};

function sqlCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code: unknown }).code : null;
}

export function registerBatchRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/planning/orders/:id/release', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = uuidParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_order_id' });
    const result = await pool.query(`UPDATE production_orders o
      SET status='released', updated_at=now()
      WHERE o.organization_id=$1 AND o.id=$2 AND o.status='draft'
        AND EXISTS (SELECT 1 FROM process_route_versions v
          WHERE v.organization_id=o.organization_id AND v.route_id=o.route_id
            AND v.version=o.route_version AND v.state='approved')
      RETURNING id,order_code,status`, [actor.organization_id, params.data.id]);
    if (!result.rowCount) return reply.code(409).send({ error: 'order_not_releasable' });
    return { id: result.rows[0].id, orderCode: result.rows[0].order_code,
      status: result.rows[0].status };
  });

  app.post('/planning/orders/:id/batches', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = uuidParam.safeParse(request.params);
    const parsed = batchSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: 'invalid_batch' });
    const data = parsed.data, id = randomUUID(), eventId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query(`SELECT status FROM production_orders
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
        [actor.organization_id, params.data.id]);
      if (!order.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'order_not_found' });
      }
      if (!['released', 'in_progress'].includes(order.rows[0].status)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'order_not_released' });
      }
      await client.query(`INSERT INTO production_batches
        (organization_id,id,order_id,batch_code,material_line,
          planned_quantity,quantity_unit,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.organization_id,id,params.data.id,data.batchCode,
          data.materialLine,data.plannedQuantity,data.quantityUnit,actor.id]);
      await client.query(`INSERT INTO production_batch_events
        (organization_id,id,batch_id,event_number,from_status,to_status,actor_id)
        VALUES ($1,$2,$3,1,NULL,'created',$4)`,
        [actor.organization_id,eventId,id,actor.id]);
      await client.query('COMMIT');
      return reply.code(201).send({ id, orderId: params.data.id,
        batchCode: data.batchCode, materialLine: data.materialLine,
        status: 'created', plannedQuantity: data.plannedQuantity,
        quantityUnit: data.quantityUnit });
    } catch (error) {
      await client.query('ROLLBACK');
      if (sqlCode(error) === '23505') return reply.code(409).send({ error: 'batch_code_exists' });
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/orders/:id/batches', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = uuidParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_order_id' });
    const order = await pool.query(`SELECT id FROM production_orders
      WHERE organization_id=$1 AND id=$2`, [actor.organization_id,params.data.id]);
    if (!order.rowCount) return reply.code(404).send({ error: 'order_not_found' });
    const result = await pool.query(`SELECT id,batch_code,material_line,status,
        planned_quantity::text,quantity_unit
      FROM production_batches WHERE organization_id=$1 AND order_id=$2
      ORDER BY created_at,id LIMIT 500`, [actor.organization_id,params.data.id]);
    return { orderId: params.data.id, batches: result.rows.map(row => ({
      id: row.id, batchCode: row.batch_code, materialLine: row.material_line,
      status: row.status, plannedQuantity: row.planned_quantity,
      quantityUnit: row.quantity_unit,
    })) };
  });

  app.post('/planning/batches/:id/status', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = uuidParam.safeParse(request.params);
    const parsed = transitionSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_batch_transition' });
    const { status, expectedStatus, reason } = parsed.data;
    if ((status === 'hold' || status === 'scrapped') && !reason)
      return reply.code(400).send({ error: 'reason_required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query(`SELECT b.status,b.material_line,
          o.route_id,o.route_version
        FROM production_batches b
        JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
        WHERE b.organization_id=$1 AND b.id=$2 FOR UPDATE OF b`,
        [actor.organization_id,params.data.id]);
      if (!batch.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'batch_not_found' });
      }
      const current = batch.rows[0].status as z.infer<typeof state>;
      if (current !== expectedStatus) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'batch_status_changed', actualStatus: current });
      }
      if (!allowedTransitions[current].includes(status)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'invalid_batch_status_transition' });
      }
      if (status === 'completed') {
        // A flagged observation without a latest documented non-blocking
        // review must prevent accidental batch closure. This is triage only,
        // not formal independent QA release or automatic hold.
        const unresolved=await client.query(`SELECT i.id
          FROM production_inspection_observations i
          LEFT JOIN LATERAL (
            SELECT r.outcome FROM production_inspection_reviews r
            WHERE r.organization_id=i.organization_id
              AND r.batch_id=i.batch_id AND r.observation_id=i.id
            ORDER BY r.review_number DESC LIMIT 1
          ) last_review ON TRUE
          WHERE i.organization_id=$1 AND i.batch_id=$2
            AND i.attention_required=true
            AND COALESCE(last_review.outcome,'follow_up_required')<>'reviewed_no_block'
          LIMIT 1`,[actor.organization_id,params.data.id]);
        if(unresolved.rowCount){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'inspection_review_pending'});
        }
        // An unresolved physical handover must not be disguised as a completed
        // batch. The declaration is immutable; a different actor must receipt
        // it before the chief may close the batch.
        const pendingHandoffs = await client.query(`SELECT 1
          FROM production_stage_handoffs h
          LEFT JOIN production_stage_receipts r
            ON r.organization_id=h.organization_id AND r.handoff_id=h.id
          WHERE h.organization_id=$1 AND h.batch_id=$2 AND r.handoff_id IS NULL
          LIMIT 1`, [actor.organization_id, params.data.id]);
        if (pendingHandoffs.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'handoff_receipt_pending' });
        }
        // A status alone cannot certify manufacturing: every step in this
        // batch's approved route branch needs immutable completion evidence.
        // Keep the check under the locked batch row to serialize concurrent
        // status changes and evidence submissions.
        const steps = await client.query(`SELECT s.step_number,
            EXISTS (SELECT 1 FROM production_step_evidence e
              WHERE e.organization_id=s.organization_id AND e.batch_id=$2
                AND e.route_id=s.route_id AND e.route_version=s.route_version
                AND e.step_number=s.step_number AND e.kind='completed') AS done
          FROM process_route_steps s
          WHERE s.organization_id=$1 AND s.route_id=$3 AND s.route_version=$4
            AND s.electrode_line=$5 ORDER BY s.step_number`,
          [actor.organization_id,params.data.id,batch.rows[0].route_id,
            batch.rows[0].route_version,
            batch.rows[0].material_line === 'cell' ? 'common' : batch.rows[0].material_line]);
        if (!steps.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'batch_route_steps_missing' });
        }
        if (steps.rows.some((step: { done: boolean }) => !step.done)) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'batch_route_step_incomplete' });
        }
      }
      const next = await client.query(`SELECT COALESCE(max(event_number),0)+1 AS number
        FROM production_batch_events WHERE organization_id=$1 AND batch_id=$2`,
        [actor.organization_id,params.data.id]);
      const eventNumber = Number(next.rows[0].number);
      await client.query(`UPDATE production_batches SET status=$3
        WHERE organization_id=$1 AND id=$2`, [actor.organization_id,params.data.id,status]);
      await client.query(`INSERT INTO production_batch_events
        (organization_id,id,batch_id,event_number,from_status,to_status,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.organization_id,randomUUID(),params.data.id,eventNumber,
          current,status,actor.id,reason ?? null]);
      await client.query('COMMIT');
      return { id: params.data.id, previousStatus: current, status, eventNumber };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/batches/:id/events', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = uuidParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_batch_id' });
    const batch = await pool.query(`SELECT id,status FROM production_batches
      WHERE organization_id=$1 AND id=$2`, [actor.organization_id,params.data.id]);
    if (!batch.rowCount) return reply.code(404).send({ error: 'batch_not_found' });
    const events = await pool.query(`SELECT event_number,from_status,to_status,
        actor_id,reason,occurred_at
      FROM production_batch_events WHERE organization_id=$1 AND batch_id=$2
      ORDER BY event_number LIMIT 500`,[actor.organization_id,params.data.id]);
    return { id: params.data.id, status: batch.rows[0].status,
      events: events.rows.map(row => ({
        number: row.event_number, fromStatus: row.from_status,
        toStatus: row.to_status, actorId: row.actor_id,
        reason: row.reason, occurredAt: row.occurred_at,
      })) };
  });
}
