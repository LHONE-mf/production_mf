import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const uuid = z.string().uuid();
const batchParam = z.object({ id:uuid }).strict();
const stepParam = z.object({ id:uuid,stepNumber:z.coerce.number().int().positive().safe() }).strict();
const sourceValue = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
  .refine(value=>Number(value)>0);
const sourceMeasureSchema = z.object({
  kind:z.enum(['dry_solids_kg','coated_side_a_m',
    'calendered_length_m','cut_good_pieces']),value:sourceValue,
}).strict();
const bodySchema = z.object({
  linkId:uuid, sourceEntryId:uuid,
  sourceKind:z.enum(['journal','mix_batch','coat_run',
    'calender_run','cut_run']).default('journal'),
  sourceMeasure:sourceMeasureSchema.optional(),
  sourceStage:z.enum(['storage','slurry','coating','calendaring','cutting',
    'sorting','assembly','electrolyte','electrolyte-705','walzing','formation']),
  sourceCreatedAt:z.string().datetime({offset:true}),
  summary:z.string().trim().min(1).max(2000),
  defects:z.string().trim().min(1).max(2000).optional(),
}).strict().superRefine((data,ctx)=>{
  const sourceStage:Record<string,string> = {
    mix_batch:'slurry',coat_run:'coating',
    calender_run:'calendaring',cut_run:'cutting',
  };
  const sourceMetric:Record<string,string> = {
    mix_batch:'dry_solids_kg',coat_run:'coated_side_a_m',
    calender_run:'calendered_length_m',cut_run:'cut_good_pieces',
  };
  const stage = sourceStage[data.sourceKind];
  const metric = sourceMetric[data.sourceKind];
  if (stage && data.sourceStage!==stage)
    ctx.addIssue({code:'custom',path:['sourceStage'],message:'source stage mismatch'});
  if (data.sourceMeasure && data.sourceMeasure.kind!==metric)
    ctx.addIssue({code:'custom',path:['sourceMeasure'],message:'source metric mismatch'});
  if (data.sourceMeasure?.kind==='cut_good_pieces' &&
      !/^\d+$/.test(data.sourceMeasure.value))
    ctx.addIssue({code:'custom',path:['sourceMeasure'],message:'count must be an integer'});
});

function sqlCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code:unknown }).code : null;
}

/** A manually attested pointer to an existing offline journal entry.
 *  NOT validated execution evidence, not a source of truth for output quantity.
 *  The chief intentionally sends selected content from local device storage.
 */
