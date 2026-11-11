import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { hasWholeCount } from './quantities.js';

const uuid = z.guid();
const paramsSchema = z.object({
  id: uuid,
  stepNumber: z.coerce.number().int().positive().safe(),
}).strict();
const batchParam = z.object({ id: uuid }).strict();
const qty = z.string().regex(/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/);
const equipmentCode = z.string().trim().min(1).max(120).optional();
const note = z.string().trim().min(1).max(2000).optional();
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ eventId: uuid, kind: z.literal('started'), equipmentCode, note }).strict(),
  z.object({ eventId: uuid, kind: z.literal('completed'), quantity: qty,
    quantityUnit: z.enum(['cells','pieces','kg','m','m2']), equipmentCode, note }).strict(),
  z.object({ eventId: uuid, kind: z.literal('deviation'), equipmentCode,
    note: z.string().trim().min(1).max(2000) }).strict(),
]);
type EvidenceKind = z.infer<typeof inputSchema>['kind'];
function pgCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code: unknown }).code : null;
}

/**
 * Additive route-step evidence only. It never drives production equipment,
 * mutates task outboxes, completes batches, or posts material consumption.
 * Chief-only until workshop actor/operation permissions are implemented.
 */
export function registerStepEvidenceRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/planning/batches/:id/steps/:stepNumber/evidence', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error:'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error:'forbidden' });
    const params = paramsSchema.safeParse(request.params);
    const parsed = inputSchema.safeParse(request.body);
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error:'invalid_step_evidence' });
    const { id:batchId, stepNumber } = params.data;
    const data = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query(`SELECT b.id,b.order_id,b.status,b.material_line,
          o.route_id,o.route_version,o.status AS order_status
        FROM production_batches b
        JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
        WHERE b.organization_id=$1 AND b.id=$2
        FOR UPDATE OF b`, [actor.organization_id,batchId]);
      if (!batch.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error:'batch_not_found' });
      }
      const b = batch.rows[0];
      const line = b.material_line === 'cell' ? 'common' : b.material_line;
      const stepResult = await client.query(`SELECT step_number,workshop_id,name
        FROM process_route_steps
        WHERE organization_id=$1 AND route_id=$2 AND route_version=$3
          AND electrode_line=$4
        ORDER BY step_number`,
        [actor.organization_id,b.route_id,b.route_version,line]);
      const steps = stepResult.rows as Array<{
        step_number: number; workshop_id: string; name: string;
      }>;
      const index = steps.findIndex(step => step.step_number === stepNumber);
      if (index < 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error:'step_not_in_batch_route' });
      }
      const workshopId = steps[index].workshop_id;
      const existing = await client.query(`SELECT
          batch_id=$3 AND order_id=$4 AND route_id=$5 AND route_version=$6
            AND step_number=$7 AND workshop_id=$8 AND kind=$9
            AND actor_id=$10 AND quantity IS NOT DISTINCT FROM $11::numeric
            AND quantity_unit IS NOT DISTINCT FROM $12::text
            AND equipment_code IS NOT DISTINCT FROM $13::text
            AND note IS NOT DISTINCT FROM $14::text AS identical
        FROM production_step_evidence WHERE organization_id=$1 AND id=$2`,
        [actor.organization_id,data.eventId,batchId,b.order_id,b.route_id,
          b.route_version,stepNumber,workshopId,data.kind,actor.id,
          data.kind === 'completed' ? data.quantity : null,
          data.kind === 'completed' ? data.quantityUnit : null,
          data.equipmentCode ?? null,data.note ?? null]);
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        if (!existing.rows[0].identical)
          return reply.code(409).send({ error:'step_evidence_id_reused' });
        return { id:data.eventId,batchId,stepNumber,kind:data.kind,alreadyRecorded:true };
      }
      // Existing immutable declarations retain exact retry semantics. Validate
      // only a new write; never round or rewrite a historical fractional count.
      if (data.kind==='completed' && !hasWholeCount(data.quantity,data.quantityUnit)) {
        await client.query('ROLLBACK');
        return reply.code(400).send({error:'quantity_requires_whole_count'});
      }
      if (b.status !== 'in_progress' || !['released','in_progress'].includes(b.order_status)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error:'batch_not_active' });
      }
      const previous = await client.query(`SELECT kind FROM production_step_evidence
        WHERE organization_id=$1 AND batch_id=$2 AND step_number=$3
          AND kind IN ('started','completed')`,
        [actor.organization_id,batchId,stepNumber]);
      const started = previous.rows.some(row => row.kind === 'started');
      const finished = previous.rows.some(row => row.kind === 'completed');
      if (data.kind === 'started') {
        if (started) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error:'step_already_started' });
        }
        if (index > 0) {
          const priorNumber = steps[index-1].step_number;
          const prior = await client.query(`SELECT
              EXISTS(SELECT 1 FROM production_step_evidence e
                WHERE e.organization_id=$1 AND e.batch_id=$2
                  AND e.step_number=$3 AND e.kind='completed') AS finished,
              EXISTS(SELECT 1 FROM production_stage_handoffs h
                JOIN production_stage_receipts r ON r.organization_id=h.organization_id
                  AND r.handoff_id=h.id
                WHERE h.organization_id=$1 AND h.batch_id=$2
                  AND h.from_step=$3 AND h.to_step=$4) AS received`,
            [actor.organization_id,batchId,priorNumber,stepNumber]);
          if (!prior.rows[0].finished || !prior.rows[0].received) {
            await client.query('ROLLBACK');
            return reply.code(409).send({ error:'previous_step_not_complete_or_received' });
          }
        }
      } else if (!started || finished) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error:'step_not_open' });
      }
      await client.query(`INSERT INTO production_step_evidence
        (organization_id,id,batch_id,order_id,route_id,route_version,step_number,
          workshop_id,kind,actor_id,quantity,quantity_unit,equipment_code,note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [actor.organization_id,data.eventId,batchId,b.order_id,b.route_id,
          b.route_version,stepNumber,workshopId,data.kind,actor.id,
          data.kind === 'completed' ? data.quantity : null,
          data.kind === 'completed' ? data.quantityUnit : null,
          data.equipmentCode ?? null,data.note ?? null]);
      await client.query('COMMIT');
      return reply.code(201).send({ id:data.eventId,batchId,stepNumber,
        kind:data.kind,alreadyRecorded:false });
    } catch (error) {
      await client.query('ROLLBACK');
      if (pgCode(error) === '23505') return reply.code(409).send({ error:'step_evidence_already_exists' });
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/batches/:id/steps', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error:'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error:'forbidden' });
    const params = batchParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error:'invalid_batch_id' });
    const batch = await pool.query(`SELECT b.id,b.material_line,o.route_id,o.route_version
      FROM production_batches b JOIN production_orders o
        ON o.organization_id=b.organization_id AND o.id=b.order_id
      WHERE b.organization_id=$1 AND b.id=$2`,[actor.organization_id,params.data.id]);
    if (!batch.rowCount) return reply.code(404).send({ error:'batch_not_found' });
    const b = batch.rows[0];
    const rows = await pool.query(`SELECT s.step_number,s.name,s.stage,s.workshop_id,
        e.id AS evidence_id,e.kind,e.actor_id,e.quantity::text,e.quantity_unit,
        e.equipment_code,e.note,e.recorded_at
      FROM process_route_steps s LEFT JOIN production_step_evidence e
        ON e.organization_id=s.organization_id AND e.route_id=s.route_id
          AND e.route_version=s.route_version AND e.step_number=s.step_number
          AND e.batch_id=$4
      WHERE s.organization_id=$1 AND s.route_id=$2 AND s.route_version=$3
        AND s.electrode_line=$5
      ORDER BY s.step_number,e.recorded_at,e.id LIMIT 500`,
      [actor.organization_id,b.route_id,b.route_version,params.data.id,
        b.material_line === 'cell' ? 'common' : b.material_line]);
    return { batchId:params.data.id, steps:rows.rows.map(row=>({
      number:row.step_number,name:row.name,stage:row.stage,
      workshopId:row.workshop_id,
      evidence:row.evidence_id ? {
        id:row.evidence_id,kind:row.kind,actorId:row.actor_id,
        quantity:row.quantity,quantityUnit:row.quantity_unit,
        equipmentCode:row.equipment_code,note:row.note,recordedAt:row.recorded_at,
      } : null,
    })) };
  });

  // Read-only visibility into declared output and documented interstage
  // quantities. A difference is NOT proven waste, yield, or inventory.
  app.get('/planning/batches/:id/quantity-flow', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error:'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error:'forbidden' });
    const params = batchParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error:'invalid_batch_id' });
    const batchId = params.data.id;
    const batch = await pool.query(`SELECT b.material_line,o.route_id,o.route_version
      FROM production_batches b
      JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
      WHERE b.organization_id=$1 AND b.id=$2`, [actor.organization_id,batchId]);
    if (!batch.rowCount) return reply.code(404).send({ error:'batch_not_found' });
    const b = batch.rows[0];
    const rows = await pool.query(`
      WITH branch_steps AS (
        SELECT step_number,name,workshop_id,
          LEAD(step_number) OVER (ORDER BY step_number) AS next_step
        FROM process_route_steps
        WHERE organization_id=$1 AND route_id=$2 AND route_version=$3
          AND electrode_line=$5
      ), measured_sources AS (
        SELECT step_number,count(*)::int AS source_count,
          min(id::text) AS source_link_id,min(source_entry_id::text) AS source_entry_id,
          min(summary) AS source_summary,min(source_measure_kind) AS source_metric,
          min(source_measure_value) AS source_quantity
        FROM production_local_journal_links
        WHERE organization_id=$1 AND batch_id=$4 AND route_id=$2 AND route_version=$3
          AND source_measure_kind IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM production_local_journal_withdrawals w
            WHERE w.organization_id=production_local_journal_links.organization_id
              AND w.link_id=production_local_journal_links.id)
        GROUP BY step_number
      ), withdrawn_sources AS (
        SELECT l.step_number,count(*)::int AS withdrawn_count
        FROM production_local_journal_links l
        JOIN production_local_journal_withdrawals w ON w.organization_id=l.organization_id AND w.link_id=l.id
        WHERE l.organization_id=$1 AND l.batch_id=$4 AND l.source_measure_kind IS NOT NULL
        GROUP BY l.step_number
      ), source_values AS (
        SELECT measured_sources.*,
          CASE source_metric WHEN 'calendered_length_m' THEN 'm'
            WHEN 'cut_good_pieces' THEN 'pieces'
            WHEN 'assembled_cells_out' THEN 'cells' ELSE NULL END AS comparison_unit
        FROM measured_sources
      )
      SELECT s.step_number,s.name,s.workshop_id,s.next_step,
        e.quantity::text AS output_quantity,e.quantity_unit AS output_unit,
        h.id AS handoff_id,h.quantity::text AS handoff_quantity,
        h.quantity_unit AS handoff_unit,
        (r.handoff_id IS NOT NULL) AS received,
        CASE WHEN e.quantity_unit=h.quantity_unit
          THEN (e.quantity-h.quantity)::text ELSE NULL END AS quantity_difference,
        COALESCE(l.source_count,0) AS source_count,COALESCE(w.withdrawn_count,0) AS withdrawn_count,
        l.source_link_id,l.source_entry_id,
        l.source_summary,l.source_metric,l.source_quantity::text,l.comparison_unit,
        CASE WHEN l.source_count=1 AND e.quantity_unit=l.comparison_unit
          THEN (e.quantity-l.source_quantity)::text ELSE NULL END AS source_difference
      FROM branch_steps s
      LEFT JOIN production_step_evidence e
        ON e.organization_id=$1 AND e.batch_id=$4 AND e.step_number=s.step_number
          AND e.kind='completed'
      LEFT JOIN production_stage_handoffs h
        ON h.organization_id=$1 AND h.batch_id=$4
          AND h.from_step=s.step_number AND h.to_step=s.next_step
      LEFT JOIN production_stage_receipts r
        ON r.organization_id=h.organization_id AND r.handoff_id=h.id
      LEFT JOIN source_values l ON l.step_number=s.step_number
      LEFT JOIN withdrawn_sources w ON w.step_number=s.step_number
      ORDER BY s.step_number`,
      [actor.organization_id,b.route_id,b.route_version,batchId,
        b.material_line === 'cell' ? 'common' : b.material_line]);
    return { batchId, steps:rows.rows.map(row=>({
      number:row.step_number,name:row.name,workshopId:row.workshop_id,
      nextStep:row.next_step,
      output:row.output_quantity === null ? null : {
        quantity:row.output_quantity,unit:row.output_unit,
      },
      handoff:row.handoff_id === null ? null : {
        id:row.handoff_id,quantity:row.handoff_quantity,
        unit:row.handoff_unit,received:row.received,
      },
      // Null when no transfer is documented or units are incomparable.
      difference:row.quantity_difference,
      // Compare only a single output-compatible measurement. Input/partial
      // metrics are not equivalent to output; multiple sources may overlap.
      // Never invent a sum, conversion, yield or independent verification.
      sourceComparison:{
        status:row.source_count===0 ? 'no_source' : row.source_count>1 ? 'multiple_sources'
          : row.comparison_unit===null ? 'reference_only'
          : row.output_quantity===null ? 'output_missing'
          : row.comparison_unit!==row.output_unit ? 'unit_mismatch' : 'compared',
        sourceCount:row.source_count,
        withdrawnSourceCount:row.withdrawn_count,
        source:row.source_count===1 ? {
          linkId:row.source_link_id,sourceEntryId:row.source_entry_id,
          summary:row.source_summary,
          measure:{kind:row.source_metric,value:row.source_quantity},
        } : null,
        difference:row.source_difference,
      },
    })) };
  });
}
