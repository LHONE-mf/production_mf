import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';

const uuid=z.guid();
const read=z.object({deviceId:uuid,after:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const write=z.object({deviceId:uuid,changeId:uuid,materialId:uuid,
 expectedRevision:z.number().int().min(0).max(2147483645),
 lowAvailable:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
 expiryDays:z.number().int().min(0).max(365),active:z.boolean(),
 reason:z.string().trim().min(1).max(2000)}).strict();
const snapshot=(row:Record<string,unknown>)=>({
 materialId:row.material_id,lowAvailable:Number(row.low_available),
 expiryDays:row.expiry_days,active:row.active,revision:row.revision,
 updatedBy:row.updated_by,updatedAt:new Date(String(row.updated_at)).toISOString(),
});
export function registerInventoryAlertPolicyRoutes(app:FastifyInstance,pool:Pool){
 app.get('/inventory/alert-policies',async(request,reply)=>{
  const parsed=read.safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_alert_policy_query'});
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
   parsed.data.deviceId,false,undefined,async(client,_actor,level,epoch)=>{
    if(!level)issueFail(403,'warehouse_access_required');
    const rows=await client.query(`SELECT * FROM inventory_alert_policies
      WHERE organization_id=$1 AND ($2::uuid IS NULL OR material_id>$2)
      ORDER BY material_id LIMIT $3`,[_actor.organization_id,parsed.data.after??null,parsed.data.limit+1]);
    const page=rows.rows.slice(0,parsed.data.limit);
    return{epoch,policies:page.map(snapshot),hasMore:rows.rows.length>parsed.data.limit,
     nextAfter:rows.rows.length>parsed.data.limit?page[page.length-1].material_id:null};
   });}catch(error){const e=issueHttpError(error);return reply.code(e.status).send(e.body);}
 });
 app.post('/inventory/alert-policies',async(request,reply)=>{
  const parsed=write.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'invalid_alert_policy_change'});
  const data=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
   data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,level,epoch)=>{
    if(level!=='chief'&&level!=='manager')issueFail(403,'warehouse_manager_required');
    const prior=await client.query(`SELECT organization_id,actor_id,device_id,
      request_payload=$2::jsonb AS identical,result_payload
      FROM inventory_alert_policy_events WHERE change_id=$1`,
      [data.changeId,JSON.stringify(data)]);
    if(prior.rowCount){
     const p=prior.rows[0];
     if(p.organization_id!==actor.organization_id||p.actor_id!==actor.id||
       p.device_id!==data.deviceId||p.identical!==true)issueFail(409,'alert_policy_change_id_reused');
     return{status:'duplicate',changeId:data.changeId,policy:p.result_payload};
    }
    const material=await client.query('SELECT id FROM inventory_materials WHERE organization_id=$1 AND id=$2',
      [actor.organization_id,data.materialId]);
    if(!material.rowCount)issueFail(404,'material_not_found');
    const old=await client.query('SELECT revision FROM inventory_alert_policies WHERE organization_id=$1 AND material_id=$2 FOR UPDATE',
      [actor.organization_id,data.materialId]);
    const revision=old.rows[0]?.revision??0;
    if(revision!==data.expectedRevision)issueFail(409,'alert_policy_revision_conflict');
    const updated=await client.query(`INSERT INTO inventory_alert_policies
      (organization_id,material_id,low_available,expiry_days,active,revision,updated_by)
      VALUES($1,$2,$3,$4,$5,1,$6)
      ON CONFLICT(organization_id,material_id) DO UPDATE SET
       low_available=EXCLUDED.low_available,expiry_days=EXCLUDED.expiry_days,
       active=EXCLUDED.active,revision=inventory_alert_policies.revision+1,
       updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
      RETURNING *`,[actor.organization_id,data.materialId,data.lowAvailable,
       data.expiryDays,data.active,actor.id]);
    const policy=snapshot(updated.rows[0]);
    await client.query(`INSERT INTO inventory_alert_policy_events
     (change_id,organization_id,material_id,actor_id,device_id,epoch,expected_revision,request_payload,result_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
     [data.changeId,actor.organization_id,data.materialId,actor.id,data.deviceId,epoch,
      data.expectedRevision,JSON.stringify(data),JSON.stringify(policy)]);
    return{status:'confirmed',changeId:data.changeId,policy};
   });}catch(error){const e=issueHttpError(error);return reply.code(e.status).send(e.body);}
 });
}
