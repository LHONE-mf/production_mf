import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  issueBatchStep,
  issueFail,
  issueTransaction,
  type IssueActor,
} from "./inventory-issue-scope.js";
import { inventoryStream } from "./inventory-stream.js";
import { custodyDuplicate, custodyFailure } from "./room-custody-scope.js";
import {
  cuttingOutput,
  rollId,
  rollPage,
  rollQuantity,
  rollZero,
  rollJoins,
  rollScope,
} from "./cutting-output-domain.js";
async function context(
  client: PoolClient,
  actor: IssueActor,
  deviceId: string,
  epoch: string,
) {
  return {
    organizationId: actor.organization_id,
    actorId: actor.id,
    deviceId,
    epoch,
    postingEnabled: (await inventoryStream(client, actor.organization_id))
      .posting_enabled,
  };
}
export function registerCuttingOutputRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/inventory/cutting-outputs", async (request, reply) => {
    const parsed = cuttingOutput.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_counted_cutting_output" });
    const data = parsed.data;
    if (
      [data.consumptionIds, data.outputs.map((o) => o.id)].some(
        (ids) => new Set(ids).size !== ids.length,
      )
    )
      return reply
        .code(400)
        .send({ error: "duplicate_cutting_source_or_identity" });
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
          if (step.stage !== "cutting")
            issueFail(409, "cutting_route_required");
          const prior = await custodyDuplicate(
            client,
            actor,
            "inventory_cutting_outputs",
            data,
            data,
            "declaration",
          );
          if (prior) return prior;
          await issueBatchStep(
            client,
            actor,
            data.productionBatchId,
            data.stepNumber,
            actor.role === "chief",
          );
          for (const [ids, column] of [
            [data.consumptionIds, "cutting_consumption_id"],
          ] as const)
            if (
              (
                await client.query(
                  `SELECT 1 FROM inventory_cutting_output_claims WHERE organization_id=$1 AND ${column}=ANY($2::uuid[])`,
                  [actor.organization_id, ids],
                )
              ).rowCount
            )
              issueFail(409, "cutting_measurement_already_declared");
          const sources = (
            await client.query(
              "SELECT cutting_output_sources($1,$2) AS source",
              [actor.organization_id, data],
            )
          ).rows[0].source;
          const recordedAt = (
              await client.query("SELECT clock_timestamp() AS at")
            ).rows[0].at.toISOString(),
            declaration = {
              ...data,
              sources,
              actorId: actor.id,
              recordedAt,
              qualityStatus: "unreviewed",
              materialAccountingStatus: "unreconciled",
              genealogyScope: "declaration",
              warehouseEffect: "none",
            };
          await client.query(
            "INSERT INTO inventory_cutting_outputs(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,epoch,source_snapshot,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
            [
              data.operationId,
              actor.organization_id,
              actor.id,
              data.deviceId,
              data.productionBatchId,
              data.stepNumber,
              epoch,
              JSON.stringify(sources),
              data,
              declaration,
              recordedAt,
            ],
          );
          for (const [ids, column] of [
            [data.consumptionIds, "cutting_consumption_id"],
          ] as const)
            for (const id of ids)
              await client.query(
                `INSERT INTO inventory_cutting_output_claims(organization_id,declaration_id,${column}) VALUES($1,$2,$3)`,
                [actor.organization_id, data.operationId, id],
              );
          for (const output of data.outputs)
            await client.query(
              "INSERT INTO inventory_room_output_lots(id,organization_id,cutting_declaration_id,material_id,quantity,unit) VALUES($1,$2,$3,$4,$5,'pieces')",
              [
                output.id,
                actor.organization_id,
                data.operationId,
                output.materialId,
                output.quantity,
              ],
            );
          return {
            status: "confirmed",
            operationId: data.operationId,
            declaration,
          };
        },
      );
      return reply.code(result.status === "duplicate" ? 200 : 201).send(result);
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get("/inventory/cutting-outputs", async (request, reply) => {
    const parsed = rollPage.strict().safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_cutting_page" });
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
              `SELECT l.id,l.quantity,room_output_snapshot(l.organization_id,l.id) AS snapshot,m.material_code,m.display_name,b.batch_code,a.n,a.reserved,a.received,
    m.active AND m.base_unit='pieces' AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND cutting_output_inputs_eligible(c.organization_id,c.request_payload) AS eligible
    FROM inventory_room_output_lots l JOIN inventory_cutting_outputs c ON c.organization_id=l.organization_id AND c.operation_id=l.cutting_declaration_id JOIN inventory_materials m ON m.organization_id=l.organization_id AND m.id=l.material_id ${rollJoins}
    LEFT JOIN LATERAL(SELECT count(*) AS n,COALESCE(sum(h.quantity),0) AS reserved,COALESCE(sum(h.quantity) FILTER(WHERE EXISTS(SELECT 1 FROM inventory_room_handoff_events e WHERE e.organization_id=h.organization_id AND e.handoff_id=h.operation_id AND e.kind='receive')),0) AS received FROM inventory_room_handoffs h WHERE h.organization_id=l.organization_id AND h.output_lot_id=l.id) a ON true
    WHERE l.organization_id=$1 AND l.id>$2 AND s.stage='cutting' AND ${rollScope} ORDER BY l.id LIMIT $5`,
              [
                actor.organization_id,
                q.after ?? rollZero,
                actor.role,
                actor.id,
                q.limit + 1,
              ],
            )
          ).rows;
          const items = rows.slice(0, q.limit).map((r) => ({
            id: r.id,
            snapshot: r.snapshot,
            materialCode: r.material_code,
            materialName: r.display_name,
            batchCode: r.batch_code,
            reserved: Number(r.reserved),
            received: Number(r.received),
            remaining: Number(r.quantity) - Number(r.reserved),
            revision: Number(r.n) + 1,
            eligible: r.eligible && r.snapshot.lot.disposition === "ready",
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
  app.get("/inventory/cutting-outputs/history", async (request, reply) => {
    const parsed = rollPage.strict().safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_cutting_history" });
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
              `SELECT c.operation_id,c.result_payload FROM inventory_cutting_outputs c ${rollJoins} WHERE c.organization_id=$1 AND c.operation_id>$2 AND s.stage='cutting' AND ${rollScope} ORDER BY c.operation_id LIMIT $5`,
              [
                actor.organization_id,
                q.after ?? rollZero,
                actor.role,
                actor.id,
                q.limit + 1,
              ],
            )
          ).rows;
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
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
  });
  app.get("/inventory/cutting-outputs/inputs", async (request, reply) => {
    const parsed = rollPage.strict().safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_coating_input_page" });
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
              `SELECT c.operation_id,c.production_batch_id,c.step_number,c.result_payload,cl.declaration_id,b.batch_code,m.material_code,m.display_name,b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND cutting_output_input_eligible(c.organization_id,c.operation_id) AS eligible
    FROM inventory_cutting_consumptions c ${rollJoins} JOIN inventory_materials m ON m.organization_id=c.organization_id AND m.id=c.material_id LEFT JOIN inventory_cutting_output_claims cl ON cl.organization_id=c.organization_id AND cl.cutting_consumption_id=c.operation_id WHERE c.organization_id=$1 AND c.operation_id>$2 AND s.stage='cutting' AND ${rollScope} ORDER BY c.operation_id LIMIT $5`,
              [
                actor.organization_id,
                q.after ?? rollZero,
                actor.role,
                actor.id,
                q.limit + 1,
              ],
            )
          ).rows;
          const items = rows.slice(0, q.limit).map((r) => ({
            operationId: r.operation_id,
            productionBatchId: r.production_batch_id,
            stepNumber: r.step_number,
            consumption: r.result_payload,
            batchCode: r.batch_code,
            claimedBy: r.declaration_id ?? null,
            eligible: r.eligible,
            materialId: r.result_payload.materialId,
            materialCode: r.material_code,
            materialName: r.display_name,
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
  app.get("/inventory/cutting-outputs/materials", async (request, reply) => {
    const parsed = rollPage
      .extend({
        productionBatchId: rollId,
        stepNumber: z.coerce.number().int().min(1).max(2147483647),
      })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_cutting_materials" });
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
          const step = await issueBatchStep(
            client,
            actor,
            q.productionBatchId,
            q.stepNumber,
            actor.role === "chief",
            false,
          );
          if (step.stage !== "cutting")
            issueFail(409, "cutting_route_required");
          const rows = (
            await client.query(
              "SELECT id,material_code AS code,display_name AS name,base_unit AS unit FROM inventory_materials WHERE organization_id=$1 AND id>$2 AND active AND category='electrode' AND base_unit='pieces' AND tape_specification IS NULL ORDER BY id LIMIT $3",
              [actor.organization_id, q.after ?? rollZero, q.limit + 1],
            )
          ).rows;
          return {
            ...(await context(client, actor, q.deviceId, epoch)),
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
}
