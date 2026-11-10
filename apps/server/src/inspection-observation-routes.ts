import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const uuid=z.string().uuid();
const batchParam=z.object({id:uuid}).strict();
const stepParam=z.object({id:uuid,stepNumber:z.coerce.number().int().positive().safe()}).strict();
const characteristic=z.string().trim().min(1).max(120);
const note=z.string().trim().min(1).max(2000);
const measured=z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const units=z.enum(['um','mm','g','mg','mOhm','V','mAh','pct','C']);
const common={observationId:uuid,characteristic,attentionRequired:z.boolean()};
const inputSchema=z.discriminatedUnion('kind',[
  z.object({...common,kind:z.literal('measurement'),
    observedValue:measured,observedUnit:units,note:note.optional()}).strict(),
  z.object({...common,kind:z.literal('visual'),note}).strict(),
]);

function errorCode(error:unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as {code:unknown}).code : null;
}

/** Chief-attested, read-only-after-write inspection observations.
 * Not a QA release and not verified production execution evidence.
 */
export function registerInspectionObservationRoutes(app:FastifyInstance,pool:Pool) {
  app.post('/planning/batches/:id/steps/:stepNumber/inspections',
    async (request,reply)=>{
      const actor=await authenticate(pool,request.headers.authorization);
      if(!actor)return reply.code(401).send({error:'unauthorized'});
      if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
      const params=stepParam.safeParse(request.params);
      const parsed=inputSchema.safeParse(request.body);
      if(!params.success||!parsed.success)
        return reply.code(400).send({error:'invalid_inspection_observation'});
      if(parsed.data.kind==='measurement' &&
          parsed.data.attentionRequired && !parsed.data.note)
        return reply.code(400).send({error:'inspection_note_required'});
      const {id:batchId,stepNumber}=params.data;
      const data=parsed.data;
      const value=data.kind==='measurement'?data.observedValue:null;
      const unit=data.kind==='measurement'?data.observedUnit:null;
      const explanation=data.note??null;
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const batch=await client.query(`SELECT b.order_id,b.status,b.material_line,
            o.route_id,o.route_version
          FROM production_batches b JOIN production_orders o
            ON o.organization_id=b.organization_id AND o.id=b.order_id
          WHERE b.organization_id=$1 AND b.id=$2
          FOR UPDATE OF b`,[actor.organization_id,batchId]);
        if(!batch.rowCount){
          await client.query('ROLLBACK');
          return reply.code(404).send({error:'batch_not_found'});
        }
        const b=batch.rows[0];
        const step=await client.query(`SELECT workshop_id
          FROM process_route_steps
          WHERE organization_id=$1 AND route_id=$2 AND route_version=$3
            AND step_number=$4 AND electrode_line=$5`,
          [actor.organization_id,b.route_id,b.route_version,stepNumber,
            b.material_line==='cell'?'common':b.material_line]);
        if(!step.rowCount){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'step_not_in_batch_route'});
        }
        const workshop=step.rows[0].workshop_id;
        const values=[actor.organization_id,data.observationId,batchId,
          b.order_id,b.route_id,b.route_version,stepNumber,workshop,
          data.kind,data.characteristic,value,unit,data.attentionRequired,
          explanation,actor.id];
        const previous=await client.query(`SELECT
          batch_id=$3 AND order_id=$4 AND route_id=$5 AND route_version=$6
          AND step_number=$7 AND workshop_id=$8 AND kind=$9
          AND characteristic=$10
          AND observed_value IS NOT DISTINCT FROM $11::numeric
          AND observed_unit IS NOT DISTINCT FROM $12::text
          AND attention_required=$13 AND note IS NOT DISTINCT FROM $14::text
          AND recorded_by=$15 AS identical
          FROM production_inspection_observations
          WHERE organization_id=$1 AND id=$2`,values);
        if(previous.rowCount){
          await client.query('ROLLBACK');
          if(!previous.rows[0].identical)
            return reply.code(409).send({error:'inspection_id_reused'});
          return {id:data.observationId,batchId,stepNumber,alreadyRecorded:true};
        }
        // More observations are permitted for a held batch, e.g. to record
        // findings after an operator identified a concern. Never rewrite one.
        if(!['in_progress','hold'].includes(b.status)){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'batch_not_open_for_inspection'});
        }
        await client.query(`INSERT INTO production_inspection_observations
          (organization_id,id,batch_id,order_id,route_id,route_version,
           step_number,workshop_id,kind,characteristic,observed_value,
           observed_unit,attention_required,note,recorded_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,values);
        await client.query('COMMIT');
        return reply.code(201).send({
          id:data.observationId,batchId,stepNumber,alreadyRecorded:false,
        });
      }catch(error){
        await client.query('ROLLBACK');
        if(errorCode(error)==='23505')
          return reply.code(409).send({error:'inspection_id_conflict'});
        throw error;
      }finally{client.release();}
    });

  app.get('/planning/batches/:id/inspections',async(request,reply)=>{
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor)return reply.code(401).send({error:'unauthorized'});
    if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
    const params=batchParam.safeParse(request.params);
    if(!params.success)return reply.code(400).send({error:'invalid_batch_id'});
    const batchId=params.data.id;
    const batch=await pool.query(`SELECT id FROM production_batches
      WHERE organization_id=$1 AND id=$2`,[actor.organization_id,batchId]);
    if(!batch.rowCount)return reply.code(404).send({error:'batch_not_found'});
    const result=await pool.query(`SELECT i.id,i.step_number,i.kind,i.characteristic,
       i.observed_value::text AS value,i.observed_unit,i.attention_required,i.note,
       i.recorded_by,i.recorded_at,
       last_review.review_number,last_review.outcome AS review_outcome,
       last_review.reason AS review_reason,
       last_review.reviewed_by,last_review.reviewed_at,
       COALESCE(review_history.events,'[]'::jsonb) AS review_history,
       criterion.id AS criterion_id,
       criterion.lower_limit::text AS reference_lower,
       criterion.upper_limit::text AS reference_upper,
       CASE
         WHEN i.kind<>'measurement' OR criterion.id IS NULL
           THEN 'no_reference'
         WHEN criterion.lower_limit IS NOT NULL
           AND i.observed_value<criterion.lower_limit THEN 'below_reference'
         WHEN criterion.upper_limit IS NOT NULL
           AND i.observed_value>criterion.upper_limit THEN 'above_reference'
         ELSE 'within_reference'
       END AS reference_comparison
      FROM production_inspection_observations i
      LEFT JOIN LATERAL (
        SELECT review_number,outcome,reason,reviewed_by,reviewed_at
        FROM production_inspection_reviews r
        WHERE r.organization_id=i.organization_id
          AND r.batch_id=i.batch_id AND r.observation_id=i.id
        ORDER BY review_number DESC LIMIT 1
      ) last_review ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'number',r.review_number,'outcome',r.outcome,
          'reason',r.reason,'reviewedBy',r.reviewed_by,
          'reviewedAt',r.reviewed_at
        ) ORDER BY r.review_number) AS events
        FROM production_inspection_reviews r
        WHERE r.organization_id=i.organization_id
          AND r.batch_id=i.batch_id AND r.observation_id=i.id
      ) review_history ON TRUE
      LEFT JOIN LATERAL (
        SELECT c.id,c.lower_limit,c.upper_limit
        FROM production_inspection_criteria c
        WHERE c.organization_id=i.organization_id
          AND c.route_id=i.route_id AND c.route_version=i.route_version
          AND c.step_number=i.step_number
          AND lower(c.characteristic)=lower(i.characteristic)
          AND c.unit=i.observed_unit
        LIMIT 1
      ) criterion ON TRUE
      WHERE i.organization_id=$1 AND i.batch_id=$2
      ORDER BY i.recorded_at,i.id LIMIT 300`,
      [actor.organization_id,batchId]);
    return {batchId,observations:result.rows.map(row=>({
      id:row.id,stepNumber:row.step_number,kind:row.kind,
      characteristic:row.characteristic,observedValue:row.value,
      observedUnit:row.observed_unit,
      attentionRequired:row.attention_required,
      note:row.note,recordedBy:row.recorded_by,recordedAt:row.recorded_at,
      reviewHistory:row.review_history,
      referenceComparison:row.reference_comparison,
      referenceCriterionId:row.criterion_id,
      referenceLowerLimit:row.reference_lower,
      referenceUpperLimit:row.reference_upper,
      latestReview:row.review_number===null ? null : {
        number:row.review_number,outcome:row.review_outcome,
        reason:row.review_reason,reviewedBy:row.reviewed_by,
        reviewedAt:row.reviewed_at,
      },
    }))};
  });
}
