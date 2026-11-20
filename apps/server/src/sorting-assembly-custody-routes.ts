import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueBatchStep,issueFail,issueHttpError,issueMembership,issueTransaction} from './inventory-issue-scope.js';
import {checkSortingAssemblySource} from './sorting-assembly-source-check.js';

const id=z.guid();
const description=z.string().trim().min(1).max(2000);
const grade=z.string().trim().min(1).max(120);
const quantity=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const offer=z.object({
 operationId:id,deviceId:id,submissionId:id,grade,quantity,
 assemblyBatchId:id,assemblyStepNumber:z.number().int().min(1).max(2147483647),recipientId:id,
 reason:description,evidence:description,
}).strict();
const receipt=z.object({
 operationId:id,deviceId:id,handoffId:id,observedQuantity:quantity,observedGrade:grade,
 observedLabel:z.string().trim().min(1).max(200),reason:description,evidence:description,
}).strict();
const page=z.object({
 deviceId:id,after:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();
function failure(error:unknown){
 if((error as {code?:string}).code==='P0001')
  return{status:409,body:{error:(error as Error).message}};
 return issueHttpError(error);
}

/** Transfers an entire independently counted grade to an assigned Assembly WIP receiver.
 * This only proves physical custody. It does not release QA, make stock, pair
 * cathode/anode or authorize cell manufacturing. */
export function registerSortingAssemblyCustodyRoutes(app:FastifyInstance,pool:Pool){
 app.post('/inventory/assembly-electrodes/handoffs',async(request,reply)=>{
  const parsed=offer.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'invalid_assembly_grade_offer'});
  const data=parsed.data;
  try{
   const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
    data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,_level,epoch)=>{
    if(actor.role!=='chief'&&actor.role!=='master')issueFail(403,'sorting_supervisor_required');
    const line=(await client.query(`SELECT l.material_id,l.quantity,s.production_batch_id,s.step_number
     FROM inventory_output_lines l JOIN inventory_output_submissions s
       ON s.organization_id=l.organization_id AND s.operation_id=l.submission_id
     WHERE l.organization_id=$1 AND l.submission_id=$2 AND l.grade=$3 FOR SHARE OF l,s`,
     [actor.organization_id,data.submissionId,data.grade])).rows[0];
    if(!line)issueFail(404,'sorting_output_grade_not_found');
    const source=await issueBatchStep(client,actor,line.production_batch_id,line.step_number,actor.role==='chief',false);
    if(source.stage!=='sorting')issueFail(409,'sorting_source_step_required');
    const earlier=(await client.query(
     'SELECT *,request_payload=$2::jsonb AS identical FROM inventory_assembly_electrode_handoffs WHERE operation_id=$1',
     [data.operationId,JSON.stringify(data)])).rows[0];
    if(earlier){
     if(earlier.organization_id!==actor.organization_id||earlier.actor_id!==actor.id||
        earlier.device_id!==data.deviceId||!earlier.identical)issueFail(409,'operation_id_reused');
     return{status:'duplicate',operationId:data.operationId,handoff:earlier.result_payload};
    }
    // Do not trust an earlier phone preflight. Re-check the physical Cutting
    // receipt, approved production route, recipient and competing custody
    // channel inside this serialized write transaction.
    const eligible=await checkSortingAssemblySource(client,actor,{
     submissionId:data.submissionId,grade:data.grade,assemblyBatchId:data.assemblyBatchId,
     assemblyStepNumber:data.assemblyStepNumber,recipientId:data.recipientId,
    });
    if(eligible.quantity!==data.quantity)issueFail(409,'sorting_grade_quantity_mismatch');

    const target=await issueBatchStep(client,actor,data.assemblyBatchId,data.assemblyStepNumber,true,false);
    if(target.stage!=='assembly'||!['created','in_progress'].includes(target.status)||
       !['released','in_progress'].includes(target.order_status)||
       !await issueMembership(client,actor.organization_id,data.recipientId,target.workshop_id))
      issueFail(409,'assembly_route_or_receiver_required');
    if((await client.query(
      'SELECT 1 FROM inventory_output_acceptances WHERE organization_id=$1 AND submission_id=$2 AND grade=$3',
      [actor.organization_id,data.submissionId,data.grade])).rowCount)
      issueFail(409,'sorting_grade_already_accepted_into_warehouse');
    if((await client.query(
      'SELECT 1 FROM inventory_assembly_electrode_handoffs WHERE organization_id=$1 AND submission_id=$2 AND grade=$3',
      [actor.organization_id,data.submissionId,data.grade])).rowCount)
      issueFail(409,'sorting_grade_already_offered_to_assembly');
    const recordedAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    const handoff={...data,sourceBatchId:line.production_batch_id,materialId:line.material_id,
     recipientWorkshopId:target.workshop_id,actorId:actor.id,recordedAt,
     warehouseEffect:'none',qualityStatus:'unreviewed'};
    await client.query(`INSERT INTO inventory_assembly_electrode_handoffs
     (operation_id,organization_id,submission_id,grade,material_id,source_batch_id,
      assembly_batch_id,assembly_step_number,recipient_id,recipient_workshop_id,
      quantity,actor_id,device_id,epoch,request_payload,result_payload,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
     [data.operationId,actor.organization_id,data.submissionId,data.grade,line.material_id,
      line.production_batch_id,data.assemblyBatchId,data.assemblyStepNumber,data.recipientId,
      target.workshop_id,data.quantity,actor.id,data.deviceId,epoch,JSON.stringify(data),
      JSON.stringify(handoff),recordedAt]);
    return{status:'confirmed',operationId:data.operationId,handoff};
   });
   return reply.code(result.status==='duplicate'?200:201).send(result);
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });

 app.post('/inventory/assembly-electrodes/acknowledgements',async(request,reply)=>{
  const parsed=receipt.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:'invalid_assembly_electrode_receipt'});
  const data=parsed.data;
  try{
   const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
    data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,_level,epoch)=>{
    const h=(await client.query(
      'SELECT * FROM inventory_assembly_electrode_handoffs WHERE organization_id=$1 AND operation_id=$2 FOR SHARE',
      [actor.organization_id,data.handoffId])).rows[0];
    if(!h)issueFail(404,'assembly_handoff_not_found');
    if(h.recipient_id!==actor.id||!await issueMembership(client,actor.organization_id,actor.id,h.recipient_workshop_id))
     issueFail(403,'assigned_assembly_receiver_required');
    const prior=(await client.query(
     'SELECT *,request_payload=$2::jsonb AS identical FROM inventory_assembly_electrode_receipts WHERE operation_id=$1',
     [data.operationId,JSON.stringify(data)])).rows[0];
    if(prior){
     if(prior.organization_id!==actor.organization_id||prior.actor_id!==actor.id||
        prior.device_id!==data.deviceId||!prior.identical)issueFail(409,'operation_id_reused');
     return{status:'duplicate',operationId:data.operationId,receipt:prior.result_payload};
    }
    const originalLabel='production:'+h.submission_id+':'+h.grade;
    if(data.observedQuantity!==Number(h.quantity)||data.observedGrade!==h.grade||
       data.observedLabel!==originalLabel)
     issueFail(409,'physical_assembly_grade_or_count_mismatch');
    const target=await issueBatchStep(client,actor,h.assembly_batch_id,h.assembly_step_number,false,true);
    if(target.stage!=='assembly'||target.workshop_id!==h.recipient_workshop_id)
     issueFail(409,'assembly_route_changed');
    if((await client.query('SELECT 1 FROM inventory_assembly_electrode_receipts WHERE organization_id=$1 AND handoff_id=$2',
      [actor.organization_id,data.handoffId])).rowCount)
     issueFail(409,'assembly_grade_already_received');
    const recordedAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    const accepted={...data,sourceSnapshot:h.result_payload,actorId:actor.id,recordedAt,
     custodyEffect:'received',warehouseEffect:'none',qualityStatus:'unreviewed'};
    await client.query(`INSERT INTO inventory_assembly_electrode_receipts
     (operation_id,organization_id,handoff_id,actor_id,device_id,epoch,observed_quantity,
      observed_grade,observed_label,request_payload,result_payload,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
     [data.operationId,actor.organization_id,data.handoffId,actor.id,data.deviceId,epoch,
      data.observedQuantity,data.observedGrade,data.observedLabel,JSON.stringify(data),
      JSON.stringify(accepted),recordedAt]);
    return{status:'confirmed',operationId:data.operationId,receipt:accepted};
   });
   return reply.code(result.status==='duplicate'?200:201).send(result);
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });

 // Read-only B2.1 preflight. Neither an offer nor a reservation.
 app.get('/inventory/assembly-electrodes/eligibility',async(request,reply)=>{
  const parsed=z.object({
   deviceId:id,submissionId:id,grade,assemblyBatchId:id,
   assemblyStepNumber:z.coerce.number().int().min(1).max(2147483647),
   recipientId:id,
  }).strict().safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_assembly_source_check'});
  const {deviceId,...query}=parsed.data;
  try{
   return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
    deviceId,false,undefined,async(client,actor,_level,epoch)=>({
     ...await checkSortingAssemblySource(client,actor,query),
     organizationId:actor.organization_id,actorId:actor.id,deviceId,epoch,
    }));
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });

 // Only the currently authenticated assigned recipient can discover their offers.
 app.get('/inventory/assembly-electrodes/handoffs',async(request,reply)=>{
  const parsed=page.safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_assembly_handoff_page'});
  const q=parsed.data;
  try{
   return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
    q.deviceId,false,undefined,async(client,actor,_level,epoch)=>{
    const rows=(await client.query(`SELECT h.operation_id,h.result_payload,r.result_payload AS received
      FROM inventory_assembly_electrode_handoffs h
      LEFT JOIN inventory_assembly_electrode_receipts r ON r.organization_id=h.organization_id AND r.handoff_id=h.operation_id
      WHERE h.organization_id=$1 AND h.recipient_id=$2 AND h.operation_id>$3 AND
       EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=h.organization_id
         AND m.user_id=$2 AND m.workshop_id=h.recipient_workshop_id)
      ORDER BY h.operation_id LIMIT $4`,[actor.organization_id,actor.id,q.after??'00000000-0000-0000-0000-000000000000',q.limit+1])).rows;
    const items=rows.slice(0,q.limit).map(r=>({handoff:r.result_payload,received:r.received}));
    return{organizationId:actor.organization_id,actorId:actor.id,deviceId:q.deviceId,epoch,
     items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?rows[q.limit-1].operation_id:null};
   });
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
}
