import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {issueFail,issueTransaction,type IssueActor} from './inventory-issue-scope.js';
import {cellProductionAccess,cellOutputContext,cellOutputError} from './inventory-cell-output-routes.js';
const page=z.object({deviceId:z.guid(),after:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const materialQuery=page.extend({completionId:z.guid(),productionBatchId:z.guid(),stepNumber:z.coerce.number().int().positive().safe()});
async function completed(client:PoolClient,actor:IssueActor,q:{completionId?:string;productionBatchId?:string;stepNumber?:number;after?:string;limit:number}){
 if(!['chief','master'].includes(actor.role))issueFail(403,'production_output_authority_required');
 const rows=(await client.query(`SELECT e.id,e.batch_id,e.step_number,e.quantity::text,e.recorded_at,b.batch_code,s.workshop_id,s.name
  FROM production_step_evidence e JOIN production_batches b ON b.organization_id=e.organization_id AND b.id=e.batch_id
  JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id AND o.route_id=e.route_id AND o.route_version=e.route_version
  JOIN process_route_steps s ON s.organization_id=e.organization_id AND s.route_id=e.route_id AND s.route_version=e.route_version AND s.step_number=e.step_number AND s.workshop_id=e.workshop_id
  WHERE e.organization_id=$1 AND e.kind='completed' AND e.quantity_unit='pieces' AND e.quantity=trunc(e.quantity) AND e.quantity BETWEEN 1 AND 9007199254740991
   AND b.material_line='cell' AND s.stage='formation' AND s.electrode_line='common' AND b.status IN ('in_progress','completed') AND o.status IN ('released','in_progress','completed')
   AND ($2::uuid IS NULL OR e.id=$2) AND ($3::uuid IS NULL OR b.id=$3) AND ($4::int IS NULL OR e.step_number=$4) AND e.id>$5
   AND ($6::boolean OR EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=e.organization_id AND m.user_id=$7 AND m.workshop_id=e.workshop_id))
   AND NOT EXISTS(SELECT 1 FROM process_route_steps later WHERE later.organization_id=e.organization_id AND later.route_id=e.route_id AND later.route_version=e.route_version AND later.step_number>e.step_number AND later.electrode_line='common')
   AND NOT EXISTS(SELECT 1 FROM inventory_cell_submissions offered WHERE offered.organization_id=e.organization_id AND offered.completion_id=e.id)
  ORDER BY e.id LIMIT $8 FOR SHARE OF e,b,o,s`,[actor.organization_id,q.completionId??null,q.productionBatchId??null,q.stepNumber??null,q.after??'00000000-0000-0000-0000-000000000000',actor.role==='chief',actor.id,q.limit])).rows;
 for(const row of rows)await cellProductionAccess(client,actor,row.batch_id,row.step_number);return rows;
}
export function registerInventoryCellOutputDiscovery(app:FastifyInstance,pool:Pool){
 app.get('/inventory/cell-outputs/steps',async(request,reply)=>{
  const parsed=page.safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'invalid_cell_step_page'});const q=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,_level,epoch)=>{
   const rows=await completed(client,actor,{after:q.after,limit:q.limit+1}),items=rows.slice(0,q.limit).map(r=>({completionId:r.id,productionBatchId:r.batch_id,stepNumber:r.step_number,batchCode:r.batch_code,workshopId:r.workshop_id,name:r.name,materialLine:'cell',quantity:Number(r.quantity),unit:'pieces',completedAt:r.recorded_at.toISOString()}));
   return{...await cellOutputContext(client,actor,q.deviceId,epoch),items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.completionId:null};
  });}catch(error){const e=cellOutputError(error);return reply.code(e.status).send(e.body);}
 });
 app.get('/inventory/cell-outputs/materials',async(request,reply)=>{
  const parsed=materialQuery.safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:'invalid_cell_material_page'});const q=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,_level,epoch)=>{
   if(!(await completed(client,actor,{completionId:q.completionId,productionBatchId:q.productionBatchId,stepNumber:q.stepNumber,limit:1})).length)issueFail(404,'completed_cell_step_not_found');
   const rows=(await client.query("SELECT id,material_code,display_name FROM inventory_materials WHERE organization_id=$1 AND active AND category='cell' AND base_unit='pieces' AND id>$2 ORDER BY id LIMIT $3 FOR SHARE",[actor.organization_id,q.after??'00000000-0000-0000-0000-000000000000',q.limit+1])).rows;
   const items=rows.slice(0,q.limit).map(r=>({id:r.id,code:r.material_code,name:r.display_name,category:'cell',baseUnit:'pieces'}));
   return{...await cellOutputContext(client,actor,q.deviceId,epoch),items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.id:null};
  });}catch(error){const e=cellOutputError(error);return reply.code(e.status).send(e.body);}
 });
}
