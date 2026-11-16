import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createCoatingRollFixture } from "./coating-roll-test-fixture.js";
export async function createCalendaringFixture(searchPath?: string) {
  const f = await createCoatingRollFixture(searchPath);
  async function receivedRolls(count = 1) {
    const inputs = await f.inputs(),
      declaration = f.declaration(inputs);
    declaration.outputs = Array.from({ length: count }, (_, i) => ({
      ...declaration.outputs[0],
      id: randomUUID(),
      label: "SYNTHETIC-CALENDAR-" + i,
    }));
    const output = await f.post("/inventory/coating-rolls", declaration, 5);
    expect(output.statusCode, output.body).toBe(201);
    const receipts = [];
    for (const roll of declaration.outputs) {
      const offer = {
        operationId: randomUUID(),
        deviceId: f.actors[5].device,
        outputLotId: roll.id,
        quantity: 1,
        expectedSourceRevision: 1,
        recipientId: f.actors[6].id,
        destinationStepNumber: 3,
        reason: "Actual identified roll transfer",
        evidence: "Synthetic label",
      };
      const sent = await f.post("/inventory/coating-rolls/handoffs", offer, 5);
      expect(sent.statusCode, sent.body).toBe(201);
      const receipt = await f.post(
        "/inventory/coating-rolls/acknowledgements",
        {
          operationId: randomUUID(),
          deviceId: f.actors[6].device,
          handoffId: offer.operationId,
          kind: "receive",
          observedQuantity: 1,
          observedRollLabel: roll.label,
          observedLengthMm: null,
          measurementNote:
            "Count and identity checked; source length not independently remeasured",
          reason: "Assigned physical receipt",
          evidence: "Synthetic receiver observation",
        },
        6,
      );
      expect(receipt.statusCode, receipt.body).toBe(201);
      receipts.push(receipt.json().receipt);
    }
    return { inputs, declaration: output.json().declaration, receipts };
  }
  function consumption(
    source: Awaited<ReturnType<typeof receivedRolls>>,
    quantities = [250],
    actor = 6,
  ) {
    return {
      operationId: randomUUID(),
      deviceId: f.actors[actor].device,
      productionBatchId: f.batch,
      stepNumber: 3,
      materialId: source.inputs.materialId,
      observedAt: Date.now(),
      reference: "Synthetic actual Calendaring pass C-1",
      actualLengthMm: quantities.reduce((a, b) => a + b, 0),
      allocations: quantities.map((quantity, i) => ({
        operationId: randomUUID(),
        receiptId: source.receipts[i].operationId,
        quantity,
        expectedRevision: 1,
      })),
      reason: "Actual independently observed length processed",
      evidence: "Synthetic independent length measurement",
    };
  }
  return { ...f, receivedRolls, consumption };
}
