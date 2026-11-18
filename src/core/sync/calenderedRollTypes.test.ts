import { it, expect } from "vitest";
import { calenderedRollTestData } from "./calenderedTestFixture";
import {
  copyCalenderedRequest,
  copyCalenderedDeclaration,
  copyCalenderedReceipt,
} from "./calenderedRollTypes";
const id = () => crypto.randomUUID(),
  scope = {
    serverUrl: "https://factory.test",
    organizationId: id(),
    actorId: id(),
    deviceId: id(),
  };
it("retains independently measured physical output and null unknowns without certifying input/output equality or QA", () => {
  const f = calenderedRollTestData(scope);
  expect(f.declaration.sources[0].actualLengthMm).toBe(250);
  expect(f.declaration.outputs[0]).toMatchObject({
    measuredLengthMm: 240,
    measuredMassMg: null,
  });
  expect(f.declaration.scrapLengthMm).toBeNull();
  if (f.command.kind !== "output") throw Error("Output fixture required");
  expect(
    copyCalenderedRequest({ ...f.command.request, scrapLengthMm: 0 }),
  ).toMatchObject({ scrapLengthMm: 0, scrapMassMg: null });
});
it("rejects fractional length, forged accounting status, broken genealogy and wrong physical receipt identity", () => {
  const f = calenderedRollTestData(scope);
  if (f.command.kind !== "output") throw Error("Output fixture required");
  const r = f.command.request;
  expect(() =>
    copyCalenderedRequest({
      ...r,
      outputs: [{ ...r.outputs[0], measuredLengthMm: 0.5 }],
    }),
  ).toThrow();
  expect(() =>
    copyCalenderedDeclaration({
      ...f.declaration,
      materialAccountingStatus: "reconciled",
    }),
  ).toThrow();
  expect(() =>
    copyCalenderedDeclaration({ ...f.declaration, sources: [] }),
  ).toThrow();
  expect(() =>
    copyCalenderedReceipt({
      ...f.receipt.request,
      observedRollLabel: "OTHER",
      sourceSnapshot: f.handoff,
      actorId: scope.actorId,
      recordedAt: new Date().toISOString(),
      custodyEffect: "received",
      unit: "rolls",
      warehouseEffect: "none",
    }),
  ).toThrow();
});
