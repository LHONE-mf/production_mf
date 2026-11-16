import type {PoolClient} from 'pg';
import {issueBatchStep, issueFail, issueHttpError, type IssueActor} from './inventory-issue-scope.js';
export async function custodySource(client: PoolClient, actor: IssueActor, id: string, active = false) {
  const row = (
    await client.query(
      'SELECT c.*,room_slurry_source_snapshot(c.organization_id,c.operation_id) AS snapshot FROM inventory_slurry_consumptions c WHERE organization_id=$1 AND operation_id=$2',
      [actor.organization_id, id],
    )
  ).rows[0];
  if (!row) issueFail(404, 'slurry_consumption_not_found');
  const step = await issueBatchStep(
    client,
    actor,
    row.production_batch_id,
    row.step_number,
    actor.role === 'chief',
    active,
  );
  if (
    step.stage !== 'slurry' ||
    (actor.role !== 'chief' && actor.role !== 'master' && row.actor_id !== actor.id)
  )
    issueFail(403, 'slurry_output_authority_required');
  return row;
}
export async function custodyLot(client: PoolClient, actor: IssueActor, id: string, active = false) {
  const row = (
    await client.query(
      `SELECT l.*,d.consumption_id,d.production_batch_id,d.step_number,room_output_snapshot(l.organization_id,l.id) AS snapshot
 FROM inventory_room_output_lots l JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id WHERE l.organization_id=$1 AND l.id=$2`,
      [actor.organization_id, id],
    )
  ).rows[0];
  if (!row) issueFail(404, 'room_output_not_found');
  await custodySource(client, actor, row.consumption_id, active);
  return row;
}
export async function coatingSuccessor(client: PoolClient, org: string, batch: string, sourceStep: number) {
  const row = (
    await client.query(
      `SELECT s.step_number,s.workshop_id,s.stage FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
 WHERE b.organization_id=$1 AND b.id=$2 AND s.step_number>$3 ORDER BY s.step_number LIMIT 1`,
      [org, batch, sourceStep],
    )
  ).rows[0];
  if (!row || row.stage !== 'coating') issueFail(409, 'approved_coating_successor_required');
  return row;
}
export async function custodyEligible(client: PoolClient, org: string, consumption: string) {
  if (
    !(await client.query('SELECT room_consumption_sources_eligible($1,$2) AS ok', [org, consumption])).rows[0]
      .ok
  )
    issueFail(409, 'room_source_held');
}
export async function custodyDuplicate(
  client: PoolClient,
  actor: IssueActor,
  table: 'inventory_coating_outputs' | 'inventory_room_outputs' | 'inventory_room_handoffs' | 'inventory_room_handoff_events',
  request: {operationId: string; deviceId: string},
  body: object,
  field: string,
) {
  const row = (
    await client.query(
      `SELECT *,request_payload=$2::jsonb AS identical FROM ${table} WHERE operation_id=$1`,
      [request.operationId, JSON.stringify(body)],
    )
  ).rows[0];
  if (!row) return null;
  if (
    row.organization_id !== actor.organization_id ||
    row.actor_id !== actor.id ||
    row.device_id !== request.deviceId ||
    !row.identical
  )
    issueFail(409, 'operation_id_reused');
  return {status: 'duplicate', operationId: request.operationId, [field]: row.result_payload};
}
export function custodyFailure(error: unknown) {
  if ((error as {code?: string}).code === 'P0001')
    return {status: 409, body: {error: 'room_custody_conflict'}};
  return issueHttpError(error);
}
