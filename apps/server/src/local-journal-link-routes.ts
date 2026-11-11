import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const uuid = z.guid();
const batchParam = z.object({ id:uuid }).strict();
const stepParam = z.object({ id:uuid,stepNumber:z.coerce.number().int().positive().safe() }).strict();
const withdrawalParams=z.object({id:uuid,linkId:uuid}).strict();
const withdrawalSchema=z.object({withdrawalId:uuid,reason:z.string().trim().min(1).max(2000)}).strict();
const sourceValue = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)
  .refine(value=>Number(value)>0);
const sourceMeasureSchema = z.object({
  kind:z.enum(['dry_solids_kg','coated_side_a_m',
    'calendered_length_m','cut_good_pieces',
    'sort_input_good_pieces','assembled_cells_out']),value:sourceValue,
}).strict();
const bodySchema = z.object({
  linkId:uuid, sourceEntryId:uuid,
  sourceKind:z.enum(['journal','mix_batch','coat_run',
    'calender_run','cut_run','sort_run','assembly_run']).default('journal'),
  sourceMeasure:sourceMeasureSchema.optional(),
  sourceStage:z.enum(['storage','slurry','coating','calendaring','cutting',
    'sorting','assembly','electrolyte','electrolyte-705','walzing','formation']),
  sourceCreatedAt:z.string().datetime({offset:true}),
  summary:z.string().trim().min(1).max(2000),
  defects:z.string().trim().min(1).max(2000).optional(),
  replacesLinkId:uuid.optional(),
  replacementReason:z.string().trim().min(1).max(2000).optional(),
}).strict().superRefine((data,ctx)=>{
  if(Boolean(data.replacesLinkId)!==Boolean(data.replacementReason))
    ctx.addIssue({code:'custom',path:['replacementReason'],message:'replacement identity and reason required together'});
  const sourceStage:Record<string,string> = {
    mix_batch:'slurry',coat_run:'coating',
    calender_run:'calendaring',cut_run:'cutting',
    sort_run:'sorting',assembly_run:'assembly',
  };
  const sourceMetric:Record<string,string> = {
    mix_batch:'dry_solids_kg',coat_run:'coated_side_a_m',
    calender_run:'calendered_length_m',cut_run:'cut_good_pieces',
    sort_run:'sort_input_good_pieces',assembly_run:'assembled_cells_out',
  };
  const stage = sourceStage[data.sourceKind];
  const metric = sourceMetric[data.sourceKind];
  if (stage && data.sourceStage!==stage)
    ctx.addIssue({code:'custom',path:['sourceStage'],message:'source stage mismatch'});
  if (data.sourceMeasure && data.sourceMeasure.kind!==metric)
    ctx.addIssue({code:'custom',path:['sourceMeasure'],message:'source metric mismatch'});
  if (data.sourceMeasure &&
      ['cut_good_pieces','sort_input_good_pieces','assembled_cells_out']
        .includes(data.sourceMeasure.kind) &&
      !/^\d+(?:\.0{1,6})?$/.test(data.sourceMeasure.value))
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
  app.post('/planning/batches/:id/journal-links/:linkId/withdraw',async(request,reply)=>{
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor)return reply.code(401).send({error:'unauthorized'});
    if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
    const params=withdrawalParams.safeParse(request.params);
    const input=withdrawalSchema.safeParse(request.body);
    if(!params.success||!input.success)return reply.code(400).send({error:'invalid_source_withdrawal'});
    const {id:batchId,linkId}=params.data,data=input.data;
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      // Serialize with source additions and other audit corrections. This does
      // not reopen a completed batch or alter its execution/QA history.
      const batch=await client.query(`SELECT id FROM production_batches
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[actor.organization_id,batchId]);
      if(!batch.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'batch_not_found'});}
      const source=await client.query(`SELECT id FROM production_local_journal_links
        WHERE organization_id=$1 AND batch_id=$2 AND id=$3`,[actor.organization_id,batchId,linkId]);
      if(!source.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'journal_link_not_found'});}
      const old=await client.query(`SELECT link_id=$3 AND reason=$4 AND withdrawn_by=$5 AS identical
        FROM production_local_journal_withdrawals WHERE organization_id=$1 AND id=$2`,
        [actor.organization_id,data.withdrawalId,linkId,data.reason,actor.id]);
      if(old.rowCount){
        await client.query('ROLLBACK');
        if(!old.rows[0].identical)return reply.code(409).send({error:'withdrawal_id_reused'});
        return {id:data.withdrawalId,batchId,linkId,alreadyRecorded:true};
      }
      const withdrawn=await client.query(`SELECT id FROM production_local_journal_withdrawals
        WHERE organization_id=$1 AND link_id=$2`,[actor.organization_id,linkId]);
      if(withdrawn.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'local_source_already_withdrawn'});}
      await client.query(`INSERT INTO production_local_journal_withdrawals
        (organization_id,id,link_id,reason,withdrawn_by) VALUES($1,$2,$3,$4,$5)`,
        [actor.organization_id,data.withdrawalId,linkId,data.reason,actor.id]);
      await client.query('COMMIT');
      return reply.code(201).send({id:data.withdrawalId,batchId,linkId,alreadyRecorded:false});
    }catch(error){
      await client.query('ROLLBACK');
      if(sqlCode(error)==='23505')return reply.code(409).send({error:'withdrawal_id_reused'});
      throw error;
    }finally{client.release();}
  });
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
          AND source_measure_value IS NOT DISTINCT FROM $17::numeric
          AND rp.original_link_id IS NOT DISTINCT FROM $18::uuid
          AND rp.reason IS NOT DISTINCT FROM $19::text AS identical
        FROM production_local_journal_links l
        LEFT JOIN production_local_journal_replacements rp
          ON rp.organization_id=l.organization_id AND rp.replacement_link_id=l.id
        WHERE l.organization_id=$1 AND l.id=$2`,
        [actor.organization_id,data.linkId,batchId,b.order_id,b.route_id,
          b.route_version,stepNumber,step.rows[0].workshop_id,
          data.sourceStage,data.sourceEntryId,data.sourceCreatedAt,
          data.summary,data.defects ?? null,actor.id,data.sourceKind,
          data.sourceMeasure?.kind ?? null,data.sourceMeasure?.value ?? null,
          data.replacesLinkId ?? null,data.replacementReason ?? null]);
      if (old.rowCount) {
        await client.query('ROLLBACK');
        if (!old.rows[0].identical) return reply.code(409).send({error:'journal_link_id_reused'});
        return {id:data.linkId,batchId,stepNumber,alreadyLinked:true};
      }
      if (b.status !== 'in_progress') {
        await client.query('ROLLBACK');
        return reply.code(409).send({error:'batch_not_active'});
      }
      if(data.replacesLinkId){
        const original=await client.query(`SELECT l.id,r.replacement_link_id
          FROM production_local_journal_links l
          JOIN production_local_journal_withdrawals w ON w.organization_id=l.organization_id AND w.link_id=l.id
          LEFT JOIN production_local_journal_replacements r ON r.organization_id=l.organization_id AND r.original_link_id=l.id
          WHERE l.organization_id=$1 AND l.id=$2 AND l.batch_id=$3
            AND l.route_id=$4 AND l.route_version=$5 AND l.step_number=$6
            AND l.source_kind=$7 AND l.source_stage=$8`,
          [actor.organization_id,data.replacesLinkId,batchId,b.route_id,b.route_version,stepNumber,data.sourceKind,data.sourceStage]);
        if(!original.rowCount||original.rows[0].replacement_link_id){
          await client.query('ROLLBACK');return reply.code(409).send({error:'source_not_replaceable'});
        }
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
      if(data.replacesLinkId)await client.query(`INSERT INTO production_local_journal_replacements
        (organization_id,original_link_id,replacement_link_id,reason,recorded_by) VALUES($1,$2,$3,$4,$5)`,
        [actor.organization_id,data.replacesLinkId,data.linkId,data.replacementReason,actor.id]);
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
    const entries = await pool.query(`SELECT l.id,step_number,source_stage,source_entry_id,
        source_created_at,summary,defects,linked_by,linked_at,
        source_kind,source_measure_kind,source_measure_value::text,
        w.id AS withdrawal_id,w.reason,w.withdrawn_by,w.withdrawn_at,
        rp.original_link_id,rp.reason AS replacement_reason,rp.recorded_by,rp.recorded_at,
        next.replacement_link_id AS replaced_by
      FROM production_local_journal_links l
      LEFT JOIN production_local_journal_withdrawals w ON w.organization_id=l.organization_id AND w.link_id=l.id
      LEFT JOIN production_local_journal_replacements rp ON rp.organization_id=l.organization_id AND rp.replacement_link_id=l.id
      LEFT JOIN production_local_journal_replacements next ON next.organization_id=l.organization_id AND next.original_link_id=l.id
      WHERE l.organization_id=$1 AND l.batch_id=$2
      ORDER BY step_number,linked_at,l.id LIMIT 200`,
      [actor.organization_id,params.data.id]);
    return {batchId:params.data.id,links:entries.rows.map(row=>({
      id:row.id,stepNumber:row.step_number,sourceStage:row.source_stage,
      sourceKind:row.source_kind,
      sourceMeasure:row.source_measure_kind
        ? {kind:row.source_measure_kind,value:row.source_measure_value} : null,
      sourceEntryId:row.source_entry_id,
      sourceCreatedAt:row.source_created_at,summary:row.summary,
      defects:row.defects,linkedBy:row.linked_by,linkedAt:row.linked_at,
      withdrawal:row.withdrawal_id ? {id:row.withdrawal_id,reason:row.reason,
        withdrawnBy:row.withdrawn_by,withdrawnAt:row.withdrawn_at} : null,
      replacementOf:row.original_link_id ? {linkId:row.original_link_id,reason:row.replacement_reason,
        recordedBy:row.recorded_by,recordedAt:row.recorded_at} : null,
      replacedBy:row.replaced_by ?? null,
    }))};
  });
}
