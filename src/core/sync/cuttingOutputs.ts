import { db } from "../db";
import type { HybridSession } from "./hybridClient";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import { readPage } from "./roomCustody";
import {
  issueIdValid as id,
  issueTextValid as text,
} from "./inventoryIssueTypes";
import { sameOutput as same } from "./inventoryOutputTypes";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type InventoryScope,
  type ReceivingDraft,
} from "./inventoryOutbox";
import { withInventorySync } from "./inventorySyncLock";
import {
  copyCutOutputRequest,
  copyCutOutputDeclaration,
  copyCutOutputSources,
  copyCutOutputInput,
  copyCutOutputLot,
  copyCutOutputHandoffRead,
  copyCutOutputOfferRequest,
  copyCutOutputHandoff,
  copyCutOutputReceiptRequest,
  copyCutOutputReceipt,
  type CutOutputRequest,
  type CutOutputInput,
  type CutOutputLot,
  type CutOutputHandoffRead,
  type CutOutputOfferRequest,
  type CutOutputReceiptRequest,
  type CutOutputSources,
} from "./cuttingOutputTypes";
export * from "./cuttingOutputTypes";
interface OutputBase {
  inputs: CutOutputInput[];
}
interface OfferBase {
  lot: CutOutputLot;
  recipient: { id: string; name: string };
  destinationStepNumber: number;
  recipientWorkshopId: string;
}
interface ReceiptBase {
  handoff: CutOutputHandoffRead;
}
export type CutOutputCommand =
  | { kind: "output"; request: CutOutputRequest; base: OutputBase }
  | { kind: "offer"; request: CutOutputOfferRequest; base: OfferBase }
  | { kind: "receipt"; request: CutOutputReceiptRequest; base: ReceiptBase };
