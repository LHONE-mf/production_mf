import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {authenticate} from './auth.js';
import {inventoryStockFromRow} from './inventory-snapshot.js';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';
const uuid=z.guid(),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),version=z.number().int().min(1).max(2147483646),text=z.string().trim().min(1).max(2000);
const stock=z.object({stockId:uuid,materialId:uuid,locationId:uuid,manufacturerLot:z.string().min(1).max(200),unit:z.enum(['mg','ul','mm','pieces']),quality:z.enum(['quarantine','released','blocked']),onHand:count,reserved:count,available:count,revision:version,disposition:z.enum(['release','hold','block','reject']).optional(),expiresAt:z.string().optional(),manufacturedOn:z.string().optional()}).strict();
const common=z.object({operationId:uuid,countId:uuid,deviceId:uuid,reason:text,evidence:text});
const body=z.discriminatedUnion('kind',[common.extend({kind:z.literal('open')}).strict(),common.extend({kind:z.literal('close')}).strict(),common.extend({kind:z.literal('observe'),stock,quantity:count}).strict(),common.extend({kind:z.literal('correct'),observationId:uuid,expectedRevision:version}).strict()]);
function snapshot(row:Record<string,unknown>){return{operationId:row.operation_id,countId:row.count_id,kind:row.kind,stockId:row.stock_id,observationId:row.observation_id,quantity:row.quantity===null?null:Number(row.quantity),expectedRevision:row.expected_revision,observedStock:row.observed_stock,actorId:row.actor_id,deviceId:row.device_id,reason:row.reason,evidence:row.evidence,recordedAt:(row.recorded_at as Date).toISOString()};}
function failure(error:unknown){if((error as{code?:string}).code==='P0001'&&['count_authority_required','count_not_found','count_closed','count_snapshot_unverified','count_observation_mismatch','inventory_count_pair_required'].includes((error as Error).message))return{status:409,body:{error:(error as Error).message}};return issueHttpError(error);}
export function registerInventoryCountRoutes(app:FastifyInstance,pool:Pool){
 app.post('/inventory/counts/operations',async(request,reply)=>{
  if(!await authenticate(pool,request.headers.authorization))return reply.code(401).send({error:'unauthorized'});const parsed=body.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'invalid_count_action'});const data=parsed.data;
  try{const result=await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,true,request.headers['x-inventory-epoch'],async(client,actor,level,epoch)=>{
   const manager=level==='chief'||level==='manager';if(!level||data.kind==='correct'&&!manager)issueFail(403,'count_authority_required');
   const prior=(await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_count_events WHERE operation_id=$1',[data.operationId,JSON.stringify(data)])).rows[0];if(prior){if(prior.organization_id!==actor.organization_id||prior.actor_id!==actor.id||prior.device_id!==data.deviceId||!prior.identical)issueFail(409,'operation_id_reused');return{status:'duplicate',...prior.result_payload};}
   if((await client.query('SELECT 1 FROM inventory_operations WHERE operation_id=$1 UNION ALL SELECT 1 FROM inventory_issue_events WHERE operation_id=$1 UNION ALL SELECT 1 FROM inventory_issue_outcomes WHERE operation_id=$1',[data.operationId])).rowCount)issueFail(409,'operation_id_reused');
   const opened=(await client.query("SELECT actor_id FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2 AND kind='open'",[actor.organization_id,data.countId])).rows[0];
   if(data.kind==='open'){if(opened)issueFail(409,'count_already_exists');}else if(!opened)issueFail(404,'count_not_found');
   if(data.kind==='close'&&!manager&&opened.actor_id!==actor.id)issueFail(403,'count_authority_required');
   if(['observe','close'].includes(data.kind)&&(await client.query("SELECT 1 FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2 AND kind='close'",[actor.organization_id,data.countId])).rowCount)issueFail(409,'count_closed');
   let stockId:string|null=null,observationId:string|null=null,quantity:number|null=null,expectedRevision:number|null=null,observedStock:unknown=null,resultStock:unknown=null;
   if(data.kind==='observe'){
    stockId=data.stock.stockId;quantity=data.quantity;expectedRevision=data.stock.revision;observedStock=data.stock;
    if(!(await client.query('SELECT 1 FROM inventory_operations WHERE organization_id=$1 AND stock_id=$2 AND resulting_revision=$3 AND result_stock=$4::jsonb',[actor.organization_id,stockId,expectedRevision,JSON.stringify(observedStock)])).rowCount)issueFail(409,'count_snapshot_unverified');
   }
   if(data.kind==='correct'){
    const observation=(await client.query("SELECT * FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2 AND operation_id=$3 AND kind='observe'",[actor.organization_id,data.countId,data.observationId])).rows[0];if(!observation)issueFail(404,'count_observation_not_found');
    if((await client.query("SELECT 1 FROM inventory_count_events WHERE organization_id=$1 AND observation_id=$2 AND kind='correct'",[actor.organization_id,data.observationId])).rowCount)issueFail(409,'count_already_corrected');
    stockId=observation.stock_id;observationId=data.observationId;quantity=Number(observation.quantity);expectedRevision=observation.expected_revision;observedStock=observation.observed_stock;
    const row=(await client.query('SELECT s.*,m.base_unit FROM inventory_stocks s JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s',[actor.organization_id,stockId])).rows[0];if(!row)issueFail(404,'stock_not_found');const current=inventoryStockFromRow(row),before={...current,available:current.onHand-current.reserved};
    const same=(await client.query('SELECT $1::jsonb=$2::jsonb AS same',[JSON.stringify(before),JSON.stringify(observedStock)])).rows[0].same;
    if(data.expectedRevision!==expectedRevision||current.revision!==expectedRevision||!same)issueFail(409,'count_revision_changed');
    if(quantity<current.reserved)issueFail(409,'count_below_reserved');const delta=quantity-current.onHand;if(!delta)issueFail(409,'count_no_discrepancy');
    resultStock={...before,onHand:quantity,available:quantity-current.reserved,revision:current.revision+1};await client.query('UPDATE inventory_stocks SET on_hand=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2',[actor.organization_id,stockId,quantity]);
    await client.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,request_payload,result_stock,from_location_id) VALUES($1,$2,$3,$4,$5,'count_adjustment',$6,$7,$8,$9,$10,$11,$12)",[data.operationId,actor.organization_id,stockId,actor.id,data.deviceId,Math.abs(delta),current.revision,current.revision+1,data.reason,JSON.stringify(data),JSON.stringify(resultStock),current.locationId]);
   }
   const recordedAt=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString(),event={operationId:data.operationId,countId:data.countId,kind:data.kind,stockId,observationId,quantity,expectedRevision,observedStock,actorId:actor.id,deviceId:data.deviceId,reason:data.reason,evidence:data.evidence,recordedAt},accepted={operationId:data.operationId,event,...(resultStock?{stock:resultStock}:{})};
   await client.query('INSERT INTO inventory_count_events(operation_id,organization_id,count_id,kind,actor_id,device_id,epoch,stock_id,observation_id,quantity,expected_revision,observed_stock,result_stock,request_payload,result_payload,reason,evidence,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',[data.operationId,actor.organization_id,data.countId,data.kind,actor.id,data.deviceId,epoch,stockId,observationId,quantity,expectedRevision,observedStock?JSON.stringify(observedStock):null,resultStock?JSON.stringify(resultStock):null,JSON.stringify(data),JSON.stringify(accepted),data.reason,data.evidence,recordedAt]);return{status:'confirmed',...accepted};
  });return reply.code(result.status==='duplicate'?200:201).send(result);}catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
 app.get('/inventory/counts',async(request,reply)=>{
  const q=z.object({deviceId:uuid,after:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().safeParse(request.query);if(!q.success)return reply.code(400).send({error:'invalid_count_page'});const data=q.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,false,undefined,async(client,actor,level,epoch)=>{if(!level)issueFail(403,'count_authority_required');const rows=(await client.query("SELECT c.count_id,c.actor_id,c.reason,c.evidence,c.recorded_at,EXISTS(SELECT 1 FROM inventory_count_events x WHERE x.organization_id=c.organization_id AND x.count_id=c.count_id AND x.kind='close') AS closed FROM inventory_count_events c WHERE c.organization_id=$1 AND c.kind='open' AND c.count_id>$2 ORDER BY c.count_id LIMIT $3",[actor.organization_id,data.after??'00000000-0000-0000-0000-000000000000',data.limit+1])).rows;const items=rows.slice(0,data.limit).map(r=>({countId:r.count_id,openedBy:r.actor_id,reason:r.reason,evidence:r.evidence,recordedAt:r.recorded_at.toISOString(),closed:r.closed}));return{epoch,items,hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?items.at(-1)!.countId:null};});}catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
 app.get('/inventory/counts/:countId/events',async(request,reply)=>{
  const sequence=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const p=z.object({countId:uuid}).strict().safeParse(request.params);
  const q=z.object({deviceId:uuid,after:sequence.default(0),until:sequence.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().safeParse(request.query);
  if(!p.success||!q.success)return reply.code(400).send({error:'invalid_count_history'});
  const data=q.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],data.deviceId,false,undefined,async(client,actor,level,epoch)=>{
   if(!level)issueFail(403,'count_authority_required');
   const countId=p.data.countId;
   if(!(await client.query("SELECT 1 FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2 AND kind='open'",[actor.organization_id,countId])).rowCount)issueFail(404,'count_not_found');
   const head=Number((await client.query('SELECT MAX(sequence)::text AS high FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2',[actor.organization_id,countId])).rows[0].high);
   if(!Number.isSafeInteger(head)||head<1)throw Error('invalid_count_sequence');
   const throughSequence=data.until??head;
   if(throughSequence>head||data.after>throughSequence)issueFail(409,'count_history_cursor_out_of_range');
   const rows=(await client.query('SELECT * FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2 AND sequence>$3 AND sequence<=$4 ORDER BY sequence LIMIT $5',[actor.organization_id,countId,data.after,throughSequence,data.limit+1])).rows;
   const closed=!!(await client.query("SELECT 1 FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2 AND kind='close' AND sequence<=$3",[actor.organization_id,countId,throughSequence])).rowCount;
   const items=rows.slice(0,data.limit).map(r=>({...snapshot(r),sequence:Number(r.sequence)}));
   return{epoch,throughSequence,closed,items,hasMore:rows.length>data.limit,nextAfter:rows.length>data.limit?items.at(-1)!.sequence:null};
  });}catch(error){const e=failure(error);return reply.code(e.status).send(e.body);}
 });
}
