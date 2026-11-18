import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  issueBatchStep,
  issueMembership,
  issueFail,
  issueTransaction,
  type IssueActor,
} from "./inventory-issue-scope.js";
import { custodyDuplicate, custodyFailure } from "./room-custody-scope.js";
import {
  calenderedRollLot,
  cuttingSuccessor,
  rollContext,
} from "./calendered-roll-scope.js";
import {
  rollCommon,
  rollId,
  rollQuantity,
  rollText,
  rollPage,
  rollZero,
  rollJoins,
} from "./calendered-roll-domain.js";
const offer = rollCommon
  .extend({
    outputLotId: rollId,
    quantity: z.literal(1),
    expectedSourceRevision: rollQuantity.max(Number.MAX_SAFE_INTEGER - 1),
    recipientId: rollId,
    destinationStepNumber: rollQuantity.max(2147483647),
  })
  .strict();
const observed = rollCommon.extend({
  handoffId: rollId,
  observedRollLabel: rollText.max(200).nullable(),
  observedLengthMm: rollQuantity.nullable(),
  measurementNote: rollText,
});
const receipt = z.discriminatedUnion("kind", [
  observed
    .extend({
      kind: z.literal("receive"),
      observedQuantity: z.literal(1),
      observedRollLabel: rollText.max(200),
    })
    .strict(),
  observed
    .extend({
      kind: z.literal("discrepancy"),
      observedQuantity: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .nullable(),
    })
    .strict(),
]);
async function visibleHandoff(
  client: PoolClient,
  actor: IssueActor,
  id: string,
) {
  const row = (
    await client.query(
      `SELECT h.*,c.actor_id AS sender_id,c.step_number AS source_step,s.workshop_id AS sender_workshop FROM inventory_room_handoffs h JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id JOIN inventory_calendaring_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.calendaring_declaration_id ${rollJoins} WHERE h.organization_id=$1 AND h.operation_id=$2`,
      [actor.organization_id, id],
    )
  ).rows[0];
  if (!row) issueFail(404, "calendered_roll_handoff_not_found");
  if (
    actor.role !== "chief" &&
    !(
      (row.sender_id === actor.id || actor.role === "master") &&
      (await issueMembership(
        client,
        actor.organization_id,
        actor.id,
        row.sender_workshop,
      ))
    ) &&
    !(
      (row.recipient_id === actor.id || actor.role === "master") &&
      (await issueMembership(
        client,
        actor.organization_id,
        actor.id,
        row.recipient_workshop_id,
      ))
    )
  )
    issueFail(404, "calendered_roll_handoff_not_found");
  return row;
}
export function registerCalenderedRollCustodyRoutes(
  app: FastifyInstance,
  pool: Pool,
) {
  app.post("/inventory/calendered-rolls/handoffs", async (request, reply) => {
    const parsed = offer.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_whole_roll_offer" });
    const data = parsed.data;
    try {
      const result = await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers["x-device-proof"],
        data.deviceId,
        true,
        request.headers["x-inventory-epoch"],
        async (client, actor, _level, epoch) => {
          const source = await calenderedRollLot(
              client,
              actor,
              data.outputLotId,
            ),
            prior = await custodyDuplicate(
              client,
              actor,
              "inventory_room_handoffs",
              data,
              data,
              "handoff",
            );
          if (prior) return prior;
          await calenderedRollLot(client, actor, data.outputLotId, true);
          const target = await cuttingSuccessor(
            client,
            actor.organization_id,
            source.production_batch_id,
            source.step_number,
          );
          if (
            target.step_number !== data.destinationStepNumber ||
            !(await issueMembership(
              client,
              actor.organization_id,
              data.recipientId,
              target.workshop_id,
            ))
          )
            issueFail(409, "cutting_recipient_or_route_changed");
          const recordedAt = (
              await client.query("SELECT clock_timestamp() AS at")
            ).rows[0].at.toISOString(),
            handoff = {
              ...data,
              productionBatchId: source.production_batch_id,
              sourceRoom: "calendaring",
              destinationRoom: "cutting",
              recipientWorkshopId: target.workshop_id,
              sourceSnapshot: source.snapshot,
              actorId: actor.id,
              recordedAt,
              unit: "rolls",
              warehouseEffect: "none",
            };
          await client.query(
            "INSERT INTO inventory_room_handoffs(operation_id,organization_id,output_lot_id,actor_id,device_id,production_batch_id,destination_step,recipient_id,recipient_workshop_id,quantity,expected_revision,output_snapshot,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15)",
            [
              data.operationId,
              actor.organization_id,
              data.outputLotId,
              actor.id,
              data.deviceId,
              source.production_batch_id,
              target.step_number,
              data.recipientId,
              target.workshop_id,
              data.expectedSourceRevision,
              source.snapshot,
              epoch,
              data,
              handoff,
              recordedAt,
            ],
          );
          return {
            status: "confirmed",
            operationId: data.operationId,
            handoff,
          };
        },
      );
      return reply.code(result.status === "duplicate" ? 200 : 201).send(result);
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.post(
    "/inventory/calendered-rolls/acknowledgements",
    async (request, reply) => {
      const parsed = receipt.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_roll_receipt" });
      const data = parsed.data;
      try {
        const result = await issueTransaction(
          pool,
          request.headers.authorization,
          request.headers["x-device-proof"],
          data.deviceId,
          true,
          request.headers["x-inventory-epoch"],
          async (client, actor, _level, epoch) => {
            const h = (
              await client.query(
                "SELECT * FROM inventory_room_handoffs WHERE organization_id=$1 AND operation_id=$2 AND output_snapshot->>'unit'='rolls' FOR UPDATE",
                [actor.organization_id, data.handoffId],
              )
            ).rows[0];
            if (!h) issueFail(404, "calendered_roll_handoff_not_found");
            if (
              h.recipient_id !== actor.id ||
              !(await issueMembership(
                client,
                actor.organization_id,
                actor.id,
                h.recipient_workshop_id,
              ))
            )
              issueFail(403, "assigned_roll_receiver_required");
            const target = await issueBatchStep(
              client,
              actor,
              h.production_batch_id,
              h.destination_step,
              false,
              false,
            );
            if (
              target.stage !== "cutting" ||
              target.workshop_id !== h.recipient_workshop_id
            )
              issueFail(409, "cutting_route_changed");
            const prior = await custodyDuplicate(
              client,
              actor,
              "inventory_room_handoff_events",
              data,
              data,
              "receipt",
            );
            if (prior) return prior;
            if (data.kind === "receive")
              await issueBatchStep(
                client,
                actor,
                h.production_batch_id,
                h.destination_step,
                false,
              );
            const recordedAt = (
                await client.query("SELECT clock_timestamp() AS at")
              ).rows[0].at.toISOString(),
              receipt = {
                ...data,
                sourceSnapshot: h.result_payload,
                actorId: actor.id,
                recordedAt,
                custodyEffect: data.kind === "receive" ? "received" : "none",
                unit: "rolls",
                warehouseEffect: "none",
              };
            await client.query(
              "INSERT INTO inventory_room_handoff_events(operation_id,organization_id,handoff_id,actor_id,device_id,kind,observed_quantity,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              [
                data.operationId,
                actor.organization_id,
                h.operation_id,
                actor.id,
                data.deviceId,
                data.kind,
                data.observedQuantity,
                epoch,
                data,
                receipt,
                recordedAt,
              ],
            );
            return {
              status: "confirmed",
              operationId: data.operationId,
              receipt,
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
  app.get("/inventory/calendered-rolls/recipients", async (request, reply) => {
    const parsed = rollPage
      .extend({ outputLotId: rollId })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_roll_recipients" });
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
          const lot = await calenderedRollLot(client, actor, q.outputLotId),
            target = await cuttingSuccessor(
              client,
              actor.organization_id,
              lot.production_batch_id,
              lot.step_number,
            );
          const rows = (
            await client.query(
              "SELECT u.id,u.login AS name FROM users u JOIN user_workshop_memberships w ON w.organization_id=u.organization_id AND w.user_id=u.id WHERE u.organization_id=$1 AND u.id>$2 AND u.active AND w.workshop_id=$3 ORDER BY u.id LIMIT $4",
              [
                actor.organization_id,
                q.after ?? rollZero,
                target.workshop_id,
                q.limit + 1,
              ],
            )
          ).rows;
          return {
            ...(await rollContext(client, actor, q.deviceId, epoch)),
            destinationStepNumber: target.step_number,
            recipientWorkshopId: target.workshop_id,
            items: rows.slice(0, q.limit),
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? rows[q.limit - 1].id : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get("/inventory/calendered-rolls/handoffs", async (request, reply) => {
    const parsed = rollPage
      .extend({ room: z.enum(["calendaring", "cutting"]) })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_roll_handoff_page" });
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
              `SELECT h.operation_id,h.result_payload,m.active AND m.base_unit='rolls' AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND calendered_roll_inputs_eligible(c.organization_id,c.request_payload) AS eligible,
    (SELECT e.result_payload FROM inventory_room_handoff_events e WHERE e.organization_id=h.organization_id AND e.handoff_id=h.operation_id AND e.kind='receive') AS received,
    (SELECT count(*)::int FROM inventory_room_handoff_events e WHERE e.organization_id=h.organization_id AND e.handoff_id=h.operation_id) AS event_count
    FROM inventory_room_handoffs h JOIN inventory_room_output_lots l ON l.organization_id=h.organization_id AND l.id=h.output_lot_id JOIN inventory_calendaring_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.calendaring_declaration_id JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id ${rollJoins}
    WHERE h.organization_id=$1 AND h.operation_id>$2 AND s.stage='calendaring' AND ($3='chief' OR $5='calendaring' AND(c.actor_id=$4 OR $3='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=c.organization_id AND w.user_id=$4 AND w.workshop_id=s.workshop_id) OR $5='cutting' AND(h.recipient_id=$4 OR $3='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=h.organization_id AND w.user_id=$4 AND w.workshop_id=h.recipient_workshop_id)) ORDER BY h.operation_id LIMIT $6`,
              [
                actor.organization_id,
                q.after ?? rollZero,
                actor.role,
                actor.id,
                q.room,
                q.limit + 1,
              ],
            )
          ).rows;
          const items = rows.slice(0, q.limit).map((r) => ({
            operationId: r.operation_id,
            handoff: r.result_payload,
            eligible: r.eligible,
            received: r.received ?? null,
            eventCount: r.event_count,
          }));
          return {
            ...(await rollContext(client, actor, q.deviceId, epoch)),
            items,
            hasMore: rows.length > q.limit,
            nextAfter:
              rows.length > q.limit ? rows[q.limit - 1].operation_id : null,
          };
        },
      );
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get(
    "/inventory/calendered-rolls/handoffs/:handoffId/events",
    async (request, reply) => {
      const parsed = rollPage.strict().safeParse(request.query),
        params = z
          .object({ handoffId: rollId })
          .strict()
          .safeParse(request.params);
      if (!parsed.success || !params.success)
        return reply.code(400).send({ error: "invalid_roll_event_page" });
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
            await visibleHandoff(client, actor, params.data.handoffId);
            const rows = (
              await client.query(
                "SELECT operation_id,result_payload FROM inventory_room_handoff_events WHERE organization_id=$1 AND handoff_id=$2 AND operation_id>$3 ORDER BY operation_id LIMIT $4",
                [
                  actor.organization_id,
                  params.data.handoffId,
                  q.after ?? rollZero,
                  q.limit + 1,
                ],
              )
            ).rows;
            return {
              ...(await rollContext(client, actor, q.deviceId, epoch)),
              items: rows.slice(0, q.limit).map((r) => r.result_payload),
              hasMore: rows.length > q.limit,
              nextAfter:
                rows.length > q.limit ? rows[q.limit - 1].operation_id : null,
            };
          },
        );
      } catch (error) {
        const e = custodyFailure(error);
        return reply.code(e.status).send(e.body);
      }
    },
  );
}
