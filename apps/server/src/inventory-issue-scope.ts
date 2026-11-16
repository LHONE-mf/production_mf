import type { Pool, PoolClient } from 'pg';
import { authenticate } from './auth.js';
import { currentInventoryActor, inventoryStream, inventoryWriteFence } from './inventory-stream.js';
export class IssueError extends Error { constructor(public status: number, message: string) { super(message); } }
export function issueFail(status: number, code: string): never { throw new IssueError(status, code); }
export type IssueActor = { id: string; organization_id: string; role: string };
export async function issueWarehouseLevel(client: PoolClient, actor: IssueActor): Promise<'chief' | 'manager' | 'operator' | null> {
  if (actor.role === 'chief') return 'chief';
  const grant = await client.query('SELECT level FROM inventory_access WHERE organization_id=$1 AND user_id=$2 AND active FOR SHARE', [actor.organization_id, actor.id]);
  return grant.rows[0]?.level ?? null;
}
export async function issueMembership(client: PoolClient, org: string, user: string, workshop: string) {
  return !!(await client.query(`SELECT u.id FROM users u JOIN user_workshop_memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id WHERE u.organization_id=$1 AND u.id=$2 AND u.active AND m.workshop_id=$3 FOR SHARE OF u,m`, [org, user, workshop])).rowCount;
}
/** The workshop comes from the immutable approved batch route, never the request. */
export async function issueBatchStep(client: PoolClient, actor: IssueActor, batch: string, step: number, warehouse: boolean, active = true) {
  const found = await client.query(`SELECT b.id,b.batch_code,b.status,o.status AS order_status,s.workshop_id,s.name,s.stage
    FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
    JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version
    WHERE b.organization_id=$1 AND b.id=$2 AND s.step_number=$3 AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END FOR SHARE OF b,o,s`, [actor.organization_id, batch, step]);
  const row = found.rows[0]; if (!row) issueFail(404, 'production_step_not_found');
  if (!warehouse && !await issueMembership(client, actor.organization_id, actor.id, row.workshop_id)) issueFail(403, 'production_workshop_required');
  if (active && (!['created', 'in_progress'].includes(row.status) || !['released', 'in_progress'].includes(row.order_status))) issueFail(409, 'production_batch_unavailable');
  return row;
}
export function issueSnapshot(row: Record<string, unknown>) {
  return { id: row.id as string, materialId: row.material_id as string, productionBatchId: row.production_batch_id as string, stepNumber: row.step_number as number, workshopId: row.workshop_id as string, recipientId: row.recipient_id as string, requestedBy: row.requested_by as string, quantity: Number(row.quantity), unit: row.unit as string, state: row.state as string, revision: row.revision as number,
    ...(row.tape_specification ? {tapeSpecification: row.tape_specification, operationReference: row.operation_reference as string} : {}),
    stockId: row.stock_id as string | null, source: row.source_snapshot as object | null,
    approvalOperationId: row.approved_operation_id as string | null, approvedStockRevision: row.approved_stock_revision as number | null, approvedBy: row.approved_by as string | null, approvedDeviceId: row.approved_device_id as string | null,
    dispatchOperationId: row.dispatch_operation_id as string | null, receiptOperationId: row.receipt_operation_id as string | null };
}

export async function issueTransaction<T>(pool: Pool, authorization: string | undefined, proof: unknown, deviceId: string, write: boolean, epoch: unknown, task: (client: PoolClient, actor: IssueActor, level: Awaited<ReturnType<typeof issueWarehouseLevel>>, epoch: string) => Promise<T>) {
  const actor = await authenticate(pool, authorization); if (!actor) issueFail(401, 'unauthorized');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(write ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))' : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [actor.organization_id + ':inventory-sequence']);
    const current = await currentInventoryActor(client, actor.organization_id, actor.id, deviceId, authorization!, proof); if (!current) issueFail(403, 'current_device_proof_required');
    const level = await issueWarehouseLevel(client, current), stream = await inventoryStream(client, actor.organization_id);
    if (write) { const fence = await inventoryWriteFence(client, actor.organization_id, epoch); if (fence) issueFail(fence === 'inventory_epoch_required' ? 428 : 409, fence); }
    const result = await task(client, current, level, stream.epoch);
    // Production batch/step locks may wait independently of the inventory lock.
    // Row locks prevent revocation, but time can still expire the proof/session.
    // Roll back all effects rather than release a result under expired authority.
    if (!await currentInventoryActor(client, actor.organization_id, actor.id, deviceId, authorization!, proof)) issueFail(403, 'current_device_proof_required');
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export function issueHttpError(error: unknown) {
  if (error instanceof IssueError) return { status: error.status, body: { error: error.message } };
  const code = (error as { code?: string }).code;
  if (code === '23505') return { status: 409, body: { error: 'operation_id_reused' } };
  if (code === '23503') return { status: 409, body: { error: 'inventory_reference_changed' } };
  if (code === 'P0001' && ['inventory_issue_handoff_required','inventory_issue_stock_pair_required','issue_manager_required','inventory_tape_identity_immutable','inventory_tape_specification_mismatch','inventory_tape_operation_mismatch','inventory_tape_ack_mismatch'].includes((error as Error).message)) return {status:409,body:{error:'issue_handoff_ineligible'}};
  throw error;
}