const invalid = (): never => {
  throw Error("Исходный выпуск, передача или приёмка изменены");
};
function copyCommand(command: CutOutputCommand): CutOutputCommand {
  if (command.kind === "output") {
    const request = copyCutOutputRequest(command.request),
      inputs = command.base.inputs.map(copyCutOutputInput);
    if (
      inputs.length !== request.consumptionIds.length ||
      new Set(inputs.map((i) => i.operationId)).size !== inputs.length ||
      new Set(inputs.map((i) => i.materialId)).size !== 1
    )
      invalid();
    for (const id of request.consumptionIds) {
      const input = inputs.find((i) => i.operationId === id);
      if (
        !input ||
        !input.eligible ||
        input.claimedBy ||
        input.productionBatchId !== request.productionBatchId ||
        input.stepNumber !== request.stepNumber
      )
        invalid();
    }
    return { kind: "output", request, base: { inputs } };
  }
  if (command.kind === "offer") {
    const request = copyCutOutputOfferRequest(command.request),
      lot = copyCutOutputLot(command.base.lot),
      r = command.base.recipient;
    if (
      !lot.eligible ||
      request.quantity > lot.remaining ||
      lot.revision !== request.expectedSourceRevision ||
      lot.id !== request.outputLotId ||
      lot.snapshot.lot.disposition !== "ready" ||
      !r ||
      !id(r.id) ||
      !text(r.name) ||
      r.id !== request.recipientId ||
      request.destinationStepNumber !== command.base.destinationStepNumber ||
      request.destinationStepNumber <= lot.snapshot.declaration.stepNumber ||
      !text(command.base.recipientWorkshopId)
    )
      invalid();
    return {
      kind: "offer",
      request,
      base: {
        lot,
        recipient: { id: r.id, name: r.name },
        destinationStepNumber: request.destinationStepNumber,
        recipientWorkshopId: command.base.recipientWorkshopId,
      },
    };
  }
  if (command.kind === "receipt") {
    const request = copyCutOutputReceiptRequest(command.request),
      handoff = copyCutOutputHandoffRead(command.base.handoff);
    if (
      request.handoffId !== handoff.operationId ||
      handoff.received ||
      (request.kind === "receive" &&
        (!handoff.eligible ||
          request.observedQuantity !== handoff.handoff.quantity ||
          request.observedLotLabel !==
            handoff.handoff.sourceSnapshot.lot.label))
    )
      throw Error(
        "Проверьте физическую идентичность исходного лота и состояние передачи; несоответствие сохраните отдельно",
      );
    return { kind: "receipt", request, base: { handoff } };
  }
  return invalid();
}
function sources(
  command: Extract<CutOutputCommand, { kind: "output" }>,
): CutOutputSources {
  return copyCutOutputSources(
    command.request,
    command.request.consumptionIds.map(
      (id) =>
        command.base.inputs.find((i) => i.operationId === id)!.consumption,
    ),
  );
}
export function cutOutputProposals(scope: InventoryScope, actor: string) {
  return inventoryOutbox.receivingDrafts
    .filter((r) => {
      try {
        const key = JSON.parse(r.key);
        return (
          key[0] === inventoryScopeKey(scope) &&
          key[1] === actor &&
          key[2] === "cut-output"
        );
      } catch {
        return false;
      }
    })
    .toArray();
}
function overlaps(a: CutOutputCommand, b: CutOutputCommand) {
  if (a.request.operationId === b.request.operationId) return true;
  if (a.kind === "output" && b.kind === "output")
    return a.request.consumptionIds.some((id) =>
      b.request.consumptionIds.includes(id),
    );
  return a.kind === "offer" && b.kind === "offer"
    ? a.request.outputLotId === b.request.outputLotId
    : a.kind === "receipt" &&
        b.kind === "receipt" &&
        a.request.handoffId === b.request.handoffId;
}
export async function freezeCutOutputCommand(
  scope: InventoryScope,
  actor: string,
  epoch: string,
  input: CutOutputCommand,
) {
  const original = JSON.stringify(input.request),
    command = copyCommand(input),
    user = await db.users.get(actor);
  if (
    !user?.isActive ||
    !id(epoch) ||
    command.request.deviceId !== scope.deviceId ||
    (command.kind === "receipt" &&
      command.base.handoff.handoff.recipientId !== scope.actorId)
  )
    throw Error("Неизвестный автор, история или назначенный получатель");
  const localRole = user.role;
  return inventoryOutbox.transaction(
    "rw",
    inventoryOutbox.receivingDrafts,
    async () => {
      const key = JSON.stringify([
          inventoryScopeKey(scope),
          actor,
          "cut-output",
          command.request.operationId,
        ]),
        old = await inventoryOutbox.receivingDrafts.get(key);
      if (old) {
        if (
          old.fields.kind === command.kind &&
          old.fields.request === original &&
          old.fields.epoch === epoch &&
          same(JSON.parse(old.fields.base), command.base)
        )
          return old;
        return invalid();
      }
      const occupied = await inventoryOutbox.receivingDrafts
        .filter((row) => {
          try {
            if (JSON.parse(row.key)[2] !== "cut-output") return false;
            const prior = {
              kind: row.fields.kind,
              request: JSON.parse(row.fields.request),
              base: JSON.parse(row.fields.base),
            } as CutOutputCommand;
            return (
              prior.request.operationId === command.request.operationId ||
              (row.fields.state === "pending" && overlaps(command, prior))
            );
          } catch {
            return false;
          }
        })
        .first();
      if (occupied)
        throw Error("Источник уже удержан ожидающим исходным предложением");
      const row: ReceivingDraft = {
        key,
        revision: 1,
        operationId: command.request.operationId,
        fields: {
          kind: command.kind,
          state: "pending",
          request: original,
          base: JSON.stringify(command.base),
          epoch,
          localRole,
        },
      };
      await inventoryOutbox.receivingDrafts.add(row);
      return row;
    },
  );
}
export function sendCutOutputCommand(
  session: HybridSession,
  scope: InventoryScope,
  actor: string,
  key: string,
) {
  return withInventorySync(scope, async () => {
    const row = (await cutOutputProposals(scope, actor)).find(
      (r) => r.key === key,
    );
    if (!row || row.fields.state !== "pending")
      throw Error("Нет исходного ожидающего действия с лотом");
    const rawRequest = JSON.parse(row.fields.request),
      rawBase = JSON.parse(row.fields.base),
      command = copyCommand({
        kind: row.fields.kind,
        request: rawRequest,
        base: rawBase,
      } as CutOutputCommand),
      user = await db.users.get(actor);
    if (
      !user?.isActive ||
      user.role !== row.fields.localRole ||
      command.request.deviceId !== scope.deviceId ||
      command.request.operationId !== row.operationId ||
      !same(rawRequest, command.request) ||
      !same(rawBase, command.base) ||
      (command.kind === "receipt" &&
        command.base.handoff.handoff.recipientId !== scope.actorId)
    )
      invalid();
    const ctx = await loadInventoryIssueContext(session, scope);
    if (ctx.epoch !== row.fields.epoch || !ctx.postingEnabled)
      throw Error("История изменилась; исходное предложение сохранено");
    const suffix =
        command.kind === "output"
          ? ""
          : command.kind === "offer"
            ? "/handoffs"
            : "/acknowledgements",
      response = await inventoryRequest(
        session,
        scope,
        "/inventory/cutting-outputs" + suffix,
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
        "Действие не принято; исходные данные сохранены: HTTP " +
          response.status,
      );
    }
    if (![200, 201].includes(response.status))
      throw Error(
        "Ответ неизвестен / доступ утрачен; повторите исходный ID: HTTP " +
          response.status,
      );
    const raw = await response.json();
    let field: string, result: unknown, expected: unknown;
    if (command.kind === "output") {
      field = "declaration";
      const c = copyCutOutputDeclaration(raw?.declaration);
      result = c;
      expected = {
        ...command.request,
        sources: sources(command),
        actorId: scope.actorId,
        recordedAt: c.recordedAt,
        qualityStatus: "unreviewed",
        materialAccountingStatus: "unreconciled",
        genealogyScope: "declaration",
        warehouseEffect: "none",
      };
    } else if (command.kind === "offer") {
      field = "handoff";
      const h = copyCutOutputHandoff(raw?.handoff);
      result = h;
      expected = {
        ...command.request,
        productionBatchId:
          command.base.lot.snapshot.declaration.productionBatchId,
        sourceRoom: "cutting",
        destinationRoom: "sorting",
        recipientWorkshopId: command.base.recipientWorkshopId,
        sourceSnapshot: command.base.lot.snapshot,
        actorId: scope.actorId,
        recordedAt: h.recordedAt,
        unit: "pieces",
        warehouseEffect: "none",
      };
    } else {
      field = "receipt";
      const r = copyCutOutputReceipt(raw?.receipt);
      result = r;
      expected = {
        ...command.request,
        sourceSnapshot: command.base.handoff.handoff,
        actorId: scope.actorId,
        recordedAt: r.recordedAt,
        custodyEffect: command.request.kind === "receive" ? "received" : "none",
        unit: "pieces",
        warehouseEffect: "none",
      };
    }
    if (
      raw.status !== (response.status === 201 ? "confirmed" : "duplicate") ||
      raw.operationId !== command.request.operationId ||
      !same(result, expected)
    )
      throw Error(
        "Ответ не совпадает с исходными измерениями, лотом или передачей",
      );
    await commit({
      state: "accepted",
      acknowledgement: JSON.stringify({
        status: raw.status,
        operationId: command.request.operationId,
        [field]: result,
      }),
    });
  });
}
export async function loadCutOutputInputs(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/cutting-outputs/inputs",
      copyCutOutputInput,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadCutOutputLots(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/cutting-outputs",
      copyCutOutputLot,
      (r) => r.id,
      after,
    )
  ).page;
}
export async function loadCutOutputHistory(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/cutting-outputs/history",
      copyCutOutputDeclaration,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadCutOutputHandoffs(
  session: HybridSession,
  scope: InventoryScope,
  room: "cutting" | "sorting",
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/cutting-outputs/handoffs",
      copyCutOutputHandoffRead,
      (r) => r.operationId,
      after,
      { room },
    )
  ).page;
}
export async function loadCutOutputEvents(
  session: HybridSession,
  scope: InventoryScope,
  handoffId: string,
  after?: string,
) {
  if (!id(handoffId)) return invalid();
  return (
    await readPage(
      session,
      scope,
      "/inventory/cutting-outputs/handoffs/" + handoffId + "/events",
      copyCutOutputReceipt,
      (r) => r.operationId,
      after,
    )
  ).page;
}
const copyOption = (value: unknown) => {
  const r = value as { id: string; name: string; code?: string; unit?: string };
  if (
    !r ||
    !id(r.id) ||
    !text(r.name) ||
    (r.code !== undefined && !text(r.code)) ||
    (r.unit !== undefined && r.unit !== "pieces")
  )
    return invalid();
  return {
    id: r.id,
    name: r.name,
    ...(r.code ? { code: r.code } : {}),
    ...(r.unit ? { unit: "pieces" as const } : {}),
  };
};
export async function loadCutOutputMaterials(
  session: HybridSession,
  scope: InventoryScope,
  batch: string,
  step: number,
  after?: string,
) {
  if (!id(batch) || !Number.isInteger(step) || step < 1) return invalid();
  return (
    await readPage(
      session,
      scope,
      "/inventory/cutting-outputs/materials",
      copyOption,
      (r) => r.id,
      after,
      { productionBatchId: batch, stepNumber: String(step) },
    )
  ).page;
}
export async function loadCutOutputRecipients(
  session: HybridSession,
  scope: InventoryScope,
  lot: string,
  after?: string,
) {
  if (!id(lot)) return invalid();
  const { page, raw } = await readPage(
    session,
    scope,
    "/inventory/cutting-outputs/recipients",
    copyOption,
    (r) => r.id,
    after,
    { outputLotId: lot },
  );
  if (
    !Number.isSafeInteger(raw.destinationStepNumber) ||
    raw.destinationStepNumber < 1 ||
    !text(raw.recipientWorkshopId)
  )
    return invalid();
  return {
    ...page,
    destinationStepNumber: raw.destinationStepNumber as number,
    recipientWorkshopId: raw.recipientWorkshopId as string,
  };
}
