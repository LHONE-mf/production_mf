import type {SlurryConsumptionRequest} from './slurryConsumption';
import {issueIdValid as id, issueTextValid as text} from './inventoryIssueTypes';
import {outcomeInteger as integer, outcomeInstant as instant} from './inventoryOutcomeTypes';
import {sameOutput as same} from './inventoryOutputTypes';

interface Common {
  operationId: string;
  deviceId: string;
  reason: string;
  evidence: string;
}
export interface SlurryOutputRequest extends Common {
  consumptionId: string;
  outputs: {id: string; materialId: string; quantity: number}[];
  scrapMg: number;
  measuredLossMg: number;
  unknownMg: number;
  basis: 'weighed-slurry-mass';
  specificationReference: string;
  observedAt: number;
}
export interface RoomHandoffRequest extends Common {
  outputLotId: string;
  quantity: number;
  expectedSourceRevision: number;
  recipientId: string;
  destinationStepNumber: number;
}
export type RoomReceiptRequest = Common & {handoffId: string} & (
    | {kind: 'receive'; observedQuantity: number}
    | {kind: 'discrepancy'; observedQuantity: number | null}
  );
export type CustodyCommand = 'declaration' | 'handoff' | 'receipt';
export type CustodyRequest = SlurryOutputRequest | RoomHandoffRequest | RoomReceiptRequest;
export interface SlurrySourceSnapshot {
  consumption: SlurryConsumptionRequest & {
    room: 'slurry';
    actorId: string;
    recordedAt: string;
    warehouseEffect: 'none';
  };
  parents: {
    issueId: string;
    sourceStockId: string;
    materialId: string;
    manufacturerLot: string;
    receiptOperationId: string;
    componentId: string;
    quantity: number;
    unit: 'mg';
    consumptionOperationId: string;
  }[];
}
export interface SlurryOutputSource {
  operationId: string;
  productionBatchId: string;
  stepNumber: number;
  sourceSnapshot: SlurrySourceSnapshot;
  inputQuantity: number;
  declarationId: string | null;
  eligible: boolean;
}
export interface SlurryDeclaration extends SlurryOutputRequest {
  productionBatchId: string;
  stepNumber: number;
  inputQuantity: number;
  source: SlurrySourceSnapshot;
  actorId: string;
  recordedAt: string;
  qualityStatus: 'unreviewed';
  warehouseEffect: 'none';
}
export interface OutputSnapshot {
  id: string;
  declarationId: string;
  materialId: string;
  quantity: number;
  unit: 'mg';
  consumptionId: string;
  declaration: SlurryDeclaration;
}
export interface SlurryOutputLot {
  id: string;
  materialId: string;
  materialCode: string;
  materialName: string;
  productionBatchId: string;
  stepNumber: number;
  quantity: number;
  available: number;
  inTransit: number;
  received: number;
  revision: number;
  unit: 'mg';
  qualityStatus: 'unreviewed';
  eligible: boolean;
  sourceSnapshot: OutputSnapshot;
}
export interface RoomHandoff extends RoomHandoffRequest {
  productionBatchId: string;
  sourceRoom: 'slurry';
  destinationRoom: 'coating';
  recipientWorkshopId: string;
  sourceSnapshot: OutputSnapshot;
  actorId: string;
  recordedAt: string;
  unit: 'mg';
  warehouseEffect: 'none';
}
export type RoomReceipt = RoomReceiptRequest & {
  sourceSnapshot: RoomHandoff;
  actorId: string;
  recordedAt: string;
  custodyEffect: 'received' | 'none';
  unit: 'mg';
  warehouseEffect: 'none';
};
export interface RoomHandoffRead extends RoomHandoff {
  status: 'awaiting_receiver' | 'discrepancy' | 'received';
  custodyQuantity: number;
  eligible: boolean;
  events: RoomReceipt[];
  eventCount: number;
  eventsTruncated: boolean;
}
export type CustodyBase = SlurryOutputSource | SlurryOutputLot | RoomHandoffRead;
export interface CustodyMaterial {
  id: string;
  code: string;
  name: string;
  unit: 'mg';
}
export interface CustodyRecipient {
  id: string;
  name: string;
}
const bad = () => {
  throw Error('Некорректные исходные данные движения материала');
};
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad();
const list = (v: unknown, min = 1, max = 100): unknown[] =>
  Array.isArray(v) && v.length >= min && v.length <= max ? v : bad();
