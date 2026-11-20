import type {PoolClient} from 'pg';
import {z} from 'zod';
import {issueBatchStep,issueFail,issueMembership,type IssueActor} from './inventory-issue-scope.js';

/** Read-only preflight. Its result is NOT a reservation or a custody grant. */
export interface SortingAssemblySourceQuery {
 submissionId:string;
 grade:string;
 assemblyBatchId:string;
 assemblyStepNumber:number;
 recipientId:string;
}
export async function checkSortingAssemblySource(
 client:PoolClient,actor:IssueActor,q:SortingAssemblySourceQuery,
){
 if(!['chief','master'].includes(actor.role))issueFail(403,'sorting_supervisor_required');

 // Never take identity or measured quantities from a phone-provided SortRun.
 const row=(await client.query(`SELECT l.grade,l.material_id,l.quantity,
     s.production_batch_id,s.step_number,s.source_cut_id,
     s.request_payload->'source'->>'cuttingReceiptId' AS cutting_receipt_id,
     s.request_payload->'source'->>'inputCount' AS input_count
   FROM inventory_output_lines l
   JOIN inventory_output_submissions s ON s.organization_id=l.organization_id
    AND s.operation_id=l.submission_id
   WHERE l.organization_id=$1 AND l.submission_id=$2 AND l.grade=$3
   FOR SHARE OF l,s`,
   [actor.organization_id,q.submissionId,q.grade])).rows[0];
 if(!row)issueFail(404,'sorting_output_grade_not_found');

 const source=await issueBatchStep(client,actor,row.production_batch_id,row.step_number,actor.role==='chief',false);
 if(source.stage!=='sorting'||!['in_progress','completed'].includes(source.status)||
    !['released','in_progress','completed'].includes(source.order_status))
   issueFail(409,'sorting_source_step_unavailable');
 const count=Number(row.quantity),receivedCount=Number(row.input_count);
 if(!Number.isSafeInteger(count)||count<1)issueFail(409,'sorting_grade_quantity_invalid');
 if(!z.guid().safeParse(row.cutting_receipt_id).success ||
    row.source_cut_id!=='received:'+row.cutting_receipt_id ||
    !Number.isSafeInteger(receivedCount)||receivedCount<1)
   issueFail(409,'confirmed_cutting_receipt_required');

 // A saved submission can describe a receipt that never happened. Check the
 // actual immutable server event and its exact physical count, source and scope.
 const received=await client.query(`SELECT e.operation_id
   FROM inventory_room_handoff_events e
   JOIN inventory_room_handoffs h ON h.organization_id=e.organization_id AND h.operation_id=e.handoff_id
   JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id
   JOIN inventory_cutting_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.cutting_declaration_id
   JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id
   JOIN users receiver ON receiver.organization_id=h.organization_id AND receiver.id=h.recipient_id AND receiver.active
   JOIN user_workshop_memberships membership ON membership.organization_id=h.organization_id
    AND membership.user_id=h.recipient_id AND membership.workshop_id=h.recipient_workshop_id
   WHERE e.organization_id=$1 AND e.operation_id=$2 AND e.kind='receive'
    AND e.actor_id=h.recipient_id AND e.observed_quantity=h.quantity AND e.observed_quantity=$6
    AND e.result_payload->>'custodyEffect'='received'
    AND e.result_payload->>'observedLotLabel'=h.output_snapshot->'lot'->>'label'
    AND h.output_snapshot->>'unit'='pieces' AND h.output_snapshot->'lot'->>'disposition'='ready'
    AND h.production_batch_id=$3 AND c.production_batch_id=$3
    AND h.destination_step=$4 AND h.recipient_workshop_id=$5
    AND m.active AND m.base_unit='pieces' AND m.category='electrode'
    AND cutting_output_inputs_eligible(c.organization_id,c.request_payload)
   FOR SHARE OF e,h,l,c,m,receiver,membership`,
  [actor.organization_id,row.cutting_receipt_id,row.production_batch_id,row.step_number,source.workshop_id,receivedCount]);
 if(!received.rowCount)issueFail(409,'cutting_receipt_source_unavailable');

 const target=await issueBatchStep(client,actor,q.assemblyBatchId,q.assemblyStepNumber,true,false);
 if(target.stage!=='assembly'||!['created','in_progress'].includes(target.status)||
    !['released','in_progress'].includes(target.order_status)||
    !await issueMembership(client,actor.organization_id,q.recipientId,target.workshop_id))
   issueFail(409,'assembly_route_or_receiver_required');

 // Same approved order, same route/version, electrode source -> cell batch.
 // Merely having two individually valid steps is insufficient.
 const connected=await client.query(`SELECT 1 FROM production_batches s
   JOIN production_batches t ON t.organization_id=s.organization_id AND t.order_id=s.order_id
   JOIN production_orders o ON o.organization_id=s.organization_id AND o.id=s.order_id
   WHERE s.organization_id=$1 AND s.id=$2 AND t.id=$3
    AND s.material_line IN ('cathode','anode') AND t.material_line='cell'
    AND $4::int<$5::int
    AND EXISTS(SELECT 1 FROM process_route_steps rs
     WHERE rs.organization_id=o.organization_id AND rs.route_id=o.route_id
      AND rs.route_version=o.route_version AND rs.step_number=$4 AND rs.stage='sorting'
      AND rs.electrode_line=s.material_line)
    AND EXISTS(SELECT 1 FROM process_route_steps rt
     WHERE rt.organization_id=o.organization_id AND rt.route_id=o.route_id
      AND rt.route_version=o.route_version AND rt.step_number=$5 AND rt.stage='assembly'
      AND rt.electrode_line='common')
   FOR SHARE OF s,t,o`,
  [actor.organization_id,row.production_batch_id,q.assemblyBatchId,row.step_number,q.assemblyStepNumber]);
 if(!connected.rowCount)issueFail(409,'sorting_assembly_route_mismatch');

 const material=await client.query(`SELECT id FROM inventory_materials
    WHERE organization_id=$1 AND id=$2 AND active AND category='electrode' AND base_unit='pieces'
    FOR SHARE`,[actor.organization_id,row.material_id]);
 if(!material.rowCount)issueFail(409,'electrode_material_required');

 const occupied=await client.query(`SELECT EXISTS(
   SELECT 1 FROM inventory_output_acceptances
    WHERE organization_id=$1 AND submission_id=$2 AND grade=$3
   UNION ALL
   SELECT 1 FROM inventory_assembly_electrode_handoffs
    WHERE organization_id=$1 AND submission_id=$2 AND grade=$3
  ) AS occupied`,[actor.organization_id,q.submissionId,q.grade]);
 if(occupied.rows[0]?.occupied!==false)issueFail(409,'sorting_grade_already_claimed');

 return{eligible:true as const,submissionId:q.submissionId,grade:row.grade,
  quantity:count,unit:'pieces' as const,sourceBatchId:row.production_batch_id,
  sourceStepNumber:row.step_number,materialId:row.material_id,
  assemblyBatchId:q.assemblyBatchId,assemblyStepNumber:q.assemblyStepNumber,
  recipientId:q.recipientId,reservationEffect:'none' as const};
}
