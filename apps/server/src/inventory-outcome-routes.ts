import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';
import { inventoryStockFromRow } from './inventory-snapshot.js';
import { issueFail, issueHttpError, issueMembership, issueSnapshot, issueTransaction } from './inventory-issue-scope.js';
const uuid = z.guid(), positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), revision = z.number().int().min(1).max(2147483646), text = z.string().trim().min(1).max(2000);
const common = z.object({ operationId: uuid, deviceId: uuid, issueId: uuid, productionBatchId: uuid, sourceStockId: uuid, expectedSettlementRevision: positive.max(Number.MAX_SAFE_INTEGER - 1), quantity: positive, reason: text, evidence: text });
const body = z.discriminatedUnion('kind', [
  common.extend({ kind: z.literal('return'), expectedSourceRevision: revision, stockId: uuid, locationId: uuid, condition: z.enum(['untouched_unused', 'damaged', 'contaminated', 'altered', 'untraceable', 'expired', 'blocked']) }).strict(),
  common.extend({ kind: z.literal('scrap') }).strict(),
]);
const target = z.object({ issueId: uuid }).strict(), page = z.object({ deviceId: uuid, after: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const counts = (value: unknown) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('unsafe_issue_settlement'); return n; };
function settlement(issued: unknown, row: Record<string, unknown>) {
  const quantity = counts(issued), returned = counts(row.returned), scrapped = counts(row.scrapped), revision = counts(row.n) + 1;
  if (!Number.isSafeInteger(revision) || returned + scrapped > quantity) throw Error('invalid_issue_settlement');
  return { revision, issued: quantity, returned, scrapped, consumed: 0, outstanding: quantity - returned - scrapped };
}
const aggregates = `SELECT count(*) AS n,COALESCE(sum(quantity) FILTER(WHERE kind='return'),0) AS returned,COALESCE(sum(quantity) FILTER(WHERE kind='scrap'),0) AS scrapped FROM inventory_issue_outcomes WHERE organization_id=$1 AND issue_id=$2`;
async function balance(client: PoolClient, org: string, issueId: string, quantity: unknown) { return settlement(quantity, (await client.query(aggregates, [org, issueId])).rows[0]); }
function failure(error: unknown) {
  if ((error as { code?: string }).code === 'P0001' && ['outcome_warehouse_authority_required', 'accepted_issue_provenance_required', 'issue_outstanding_changed', 'return_source_ineligible', 'inventory_return_pair_required'].includes((error as Error).message)) return { status: 409, body: { error: (error as Error).message } };
  return issueHttpError(error);
}
export function registerInventoryOutcomeRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/inventory/issues/:issueId/outcomes', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = body.safeParse(request.body), params = target.safeParse(request.params); if (!parsed.success || !params.success || parsed.data.issueId !== params.data.issueId) return reply.code(400).send({ error: 'invalid_issue_outcome' }); const data = parsed.data;
    try {
      const result = await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, true, request.headers['x-inventory-epoch'], async (client, actor, level, epoch) => {
        if (!level || data.kind === 'scrap' && level !== 'chief' && level !== 'manager') issueFail(403, 'outcome_warehouse_authority_required');
        const prior = await client.query('SELECT *,request_payload=$2::jsonb AS identical FROM inventory_issue_outcomes WHERE operation_id=$1', [data.operationId, JSON.stringify(data)]);
        if (prior.rowCount) { const p = prior.rows[0]; if (p.organization_id !== actor.organization_id || p.actor_id !== actor.id || p.device_id !== data.deviceId || !p.identical) issueFail(409, 'operation_id_reused'); return { status: 'duplicate', ...p.result_payload }; }
        if ((await client.query('SELECT operation_id FROM inventory_operations WHERE operation_id=$1 UNION ALL SELECT operation_id FROM inventory_issue_events WHERE operation_id=$1', [data.operationId])).rowCount) issueFail(409, 'operation_id_reused');
        const issue = (await client.query('SELECT * FROM inventory_issues WHERE organization_id=$1 AND id=$2 FOR UPDATE', [actor.organization_id, data.issueId])).rows[0]; if (!issue) issueFail(404, 'issue_not_found');
        if (issue.state !== 'received' || issue.stock_id !== data.sourceStockId || issue.production_batch_id !== data.productionBatchId) issueFail(409, 'accepted_issue_provenance_required');
        const before = await balance(client, actor.organization_id, issue.id, issue.quantity);
        if (before.revision !== data.expectedSettlementRevision || data.quantity > before.outstanding) issueFail(409, 'issue_outstanding_changed');
        let stock: ReturnType<typeof inventoryStockFromRow> & { available: number } | undefined;
        if (data.kind === 'return') {
          if (data.condition !== 'untouched_unused' || data.stockId === data.sourceStockId) issueFail(409, 'return_condition_ineligible');
          const source = (await client.query(`SELECT s.*,m.base_unit,inventory_package_released(s.organization_id,s.id) AS eligible,LEAST(s.expires_at,($3::jsonb->>'expiresAt')::timestamptz) AS inherited_expiry FROM inventory_stocks s JOIN inventory_materials m ON m.organization_id=s.organization_id AND m.id=s.material_id WHERE s.organization_id=$1 AND s.id=$2 FOR UPDATE OF s`, [actor.organization_id, data.sourceStockId, JSON.stringify(issue.source_snapshot)])).rows[0];
          if (!source || !source.eligible || source.inherited_expiry && new Date(source.inherited_expiry).getTime() <= Date.now()) issueFail(409, 'return_source_ineligible');
          if (source.revision !== data.expectedSourceRevision) issueFail(409, 'revision_conflict');
          if (!(await client.query('SELECT 1 FROM inventory_locations WHERE organization_id=$1 AND id=$2 AND active FOR SHARE', [actor.organization_id, data.locationId])).rowCount) issueFail(404, 'destination_not_found');
          const parent = inventoryStockFromRow(source);
          if (parent.materialId !== issue.material_id || parent.unit !== issue.unit || parent.manufacturerLot !== issue.source_snapshot.manufacturerLot) issueFail(409, 'accepted_issue_provenance_required');
          stock = { ...parent, stockId: data.stockId, locationId: data.locationId, quality: 'released', disposition: 'release', onHand: data.quantity, reserved: 0, available: data.quantity, revision: 1 };
          delete stock.expiresAt; if (source.inherited_expiry) stock.expiresAt = new Date(source.inherited_expiry).toISOString();
          await client.query(`INSERT INTO inventory_stocks(id,organization_id,material_id,manufacturer_lot,location_id,quality,disposition,on_hand,reserved,revision,expires_at,manufactured_on) VALUES($1,$2,$3,$4,$5,'released','release',$6,0,1,$7,$8)`, [stock.stockId, actor.organization_id, stock.materialId, stock.manufacturerLot, stock.locationId, stock.onHand, stock.expiresAt ?? null, stock.manufacturedOn ?? null]);
          await client.query(`INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,production_batch_id,request_payload,result_stock,from_location_id,to_location_id) VALUES($1,$2,$3,$4,$5,'return',$6,0,1,$7,$8,$9,$10,$11,$12)`, [data.operationId, actor.organization_id, stock.stockId, actor.id, data.deviceId, data.quantity, data.reason, data.productionBatchId, JSON.stringify(data), JSON.stringify(stock), parent.locationId, stock.locationId]);
        }
        const after = { ...before, revision: before.revision + 1, returned: before.returned + (data.kind === 'return' ? data.quantity : 0), scrapped: before.scrapped + (data.kind === 'scrap' ? data.quantity : 0), outstanding: before.outstanding - data.quantity };
        const recordedAt = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
        const outcome = { operationId: data.operationId, issueId: issue.id, productionBatchId: issue.production_batch_id, sourceStockId: issue.stock_id, actorId: actor.id, deviceId: data.deviceId, kind: data.kind, quantity: data.quantity, stockId: stock?.stockId ?? null, condition: data.kind === 'return' ? data.condition : null, expectedRevision: before.revision, resultingRevision: after.revision, reason: data.reason, evidence: data.evidence, recordedAt };
        const accepted = { operationId: data.operationId, outcome, settlement: after, ...(stock ? { stock } : {}) };
        await client.query(`INSERT INTO inventory_issue_outcomes(operation_id,organization_id,issue_id,production_batch_id,source_stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,epoch,reason,evidence,condition,return_stock_id,request_payload,result_payload,result_stock,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, [data.operationId, actor.organization_id, issue.id, data.productionBatchId, data.sourceStockId, actor.id, data.deviceId, data.kind, data.quantity, before.revision, after.revision, epoch, data.reason, data.evidence, data.kind === 'return' ? data.condition : null, stock?.stockId ?? null, JSON.stringify(data), JSON.stringify(accepted), stock ? JSON.stringify(stock) : null, recordedAt]);
        return { status: 'confirmed', ...accepted };
      }); return reply.code(result.status === 'duplicate' ? 200 : 201).send(result);
    } catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/returns', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = page.safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: 'invalid_return_page' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      if (!level) issueFail(403, 'outcome_warehouse_authority_required');
      const rows = (await client.query(`SELECT i.*,to_jsonb(s)||jsonb_build_object('base_unit',m.base_unit) AS source_stock,m.display_name,m.material_code,b.batch_code,u.login AS recipient_name,a.*,inventory_package_released(s.organization_id,s.id) AND ((i.source_snapshot->>'expiresAt') IS NULL OR (i.source_snapshot->>'expiresAt')::timestamptz>clock_timestamp()) AS source_eligible FROM inventory_issues i JOIN inventory_stocks s ON s.organization_id=i.organization_id AND s.id=i.stock_id JOIN inventory_materials m ON m.organization_id=i.organization_id AND m.id=i.material_id JOIN production_batches b ON b.organization_id=i.organization_id AND b.id=i.production_batch_id JOIN users u ON u.organization_id=i.organization_id AND u.id=i.recipient_id LEFT JOIN LATERAL(SELECT count(*) AS n,COALESCE(sum(quantity) FILTER(WHERE kind='return'),0) AS returned,COALESCE(sum(quantity) FILTER(WHERE kind='scrap'),0) AS scrapped FROM inventory_issue_outcomes o WHERE o.organization_id=i.organization_id AND o.issue_id=i.id) a ON true WHERE i.organization_id=$1 AND i.state='received' AND i.id>$2 ORDER BY i.id LIMIT $3`, [actor.organization_id, data.after ?? '00000000-0000-0000-0000-000000000000', data.limit + 1])).rows;
      const items = rows.slice(0, data.limit).map(r => { const stock = inventoryStockFromRow(r.source_stock); return { issue: issueSnapshot(r), settlement: settlement(r.quantity, r), source: { ...stock, available: stock.onHand - stock.reserved }, sourceEligible: r.source_eligible, labels: { materialName: r.display_name, materialCode: r.material_code, batchCode: r.batch_code, recipientName: r.recipient_name } }; });
      return { epoch, items, hasMore: rows.length > data.limit, nextAfter: rows.length > data.limit ? items[items.length - 1].issue.id : null };
    }); } catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
  app.get('/inventory/issues/:issueId/outcomes', async (request, reply) => {
    if (!await authenticate(pool, request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
    const params = target.safeParse(request.params), parsed = z.object({ deviceId: uuid, after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().safeParse(request.query); if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_outcome_history' }); const data = parsed.data;
    try { return await issueTransaction(pool, request.headers.authorization, request.headers['x-device-proof'], data.deviceId, false, undefined, async (client, actor, level, epoch) => {
      const issue = (await client.query('SELECT * FROM inventory_issues WHERE organization_id=$1 AND id=$2', [actor.organization_id, params.data.issueId])).rows[0];
      if (!issue || !level && (!(issue.requested_by === actor.id || issue.recipient_id === actor.id) || !await issueMembership(client, actor.organization_id, actor.id, issue.workshop_id))) issueFail(404, 'issue_not_found');
      const rows = (await client.query('SELECT sequence,result_payload FROM inventory_issue_outcomes WHERE organization_id=$1 AND issue_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4', [actor.organization_id, issue.id, data.after, data.limit + 1])).rows;
      const items = rows.slice(0, data.limit).map(r => ({ ...r.result_payload.outcome, sequence: counts(r.sequence) }));
      return { epoch, settlement: await balance(client, actor.organization_id, issue.id, issue.quantity), items, hasMore: rows.length > data.limit, nextAfter: rows.length > data.limit ? items[items.length - 1].sequence : null };
    }); } catch (error) { const e = failure(error); return reply.code(e.status).send(e.body); }
  });
}
