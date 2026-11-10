import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const uuid=z.guid(),positive=z.coerce.number().int().positive().safe();
const routeParam=z.object({id:uuid,version:positive}).strict();
const stepParam=routeParam.extend({stepNumber:positive}).strict();
const batchParam=z.object({id:uuid}).strict();
const decimal=z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const payload=z.object({
  criterionId:uuid,characteristic:z.string().trim().min(1).max(120),
  unit:z.enum(['um','mm','g','mg','mOhm','V','mAh','pct','C']),
  lowerLimit:decimal.optional(),upperLimit:decimal.optional(),
  note:z.string().trim().min(1).max(2000).optional(),
}).strict().superRefine((v,ctx)=>{
  if(v.lowerLimit===undefined&&v.upperLimit===undefined)
    ctx.addIssue({code:'custom',message:'a limit is required',path:['lowerLimit']});
  if(v.lowerLimit!==undefined&&v.upperLimit!==undefined&&
    Number(v.lowerLimit)>Number(v.upperLimit))
    ctx.addIssue({code:'custom',message:'inverted limits',path:['upperLimit']});
});
function pgCode(e:unknown) {
  return e && typeof e==='object' && 'code' in e
    ? (e as {code:unknown}).code : null;
}
function mapRow(r:Record<string,unknown>) {
  return {id:r.id,stepNumber:r.step_number,characteristic:r.characteristic,
    unit:r.unit,lowerLimit:r.lower_limit,upperLimit:r.upper_limit,
    note:r.note,createdBy:r.created_by,createdAt:r.created_at};
}
const columns=String.raw`id,step_number,characteristic,unit,
  lower_limit::text,upper_limit::text,note,created_by,created_at`;

