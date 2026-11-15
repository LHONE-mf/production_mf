import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {issueBatchStep,issueFail,issueHttpError,issueTransaction,type IssueActor} from './inventory-issue-scope.js';
import {inventoryStream} from './inventory-stream.js';
const page=z.object({deviceId:z.guid(),after:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const materials=page.extend({completionId:z.guid(),productionBatchId:z.guid(),stepNumber:z.coerce.number().int().positive().safe()}).strict();

/** Only actual completed final steps may be selected for a new output offer.
 * Exact retry uses the original submission API, never this discovery page. */
async function completedSteps(client:PoolClient,actor:IssueActor,q:{completionId?:string;productionBatchId?:string;stepNumber?:number;after?:string;limit:number}){
 if(!['chief','master'].includes(actor.role))issueFail(403,'production_output_authority_required');
 const rows=(await client.query(`SELECT e.id AS completion_id,e.batch_id,e.step_number,e.quantity::text,e.recorded_at,
   b.batch_code,b.material_line,s.workshop_id,s.name
  FROM production_step_evidence e
  JOIN production_batches b ON b.organization_id=e.organization_id AND b.id=e.batch_id
  JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
  JOIN process_route_steps s ON s.organization_id=e.organization_id AND s.route_id=e.route_id
   AND s.route_version=e.route_version AND s.step_number=e.step_number AND s.workshop_id=e.workshop_id AND s.electrode_line=b.material_line
  WHERE e.organization_id=$1 AND e.kind='completed' AND e.quantity_unit='pieces' AND e.quantity=trunc(e.quantity)
   AND s.stage='sorting' AND b.material_line IN ('cathode','anode')
   AND b.status IN ('in_progress','completed') AND o.status IN ('released','in_progress','completed')
   AND ($2::uuid IS NULL OR e.id=$2) AND ($3::uuid IS NULL OR b.id=$3) AND ($4::int IS NULL OR e.step_number=$4)
   AND e.id>$5 AND ($6::boolean OR EXISTS(SELECT 1 FROM user_workshop_memberships m
    WHERE m.organization_id=e.organization_id AND m.user_id=$7 AND m.workshop_id=e.workshop_id))
   AND NOT EXISTS(SELECT 1 FROM process_route_steps later WHERE later.organization_id=e.organization_id
    AND later.route_id=e.route_id AND later.route_version=e.route_version AND later.step_number>e.step_number
    AND later.electrode_line IN ('common',b.material_line))
   AND NOT EXISTS(SELECT 1 FROM inventory_output_submissions offered WHERE offered.organization_id=e.organization_id AND offered.completion_id=e.id)
  ORDER BY e.id LIMIT $8 FOR SHARE OF e,b,o,s`,[actor.organization_id,q.completionId??null,q.productionBatchId??null,q.stepNumber??null,
   q.after??'00000000-0000-0000-0000-000000000000',actor.role==='chief',actor.id,q.limit])).rows;
 for(const row of rows)await issueBatchStep(client,actor,row.batch_id,row.step_number,actor.role==='chief',false);
 return rows;
}
async function context(client:PoolClient,actor:IssueActor,deviceId:string,epoch:string){
 const stream=await inventoryStream(client,actor.organization_id);
 return{organizationId:actor.organization_id,actorId:actor.id,deviceId,epoch,postingEnabled:stream.posting_enabled};
}
export function registerInventoryOutputDiscovery(app:FastifyInstance,pool:Pool){
 app.get('/inventory/outputs/steps',async(request,reply)=>{
  const parsed=page.safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'invalid_output_step_page'});
  const q=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,_level,epoch)=>{
   const rows=await completedSteps(client,actor,{after:q.after,limit:q.limit+1});
   const items=rows.slice(0,q.limit).map(r=>({completionId:r.completion_id,productionBatchId:r.batch_id,batchCode:r.batch_code,
    stepNumber:r.step_number,workshopId:r.workshop_id,name:r.name,materialLine:r.material_line,quantity:Number(r.quantity),unit:'pieces',completedAt:r.recorded_at.toISOString()}));
   return{...await context(client,actor,q.deviceId,epoch),items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.completionId:null};
  });}catch(error){const e=issueHttpError(error);return reply.code(e.status).send(e.body);}
 });
 app.get('/inventory/outputs/materials',async(request,reply)=>{
  const parsed=materials.safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'invalid_output_material_page'});
  const q=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,_level,epoch)=>{
   const source=await completedSteps(client,actor,{completionId:q.completionId,productionBatchId:q.productionBatchId,stepNumber:q.stepNumber,limit:1});
   if(!source.length)issueFail(404,'completed_output_step_not_found');
   const rows=(await client.query(`SELECT id,material_code,display_name FROM inventory_materials
    WHERE organization_id=$1 AND active AND category='electrode' AND base_unit='pieces' AND id>$2 ORDER BY id LIMIT $3 FOR SHARE`,
    [actor.organization_id,q.after??'00000000-0000-0000-0000-000000000000',q.limit+1])).rows;
   const items=rows.slice(0,q.limit).map(r=>({id:r.id,code:r.material_code,name:r.display_name,category:'electrode',baseUnit:'pieces'}));
   return{...await context(client,actor,q.deviceId,epoch),items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.id:null};
  });}catch(error){const e=issueHttpError(error);return reply.code(e.status).send(e.body);}
 });
}
