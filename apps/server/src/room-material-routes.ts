import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueTransaction,issueBatchStep,issueSnapshot,issueFail,issueHttpError} from './inventory-issue-scope.js';
import {inventoryStream} from './inventory-stream.js';
import {balance,settlement} from './inventory-outcome-routes.js';
const uuid=z.guid(),positive=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),text=z.string().min(1).max(200).refine(v=>!!v.trim());
const source=z.object({id:text,recordedAt:z.number().finite().positive(),recordedBy:text,recordedRole:text,batchCode:text,recipeId:text.nullable(),recipeRevision:positive.nullable(),recipeName:text,measurementNote:z.string().min(1).max(2000).refine(v=>!!v.trim()),components:z.array(z.object({componentId:text,componentVersion:positive,actualMg:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict()).min(1).max(100)}).strict();
const command=z.object({operationId:uuid,deviceId:uuid,productionBatchId:uuid,stepNumber:z.number().int().min(1).max(2147483647),
 source,allocations:z.array(z.object({operationId:uuid,issueId:uuid,materialId:uuid,componentId:text,quantity:positive,expectedSettlementRevision:positive.max(Number.MAX_SAFE_INTEGER-1)}).strict()).min(1).max(100),reason:z.string().min(1).max(2000).refine(v=>!!v.trim()),evidence:z.string().min(1).max(2000).refine(v=>!!v.trim())}).strict();
function measured(body:z.infer<typeof command>){
 if(new Set(body.source.components.map(c=>c.componentId)).size!==body.source.components.length||new Set(body.allocations.map(a=>a.issueId)).size!==body.allocations.length||new Set([body.operationId,...body.allocations.map(a=>a.operationId)]).size!==body.allocations.length+1)return false;
 return body.allocations.every(a=>body.source.components.some(c=>c.componentId===a.componentId))&&body.source.components.every(c=>body.allocations.filter(a=>a.componentId===c.componentId).reduce((n,a)=>n+BigInt(a.quantity),0n)===BigInt(c.actualMg));
}
function failure(error:unknown){
 if((error as {code?:string}).code==='P0001')return{status:409,body:{error:'room_source_or_settlement_changed'}};
 return issueHttpError(error);
}
export function registerRoomMaterialRoutes(app:FastifyInstance,pool:Pool){
 app.get('/inventory/room-materials/:room',async(request,reply)=>{
  const params=z.object({room:z.enum(['slurry','coating','calendaring','cutting','sorting','assembly','electrolyte','electrolyte-705','walzing','formation'])}).safeParse(request.params);
  const query=z.object({deviceId:uuid,after:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().safeParse(request.query);
  if(!params.success||!query.success)return reply.code(400).send({error:'invalid_room_material_page'});
  const q=query.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],q.deviceId,false,undefined,async(client,actor,_level,epoch)=>{
   const rows=(await client.query(`SELECT i.*,m.display_name,m.material_code,b.batch_code,
    a.*,inventory_package_released(i.organization_id,i.stock_id) AND ((i.source_snapshot->>'expiresAt') IS NULL OR (i.source_snapshot->>'expiresAt')::timestamptz>clock_timestamp()) AS eligible
    FROM inventory_issues i JOIN inventory_materials m ON m.organization_id=i.organization_id AND m.id=i.material_id
    JOIN production_batches b ON b.organization_id=i.organization_id AND b.id=i.production_batch_id
    JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
    JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=i.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
    LEFT JOIN LATERAL(SELECT count(*) AS n,COALESCE(sum(quantity) FILTER(WHERE kind='return'),0) AS returned,COALESCE(sum(quantity) FILTER(WHERE kind='scrap'),0) AS scrapped,COALESCE(sum(quantity) FILTER(WHERE kind='consume'),0) AS consumed FROM inventory_issue_outcomes WHERE organization_id=i.organization_id AND issue_id=i.id) a ON true
    WHERE i.organization_id=$1 AND i.state='received' AND s.stage=$2 AND i.id>$3
    AND ($4='chief' OR (i.recipient_id=$5 OR $4='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=i.organization_id AND w.user_id=$5 AND w.workshop_id=i.workshop_id)) ORDER BY i.id LIMIT $6`,[actor.organization_id,params.data.room,q.after??'00000000-0000-0000-0000-000000000000',actor.role,actor.id,q.limit+1])).rows;
   const items=rows.slice(0,q.limit).map(r=>({issue:issueSnapshot(r),room:params.data.room,materialName:r.display_name,materialCode:r.material_code,batchCode:r.batch_code,eligible:r.eligible,settlement:settlement(r.quantity,r)}));
   const stream=await inventoryStream(client,actor.organization_id);
   return{organizationId:actor.organization_id,actorId:actor.id,deviceId:q.deviceId,epoch,postingEnabled:stream.posting_enabled,items,hasMore:rows.length>q.limit,nextAfter:rows.length>q.limit?items.at(-1)!.issue.id:null};
  });}catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
 app.post('/inventory/room-materials/slurry/consumptions',async(request,reply)=>{
  const parsed=command.safeParse(request.body);if(!parsed.success||!measured(parsed.data))return reply.code(400).send({error:'invalid_measured_slurry_allocation'});
  const data=parsed.data;
  try{
   const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,_level,epoch)=>{
    const step=await issueBatchStep(client,actor,data.productionBatchId,data.stepNumber,actor.role==='chief',false);
    if(step.stage!=='slurry')issueFail(409,'slurry_route_required');
    const prior=(await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_slurry_consumptions WHERE operation_id=$1',[data.operationId,JSON.stringify(data)])).rows[0];
    if(prior){if(prior.organization_id!==actor.organization_id||prior.actor_id!==actor.id||prior.device_id!==data.deviceId||!prior.identical)issueFail(409,'operation_id_reused');return{status:'duplicate',operationId:data.operationId,consumption:prior.result_payload};}
    await issueBatchStep(client,actor,data.productionBatchId,data.stepNumber,actor.role==='chief');
    const lines=[];
    for(const allocation of data.allocations){
     const i=(await client.query('SELECT * FROM inventory_issues WHERE organization_id=$1 AND id=$2 FOR UPDATE',[actor.organization_id,allocation.issueId])).rows[0];
     if(!i||i.production_batch_id!==data.productionBatchId||i.step_number!==data.stepNumber||i.state!=='received'||i.material_id!==allocation.materialId||i.unit!=='mg')issueFail(409,'received_mass_source_required');
     if(actor.role!=='chief'&&actor.role!=='master'&&i.recipient_id!==actor.id)issueFail(403,'room_custodian_required');
     const allowed=(await client.query("SELECT inventory_package_released($1,$2) AS eligible",[actor.organization_id,i.stock_id])).rows[0].eligible;
     if(!allowed||i.source_snapshot.expiresAt&&Date.parse(i.source_snapshot.expiresAt)<=Date.now())issueFail(409,'room_source_held');
     const before=await balance(client,actor.organization_id,i.id,i.quantity);
     if(before.revision!==allocation.expectedSettlementRevision||allocation.quantity>before.outstanding)issueFail(409,'issue_outstanding_changed');
     lines.push({allocation,issue:i,before});
    }
    const recordedAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
    const consumption={...data,room:'slurry',actorId:actor.id,recordedAt,warehouseEffect:'none'};
    await client.query('INSERT INTO inventory_slurry_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,source_id,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[data.operationId,actor.organization_id,actor.id,data.deviceId,data.productionBatchId,data.stepNumber,data.source.id,epoch,JSON.stringify(data),JSON.stringify(consumption),recordedAt]);
    for(const {allocation:a,issue:i,before}of lines){
     const outcome={operationId:a.operationId,issueId:i.id,productionBatchId:i.production_batch_id,sourceStockId:i.stock_id,actorId:actor.id,deviceId:data.deviceId,kind:'consume',quantity:a.quantity,stockId:null,condition:null,expectedRevision:before.revision,resultingRevision:before.revision+1,reason:data.reason,evidence:data.evidence,recordedAt};
     const after={...before,revision:before.revision+1,consumed:before.consumed+a.quantity,outstanding:before.outstanding-a.quantity};
     await client.query(`INSERT INTO inventory_issue_outcomes(operation_id,organization_id,issue_id,production_batch_id,source_stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,epoch,reason,evidence,request_payload,result_payload,recorded_at,consumption_id,component_id) VALUES($1,$2,$3,$4,$5,$6,$7,'consume',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[a.operationId,actor.organization_id,i.id,i.production_batch_id,i.stock_id,actor.id,data.deviceId,a.quantity,before.revision,before.revision+1,epoch,data.reason,data.evidence,JSON.stringify({consumptionId:data.operationId,...a}),JSON.stringify({operationId:a.operationId,outcome,settlement:after}),recordedAt,data.operationId,a.componentId]);
    }
    return{status:'confirmed',operationId:data.operationId,consumption};
   });return reply.code(result.status==='duplicate'?200:201).send(result);
  }catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
}
