import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueFail,issueHttpError,issueTransaction} from './inventory-issue-scope.js';

const sequence=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const query=z.object({
 deviceId:z.guid(),after:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50),
 untilIssue:sequence.optional(),untilOutcome:sequence.optional(),
 productionBatchId:z.guid().optional(),recipientId:z.guid().optional(),
 materialId:z.guid().optional(),stockId:z.guid().optional(),
}).strict().refine(q=>(q.untilIssue===undefined)===(q.untilOutcome===undefined));
function exact(value:unknown):number{
 if(value===null||value===undefined||!/^\d+$/.test(String(value)))throw Error('invalid_reconciliation_quantity');
 const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_reconciliation_quantity');return n;
}
export function registerInventoryReconciliationRoutes(app:FastifyInstance,pool:Pool){
 app.get('/inventory/reports/reconciliation',async(request,reply)=>{
  const parsed=query.safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({error:'invalid_reconciliation_query'});
  const q=parsed.data;
  try{return await issueTransaction(pool,request.headers.authorization,request.headers['x-device-proof'],
   q.deviceId,false,undefined,async(client,actor,level,epoch)=>{
    if(!level)issueFail(403,'warehouse_access_required');
    const head=(await client.query(`SELECT
     (SELECT COALESCE(MAX(sequence),0)::text FROM inventory_issue_events WHERE organization_id=$1) AS issue,
     (SELECT COALESCE(MAX(sequence),0)::text FROM inventory_issue_outcomes WHERE organization_id=$1) AS outcome`,[actor.organization_id])).rows[0];
    const throughIssueSequence=q.untilIssue??exact(head.issue),throughOutcomeSequence=q.untilOutcome??exact(head.outcome);
    if(throughIssueSequence>exact(head.issue)||throughOutcomeSequence>exact(head.outcome))issueFail(409,'inventory_report_cursor_out_of_range');
    // Both streams are append-only. Select the accepted issue snapshot as of the
    // first page, rather than today's mutable issue projection or warehouse stock.
    const rows=(await client.query(`WITH latest AS (
     SELECT DISTINCT ON (issue_id) issue_id,result_issue AS issue
     FROM inventory_issue_events WHERE organization_id=$1 AND sequence<=$2
     ORDER BY issue_id,sequence DESC
    ) SELECT l.issue_id,l.issue,m.material_code,m.display_name,b.batch_code,u.login AS recipient_name,
     COALESCE(a.returned,0)::text AS returned,COALESCE(a.scrapped,0)::text AS scrapped,COALESCE(a.consumed,0)::text AS consumed
     FROM latest l
     JOIN inventory_materials m ON m.organization_id=$1 AND m.id=(l.issue->>'materialId')::uuid
     JOIN production_batches b ON b.organization_id=$1 AND b.id=(l.issue->>'productionBatchId')::uuid
     JOIN users u ON u.organization_id=$1 AND u.id=(l.issue->>'recipientId')::uuid
     LEFT JOIN LATERAL (
      SELECT SUM(quantity::numeric) FILTER(WHERE kind='return') AS returned,
       SUM(quantity::numeric) FILTER(WHERE kind='scrap') AS scrapped,SUM(quantity::numeric) FILTER(WHERE kind='consume') AS consumed
      FROM inventory_issue_outcomes WHERE organization_id=$1 AND issue_id=l.issue_id AND sequence<=$3
     ) a ON true
     WHERE l.issue->>'state'='received' AND ($4::uuid IS NULL OR l.issue_id>$4)
      AND ($5::uuid IS NULL OR (l.issue->>'productionBatchId')::uuid=$5)
      AND ($6::uuid IS NULL OR (l.issue->>'recipientId')::uuid=$6)
      AND ($7::uuid IS NULL OR (l.issue->>'materialId')::uuid=$7)
      AND ($8::uuid IS NULL OR (l.issue->>'stockId')::uuid=$8)
     ORDER BY l.issue_id LIMIT $9`,[actor.organization_id,throughIssueSequence,throughOutcomeSequence,
      q.after??null,q.productionBatchId??null,q.recipientId??null,q.materialId??null,q.stockId??null,q.limit+1])).rows;
    const items=rows.slice(0,q.limit).map(row=>{
     const i=row.issue,issued=exact(i.quantity),returned=exact(row.returned),scrapped=exact(row.scrapped),consumed=exact(row.consumed);
     if(BigInt(returned)+BigInt(scrapped)+BigInt(consumed)>BigInt(issued))throw Error('invalid_reconciliation_balance');
     return{issueId:row.issue_id,stockId:i.stockId,materialId:i.materialId,productionBatchId:i.productionBatchId,
      stepNumber:i.stepNumber,recipientId:i.recipientId,workshopId:i.workshopId,
      manufacturerLot:i.source.manufacturerLot,unit:i.unit,materialCode:row.material_code,
      materialName:row.display_name,batchCode:row.batch_code,recipientName:row.recipient_name,
      dispatchOperationId:i.dispatchOperationId,receiptOperationId:i.receiptOperationId,
      issued,returned,scrapped,consumed:consumed||null,consumptionStatus:consumed?'recorded':'not_recorded',outstanding:issued-returned-scrapped-consumed};
    });
    return{epoch,throughIssueSequence,throughOutcomeSequence,items,hasMore:rows.length>q.limit,
     nextAfter:rows.length>q.limit?items[items.length-1].issueId:null};
   });}catch(error){const e=issueHttpError(error);return reply.code(e.status).send(e.body);}
 });
}
