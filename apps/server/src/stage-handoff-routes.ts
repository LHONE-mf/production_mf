import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { hasWholeCount } from './quantities.js';

const id = z.guid();
const batchParam = z.object({ id }).strict();
const positiveQuantity = z.string().regex(/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const sendSchema = z.object({
  handoffId: id,
  fromStep: z.number().int().positive().safe(),
  toStep: z.number().int().positive().safe(),
  quantity: positiveQuantity,
  quantityUnit: z.enum(['cells','pieces','kg','m','m2']),
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();
const receiveSchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
}).strict();

function pgCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code: unknown }).code : null;
}

/**
 * Recorded transfers are *not* stock consumption, output yield or automated
 * stage advancement. A receiver must independently acknowledge a handoff.
 * The server keeps both declarations immutable with tenant-owned identities.
 */
export function registerStageHandoffRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/planning/batches/:id/handoffs', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!['chief','master'].includes(actor.role))
      return reply.code(403).send({ error: 'forbidden' });
    const params = batchParam.safeParse(request.params);
    const parsed = sendSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_handoff' });
    const batchId = params.data.id, data = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query(`SELECT b.id,b.order_id,b.material_line,
          b.status,b.planned_quantity::text,b.quantity_unit,
          o.route_id,o.route_version,o.status AS order_status
        FROM production_batches b
        JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
        WHERE b.organization_id=$1 AND b.id=$2 FOR UPDATE OF b`,
        [actor.organization_id,batchId]);
      if (!batch.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'batch_not_found' });
      }
      const record = batch.rows[0];
      // Masters may send only *from* their currently assigned route workshop.
      // Enforce this before even acknowledging an old handoff ID, so a revoked
      // master cannot use retries to read or write transfer history. FOR SHARE
      // prevents membership deletion while the transfer transaction commits.
      if (actor.role === 'master') {
        const source = await client.query(`SELECT 1 FROM process_route_steps s
          JOIN user_workshop_memberships m
            ON m.organization_id=s.organization_id AND m.workshop_id=s.workshop_id
            AND m.user_id=$2
          WHERE s.organization_id=$1 AND s.route_id=$3 AND s.route_version=$4
            AND s.electrode_line=$5 AND s.step_number=$6
          FOR SHARE OF m`, [
          actor.organization_id,actor.id,record.route_id,record.route_version,
          record.material_line === 'cell' ? 'common' : record.material_line,
          data.fromStep,
        ]);
        if (!source.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error:'source_workshop_access_denied' });
        }
      }
      // Retried requests are safe even after the batch has advanced, but never
      // let the same UUID mean a different physical transfer.
      const previousId = await client.query(`SELECT id,batch_id,from_step,to_step,
          quantity_unit,note,sent_by,(quantity=$3::numeric) AS same_quantity
        FROM production_stage_handoffs WHERE organization_id=$1 AND id=$2`,
        [actor.organization_id,data.handoffId,data.quantity]);
      if (previousId.rowCount) {
        const prev = previousId.rows[0];
        await client.query('ROLLBACK');
        if (prev.batch_id === batchId && prev.from_step === data.fromStep &&
            prev.to_step === data.toStep && prev.same_quantity === true &&
            prev.quantity_unit === data.quantityUnit &&
            prev.note === (data.note ?? null) && prev.sent_by === actor.id) {
          return { id: data.handoffId, batchId, status: 'already_sent' };
        }
        return reply.code(409).send({ error: 'handoff_id_reused' });
      }
      if (!hasWholeCount(data.quantity,data.quantityUnit)) {
        await client.query('ROLLBACK');
        return reply.code(400).send({error:'quantity_requires_whole_count'});
      }
      if (record.status !== 'in_progress' || !['released','in_progress'].includes(record.order_status)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'batch_not_active' });
      }
      // PostgreSQL NUMERIC comparison avoids float conversion of kg/area data.
      const quantityOk = await client.query(`SELECT ($1::numeric <= $2::numeric) AS valid`,
        [data.quantity,record.planned_quantity]);
      if (!record.planned_quantity || record.quantity_unit !== data.quantityUnit ||
          !quantityOk.rows[0].valid) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'handoff_quantity_exceeds_batch' });
      }
      const line = record.material_line === 'cell' ? 'common' : record.material_line;
      const route = await client.query(`SELECT s.step_number,s.workshop_id
        FROM process_route_steps s
        WHERE s.organization_id=$1 AND s.route_id=$2 AND s.route_version=$3
          AND s.electrode_line=$4 ORDER BY s.step_number`,
        [actor.organization_id,record.route_id,record.route_version,line]);
      const steps = route.rows as Array<{ step_number: number; workshop_id: string }>;
      const fromIndex = steps.findIndex(step => step.step_number === data.fromStep);
      if (fromIndex < 0 || fromIndex + 1 >= steps.length ||
          steps[fromIndex + 1].step_number !== data.toStep) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'not_next_route_step' });
      }
      // A transfer cannot be declared before the sending operation has
      // produced its immutable completion evidence. Without this check,
      // a batch could be physically advanced while its route step is open.
      const finished = await client.query(`SELECT quantity::text,quantity_unit
        FROM production_step_evidence
        WHERE organization_id=$1 AND batch_id=$2 AND step_number=$3
          AND kind='completed' LIMIT 1`,
        [actor.organization_id,batchId,data.fromStep]);
      if (!finished.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'source_step_not_completed' });
      }
      // Never declare more transferred material than the sending operation
      // recorded as output. The units must match; conversion is not inferred.
      const actualOutput = finished.rows[0];
      if (actualOutput.quantity_unit !== data.quantityUnit) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'handoff_output_unit_mismatch' });
      }
      const withinOutput = await client.query(
        'SELECT $1::numeric <= $2::numeric AS valid',
        [data.quantity,actualOutput.quantity]);
      if (!withinOutput.rows[0].valid) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'handoff_exceeds_recorded_output' });
      }
      const latest = await client.query(`SELECT h.to_step,
          (r.handoff_id IS NOT NULL) AS received
        FROM production_stage_handoffs h
        LEFT JOIN production_stage_receipts r ON r.organization_id=h.organization_id
          AND r.handoff_id=h.id
        WHERE h.organization_id=$1 AND h.batch_id=$2
        ORDER BY h.from_step DESC LIMIT 1`,
        [actor.organization_id,batchId]);
      const expectedFrom = latest.rowCount ? latest.rows[0].to_step : steps[0].step_number;
      if (data.fromStep !== expectedFrom || (latest.rowCount && !latest.rows[0].received)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'previous_handoff_not_received' });
      }
      await client.query(`INSERT INTO production_stage_handoffs
        (organization_id,id,batch_id,from_step,to_step,from_workshop_id,
          to_workshop_id,quantity,quantity_unit,sent_by,note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [actor.organization_id,data.handoffId,batchId,data.fromStep,data.toStep,
          steps[fromIndex].workshop_id,steps[fromIndex + 1].workshop_id,
          data.quantity,data.quantityUnit,actor.id,data.note ?? null]);
      await client.query('COMMIT');
      return reply.code(201).send({ id:data.handoffId,batchId,status:'sent' });
    } catch (error) {
      await client.query('ROLLBACK');
      if (pgCode(error) === '23505') return reply.code(409).send({ error:'handoff_already_exists' });
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/handoffs/inbox', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error:'unauthorized' });
    if (!['chief','master'].includes(actor.role)) return reply.code(403).send({ error:'forbidden' });
    // Masters only see work arriving in a workshop where they currently
    // have membership. Sending actor and batch codes are audit references,
    // not an entitlement to see the rest of the order or other workshops.
    const result = await pool.query(`SELECT h.id,h.batch_id,b.batch_code,h.from_step,h.to_step,
          h.from_workshop_id,h.to_workshop_id,h.quantity::text,h.quantity_unit,
          h.sent_by,h.sent_at,h.note
        FROM production_stage_handoffs h
        JOIN production_batches b ON b.organization_id=h.organization_id AND b.id=h.batch_id
        LEFT JOIN production_stage_receipts r ON r.organization_id=h.organization_id
          AND r.handoff_id=h.id
        WHERE h.organization_id=$1 AND r.handoff_id IS NULL
          AND ($2::boolean OR EXISTS (
            SELECT 1 FROM user_workshop_memberships m
            WHERE m.organization_id=h.organization_id
              AND m.user_id=$3 AND m.workshop_id=h.to_workshop_id
          ))
        ORDER BY h.sent_at,h.id LIMIT 200`,
        [actor.organization_id,actor.role === 'chief',actor.id]);
    return { handoffs:result.rows.map(row=>({
      id:row.id,batchId:row.batch_id,batchCode:row.batch_code,
      fromStep:row.from_step,toStep:row.to_step,
      fromWorkshopId:row.from_workshop_id,toWorkshopId:row.to_workshop_id,
      quantity:row.quantity,quantityUnit:row.quantity_unit,
      sentBy:row.sent_by,sentAt:row.sent_at,note:row.note,
    })) };
  });

  app.post('/planning/handoffs/:id/receive', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error:'unauthorized' });
    if (!['chief','master'].includes(actor.role)) return reply.code(403).send({ error:'forbidden' });
    const params = batchParam.safeParse(request.params);
    const parsed = receiveSchema.safeParse(request.body ?? {});
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error:'invalid_receipt' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const handoff = await client.query(`SELECT h.id,h.sent_by,h.to_workshop_id,
          r.received_by
        FROM production_stage_handoffs h
        LEFT JOIN production_stage_receipts r ON r.organization_id=h.organization_id
          AND r.handoff_id=h.id
        WHERE h.organization_id=$1 AND h.id=$2 FOR UPDATE OF h`,
        [actor.organization_id,params.data.id]);
      if (!handoff.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error:'handoff_not_found' });
      }
      const h = handoff.rows[0];
      const permitted = actor.role === 'chief' || (await client.query(`SELECT 1 FROM user_workshop_memberships
        WHERE organization_id=$1 AND user_id=$2 AND workshop_id=$3`,
        [actor.organization_id,actor.id,h.to_workshop_id])).rowCount === 1;
      if (!permitted) {
        await client.query('ROLLBACK');
        return reply.code(403).send({ error:'destination_workshop_access_denied' });
      }
      if (h.sent_by === actor.id) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error:'same_actor_cannot_receive' });
      }
      if (h.received_by) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error:'handoff_already_received' });
      }
      await client.query(`INSERT INTO production_stage_receipts
        (organization_id,handoff_id,received_by,note)
        VALUES($1,$2,$3,$4)`,
        [actor.organization_id,params.data.id,actor.id,parsed.data.note ?? null]);
      await client.query('COMMIT');
      return { id:params.data.id,status:'received' };
    } catch (error) {
      await client.query('ROLLBACK');
      if (pgCode(error) === '23505') return reply.code(409).send({ error:'handoff_already_received' });
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/batches/:id/handoffs', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error:'unauthorized' });
    // No batch-level read permission model for masters yet. Use their inbox.
    if (actor.role !== 'chief') return reply.code(403).send({ error:'forbidden' });
    const params = batchParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error:'invalid_batch_id' });
    const batch = await pool.query(`SELECT id FROM production_batches
      WHERE organization_id=$1 AND id=$2`,[actor.organization_id,params.data.id]);
    if (!batch.rowCount) return reply.code(404).send({ error:'batch_not_found' });
    const rows = await pool.query(`SELECT h.id,h.from_step,h.to_step,
        h.from_workshop_id,h.to_workshop_id,h.quantity::text,h.quantity_unit,
        h.sent_by,h.sent_at,h.note,r.received_by,r.received_at,r.note AS receipt_note
      FROM production_stage_handoffs h
      LEFT JOIN production_stage_receipts r ON r.organization_id=h.organization_id
        AND r.handoff_id=h.id
      WHERE h.organization_id=$1 AND h.batch_id=$2
      ORDER BY h.from_step LIMIT 200`,[actor.organization_id,params.data.id]);
    return { batchId:params.data.id,handoffs:rows.rows.map(row=>({
      id:row.id,fromStep:row.from_step,toStep:row.to_step,
      fromWorkshopId:row.from_workshop_id,toWorkshopId:row.to_workshop_id,
      quantity:row.quantity,quantityUnit:row.quantity_unit,
      sentBy:row.sent_by,sentAt:row.sent_at,note:row.note,
      receivedBy:row.received_by,receivedAt:row.received_at,receiptNote:row.receipt_note,
    })) };
  });
}
