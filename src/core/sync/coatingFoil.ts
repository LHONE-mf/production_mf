import { db } from "../db";
import type { HybridSession } from "./hybridClient";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import {
  issueIdValid as id,
  issueTextValid as text,
  validateIssue,
  issueSource,
  type InventoryIssue,
} from "./inventoryIssueTypes";
import {
  validateSettlement,
  outcomeInteger as integer,
  outcomeInstant as instant,
  type InventorySettlement,
} from "./inventoryOutcomeTypes";
import { readPage } from "./roomCustody";
import { sameOutput as same } from "./inventoryOutputTypes";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type InventoryScope,
  type ReceivingDraft,
  type InventoryStockSnapshot,
} from "./inventoryOutbox";
import { withInventorySync } from "./inventorySyncLock";
export interface FoilAllocation {
  operationId: string;
  issueId: string;
  quantity: number;
  expectedSettlementRevision: number;
}
export interface FoilRequest {
  operationId: string;
  deviceId: string;
  productionBatchId: string;
  stepNumber: number;
  materialId: string;
  unit: "mg" | "mm";
  observedAt: number;
  reference: string;
  specificationReference: string;
  actualQuantity: number;
  allocations: FoilAllocation[];
  reason: string;
  evidence: string;
}
interface FoilBalance {
  issue: InventoryIssue;
  settlement: InventorySettlement;
}
export interface FoilSource extends FoilBalance {
  room: "coating";
  materialName: string;
  materialCode: string;
  batchCode: string;
  eligible: boolean;
}
export interface FoilConsumption extends FoilRequest {
  room: "coating";
  actorId: string;
  recordedAt: string;
  warehouseEffect: "none";
  sources: FoilBalance[];
}
const invalid = (): never => {
  throw Error("Некорректные исходные данные расхода фольги");
};
const object = (r: unknown): Record<string, unknown> =>
  r && typeof r === "object" && !Array.isArray(r)
    ? (r as Record<string, unknown>)
    : invalid();
