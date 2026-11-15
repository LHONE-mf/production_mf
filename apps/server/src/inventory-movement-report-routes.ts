import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';

// Read-only ledger reporting: independent of local journals, caches and queues.
// Each page is bound to an immutable upper event sequence selected on the first read.
const safe=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const params=z.object({
 deviceId:z.guid(),after:safe.default(0),until:safe.optional(),
 limit:z.coerce.number().int().min(1).max(100).default(50),
 stockId:z.guid().optional(),materialId:z.guid().optional(),locationId:z.guid().optional(),
 productionBatchId:z.guid().optional(),actorId:z.guid().optional(),
 manufacturerLot:z.string().trim().min(1).max(200).optional(),
 kind:z.string().regex(/^[a-z][a-z_]{0,39}$/).optional(),
 from:z.iso.date().optional(),through:z.iso.date().optional(),
}).strict();
function count(raw:unknown):number{
 if(raw===null||raw===undefined||raw==='')throw Error('invalid_inventory_report_sequence');
 const n=Number(raw);
 if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_inventory_report_sequence');
 return n;
}
export function registerInventoryMovementReportRoutes(app:FastifyInstance,pool:Pool){
 app.get('/inventory/reports/movements',async(request,reply)=>{
  const parsed=params.safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_movement_report_query'});
  const q=parsed.data;
  if(q.from&&q.through&&q.through<q.from)
    return reply.code(400).send({error:'invalid_movement_report_dates'});
  try{
   return await issueTransaction(pool,request.headers.authorization,
    request.headers['x-device-proof'],q.deviceId,false,undefined,
    async(client,actor,level,epoch)=>{
     if(!level)issueFail(403,'warehouse_access_required');
     const head=(await client.query(`SELECT COALESCE(MAX(sequence),0)::text AS high
       FROM inventory_operations WHERE organization_id=$1`,[actor.organization_id])).rows[0];
     const upper=q.until??count(head.high);
     if(upper>count(head.high)||q.after>upper)issueFail(409,'inventory_report_cursor_out_of_range');
     // Freeze event identity by the immutable ledger sequence. Historical location
     // and maker lot come from its accepted result_stock, not today's stock row.
     const result=await client.query(`SELECT o.sequence,o.operation_id,o.stock_id,o.kind,
       o.quantity,o.recorded_at,o.actor_id,o.device_id,o.reason,o.production_batch_id,
       o.from_location_id,o.to_location_id,
       o.result_stock->>'onHand' AS on_hand_after,
       o.result_stock->>'reserved' AS reserved_after,
       s.material_id,o.result_stock->>'manufacturerLot' AS manufacturer_lot,
       o.result_stock->>'locationId' AS location_id,
       m.material_code,m.display_name,m.base_unit,
       CASE
        WHEN o.kind='quality_change' AND qa.operation_id IS NOT NULL THEN jsonb_build_object(
         'type','quality','disposition',qa.disposition,'evidence',qa.evidence)
        WHEN o.kind='count_adjustment' AND observation.operation_id IS NOT NULL THEN jsonb_build_object(
         'type','count','countId',correction.count_id,'observationId',observation.operation_id,
         'recordedOnHand',observation.observed_stock->'onHand','countedOnHand',observation.quantity,
         'observedRevision',observation.expected_revision,'observedBy',observation.actor_id,
         'observedDeviceId',observation.device_id,'observedAt',observation.recorded_at,
         'observationEvidence',observation.evidence,'evidence',correction.evidence)
        WHEN o.kind IN ('split_in','split_out') AND split.operation_id IS NOT NULL THEN jsonb_build_object(
         'type','split','parentStockId',split.parent_stock_id,'childStockId',split.child_stock_id,
         'parentOperationId',split.operation_id,'childOperationId',split.child_operation_id,
         'parentOnHandBefore',split.parent_before->'onHand','parentOnHandAfter',split.parent_after->'onHand',
         'evidence',split.evidence)
        WHEN o.kind='return' AND returned.operation_id IS NOT NULL THEN jsonb_build_object(
         'type','return','sourceStockId',returned.source_stock_id,'issueId',returned.issue_id,'evidence',returned.evidence)
        ELSE NULL END AS audit
       FROM inventory_operations o
       LEFT JOIN inventory_stocks s ON s.organization_id=o.organization_id AND s.id=o.stock_id
       LEFT JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id
       LEFT JOIN inventory_quality_dispositions qa ON qa.organization_id=o.organization_id AND qa.operation_id=o.operation_id
       LEFT JOIN inventory_count_events correction ON correction.organization_id=o.organization_id AND correction.operation_id=o.operation_id AND correction.kind='correct'
       LEFT JOIN inventory_count_events observation ON observation.organization_id=correction.organization_id AND observation.operation_id=correction.observation_id AND observation.kind='observe'
       LEFT JOIN inventory_splits split ON split.organization_id=o.organization_id AND (split.operation_id=o.operation_id OR split.child_operation_id=o.operation_id)
       LEFT JOIN inventory_issue_outcomes returned ON returned.organization_id=o.organization_id AND returned.operation_id=o.operation_id AND returned.kind='return'
       WHERE o.organization_id=$1 AND o.sequence>$2 AND o.sequence<=$3
         AND ($4::uuid IS NULL OR o.stock_id=$4)
         AND ($5::uuid IS NULL OR s.material_id=$5)
         AND ($6::uuid IS NULL OR o.production_batch_id=$6)
         AND ($7::uuid IS NULL OR o.actor_id=$7)
         AND ($8::text IS NULL OR o.kind=$8)
         AND ($9::date IS NULL OR o.recorded_at >= ($9::date::timestamp AT TIME ZONE 'UTC'))
         AND ($10::date IS NULL OR o.recorded_at < (($10::date+INTERVAL '1 day')::timestamp AT TIME ZONE 'UTC'))
         AND ($12::text IS NULL OR o.result_stock->>'manufacturerLot'=$12)
         AND ($13::uuid IS NULL OR (o.result_stock->>'locationId')::uuid=$13)
       ORDER BY o.sequence LIMIT $11`,
       [actor.organization_id,q.after,upper,q.stockId??null,q.materialId??null,
        q.productionBatchId??null,q.actorId??null,q.kind??null,q.from??null,q.through??null,q.limit+1,q.manufacturerLot??null,q.locationId??null]);
     const slice=result.rows.slice(0,q.limit);
     const items=slice.map(row=>{
      if(['quality_change','count_adjustment','split_in','split_out','return'].includes(row.kind)&&!row.audit)
       throw Error('inventory_report_audit_missing');
      if(row.audit?.type==='count')row.audit.observedAt=new Date(row.audit.observedAt).toISOString();
      return{
       sequence:count(row.sequence),operationId:String(row.operation_id),
       stockId:String(row.stock_id),kind:String(row.kind),quantity:count(row.quantity),
       onHandAfter:count(row.on_hand_after),reservedAfter:count(row.reserved_after),
       recordedAt:new Date(row.recorded_at).toISOString(),
       actorId:String(row.actor_id),deviceId:String(row.device_id),
       reason:String(row.reason),productionBatchId:row.production_batch_id??null,
       materialId:row.material_id??null,materialCode:row.material_code??null,
       materialName:row.display_name??null,manufacturerLot:row.manufacturer_lot??null,
       locationId:row.location_id??null,
       fromLocationId:row.from_location_id??null,toLocationId:row.to_location_id??null,
       unit:row.base_unit??null,
       audit:row.audit,
      };
     });
     return{epoch,throughSequence:upper,items,hasMore:result.rows.length>q.limit,
       nextAfter:items.length?items[items.length-1].sequence:q.after};
    });
  }catch(error){const found=issueHttpError(error);return reply.code(found.status).send(found.body);}
 });
}
