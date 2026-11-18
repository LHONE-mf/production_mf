import {
  issueIdValid as id,
  issueTextValid as text,
} from "./inventoryIssueTypes";
import {
  outcomeInteger as integer,
  outcomeInstant as instant,
} from "./inventoryOutcomeTypes";
import { sameOutput as same } from "./inventoryOutputTypes";
import {
  copyCalendaringConsumption,
  type CalendaringConsumption,
} from "./calendaringConsumption";
import {
  copyPhysicalRoll,
  copyRollOfferRequest,
  copyRollReceiptRequest,
  type PhysicalRoll,
} from "./coatedRollTypes";
export interface CalenderedOutputRequest {
  operationId: string;
  deviceId: string;
  productionBatchId: string;
  stepNumber: number;
  consumptionIds: string[];
  outputs: PhysicalRoll[];
  scrapLengthMm: number | null;
  scrapMassMg: number | null;
  accountingNote: string;
  observedAt: number;
  specificationReference: string;
  reference: string;
  reason: string;
  evidence: string;
}
export type CalenderedSources = CalendaringConsumption[];
export interface CalenderedDeclaration extends CalenderedOutputRequest {
  sources: CalenderedSources;
  actorId: string;
  recordedAt: string;
  qualityStatus: "unreviewed";
  materialAccountingStatus: "unreconciled";
  genealogyScope: "declaration";
  warehouseEffect: "none";
}
export interface CalenderedSnapshot {
  id: string;
  declarationId: string;
  materialId: string;
  quantity: 1;
  unit: "rolls";
  roll: PhysicalRoll;
  declaration: CalenderedDeclaration;
}
export interface CalenderedLot {
  id: string;
  snapshot: CalenderedSnapshot;
  materialCode: string;
  materialName: string;
  batchCode: string;
  reserved: number;
  received: number;
  remaining: number;
  revision: number;
  eligible: boolean;
}
export interface CalenderedOfferRequest {
  operationId: string;
  deviceId: string;
  outputLotId: string;
  quantity: 1;
  expectedSourceRevision: number;
  recipientId: string;
  destinationStepNumber: number;
  reason: string;
  evidence: string;
}
export interface CalenderedHandoff extends CalenderedOfferRequest {
  productionBatchId: string;
  sourceRoom: "calendaring";
  destinationRoom: "cutting";
  recipientWorkshopId: string;
  sourceSnapshot: CalenderedSnapshot;
  actorId: string;
  recordedAt: string;
  unit: "rolls";
  warehouseEffect: "none";
}
export interface CalenderedReceiptRequest {
  operationId: string;
  deviceId: string;
  handoffId: string;
  kind: "receive" | "discrepancy";
  observedQuantity: number | null;
  observedRollLabel: string | null;
  observedLengthMm: number | null;
  measurementNote: string;
  reason: string;
  evidence: string;
}
export interface CalenderedReceipt extends CalenderedReceiptRequest {
  sourceSnapshot: CalenderedHandoff;
  actorId: string;
  recordedAt: string;
  custodyEffect: "received" | "none";
  unit: "rolls";
  warehouseEffect: "none";
}
export interface CalenderedHandoffRead {
  operationId: string;
  handoff: CalenderedHandoff;
  eligible: boolean;
  received: CalenderedReceipt | null;
  eventCount: number;
}
export interface CalenderedInput {
  operationId: string;
  productionBatchId: string;
  stepNumber: number;
  consumption: CalendaringConsumption;
  materialId: string;
  materialCode?: string;
  materialName?: string;
  batchCode: string;
  claimedBy: string | null;
  eligible: boolean;
}
const invalid = (): never => {
  throw Error("Некорректные данные выпуска или передачи рулона");
};
const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : invalid();
const unique = (values: unknown[]) => new Set(values).size === values.length;
function ids(x: unknown): string[] {
  if (
    !Array.isArray(x) ||
    !x.length ||
    x.length > 100 ||
    !x.every(id) ||
    !unique(x)
  )
    return invalid();
  return [...x];
}
const optionalQuantity = (x: unknown, min = 0) => x === null || integer(x, min);
const commonKeys = ["operationId", "deviceId", "reason", "evidence"];
function common(r: Record<string, unknown>) {
  if (
    ![r.operationId, r.deviceId].every(id) ||
    ![r.reason, r.evidence].every(text)
  )
    invalid();
  return {
    operationId: r.operationId as string,
    deviceId: r.deviceId as string,
    reason: r.reason as string,
    evidence: r.evidence as string,
  };
}
function strict(r: Record<string, unknown>, keys: string[]) {
  if (Object.keys(r).some((k) => !keys.includes(k))) invalid();
}
function pick(r: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, r[k]]));
}
const outputKeys = [
  ...commonKeys,
  "productionBatchId",
  "stepNumber",
  "consumptionIds",
  "outputs",
  "scrapLengthMm",
  "scrapMassMg",
  "accountingNote",
  "observedAt",
  "specificationReference",
  "reference",
];
export function copyCalenderedRequest(value: unknown): CalenderedOutputRequest {
  const r = object(value);
  strict(r, outputKeys);
  const c = common(r),
    consumptionIds = ids(r.consumptionIds);
  if (
    !id(r.productionBatchId) ||
    !integer(r.stepNumber, 1, 2147483647) ||
    ![r.accountingNote, r.specificationReference, r.reference].every(text) ||
    !optionalQuantity(r.scrapLengthMm) ||
    !optionalQuantity(r.scrapMassMg) ||
    typeof r.observedAt !== "number" ||
    !Number.isFinite(r.observedAt) ||
    r.observedAt <= 0 ||
    !Array.isArray(r.outputs) ||
    !r.outputs.length ||
    r.outputs.length > 100
  )
    invalid();
  const outputs = (r.outputs as unknown[]).map(copyPhysicalRoll);
  if (!unique(outputs.map((o) => o.id))) invalid();
  return {
    ...c,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    consumptionIds,
    outputs,
    scrapLengthMm: r.scrapLengthMm as number | null,
    scrapMassMg: r.scrapMassMg as number | null,
    accountingNote: r.accountingNote as string,
    observedAt: r.observedAt as number,
    specificationReference: r.specificationReference as string,
    reference: r.reference as string,
  };
}
export function copyCalenderedSources(
  request: CalenderedOutputRequest,
  value: unknown,
): CalenderedSources {
  if (!Array.isArray(value) || value.length !== request.consumptionIds.length)
    return invalid();
  const sources = value.map(copyCalendaringConsumption);
  if (
    !same(
      sources.map((c) => c.operationId),
      request.consumptionIds,
    ) ||
    sources.some(
      (c) =>
        c.productionBatchId !== request.productionBatchId ||
        c.stepNumber !== request.stepNumber,
    ) ||
    new Set(sources.map((c) => c.materialId)).size !== 1
  )
    return invalid();
  return sources;
}
export function copyCalenderedDeclaration(
  value: unknown,
): CalenderedDeclaration {
  const r = object(value),
    request = copyCalenderedRequest(pick(r, outputKeys)),
    sources = copyCalenderedSources(request, r.sources);
  if (
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    r.qualityStatus !== "unreviewed" ||
    r.materialAccountingStatus !== "unreconciled" ||
    r.genealogyScope !== "declaration" ||
    r.warehouseEffect !== "none"
  )
    invalid();
  return {
    ...request,
    sources,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    qualityStatus: "unreviewed",
    materialAccountingStatus: "unreconciled",
    genealogyScope: "declaration",
    warehouseEffect: "none",
  };
}
export function copyCalenderedSnapshot(value: unknown): CalenderedSnapshot {
  const r = object(value),
    declaration = copyCalenderedDeclaration(r.declaration),
    roll = copyPhysicalRoll(r.roll);
  if (
    ![r.id, r.declarationId, r.materialId].every(id) ||
    r.quantity !== 1 ||
    r.unit !== "rolls" ||
    r.declarationId !== declaration.operationId ||
    r.id !== roll.id ||
    r.materialId !== roll.materialId ||
    !same(
      roll,
      declaration.outputs.find((o) => o.id === r.id),
    )
  )
    invalid();
  return {
    id: r.id as string,
    declarationId: r.declarationId as string,
    materialId: r.materialId as string,
    quantity: 1,
    unit: "rolls",
    roll,
    declaration,
  };
}
export function copyCalenderedLot(value: unknown): CalenderedLot {
  const r = object(value),
    snapshot = copyCalenderedSnapshot(r.snapshot);
  if (
    r.id !== snapshot.id ||
    ![r.materialCode, r.materialName, r.batchCode].every(text) ||
    ![r.reserved, r.received, r.remaining].every((n) => integer(n, 0, 1)) ||
    (r.reserved as number) < (r.received as number) ||
    (r.reserved as number) + (r.remaining as number) !== 1 ||
    r.revision !== (r.reserved as number) + 1 ||
    typeof r.eligible !== "boolean"
  )
    invalid();
  return {
    id: snapshot.id,
    snapshot,
    materialCode: r.materialCode as string,
    materialName: r.materialName as string,
    batchCode: r.batchCode as string,
    reserved: r.reserved as number,
    received: r.received as number,
    remaining: r.remaining as number,
    revision: r.revision as number,
    eligible: r.eligible as boolean,
  };
}
const offerKeys = [
  ...commonKeys,
  "outputLotId",
  "quantity",
  "expectedSourceRevision",
  "recipientId",
  "destinationStepNumber",
];
export const copyCalenderedOfferRequest = copyRollOfferRequest;
export function copyCalenderedHandoff(value: unknown): CalenderedHandoff {
  const r = object(value),
    request = copyCalenderedOfferRequest(pick(r, offerKeys)),
    sourceSnapshot = copyCalenderedSnapshot(r.sourceSnapshot);
  if (
    r.outputLotId !== sourceSnapshot.id ||
    r.productionBatchId !== sourceSnapshot.declaration.productionBatchId ||
    (r.destinationStepNumber as number) <=
      sourceSnapshot.declaration.stepNumber ||
    r.sourceRoom !== "calendaring" ||
    r.destinationRoom !== "cutting" ||
    !text(r.recipientWorkshopId) ||
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    r.unit !== "rolls" ||
    r.warehouseEffect !== "none"
  )
    invalid();
  return {
    ...request,
    productionBatchId: r.productionBatchId as string,
    sourceRoom: "calendaring",
    destinationRoom: "cutting",
    recipientWorkshopId: r.recipientWorkshopId as string,
    sourceSnapshot,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    unit: "rolls",
    warehouseEffect: "none",
  };
}
const receiptKeys = [
  ...commonKeys,
  "handoffId",
  "kind",
  "observedQuantity",
  "observedRollLabel",
  "observedLengthMm",
  "measurementNote",
];
export const copyCalenderedReceiptRequest = copyRollReceiptRequest;
export function copyCalenderedReceipt(value: unknown): CalenderedReceipt {
  const r = object(value),
    request = copyCalenderedReceiptRequest(pick(r, receiptKeys)),
    sourceSnapshot = copyCalenderedHandoff(r.sourceSnapshot);
  if (
    request.handoffId !== sourceSnapshot.operationId ||
    r.actorId !== sourceSnapshot.recipientId ||
    !instant(r.recordedAt) ||
    r.custodyEffect !== (request.kind === "receive" ? "received" : "none") ||
    r.unit !== "rolls" ||
    r.warehouseEffect !== "none" ||
    (request.kind === "receive" &&
      (request.observedRollLabel !== sourceSnapshot.sourceSnapshot.roll.label ||
        (request.observedLengthMm !== null &&
          request.observedLengthMm !==
            sourceSnapshot.sourceSnapshot.roll.measuredLengthMm)))
  )
    invalid();
  return {
    ...request,
    sourceSnapshot,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    custodyEffect: request.kind === "receive" ? "received" : "none",
    unit: "rolls",
    warehouseEffect: "none",
  };
}
export function copyCalenderedHandoffRead(
  value: unknown,
): CalenderedHandoffRead {
  const r = object(value),
    handoff = copyCalenderedHandoff(r.handoff),
    received = r.received === null ? null : copyCalenderedReceipt(r.received);
  if (
    r.operationId !== handoff.operationId ||
    typeof r.eligible !== "boolean" ||
    !integer(r.eventCount) ||
    (received &&
      (received.kind !== "receive" ||
        received.handoffId !== handoff.operationId ||
        !same(received.sourceSnapshot, handoff) ||
        !integer(r.eventCount, 1)))
  )
    invalid();
  return {
    operationId: handoff.operationId,
    handoff,
    eligible: r.eligible as boolean,
    received,
    eventCount: r.eventCount as number,
  };
}
export function copyCalenderedInput(value: unknown): CalenderedInput {
  const r = object(value),
    consumption = copyCalendaringConsumption(r.consumption);
  if (
    r.operationId !== consumption.operationId ||
    r.productionBatchId !== consumption.productionBatchId ||
    r.stepNumber !== consumption.stepNumber ||
    r.materialId !== consumption.materialId ||
    !text(r.batchCode) ||
    (r.materialCode !== undefined && !text(r.materialCode)) ||
    (r.materialName !== undefined && !text(r.materialName)) ||
    !(r.claimedBy === null || id(r.claimedBy)) ||
    typeof r.eligible !== "boolean"
  )
    return invalid();
  return {
    operationId: consumption.operationId,
    productionBatchId: consumption.productionBatchId,
    stepNumber: consumption.stepNumber,
    materialId: consumption.materialId,
    ...(r.materialCode !== undefined
      ? { materialCode: r.materialCode as string }
      : {}),
    ...(r.materialName !== undefined
      ? { materialName: r.materialName as string }
      : {}),
    consumption,
    batchCode: r.batchCode as string,
    claimedBy: r.claimedBy as string | null,
    eligible: r.eligible as boolean,
  };
}
