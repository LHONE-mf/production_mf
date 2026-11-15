import type{FastifyInstance}from'fastify';import type{Pool}from'pg';import{z}from'zod';
import{authenticate}from'./auth.js';import{deviceProofError}from'./sync-routes.js';
import{inventoryStream,currentInventoryWriter}from'./inventory-stream.js';
const digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().trim().min(1).max(2000);
const requestSchema=z.object({approvalId:z.guid(),deviceId:z.guid(),targetActorId:z.guid(),targetDeviceId:z.guid(),epoch:z.guid(),evidenceDigest:digest,reason:text,evidence:text}).strict();
function view(row:Record<string,unknown>){return{approvalId:row.id,organizationId:row.organization_id,epoch:row.epoch,targetActorId:row.target_actor_id,targetDeviceId:row.target_device_id,approvedBy:row.approved_by,approvalDeviceId:row.approval_device_id,evidenceDigest:row.evidence_digest,reason:row.reason,evidence:row.evidence,approvedAt:(row.recorded_at as Date).toISOString()};}
export function registerInventoryRecoveryRoutes(app:FastifyInstance,pool:Pool){
 app.post('/inventory/recovery-approvals',async(request,reply)=>{
  const actor=await authenticate(pool,request.headers.authorization);if(!actor)return reply.code(401).send({error:'unauthorized'});if(actor.role!=='chief')return reply.code(403).send({error:'forbidden'});
  const parsed=requestSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'invalid_recovery_approval'});const data=parsed.data;
  if(await deviceProofError(pool,actor,request.headers.authorization!,data.deviceId,request.headers['x-device-proof']))return reply.code(403).send({error:'device_proof_invalid'});
  const client=await pool.connect();try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.organization_id+':inventory-sequence']);
   const current=await currentInventoryWriter(client,actor.organization_id,actor.id,data.deviceId,request.headers.authorization!,request.headers['x-device-proof'],'manager');
   if(current?.role!=='chief'){await client.query('ROLLBACK');return reply.code(403).send({error:'forbidden'});}
   const stream=await inventoryStream(client,actor.organization_id);if(stream.epoch!==data.epoch){await client.query('ROLLBACK');return reply.code(409).send({error:'inventory_epoch_changed'});}
   const prior=await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_recovery_approvals WHERE id=$1',[data.approvalId,JSON.stringify(data)]);
   if(prior.rowCount){await client.query('ROLLBACK');const row=prior.rows[0];return reply.code(row.organization_id===actor.organization_id&&row.approved_by===actor.id&&row.identical?200:409).send(row.organization_id===actor.organization_id&&row.approved_by===actor.id&&row.identical?{approval:view(row)}:{error:'approval_id_reused'});}
   const target=await client.query('SELECT d.id FROM devices d JOIN users u ON u.id=d.user_id AND u.organization_id=d.organization_id WHERE d.organization_id=$1 AND d.id=$2 AND d.user_id=$3 AND d.revoked_at IS NULL AND u.active',[actor.organization_id,data.targetDeviceId,data.targetActorId]);
   if(!target.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'recovery_target_not_found'});}
   const result=await client.query(`INSERT INTO inventory_recovery_approvals(id,organization_id,epoch,target_actor_id,target_device_id,approved_by,approval_device_id,evidence_digest,reason,evidence,request_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(id) DO NOTHING RETURNING *`,[data.approvalId,actor.organization_id,data.epoch,data.targetActorId,data.targetDeviceId,actor.id,data.deviceId,data.evidenceDigest,data.reason,data.evidence,JSON.stringify(data)]);
   if(!result.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'approval_id_reused'});}
   await client.query('COMMIT');return reply.code(201).send({approval:view(result.rows[0])});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
 app.get('/inventory/recovery-approvals',async(request,reply)=>{
  const actor=await authenticate(pool,request.headers.authorization);if(!actor)return reply.code(401).send({error:'unauthorized'});
  const parsed=z.object({deviceId:z.guid(),evidenceDigest:digest}).strict().safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'invalid_recovery_query'});const data=parsed.data;
  const client=await pool.connect();try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[actor.organization_id+':inventory-sequence']);
   if(!await currentInventoryWriter(client,actor.organization_id,actor.id,data.deviceId,request.headers.authorization??'',request.headers['x-device-proof'],'operator')){await client.query('ROLLBACK');return reply.code(403).send({error:'forbidden'});}
   const stream=await inventoryStream(client,actor.organization_id);
   const rows=await client.query('SELECT * FROM inventory_recovery_approvals WHERE organization_id=$1 AND target_actor_id=$2 AND target_device_id=$3 AND epoch=$4 AND evidence_digest=$5 ORDER BY recorded_at DESC,id DESC LIMIT 1',[actor.organization_id,actor.id,data.deviceId,stream.epoch,data.evidenceDigest]);
   await client.query('COMMIT');return{organizationId:actor.organization_id,actorId:actor.id,deviceId:data.deviceId,epoch:stream.epoch,postingEnabled:stream.posting_enabled,approval:rows.rowCount?view(rows.rows[0]):null};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
}
