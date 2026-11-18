import type {FastifyInstance} from 'fastify';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {issueTransaction, issueFail, type IssueActor} from './inventory-issue-scope.js';
import {inventoryStream} from './inventory-stream.js';
import {custodySource, custodyLot, coatingSuccessor, custodyFailure} from './room-custody-scope.js';
const uuid = z.guid(),
  zero = '00000000-0000-0000-0000-000000000000';
const page = z.object({
  deviceId: uuid,
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const exact = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid custody quantity');
  return n;
};
const sourceScope = `($4='chief' OR (c.actor_id=$5 OR $4='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=c.organization_id AND w.user_id=$5 AND w.workshop_id=s.workshop_id))`;
const sourceJoins = `JOIN production_batches b ON b.organization_id=c.organization_id AND b.id=c.production_batch_id JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=c.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END`;
export function registerRoomCustodyReads(app: FastifyInstance, pool: Pool) {
  async function context(client: PoolClient, actor: IssueActor, deviceId: string, epoch: string) {
    return {
      organizationId: actor.organization_id,
      actorId: actor.id,
      deviceId,
      epoch,
      postingEnabled: (await inventoryStream(client, actor.organization_id)).posting_enabled,
    };
  }
  app.get('/inventory/room-outputs/slurry/sources', async (request, reply) => {
    const parsed = page.strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({error: 'invalid_room_source_page'});
    const q = parsed.data;
    try {
      return await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        q.deviceId,
        false,
        undefined,
        async (client, actor, _level, epoch) => {
          const rows = (
            await client.query(
              `SELECT c.*,room_slurry_source_snapshot(c.organization_id,c.operation_id) AS snapshot,d.operation_id AS declaration_id,
    b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND room_consumption_sources_eligible(c.organization_id,c.operation_id) AS eligible
    FROM inventory_slurry_consumptions c ${sourceJoins} LEFT JOIN inventory_room_outputs d ON d.organization_id=c.organization_id AND d.consumption_id=c.operation_id
    WHERE c.organization_id=$1 AND c.operation_id>$2 AND s.stage=$3 AND ${sourceScope} ORDER BY c.operation_id LIMIT $6`,
              [actor.organization_id, q.after ?? zero, 'slurry', actor.role, actor.id, q.limit + 1],
            )
          ).rows;
          const items = rows
            .slice(0, q.limit)
            .map((r) => ({
              operationId: r.operation_id,
              productionBatchId: r.production_batch_id,
              stepNumber: r.step_number,
              sourceSnapshot: r.snapshot,
              inputQuantity: exact(
                r.request_payload.source.components.reduce(
                  (n: number, c: {actualMg: number}) => n + c.actualMg,
                  0,
                ),
              ),
              declarationId: r.declaration_id ?? null,
              eligible: r.eligible,
            }));
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? items.at(-1)!.operationId : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get('/inventory/room-outputs/slurry/materials', async (request, reply) => {
    const parsed = page.extend({consumptionId: uuid}).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({error: 'invalid_output_material_page'});
    const q = parsed.data;
    try {
      return await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        q.deviceId,
        false,
        undefined,
        async (client, actor, _level, epoch) => {
          await custodySource(client, actor, q.consumptionId);
          const rows = (
            await client.query(
              "SELECT id,material_code AS code,display_name AS name,base_unit AS unit FROM inventory_materials WHERE organization_id=$1 AND active AND base_unit='mg' AND id>$2 ORDER BY id LIMIT $3",
              [actor.organization_id, q.after ?? zero, q.limit + 1],
            )
          ).rows;
          const items = rows.slice(0, q.limit);
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? items.at(-1)!.id : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get('/inventory/room-outputs/slurry', async (request, reply) => {
    const parsed = page.strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({error: 'invalid_output_page'});
    const q = parsed.data;
    try {
      return await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        q.deviceId,
        false,
        undefined,
        async (client, actor, _level, epoch) => {
          const rows = (
            await client.query(
              `SELECT l.*,m.material_code,m.display_name,d.production_batch_id,d.step_number,room_output_snapshot(l.organization_id,l.id) AS snapshot,
    a.n,a.reserved,a.received,b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND room_consumption_sources_eligible(c.organization_id,c.operation_id) AND m.active AS eligible
    FROM inventory_room_output_lots l JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id
    JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id JOIN inventory_slurry_consumptions c ON c.organization_id=d.organization_id AND c.operation_id=d.consumption_id ${sourceJoins}
    LEFT JOIN LATERAL(SELECT count(*) AS n,COALESCE(sum(h.quantity::numeric),0) AS reserved,COALESCE(sum(h.quantity::numeric) FILTER(WHERE EXISTS(SELECT 1 FROM inventory_room_handoff_events e WHERE e.organization_id=h.organization_id AND e.handoff_id=h.operation_id AND e.kind='receive')),0) AS received FROM inventory_room_handoffs h WHERE h.organization_id=l.organization_id AND h.output_lot_id=l.id) a ON true
    WHERE l.organization_id=$1 AND l.id>$2 AND s.stage=$3 AND ${sourceScope} ORDER BY l.id LIMIT $6`,
              [actor.organization_id, q.after ?? zero, 'slurry', actor.role, actor.id, q.limit + 1],
            )
          ).rows;
          const items = rows
            .slice(0, q.limit)
            .map((r) => ({
              id: r.id,
              materialId: r.material_id,
              materialCode: r.material_code,
              materialName: r.display_name,
              productionBatchId: r.production_batch_id,
              stepNumber: r.step_number,
              quantity: exact(r.quantity),
              available: exact(BigInt(r.quantity) - BigInt(r.reserved)),
              inTransit: exact(BigInt(r.reserved) - BigInt(r.received)),
              received: exact(r.received),
              revision: exact(r.n) + 1,
              unit: 'mg',
              qualityStatus: 'unreviewed',
              eligible: r.eligible,
              sourceSnapshot: r.snapshot,
            }));
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? items.at(-1)!.id : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get('/inventory/room-handoffs/options', async (request, reply) => {
    const parsed = page.extend({outputLotId: uuid}).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({error: 'invalid_handoff_options'});
    const q = parsed.data;
    try {
      return await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        q.deviceId,
        false,
        undefined,
        async (client, actor, _level, epoch) => {
          const lot = await custodyLot(client, actor, q.outputLotId),
            target = await coatingSuccessor(
              client,
              actor.organization_id,
              lot.production_batch_id,
              lot.step_number,
            );
          const rows = (
            await client.query(
              'SELECT u.id,u.login AS name FROM users u JOIN user_workshop_memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id WHERE u.organization_id=$1 AND u.active AND m.workshop_id=$2 AND u.id>$3 ORDER BY u.id LIMIT $4',
              [actor.organization_id, target.workshop_id, q.after ?? zero, q.limit + 1],
            )
          ).rows;
          const items = rows.slice(0, q.limit);
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
            destinationStepNumber: target.step_number,
            destinationWorkshopId: target.workshop_id,
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? items.at(-1)!.id : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get('/inventory/room-handoffs/:room', async (request, reply) => {
    const params = z.object({room: z.enum(['slurry', 'coating'])}).safeParse(request.params),
      parsed = page.strict().safeParse(request.query);
    if (!params.success || !parsed.success) return reply.code(400).send({error: 'invalid_handoff_page'});
    const q = parsed.data;
    try {
      return await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        q.deviceId,
        false,
        undefined,
        async (client, actor, _level, epoch) => {
          const rows = (
            await client.query(
              `SELECT h.*,a.events,a.event_count,a.received,a.flagged,b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND room_consumption_sources_eligible(c.organization_id,c.operation_id) AND EXISTS(SELECT 1 FROM inventory_materials m WHERE m.organization_id=l.organization_id AND m.id=l.material_id AND m.active) AS eligible FROM inventory_room_handoffs h
    JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id
    JOIN inventory_slurry_consumptions c ON c.organization_id=d.organization_id AND c.operation_id=d.consumption_id ${sourceJoins}
    LEFT JOIN LATERAL(SELECT count(*) AS event_count,COALESCE(bool_or(e.kind='receive'),false) AS received,COALESCE(bool_or(e.kind='discrepancy'),false) AS flagged,
     (SELECT COALESCE(jsonb_agg(recent.result_payload ORDER BY recent.recorded_at,recent.operation_id),'[]'::jsonb) FROM (SELECT result_payload,recorded_at,operation_id FROM inventory_room_handoff_events WHERE organization_id=h.organization_id AND handoff_id=h.operation_id ORDER BY (kind='receive') DESC,recorded_at DESC,operation_id DESC LIMIT 10) recent) AS events
     FROM inventory_room_handoff_events e WHERE e.organization_id=h.organization_id AND e.handoff_id=h.operation_id) a ON true
    WHERE h.organization_id=$1 AND h.operation_id>$2 AND ($3='slurry' AND ${sourceScope} OR $3='coating' AND ($4='chief' OR (h.recipient_id=$5 OR $4='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=h.organization_id AND m.user_id=$5 AND m.workshop_id=h.recipient_workshop_id))) ORDER BY h.operation_id LIMIT $6`,
              [actor.organization_id, q.after ?? zero, params.data.room, actor.role, actor.id, q.limit + 1],
            )
          ).rows;
          const items = rows
            .slice(0, q.limit)
            .map((r) => ({
              ...r.result_payload,
              status: r.received ? 'received' : r.flagged ? 'discrepancy' : 'awaiting_receiver',
              custodyQuantity: r.received ? exact(r.quantity) : 0,
              eligible: r.eligible,
              events: r.events,
              eventCount: exact(r.event_count),
              eventsTruncated: BigInt(r.event_count) > 10n,
            }));
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? items.at(-1)!.operationId : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get('/inventory/room-handoffs/:room/:handoffId/events', async (request, reply) => {
    const params = z.object({room: z.enum(['slurry', 'coating']), handoffId: uuid}).safeParse(request.params),
      parsed = page.strict().safeParse(request.query);
    if (!params.success || !parsed.success) return reply.code(400).send({error: 'invalid_handoff_history'});
    const q = parsed.data;
    try {
      return await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        q.deviceId,
        false,
        undefined,
        async (client, actor, _level, epoch) => {
          const visible = await client.query(
            `SELECT h.operation_id FROM inventory_room_handoffs h
    JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id JOIN inventory_room_outputs d ON d.organization_id=l.organization_id AND d.operation_id=l.declaration_id
    JOIN inventory_slurry_consumptions c ON c.organization_id=d.organization_id AND c.operation_id=d.consumption_id ${sourceJoins}
    WHERE h.organization_id=$1 AND h.operation_id=$2 AND ($3='slurry' AND ${sourceScope} OR $3='coating' AND ($4='chief' OR (h.recipient_id=$5 OR $4='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships m WHERE m.organization_id=h.organization_id AND m.user_id=$5 AND m.workshop_id=h.recipient_workshop_id)))`,
            [actor.organization_id, params.data.handoffId, params.data.room, actor.role, actor.id],
          );
          if (!visible.rowCount) issueFail(404, 'room_handoff_not_found');
          const rows = (
            await client.query(
              'SELECT result_payload FROM inventory_room_handoff_events WHERE organization_id=$1 AND handoff_id=$2 AND operation_id>$3 ORDER BY operation_id LIMIT $4',
              [actor.organization_id, params.data.handoffId, q.after ?? zero, q.limit + 1],
            )
          ).rows;
          const items = rows.slice(0, q.limit).map((r) => r.result_payload);
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? items.at(-1)!.operationId : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
}
