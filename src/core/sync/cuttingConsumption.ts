import {copyCalendaringRequest,type CalendaringConsumptionRequest} from './calendaringConsumption';
import { db } from "../db";
import type { HybridSession } from "./hybridClient";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import {
  issueIdValid as id,
  issueTextValid as text,
} from "./inventoryIssueTypes";
import {
  outcomeInteger as integer,
  outcomeInstant as instant,
} from "./inventoryOutcomeTypes";
import { sameOutput as same } from "./inventoryOutputTypes";
import { copyCalenderedReceipt, type CalenderedReceipt } from "./calenderedRollTypes";
import { toInventoryBaseUnits } from "./inventoryReceiving";
import { readPage } from "./roomCustody";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type InventoryScope,
  type ReceivingDraft,
} from "./inventoryOutbox";
import { withInventorySync } from "./inventorySyncLock";

export interface CuttingAllocation {
  operationId: string;
  receiptId: string;
  quantity: number;
  expectedRevision: number;
}
export type CuttingConsumptionRequest=CalendaringConsumptionRequest;
export interface CuttingRollBalance {
  receipt: CalenderedReceipt;
  received: number;
  consumed: number;
  remaining: number;
  revision: number;
  capacityBasis: "calendered_measured_roll_length";
}
export interface CuttingRollSource extends CuttingRollBalance {
  productionBatchId: string;
  stepNumber: number;
  materialId: string;
  materialCode: string;
  materialName: string;
  batchCode: string;
  eligible: boolean;
  unit: "mm";
}
export interface CuttingConsumption extends CuttingConsumptionRequest {
  room: "cutting";
  unit: "mm";
  actorId: string;
  recordedAt: string;
  warehouseEffect: "none";
  sources: { allocationOperationId: string; source: CuttingRollBalance }[];
}
const invalid = () => {
  throw Error("Некорректные данные фактического расхода рулонов в Cutting");
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const requestKeys = [
  "operationId",
  "deviceId",
  "productionBatchId",
  "stepNumber",
  "materialId",
  "observedAt",
  "reference",
  "actualLengthMm",
  "allocations",
  "reason",
  "evidence",
];
export function copyCuttingRequest(value:unknown):CuttingConsumptionRequest{try{return copyCalendaringRequest(value);}catch{return invalid();}}
function copyBalance(value: unknown): CuttingRollBalance {
  const r = object(value),
    receipt = copyCalenderedReceipt(r.receipt);
  if (
    receipt.kind !== "receive" ||
    receipt.observedQuantity !== 1 ||
    r.capacityBasis !== "calendered_measured_roll_length" ||
    r.received !==
      receipt.sourceSnapshot.sourceSnapshot.roll.measuredLengthMm ||
    !integer(r.received, 1) ||
    ![r.consumed, r.remaining].every((v) => integer(v)) ||
    !integer(r.revision, 1) ||
    BigInt(r.consumed as number) + BigInt(r.remaining as number) !==
      BigInt(r.received as number)
  )
    invalid();
  return {
    receipt,
    received: r.received as number,
    consumed: r.consumed as number,
    remaining: r.remaining as number,
    revision: r.revision as number,
    capacityBasis: "calendered_measured_roll_length",
  };
}
export function copyCuttingRollSource(
  value: unknown,
): CuttingRollSource {
  const r = object(value),
    balance = copyBalance(r),
    handoff = balance.receipt.sourceSnapshot;
  if (
    r.productionBatchId !== handoff.productionBatchId ||
    r.stepNumber !== handoff.destinationStepNumber ||
    r.materialId !== handoff.sourceSnapshot.materialId ||
    ![r.materialCode, r.materialName, r.batchCode].every(text) ||
    typeof r.eligible !== "boolean" ||
    r.unit !== "mm"
  )
    invalid();
  return {
    ...balance,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    materialId: r.materialId as string,
    materialCode: r.materialCode as string,
    materialName: r.materialName as string,
    batchCode: r.batchCode as string,
    eligible: r.eligible as boolean,
    unit: "mm",
  };
}
export function copyCuttingConsumption(
  value: unknown,
): CuttingConsumption {
  const r = object(value),
    request = copyCuttingRequest(
      Object.fromEntries(requestKeys.map((k) => [k, r[k]])),
    );
  if (
    r.room !== "cutting" ||
    r.unit !== "mm" ||
    r.warehouseEffect !== "none" ||
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    !Array.isArray(r.sources) ||
    r.sources.length !== request.allocations.length
  )
    invalid();
  const sources = (r.sources as unknown[]).map((v, i) => {
    const s = object(v),
      source = copyBalance(s.source),
      allocation = request.allocations[i];
    if (
      s.allocationOperationId !== allocation.operationId ||
      source.receipt.operationId !== allocation.receiptId ||
      source.revision !== allocation.expectedRevision ||
      allocation.quantity > source.remaining ||
      source.receipt.sourceSnapshot.productionBatchId !==
        request.productionBatchId ||
      source.receipt.sourceSnapshot.sourceSnapshot.materialId !==
        request.materialId ||
      source.receipt.sourceSnapshot.destinationStepNumber !== request.stepNumber
    )
      invalid();
    return { allocationOperationId: allocation.operationId, source };
  });
  return {
    ...request,
    room: "cutting",
    unit: "mm",
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    warehouseEffect: "none",
    sources,
  };
}
export async function loadCuttingRoll(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/room-materials/cutting/rolls",
      copyCuttingRollSource,
      (r) => r.receipt.operationId,
      after,
    )
  ).page;
}
export async function loadCuttingConsumptions(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/room-materials/cutting/consumptions",
      copyCuttingConsumption,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export function cuttingConsumptionProposals(
  scope: InventoryScope,
  actor: string,
) {
  return inventoryOutbox.receivingDrafts
    .filter((row) => {
      try {
        const k = JSON.parse(row.key);
        return (
          k[0] === inventoryScopeKey(scope) &&
          k[1] === actor &&
          k[2] === "cutting-consumption"
        );
      } catch {
        return false;
      }
    })
    .toArray();
}
function validateIntent(
  scope: InventoryScope,
  request: CuttingConsumptionRequest,
  sources: CuttingRollSource[],
) {
  if (
    request.deviceId !== scope.deviceId ||
    sources.length !== request.allocations.length ||
    new Set(sources.map((s) => s.receipt.operationId)).size !== sources.length
  )
    invalid();
  for (const a of request.allocations) {
    const source = sources.find((s) => s.receipt.operationId === a.receiptId);
    if (
      !source?.eligible ||
      source.materialId !== request.materialId ||
      source.productionBatchId !== request.productionBatchId ||
      source.stepNumber !== request.stepNumber ||
      source.revision !== a.expectedRevision ||
      a.quantity > source.remaining
    )
      throw Error(
        "Источник удержан, остаток превышен или исходная партия/версия изменена",
      );
  }
}
export async function freezeCuttingConsumption(
  scope: InventoryScope,
  localActorId: string,
  epoch: string,
  input: CuttingConsumptionRequest,
  choices: CuttingRollSource[],
) {
  const user = await db.users.get(localActorId),
    request = copyCuttingRequest(input),
    sources = choices.map(copyCuttingRollSource);
  if (!user?.isActive || !id(epoch))
    throw Error("Неизвестный автор или история Cutting");
  validateIntent(scope, request, sources);
  return inventoryOutbox.transaction(
    "rw",
    inventoryOutbox.receivingDrafts,
    async () => {
      const key = JSON.stringify([
          inventoryScopeKey(scope),
          localActorId,
          "cutting-consumption",
          request.operationId,
        ]),
        old = await inventoryOutbox.receivingDrafts.get(key);
      if (old) {
        if (
          old.fields.request === JSON.stringify(input) &&
          old.fields.epoch === epoch &&
          same(JSON.parse(old.fields.sources), sources)
        )
          return old;
        throw Error("Исходное измерение уже удержано");
      }
      const occupied = await inventoryOutbox.receivingDrafts
        .filter((row) => {
          try {
            if (JSON.parse(row.key)[2] !== "cutting-consumption")
              return false;
            const r: CuttingConsumptionRequest = JSON.parse(
              row.fields.request,
            );
            return (
              r.operationId === request.operationId ||
              (row.fields.state === "pending" &&
                r.allocations.some((a) =>
                  request.allocations.some((b) => b.receiptId === a.receiptId),
                ))
            );
          } catch {
            return false;
          }
        })
        .first();
      if (occupied)
        throw Error(
          "Источник удержан ожидающим измерением; подтвердите исходное событие и обновите остаток",
        );
      const row: ReceivingDraft = {
        key,
        revision: 1,
        operationId: request.operationId,
        fields: {
          state: "pending",
          epoch,
          localRole: user.role,
          request: JSON.stringify(input),
          sources: JSON.stringify(sources),
        },
      };
      await inventoryOutbox.receivingDrafts.add(row);
      return row;
    },
  );
}
export function sendCuttingConsumption(
  session: HybridSession,
  scope: InventoryScope,
  actor: string,
  key: string,
) {
  return withInventorySync(scope, async () => {
    const row = (await cuttingConsumptionProposals(scope, actor)).find(
      (r) => r.key === key,
    );
    if (!row || row.fields.state !== "pending")
      throw Error("Нет исходного ожидающего расхода Cutting");
    const request = copyCuttingRequest(JSON.parse(row.fields.request)),
      sources: CuttingRollSource[] = JSON.parse(row.fields.sources).map(
        copyCuttingRollSource,
      ),
      user = await db.users.get(actor);
    if (
      !user?.isActive ||
      user.role !== row.fields.localRole ||
      request.operationId !== row.operationId ||
      !same(JSON.parse(row.fields.request), request) ||
      !same(JSON.parse(row.fields.sources), sources)
    )
      throw Error("Исходный автор или измерение изменено");
    validateIntent(scope, request, sources);
    const context = await loadInventoryIssueContext(session, scope);
    if (context.epoch !== row.fields.epoch || !context.postingEnabled)
      throw Error("История изменилась; исходный расход Cutting удержан");
    const response = await inventoryRequest(
      session,
      scope,
      "/inventory/room-materials/cutting/consumptions",
      {
        method: "POST",
        headers: { "x-inventory-epoch": row.fields.epoch },
        body: row.fields.request,
      },
    );
    async function commit(fields: Record<string, string>) {
      await inventoryOutbox.transaction(
        "rw",
        inventoryOutbox.receivingDrafts,
        async () => {
          if (!same(await inventoryOutbox.receivingDrafts.get(key), row))
            throw Error("Исходное предложение изменилось при ожидании ответа");
          await inventoryOutbox.receivingDrafts.put({
            ...row!,
            revision: row!.revision + 1,
            fields: { ...row!.fields, ...fields },
          });
        },
      );
    }
    if ([400, 404, 409].includes(response.status)) {
      await commit({
        state: response.status === 409 ? "conflict" : "rejected",
        error: "HTTP " + response.status,
      });
      throw Error(
        "Расход Cutting не принят; исходные данные сохранены: HTTP " +
          response.status,
      );
    }
    if (![200, 201].includes(response.status))
      throw Error(
        "Ответ неизвестен / доступ утрачен; повторите исходный ID: HTTP " +
          response.status,
      );
    const raw = await response.json(),
      consumption = copyCuttingConsumption(raw?.consumption),
      expected = {
        ...request,
        room: "cutting",
        unit: "mm",
        actorId: scope.actorId,
        recordedAt: consumption.recordedAt,
        warehouseEffect: "none",
        sources: request.allocations.map((a) => ({
          allocationOperationId: a.operationId,
          source: copyBalance(
            sources.find((s) => s.receipt.operationId === a.receiptId)!,
          ),
        })),
      };
    if (
      raw.status !== (response.status === 201 ? "confirmed" : "duplicate") ||
      raw.operationId !== request.operationId ||
      !same(consumption, expected)
    )
      throw Error(
        "Ответ расхода не совпадает с исходными измерениями и принятыми лотами",
      );
    await commit({
      state: "accepted",
      acknowledgement: JSON.stringify({
        status: raw.status,
        operationId: request.operationId,
        consumption,
      }),
    });
  });
}

/** Exact m→mm conversion; physical roll capacity comes only from its recorded measurement. */
export function measuredCuttingMm(value: string) {
  return toInventoryBaseUnits(value, "m", "mm");
}
