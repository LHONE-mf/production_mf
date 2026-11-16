import { db } from "../db";
import type { HybridSession } from "./hybridClient";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import { readPage } from "./roomCustody";
import {
  copyInventoryIssue,
  issueIdValid as id,
  issueTextValid as text,
  type InventoryIssue,
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
  copyRollRequest,
  copyRollDeclaration,
  copyRollSources,
  copyRollInput,
  copyRollLot,
  copyRollHandoffRead,
  copyRollOfferRequest,
  copyRollHandoff,
  copyRollReceiptRequest,
  copyRollReceipt,
  type RollOutputRequest,
  type RollInput,
  type RollLot,
  type RollHandoffRead,
  type RollOfferRequest,
  type RollReceiptRequest,
  type RollSources,
} from "./coatedRollTypes";
export * from "./coatedRollTypes";
interface OutputBase {
  inputs: RollInput[];
  tape: InventoryIssue[];
}
interface OfferBase {
  lot: RollLot;
  recipient: { id: string; name: string };
  destinationStepNumber: number;
  recipientWorkshopId: string;
}
interface ReceiptBase {
  handoff: RollHandoffRead;
}
export type RollCommand =
  | { kind: "output"; request: RollOutputRequest; base: OutputBase }
  | { kind: "offer"; request: RollOfferRequest; base: OfferBase }
  | { kind: "receipt"; request: RollReceiptRequest; base: ReceiptBase };
