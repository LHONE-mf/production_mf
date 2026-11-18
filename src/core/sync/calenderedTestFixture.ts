import type { InventoryScope } from "./inventoryOutbox";
import { coatedRollTestData } from "./calendaringTestFixture";
import { copyRollReceipt } from "./coatedRollTypes";
import { copyCalendaringConsumption } from "./calendaringConsumption";
import {
  copyCalenderedRequest,
  copyCalenderedDeclaration,
  copyCalenderedLot,
  copyCalenderedHandoff,
  copyCalenderedHandoffRead,
  type CalenderedCommand,
} from "./calenderedRolls";
const id = () => crypto.randomUUID();
export function calenderedRollTestData(
  scope: InventoryScope,
  at = new Date().toISOString(),
) {
  const upstream = coatedRollTestData(scope, at).receipt;
  if (upstream.kind !== "receipt") throw Error("Synthetic receipt required");
  const input = copyRollReceipt({
      ...upstream.request,
      sourceSnapshot: upstream.base.handoff.handoff,
      actorId: scope.actorId,
      recordedAt: at,
      custodyEffect: "received",
      unit: "rolls",
      warehouseEffect: "none",
    }),
    allocationId = id();
  const consumption = copyCalendaringConsumption({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: input.sourceSnapshot.productionBatchId,
    stepNumber: 3,
    materialId: input.sourceSnapshot.sourceSnapshot.materialId,
    observedAt: 1000,
    reference: "Synthetic actual Calendaring input observation",
    actualLengthMm: 250,
    allocations: [
      {
        operationId: allocationId,
        receiptId: input.operationId,
        quantity: 250,
        expectedRevision: 1,
      },
    ],
    reason: "Independent measured input use",
    evidence: "Synthetic actual length observation",
    room: "calendaring",
    unit: "mm",
    actorId: scope.actorId,
    recordedAt: at,
    warehouseEffect: "none",
    sources: [
      {
        allocationOperationId: allocationId,
        source: {
          receipt: input,
          received: 400,
          consumed: 0,
          remaining: 400,
          revision: 1,
          capacityBasis: "coating_measured_roll_length",
        },
      },
    ],
  });
  const request = copyCalenderedRequest({
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: consumption.productionBatchId,
    stepNumber: 3,
    consumptionIds: [consumption.operationId],
    outputs: [
      {
        id: id(),
        materialId: consumption.materialId,
        label: "Synthetic calendered physical roll A",
        measuredLengthMm: 240,
        measuredMassMg: null,
        disposition: "ready",
      },
    ],
    scrapLengthMm: null,
    scrapMassMg: null,
    accountingNote: "Unknown actual loss; output is independently measured",
    observedAt: 1000,
    specificationReference: "Explicit output card",
    reference: "Independent actual calendered output",
    reason: "Observed physical output",
    evidence: "Synthetic measured output length",
  });
  const command: CalenderedCommand = {
    kind: "output",
    request,
    base: {
      inputs: [
        {
          operationId: consumption.operationId,
          productionBatchId: consumption.productionBatchId,
          stepNumber: 3,
          materialId: consumption.materialId,
          consumption,
          batchCode: "Synthetic",
          claimedBy: null,
          eligible: true,
        },
      ],
    },
  };
  const declaration = copyCalenderedDeclaration({
      ...request,
      sources: [consumption],
      actorId: scope.actorId,
      recordedAt: at,
      qualityStatus: "unreviewed",
      materialAccountingStatus: "unreconciled",
      genealogyScope: "declaration",
      warehouseEffect: "none",
    }),
    roll = request.outputs[0];
  const lot = copyCalenderedLot({
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
    materialCode: "CALENDERED",
    materialName: "Explicit output SKU",
    batchCode: "Synthetic",
    reserved: 0,
    received: 0,
    remaining: 1,
    revision: 1,
    eligible: true,
  });
  const offer: CalenderedCommand = {
    kind: "offer",
    request: {
      operationId: id(),
      deviceId: scope.deviceId,
      outputLotId: lot.id,
      quantity: 1,
      expectedSourceRevision: 1,
      recipientId: scope.actorId,
      destinationStepNumber: 4,
      reason: "Direct physical roll transfer",
      evidence: "Synthetic identified output roll",
    },
    base: {
      lot,
      recipient: { id: scope.actorId, name: "Assigned Cutting receiver" },
      destinationStepNumber: 4,
      recipientWorkshopId: "cutting",
    },
  };
  const handoff = copyCalenderedHandoff({
    ...offer.request,
    productionBatchId: request.productionBatchId,
    sourceRoom: "calendaring",
    destinationRoom: "cutting",
    recipientWorkshopId: "cutting",
    sourceSnapshot: lot.snapshot,
    actorId: scope.actorId,
    recordedAt: at,
    unit: "rolls",
    warehouseEffect: "none",
  });
  const receipt: CalenderedCommand = {
    kind: "receipt",
    request: {
      operationId: id(),
      deviceId: scope.deviceId,
      handoffId: handoff.operationId,
      kind: "receive",
      observedQuantity: 1,
      observedRollLabel: roll.label,
      observedLengthMm: null,
      measurementNote:
        "Physical count and label checked; length not remeasured",
      reason: "Actual assigned receipt",
      evidence: "Synthetic independent receiver",
    },
    base: {
      handoff: copyCalenderedHandoffRead({
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