export function registerLocalJournalLinkRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/planning/batches/:id/steps/:stepNumber/journal-links', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({error:'unauthorized'});
    if (actor.role !== 'chief') return reply.code(403).send({error:'forbidden'});
    const params = stepParam.safeParse(request.params);
    const input = bodySchema.safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({error:'invalid_local_journal_link'});
    const { id:batchId,stepNumber } = params.data;
    const data = input.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const record = await client.query(`SELECT b.id,b.order_id,b.status,b.material_line,
          o.route_id,o.route_version
        FROM production_batches b
        JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
        WHERE b.organization_id=$1 AND b.id=$2 FOR UPDATE OF b`,
        [actor.organization_id,batchId]);
      if (!record.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({error:'batch_not_found'});
      }
      const b = record.rows[0];
      const step = await client.query(`SELECT workshop_id,stage FROM process_route_steps
        WHERE organization_id=$1 AND route_id=$2 AND route_version=$3
          AND step_number=$4 AND electrode_line=$5`,
        [actor.organization_id,b.route_id,b.route_version,stepNumber,
          b.material_line === 'cell' ? 'common' : b.material_line]);
      if (!step.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(409).send({error:'step_not_in_batch_route'});
      }
      if (step.rows[0].stage !== data.sourceStage) {
        await client.query('ROLLBACK');
        return reply.code(409).send({error:'journal_stage_mismatch'});
      }
      // Idempotent retry is accepted even after a batch status transition,
      // but a UUID cannot silently be reassigned to different content.
      const old = await client.query(`SELECT
          batch_id=$3 AND order_id=$4 AND route_id=$5 AND route_version=$6
          AND step_number=$7 AND workshop_id=$8 AND source_stage=$9
          AND source_entry_id=$10 AND source_created_at=$11::timestamptz
          AND summary=$12 AND defects IS NOT DISTINCT FROM $13::text
          AND linked_by=$14 AND source_kind=$15
          AND source_measure_kind IS NOT DISTINCT FROM $16::text
          AND source_measure_value IS NOT DISTINCT FROM $17::numeric AS identical
        FROM production_local_journal_links
        WHERE organization_id=$1 AND id=$2`,
        [actor.organization_id,data.linkId,batchId,b.order_id,b.route_id,
          b.route_version,stepNumber,step.rows[0].workshop_id,
          data.sourceStage,data.sourceEntryId,data.sourceCreatedAt,
          data.summary,data.defects ?? null,actor.id,data.sourceKind,
          data.sourceMeasure?.kind ?? null,data.sourceMeasure?.value ?? null]);
      if (old.rowCount) {
        await client.query('ROLLBACK');
        if (!old.rows[0].identical) return reply.code(409).send({error:'journal_link_id_reused'});
        return {id:data.linkId,batchId,stepNumber,alreadyLinked:true};
      }
      if (b.status !== 'in_progress') {
        await client.query('ROLLBACK');
        return reply.code(409).send({error:'batch_not_active'});
      }
      await client.query(`INSERT INTO production_local_journal_links
        (organization_id,id,batch_id,order_id,route_id,route_version,step_number,
          workshop_id,source_stage,source_entry_id,source_created_at,
          summary,defects,linked_by,source_kind,
          source_measure_kind,source_measure_value)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [actor.organization_id,data.linkId,batchId,b.order_id,b.route_id,
          b.route_version,stepNumber,step.rows[0].workshop_id,
          data.sourceStage,data.sourceEntryId,data.sourceCreatedAt,
          data.summary,data.defects ?? null,actor.id,data.sourceKind,
          data.sourceMeasure?.kind ?? null,data.sourceMeasure?.value ?? null]);
      await client.query('COMMIT');
      return reply.code(201).send({id:data.linkId,batchId,stepNumber,alreadyLinked:false});
    } catch (error) {
      await client.query('ROLLBACK');
      if (sqlCode(error) === '23505')
        return reply.code(409).send({error:'local_source_already_linked'});
      throw error;
    } finally { client.release(); }
  });

  app.get('/planning/batches/:id/journal-links', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({error:'unauthorized'});
    if (actor.role !== 'chief') return reply.code(403).send({error:'forbidden'});
    const params = batchParam.safeParse(request.params);
    if (!params.success) return reply.code(400).send({error:'invalid_batch_id'});
    const batch = await pool.query(`SELECT id FROM production_batches
      WHERE organization_id=$1 AND id=$2`,[actor.organization_id,params.data.id]);
    if (!batch.rowCount) return reply.code(404).send({error:'batch_not_found'});
    const entries = await pool.query(`SELECT id,step_number,source_stage,source_entry_id,
        source_created_at,summary,defects,linked_by,linked_at,
        source_kind,source_measure_kind,source_measure_value::text
      FROM production_local_journal_links
      WHERE organization_id=$1 AND batch_id=$2
      ORDER BY step_number,linked_at,id LIMIT 200`,
      [actor.organization_id,params.data.id]);
    return {batchId:params.data.id,links:entries.rows.map(row=>({
      id:row.id,stepNumber:row.step_number,sourceStage:row.source_stage,
      sourceKind:row.source_kind,
      sourceMeasure:row.source_measure_kind
        ? {kind:row.source_measure_kind,value:row.source_measure_value} : null,
      sourceEntryId:row.source_entry_id,
      sourceCreatedAt:row.source_created_at,summary:row.summary,
      defects:row.defects,linkedBy:row.linked_by,linkedAt:row.linked_at,
    }))};
  });
}
