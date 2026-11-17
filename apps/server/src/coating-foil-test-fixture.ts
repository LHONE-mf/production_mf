import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createRoomHandoffFixture } from "./room-handoff-test-fixture.js";
export async function createCoatingFoilFixture(searchPath?: string, withCalendaring=false,withCutting=false) {
  const f = await createRoomHandoffFixture(searchPath, withCalendaring, withCutting);
  async function received(unit = "mm", materialId?: string) {
    materialId ??= randomUUID();
    if (
      !(
        await f.pool.query("SELECT 1 FROM inventory_materials WHERE id=$1", [
          materialId,
        ])
      ).rowCount
    )
      expect(
        (
          await f.post("/inventory/materials", {
            id: materialId,
            deviceId: f.actors[0].device,
            code: "FOIL-" + materialId,
            name: "Synthetic explicitly selected collector foil",
            category: "raw_material",
            baseUnit: unit,
          })
        ).statusCode,
      ).toBe(201);
    const stockId = randomUUID();
    const receipt = {
      operationId: randomUUID(),
      stockId,
      deviceId: f.actors[2].device,
      materialId,
      locationId: f.location,
      manufacturerLot: "SYNTHETIC-FOIL-" + stockId,
      quantity: 1000,
      expectedRevision: 0,
      reason: "Independent measured collector receipt",
    };
    expect((await f.post("/inventory/receipts", receipt, 2)).statusCode).toBe(
      201,
    );
    expect(
      (
        await f.post(`/inventory/stocks/${stockId}/quality-dispositions`, {
          operationId: randomUUID(),
          stockId,
          deviceId: f.actors[0].device,
          expectedRevision: 1,
          disposition: "release",
          reason: "Chief review",
          evidence: "Synthetic supplier certificate",
        })
      ).statusCode,
    ).toBe(201);
    const request = {
      operationId: randomUUID(),
      issueId: randomUUID(),
      deviceId: f.actors[5].device,
      materialId,
      productionBatchId: f.batch,
      stepNumber: 2,
      recipientId: f.actors[5].id,
      quantity: 800,
      reason: "Explicit collector foil requirement",
      evidence: "Synthetic Coating specification",
    };
    expect((await f.post("/inventory/issues", request, 5)).statusCode).toBe(
      201,
    );
    let issue;
    for (const [kind, revision, actor, extra] of [
      ["reserve", 1, 1, { stockId, expectedStockRevision: 2 }],
      ["approve", 2, 1, { expectedStockRevision: 3 }],
      ["dispatch", 3, 1, { expectedStockRevision: 3 }],
      ["receive", 4, 5, {}],
    ] as const) {
      const r = await f.act(
        request.issueId,
        f.operation(kind, revision, actor, extra),
        actor,
      );
      expect(r.statusCode, r.body).toBe(201);
      issue = r.json().issue;
    }
    return { stockId, materialId, issue };
  }
  const consumption = (
    source: Awaited<ReturnType<typeof received>>,
    quantity = 500,
  ) => ({
    operationId: randomUUID(),
    deviceId: f.actors[5].device,
    productionBatchId: f.batch,
    stepNumber: 2,
    materialId: source.materialId,
    unit: source.issue.unit,
    observedAt: Date.now(),
    reference: "Synthetic Coating card C-2",
    specificationReference:
      "Synthetic explicit collector material specification",
    actualQuantity: quantity,
    allocations: [
      {
        operationId: randomUUID(),
        issueId: source.issue.id,
        quantity,
        expectedSettlementRevision: 1,
      },
    ],
    reason: "Actual independently measured foil use",
    evidence: "Measured in the issued unit, without roll conversion",
  });
  return { ...f, received, consumption };
}
