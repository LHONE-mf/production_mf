import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {cellSubmission} from './inventory-cell-output-contract.js';
import {issueBatchStep,issueFail,issueHttpError,issueTransaction,type IssueActor} from './inventory-issue-scope.js';
import {inventoryStream} from './inventory-stream.js';
export async function cellProductionAccess(client:PoolClient,actor:IssueActor,batch:string,step:number){
 if(!['chief','master'].includes(actor.role))issueFail(403,'production_output_authority_required');
 return issueBatchStep(client,actor,batch,step,actor.role==='chief',false);
}
export function cellOutputError(error:unknown){
 if((error as {code?:string}).code==='P0001'&&/^(cell_output_|cell_serial_)/.test((error as Error).message))return{status:409,body:{error:(error as Error).message}};
 return issueHttpError(error);
}
export async function cellOutputContext(client:PoolClient,actor:IssueActor,deviceId:string,epoch:string){const stream=await inventoryStream(client,actor.organization_id);return{organizationId:actor.organization_id,actorId:actor.id,deviceId,epoch,postingEnabled:stream.posting_enabled};}
export function registerInventoryCellOutputRoutes(app:FastifyInstance,pool:Pool){
 app.post('/inventory/cell-outputs',async(request,reply)=>{
  const parsed=cellSubmission.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'invalid_cell_output'});const data=parsed.data;
  try{
   const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,_level,epoch)=>{
    const step=await cellProductionAccess(client,actor,data.productionBatchId,data.stepNumber);
    const old=(await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_cell_submissions WHERE operation_id=$1',[data.operationId,JSON.stringify(data)])).rows[0];
    if(old){if(old.organization_id!==actor.organization_id||old.actor_id!==actor.id||old.device_id!==data.deviceId||!old.identical)issueFail(409,'operation_id_reused');return{status:'duplicate',...old.result_payload};}
    if(step.stage!=='formation'||!['in_progress','completed'].includes(step.status)||!['released','in_progress','completed'].includes(step.order_status))issueFail(409,'completed_cell_step_required');
    const quantity=data.source.formation.cellsOut;
    const completion=await client.query(`SELECT e.id FROM production_step_evidence e JOIN production_batches b ON b.organization_id=e.organization_id AND b.id=e.batch_id
     WHERE e.organization_id=$1 AND e.id=$2 AND e.batch_id=$3 AND e.step_number=$4 AND e.kind='completed' AND e.quantity_unit='pieces' AND e.quantity=$5
      AND b.material_line='cell' AND NOT EXISTS(SELECT 1 FROM process_route_steps s WHERE s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number>e.step_number AND s.electrode_line='common') FOR SHARE OF e`,[actor.organization_id,data.completionId,data.productionBatchId,data.stepNumber,quantity]);
    if(!completion.rowCount)issueFail(409,'completed_cell_quantity_required');
    if(!(await client.query("SELECT id FROM inventory_materials WHERE organization_id=$1 AND id=$2 AND active AND category='cell' AND base_unit='pieces' FOR SHARE",[actor.organization_id,data.materialId])).rowCount)issueFail(409,'cell_material_required');
    const recordedAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    const submission={...data,quantity,unit:'pieces',revision:1,actorId:actor.id,recordedAt},ack={operationId:data.operationId,submission},s=data.source;
    await client.query(`INSERT INTO inventory_cell_submissions(operation_id,organization_id,production_batch_id,step_number,completion_id,source_identity_id,source_run_id,assembly_output_id,assembly_run_id,material_id,serial_prefix,serial_start,serial_end,quantity,actor_id,device_id,epoch,reason,evidence,request_payload,result_payload,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,[data.operationId,actor.organization_id,data.productionBatchId,data.stepNumber,data.completionId,s.identityId,s.formationRunId,s.lineage.assemblyOutputId,s.lineage.assemblyRunId,data.materialId,s.inputSerialRange.prefix??'',s.inputSerialRange.start,s.inputSerialRange.end,quantity,actor.id,data.deviceId,epoch,data.reason,data.evidence,JSON.stringify(data),JSON.stringify(ack),recordedAt]);
    for(const [ordinal,r]of s.ranges.entries())await client.query('INSERT INTO inventory_cell_serial_ranges(organization_id,submission_id,ordinal,range_start,range_end) VALUES($1,$2,$3,$4,$5)',[actor.organization_id,data.operationId,ordinal,r.start,r.end]);
    return{status:'confirmed',...ack};
   });return reply.code(result.status==='duplicate'?200:201).send(result);
  }catch(error){const e=cellOutputError(error);return reply.code(e.status).send(e.body);}
 });
 app.get('/inventory/cell-outputs',async(request,reply)=>{
  const parsed=z.object({deviceId:z.guid(),after:z.guid().optional(),productionBatchId:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_cell_output_page'});const q=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,level,epoch)=>{
   if(!level&&actor.role!=='master')issueFail(403,'output_read_authority_required');
   const rows=(await client.query(`SELECT s.* FROM inventory_cell_submissions s JOIN production_step_evidence e ON e.organization_id=s.organization_id AND e.id=s.completion_id
    WHERE s.organization_id=$1 AND s.operation_id>$2 AND ($3::uuid IS NULL OR s.production_batch_id=$3)
     AND ($4::boolean OR EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=s.organization_id AND m.user_id=$5 AND m.workshop_id=e.workshop_id))
    ORDER BY s.operation_id LIMIT $6`,[actor.organization_id,q.after??'00000000-0000-0000-0000-000000000000',q.productionBatchId??null,!!level,actor.id,q.limit+1])).rows;
   if(!level)for(const row of rows.slice(0,q.limit))await cellProductionAccess(client,actor,row.production_batch_id,row.step_number);
   const items=rows.slice(0,q.limit).map(row=>row.result_payload.submission);
   return{...await cellOutputContext(client,actor,q.deviceId,epoch),items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.operationId:null};
  });}catch(error){const e=cellOutputError(error);return reply.code(e.status).send(e.body);}
 });
}
