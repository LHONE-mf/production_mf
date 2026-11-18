import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createCoatingFoilFixture } from "./coating-foil-test-fixture.js";
export async function createCoatingRollFixture(searchPath?: string, withCutting=false,withSorting=false) {
  const f = await createCoatingFoilFixture(searchPath, true, withCutting,withSorting);
  async function inputs() {
    const slurry = await f.receivedSlurry(),
      foil = await f.received();
    const slurryUse = {
      operationId: randomUUID(),
      deviceId: f.actors[5].device,
      productionBatchId: f.batch,
      stepNumber: 2,
      observedAt: Date.now(),
      reference: "Synthetic Coating run C-4",
      actualMg: 300,
      allocations: [
        {
          operationId: randomUUID(),
          receiptId: slurry.receipt.operationId,
          quantity: 300,
          expectedRevision: 1,
        },
      ],
      reason: "Independent actual Slurry use",
      evidence: "Synthetic scale observation",
    };
    const s = await f.post(
      "/inventory/room-materials/coating/consumptions",
      slurryUse,
      5,
    );
    expect(s.statusCode, s.body).toBe(201);
    const foilUse = f.consumption(foil, 500),
      p = await f.post(
        "/inventory/room-materials/coating/foil-consumptions",
        foilUse,
        5,
      );
    expect(p.statusCode, p.body).toBe(201);
    const materialId = randomUUID();
    expect(
      (
        await f.post("/inventory/materials", {
          id: materialId,
          deviceId: f.actors[0].device,
          code: "COATED-" + materialId,
          name: "Synthetic explicitly specified coated electrode roll",
          category: "electrode",
          baseUnit: "rolls",
        })
      ).statusCode,
    ).toBe(201);
    return {
      slurry,
      foil,
      slurryConsumption: s.json().consumption,
      foilConsumption: p.json().consumption,
      materialId,
    };
  }
  const declaration = (i: Awaited<ReturnType<typeof inputs>>) => ({
    operationId: randomUUID(),
    deviceId: f.actors[5].device,
    productionBatchId: f.batch,
    stepNumber: 2,
    slurryConsumptionIds: [i.slurryConsumption.operationId],
    foilConsumptionIds: [i.foilConsumption.operationId],
    outputs: [
      {
        id: randomUUID(),
        materialId: i.materialId,
        label: "SYNTHETIC-PHYSICAL-ROLL",
        measuredLengthMm: 400,
        measuredMassMg: null,
        disposition: "ready",
      },
    ],
    tape: {
      status: "not_applicable",
      note: "Synthetic card explicitly does not require tape for this observation",
    },
    scrapLengthMm: null,
    scrapMassMg: null,
    accountingNote:
      "Losses and incorporation are not measured; input totals retain their own units",
    observedAt: Date.now(),
    specificationReference: "Synthetic coated electrode specification",
    reference: "Synthetic measured Coating run C-4",
    reason: "Actual physically identified coated roll",
    evidence: "Independent output length observation",
  });
  return { ...f, inputs, declaration };
}
