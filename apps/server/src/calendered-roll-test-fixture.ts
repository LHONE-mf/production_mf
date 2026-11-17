import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createCalendaringFixture } from "./calendaring-consumption-test-fixture.js";
export async function createCalenderedRollFixture(searchPath?: string) {
  const f = await createCalendaringFixture(searchPath, true);
  async function inputs() {
    const received = await f.receivedRolls(),
      body = f.consumption(received),
      use = await f.post(
        "/inventory/room-materials/calendaring/consumptions",
        body,
        6,
      );
    expect(use.statusCode, use.body).toBe(201);
    return {
      received,
      consumption: use.json().consumption,
      materialId: received.inputs.materialId,
    };
  }
  const declaration = (i: Awaited<ReturnType<typeof inputs>>) => ({
    operationId: randomUUID(),
    deviceId: f.actors[6].device,
    productionBatchId: f.batch,
    stepNumber: 3,
    consumptionIds: [i.consumption.operationId],
    outputs: [
      {
        id: randomUUID(),
        materialId: i.materialId,
        label: "SYNTHETIC-CALENDERED-ROLL",
        measuredLengthMm: 240,
        measuredMassMg: null,
        disposition: "ready",
      },
    ],
    scrapLengthMm: null,
    scrapMassMg: null,
    accountingNote:
      "Actual output measured independently; incorporation and losses remain unreconciled",
    observedAt: Date.now(),
    specificationReference:
      "Synthetic explicit calendered electrode specification",
    reference: "Synthetic actual calendered output C-2",
    reason: "Actual identified output roll",
    evidence: "Independent physical length measurement",
  });
  return { ...f, inputs, declaration };
}
