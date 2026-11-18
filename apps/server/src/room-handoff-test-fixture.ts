import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
export async function createRoomHandoffFixture(searchPath?: string, withCalendaring=false,withCutting=false,withSorting=false) {
  const f = await createInventoryHandoffFixture(searchPath, true, withCalendaring, withCutting, withSorting);
  async function consumed() {
    const {id: stockId, issue} = await f.reserved(1000);
    for (const [kind, rev, actor, extra] of [
      ['approve', 2, 1, {expectedStockRevision: 3}],
      ['dispatch', 3, 1, {expectedStockRevision: 3}],
      ['receive', 4, 4, {}],
    ] as const)
      expect((await f.act(issue.id, f.operation(kind, rev, actor, extra), actor)).statusCode).toBe(201);
    const request = {
      operationId: randomUUID(),
      deviceId: f.actors[4].device,
      productionBatchId: f.batch,
      stepNumber: 1,
      source: {
        id: randomUUID(),
        recordedAt: Date.now() + 0.5,
        recordedBy: 'synthetic-local-author',
        recordedRole: 'worker',
        batchCode: 'SYNTHETIC-MIX',
        recipeId: null,
        recipeRevision: null,
        recipeName: 'Explicit weighed mixture',
        measurementNote: 'Scale observation',
        components: [{componentId: 'component', componentVersion: 1, actualMg: 1000}],
      },
      allocations: [
        {
          operationId: randomUUID(),
          issueId: issue.id,
          materialId: f.material,
          componentId: 'component',
          quantity: 1000,
          expectedSettlementRevision: 1,
        },
      ],
      reason: 'Actual measured input',
      evidence: 'Synthetic source mapping',
    };
    const r = await f.post('/inventory/room-materials/slurry/consumptions', request, 4);
    expect(r.statusCode, r.body).toBe(201);
    return {stockId, consumption: r.json().consumption};
  }
  async function receivedSlurry() {
    const {stockId, consumption} = await consumed();
    const output = {
      operationId: randomUUID(),
      deviceId: f.actors[4].device,
      consumptionId: consumption.operationId,
      outputs: [{id: randomUUID(), materialId: f.material, quantity: 900}],
      scrapMg: 0,
      measuredLossMg: 50,
      unknownMg: 50,
      basis: 'weighed-slurry-mass',
      specificationReference: 'Synthetic approved product card',
      observedAt: Date.now(),
      reason: 'Independent output weighing',
      evidence: 'Synthetic net output observation',
    };
    const declared = await f.post('/inventory/room-outputs/slurry', output, 4);
    expect(declared.statusCode, declared.body).toBe(201);
    const offer = {
      operationId: randomUUID(),
      deviceId: f.actors[4].device,
      outputLotId: output.outputs[0].id,
      quantity: 400,
      expectedSourceRevision: 1,
      recipientId: f.actors[5].id,
      destinationStepNumber: 2,
      reason: 'Explicit actual transfer',
      evidence: 'Synthetic transfer container',
    };
    expect((await f.post('/inventory/room-handoffs', offer, 4)).statusCode).toBe(201);
    const receiptRequest = {
      operationId: randomUUID(),
      deviceId: f.actors[5].device,
      handoffId: offer.operationId,
      kind: 'receive',
      observedQuantity: 400,
      reason: 'Independent exact receipt',
      evidence: 'Synthetic Coating scale',
    };
    const accepted = await f.post('/inventory/room-handoffs/acknowledgements', receiptRequest, 5);
    expect(accepted.statusCode, accepted.body).toBe(201);
    return {stockId, consumption, output, offer, receiptRequest, receipt: accepted.json().receipt};
  }
  return {...f, consumed, receivedSlurry};
}
