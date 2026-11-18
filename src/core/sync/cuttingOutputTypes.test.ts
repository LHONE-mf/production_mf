import { it, expect } from "vitest";
import { cuttingOutputTestData } from "./cuttingOutputTestFixture";
import {
  copyCutOutputRequest,
  copyCutOutputLot,
  copyCutOutputReceipt,
  copyCutOutputReceiptRequest,
  copyCutOutputHandoff,
  copyCutOutputHandoffRead,
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

it("rejects non-string disposition values rather than coercing untrusted data", () => {
  const f = cuttingOutputTestData(scope);
  if (f.command.kind !== "output") throw Error("Output required");
  const request = f.command.request;
  const lot = request.outputs[0];
  for (const malformed of [["ready"], ["held"], null, 0, {}]) {
    expect(() =>
      copyCutOutputRequest({
        ...request,
        outputs: [{ ...lot, disposition: malformed }],
      }),
    ).toThrow();
  }
  for (const disposition of ["ready", "held"] as const) {
    expect(
      copyCutOutputRequest({
        ...request,
        outputs: [{ ...lot, disposition }],
      }).outputs[0].disposition,
    ).toBe(disposition);
  }
});

it("rejects non-string receipt kinds even when their string representation looks valid", () => {
  const f = cuttingOutputTestData(scope);
  if (f.receipt.kind !== "receipt") throw Error("Receipt required");
  const request = f.receipt.request;
  for (const malformed of [["receive"], ["discrepancy"], null, 0, {}]) {
    expect(() =>
      copyCutOutputReceiptRequest({ ...request, kind: malformed }),
    ).toThrow();
  }
  expect(copyCutOutputReceiptRequest(request).kind).toBe("receive");
  expect(
    copyCutOutputReceiptRequest({
      ...request,
      kind: "discrepancy",
      observedQuantity: null,
      observedLotLabel: null,
    }).kind,
  ).toBe("discrepancy");

  // A malformed kind must not be silently accepted as a non-receiving event.
  expect(() =>
    copyCutOutputReceipt({
      ...request,
      kind: ["receive"],
      sourceSnapshot: f.handoff,
      actorId: scope.actorId,
      recordedAt: new Date().toISOString(),
      custodyEffect: "none",
      warehouseEffect: "none",
    }),
  ).toThrow();
});

it("rejects contradictory handoff ancestry referring to a held lot", () => {
  const f = cuttingOutputTestData(scope);
  const original = f.handoff.sourceSnapshot;
  const held = { ...original.lot, disposition: "held" as const };
  const snapshot = {
    ...original,
    lot: held,
    declaration: {
      ...original.declaration,
      outputs: original.declaration.outputs.map((lot) =>
        lot.id === held.id ? held : lot,
      ),
    },
  };
  // Both nested copies agree, but they cannot describe a valid handoff.
  const malformed = { ...f.handoff, sourceSnapshot: snapshot };
  expect(copyCutOutputHandoff(f.handoff)).toEqual(f.handoff);
  expect(() => copyCutOutputHandoff(malformed)).toThrow();
  expect(() =>
    copyCutOutputHandoffRead({
      operationId: malformed.operationId,
      handoff: malformed,
      eligible: false,
      received: null,
      eventCount: 0,
    }),
  ).toThrow();
  if (f.receipt.kind !== "receipt") throw Error("Receipt required");
  expect(() =>
    copyCutOutputReceipt({
      ...f.receipt.request,
      sourceSnapshot: malformed,
      actorId: scope.actorId,
      recordedAt: new Date().toISOString(),
      custodyEffect: "received",
      warehouseEffect: "none",
    }),
  ).toThrow();
});

it("distinguishes a validated historical receipt from an outstanding or disputed record", () => {
  const f = cuttingOutputTestData(scope);
  if (f.receipt.kind !== "receipt") throw Error("Receipt required");
  const row = {
    operationId: f.handoff.operationId,
    handoff: f.handoff,
    eligible: true,
    received: null,
    eventCount: 0,
  };
  expect(copyCutOutputHandoffRead(row).received).toBeNull();
  const receipt = {
    ...f.receipt.request,
    sourceSnapshot: f.handoff,
    actorId: scope.actorId,
    recordedAt: new Date().toISOString(),
    custodyEffect: "received",
    warehouseEffect: "none",
  };
  // Historical receipt remains valid when current eligibility changes.
  for (const eligible of [true, false]) {
    const history = copyCutOutputHandoffRead({
      ...row,
      eligible,
      received: receipt,
      eventCount: 1,
    });
    expect(history.received).toEqual(receipt);
    expect(history.eligible).toBe(eligible);
    if (!history.received) throw Error("Confirmed receipt required");
    const count: number = history.received.observedQuantity;
    const label: string = history.received.observedLotLabel;
    expect(count).toBe(f.handoff.quantity);
    expect(label).toBe(f.handoff.sourceSnapshot.lot.label);
  }

  const discrepancy = {
    ...receipt,
    kind: "discrepancy",
    custodyEffect: "none",
    observedQuantity: null,
    observedLotLabel: null,
  };
  expect(copyCutOutputReceipt(discrepancy).custodyEffect).toBe("none");
  expect(() =>
    copyCutOutputHandoffRead({
      ...row,
      received: discrepancy,
      eventCount: 1,
    }),
  ).toThrow();
  expect(() =>
    copyCutOutputHandoffRead({ ...row, received: receipt }),
  ).toThrow();
  expect(() =>
    copyCutOutputHandoffRead({
      ...row,
      received: { ...receipt, handoffId: id() },
      eventCount: 1,
    }),
  ).toThrow();
});
