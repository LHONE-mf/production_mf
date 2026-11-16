import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  issueBatchStep,
  issueFail,
  issueHttpError,
  issueTransaction,
} from "./inventory-issue-scope.js";
const uuid = z.guid(),
  positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  text = z
    .string()
    .min(1)
    .max(2000)
    .refine((v) => !!v.trim());
const command = z
  .object({
    operationId: uuid,
    deviceId: uuid,
    productionBatchId: uuid,
    stepNumber: positive.max(2147483647),
    materialId: uuid,
    unit: z.enum(["mg", "mm"]),
    observedAt: z.number().finite().positive(),
    reference: text,
    specificationReference: text,
    actualQuantity: positive,
    allocations: z
      .array(
        z
          .object({
            operationId: uuid,
            issueId: uuid,
            quantity: positive,
            expectedSettlementRevision: positive.max(
              Number.MAX_SAFE_INTEGER - 1,
            ),
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
const joins = `JOIN production_batches b ON b.organization_id=i.organization_id AND b.id=i.production_batch_id JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=i.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END`;
const scoped = `($4='chief' OR (i.recipient_id=$5 OR $4='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=i.organization_id AND w.user_id=$5 AND w.workshop_id=i.workshop_id))`;
function failure(error: unknown) {
  if ((error as { code?: string }).code === "P0001")
    return {
      status: 409,
      body: { error: "foil_source_or_settlement_changed" },
    };
  return issueHttpError(error);
}
export function registerCoatingFoilRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/inventory/room-materials/coating/foil", async (request, reply) => {
    const parsed = page.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_foil_page" });
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
              `SELECT i.id,coating_foil_source(i.organization_id,i.id) AS source,m.display_name,m.material_code,b.batch_code,
    m.active AND b.status IN ('created','in_progress') AND o.status IN ('released','in_progress') AND inventory_package_released(i.organization_id,i.stock_id) AND ((i.source_snapshot->>'expiresAt') IS NULL OR (i.source_snapshot->>'expiresAt')::timestamptz>clock_timestamp()) AS eligible
    FROM inventory_issues i JOIN inventory_materials m ON m.organization_id=i.organization_id AND m.id=i.material_id ${joins}
    WHERE i.organization_id=$1 AND i.id>$2 AND i.state=$3 AND s.stage='coating' AND s.workshop_id=i.workshop_id AND i.unit IN ('mg','mm') AND m.base_unit=i.unit AND m.category IN ('raw_material','component') AND m.tape_specification IS NULL AND ${scoped}
    ORDER BY i.id LIMIT $6`,
              [
                actor.organization_id,
                q.after ?? zero,
                "received",
                actor.role,
                actor.id,
                q.limit + 1,
              ],
            )
          ).rows;
          const items = rows
            .slice(0, q.limit)
            .map((r) => ({
              ...r.source,
              room: "coating",
              materialName: r.display_name,
              materialCode: r.material_code,
              batchCode: r.batch_code,
              eligible: r.eligible,
            }));
          return {
            organizationId: actor.organization_id,
            actorId: actor.id,
            deviceId: q.deviceId,
            epoch,
            postingEnabled: (
              await client.query(
                "SELECT posting_enabled FROM inventory_streams WHERE organization_id=$1",
                [actor.organization_id],
              )
            ).rows[0].posting_enabled,
            items,
            hasMore: rows.length > q.limit,
            nextAfter: rows.length > q.limit ? rows[q.limit - 1].id : null,
          };
        },
      );
    } catch (error) {
      const e = failure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.get(
    "/inventory/room-materials/coating/foil-consumptions",
    async (request, reply) => {
      const parsed = page.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_foil_history" });
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
                `SELECT c.operation_id,c.result_payload FROM inventory_coating_foil_consumptions c JOIN production_batches b ON b.organization_id=c.organization_id AND b.id=c.production_batch_id JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=c.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END
    WHERE c.organization_id=$1 AND c.operation_id>$2 AND s.stage='coating' AND ($3='chief' OR (c.actor_id=$4 OR $3='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=c.organization_id AND w.user_id=$4 AND w.workshop_id=s.workshop_id)) ORDER BY c.operation_id LIMIT $5`,
                [
                  actor.organization_id,
                  q.after ?? zero,
                  actor.role,
                  actor.id,
                  q.limit + 1,
                ],
              )
            ).rows;
            return {
              organizationId: actor.organization_id,
              actorId: actor.id,
              deviceId: q.deviceId,
              epoch,
              postingEnabled: (
                await client.query(
                  "SELECT posting_enabled FROM inventory_streams WHERE organization_id=$1",
                  [actor.organization_id],
                )
              ).rows[0].posting_enabled,
              items: rows.slice(0, q.limit).map((r) => r.result_payload),
              hasMore: rows.length > q.limit,
              nextAfter:
                rows.length > q.limit ? rows[q.limit - 1].operation_id : null,
            };
          },
        );
      } catch (error) {
        const e = failure(error);
        return reply.code(e.status).send(e.body);
      }
    },
  );
  app.post(
    "/inventory/room-materials/coating/foil-consumptions",
    async (request, reply) => {
      const parsed = command.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_measured_foil_use" });
      const data = parsed.data;
      if (
        new Set([
          data.operationId,
          ...data.allocations.map((a) => a.operationId),
        ]).size !==
          data.allocations.length + 1 ||
        new Set(data.allocations.map((a) => a.issueId)).size !==
          data.allocations.length ||
        data.allocations.reduce((n, a) => n + BigInt(a.quantity), 0n) !==
          BigInt(data.actualQuantity)
      )
        return reply.code(400).send({ error: "foil_actual_total_mismatch" });
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
            if (step.stage !== "coating")
              issueFail(409, "coating_route_required");
            const prior = (
              await client.query(
                "SELECT *,request_payload=$2::jsonb AS identical FROM inventory_coating_foil_consumptions WHERE operation_id=$1",
                [data.operationId, JSON.stringify(data)],
              )
            ).rows[0];
            if (prior) {
              if (
                prior.organization_id !== actor.organization_id ||
                prior.actor_id !== actor.id ||
                prior.device_id !== data.deviceId ||
                !prior.identical
              )
                issueFail(409, "operation_id_reused");
              return {
                status: "duplicate",
                operationId: data.operationId,
                consumption: prior.result_payload,
              };
            }
            await issueBatchStep(
              client,
              actor,
              data.productionBatchId,
              data.stepNumber,
              actor.role === "chief",
            );
            const material = (
              await client.query(
                "SELECT base_unit,category,tape_specification FROM inventory_materials WHERE organization_id=$1 AND id=$2 AND active FOR SHARE",
                [actor.organization_id, data.materialId],
              )
            ).rows[0];
            if (
              !material ||
              material.base_unit !== data.unit ||
              !["raw_material", "component"].includes(material.category) ||
              material.tape_specification
            )
              issueFail(409, "foil_material_or_unit_changed");
            const sources = [];
            for (const a of data.allocations) {
              const i = (
                await client.query(
                  "SELECT * FROM inventory_issues WHERE organization_id=$1 AND id=$2 FOR UPDATE",
                  [actor.organization_id, a.issueId],
                )
              ).rows[0];
              if (
                !i ||
                i.state !== "received" ||
                i.production_batch_id !== data.productionBatchId ||
                i.step_number !== data.stepNumber ||
                i.workshop_id !== step.workshop_id ||
                i.material_id !== data.materialId ||
                i.unit !== data.unit
              )
                issueFail(409, "received_foil_source_required");
              if (
                actor.role !== "chief" &&
                actor.role !== "master" &&
                i.recipient_id !== actor.id
              )
                issueFail(403, "room_custodian_required");
              if (
                !(
                  await client.query(
                    "SELECT inventory_package_released($1,$2) AS eligible",
                    [actor.organization_id, i.stock_id],
                  )
                ).rows[0].eligible ||
                (i.source_snapshot.expiresAt &&
                  Date.parse(i.source_snapshot.expiresAt) <= Date.now())
              )
                issueFail(409, "room_source_held");
              const source = (
                await client.query(
                  "SELECT coating_foil_source($1,$2) AS source",
                  [actor.organization_id, i.id],
                )
              ).rows[0].source;
              if (
                !source ||
                source.settlement.revision !== a.expectedSettlementRevision ||
                a.quantity > source.settlement.outstanding
              )
                issueFail(409, "issue_outstanding_changed");
              sources.push(source);
            }
            const recordedAt = (
                await client.query("SELECT clock_timestamp() AS at")
              ).rows[0].at.toISOString(),
              consumption = {
                ...data,
                room: "coating",
                actorId: actor.id,
                recordedAt,
                warehouseEffect: "none",
                sources,
              };
            await client.query(
              "INSERT INTO inventory_coating_foil_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,material_id,unit,actual_quantity,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
              [
                data.operationId,
                actor.organization_id,
                actor.id,
                data.deviceId,
                data.productionBatchId,
                data.stepNumber,
                data.materialId,
                data.unit,
                data.actualQuantity,
                epoch,
                JSON.stringify(data),
                JSON.stringify(consumption),
                recordedAt,
              ],
            );
            for (const [index, a] of data.allocations.entries()) {
              const { issue: i, settlement: before } = sources[index],
                after = {
                  ...before,
                  revision: before.revision + 1,
                  consumed: before.consumed + a.quantity,
                  outstanding: before.outstanding - a.quantity,
                };
              const outcome = {
                operationId: a.operationId,
                issueId: i.id,
                productionBatchId: i.productionBatchId,
                sourceStockId: i.stockId,
                actorId: actor.id,
                deviceId: data.deviceId,
                kind: "consume",
                quantity: a.quantity,
                stockId: null,
                condition: null,
                expectedRevision: before.revision,
                resultingRevision: before.revision + 1,
                reason: data.reason,
                evidence: data.evidence,
                recordedAt,
              };
              await client.query(
                `INSERT INTO inventory_issue_outcomes(operation_id,organization_id,issue_id,production_batch_id,source_stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,epoch,reason,evidence,request_payload,result_payload,recorded_at,foil_consumption_id) VALUES($1,$2,$3,$4,$5,$6,$7,'consume',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
                [
                  a.operationId,
                  actor.organization_id,
                  i.id,
                  i.productionBatchId,
                  i.stockId,
                  actor.id,
                  data.deviceId,
                  a.quantity,
                  before.revision,
                  before.revision + 1,
                  epoch,
                  data.reason,
                  data.evidence,
                  JSON.stringify({ consumptionId: data.operationId, ...a }),
                  JSON.stringify({
                    operationId: a.operationId,
                    outcome,
                    settlement: after,
                  }),
                  recordedAt,
                  data.operationId,
                ],
              );
            }
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
        const e = failure(error);
        return reply.code(e.status).send(e.body);
      }
    },
  );
}
