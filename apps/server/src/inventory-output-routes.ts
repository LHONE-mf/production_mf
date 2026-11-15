import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {electrodeSubmission,outputAcceptance} from './inventory-output-contract.js';
import {issueBatchStep,issueFail,issueHttpError,issueTransaction,type IssueActor} from './inventory-issue-scope.js';
import {inventoryExpiryInstant} from './inventory-snapshot.js';
import {inventoryStream} from './inventory-stream.js';

async function productionAccess(client:PoolClient,actor:IssueActor,batch:string,step:number){
 if(actor.role!=='chief'&&actor.role!=='master')issueFail(403,'production_output_authority_required');
 return issueBatchStep(client,actor,batch,step,actor.role==='chief',false);
}
function failure(error:unknown){
 if((error as {code?:string}).code==='P0001'&&['finished_output_source_required','finished_output_pair_required','finished_output_line_mismatch','finished_output_authority_required','finished_output_history_required'].includes((error as Error).message))
  return{status:409,body:{error:(error as Error).message}};
 return issueHttpError(error);
}

export function registerInventoryOutputRoutes(app:FastifyInstance,pool:Pool){
 app.post('/inventory/outputs/electrodes',async(request,reply)=>{
  const parsed=electrodeSubmission.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'invalid_electrode_output'});
  const data=parsed.data;
  try{
   const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,_level,epoch)=>{
    const step=await productionAccess(client,actor,data.productionBatchId,data.stepNumber);
    const prior=(await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_output_submissions WHERE operation_id=$1',[data.operationId,JSON.stringify(data)])).rows[0];
    if(prior){
     if(prior.organization_id!==actor.organization_id||prior.actor_id!==actor.id||prior.device_id!==data.deviceId||!prior.identical)issueFail(409,'operation_id_reused');
     return{status:'duplicate',...prior.result_payload};
    }
    if(step.stage!=='sorting'||!['in_progress','completed'].includes(step.status)||!['released','in_progress','completed'].includes(step.order_status))issueFail(409,'finished_output_step_unavailable');
    const completion=(await client.query(`SELECT e.id,e.quantity::text,e.quantity_unit FROM production_step_evidence e
      JOIN production_batches b ON b.organization_id=e.organization_id AND b.id=e.batch_id
      WHERE e.organization_id=$1 AND e.id=$2 AND e.batch_id=$3 AND e.step_number=$4 AND e.kind='completed'
       AND b.material_line IN ('cathode','anode') AND NOT EXISTS(SELECT 1 FROM process_route_steps s
        WHERE s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version
         AND s.step_number>e.step_number AND s.electrode_line IN ('common',b.material_line))`,
      [actor.organization_id,data.completionId,data.productionBatchId,data.stepNumber])).rows[0];
    const quantity=data.source.stages[2].passedCount;
    if(!completion||completion.quantity_unit!=='pieces'||Number(completion.quantity)!==quantity)issueFail(409,'completed_sorting_quantity_required');
    for(const output of data.outputs){
     const material=await client.query("SELECT id FROM inventory_materials WHERE organization_id=$1 AND id=$2 AND active AND category='electrode' AND base_unit='pieces' FOR SHARE",[actor.organization_id,output.materialId]);
     if(!material.rowCount)issueFail(409,'electrode_material_required');
    }
    const submission={operationId:data.operationId,productionBatchId:data.productionBatchId,stepNumber:data.stepNumber,
     completionId:data.completionId,source:data.source,outputs:data.outputs,revision:1,actorId:actor.id,deviceId:data.deviceId,
     reason:data.reason,evidence:data.evidence,recordedAt:(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString()};
    const accepted={operationId:data.operationId,submission};
    await client.query(`INSERT INTO inventory_output_submissions(operation_id,organization_id,production_batch_id,step_number,completion_id,
     source_run_id,source_cut_id,quantity,actor_id,device_id,epoch,reason,evidence,request_payload,result_payload,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
     [data.operationId,actor.organization_id,data.productionBatchId,data.stepNumber,data.completionId,data.source.runId,data.source.cutRunId,quantity,
      actor.id,data.deviceId,epoch,data.reason,data.evidence,JSON.stringify(data),JSON.stringify(accepted),submission.recordedAt]);
    for(const o of data.outputs)await client.query('INSERT INTO inventory_output_lines(organization_id,submission_id,grade,material_id,quantity) VALUES($1,$2,$3,$4,$5)',[actor.organization_id,data.operationId,o.grade,o.materialId,o.quantity]);
    return{status:'confirmed',...accepted};
   });
   return reply.code(result.status==='duplicate'?200:201).send(result);
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });

 app.post('/inventory/outputs/accept',async(request,reply)=>{
  const parsed=outputAcceptance.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'invalid_output_acceptance'});
  const data=parsed.data;
  try{
   const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,level,epoch)=>{
    if(!level)issueFail(403,'warehouse_access_required');
    const prior=(await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_output_acceptances WHERE operation_id=$1',[data.operationId,JSON.stringify(data)])).rows[0];
    if(prior){
     if(prior.organization_id!==actor.organization_id||prior.actor_id!==actor.id||prior.device_id!==data.deviceId||!prior.identical)issueFail(409,'operation_id_reused');
     return{status:'duplicate',operationId:data.operationId,stock:prior.result_stock};
    }
    const line=(await client.query(`SELECT l.material_id,l.quantity,s.production_batch_id,s.step_number
     FROM inventory_output_lines l JOIN inventory_output_submissions s ON s.organization_id=l.organization_id AND s.operation_id=l.submission_id
     WHERE l.organization_id=$1 AND l.submission_id=$2 AND l.grade=$3`,[actor.organization_id,data.submissionId,data.grade])).rows[0];
    if(!line)issueFail(404,'output_grade_not_found');
    if(Number(line.quantity)!==data.quantity)issueFail(409,'physical_output_quantity_mismatch');
    const step=await issueBatchStep(client,actor,line.production_batch_id,line.step_number,true,false);
    if(!['in_progress','completed'].includes(step.status)||!['released','in_progress','completed'].includes(step.order_status))issueFail(409,'finished_output_step_unavailable');
    if((await client.query('SELECT 1 FROM inventory_output_acceptances WHERE organization_id=$1 AND submission_id=$2 AND grade=$3',[actor.organization_id,data.submissionId,data.grade])).rowCount)issueFail(409,'output_already_accepted');
    if(!(await client.query("SELECT id FROM inventory_materials WHERE organization_id=$1 AND id=$2 AND active AND category='electrode' AND base_unit='pieces' FOR SHARE",[actor.organization_id,line.material_id])).rowCount)issueFail(409,'electrode_material_required');
    if(!(await client.query('SELECT id FROM inventory_locations WHERE organization_id=$1 AND id=$2 AND active FOR SHARE',[actor.organization_id,data.locationId])).rowCount)issueFail(404,'location_not_found');
    const stock={stockId:data.stockId,materialId:line.material_id,manufacturerLot:'production:'+data.submissionId+':'+data.grade,
     unit:'pieces',locationId:data.locationId,quality:'quarantine',onHand:data.quantity,reserved:0,available:data.quantity,revision:1,
     ...(data.manufacturedOn?{manufacturedOn:data.manufacturedOn}:{}),...(data.expiresOn?{expiresAt:inventoryExpiryInstant(data.expiresOn)}:{})};
    await client.query(`INSERT INTO inventory_stocks(id,organization_id,material_id,manufacturer_lot,receipt_reference,location_id,quality,on_hand,reserved,revision,manufactured_on,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,'quarantine',$7,0,1,$8,$9)`,[data.stockId,actor.organization_id,line.material_id,stock.manufacturerLot,data.submissionId,data.locationId,data.quantity,data.manufacturedOn??null,stock.expiresAt??null]);
    await client.query(`INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,production_batch_id,request_payload,result_stock,to_location_id)
     VALUES($1,$2,$3,$4,$5,'receive',$6,0,1,$7,$8,$9,$10,$11)`,[data.operationId,actor.organization_id,data.stockId,actor.id,data.deviceId,data.quantity,data.reason,line.production_batch_id,JSON.stringify(data),JSON.stringify(stock),data.locationId]);
    await client.query(`INSERT INTO inventory_output_acceptances(operation_id,organization_id,submission_id,grade,stock_id,actor_id,device_id,epoch,request_payload,result_stock)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[data.operationId,actor.organization_id,data.submissionId,data.grade,data.stockId,actor.id,data.deviceId,epoch,JSON.stringify(data),JSON.stringify(stock)]);
    return{status:'confirmed',operationId:data.operationId,stock};
   });
   return reply.code(result.status==='duplicate'?200:201).send(result);
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });

 app.get('/inventory/outputs',async(request,reply)=>{
  const parsed=z.object({deviceId:z.guid(),productionBatchId:z.guid().optional(),after:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_output_page'});
  const q=parsed.data;
  try{
   return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,level,epoch)=>{
    if(!level&&actor.role!=='master')issueFail(403,'output_read_authority_required');
    const rows=(await client.query(`SELECT s.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('grade',l.grade,'materialId',l.material_id,'quantity',l.quantity,'stockId',a.stock_id,'acceptanceOperationId',a.operation_id) ORDER BY l.grade)
     FROM inventory_output_lines l LEFT JOIN inventory_output_acceptances a ON a.organization_id=l.organization_id AND a.submission_id=l.submission_id AND a.grade=l.grade
     WHERE l.organization_id=s.organization_id AND l.submission_id=s.operation_id),'[]') AS outputs
     FROM inventory_output_submissions s JOIN production_step_evidence e ON e.organization_id=s.organization_id AND e.id=s.completion_id
     WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.production_batch_id=$2) AND s.operation_id>$3
      AND ($4::boolean OR EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=s.organization_id AND m.user_id=$5 AND m.workshop_id=e.workshop_id))
     ORDER BY s.operation_id LIMIT $6`,[actor.organization_id,q.productionBatchId??null,q.after??'00000000-0000-0000-0000-000000000000',!!level,actor.id,q.limit+1])).rows;
    // Membership is locked/rechecked before returning a Master-scoped source.
    for(const row of rows.slice(0,q.limit))if(!level)await productionAccess(client,actor,row.production_batch_id,row.step_number);
    const items=rows.slice(0,q.limit).map(row=>({...row.result_payload.submission,outputs:row.outputs}));
    const stream=await inventoryStream(client,actor.organization_id);
    return{organizationId:actor.organization_id,actorId:actor.id,deviceId:q.deviceId,epoch,postingEnabled:stream.posting_enabled,
     items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.operationId:null};
   });
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
}
