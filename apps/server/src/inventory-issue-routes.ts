import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { inventoryStockFromRow } from './inventory-snapshot.js';
import { transitionInventory } from './inventoryDomain.js';
import { issueTransaction, issueHttpError, issueFail, issueWarehouseLevel, issueMembership, issueBatchStep, issueSnapshot, type IssueActor } from './inventory-issue-scope.js';
import { registerInventoryIssueReads } from './inventory-issue-reads.js';
const id = z.guid(), revision = z.number().int().min(1).max(2147483646), text = z.string().trim().min(1).max(2000);
const common = z.object({ operationId: id, deviceId: id, reason: text, evidence: text });
const create = common.extend({ issueId: id, materialId: id, productionBatchId: id, stepNumber: z.number().int().min(1).max(2147483647), recipientId: id, quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const action = common.extend({ expectedIssueRevision: revision });
const operation = z.discriminatedUnion('kind', [
  action.extend({ kind: z.literal('reserve'), stockId: id, expectedStockRevision: revision }).strict(),
  action.extend({ kind: z.literal('approve'), expectedStockRevision: revision }).strict(),
  action.extend({ kind: z.literal('dispatch'), expectedStockRevision: revision }).strict(),
  action.extend({ kind: z.literal('receive') }).strict(), action.extend({ kind: z.literal('cancel'), expectedStockRevision: revision.optional() }).strict(),
]);
async function duplicate(client: PoolClient, actor: IssueActor, data: { operationId: string; deviceId: string }, payload: object) {
  const found = await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_issue_events WHERE operation_id=$1', [data.operationId, JSON.stringify(payload)]);
  if (!found.rowCount) {
    if ((await client.query('SELECT 1 FROM inventory_operations WHERE operation_id=$1', [data.operationId])).rowCount) issueFail(409, 'operation_id_reused');
    return null;
  }
  const row = found.rows[0]; if (row.organization_id !== actor.organization_id || row.actor_id !== actor.id || row.device_id !== data.deviceId || !row.identical) issueFail(409, 'operation_id_reused');
  return { status: 'duplicate', operationId: data.operationId, issue: row.result_issue, ...(row.result_stock ? { stock: row.result_stock } : {}) };
}
async function event(client: PoolClient, actor: IssueActor, epoch: string, data: { operationId: string; deviceId: string; reason: string; evidence: string }, kind: string, before: number, issue: ReturnType<typeof issueSnapshot>, payload: object, stock?: object) {
  await client.query(`INSERT INTO inventory_issue_events(operation_id,organization_id,issue_id,actor_id,device_id,kind,expected_revision,resulting_revision,epoch,reason,evidence,stock_effect,request_payload,result_issue,result_stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [data.operationId, actor.organization_id, issue.id, actor.id, data.deviceId, kind, before, issue.revision, epoch, data.reason, data.evidence, !!stock, JSON.stringify(payload), JSON.stringify(issue), stock ? JSON.stringify(stock) : null]);
  return { status: 'confirmed', operationId: data.operationId, issue, ...(stock ? { stock } : {}) };
}
export function registerInventoryIssueRoutes(app: FastifyInstance, pool: Pool) {
  registerInventoryIssueReads(app, pool);
  app.post('/inventory/issues', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = create.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: 'invalid_issue_request' });
    const data = parsed.data;
    try {
      const result = await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, true, request.headers['x-inventory-epoch'], async (client, actor, level, epoch) => {
        const step = await issueBatchStep(client, actor, data.productionBatchId, data.stepNumber, !!level, false);
        const prior = await duplicate(client, actor, data, data); if (prior) return prior;
        await issueBatchStep(client, actor, data.productionBatchId, data.stepNumber, !!level);
        if (!await issueMembership(client, actor.organization_id, data.recipientId, step.workshop_id)) issueFail(409, 'recipient_workshop_required');
        const material = (await client.query('SELECT base_unit FROM inventory_materials WHERE organization_id=$1 AND id=$2 AND active FOR SHARE', [actor.organization_id, data.materialId])).rows[0]; if (!material) issueFail(404, 'material_not_found');
        const inserted = await client.query(`INSERT INTO inventory_issues(id,organization_id,material_id,production_batch_id,step_number,workshop_id,recipient_id,requested_by,quantity,unit,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested') RETURNING *`, [data.issueId, actor.organization_id, data.materialId, data.productionBatchId, data.stepNumber, step.workshop_id, data.recipientId, actor.id, data.quantity, material.base_unit]);
        return event(client, actor, epoch, data, 'request', 0, issueSnapshot(inserted.rows[0]), data);
      }); return reply.code(result.status === 'duplicate' ? 200 : 201).send(result);
    } catch (error) { const failure = issueHttpError(error); return reply.code(failure.status).send(failure.body); }
  });
  app.post('/inventory/issues/:issueId/operations', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = operation.safeParse(request.body), target = z.object({ issueId: id }).strict().safeParse(request.params); if (!parsed.success || !target.success) return reply.code(400).send({ error: 'invalid_issue_operation' });
    const data = parsed.data, issueId = target.data.issueId, payload = { ...data, issueId };
    try {
      const result = await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, true, request.headers['x-inventory-epoch'], async (client, actor, level, epoch) => {
        const privileged = level === 'chief' || level === 'manager';
        if (['reserve', 'approve', 'dispatch'].includes(data.kind) && !privileged) issueFail(403, 'issue_manager_required');
        const row = (await client.query('SELECT * FROM inventory_issues WHERE organization_id=$1 AND id=$2 FOR UPDATE', [actor.organization_id, issueId])).rows[0]; if (!row) issueFail(404, 'issue_not_found');
        if (!level && (!(row.requested_by === actor.id || row.recipient_id === actor.id) || !await issueMembership(client, actor.organization_id, actor.id, row.workshop_id))) issueFail(404, 'issue_not_found');
        if (data.kind === 'receive' && (row.recipient_id !== actor.id || !await issueMembership(client, actor.organization_id, actor.id, row.workshop_id))) issueFail(403, 'assigned_recipient_required');
        if (data.kind === 'cancel' && !privileged && (row.requested_by !== actor.id || row.stock_id)) issueFail(403, 'issue_manager_required');
        const prior = await duplicate(client, actor, data, payload); if (prior) return prior;
        if (row.revision !== data.expectedIssueRevision) issueFail(409, 'issue_revision_conflict');
        if (data.kind === 'receive' ? row.state !== 'dispatched' : data.kind === 'reserve' ? row.state !== 'requested' : data.kind === 'approve' ? !['reserved', 'approved'].includes(row.state) : data.kind === 'dispatch' ? row.state !== 'approved' : !['requested', 'reserved', 'approved'].includes(row.state)) issueFail(409, 'issue_state_conflict');
        if (['reserve', 'approve', 'dispatch'].includes(data.kind)) {
          const step = await issueBatchStep(client, actor, row.production_batch_id, row.step_number, true);
          if (step.workshop_id !== row.workshop_id) issueFail(409, 'issue_production_scope_changed');
          if (!await issueMembership(client, actor.organization_id, row.recipient_id, row.workshop_id)) issueFail(409, 'recipient_workshop_required');
        }
        let snapshot: object | undefined;
        if (data.kind === 'reserve' || data.kind === 'approve' || data.kind === 'dispatch' || (data.kind === 'cancel' && row.stock_id)) {
          const stockId = data.kind === 'reserve' ? data.stockId : row.stock_id;
          const stockRow = (await client.query(`SELECT s.*,m.base_unit,(s.expires_at IS NULL OR s.expires_at>clock_timestamp()) AS unexpired FROM inventory_stocks s JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s`, [actor.organization_id, stockId])).rows[0]; if (!stockRow) issueFail(404, 'stock_not_found');
          const current = inventoryStockFromRow(stockRow);
          if (data.kind === 'cancel' && data.expectedStockRevision !== current.revision) issueFail(409, 'revision_conflict');
          if (current.materialId !== row.material_id || current.unit !== row.unit) issueFail(409, 'issue_material_mismatch');
          if (data.kind !== 'cancel' && (current.revision !== data.expectedStockRevision || current.quality !== 'released' || !stockRow.unexpired)) issueFail(409, current.revision !== data.expectedStockRevision ? 'revision_conflict' : !stockRow.unexpired ? 'expired' : 'blocked');
          const reservation = data.kind === 'reserve' ? null : (await client.query('SELECT quantity FROM inventory_reservations WHERE organization_id=$1 AND id=$2 AND issue_id=$2 AND stock_id=$3 AND production_batch_id=$4 FOR UPDATE', [actor.organization_id, issueId, stockId, row.production_batch_id])).rows[0];
          if (data.kind !== 'reserve' && (!reservation || Number(reservation.quantity) !== Number(row.quantity))) issueFail(409, 'issue_reservation_missing');
          if (data.kind === 'dispatch') {
            if (row.approved_stock_revision !== current.revision) issueFail(409, 'issue_approval_stale');
            const approver = (await client.query(`SELECT u.id,u.organization_id,u.role FROM users u JOIN devices d ON d.organization_id=u.organization_id AND d.user_id=u.id WHERE u.organization_id=$1 AND u.id=$2 AND u.active AND d.id=$3 AND d.revoked_at IS NULL FOR SHARE OF u,d`, [actor.organization_id, row.approved_by, row.approved_device_id])).rows[0];
            if (!approver || !['chief', 'manager'].includes(await issueWarehouseLevel(client, approver) ?? '')) issueFail(409, 'issue_approval_revoked');
          }
          if (data.kind === 'approve') {
            Object.assign(row, { approved_operation_id: data.operationId, approved_stock_revision: current.revision, approved_by: actor.id, approved_device_id: data.deviceId });
          } else {
            const kind = data.kind === 'reserve' ? 'reserve' : data.kind === 'dispatch' ? 'issue' : 'release_reservation';
            const outcome = transitionInventory(current, { operationId: data.operationId, stockId, kind, actorId: actor.id, expectedRevision: current.revision, quantity: Number(row.quantity), productionBatchId: row.production_batch_id, reason: data.reason }, { mayAdjust: false, mayIssue: data.kind === 'dispatch' && privileged, ownedReservation: reservation ? Number(reservation.quantity) : undefined });
            if (!outcome.ok) issueFail(409, outcome.code);
            snapshot = { ...outcome.stock, available: outcome.available };
            if (data.kind === 'reserve') {
              await client.query('INSERT INTO inventory_reservations(id,organization_id,stock_id,production_batch_id,quantity,issue_id) VALUES($1,$2,$3,$4,$5,$1)', [issueId, actor.organization_id, stockId, row.production_batch_id, row.quantity]);
              Object.assign(row, { stock_id: stockId, source_snapshot: { stockId, materialId: current.materialId, manufacturerLot: current.manufacturerLot, locationId: current.locationId, unit: current.unit, quality: current.quality, ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}), ...(current.manufacturedOn ? { manufacturedOn: current.manufacturedOn } : {}) } });
            } else await client.query('DELETE FROM inventory_reservations WHERE organization_id=$1 AND issue_id=$2', [actor.organization_id, issueId]);
            await client.query('UPDATE inventory_stocks SET on_hand=$3,reserved=$4,revision=$5 WHERE organization_id=$1 AND id=$2', [actor.organization_id, stockId, outcome.stock.onHand, outcome.stock.reserved, outcome.stock.revision]);
            await client.query(`INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,production_batch_id,request_payload,result_stock,from_location_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [data.operationId, actor.organization_id, stockId, actor.id, data.deviceId, kind, row.quantity, current.revision, outcome.stock.revision, data.reason, row.production_batch_id, JSON.stringify(payload), JSON.stringify(snapshot), current.locationId]);
          }
        }
        row.state = ({ reserve: 'reserved', approve: 'approved', dispatch: 'dispatched', receive: 'received', cancel: 'cancelled' } as const)[data.kind]; row.revision++;
        if (data.kind === 'dispatch') row.dispatch_operation_id = data.operationId;
        if (data.kind === 'receive') row.receipt_operation_id = data.operationId;
        await client.query(`UPDATE inventory_issues SET state=$3,revision=$4,stock_id=$5,source_snapshot=$6,approved_operation_id=$7,approved_stock_revision=$8,approved_by=$9,approved_device_id=$10,dispatch_operation_id=$11,receipt_operation_id=$12,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2`, [actor.organization_id, issueId, row.state, row.revision, row.stock_id, row.source_snapshot ? JSON.stringify(row.source_snapshot) : null, row.approved_operation_id, row.approved_stock_revision, row.approved_by, row.approved_device_id, row.dispatch_operation_id, row.receipt_operation_id]);
        return event(client, actor, epoch, data, data.kind, data.expectedIssueRevision, issueSnapshot(row), payload, snapshot);
      }); return reply.code(result.status === 'duplicate' ? 200 : 201).send(result);
    } catch (error) { const failure = issueHttpError(error); return reply.code(failure.status).send(failure.body); }
  });
}
