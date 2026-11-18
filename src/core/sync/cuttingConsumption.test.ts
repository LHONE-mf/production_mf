import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "../db";
import { UserRole } from "../types";
import { inventoryOutbox } from "./inventoryOutbox";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import { calenderedRollTestData } from "./calenderedTestFixture";
import { copyCalenderedReceipt } from "./calenderedRollTypes";
import {
  measuredCuttingMm,
  copyCuttingRollSource,
  copyCuttingRequest,
  freezeCuttingConsumption,
  sendCuttingConsumption,
  cuttingConsumptionProposals,
} from "./cuttingConsumption";
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
  actor = "calendar-worker",
  epoch = id(),
  at = new Date().toISOString();
function fixture() {
  const data = calenderedRollTestData(scope),
    command = data.receipt;
  if (command.kind !== "receipt") throw Error("Fixture receipt required");
  const receipt = copyCalenderedReceipt({
      ...command.request,
      sourceSnapshot: command.base.handoff.handoff,
      actorId: scope.actorId,
      recordedAt: at,
      custodyEffect: "received",
      unit: "rolls",
      warehouseEffect: "none",
    }),
    h = receipt.sourceSnapshot;
  const source = copyCuttingRollSource({
    receipt,
    received: 240,
    consumed: 0,
    remaining: 240,
    revision: 1,
    capacityBasis: "calendered_measured_roll_length",
    productionBatchId: h.productionBatchId,
    stepNumber: 4,
    materialId: h.sourceSnapshot.materialId,
    materialCode: "ROLL",
    materialName: "Synthetic explicitly measured electrode roll",
    batchCode: "Synthetic",
    eligible: true,
    unit: "mm",
  });
  const request = {
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: source.productionBatchId,
    stepNumber: 4,
    materialId: source.materialId,
    observedAt: 1000,
    reference: "Independent actual Cutting observation",
    actualLengthMm: 150,
    allocations: [
      {
        operationId: id(),
        receiptId: receipt.operationId,
        quantity: 150,
        expectedRevision: 1,
      },
    ],
    reason: "Measured length processed",
    evidence: "Physical independent length record",
  };
  return { source, request };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await inventoryOutbox.receivingDrafts.clear();
  await db.users.put({
    id: actor,
    login: actor,
    fullName: "Synthetic operator",
    role: UserRole.WORKER,
    isActive: true,
    password: "test-only",
    createdAt: new Date(),
  });
  vi.mocked(loadInventoryIssueContext).mockResolvedValue({
    organizationId: scope.organizationId,
    actorId: scope.actorId,
    deviceId: scope.deviceId,
    epoch,
    postingEnabled: true,
  } as never);
});
afterEach(() => vi.restoreAllMocks());
it("keeps exact length units and independently measured source capacity, without treating roll count as length", () => {
  const f = fixture();
  expect(measuredCuttingMm("0.250")).toBe(250);
  for (const v of ["", "0", "0.0001", "-1"])
    expect(() => measuredCuttingMm(v)).toThrow();
  expect(() =>
    copyCuttingRollSource({ ...f.source, received: 1, remaining: 1 }),
  ).toThrow();
  expect(() =>
    copyCuttingRollSource({
      ...f.source,
      capacityBasis: "guessed_roll_length",
    }),
  ).toThrow();
  expect(() =>
    copyCuttingRequest({ ...f.request, actualLengthMm: 251 }),
  ).toThrow();
});
it("preserves original offline intent, reopens and retries identical bytes after a lost committed reply", async () => {
  const f = fixture(),
    row = await freezeCuttingConsumption(scope, actor, epoch, f.request, [
      f.source,
    ]);
  inventoryOutbox.close();
  await inventoryOutbox.open();
  const ack = {
    ...f.request,
    room: "cutting",
    unit: "mm",
    actorId: scope.actorId,
    recordedAt: at,
    warehouseEffect: "none",
    sources: [
      {
        allocationOperationId: f.request.allocations[0].operationId,
        source: {
          receipt: f.source.receipt,
          received: 240,
          consumed: 0,
          remaining: 240,
          revision: 1,
          capacityBasis: "calendered_measured_roll_length",
        },
      },
    ],
  };
  vi.mocked(inventoryRequest)
    .mockRejectedValueOnce(Error("Lost committed reply"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "duplicate",
          operationId: f.request.operationId,
          consumption: ack,
        }),
        { status: 200 },
      ),
    );
  await expect(
    sendCuttingConsumption({} as never, scope, actor, row.key),
  ).rejects.toThrow("Lost");
  expect(
    (await cuttingConsumptionProposals(scope, actor))[0].fields.state,
  ).toBe("pending");
  await sendCuttingConsumption({} as never, scope, actor, row.key);
  expect(vi.mocked(inventoryRequest).mock.calls.map((c) => c[3]?.body)).toEqual(
    [row.fields.request, row.fields.request],
  );
  expect(
    (await cuttingConsumptionProposals(scope, actor))[0].fields.state,
  ).toBe("accepted");
});

it("retains overlap holds and refuses history changes, forged replies and late acknowledgement overwrites", async () => {
  const f = fixture(),
    row = await freezeCuttingConsumption(scope, actor, epoch, f.request, [
      f.source,
    ]);
  await expect(
    freezeCuttingConsumption(
      scope,
      actor,
      epoch,
      {
        ...f.request,
        operationId: id(),
        allocations: [{ ...f.request.allocations[0], operationId: id() }],
      },
      [f.source],
    ),
  ).rejects.toThrow("Источник удержан");
  vi.mocked(loadInventoryIssueContext).mockResolvedValueOnce({
    epoch: id(),
    postingEnabled: true,
  } as never);
  await expect(
    sendCuttingConsumption({} as never, scope, actor, row.key),
  ).rejects.toThrow("История");
  expect(inventoryRequest).not.toHaveBeenCalled();
  const ack = {
    ...f.request,
    room: "cutting",
    unit: "mm",
    actorId: scope.actorId,
    recordedAt: at,
    warehouseEffect: "none",
    sources: [
      {
        allocationOperationId: f.request.allocations[0].operationId,
        source: {
          receipt: f.source.receipt,
          received: 240,
          consumed: 0,
          remaining: 240,
          revision: 1,
          capacityBasis: "calendered_measured_roll_length",
        },
      },
    ],
  };
  vi.mocked(inventoryRequest).mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        status: "confirmed",
        operationId: f.request.operationId,
        consumption: { ...ack, warehouseEffect: "receive" },
      }),
      { status: 201 },
    ),
  );
  await expect(
    sendCuttingConsumption({} as never, scope, actor, row.key),
  ).rejects.toThrow();
  expect(
    (await inventoryOutbox.receivingDrafts.get(row.key))!.fields.state,
  ).toBe("pending");
  let release!: (r: Response) => void;
  vi.mocked(inventoryRequest).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const sending = sendCuttingConsumption(
    {} as never,
    scope,
    actor,
    row.key,
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await inventoryOutbox.receivingDrafts.put({
    ...row,
    revision: row.revision + 1,
    fields: { ...row.fields, state: "conflict" },
  });
  release(
    new Response(
      JSON.stringify({
        status: "duplicate",
        operationId: f.request.operationId,
        consumption: ack,
      }),
      { status: 200 },
    ),
  );
  await expect(sending).rejects.toThrow("Исходное");
  expect(
    (await inventoryOutbox.receivingDrafts.get(row.key))!.fields.state,
  ).toBe("conflict");
});
