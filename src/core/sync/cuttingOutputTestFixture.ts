import type { InventoryScope } from "./inventoryOutbox";
import { calenderedRollTestData } from "./calenderedTestFixture";
import { copyCalenderedReceipt } from "./calenderedRollTypes";
import { copyCuttingConsumption } from "./cuttingConsumption";
import {
  copyCutOutputRequest,
  copyCutOutputDeclaration,
  copyCutOutputLot,
  copyCutOutputHandoff,
  copyCutOutputHandoffRead,
  type CutOutputCommand,
} from "./cuttingOutputs";
const id = () => crypto.randomUUID();
export function cuttingOutputTestData(
  scope: InventoryScope,
  at = new Date().toISOString(),
) {
  const upstream = calenderedRollTestData(scope, at).receipt;
  if (upstream.kind !== "receipt") throw Error("Synthetic receipt required");
  const receipt = copyCalenderedReceipt({
      ...upstream.request,
      sourceSnapshot: upstream.base.handoff.handoff,
      actorId: scope.actorId,
      recordedAt: at,
      custodyEffect: "received",
      unit: "rolls",
      warehouseEffect: "none",
    }),
    a = id();
  const consumption = copyCuttingConsumption({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: receipt.sourceSnapshot.productionBatchId,
    stepNumber: 4,
    materialId: receipt.sourceSnapshot.sourceSnapshot.materialId,
    observedAt: 1000,
    reference: "Synthetic independently measured Cutting input",
    actualLengthMm: 150,
    allocations: [
      {
        operationId: a,
        receiptId: receipt.operationId,
        quantity: 150,
        expectedRevision: 1,
      },
    ],
    reason: "Actual measured length cut",
    evidence: "Synthetic independent measurement",
    room: "cutting",
    unit: "mm",
    actorId: scope.actorId,
    recordedAt: at,
    warehouseEffect: "none",
    sources: [
      {
        allocationOperationId: a,
        source: {
          receipt,
          received: 240,
          consumed: 0,
          remaining: 240,
          revision: 1,
          capacityBasis: "calendered_measured_roll_length",
        },
      },
    ],
  });
  const request = copyCutOutputRequest({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: consumption.productionBatchId,
    stepNumber: 4,
    unit: "pieces",
    consumptionIds: [consumption.operationId],
    outputs: [
      {
        id: id(),
        materialId: id(),
        label: "SYNTHETIC-CUT-LOT",
        quantity: 9,
        disposition: "ready",
      },
    ],
    rejectedPieces: null,
    scrapLengthMm: null,
    scrapMassMg: null,
    accountingNote: "Independent count; rejects and losses not measured",
    observedAt: 1000,
    specificationReference: "Explicit output card",
    reference: "Synthetic independently counted output",
    reason: "Actual physical piece count",
    evidence: "No geometric yield estimate",
  });
  const command: CutOutputCommand = {
    kind: "output",
    request,
    base: {
      inputs: [
        {
          operationId: consumption.operationId,
          productionBatchId: consumption.productionBatchId,
          stepNumber: 4,
          materialId: consumption.materialId,
          consumption,
          batchCode: "Synthetic",
          claimedBy: null,
          eligible: true,
        },
      ],
    },
  };
  const declaration = copyCutOutputDeclaration({
      ...request,
      sources: [consumption],
      actorId: scope.actorId,
      recordedAt: at,
      qualityStatus: "unreviewed",
      materialAccountingStatus: "unreconciled",
      genealogyScope: "declaration",
      warehouseEffect: "none",
    }),
    lot = request.outputs[0];
  const source = copyCutOutputLot({
    id: lot.id,
    snapshot: {
      id: lot.id,
      declarationId: request.operationId,
      materialId: lot.materialId,
      quantity: lot.quantity,
      unit: "pieces",
      lot,
      declaration,
    },
    materialCode: "UNSORTED",
    materialName: "Explicit unsorted electrode SKU",
    batchCode: "Synthetic",
    reserved: 0,
    received: 0,
    remaining: 9,
    revision: 1,
    eligible: true,
  });
  const offer: CutOutputCommand = {
    kind: "offer",
    request: {
      operationId: id(),
      deviceId: scope.deviceId,
      outputLotId: lot.id,
      quantity: 4,
      unit: "pieces",
      expectedSourceRevision: 1,
      recipientId: scope.actorId,
      destinationStepNumber: 5,
      reason: "Actual direct partial lot transfer",
      evidence: "Physical count and source label",
    },
    base: {
      lot: source,
      recipient: { id: scope.actorId, name: "Assigned Sorting receiver" },
      destinationStepNumber: 5,
      recipientWorkshopId: "sorting",
    },
  };
  const handoff = copyCutOutputHandoff({
    ...offer.request,
    productionBatchId: request.productionBatchId,
    sourceRoom: "cutting",
    destinationRoom: "sorting",
    recipientWorkshopId: "sorting",
    sourceSnapshot: source.snapshot,
    actorId: scope.actorId,
    recordedAt: at,
    unit: "pieces",
    warehouseEffect: "none",
  });
  const received: CutOutputCommand = {
    kind: "receipt",
    request: {
      operationId: id(),
      deviceId: scope.deviceId,
      handoffId: handoff.operationId,
      kind: "receive",
      unit: "pieces",
      observedQuantity: 4,
      observedLotLabel: lot.label,
      measurementNote:
        "Independent physical count and source-lot identity check",
      reason: "Assigned actual receipt",
      evidence: "Synthetic separate count",
    },
    base: {
      handoff: copyCutOutputHandoffRead({
        operationId: handoff.operationId,
        handoff,
        eligible: true,
        received: null,
        eventCount: 0,
      }),
    },
  };
  return { command, declaration, offer, handoff, receipt: received };
}
