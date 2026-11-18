import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createCuttingFixture } from "./cutting-consumption-test-fixture.js";
export async function createCuttingOutputFixture(searchPath?: string) {
  const f = await createCuttingFixture(searchPath);
  async function inputs() {
    const received = await f.receivedRolls(),
      use = await f.post(
        "/inventory/room-materials/cutting/consumptions",
        f.consumption(received),
        7,
      );
    expect(use.statusCode, use.body).toBe(201);
    const materialId = randomUUID();
    expect(
      (
        await f.post("/inventory/materials", {
          id: materialId,
          deviceId: f.actors[0].device,
          code: "UNSORTED-" + materialId,
          name: "Synthetic explicitly specified unsorted electrodes",
          category: "electrode",
          baseUnit: "pieces",
        })
      ).statusCode,
    ).toBe(201);
    return { received, consumption: use.json().consumption, materialId };
  }
  const declaration = (i: Awaited<ReturnType<typeof inputs>>) => ({
    operationId: randomUUID(),
    deviceId: f.actors[7].device,
    productionBatchId: f.batch,
    stepNumber: 4,
    unit: "pieces",
    consumptionIds: [i.consumption.operationId],
    outputs: [
      {
        id: randomUUID(),
        materialId: i.materialId,
        label: "SYNTHETIC-UNSORTED-LOT",
        quantity: 9,
        disposition: "ready",
      },
    ],
    rejectedPieces: null,
    scrapLengthMm: null,
    scrapMassMg: null,
    accountingNote:
      "Actual unsorted pieces counted independently; rejects and losses remain unmeasured",
    observedAt: Date.now(),
    specificationReference: "Synthetic explicit cutting output card",
    reference: "Synthetic independent counted output",
    reason: "Actual counted unsorted output",
    evidence: "Separate physical count; no length-to-piece estimate",
  });
  return { ...f, inputs, declaration };
}