const invalid = (): never => {
  throw Error("Исходный выпуск, передача или приёмка изменены");
};
function copyCommand(command: RollCommand): RollCommand {
  if (command.kind === "output") {
    const request = copyRollRequest(command.request),
      inputs = command.base.inputs.map(copyRollInput),
      tape = command.base.tape.map(copyInventoryIssue);
    if (
      inputs.length !==
        request.slurryConsumptionIds.length +
          request.foilConsumptionIds.length ||
      new Set(inputs.map((i) => i.operationId)).size !== inputs.length
    )
      invalid();
    for (const [kind, ids] of [
      ["slurry", request.slurryConsumptionIds],
      ["foil", request.foilConsumptionIds],
    ] as const)
      for (const id of ids) {
        const s = inputs.find((i) => i.kind === kind && i.operationId === id);
        if (
          !s ||
          !s.eligible ||
          s.claimedBy ||
          s.productionBatchId !== request.productionBatchId ||
          s.stepNumber !== request.stepNumber
        )
          throw Error(
            "Измерение расхода недоступно, уже отнесено к выпуску или принадлежит другой операции",
          );
      }
    if (
      !same(
        tape.map((i) => i.id),
        request.tape.status === "unmeasured" ? request.tape.issueIds : [],
      )
    )
      invalid();
    for (const i of tape)
      if (
        i.state !== "received" ||
        i.tapeSpecification?.application !== "coating_support" ||
        i.productionBatchId !== request.productionBatchId ||
        i.stepNumber !== request.stepNumber
      )
        invalid();
    return { kind: "output", request, base: { inputs, tape } };
  }
  if (command.kind === "offer") {
    const request = copyRollOfferRequest(command.request),
      lot = copyRollLot(command.base.lot),
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
    const request = copyRollReceiptRequest(command.request),
      handoff = copyRollHandoffRead(command.base.handoff);
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
  command: Extract<RollCommand, { kind: "output" }>,
): RollSources {
  return copyRollSources(command.request, {
    slurry: command.request.slurryConsumptionIds.map(
      (id) =>
        command.base.inputs.find(
          (i) => i.kind === "slurry" && i.operationId === id,
        )!.consumption,
    ),
    foil: command.request.foilConsumptionIds.map(
      (id) =>
        command.base.inputs.find(
          (i) => i.kind === "foil" && i.operationId === id,
        )!.consumption,
    ),
    tape: command.base.tape,
  });
}
export function rollProposals(scope: InventoryScope, actor: string) {
  return inventoryOutbox.receivingDrafts
    .filter((r) => {
      try {
        const key = JSON.parse(r.key);
        return (
          key[0] === inventoryScopeKey(scope) &&
          key[1] === actor &&
          key[2] === "coated-roll"
        );
      } catch {
        return false;
      }
    })
    .toArray();
}
function overlaps(a: RollCommand, b: RollCommand) {
  if (a.request.operationId === b.request.operationId) return true;
  if (a.kind === "output" && b.kind === "output")
    return [
      ...a.request.slurryConsumptionIds,
      ...a.request.foilConsumptionIds,
    ].some((id) =>
      [
        ...b.request.slurryConsumptionIds,
        ...b.request.foilConsumptionIds,
      ].includes(id),
    );
  return a.kind === "offer" && b.kind === "offer"
    ? a.request.outputLotId === b.request.outputLotId
    : a.kind === "receipt" &&
        b.kind === "receipt" &&
        a.request.handoffId === b.request.handoffId;
}
export async function freezeRollCommand(
  scope: InventoryScope,
  actor: string,
  epoch: string,
  input: RollCommand,
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
          "coated-roll",
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
            if (JSON.parse(row.key)[2] !== "coated-roll") return false;
            const prior = {
              kind: row.fields.kind,
              request: JSON.parse(row.fields.request),
              base: JSON.parse(row.fields.base),
            } as RollCommand;
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
export function sendRollCommand(
  session: HybridSession,
  scope: InventoryScope,
  actor: string,
  key: string,
) {
  return withInventorySync(scope, async () => {
    const row = (await rollProposals(scope, actor)).find((r) => r.key === key);
    if (!row || row.fields.state !== "pending")
      throw Error("Нет исходного ожидающего действия с рулоном");
    const rawRequest = JSON.parse(row.fields.request),
      rawBase = JSON.parse(row.fields.base),
      command = copyCommand({
        kind: row.fields.kind,
        request: rawRequest,
        base: rawBase,
      } as RollCommand),
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
        "/inventory/coating-rolls" + suffix,
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
      const c = copyRollDeclaration(raw?.declaration);
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
      const h = copyRollHandoff(raw?.handoff);
      result = h;
      expected = {
        ...command.request,
        productionBatchId:
          command.base.lot.snapshot.declaration.productionBatchId,
        sourceRoom: "coating",
        destinationRoom: "calendaring",
        recipientWorkshopId: command.base.recipientWorkshopId,
        sourceSnapshot: command.base.lot.snapshot,
        actorId: scope.actorId,
        recordedAt: h.recordedAt,
        unit: "rolls",
        warehouseEffect: "none",
      };
    } else {
      field = "receipt";
      const r = copyRollReceipt(raw?.receipt);
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
export async function loadRollInputs(
  session: HybridSession,
  scope: InventoryScope,
  kind: "slurry" | "foil",
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/coating-rolls/inputs",
      copyRollInput,
      (r) => r.operationId,
      after,
      { kind },
    )
  ).page;
}
export async function loadCoatedRolls(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/coating-rolls",
      copyRollLot,
      (r) => r.id,
      after,
    )
  ).page;
}
export async function loadRollHistory(
  session: HybridSession,
  scope: InventoryScope,
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/coating-rolls/history",
      copyRollDeclaration,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadRollHandoffs(
  session: HybridSession,
  scope: InventoryScope,
  room: "coating" | "calendaring",
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      "/inventory/coating-rolls/handoffs",
      copyRollHandoffRead,
      (r) => r.operationId,
      after,
      { room },
    )
  ).page;
}
export async function loadRollEvents(
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
      "/inventory/coating-rolls/handoffs/" + handoffId + "/events",
      copyRollReceipt,
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
export async function loadRollMaterials(
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
      "/inventory/coating-rolls/materials",
      copyOption,
      (r) => r.id,
      after,
      { productionBatchId: batch, stepNumber: String(step) },
    )
  ).page;
}
export async function loadRollRecipients(
  session: HybridSession,
  scope: InventoryScope,
  lot: string,
  after?: string,
) {
  if (!id(lot)) return invalid();
  const { page, raw } = await readPage(
    session,
    scope,
    "/inventory/coating-rolls/recipients",
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
