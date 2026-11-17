import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { db } from "../db";
import { UserRole } from "../types";
import { inventoryOutbox } from "./inventoryOutbox";
import { inventoryRequest } from "./inventoryClient";
import { loadInventoryIssueContext } from "./inventoryIssueClient";
import { cuttingOutputTestData } from "./cuttingOutputTestFixture";
import {
  freezeCutOutputCommand,
  sendCutOutputCommand,
  cutOutputProposals,
  type CutOutputCommand,
} from "./cuttingOutputs";
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
const fixture = () => cuttingOutputTestData(scope, at);
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
        unit: "pieces",
        warehouseEffect: "none",
      },
    ],
  ] as const) {
    const row = await freezeCutOutputCommand(scope, actor, epoch, command);
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
      sendCutOutputCommand({} as never, scope, actor, row.key),
    ).rejects.toThrow("Lost");
    await sendCutOutputCommand({} as never, scope, actor, row.key);
    const calls = vi.mocked(inventoryRequest).mock.calls.slice(-2);
    expect(calls[0][3]?.body).toBe(row.fields.request);
    expect(calls[1][3]?.body).toBe(row.fields.request);
    expect(
      (await cutOutputProposals(scope, actor)).find((r) => r.key === row.key)
        ?.fields.state,
    ).toBe("accepted");
  }
  expect(await inventoryOutbox.stocks.count()).toBe(0);
});
it("holds duplicate input attribution, changed history and forged acknowledgements", async () => {
  const f = fixture(),
    row = await freezeCutOutputCommand(scope, actor, epoch, f.command);
  await expect(
    freezeCutOutputCommand(scope, actor, epoch, {
      ...f.command,
      request: { ...f.command.request, operationId: id() },
    } as CutOutputCommand),
  ).rejects.toThrow("удержан");
  vi.mocked(loadInventoryIssueContext).mockResolvedValueOnce({
    ...scope,
    epoch: id(),
    postingEnabled: true,
    warehouseLevel: null,
  });
  await expect(
    sendCutOutputCommand({} as never, scope, actor, row.key),
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
    sendCutOutputCommand({} as never, scope, actor, row.key),
  ).rejects.toThrow();
  expect((await cutOutputProposals(scope, actor))[0].fields.state).toBe(
    "pending",
  );
});
it("never lets a late valid receipt replace a newer local conflict", async () => {
  const f = fixture(),
    row = await freezeCutOutputCommand(scope, actor, epoch, f.receipt);
  let finish!: (r: Response) => void;
  vi.mocked(inventoryRequest).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = sendCutOutputCommand({} as never, scope, actor, row.key),
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
          unit: "pieces",
          warehouseEffect: "none",
        },
      }),
      { status: 201 },
    ),
  );
  await rejected;
  expect((await cutOutputProposals(scope, actor))[0].fields.state).toBe(
    "conflict",
  );
});
