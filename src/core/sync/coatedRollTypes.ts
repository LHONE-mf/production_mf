import {
  issueIdValid as id,
  issueTextValid as text,
  copyInventoryIssue,
  type InventoryIssue,
} from "./inventoryIssueTypes";
import {
  outcomeInteger as integer,
  outcomeInstant as instant,
} from "./inventoryOutcomeTypes";
import { sameOutput as same } from "./inventoryOutputTypes";
import {
  copyCoatingConsumption,
  type CoatingConsumption,
} from "./coatingConsumption";
import { copyFoilConsumption, type FoilConsumption } from "./coatingFoil";
export interface PhysicalRoll {
  id: string;
  materialId: string;
  label: string;
  measuredLengthMm: number;
  measuredMassMg: number | null;
  disposition: "ready" | "held";
}
export type RollTape =
  | { status: "not_applicable"; note: string }
  | { status: "unmeasured"; note: string; issueIds: string[] };
export interface RollOutputRequest {
  operationId: string;
  deviceId: string;
  productionBatchId: string;
  stepNumber: number;
  slurryConsumptionIds: string[];
  foilConsumptionIds: string[];
  outputs: PhysicalRoll[];
  tape: RollTape;
  scrapLengthMm: number | null;
  scrapMassMg: number | null;
  accountingNote: string;
  observedAt: number;
  specificationReference: string;
  reference: string;
  reason: string;
  evidence: string;
}
export interface RollSources {
  slurry: CoatingConsumption[];
  foil: FoilConsumption[];
  tape: InventoryIssue[];
}
export interface RollDeclaration extends RollOutputRequest {
  sources: RollSources;
  actorId: string;
  recordedAt: string;
  qualityStatus: "unreviewed";
  materialAccountingStatus: "unreconciled";
  genealogyScope: "declaration";
  warehouseEffect: "none";
}
export interface RollSnapshot {
  id: string;
  declarationId: string;
  materialId: string;
  quantity: 1;
  unit: "rolls";
  roll: PhysicalRoll;
  declaration: RollDeclaration;
}
export interface RollLot {
  id: string;
  snapshot: RollSnapshot;
  materialCode: string;
  materialName: string;
  batchCode: string;
  reserved: number;
  received: number;
  remaining: number;
  revision: number;
  eligible: boolean;
}
export interface RollOfferRequest {
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
export interface RollHandoff extends RollOfferRequest {
  productionBatchId: string;
  sourceRoom: "coating";
  destinationRoom: "calendaring";
  recipientWorkshopId: string;
  sourceSnapshot: RollSnapshot;
  actorId: string;
  recordedAt: string;
  unit: "rolls";
  warehouseEffect: "none";
}
export interface RollReceiptRequest {
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
export interface RollReceipt extends RollReceiptRequest {
  sourceSnapshot: RollHandoff;
  actorId: string;
  recordedAt: string;
  custodyEffect: "received" | "none";
  unit: "rolls";
  warehouseEffect: "none";
}
export interface RollHandoffRead {
  operationId: string;
  handoff: RollHandoff;
  eligible: boolean;
  received: RollReceipt | null;
  eventCount: number;
}
export interface RollInput {
  operationId: string;
  productionBatchId: string;
  stepNumber: number;
  consumption: CoatingConsumption | FoilConsumption;
  batchCode: string;
  claimedBy: string | null;
  eligible: boolean;
  kind: "slurry" | "foil";
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
function copyRoll(value: unknown): PhysicalRoll {
  const r = object(value);
  strict(r, [
    "id",
    "materialId",
    "label",
    "measuredLengthMm",
    "measuredMassMg",
    "disposition",
  ]);
  if (
    ![r.id, r.materialId].every(id) ||
    !text(r.label) ||
    (r.label as string).length > 200 ||
    !integer(r.measuredLengthMm, 1) ||
    !optionalQuantity(r.measuredMassMg, 1) ||
    !["ready", "held"].includes(String(r.disposition))
  )
    invalid();
  return {
    id: r.id as string,
    materialId: r.materialId as string,
    label: r.label as string,
    measuredLengthMm: r.measuredLengthMm as number,
    measuredMassMg: r.measuredMassMg as number | null,
    disposition: r.disposition as PhysicalRoll["disposition"],
  };
}
const outputKeys = [
  ...commonKeys,
  "productionBatchId",
  "stepNumber",
  "slurryConsumptionIds",
  "foilConsumptionIds",
  "outputs",
  "tape",
  "scrapLengthMm",
  "scrapMassMg",
  "accountingNote",
  "observedAt",
  "specificationReference",
  "reference",
];
export function copyRollRequest(value: unknown): RollOutputRequest {
  const r = object(value);
  strict(r, outputKeys);
  const c = common(r),
    slurryConsumptionIds = ids(r.slurryConsumptionIds),
    foilConsumptionIds = ids(r.foilConsumptionIds),
    t = object(r.tape);
  if (
    !id(r.productionBatchId) ||
    !integer(r.stepNumber, 1, 2147483647) ||
    ![r.accountingNote, r.specificationReference, r.reference, t.note].every(
      text,
    ) ||
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
  let tape: RollTape;
  if (t.status === "not_applicable") {
    strict(t, ["status", "note"]);
    tape = { status: "not_applicable", note: t.note as string };
  } else if (t.status === "unmeasured") {
    strict(t, ["status", "note", "issueIds"]);
    tape = {
      status: "unmeasured",
      note: t.note as string,
      issueIds: ids(t.issueIds),
    };
  } else return invalid();
  const outputs = (r.outputs as unknown[]).map(copyRoll);
  if (!unique(outputs.map((o) => o.id))) invalid();
  return {
    ...c,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    slurryConsumptionIds,
    foilConsumptionIds,
    outputs,
    tape,
    scrapLengthMm: r.scrapLengthMm as number | null,
    scrapMassMg: r.scrapMassMg as number | null,
    accountingNote: r.accountingNote as string,
    observedAt: r.observedAt as number,
    specificationReference: r.specificationReference as string,
    reference: r.reference as string,
  };
}
export function copyRollSources(
  request: RollOutputRequest,
  value: unknown,
): RollSources {
  const s = object(value);
  if (
    !Array.isArray(s.slurry) ||
    !Array.isArray(s.foil) ||
    !Array.isArray(s.tape)
  )
    invalid();
  const sources: RollSources = {
    slurry: (s.slurry as unknown[]).map(copyCoatingConsumption),
    foil: (s.foil as unknown[]).map(copyFoilConsumption),
    tape: (s.tape as unknown[]).map(copyInventoryIssue),
  };
  if (
    !same(
      sources.slurry.map((c) => c.operationId),
      request.slurryConsumptionIds,
    ) ||
    !same(
      sources.foil.map((c) => c.operationId),
      request.foilConsumptionIds,
    ) ||
    [...sources.slurry, ...sources.foil].some(
      (c) =>
        c.productionBatchId !== request.productionBatchId ||
        c.stepNumber !== request.stepNumber,
    ) ||
    !same(
      sources.tape.map((i) => i.id),
      request.tape.status === "unmeasured" ? request.tape.issueIds : [],
    )
  )
    invalid();
  for (const i of sources.tape)
    if (
      i.state !== "received" ||
      i.unit !== "rolls" ||
      i.tapeSpecification?.application !== "coating_support" ||
      i.productionBatchId !== request.productionBatchId ||
      i.stepNumber !== request.stepNumber
    )
      invalid();
  return sources;
}
export function copyRollDeclaration(value: unknown): RollDeclaration {
  const r = object(value),
    request = copyRollRequest(pick(r, outputKeys)),
    sources = copyRollSources(request, r.sources);
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
export function copyRollSnapshot(value: unknown): RollSnapshot {
  const r = object(value),
    declaration = copyRollDeclaration(r.declaration),
    roll = copyRoll(r.roll);
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
export function copyRollLot(value: unknown): RollLot {
  const r = object(value),
    snapshot = copyRollSnapshot(r.snapshot);
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
export function copyRollOfferRequest(value: unknown): RollOfferRequest {
  const r = object(value);
  strict(r, offerKeys);
  const c = common(r);
  if (
    ![r.outputLotId, r.recipientId].every(id) ||
    r.quantity !== 1 ||
    !integer(r.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
    !integer(r.destinationStepNumber, 1, 2147483647)
  )
    invalid();
  return {
    ...c,
    outputLotId: r.outputLotId as string,
    quantity: 1,
    expectedSourceRevision: r.expectedSourceRevision as number,
    recipientId: r.recipientId as string,
    destinationStepNumber: r.destinationStepNumber as number,
  };
}
export function copyRollHandoff(value: unknown): RollHandoff {
  const r = object(value),
    request = copyRollOfferRequest(pick(r, offerKeys)),
    sourceSnapshot = copyRollSnapshot(r.sourceSnapshot);
  if (
    r.outputLotId !== sourceSnapshot.id ||
    r.productionBatchId !== sourceSnapshot.declaration.productionBatchId ||
    (r.destinationStepNumber as number) <=
      sourceSnapshot.declaration.stepNumber ||
    r.sourceRoom !== "coating" ||
    r.destinationRoom !== "calendaring" ||
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
    sourceRoom: "coating",
    destinationRoom: "calendaring",
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
export function copyRollReceiptRequest(value: unknown): RollReceiptRequest {
  const r = object(value);
  strict(r, receiptKeys);
  const c = common(r);
  if (
    !id(r.handoffId) ||
    !["receive", "discrepancy"].includes(String(r.kind)) ||
    !optionalQuantity(r.observedQuantity) ||
    !optionalQuantity(r.observedLengthMm, 1) ||
    !(
      r.observedRollLabel === null ||
      (text(r.observedRollLabel) &&
        (r.observedRollLabel as string).length <= 200)
    ) ||
    !text(r.measurementNote) ||
    (r.kind === "receive" &&
      (r.observedQuantity !== 1 || r.observedRollLabel === null))
  )
    invalid();
  return {
    ...c,
    handoffId: r.handoffId as string,
    kind: r.kind as RollReceiptRequest["kind"],
    observedQuantity: r.observedQuantity as number | null,
    observedRollLabel: r.observedRollLabel as string | null,
    observedLengthMm: r.observedLengthMm as number | null,
    measurementNote: r.measurementNote as string,
  };
}
export function copyRollReceipt(value: unknown): RollReceipt {
  const r = object(value),
    request = copyRollReceiptRequest(pick(r, receiptKeys)),
    sourceSnapshot = copyRollHandoff(r.sourceSnapshot);
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
export function copyRollHandoffRead(value: unknown): RollHandoffRead {
  const r = object(value),
    handoff = copyRollHandoff(r.handoff),
    received = r.received === null ? null : copyRollReceipt(r.received);
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
export function copyRollInput(value: unknown): RollInput {
  const r = object(value);
  if (!["slurry", "foil"].includes(String(r.kind))) return invalid();
  const consumption =
    r.kind === "slurry"
      ? copyCoatingConsumption(r.consumption)
      : copyFoilConsumption(r.consumption);
  if (
    r.operationId !== consumption.operationId ||
    r.productionBatchId !== consumption.productionBatchId ||
    r.stepNumber !== consumption.stepNumber ||
    !text(r.batchCode) ||
    !(r.claimedBy === null || id(r.claimedBy)) ||
    typeof r.eligible !== "boolean"
  )
    invalid();
  return {
    operationId: consumption.operationId,
    productionBatchId: consumption.productionBatchId,
    stepNumber: consumption.stepNumber,
    consumption,
    batchCode: r.batchCode as string,
    claimedBy: r.claimedBy as string | null,
    eligible: r.eligible as boolean,
    kind: r.kind as "slurry" | "foil",
  };
}