const keys = {
  declaration: [
    'consumptionId',
    'outputs',
    'scrapMg',
    'measuredLossMg',
    'unknownMg',
    'basis',
    'specificationReference',
    'observedAt',
  ],
  handoff: ['outputLotId', 'quantity', 'expectedSourceRevision', 'recipientId', 'destinationStepNumber'],
  receipt: ['handoffId', 'kind', 'observedQuantity'],
};
const common = ['operationId', 'deviceId', 'reason', 'evidence'];
const pick = (v: unknown, fields: string[]) => Object.fromEntries(fields.map((k) => [k, obj(v)[k]]));
export function copyCustodyRequest(command: CustodyCommand, value: unknown, strict = true): CustodyRequest {
  const r = obj(value),
    fields = [...common, ...keys[command]];
  if (
    (strict && Object.keys(r).some((k) => !fields.includes(k))) ||
    ![r.operationId, r.deviceId].every(id) ||
    ![r.reason, r.evidence].every(text)
  )
    bad();
  const base = {
    operationId: r.operationId as string,
    deviceId: r.deviceId as string,
    reason: r.reason as string,
    evidence: r.evidence as string,
  };
  if (command === 'declaration') {
    if (
      !id(r.consumptionId) ||
      ![r.scrapMg, r.measuredLossMg, r.unknownMg].every((v) => integer(v)) ||
      r.basis !== 'weighed-slurry-mass' ||
      !text(r.specificationReference) ||
      typeof r.observedAt !== 'number' ||
      !Number.isFinite(r.observedAt) ||
      r.observedAt <= 0
    )
      bad();
    const outputs = list(r.outputs).map((v) => {
      const o = obj(v);
      if (
        !id(o.id) ||
        !id(o.materialId) ||
        !integer(o.quantity, 1) ||
        Object.keys(o).some((k) => !['id', 'materialId', 'quantity'].includes(k))
      )
        bad();
      return {id: o.id as string, materialId: o.materialId as string, quantity: o.quantity as number};
    });
    if (new Set(outputs.map((o) => o.id)).size !== outputs.length) bad();
    return {
      ...base,
      consumptionId: r.consumptionId as string,
      outputs,
      scrapMg: r.scrapMg as number,
      measuredLossMg: r.measuredLossMg as number,
      unknownMg: r.unknownMg as number,
      basis: 'weighed-slurry-mass',
      specificationReference: r.specificationReference as string,
      observedAt: r.observedAt as number,
    };
  }
  if (command === 'handoff') {
    if (
      ![r.outputLotId, r.recipientId].every(id) ||
      !integer(r.quantity, 1) ||
      !integer(r.expectedSourceRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
      !integer(r.destinationStepNumber, 1, 2147483647)
    )
      bad();
    return {
      ...base,
      outputLotId: r.outputLotId as string,
      quantity: r.quantity as number,
      expectedSourceRevision: r.expectedSourceRevision as number,
      recipientId: r.recipientId as string,
      destinationStepNumber: r.destinationStepNumber as number,
    };
  }
  if (
    !id(r.handoffId) ||
    !(r.kind === 'receive'
      ? integer(r.observedQuantity, 1)
      : r.kind === 'discrepancy' && (r.observedQuantity === null || integer(r.observedQuantity)))
  )
    bad();
  return {
    ...base,
    handoffId: r.handoffId as string,
    kind: r.kind,
    observedQuantity: r.observedQuantity,
  } as RoomReceiptRequest;
}
function copySourceSnapshot(value: unknown): SlurrySourceSnapshot {
  const raw = obj(value),
    c = obj(raw.consumption),
    s = obj(c.source);
  if (
    ![c.operationId, c.deviceId, c.productionBatchId, c.actorId].every(id) ||
    !integer(c.stepNumber, 1, 2147483647) ||
    c.room !== 'slurry' ||
    c.warehouseEffect !== 'none' ||
    !instant(c.recordedAt) ||
    ![c.reason, c.evidence].every(text) ||
    ![s.id, s.recordedBy, s.recordedRole, s.batchCode, s.recipeName, s.measurementNote].every(text) ||
    !integer(s.recordedAt, 1, 8640000000000000) ||
    !(s.recipeId === null || text(s.recipeId)) ||
    !(s.recipeRevision === null || integer(s.recipeRevision, 1))
  )
    bad();
  const components = list(s.components).map((v) => {
    const r = obj(v);
    if (!text(r.componentId) || !integer(r.componentVersion, 1) || !integer(r.actualMg)) bad();
    return {
      componentId: r.componentId as string,
      componentVersion: r.componentVersion as number,
      actualMg: r.actualMg as number,
    };
  });
  const allocations = list(c.allocations).map((v) => {
    const r = obj(v);
    if (
      ![r.operationId, r.issueId, r.materialId].every(id) ||
      !text(r.componentId) ||
      !integer(r.quantity, 1) ||
      !integer(r.expectedSettlementRevision, 1)
    )
      bad();
    return {
      operationId: r.operationId as string,
      issueId: r.issueId as string,
      materialId: r.materialId as string,
      componentId: r.componentId as string,
      quantity: r.quantity as number,
      expectedSettlementRevision: r.expectedSettlementRevision as number,
    };
  });
  const parents = list(raw.parents).map((v) => {
    const r = obj(v);
    if (
      ![r.issueId, r.sourceStockId, r.materialId, r.receiptOperationId, r.consumptionOperationId].every(id) ||
      !text(r.manufacturerLot) ||
      !text(r.componentId) ||
      !integer(r.quantity, 1) ||
      r.unit !== 'mg'
    )
      bad();
    return {
      issueId: r.issueId as string,
      sourceStockId: r.sourceStockId as string,
      materialId: r.materialId as string,
      manufacturerLot: r.manufacturerLot as string,
      receiptOperationId: r.receiptOperationId as string,
      componentId: r.componentId as string,
      quantity: r.quantity as number,
      unit: 'mg' as const,
      consumptionOperationId: r.consumptionOperationId as string,
    };
  });
  if (
    new Set(components.map((v) => v.componentId)).size !== components.length ||
    new Set(allocations.map((v) => v.operationId)).size !== allocations.length ||
    new Set(allocations.map((v) => v.issueId)).size !== allocations.length ||
    new Set(parents.map((v) => v.consumptionOperationId)).size !== parents.length ||
    parents.length !== allocations.length ||
    allocations.some(
      (a) =>
        !components.some((v) => v.componentId === a.componentId) ||
        !parents.some(
          (p) =>
            p.consumptionOperationId === a.operationId &&
            p.issueId === a.issueId &&
            p.materialId === a.materialId &&
            p.componentId === a.componentId &&
            p.quantity === a.quantity,
        ),
    ) ||
    components.some(
      (v) =>
        allocations
          .filter((a) => a.componentId === v.componentId)
          .reduce((n, a) => n + BigInt(a.quantity), 0n) !== BigInt(v.actualMg),
    )
  )
    bad();
  return {
    consumption: {
      operationId: c.operationId as string,
      deviceId: c.deviceId as string,
      productionBatchId: c.productionBatchId as string,
      stepNumber: c.stepNumber as number,
      source: {
        id: s.id as string,
        recordedAt: s.recordedAt as number,
        recordedBy: s.recordedBy as string,
        recordedRole: s.recordedRole as string,
        batchCode: s.batchCode as string,
        recipeId: s.recipeId as string | null,
        recipeRevision: s.recipeRevision as number | null,
        recipeName: s.recipeName as string,
        measurementNote: s.measurementNote as string,
        components,
      },
      allocations,
      reason: c.reason as string,
      evidence: c.evidence as string,
      room: 'slurry',
      actorId: c.actorId as string,
      recordedAt: c.recordedAt as string,
      warehouseEffect: 'none',
    },
    parents,
  };
}
const sourceMass = (s: SlurrySourceSnapshot) =>
  s.consumption.source.components.reduce((n, c) => n + BigInt(c.actualMg), 0n);
export function copySlurrySource(value: unknown): SlurryOutputSource {
  const r = obj(value),
    sourceSnapshot = copySourceSnapshot(r.sourceSnapshot);
  if (
    !id(r.operationId) ||
    !id(r.productionBatchId) ||
    !integer(r.stepNumber, 1) ||
    !integer(r.inputQuantity, 1) ||
    !(r.declarationId === null || id(r.declarationId)) ||
    typeof r.eligible !== 'boolean' ||
    r.operationId !== sourceSnapshot.consumption.operationId ||
    r.productionBatchId !== sourceSnapshot.consumption.productionBatchId ||
    r.stepNumber !== sourceSnapshot.consumption.stepNumber ||
    BigInt(r.inputQuantity as number) !== sourceMass(sourceSnapshot)
  )
    bad();
  return {
    operationId: r.operationId as string,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    sourceSnapshot,
    inputQuantity: r.inputQuantity as number,
    declarationId: r.declarationId as string | null,
    eligible: r.eligible as boolean,
  };
}
export function copyDeclaration(value: unknown): SlurryDeclaration {
  const r = obj(value),
    request = copyCustodyRequest(
      'declaration',
      pick(r, [...common, ...keys.declaration]),
    ) as SlurryOutputRequest,
    source = copySourceSnapshot(r.source);
  if (
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    r.qualityStatus !== 'unreviewed' ||
    r.warehouseEffect !== 'none' ||
    r.productionBatchId !== source.consumption.productionBatchId ||
    r.stepNumber !== source.consumption.stepNumber ||
    r.consumptionId !== source.consumption.operationId ||
    !integer(r.inputQuantity, 1) ||
    BigInt(r.inputQuantity as number) !== sourceMass(source) ||
    request.outputs.reduce((n, o) => n + BigInt(o.quantity), 0n) +
      BigInt(request.scrapMg) +
      BigInt(request.measuredLossMg) +
      BigInt(request.unknownMg) !==
      sourceMass(source)
  )
    bad();
  return {
    ...request,
    source,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    inputQuantity: r.inputQuantity as number,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    qualityStatus: 'unreviewed',
    warehouseEffect: 'none',
  };
}
export function copyOutputSnapshot(value: unknown): OutputSnapshot {
  const r = obj(value),
    declaration = copyDeclaration(r.declaration);
  if (
    !id(r.id) ||
    r.declarationId !== declaration.operationId ||
    r.consumptionId !== declaration.consumptionId ||
    r.unit !== 'mg' ||
    !declaration.outputs.some(
      (o) => o.id === r.id && o.materialId === r.materialId && o.quantity === r.quantity,
    )
  )
    bad();
  return {
    id: r.id as string,
    declarationId: r.declarationId as string,
    materialId: r.materialId as string,
    quantity: r.quantity as number,
    unit: 'mg',
    consumptionId: r.consumptionId as string,
    declaration,
  };
}
export function copyOutputLot(value: unknown): SlurryOutputLot {
  const r = obj(value),
    sourceSnapshot = copyOutputSnapshot(r.sourceSnapshot);
  if (
    r.id !== sourceSnapshot.id ||
    r.materialId !== sourceSnapshot.materialId ||
    r.quantity !== sourceSnapshot.quantity ||
    r.productionBatchId !== sourceSnapshot.declaration.productionBatchId ||
    r.stepNumber !== sourceSnapshot.declaration.stepNumber ||
    ![r.materialName, r.materialCode].every(text) ||
    ![r.available, r.inTransit, r.received].every((v) => integer(v)) ||
    !integer(r.revision, 1) ||
    BigInt(r.available as number) + BigInt(r.inTransit as number) + BigInt(r.received as number) !==
      BigInt(sourceSnapshot.quantity) ||
    r.unit !== 'mg' ||
    r.qualityStatus !== 'unreviewed' ||
    typeof r.eligible !== 'boolean'
  )
    bad();
  return {
    id: r.id as string,
    materialId: r.materialId as string,
    materialCode: r.materialCode as string,
    materialName: r.materialName as string,
    productionBatchId: r.productionBatchId as string,
    stepNumber: r.stepNumber as number,
    quantity: r.quantity as number,
    available: r.available as number,
    inTransit: r.inTransit as number,
    received: r.received as number,
    revision: r.revision as number,
    unit: 'mg',
    qualityStatus: 'unreviewed',
    eligible: r.eligible as boolean,
    sourceSnapshot,
  };
}
export function copyHandoff(value: unknown): RoomHandoff {
  const r = obj(value),
    request = copyCustodyRequest('handoff', pick(r, [...common, ...keys.handoff])) as RoomHandoffRequest,
    sourceSnapshot = copyOutputSnapshot(r.sourceSnapshot);
  if (
    !id(r.actorId) ||
    !instant(r.recordedAt) ||
    r.sourceRoom !== 'slurry' ||
    r.destinationRoom !== 'coating' ||
    r.unit !== 'mg' ||
    r.warehouseEffect !== 'none' ||
    !text(r.recipientWorkshopId) ||
    r.productionBatchId !== sourceSnapshot.declaration.productionBatchId ||
    request.outputLotId !== sourceSnapshot.id ||
    request.quantity > sourceSnapshot.quantity ||
    request.destinationStepNumber <= sourceSnapshot.declaration.stepNumber
  )
    bad();
  return {
    ...request,
    sourceSnapshot,
    productionBatchId: r.productionBatchId as string,
    sourceRoom: 'slurry',
    destinationRoom: 'coating',
    recipientWorkshopId: r.recipientWorkshopId as string,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    unit: 'mg',
    warehouseEffect: 'none',
  };
}
export function copyReceipt(value: unknown): RoomReceipt {
  const r = obj(value),
    request = copyCustodyRequest('receipt', pick(r, [...common, ...keys.receipt])) as RoomReceiptRequest,
    sourceSnapshot = copyHandoff(r.sourceSnapshot);
  if (
    r.actorId !== sourceSnapshot.recipientId ||
    !instant(r.recordedAt) ||
    r.unit !== 'mg' ||
    r.warehouseEffect !== 'none' ||
    r.custodyEffect !== (request.kind === 'receive' ? 'received' : 'none') ||
    request.handoffId !== sourceSnapshot.operationId ||
    (request.kind === 'receive' && request.observedQuantity !== sourceSnapshot.quantity)
  )
    bad();
  return {
    ...request,
    sourceSnapshot,
    actorId: r.actorId as string,
    recordedAt: r.recordedAt as string,
    custodyEffect: r.custodyEffect as RoomReceipt['custodyEffect'],
    unit: 'mg',
    warehouseEffect: 'none',
  };
}
export function copyRoomHandoff(value: unknown): RoomHandoffRead {
  const r = obj(value),
    handoff = copyHandoff(value),
    events = list(r.events, 0, 10).map(copyReceipt);
  if (
    !integer(r.eventCount) ||
    typeof r.eventsTruncated !== 'boolean' ||
    r.eventsTruncated !== (r.eventCount as number) > 10 ||
    events.length !== Math.min(r.eventCount as number, 10) ||
    typeof r.eligible !== 'boolean' ||
    !['awaiting_receiver', 'discrepancy', 'received'].includes(r.status as string) ||
    r.custodyQuantity !== (r.status === 'received' ? handoff.quantity : 0) ||
    events.some((e) => !same(e.sourceSnapshot, handoff)) ||
    new Set(events.map((e) => e.operationId)).size !== events.length ||
    (r.status === 'received') !== events.some((e) => e.kind === 'receive') ||
    (r.status === 'awaiting_receiver' && events.length !== 0) ||
    (r.status === 'discrepancy' && !events.some((e) => e.kind === 'discrepancy'))
  )
    bad();
  return {
    ...handoff,
    status: r.status as RoomHandoffRead['status'],
    custodyQuantity: r.custodyQuantity as number,
    eligible: r.eligible as boolean,
    events,
    eventCount: r.eventCount as number,
    eventsTruncated: r.eventsTruncated as boolean,
  };
}
export function copyMaterial(value: unknown): CustodyMaterial {
  const r = obj(value);
  if (!id(r.id) || !text(r.code) || !text(r.name) || r.unit !== 'mg') bad();
  return {id: r.id as string, code: r.code as string, name: r.name as string, unit: 'mg'};
}
export function copyRecipient(value: unknown): CustodyRecipient {
  const r = obj(value);
  if (!id(r.id) || !text(r.name)) bad();
  return {id: r.id as string, name: r.name as string};
}
