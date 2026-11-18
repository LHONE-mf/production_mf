import { it, expect } from "vitest";
import { copyRollRequest, copyRollReceiptRequest } from "./coatedRollTypes";
const id = () => crypto.randomUUID();
it("keeps a physical roll count separate from independently measured length/mass and explicit unknown accounting", () => {
  const request = {
    operationId: id(),
    deviceId: id(),
    productionBatchId: id(),
    stepNumber: 2,
    slurryConsumptionIds: [id()],
    foilConsumptionIds: [id()],
    outputs: [
      {
        id: id(),
        materialId: id(),
        label: "Physical roll label",
        measuredLengthMm: 400,
        measuredMassMg: null,
        disposition: "ready",
      },
    ],
    tape: { status: "not_applicable", note: "Explicit card decision" },
    scrapLengthMm: null,
    scrapMassMg: 0,
    accountingNote: "Unknown loss remains unmeasured",
    observedAt: 1000.5,
    specificationReference: "Explicit output card",
    reference: "Actual operation",
    reason: "Observed roll",
    evidence: "Independent measurement",
  };
  expect(copyRollRequest(request)).toEqual(request);
  for (const patch of [
    { slurryConsumptionIds: [] },
    {
      slurryConsumptionIds: [
        ...request.slurryConsumptionIds,
        ...request.slurryConsumptionIds,
      ],
    },
    { outputs: [{ ...request.outputs[0], measuredLengthMm: 0.5 }] },
    { outputs: [{ ...request.outputs[0], measuredMassMg: 0 }] },
    { tape: { status: "unmeasured", issueIds: [], note: "Unknown" } },
    { scrapMassMg: undefined },
  ])
    expect(() => copyRollRequest({ ...request, ...patch })).toThrow();
});
it("requires whole physical receipt and explicit roll identity while preserving unknown remeasurement", () => {
  const receipt = {
    operationId: id(),
    deviceId: id(),
    handoffId: id(),
    kind: "receive",
    observedQuantity: 1,
    observedRollLabel: "Physical roll label",
    observedLengthMm: null,
    measurementNote: "Not remeasured; identity/count verified",
    reason: "Actual receipt",
    evidence: "Physical label",
  };
  expect(copyRollReceiptRequest(receipt)).toEqual(receipt);
  for (const patch of [
    { observedQuantity: 0.5 },
    { observedRollLabel: null },
    { observedLengthMm: 0 },
    { measurementNote: "" },
  ])
    expect(() => copyRollReceiptRequest({ ...receipt, ...patch })).toThrow();
  expect(
    copyRollReceiptRequest({
      ...receipt,
      kind: "discrepancy",
      observedQuantity: 0,
      observedRollLabel: null,
    }),
  ).toMatchObject({ observedQuantity: 0, observedRollLabel: null });
});