const keys = [
  "operationId",
  "deviceId",
  "productionBatchId",
  "stepNumber",
  "materialId",
  "unit",
  "observedAt",
  "reference",
  "specificationReference",
  "actualQuantity",
  "allocations",
  "reason",
  "evidence",
];
export function copyFoilRequest(value: unknown): FoilRequest {
  const r = object(value);
  if (
    Object.keys(r).some((k) => !keys.includes(k)) ||
    ![r.operationId, r.deviceId, r.productionBatchId, r.materialId].every(id) ||
    !integer(r.stepNumber, 1, 2147483647) ||
    !["mg", "mm"].includes(String(r.unit)) ||
    typeof r.observedAt !== "number" ||
    !Number.isFinite(r.observedAt) ||
    r.observedAt <= 0 ||
    ![r.reference, r.specificationReference, r.reason, r.evidence].every(
      text,
    ) ||
    !integer(r.actualQuantity, 1) ||
    !Array.isArray(r.allocations) ||
    !r.allocations.length ||
    r.allocations.length > 100
  )
    invalid();
  const allocations = (r.allocations as unknown[]).map((value) => {
    const a = object(value);
    if (
      Object.keys(a).some(
        (k) =>
          ![
            "operationId",
            "issueId",
            "quantity",
            "expectedSettlementRevision",
          ].includes(k),
      ) ||
      ![a.operationId, a.issueId].every(id) ||
      !integer(a.quantity, 1) ||
      !integer(a.expectedSettlementRevision, 1, Number.MAX_SAFE_INTEGER - 1)
    )
      invalid();
    return {
      operationId: a.operationId as string,
      issueId: a.issueId as string,
      quantity: a.quantity as number,
      expectedSettlementRevision: a.expectedSettlementRevision as number,
    };
  });
  if (
    new Set([r.operationId, ...allocations.map((a) => a.operationId)]).size !==
      allocations.length + 1 ||
    new Set(allocations.map((a) => a.issueId)).size !== allocations.length ||
    allocations.reduce((n, a) => n + BigInt(a.quantity), 0n) !==
      BigInt(r.actualQuantity as number)
  )
    invalid();
  return {
    operationId: r.operationId as string,
    deviceId: r.deviceId as string,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    materialId: r.materialId as string,
    unit: r.unit as FoilRequest["unit"],
    observedAt: r.observedAt as number,
    reference: r.reference as string,
    specificationReference: r.specificationReference as string,
    actualQuantity: r.actualQuantity as number,
    allocations,
    reason: r.reason as string,
    evidence: r.evidence as string,
  };
}
function copyBalance(value: unknown): FoilBalance {
  const r = object(value);
  validateIssue(r.issue);
  validateSettlement(r.settlement);
  if (
    r.issue.state !== "received" ||
    !["mg", "mm"].includes(r.issue.unit) ||
    r.issue.tapeSpecification !== undefined ||
    r.settlement.issued !== r.issue.quantity
  )
    invalid();
  const names = [
    "id",
    "materialId",
    "productionBatchId",
    "stepNumber",
    "workshopId",
    "recipientId",
    "requestedBy",
    "quantity",
    "unit",
    "state",
    "revision",
    "stockId",
    "approvalOperationId",
    "approvedStockRevision",
    "approvedBy",
    "approvedDeviceId",
    "dispatchOperationId",
    "receiptOperationId",
  ] as const;
  const originalIssue = r.issue;
  const issue = {
    ...Object.fromEntries(names.map((k) => [k, originalIssue[k]])),
    source: issueSource({
      ...r.issue.source,
      onHand: 0,
      reserved: 0,
      available: 0,
      revision: 1,
    } as InventoryStockSnapshot),
  } as InventoryIssue;
  const settlement = {
    revision: r.settlement.revision,
    issued: r.settlement.issued,
    returned: r.settlement.returned,
    scrapped: r.settlement.scrapped,
    consumed: r.settlement.consumed,
    outstanding: r.settlement.outstanding,
  };
  return { issue, settlement };
}
export function copyFoilSource(value: unknown): FoilSource {
  const r = object(value),
    source = copyBalance(value);
  if (
    r.room !== "coating" ||
    ![r.materialName, r.materialCode, r.batchCode].every(text) ||
    typeof r.eligible !== "boolean"
  )
    invalid();
  return {
    ...source,
    room: "coating",
    materialName: r.materialName as string,
    materialCode: r.materialCode as string,
    batchCode: r.batchCode as string,
    eligible: r.eligible as boolean,
  };
}
function copyConsumption(value: unknown): FoilConsumption {
  const r = object(value),
    request = copyFoilRequest(Object.fromEntries(keys.map((k) => [k, r[k]])));
  if (
    r.room !== "coating" ||
    r.warehouseEffect !== "none" ||
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    !Array.isArray(r.sources) ||
    r.sources.length !== request.allocations.length
  )
    invalid();
  const sources = (r.sources as unknown[]).map((s, index) => {
    const source = copyBalance(s),
      a = request.allocations[index];
    if (
      source.issue.id !== a.issueId ||
      source.issue.materialId !== request.materialId ||
      source.issue.unit !== request.unit ||
      source.issue.productionBatchId !== request.productionBatchId ||
      source.issue.stepNumber !== request.stepNumber ||
      source.settlement.revision !== a.expectedSettlementRevision ||
      a.quantity > source.settlement.outstanding
    )
      invalid();
    return source;
  });
  return {
    ...request,
    room: "coating",
    warehouseEffect: "none",
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    sources,
  };
}
export async function loadFoilSources(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/room-materials/coating/foil",
      copyFoilSource,
      (s) => s.issue.id,
      after,
    )
  ).page;
}
export async function loadFoilHistory(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/room-materials/coating/foil-consumptions",
      copyConsumption,
      (s) => s.operationId,
      after,
    )
  ).page;
}
export function foilProposals(scope: InventoryScope, actor: string) {
  return inventoryOutbox.receivingDrafts
    .filter((row) => {
      try {
        const key = JSON.parse(row.key);
        return (
          key[0] === inventoryScopeKey(scope) &&
          key[1] === actor &&
          key[2] === "coating-foil"
        );
      } catch {
        return false;
      }
    })
    .toArray();
}
function validateIntent(
  scope: InventoryScope,
  request: FoilRequest,
  sources: FoilSource[],
) {
  if (
    request.deviceId !== scope.deviceId ||
    sources.length !== request.allocations.length ||
    new Set(sources.map((s) => s.issue.id)).size !== sources.length
  )
    invalid();
  for (const a of request.allocations) {
    const s = sources.find((s) => s.issue.id === a.issueId);
    if (
      !s?.eligible ||
      s.issue.materialId !== request.materialId ||
      s.issue.unit !== request.unit ||
      s.issue.productionBatchId !== request.productionBatchId ||
      s.issue.stepNumber !== request.stepNumber ||
      s.settlement.revision !== a.expectedSettlementRevision ||
      a.quantity > s.settlement.outstanding
    )
      throw Error(
        "Источник удержан, партия/единица/версия изменена или превышен остаток",
      );
  }
}
export async function freezeFoilConsumption(
  scope: InventoryScope,
  actor: string,
  epoch: string,
  input: FoilRequest,
  choices: FoilSource[],
) {
  const original = JSON.stringify(input),
    request = copyFoilRequest(JSON.parse(original)),
    sources = choices.map(copyFoilSource),
    user = await db.users.get(actor);
  if (!user || !user.isActive || !id(epoch))
    throw Error("Неизвестный автор или история Coating");
  const localRole = user.role;
  validateIntent(scope, request, sources);
  return inventoryOutbox.transaction(
    "rw",
    inventoryOutbox.receivingDrafts,
    async () => {
      const key = JSON.stringify([
          inventoryScopeKey(scope),
          actor,
          "coating-foil",
          request.operationId,
        ]),
        old = await inventoryOutbox.receivingDrafts.get(key);
      if (old) {
        if (
          old.fields.request === original &&
          old.fields.epoch === epoch &&
          same(JSON.parse(old.fields.sources), sources)
        )
          return old;
        throw Error("Исходное измерение уже удержано");
      }
      const occupied = await inventoryOutbox.receivingDrafts
        .filter((row) => {
          try {
            if (JSON.parse(row.key)[2] !== "coating-foil") return false;
            const r: FoilRequest = JSON.parse(row.fields.request);
            return (
              r.operationId === request.operationId ||
              (row.fields.state === "pending" &&
                r.allocations.some((a) =>
                  request.allocations.some((b) => b.issueId === a.issueId),
                ))
            );
          } catch {
            return false;
          }
        })
        .first();
      if (occupied)
        throw Error(
          "Источник удержан ожидающим измерением; подтвердите исходное событие",
        );
      const row: ReceivingDraft = {
        key,
        revision: 1,
        operationId: request.operationId,
        fields: {
          state: "pending",
          epoch,
          localRole,
          request: original,
          sources: JSON.stringify(sources),
        },
      };
      await inventoryOutbox.receivingDrafts.add(row);
      return row;
    },
  );
}
export function sendFoilConsumption(
  session: HybridSession,
  scope: InventoryScope,
  actor: string,
  key: string,
) {
  return withInventorySync(scope, async () => {
    const row = (await foilProposals(scope, actor)).find((r) => r.key === key);
    if (!row || row.fields.state !== "pending")
      throw Error("Нет исходного ожидающего расхода фольги");
    const request = copyFoilRequest(JSON.parse(row.fields.request)),
      sources: FoilSource[] = JSON.parse(row.fields.sources).map(
        copyFoilSource,
      ),
      user = await db.users.get(actor);
    if (
      !user?.isActive ||
      user.role !== row.fields.localRole ||
      request.operationId !== row.operationId ||
      !same(request, JSON.parse(row.fields.request)) ||
      !same(sources, JSON.parse(row.fields.sources))
    )
      throw Error("Исходный автор или измерение изменено");
    validateIntent(scope, request, sources);
    const context = await loadInventoryIssueContext(session, scope);
    if (context.epoch !== row.fields.epoch || !context.postingEnabled)
      throw Error("История изменилась; исходный расход фольги удержан");
    const response = await inventoryRequest(
      session,
      scope,
      "/inventory/room-materials/coating/foil-consumptions",
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
        "Расход не принят; исходное измерение сохранено: HTTP " +
          response.status,
      );
    }
    if (![200, 201].includes(response.status))
      throw Error(
        "Ответ неизвестен / доступ утрачен; повторите исходный ID: HTTP " +
          response.status,
      );
    const raw = await response.json(),
      consumption = copyConsumption(raw?.consumption),
      expected = {
        ...request,
        room: "coating",
        actorId: scope.actorId,
        recordedAt: consumption.recordedAt,
        warehouseEffect: "none",
        sources: request.allocations.map((a) =>
          copyBalance(sources.find((s) => s.issue.id === a.issueId)!),
        ),
      };
    if (
      raw.status !== (response.status === 201 ? "confirmed" : "duplicate") ||
      raw.operationId !== request.operationId ||
      !same(consumption, expected)
    )
      throw Error(
        "Ответ расхода не совпадает с исходным измерением и принятыми лотами",
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
