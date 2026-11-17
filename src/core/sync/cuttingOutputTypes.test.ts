import { it, expect } from "vitest";
import { cuttingOutputTestData } from "./cuttingOutputTestFixture";
import {
  copyCutOutputRequest,
  copyCutOutputLot,
  copyCutOutputReceipt,
} from "./cuttingOutputTypes";
const id = () => crypto.randomUUID(),
  scope = {
    serverUrl: "https://factory.test",
    organizationId: id(),
    actorId: id(),
    deviceId: id(),
  };
it("keeps independently counted pieces and unknown rejects separate from measured input length", () => {
  const f = cuttingOutputTestData(scope);
  expect(f.declaration.sources[0].actualLengthMm).toBe(150);
  expect(f.declaration.outputs[0].quantity).toBe(9);
  expect(f.declaration.rejectedPieces).toBeNull();
  if (f.command.kind !== "output") throw Error("Output required");
  expect(
    copyCutOutputRequest({ ...f.command.request, rejectedPieces: 0 }),
  ).toMatchObject({ rejectedPieces: 0, scrapLengthMm: null });
  expect(() =>
    copyCutOutputRequest({
      ...f.command.request,
      outputs: [{ ...f.command.request.outputs[0], quantity: 1.5 }],
    }),
  ).toThrow();
  expect(() =>
    copyCutOutputRequest({ ...f.command.request, unit: "mm" }),
  ).toThrow();
});
it("validates partial counted capacity and exact observed quantity/lot for the offered subset", () => {
  const f = cuttingOutputTestData(scope);
  if (f.offer.kind !== "offer") throw Error("Offer required");
  expect(
    copyCutOutputLot({
      ...f.offer.base.lot,
      reserved: 4,
      received: 4,
      remaining: 5,
      revision: 2,
    }),
  ).toMatchObject({ remaining: 5 });
  expect(() =>
    copyCutOutputLot({
      ...f.offer.base.lot,
      reserved: 4,
      remaining: 6,
      revision: 2,
    }),
  ).toThrow();
  const r = {
    ...f.receipt.request,
    sourceSnapshot: f.handoff,
    actorId: scope.actorId,
    recordedAt: new Date().toISOString(),
    custodyEffect: "received",
    unit: "pieces",
    warehouseEffect: "none",
  };
  expect(() => copyCutOutputReceipt({ ...r, observedQuantity: 9 })).toThrow();
  expect(() =>
    copyCutOutputReceipt({ ...r, observedLotLabel: "OTHER" }),
  ).toThrow();
});
