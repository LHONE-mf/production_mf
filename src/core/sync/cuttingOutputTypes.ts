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
  copyCuttingConsumption,
  type CuttingConsumption,
} from "./cuttingConsumption";
export interface PieceOutputLot {
  id: string;
  materialId: string;
  label: string;
  quantity: number;
  disposition: "ready" | "held";
}
export interface CutOutputRequest {
  operationId: string;
  deviceId: string;
  productionBatchId: string;
  stepNumber: number;
  consumptionIds: string[];
  unit: "pieces";
  rejectedPieces: number | null;
  outputs: PieceOutputLot[];
  scrapLengthMm: number | null;
  scrapMassMg: number | null;
  accountingNote: string;
  observedAt: number;
  specificationReference: string;
  reference: string;
  reason: string;
  evidence: string;
}
export type CutOutputSources = CuttingConsumption[];
export interface CutOutputDeclaration extends CutOutputRequest {
  sources: CutOutputSources;
  actorId: string;
  recordedAt: string;
  qualityStatus: "unreviewed";
  materialAccountingStatus: "unreconciled";
  genealogyScope: "declaration";
  warehouseEffect: "none";
}
export interface CutOutputSnapshot {
  id: string;
  declarationId: string;
  materialId: string;
  quantity: number;
  unit: "pieces";
  lot: PieceOutputLot;
  declaration: CutOutputDeclaration;
}
export interface CutOutputLot {
  id: string;
  snapshot: CutOutputSnapshot;
  materialCode: string;
  materialName: string;
  batchCode: string;
  reserved: number;
  received: number;
  remaining: number;
  revision: number;
  eligible: boolean;
}
export interface CutOutputOfferRequest {
  operationId: string;
  deviceId: string;
  outputLotId: string;
  quantity: number;
  unit: "pieces";
  expectedSourceRevision: number;
  recipientId: string;
  destinationStepNumber: number;
  reason: string;
  evidence: string;
}
export interface CutOutputHandoff extends CutOutputOfferRequest {
  productionBatchId: string;
  sourceRoom: "cutting";
  destinationRoom: "sorting";
  recipientWorkshopId: string;
  sourceSnapshot: CutOutputSnapshot;
  actorId: string;
  recordedAt: string;
  unit: "pieces";
  warehouseEffect: "none";
}
export interface CutOutputReceiptRequest {
  operationId: string;
  deviceId: string;
  handoffId: string;
  unit: "pieces";
  kind: "receive" | "discrepancy";
  observedQuantity: number | null;
  observedLotLabel: string | null;
  measurementNote: string;
  reason: string;
  evidence: string;
}
export interface CutOutputReceipt extends CutOutputReceiptRequest {
  sourceSnapshot: CutOutputHandoff;
  actorId: string;
  recordedAt: string;
  custodyEffect: "received" | "none";
  unit: "pieces";
  warehouseEffect: "none";
}
export interface CutOutputHandoffRead {
  operationId: string;
  handoff: CutOutputHandoff;
  eligible: boolean;
  received: CutOutputReceipt | null;
  eventCount: number;
}
export interface CutOutputInput {
  operationId: string;
  productionBatchId: string;
  stepNumber: number;
  consumption: CuttingConsumption;
  materialId: string;
  materialCode?: string;
  materialName?: string;
  batchCode: string;
  claimedBy: string | null;
  eligible: boolean;
}
const invalid = (): never => {
  throw Error("Некорректные данные выпуска или передачи лота");
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
function copyPieceLot(value: unknown): PieceOutputLot {
  const r = object(value);
  strict(r, ["id", "materialId", "label", "quantity", "disposition"]);
  if (
    ![r.id, r.materialId].every(id) ||
    !text(r.label) ||
    (r.label as string).length > 200 ||
    !integer(r.quantity, 1) ||
    !["ready", "held"].includes(String(r.disposition))
  )
    return invalid();
  return {
    id: r.id as string,
    materialId: r.materialId as string,
    label: r.label as string,
    quantity: r.quantity as number,
    disposition: r.disposition as "ready" | "held",
  };
}
const outputKeys = [
  ...commonKeys,
  "productionBatchId",
  "stepNumber",
  "consumptionIds",
  "unit",
  "rejectedPieces",
  "outputs",
  "scrapLengthMm",
  "scrapMassMg",
  "accountingNote",
  "observedAt",
  "specificationReference",
  "reference",
];
export function copyCutOutputRequest(value: unknown): CutOutputRequest {
  const r = object(value);
  strict(r, outputKeys);
  const c = common(r),
    consumptionIds = ids(r.consumptionIds);
  if (
    r.unit !== "pieces" ||
    !optionalQuantity(r.rejectedPieces) ||
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
  const outputs = (r.outputs as unknown[]).map(copyPieceLot);
  if (!unique(outputs.map((o) => o.id))) invalid();
  return {
    ...c,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    consumptionIds,
    unit: "pieces",
    rejectedPieces: r.rejectedPieces as number | null,
    outputs,
    scrapLengthMm: r.scrapLengthMm as number | null,
    scrapMassMg: r.scrapMassMg as number | null,
    accountingNote: r.accountingNote as string,
    observedAt: r.observedAt as number,
    specificationReference: r.specificationReference as string,
    reference: r.reference as string,
  };
}
export function copyCutOutputSources(
  request: CutOutputRequest,
  value: unknown,
): CutOutputSources {
  if (!Array.isArray(value) || value.length !== request.consumptionIds.length)
    return invalid();
  const sources = value.map(copyCuttingConsumption);
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
export function copyCutOutputDeclaration(value: unknown): CutOutputDeclaration {
  const r = object(value),
    request = copyCutOutputRequest(pick(r, outputKeys)),
    sources = copyCutOutputSources(request, r.sources);
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
export function copyCutOutputSnapshot(value: unknown): CutOutputSnapshot {
  const r = object(value),
    declaration = copyCutOutputDeclaration(r.declaration),
    lot = copyPieceLot(r.lot);
  if (
    ![r.id, r.declarationId, r.materialId].every(id) ||
    r.quantity !== lot.quantity ||
    r.unit !== "pieces" ||
    r.declarationId !== declaration.operationId ||
    r.id !== lot.id ||
    r.materialId !== lot.materialId ||
    !same(
      lot,
      declaration.outputs.find((o) => o.id === r.id),
    )
  )
    invalid();
  return {
    id: r.id as string,
    declarationId: r.declarationId as string,
    materialId: r.materialId as string,
    quantity: lot.quantity,
    unit: "pieces",
    lot,
    declaration,
  };
}
export function copyCutOutputLot(value: unknown): CutOutputLot {
  const r = object(value),
    snapshot = copyCutOutputSnapshot(r.snapshot);
  if (
    r.id !== snapshot.id ||
    ![r.materialCode, r.materialName, r.batchCode].every(text) ||
    ![r.reserved, r.received, r.remaining].every((n) =>
      integer(n, 0, snapshot.quantity),
    ) ||
    (r.reserved as number) < (r.received as number) ||
    BigInt(r.reserved as number) + BigInt(r.remaining as number) !==
      BigInt(snapshot.quantity) ||
    !integer(r.revision, 1) ||
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
  "unit",
  "expectedSourceRevision",
  "recipientId",
  "destinationStepNumber",
];
export function copyCutOutputOfferRequest(
  value: unknown,
): CutOutputOfferRequest {
  const r = object(value);
  strict(r, offerKeys);
  const c = common(r);
  if (
    r.unit !== "pieces" ||
    ![r.outputLotId, r.recipientId].every(id) ||
    !integer(r.quantity, 1) ||
    !integer(r.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
    !integer(r.destinationStepNumber, 1, 2147483647)
  )
    return invalid();
  return {
    ...c,
    outputLotId: r.outputLotId as string,
    recipientId: r.recipientId as string,
    quantity: r.quantity as number,
    unit: "pieces",
    expectedSourceRevision: r.expectedSourceRevision as number,
    destinationStepNumber: r.destinationStepNumber as number,
  };
}
export function copyCutOutputHandoff(value: unknown): CutOutputHandoff {
  const r = object(value),
    request = copyCutOutputOfferRequest(pick(r, offerKeys)),
    sourceSnapshot = copyCutOutputSnapshot(r.sourceSnapshot);
  if (
    request.quantity > sourceSnapshot.quantity ||
    r.outputLotId !== sourceSnapshot.id ||
    r.productionBatchId !== sourceSnapshot.declaration.productionBatchId ||
    (r.destinationStepNumber as number) <=
      sourceSnapshot.declaration.stepNumber ||
    r.sourceRoom !== "cutting" ||
    r.destinationRoom !== "sorting" ||
    !text(r.recipientWorkshopId) ||
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    r.unit !== "pieces" ||
    r.warehouseEffect !== "none"
  )
    invalid();
  return {
    ...request,
    productionBatchId: r.productionBatchId as string,
    sourceRoom: "cutting",
    destinationRoom: "sorting",
    recipientWorkshopId: r.recipientWorkshopId as string,
    sourceSnapshot,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    unit: "pieces",
    warehouseEffect: "none",
  };
}
const receiptKeys = [
  ...commonKeys,
  "handoffId",
  "kind",
  "observedQuantity",
  "observedLotLabel",
  "unit",
  "measurementNote",
];
export function copyCutOutputReceiptRequest(
  value: unknown,
): CutOutputReceiptRequest {
  const r = object(value);
  strict(r, receiptKeys);
  const c = common(r);
  if (
    !id(r.handoffId) ||
    r.unit !== "pieces" ||
    !["receive", "discrepancy"].includes(String(r.kind)) ||
    !optionalQuantity(r.observedQuantity) ||
    !(
      r.observedLotLabel === null ||
      (text(r.observedLotLabel) && (r.observedLotLabel as string).length <= 200)
    ) ||
    !text(r.measurementNote) ||
    (r.kind === "receive" &&
      (!integer(r.observedQuantity, 1) || !text(r.observedLotLabel)))
  )
    return invalid();
  return {
    ...c,
    handoffId: r.handoffId as string,
    kind: r.kind as "receive" | "discrepancy",
    unit: "pieces",
    observedQuantity: r.observedQuantity as number | null,
    observedLotLabel: r.observedLotLabel as string | null,
    measurementNote: r.measurementNote as string,
  };
}
export function copyCutOutputReceipt(value: unknown): CutOutputReceipt {
  const r = object(value),
    request = copyCutOutputReceiptRequest(pick(r, receiptKeys)),
    sourceSnapshot = copyCutOutputHandoff(r.sourceSnapshot);
  if (
    request.handoffId !== sourceSnapshot.operationId ||
    r.actorId !== sourceSnapshot.recipientId ||
    !instant(r.recordedAt) ||
    r.custodyEffect !== (request.kind === "receive" ? "received" : "none") ||
    r.unit !== "pieces" ||
    r.warehouseEffect !== "none" ||
    (request.kind === "receive" &&
      (request.observedQuantity !== sourceSnapshot.quantity ||
        request.observedLotLabel !== sourceSnapshot.sourceSnapshot.lot.label))
  )
    invalid();
  return {
    ...request,
    sourceSnapshot,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    custodyEffect: request.kind === "receive" ? "received" : "none",
    unit: "pieces",
    warehouseEffect: "none",
  };
}
export function copyCutOutputHandoffRead(value: unknown): CutOutputHandoffRead {
  const r = object(value),
    handoff = copyCutOutputHandoff(r.handoff),
    received = r.received === null ? null : copyCutOutputReceipt(r.received);
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
export function copyCutOutputInput(value: unknown): CutOutputInput {
  const r = object(value),
    consumption = copyCuttingConsumption(r.consumption);
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
