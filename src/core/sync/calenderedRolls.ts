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
  copyCalenderedRequest,
  copyCalenderedDeclaration,
  copyCalenderedSources,
  copyCalenderedInput,
  copyCalenderedLot,
  copyCalenderedHandoffRead,
  copyCalenderedOfferRequest,
  copyCalenderedHandoff,
  copyCalenderedReceiptRequest,
  copyCalenderedReceipt,
  type CalenderedOutputRequest,
  type CalenderedInput,
  type CalenderedLot,
  type CalenderedHandoffRead,
  type CalenderedOfferRequest,
  type CalenderedReceiptRequest,
  type CalenderedSources,
} from "./calenderedRollTypes";
export * from "./calenderedRollTypes";
interface OutputBase {
  inputs: CalenderedInput[];
}
interface OfferBase {
  lot: CalenderedLot;
  recipient: { id: string; name: string };
  destinationStepNumber: number;
  recipientWorkshopId: string;
}
interface ReceiptBase {
  handoff: CalenderedHandoffRead;
}
export type CalenderedCommand =
  | { kind: "output"; request: CalenderedOutputRequest; base: OutputBase }
  | { kind: "offer"; request: CalenderedOfferRequest; base: OfferBase }
  | { kind: "receipt"; request: CalenderedReceiptRequest; base: ReceiptBase };
const invalid = (): never => {
  throw Error("Исходный выпуск, передача или приёмка изменены");
};
function copyCommand(command: CalenderedCommand): CalenderedCommand {
  if (command.kind === "output") {
    const request = copyCalenderedRequest(command.request),
      inputs = command.base.inputs.map(copyCalenderedInput);
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
    const request = copyCalenderedOfferRequest(command.request),
      lot = copyCalenderedLot(command.base.lot),
      r = command.base.recipient;
    if (
      !lot.eligible ||
      lot.remaining !== 1 ||
      lot.revision !== request.expectedSourceRevision ||
      lot.id !== request.outputLotId ||
      lot.snapshot.roll.disposition !== "ready" ||
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
    const request = copyCalenderedReceiptRequest(command.request),
      handoff = copyCalenderedHandoffRead(command.base.handoff);
    if (
      request.handoffId !== handoff.operationId ||
      handoff.received ||
      (request.kind === "receive" &&
        (!handoff.eligible ||
          request.observedRollLabel !==
            handoff.handoff.sourceSnapshot.roll.label ||
          (request.observedLengthMm !== null &&
            request.observedLengthMm !==
              handoff.handoff.sourceSnapshot.roll.measuredLengthMm)))
    )
      throw Error(
        "Проверьте физическую идентичность рулона и состояние передачи; несоответствие сохраните отдельно",
      );
    return { kind: "receipt", request, base: { handoff } };
  }
  return invalid();
}
function sources(
  command: Extract<CalenderedCommand, { kind: "output" }>,
): CalenderedSources {
  return copyCalenderedSources(
    command.request,
    command.request.consumptionIds.map(
      (id) =>
        command.base.inputs.find((i) => i.operationId === id)!.consumption,
    ),
  );
}
export function calenderedProposals(scope: InventoryScope, actor: string) {
  return inventoryOutbox.receivingDrafts
    .filter((r) => {
      try {
        const key = JSON.parse(r.key);
        return (
          key[0] === inventoryScopeKey(scope) &&
          key[1] === actor &&
          key[2] === "calendered-roll"
        );
      } catch {
        return false;
      }
    })
    .toArray();
}
function overlaps(a: CalenderedCommand, b: CalenderedCommand) {
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
export async function freezeCalenderedCommand(
  scope: InventoryScope,
  actor: string,
  epoch: string,
  input: CalenderedCommand,
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
          "calendered-roll",
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
            if (JSON.parse(row.key)[2] !== "calendered-roll") return false;
            const prior = {
              kind: row.fields.kind,
              request: JSON.parse(row.fields.request),
              base: JSON.parse(row.fields.base),
            } as CalenderedCommand;
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
export function sendCalenderedCommand(
  session: HybridSession,
  scope: InventoryScope,
  actor: string,
  key: string,
) {
  return withInventorySync(scope, async () => {
    const row = (await calenderedProposals(scope, actor)).find(
      (r) => r.key === key,
    );
    if (!row || row.fields.state !== "pending")
      throw Error("Нет исходного ожидающего действия с рулоном");
    const rawRequest = JSON.parse(row.fields.request),
      rawBase = JSON.parse(row.fields.base),
      command = copyCommand({
        kind: row.fields.kind,
        request: rawRequest,
        base: rawBase,
      } as CalenderedCommand),
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
        "/inventory/calendered-rolls" + suffix,
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
      const c = copyCalenderedDeclaration(raw?.declaration);
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
      const h = copyCalenderedHandoff(raw?.handoff);
      result = h;
      expected = {
        ...command.request,
        productionBatchId:
          command.base.lot.snapshot.declaration.productionBatchId,
        sourceRoom: "calendaring",
        destinationRoom: "cutting",
        recipientWorkshopId: command.base.recipientWorkshopId,
        sourceSnapshot: command.base.lot.snapshot,
        actorId: scope.actorId,
        recordedAt: h.recordedAt,
        unit: "rolls",
        warehouseEffect: "none",
      };
    } else {
      field = "receipt";
      const r = copyCalenderedReceipt(raw?.receipt);
      result = r;
      expected = {
        ...command.request,
        sourceSnapshot: command.base.handoff.handoff,
        actorId: scope.actorId,
        recordedAt: r.recordedAt,
        custodyEffect: command.request.kind === "receive" ? "received" : "none",
        unit: "rolls",
        warehouseEffect: "none",
      };
    }
    if (
      raw.status !== (response.status === 201 ? "confirmed" : "duplicate") ||
      raw.operationId !== command.request.operationId ||
      !same(result, expected)
    )
      throw Error(
        "Ответ не совпадает с исходными измерениями, рулоном или передачей",
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
export async function loadCalenderedInputs(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/calendered-rolls/inputs",
      copyCalenderedInput,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadCalenderedRolls(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/calendered-rolls",
      copyCalenderedLot,
      (r) => r.id,
      after,
    )
  ).page;
}
export async function loadCalenderedHistory(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/calendered-rolls/history",
      copyCalenderedDeclaration,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadCalenderedHandoffs(
  session: HybridSession,
  scope: InventoryScope,
  room: "calendaring" | "cutting",
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/calendered-rolls/handoffs",
      copyCalenderedHandoffRead,
      (r) => r.operationId,
      after,
      { room },
    )
  ).page;
}
export async function loadCalenderedEvents(
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
      "/inventory/calendered-rolls/handoffs/" + handoffId + "/events",
      copyCalenderedReceipt,
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
    (r.unit !== undefined && r.unit !== "rolls")
  )
    return invalid();
  return {
    id: r.id,
    name: r.name,
    ...(r.code ? { code: r.code } : {}),
    ...(r.unit ? { unit: "rolls" as const } : {}),
  };
};
export async function loadCalenderedMaterials(
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
      "/inventory/calendered-rolls/materials",
      copyOption,
      (r) => r.id,
      after,
      { productionBatchId: batch, stepNumber: String(step) },
    )
  ).page;
}
export async function loadCalenderedRecipients(
  session: HybridSession,
  scope: InventoryScope,
  lot: string,
  after?: string,
) {
  if (!id(lot)) return invalid();
  const { page, raw } = await readPage(
    session,
    scope,
    "/inventory/calendered-rolls/recipients",
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
