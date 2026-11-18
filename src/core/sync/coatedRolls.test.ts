import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "../db";
import { UserRole } from "../types";
import { inventoryOutbox } from "./inventoryOutbox";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import { coatingSlurryTestSource } from "./coatedRollTestFixture";
import { copyCoatingConsumption } from "./coatingConsumption";
import { copyFoilConsumption } from "./coatingFoil";
import {
  copyRollRequest,
  copyRollDeclaration,
  copyRollLot,
  copyRollHandoff,
  copyRollHandoffRead,
  freezeRollCommand,
  sendRollCommand,
  rollProposals,
  type RollCommand,
} from "./coatedRolls";
vi.mock("./inventoryClient", () => ({ inventoryRequest: vi.fn() }));
vi.mock("./inventoryIssueClient", () => ({
  loadInventoryIssueContext: vi.fn(),
}));
const id = () => crypto.randomUUID(),
  scope = {
    serverUrl: "https://factory.test",
    organizationId: id(),
    actorId: id(),
    deviceId: id(),
  },
  actor = "roll-worker",
  epoch = id(),
  at = new Date().toISOString();
function fixture() {
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
beforeEach(async () => {
  await db.open();
  await inventoryOutbox.open();
  await db.users.put({
    id: actor,
    login: actor,
    fullName: "Synthetic worker",
    password: "test-only",
    role: UserRole.WORKER,
    isActive: true,
    createdAt: new Date(),
  });
  vi.mocked(loadInventoryIssueContext).mockResolvedValue({
    ...scope,
    epoch,
    postingEnabled: true,
    warehouseLevel: null,
  });
});
afterEach(async () => {
  vi.resetAllMocks();
  db.close();
  await db.delete();
  inventoryOutbox.close();
  await inventoryOutbox.delete();
});
it("keeps original output, offer and receipt bodies across reopen and a lost committed reply without stock effects", async () => {
  const f = fixture();
  for (const [command, field, value] of [
    [f.command, "declaration", f.declaration],
    [f.offer, "handoff", f.handoff],
    [
      f.receipt,
      "receipt",
      {
        ...f.receipt.request,
        sourceSnapshot: f.handoff,
        actorId: scope.actorId,
        recordedAt: at,
        custodyEffect: "received",
        unit: "rolls",
        warehouseEffect: "none",
      },
    ],
  ] as const) {
    const row = await freezeRollCommand(scope, actor, epoch, command);
    inventoryOutbox.close();
    await inventoryOutbox.open();
    vi.mocked(inventoryRequest)
      .mockRejectedValueOnce(Error("Lost committed reply"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "duplicate",
            operationId: command.request.operationId,
            [field]: value,
          }),
          { status: 200 },
        ),
      );
    await expect(
      sendRollCommand({} as never, scope, actor, row.key),
    ).rejects.toThrow("Lost");
    await sendRollCommand({} as never, scope, actor, row.key);
    const calls = vi.mocked(inventoryRequest).mock.calls.slice(-2);
    expect(calls[0][3]?.body).toBe(row.fields.request);
    expect(calls[1][3]?.body).toBe(row.fields.request);
    expect(
      (await rollProposals(scope, actor)).find((r) => r.key === row.key)?.fields
        .state,
    ).toBe("accepted");
  }
  expect(await inventoryOutbox.stocks.count()).toBe(0);
});
it("holds duplicate input attribution, changed history and forged acknowledgements", async () => {
  const f = fixture(),
    row = await freezeRollCommand(scope, actor, epoch, f.command);
  await expect(
    freezeRollCommand(scope, actor, epoch, {
      ...f.command,
      request: { ...f.command.request, operationId: id() },
    } as RollCommand),
  ).rejects.toThrow("удержан");
  vi.mocked(loadInventoryIssueContext).mockResolvedValueOnce({
    ...scope,
    epoch: id(),
    postingEnabled: true,
    warehouseLevel: null,
  });
  await expect(
    sendRollCommand({} as never, scope, actor, row.key),
  ).rejects.toThrow("История");
  expect(inventoryRequest).not.toHaveBeenCalled();
  vi.mocked(inventoryRequest).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        status: "confirmed",
        operationId: f.command.request.operationId,
        declaration: { ...f.declaration, qualityStatus: "released" },
      }),
      { status: 201 },
    ),
  );
  await expect(
    sendRollCommand({} as never, scope, actor, row.key),
  ).rejects.toThrow();
  expect((await rollProposals(scope, actor))[0].fields.state).toBe("pending");
});
it("never lets a late valid receipt replace a newer local conflict", async () => {
  const f = fixture(),
    row = await freezeRollCommand(scope, actor, epoch, f.receipt);
  let finish!: (r: Response) => void;
  vi.mocked(inventoryRequest).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = sendRollCommand({} as never, scope, actor, row.key),
    rejected = expect(sending).rejects.toThrow("изменилось");
  await vi.waitFor(() => expect(inventoryRequest).toHaveBeenCalledOnce());
  await inventoryOutbox.receivingDrafts.update(row.key, {
    fields: { ...row.fields, state: "conflict" },
  });
  finish(
    new Response(
      JSON.stringify({
        status: "confirmed",
        operationId: f.receipt.request.operationId,
        receipt: {
          ...f.receipt.request,
          sourceSnapshot: f.handoff,
          actorId: scope.actorId,
          recordedAt: at,
          custodyEffect: "received",
          unit: "rolls",
          warehouseEffect: "none",
        },
      }),
      { status: 201 },
    ),
  );
  await rejected;
  expect((await rollProposals(scope, actor))[0].fields.state).toBe("conflict");
});
