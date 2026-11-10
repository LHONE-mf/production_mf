import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const paramsSchema=z.object({
  id:z.string().uuid(),observationId:z.string().uuid(),
}).strict();
const schema=z.object({
  reviewId:z.string().uuid(),
  outcome:z.enum(['follow_up_required','reviewed_no_block']),
  reason:z.string().trim().min(1).max(2000),
}).strict();

/** Sequential append-only triage, not formal quality disposition. */
export function registerInspectionReviewRoutes(app:FastifyInstance,pool:Pool){
  app.post('/planning/batches/:id/inspections/:observationId/reviews',
    async(request,reply)=>{
      const actor=await authenticate(pool,request.headers.authorization);
      if(!actor)return reply.code(401).send({error:'unauthorized'});
      if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
      const params=paramsSchema.safeParse(request.params);
      const input=schema.safeParse(request.body);
      if(!params.success||!input.success)
        return reply.code(400).send({error:'invalid_inspection_review'});
      const {id:batchId,observationId}=params.data;
      const data=input.data;
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const batch=await client.query(`SELECT status FROM production_batches
          WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
          [actor.organization_id,batchId]);
        if(!batch.rowCount){
          await client.query('ROLLBACK');
          return reply.code(404).send({error:'batch_not_found'});
        }
        const observation=await client.query(`SELECT attention_required
          FROM production_inspection_observations
          WHERE organization_id=$1 AND batch_id=$2 AND id=$3`,
          [actor.organization_id,batchId,observationId]);
        if(!observation.rowCount){
          await client.query('ROLLBACK');
          return reply.code(404).send({error:'observation_not_found'});
        }
        if(!observation.rows[0].attention_required){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'observation_review_not_required'});
        }
        const previous=await client.query(`SELECT
          batch_id=$3 AND observation_id=$4 AND outcome=$5
            AND reason=$6 AND reviewed_by=$7 AS identical,
          review_number
          FROM production_inspection_reviews
          WHERE organization_id=$1 AND id=$2`,
          [actor.organization_id,data.reviewId,batchId,observationId,
            data.outcome,data.reason,actor.id]);
        if(previous.rowCount){
          await client.query('ROLLBACK');
          if(!previous.rows[0].identical)
            return reply.code(409).send({error:'inspection_review_id_reused'});
          return {id:data.reviewId,batchId,observationId,
            reviewNumber:previous.rows[0].review_number,alreadyRecorded:true};
        }
        if(!['in_progress','hold'].includes(batch.rows[0].status)){
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'batch_not_open_for_inspection'});
        }
        // The parent batch lock serializes review numbering and completion.
        const last=await client.query(`SELECT COALESCE(max(review_number),0)+1 AS next
          FROM production_inspection_reviews
          WHERE organization_id=$1 AND batch_id=$2 AND observation_id=$3`,
          [actor.organization_id,batchId,observationId]);
        const number=Number(last.rows[0].next);
        await client.query(`INSERT INTO production_inspection_reviews
          (organization_id,id,batch_id,observation_id,review_number,outcome,
           reason,reviewed_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [actor.organization_id,data.reviewId,batchId,observationId,
            number,data.outcome,data.reason,actor.id]);
        await client.query('COMMIT');
        return reply.code(201).send({
          id:data.reviewId,batchId,observationId,reviewNumber:number,
          alreadyRecorded:false,
        });
      }catch(error){
        await client.query('ROLLBACK');
        throw error;
      }finally{client.release();}
    });
}
