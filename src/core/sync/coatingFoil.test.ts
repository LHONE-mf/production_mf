import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "../db";
import { UserRole } from "../types";
import { inventoryOutbox } from "./inventoryOutbox";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import {
  copyFoilRequest,
  copyFoilSource,
  freezeFoilConsumption,
  sendFoilConsumption,
  foilProposals,
} from "./coatingFoil";
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
  epoch = id(),
  actor = "foil-worker";
function source() {
  return {
    room: "coating",
    materialName: "Synthetic collector foil",
    materialCode: "FOIL",
    batchCode: "BATCH",
    eligible: true,
    issue: {
      id: id(),
      materialId: id(),
      productionBatchId: id(),
      stepNumber: 2,
      workshopId: "coating",
      recipientId: scope.actorId,
      requestedBy: scope.actorId,
      quantity: 800,
      unit: "mm",
      state: "received",
      revision: 5,
      stockId: id(),
      source: null as any,
      approvalOperationId: id(),
      approvedStockRevision: 3,
      approvedBy: id(),
      approvedDeviceId: id(),
      dispatchOperationId: id(),
      receiptOperationId: id(),
    },
    settlement: {
      revision: 1,
      issued: 800,
      consumed: 0,
      returned: 0,
      scrapped: 0,
      outstanding: 800,
    },
  };
}
function fixture() {
  const s = source();
  s.issue.source = {
    stockId: s.issue.stockId,
    materialId: s.issue.materialId,
    manufacturerLot: "LOT",
    locationId: id(),
    unit: "mm",
    quality: "released",
  };
  const request = {
    operationId: id(),
    deviceId: scope.deviceId,
    productionBatchId: s.issue.productionBatchId,
    stepNumber: 2,
    materialId: s.issue.materialId,
    unit: "mm" as const,
    observedAt: 1000.5,
    reference: "Actual card",
    specificationReference: "Explicit collector specification",
    actualQuantity: 500,
    allocations: [
      {
        operationId: id(),
        issueId: s.issue.id,
        quantity: 500,
        expectedSettlementRevision: 1,
      },
    ],
    reason: "Actual measurement",
    evidence: "Independent length observation",
  };
  return { s: copyFoilSource(s), request };
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
    warehouseLevel: null,
    postingEnabled: true,
  });
});
afterEach(async () => {
  vi.resetAllMocks();
  db.close();
  await db.delete();
  inventoryOutbox.close();
  await inventoryOutbox.delete();
});
it("requires one explicit SKU and exact observed total, preserving source units and rejecting implicit conversion", () => {
  const { s, request } = fixture();
  expect(copyFoilRequest(request)).toEqual(request);
  expect(copyFoilSource(s).issue.unit).toBe("mm");
  for (const patch of [
    { unit: "rolls" },
    { actualQuantity: 0.5 },
    { actualQuantity: 501 },
    { specificationReference: "" },
    { allocations: [...request.allocations, ...request.allocations] },
  ])
    expect(() => copyFoilRequest({ ...request, ...patch })).toThrow();
  expect(() =>
    copyFoilSource({ ...s, issue: { ...s.issue, unit: "rolls" } }),
  ).toThrow();
});
it("saves offline, reopens and retries identical original bytes after a lost reply without accepting altered source or measurement", async () => {
  const { s, request } = fixture(),
    row = await freezeFoilConsumption(scope, actor, epoch, request, [s]);
  inventoryOutbox.close();
  await inventoryOutbox.open();
  expect((await foilProposals(scope, actor))[0]).toEqual(row);
  let mode = "lost";
  const bodies: string[] = [];
  vi.mocked(inventoryRequest).mockImplementation(
    async (_session, _scope, _path, init) => {
      bodies.push(String(init?.body));
      if (mode === "lost") throw Error("Lost committed reply");
      const consumption = {
        ...request,
        room: "coating",
        actorId: scope.actorId,
        recordedAt: new Date().toISOString(),
        warehouseEffect: "none",
        sources: [{ issue: s.issue, settlement: s.settlement }],
      };
      return new Response(
        JSON.stringify({
          status: "duplicate",
          operationId: request.operationId,
          consumption:
            mode === "forged"
              ? { ...consumption, actualQuantity: 501 }
              : consumption,
        }),
        { status: 200 },
      );
    },
  );
  await expect(
    sendFoilConsumption({} as any, scope, actor, row.key),
  ).rejects.toThrow("Lost");
  mode = "forged";
  await expect(
    sendFoilConsumption({} as any, scope, actor, row.key),
  ).rejects.toThrow();
  expect((await foilProposals(scope, actor))[0].fields.state).toBe("pending");
  mode = "ok";
  await sendFoilConsumption({} as any, scope, actor, row.key);
  expect(new Set(bodies).size).toBe(1);
  expect((await foilProposals(scope, actor))[0].fields.state).toBe("accepted");
  expect(await inventoryOutbox.stocks.count()).toBe(0);
});
it("holds overlapping local proposals and retains original evidence across epoch or local-author changes", async () => {
  const { s, request } = fixture(),
    row = await freezeFoilConsumption(scope, actor, epoch, request, [s]);
  await expect(
    freezeFoilConsumption(
      scope,
      actor,
      epoch,
      {
        ...request,
        operationId: id(),
        allocations: [{ ...request.allocations[0], operationId: id() }],
      },
      [s],
    ),
  ).rejects.toThrow();
  vi.mocked(loadInventoryIssueContext).mockResolvedValue({
    ...scope,
    epoch: id(),
    warehouseLevel: null,
    postingEnabled: true,
  });
  await expect(
    sendFoilConsumption({} as any, scope, actor, row.key),
  ).rejects.toThrow();
  expect(inventoryRequest).not.toHaveBeenCalled();
  await db.users.update(actor, { role: UserRole.MASTER });
  await expect(
    sendFoilConsumption({} as any, scope, actor, row.key),
  ).rejects.toThrow();
  expect((await foilProposals(scope, actor))[0].fields.request).toBe(
    row.fields.request,
  );
});

it("does not let a late valid acknowledgement overwrite a newer local conflict", async () => {
  const { s, request } = fixture(),
    row = await freezeFoilConsumption(scope, actor, epoch, request, [s]);
  let finish!: (r: Response) => void;
  vi.mocked(inventoryRequest).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = sendFoilConsumption({} as any, scope, actor, row.key),
    rejected = expect(sending).rejects.toThrow("изменилось");
  await vi.waitFor(() => expect(inventoryRequest).toHaveBeenCalledOnce());
  await inventoryOutbox.receivingDrafts.update(row.key, {
    fields: { ...row.fields, state: "conflict" },
  });
  finish(
    new Response(
      JSON.stringify({
        status: "confirmed",
        operationId: request.operationId,
        consumption: {
          ...request,
          room: "coating",
          actorId: scope.actorId,
          recordedAt: new Date().toISOString(),
          warehouseEffect: "none",
          sources: [{ issue: s.issue, settlement: s.settlement }],
        },
      }),
      { status: 201 },
    ),
  );
  await rejected;
  expect((await foilProposals(scope, actor))[0].fields).toEqual({
    ...row.fields,
    state: "conflict",
  });
});
