import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  issueTransaction,
  issueBatchStep,
  issueFail,
  type IssueActor,
} from "./inventory-issue-scope.js";
import { inventoryStream } from "./inventory-stream.js";
import { custodyFailure } from "./room-custody-scope.js";

const uuid = z.guid(),
  quantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  text = z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => !!s.trim());
const command = z
  .object({
    operationId: uuid,
    deviceId: uuid,
    productionBatchId: uuid,
    stepNumber: quantity.max(2147483647),
    materialId: uuid,
    observedAt: z.number().finite().positive(),
    reference: text,
    actualLengthMm: quantity,
    allocations: z
      .array(
        z
          .object({
            operationId: uuid,
            receiptId: uuid,
            quantity,
            expectedRevision: quantity.max(Number.MAX_SAFE_INTEGER - 1),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: text,
    evidence: text,
  })
  .strict();
const page = z
  .object({
    deviceId: uuid,
    after: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const zero = "00000000-0000-0000-0000-000000000000";
const sourceJoins = `JOIN inventory_room_handoffs h ON h.organization_id=e.organization_id AND h.operation_id=e.handoff_id
 JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id
 JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id
 JOIN production_batches b ON b.organization_id=h.organization_id AND b.id=h.production_batch_id
 JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
 JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=h.destination_step AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END`;
const sourceScope = `($4='chief' OR (h.recipient_id=$5 OR $4='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=h.organization_id AND w.user_id=$5 AND w.workshop_id=h.recipient_workshop_id))`;
async function source(
  client: PoolClient,
  actor: IssueActor,
  receiptId: string,
) {
  const row = (
    await client.query(
      `SELECT e.operation_id,l.material_id,h.production_batch_id,h.destination_step,h.recipient_id,h.recipient_workshop_id,
  calendaring_roll_balance(e.organization_id,e.operation_id) AS snapshot,calendaring_roll_eligible(e.organization_id,e.operation_id) AS eligible
  FROM inventory_room_handoff_events e JOIN inventory_room_handoffs h ON h.organization_id=e.organization_id AND h.operation_id=e.handoff_id
  JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id
  WHERE e.organization_id=$1 AND e.operation_id=$2 AND e.kind='receive' AND l.unit='rolls'`,
      [actor.organization_id, receiptId],
    )
  ).rows[0];
  if (!row) issueFail(404, "calendaring_received_source_not_found");
  const step = await issueBatchStep(
    client,
    actor,
    row.production_batch_id,
    row.destination_step,
    actor.role === "chief",
    false,
  );
  if (
    step.stage !== "calendaring" ||
    step.workshop_id !== row.recipient_workshop_id
  )
    issueFail(409, "calendaring_received_route_changed");
  if (
    actor.role !== "chief" &&
    actor.role !== "master" &&
    row.recipient_id !== actor.id
  )
    issueFail(403, "calendaring_received_source_authority_required");
  return row;
}
export function registerCalendaringConsumptionRoutes(
  app: FastifyInstance,
  pool: Pool,
) {
  app.get(
    "/inventory/room-materials/calendaring/rolls",
    async (request, reply) => {
      const parsed = page.safeParse(request.query);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "invalid_calendaring_source_page" });
      const q = parsed.data;
      try {
        return await issueTransaction(
          pool,
          request.headers.authorization,
          request.headers["x-device-proof"],
          q.deviceId,
          false,
          undefined,
          async (client, actor, _level, epoch) => {
            const rows = (
              await client.query(
                `SELECT e.operation_id,h.production_batch_id,h.destination_step,l.material_id,m.material_code,m.display_name,b.batch_code,
    calendaring_roll_balance(e.organization_id,e.operation_id) AS snapshot,calendaring_roll_eligible(e.organization_id,e.operation_id) AS eligible
    FROM inventory_room_handoff_events e ${sourceJoins}
    WHERE e.organization_id=$1 AND e.operation_id>$2 AND e.kind=$3 AND l.unit='rolls' AND s.stage='calendaring' AND s.workshop_id=h.recipient_workshop_id AND ${sourceScope}
    ORDER BY e.operation_id LIMIT $6`,
                [
                  actor.organization_id,
                  q.after ?? zero,
                  "receive",
                  actor.role,
                  actor.id,
                  q.limit + 1,
                ],
              )
            ).rows;
            const items = rows.slice(0, q.limit).map((r) => ({
              ...r.snapshot,
              productionBatchId: r.production_batch_id,
              stepNumber: r.destination_step,
              materialId: r.material_id,
              materialCode: r.material_code,
              materialName: r.display_name,
              batchCode: r.batch_code,
              eligible: r.eligible,
              unit: "mm",
            }));
            return {
              organizationId: actor.organization_id,
              actorId: actor.id,
              deviceId: q.deviceId,
              epoch,
              postingEnabled: (
                await inventoryStream(client, actor.organization_id)
              ).posting_enabled,
              items,
              hasMore: rows.length > q.limit,
              nextAfter:
                rows.length > q.limit
                  ? items.at(-1)!.receipt.operationId
                  : null,
            };
          },
        );
      } catch (error) {
        const e = custodyFailure(error);
        return reply.code(e.status).send(e.body);
      }
    },
  );
  app.get(
    "/inventory/room-materials/calendaring/consumptions",
    async (request, reply) => {
      const parsed = page.safeParse(request.query);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "invalid_calendaring_use_history" });
      const q = parsed.data;
      try {
        return await issueTransaction(
          pool,
          request.headers.authorization,
          request.headers["x-device-proof"],
          q.deviceId,
          false,
          undefined,
          async (client, actor, _level, epoch) => {
            const rows = (
              await client.query(
                `SELECT c.operation_id,c.result_payload FROM inventory_calendaring_consumptions c
       JOIN production_batches b ON b.organization_id=c.organization_id AND b.id=c.production_batch_id
       JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id
       JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=c.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
       WHERE c.organization_id=$1 AND c.operation_id>$2 AND s.stage='calendaring'
       AND ($3='chief' OR (c.actor_id=$4 OR $3='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=c.organization_id AND w.user_id=$4 AND w.workshop_id=s.workshop_id))
       ORDER BY c.operation_id LIMIT $5`,
                [
                  actor.organization_id,
                  q.after ?? zero,
                  actor.role,
                  actor.id,
                  q.limit + 1,
                ],
              )
            ).rows;
            const items = rows.slice(0, q.limit).map((r) => r.result_payload);
            return {
              organizationId: actor.organization_id,
              actorId: actor.id,
              deviceId: q.deviceId,
              epoch,
              postingEnabled: (
                await inventoryStream(client, actor.organization_id)
              ).posting_enabled,
              items,
              hasMore: rows.length > q.limit,
              nextAfter:
                rows.length > q.limit ? items.at(-1)!.operationId : null,
            };
          },
        );
      } catch (error) {
        const e = custodyFailure(error);
        return reply.code(e.status).send(e.body);
      }
    },
  );
  app.post(
    "/inventory/room-materials/calendaring/consumptions",
    async (request, reply) => {
      const parsed = command.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "invalid_calendaring_consumption" });
      const data = parsed.data;
      if (
        new Set([
          data.operationId,
          ...data.allocations.map((a) => a.operationId),
        ]).size !==
          data.allocations.length + 1 ||
        new Set(data.allocations.map((a) => a.receiptId)).size !==
          data.allocations.length ||
        data.allocations.reduce((n, a) => n + BigInt(a.quantity), 0n) !==
          BigInt(data.actualLengthMm)
      )
        return reply
          .code(400)
          .send({ error: "calendaring_measured_allocation_required" });
      try {
        const result = await issueTransaction(
          pool,
          request.headers.authorization,
          request.headers["x-device-proof"],
          data.deviceId,
          true,
          request.headers["x-inventory-epoch"],
          async (client, actor, _level, epoch) => {
            const step = await issueBatchStep(
              client,
              actor,
              data.productionBatchId,
              data.stepNumber,
              actor.role === "chief",
              false,
            );
            if (step.stage !== "calendaring")
              issueFail(403, "calendaring_step_required");
            const previous = (
              await client.query(
                "SELECT *,request_payload=$2::jsonb AS identical FROM inventory_calendaring_consumptions WHERE operation_id=$1",
                [data.operationId, JSON.stringify(data)],
              )
            ).rows[0];
            if (previous) {
              if (
                previous.organization_id !== actor.organization_id ||
                previous.actor_id !== actor.id ||
                previous.device_id !== data.deviceId ||
                !previous.identical
              )
                issueFail(409, "operation_id_reused");
              for (const a of data.allocations)
                await source(client, actor, a.receiptId);
              return {
                status: "duplicate",
                operationId: data.operationId,
                consumption: previous.result_payload,
              };
            }
            await issueBatchStep(
              client,
              actor,
              data.productionBatchId,
              data.stepNumber,
              actor.role === "chief",
            );
            const sources = [];
            for (const allocation of data.allocations) {
              const found = await source(client, actor, allocation.receiptId);
              if (
                found.material_id !== data.materialId ||
                found.production_batch_id !== data.productionBatchId ||
                found.destination_step !== data.stepNumber
              )
                issueFail(409, "calendaring_received_source_step_mismatch");
              if (!found.eligible)
                issueFail(409, "calendaring_received_source_held");
              if (
                found.snapshot.revision !== allocation.expectedRevision ||
                allocation.quantity > found.snapshot.remaining
              )
                issueFail(409, "calendaring_received_source_remaining_changed");
              sources.push({
                allocationOperationId: allocation.operationId,
                source: found.snapshot,
              });
            }
            const recordedAt = (
              await client.query("SELECT clock_timestamp() AS at")
            ).rows[0].at.toISOString();
            const consumption = {
              ...data,
              room: "calendaring",
              unit: "mm",
              sources,
              actorId: actor.id,
              recordedAt,
              warehouseEffect: "none",
            };
            await client.query(
              "INSERT INTO inventory_calendaring_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,actual_length_mm,epoch,request_payload,result_payload,recorded_at,material_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
              [
                data.operationId,
                actor.organization_id,
                actor.id,
                data.deviceId,
                data.productionBatchId,
                data.stepNumber,
                data.actualLengthMm,
                epoch,
                JSON.stringify(data),
                JSON.stringify(consumption),
                recordedAt,
                data.materialId,
              ],
            );
            for (const [i, allocation] of data.allocations.entries())
              await client.query(
                "INSERT INTO inventory_calendaring_allocations(operation_id,organization_id,consumption_id,receipt_id,actor_id,device_id,quantity,expected_revision,source_snapshot,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                [
                  allocation.operationId,
                  actor.organization_id,
                  data.operationId,
                  allocation.receiptId,
                  actor.id,
                  data.deviceId,
                  allocation.quantity,
                  allocation.expectedRevision,
                  JSON.stringify(sources[i].source),
                  JSON.stringify(data),
                ],
              );
            return {
              status: "confirmed",
              operationId: data.operationId,
              consumption,
            };
          },
        );
        return reply
          .code(result.status === "duplicate" ? 200 : 201)
          .send(result);
      } catch (error) {
        const e = custodyFailure(error);
        return reply.code(e.status).send(e.body);
      }
    },
  );
}
