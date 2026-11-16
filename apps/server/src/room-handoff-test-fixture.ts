import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
export async function createRoomHandoffFixture(searchPath?: string) {
  const f = await createInventoryHandoffFixture(searchPath, true);
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
        recordedAt: Date.now(),
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
  return {...f, consumed};
}
