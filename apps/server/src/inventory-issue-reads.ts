import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { inventoryStockFromRow } from './inventory-snapshot.js';
import { issueTransaction, issueHttpError, issueFail, issueSnapshot, issueBatchStep, type IssueActor } from './inventory-issue-scope.js';
const uuid = z.guid(), zero = '00000000-0000-0000-0000-000000000000';
const page = z.object({ deviceId: uuid, after: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const batchPage = page.extend({ afterStep: z.coerce.number().int().min(0).max(2147483647).default(0) }).strict();
const options = page.extend({ productionBatchId: uuid, stepNumber: z.coerce.number().int().min(1).max(2147483647), resource: z.enum(['materials', 'recipients']) }).strict();
const history = z.object({ deviceId: uuid, after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
async function visibleIssue(client: PoolClient, actor: IssueActor, warehouse: boolean, issueId: string) {
  const row = (await client.query(`SELECT i.* FROM inventory_issues i WHERE i.organization_id=$1 AND i.id=$2 AND ($3::boolean OR ((i.requested_by=$4 OR i.recipient_id=$4) AND EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=i.organization_id AND m.user_id=$4 AND m.workshop_id=i.workshop_id)))`, [actor.organization_id, issueId, warehouse, actor.id])).rows[0];
  if (!row) issueFail(404, 'issue_not_found'); return row;
}
function paged<T>(rows: T[], limit: number, epoch: string, cursor: (row: T) => string | number) { const items = rows.slice(0, limit), hasMore = rows.length > limit; return { epoch, items, hasMore, nextAfter: hasMore ? cursor(items[items.length - 1]) : null }; }
export function registerInventoryIssueReads(app: FastifyInstance, pool: Pool) {
  app.get('/inventory/issues/context', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = z.object({ deviceId: uuid }).strict().safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: 'invalid_issue_context' });
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], parsed.data.deviceId, false, undefined, async (client, actor, level, epoch) => ({ organizationId: actor.organization_id, actorId: actor.id, deviceId: parsed.data.deviceId, warehouseLevel: level, epoch, postingEnabled: (await client.query('SELECT posting_enabled FROM inventory_streams WHERE organization_id=$1', [actor.organization_id])).rows[0].posting_enabled })); }
    catch (error) { const e = issueHttpError(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/issue-batches', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = batchPage.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: 'invalid_issue_batch_page' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      const rows = (await client.query(`SELECT b.id,b.batch_code,s.step_number,s.name,s.stage,s.workshop_id FROM production_batches b JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version WHERE b.organization_id=$1 AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END AND (b.id,s.step_number)>($2::uuid,$3::integer) AND ($4::boolean OR EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=b.organization_id AND m.user_id=$5 AND m.workshop_id=s.workshop_id)) ORDER BY b.id,s.step_number LIMIT $6`, [actor.organization_id, data.after ?? zero, data.afterStep, !!level, actor.id, data.limit + 1])).rows.map(r => ({ id: r.id as string, batchCode: r.batch_code as string, stepNumber: r.step_number as number, name: r.name as string, stage: r.stage as string, workshopId: r.workshop_id as string }));
      const result = paged(rows, data.limit, epoch, r => r.id); return { ...result, nextStep: result.hasMore ? result.items[result.items.length - 1].stepNumber : null };
    }); } catch (error) { const e = issueHttpError(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/issue-options', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = options.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: 'invalid_issue_options' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      const step = await issueBatchStep(client, actor, data.productionBatchId, data.stepNumber, !!level);
      const rows = data.resource === 'materials' ? (await client.query('SELECT id,material_code AS code,display_name AS name,base_unit AS unit FROM inventory_materials WHERE organization_id=$1 AND active AND id>$2 ORDER BY id LIMIT $3', [actor.organization_id, data.after ?? zero, data.limit + 1])).rows : (await client.query('SELECT u.id,u.login AS name FROM users u JOIN user_workshop_memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id WHERE u.organization_id=$1 AND u.active AND m.workshop_id=$2 AND u.id>$3 ORDER BY u.id LIMIT $4', [actor.organization_id, step.workshop_id, data.after ?? zero, data.limit + 1])).rows;
      return paged(rows, data.limit, epoch, r => r.id);
    }); } catch (error) { const e = issueHttpError(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/issues', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = page.strict().safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: 'invalid_issue_page' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      const rows = (await client.query(`SELECT i.*,m.display_name,m.material_code,b.batch_code,u.login AS recipient_name FROM inventory_issues i JOIN inventory_materials m ON m.organization_id=i.organization_id AND m.id=i.material_id JOIN production_batches b ON b.organization_id=i.organization_id AND b.id=i.production_batch_id JOIN users u ON u.organization_id=i.organization_id AND u.id=i.recipient_id WHERE i.organization_id=$1 AND i.id>$2 AND ($3::boolean OR ((i.requested_by=$4 OR i.recipient_id=$4) AND EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=i.organization_id AND m.user_id=$4 AND m.workshop_id=i.workshop_id))) ORDER BY i.id LIMIT $5`, [actor.organization_id, data.after ?? zero, !!level, actor.id, data.limit + 1])).rows;
      return { ...paged(rows.map(issueSnapshot), data.limit, epoch, r => r.id), labels: rows.slice(0,data.limit).map(r=>({issueId:r.id,materialName:r.display_name,materialCode:r.material_code,batchCode:r.batch_code,recipientName:r.recipient_name})) };
    }); } catch (error) { const e = issueHttpError(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/issue-sources', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = page.extend({ issueId: uuid }).strict().safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: 'invalid_issue_source_page' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      if (level !== 'chief' && level !== 'manager') issueFail(403, 'issue_manager_required');
      const issue = await visibleIssue(client, actor, true, data.issueId);
      const rows = (await client.query(`SELECT s.*,m.base_unit FROM inventory_stocks s JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id WHERE s.organization_id=$1 AND s.material_id=$2 AND s.id>$3 ORDER BY s.id LIMIT $4`, [actor.organization_id, issue.material_id, data.after ?? zero, data.limit + 1])).rows.map(r => { const s = inventoryStockFromRow(r); return { ...s, available: s.onHand - s.reserved }; }); return paged(rows, data.limit, epoch, r => r.stockId);
    }); } catch (error) { const e = issueHttpError(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/issues/:issueId/history', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = history.safeParse(request.query), target = z.object({ issueId: uuid }).strict().safeParse(request.params); if (!parsed.success || !target.success) return reply.code(400).send({ error: 'invalid_issue_history' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      await visibleIssue(client, actor, !!level, target.data.issueId);
      const rows = (await client.query('SELECT operation_id,sequence,kind,actor_id,device_id,reason,evidence,expected_revision,resulting_revision,recorded_at FROM inventory_issue_events WHERE organization_id=$1 AND issue_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4', [actor.organization_id, target.data.issueId, data.after, data.limit + 1])).rows.map(r => ({ operationId: r.operation_id as string, sequence: Number(r.sequence), kind: r.kind as string, actorId: r.actor_id as string, deviceId: r.device_id as string, reason: r.reason as string, evidence: r.evidence as string, expectedRevision: r.expected_revision as number, resultingRevision: r.resulting_revision as number, recordedAt: new Date(r.recorded_at).toISOString() })); return paged(rows, data.limit, epoch, r => r.sequence);
    }); } catch (error) { const e = issueHttpError(error); return reply.code(e.status).send(e.body); }
  });
}