/** Planning references only: no automatic conformance, yield or QA release. */
export function registerInspectionCriteriaRoutes(app:FastifyInstance,pool:Pool) {
  app.post('/planning/routes/:id/versions/:version/steps/:stepNumber/inspection-criteria',
    async(request,reply)=>{
      const actor=await authenticate(pool,request.headers.authorization);
      if(!actor)return reply.code(401).send({error:'unauthorized'});
      if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
      const params=stepParam.safeParse(request.params),input=payload.safeParse(request.body);
      if(!params.success||!input.success)
        return reply.code(400).send({error:'invalid_inspection_criterion'});
      const {id:routeId,version,stepNumber}=params.data,d=input.data;
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock the route version: approval, criteria creation, and order FK
        // references are serialized against this version.
        const v=await client.query(String.raw`SELECT state FROM process_route_versions
          WHERE organization_id=$1 AND route_id=$2 AND version=$3 FOR UPDATE`,
          [actor.organization_id,routeId,version]);
        if(!v.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(404).send({error:'route_version_not_found'});
        }
        const step=await client.query(String.raw`SELECT 1 FROM process_route_steps
          WHERE organization_id=$1 AND route_id=$2 AND route_version=$3
            AND step_number=$4`,
          [actor.organization_id,routeId,version,stepNumber]);
        if(!step.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'criterion_step_not_found'});
        }
        const vals=[actor.organization_id,d.criterionId,routeId,version,stepNumber,
          d.characteristic,d.unit,d.lowerLimit??null,d.upperLimit??null,
          d.note??null,actor.id];
        const prior=await client.query(String.raw`SELECT route_id=$3 AND route_version=$4 AND step_number=$5
          AND characteristic=$6 AND unit=$7
          AND lower_limit IS NOT DISTINCT FROM $8::numeric
          AND upper_limit IS NOT DISTINCT FROM $9::numeric
          AND note IS NOT DISTINCT FROM $10::text
          AND created_by=$11 AS identical
          FROM production_inspection_criteria WHERE organization_id=$1 AND id=$2`,vals);
        if(prior.rowCount) {
          await client.query('ROLLBACK');
          if(!prior.rows[0].identical)
            return reply.code(409).send({error:'inspection_criterion_id_reused'});
          return {id:d.criterionId,alreadyRecorded:true};
        }
        if(v.rows[0].state!=='approved') {
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'criterion_route_not_approved'});
        }
        const used=await client.query(String.raw`SELECT 1 FROM production_orders
          WHERE organization_id=$1 AND route_id=$2 AND route_version=$3 LIMIT 1`,
          [actor.organization_id,routeId,version]);
        if(used.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(409).send({error:'inspection_criteria_frozen'});
        }
        await client.query(String.raw`INSERT INTO production_inspection_criteria
          (organization_id,id,route_id,route_version,step_number,
            characteristic,unit,lower_limit,upper_limit,note,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,vals);
        await client.query('COMMIT');
        return reply.code(201).send({id:d.criterionId,alreadyRecorded:false});
      }catch(error) {
        await client.query('ROLLBACK');
        if(pgCode(error)==='23505')
          return reply.code(409).send({error:'inspection_criterion_already_defined'});
        throw error;
      }finally{client.release();}
    });

  app.get('/planning/routes/:id/versions/:version/inspection-criteria',
    async(request,reply)=>{
      const actor=await authenticate(pool,request.headers.authorization);
      if(!actor)return reply.code(401).send({error:'unauthorized'});
      if(!['chief','technologist'].includes(actor.role))
        return reply.code(403).send({error:'forbidden'});
      const params=routeParam.safeParse(request.params);
      if(!params.success)return reply.code(400).send({error:'invalid_route_version'});
      const {id:routeId,version}=params.data;
      const v=await pool.query(String.raw`SELECT v.state,
        EXISTS(SELECT 1 FROM production_orders o
          WHERE o.organization_id=v.organization_id
          AND o.route_id=v.route_id AND o.route_version=v.version) AS frozen
        FROM process_route_versions v
        WHERE v.organization_id=$1 AND v.route_id=$2 AND v.version=$3`,
        [actor.organization_id,routeId,version]);
      if(!v.rowCount)return reply.code(404).send({error:'route_version_not_found'});
      const result=await pool.query(String.raw`SELECT ${columns}
        FROM production_inspection_criteria
        WHERE organization_id=$1 AND route_id=$2 AND route_version=$3
        ORDER BY step_number,characteristic,id LIMIT 500`,
        [actor.organization_id,routeId,version]);
      return {routeId,version,state:v.rows[0].state,
        frozen:v.rows[0].frozen,criteria:result.rows.map(mapRow)};
    });

  app.get('/planning/batches/:id/inspection-criteria',async(request,reply)=>{
    const actor=await authenticate(pool,request.headers.authorization);
    if(!actor)return reply.code(401).send({error:'unauthorized'});
    if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
    const params=batchParam.safeParse(request.params);
    if(!params.success)return reply.code(400).send({error:'invalid_batch_id'});
    const batchId=params.data.id;
    const batch=await pool.query(String.raw`SELECT b.material_line,o.route_id,o.route_version
      FROM production_batches b JOIN production_orders o
        ON o.organization_id=b.organization_id AND o.id=b.order_id
      WHERE b.organization_id=$1 AND b.id=$2`,[actor.organization_id,batchId]);
    if(!batch.rowCount)return reply.code(404).send({error:'batch_not_found'});
    const b=batch.rows[0],line=b.material_line==='cell'?'common':b.material_line;
    const result=await pool.query(String.raw`SELECT c.id,c.step_number,c.characteristic,c.unit,
      c.lower_limit::text,c.upper_limit::text,c.note,c.created_by,c.created_at
      FROM production_inspection_criteria c
      JOIN process_route_steps s ON s.organization_id=c.organization_id
        AND s.route_id=c.route_id AND s.route_version=c.route_version
        AND s.step_number=c.step_number
      WHERE c.organization_id=$1 AND c.route_id=$2 AND c.route_version=$3
        AND s.electrode_line=$4
      ORDER BY c.step_number,c.characteristic,c.id LIMIT 500`,
      [actor.organization_id,b.route_id,b.route_version,line]);
    return {batchId,criteria:result.rows.map(mapRow)};
  });
}
