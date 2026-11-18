import type { PoolClient } from "pg";
import {
  issueBatchStep,
  issueFail,
  type IssueActor,
} from "./inventory-issue-scope.js";
export { rollContext } from "./coating-roll-scope.js";
export async function calenderedRollLot(
  client: PoolClient,
  actor: IssueActor,
  id: string,
  active = false,
) {
  const row = (
    await client.query(
      "SELECT l.*,c.actor_id,c.production_batch_id,c.step_number,c.request_payload,room_output_snapshot(l.organization_id,l.id) AS snapshot FROM inventory_room_output_lots l JOIN inventory_calendaring_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.calendaring_declaration_id WHERE l.organization_id=$1 AND l.id=$2",
      [actor.organization_id, id],
    )
  ).rows[0];
  if (!row) issueFail(404, "calendered_roll_not_found");
  const step = await issueBatchStep(
    client,
    actor,
    row.production_batch_id,
    row.step_number,
    actor.role === "chief",
    active,
  );
  if (
    step.stage !== "calendaring" ||
    (actor.role !== "chief" &&
      actor.role !== "master" &&
      row.actor_id !== actor.id)
  )
    issueFail(403, "calendered_roll_authority_required");
  return row;
}
export async function cuttingSuccessor(
  client: PoolClient,
  org: string,
  batch: string,
  sourceStep: number,
) {
  const row = (
    await client.query(
      `SELECT s.step_number,s.stage,s.workshop_id FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END WHERE b.organization_id=$1 AND b.id=$2 AND s.step_number>$3 ORDER BY s.step_number LIMIT 1`,
      [org, batch, sourceStep],
    )
  ).rows[0];
  if (!row || row.stage !== "cutting")
    issueFail(409, "approved_cutting_successor_required");
  return row;
}
