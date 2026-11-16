import type { InventoryScope } from "./inventoryOutbox";
import { coatingSlurryTestSource } from "./coatedRollTestFixture";
import { copyCoatingConsumption } from "./coatingConsumption";
import { copyFoilConsumption } from "./coatingFoil";
import {
  copyRollRequest,
  copyRollDeclaration,
  copyRollLot,
  copyRollHandoff,
  copyRollHandoffRead,
} from "./coatedRollTypes";
const id = () => crypto.randomUUID();
import type { RollCommand } from "./coatedRolls";
export function coatedRollTestData(
  scope: InventoryScope,
  at = new Date().toISOString(),
) {
  const batch = id(),
    s = coatingSlurryTestSource(scope, batch, at),
    a = id();
  const slurry = copyCoatingConsumption({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: batch,
    stepNumber: 2,
    observedAt: 1000.5,
    reference: "Independent mass measurement",
    actualMg: 300,
    allocations: [
      {
        operationId: a,
        receiptId: s.receipt.operationId,
        quantity: 300,
        expectedRevision: 1,
      },
    ],
    reason: "Actual input",
    evidence: "Scale",
    room: "coating",
    unit: "mg",
    actorId: scope.actorId,
    recordedAt: at,
    warehouseEffect: "none",
    sources: [
      {
        allocationOperationId: a,
        source: {
          receipt: s.receipt,
          received: 400,
          consumed: 0,
          remaining: 400,
          revision: 1,
        },
      },
    ],
  });
  const issueId = id(),
    materialId = id(),
    stockId = id(),
    issue = {
      id: issueId,
      materialId,
      productionBatchId: batch,
      stepNumber: 2,
      workshopId: "coating",
      recipientId: scope.actorId,
      requestedBy: scope.actorId,
      quantity: 800,
      unit: "mm",
      state: "received",
      revision: 5,
      stockId,
      source: {
        stockId,
        materialId,
        manufacturerLot: "Synthetic foil lot",
        locationId: id(),
        unit: "mm",
        quality: "released",
      },
      approvalOperationId: id(),
      approvedStockRevision: 3,
      approvedBy: id(),
      approvedDeviceId: id(),
      dispatchOperationId: id(),
      receiptOperationId: id(),
    },
    settlement = {
      revision: 1,
      issued: 800,
      returned: 0,
      scrapped: 0,
      consumed: 0,
      outstanding: 800,
    };
  const foil = copyFoilConsumption({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: batch,
    stepNumber: 2,
    materialId,
    unit: "mm",
    observedAt: 1000,
    reference: "Actual foil input",
    specificationReference: "Explicit material card",
    actualQuantity: 500,
    allocations: [
      {
        operationId: id(),
        issueId,
        quantity: 500,
        expectedSettlementRevision: 1,
      },
    ],
    reason: "Measured length",
    evidence: "Physical measurement",
    room: "coating",
    actorId: scope.actorId,
    recordedAt: at,
    warehouseEffect: "none",
    sources: [{ issue, settlement }],
  });
  const request = copyRollRequest({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: batch,
    stepNumber: 2,
    slurryConsumptionIds: [slurry.operationId],
    foilConsumptionIds: [foil.operationId],
    outputs: [
      {
        id: id(),
        materialId: id(),
        label: "Synthetic physical roll A",
        measuredLengthMm: 400,
        measuredMassMg: null,
        disposition: "ready",
      },
    ],
    tape: { status: "not_applicable", note: "Explicit card decision" },
    scrapLengthMm: null,
    scrapMassMg: null,
    accountingNote: "Loss remains unmeasured",
    observedAt: 1000,
    specificationReference: "Output specification",
    reference: "Actual Coating operation",
    reason: "Observed output",
    evidence: "Physical identity and length",
  });
  const command: RollCommand = {
    kind: "output",
    request,
    base: {
      inputs: [
        {
          operationId: slurry.operationId,
          productionBatchId: batch,
          stepNumber: 2,
          consumption: slurry,
          batchCode: "Synthetic",
          claimedBy: null,
          eligible: true,
          kind: "slurry",
        },
        {
          operationId: foil.operationId,
          productionBatchId: batch,
          stepNumber: 2,
          consumption: foil,
          batchCode: "Synthetic",
          claimedBy: null,
          eligible: true,
          kind: "foil",
        },
      ],
      tape: [],
    },
  };
  const declaration = copyRollDeclaration({
      ...request,
      sources: { slurry: [slurry], foil: [foil], tape: [] },
      actorId: scope.actorId,
      recordedAt: at,
      qualityStatus: "unreviewed",
      materialAccountingStatus: "unreconciled",
      genealogyScope: "declaration",
      warehouseEffect: "none",
    }),
    roll = request.outputs[0],
    lot = copyRollLot({
      id: roll.id,
      snapshot: {
        id: roll.id,
        declarationId: request.operationId,
        materialId: roll.materialId,
        quantity: 1,
        unit: "rolls",
        roll,
        declaration,
      },
      materialCode: "Coated",
      materialName: "Explicit roll SKU",
      batchCode: "Synthetic",
      reserved: 0,
      received: 0,
      remaining: 1,
      revision: 1,
      eligible: true,
    });
  const offer: RollCommand = {
    kind: "offer",
    request: {
      operationId: id(),
      deviceId: scope.deviceId,
      outputLotId: lot.id,
      quantity: 1,
      expectedSourceRevision: 1,
      recipientId: scope.actorId,
      destinationStepNumber: 3,
      reason: "Physical transfer",
      evidence: "Roll label",
    },
    base: {
      lot,
      recipient: { id: scope.actorId, name: "Assigned receiver" },
      destinationStepNumber: 3,
      recipientWorkshopId: "calendaring",
    },
  };
  const handoff = copyRollHandoff({
    ...offer.request,
    productionBatchId: batch,
    sourceRoom: "coating",
    destinationRoom: "calendaring",
    recipientWorkshopId: "calendaring",
    sourceSnapshot: lot.snapshot,
    actorId: scope.actorId,
    recordedAt: at,
    unit: "rolls",
    warehouseEffect: "none",
  });
  const receipt: RollCommand = {
    kind: "receipt",
    request: {
      operationId: id(),
      deviceId: scope.deviceId,
      handoffId: handoff.operationId,
      kind: "receive",
      observedQuantity: 1,
      observedRollLabel: roll.label,
      observedLengthMm: null,
      measurementNote: "Count/identity verified, length not remeasured",
      reason: "Actual receipt",
      evidence: "Physical label",
    },
    base: {
      handoff: copyRollHandoffRead({
        operationId: handoff.operationId,
        handoff,
        eligible: true,
        received: null,
        eventCount: 0,
      }),
    },
  };
  return { command, declaration, offer, handoff, receipt };
}
