import {randomUUID} from 'node:crypto';
import {beforeAll, afterAll, describe, it, expect} from 'vitest';
import {createRoomHandoffFixture} from './room-handoff-test-fixture.js';

describe.skipIf(!process.env.POSTGRES_TEST_URL)('Actual Coating use of received Slurry', () => {
  let f: Awaited<ReturnType<typeof createRoomHandoffFixture>>;
  beforeAll(async () => {
    f = await createRoomHandoffFixture();
  });
  afterAll(async () => {
    await f?.app.close();
    await f?.pool.end();
  });
  async function received() {
    const {stockId, consumption} = await f.consumed();
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
    const receipt = {
      operationId: randomUUID(),
      deviceId: f.actors[5].device,
      handoffId: offer.operationId,
      kind: 'receive',
      observedQuantity: 400,
      reason: 'Independent exact receipt',
      evidence: 'Synthetic Coating scale',
    };
    const accepted = await f.post('/inventory/room-handoffs/acknowledgements', receipt, 5);
    expect(accepted.statusCode, accepted.body).toBe(201);
    return {stockId, output, offer, receipt: accepted.json().receipt};
  }
  const request = (receiptId: string, quantity = 300) => ({
    operationId: randomUUID(),
    deviceId: f.actors[5].device,
    productionBatchId: f.batch,
    stepNumber: 2,
    observedAt: Date.now(),
    reference: 'Actual Coating measurement / synthetic operation card',
    actualMg: quantity,
    allocations: [{operationId: randomUUID(), receiptId, quantity, expectedRevision: 1}],
    reason: 'Actual weighed Slurry use, independently observed',
    evidence: 'Synthetic before/after mass observation; no calculated flow conversion',
  });
  it('settles only explicitly received Slurry, with partial remainder, original retry and no warehouse effect', async () => {
    const source = await received(),
      before = (
        await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1', [source.stockId])
      ).rows;
    const page = await f.get(`/inventory/room-materials/coating/slurry?deviceId=${f.actors[5].device}`, 5);
    expect(page.statusCode, page.body).toBe(200);
    expect(
      page
        .json()
        .items.find(
          (r: {receipt: {operationId: string}}) => r.receipt.operationId === source.receipt.operationId,
        ),
    ).toMatchObject({received: 400, consumed: 0, remaining: 400, revision: 1, eligible: true, unit: 'mg'});
    const body = request(source.receipt.operationId),
      posted = await f.post('/inventory/room-materials/coating/consumptions', body, 5);
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json().consumption).toMatchObject({
      ...body,
      room: 'coating',
      unit: 'mg',
      actorId: f.actors[5].id,
      warehouseEffect: 'none',
    });
    expect((await f.post('/inventory/room-materials/coating/consumptions', body, 5)).json()).toEqual({
      ...posted.json(),
      status: 'duplicate',
    });
    expect(
      (
        await f.post(
          '/inventory/room-materials/coating/consumptions',
          {...body, evidence: 'Changed original'},
          5,
        )
      ).statusCode,
    ).toBe(409);
    const after = await f.get(`/inventory/room-materials/coating/slurry?deviceId=${f.actors[5].device}`, 5);
    expect(
      after
        .json()
        .items.find(
          (r: {receipt: {operationId: string}}) => r.receipt.operationId === source.receipt.operationId,
        ),
    ).toMatchObject({received: 400, consumed: 300, remaining: 100, revision: 2});
    expect(
      (await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1', [source.stockId]))
        .rows,
    ).toEqual(before);
  });
  it('serializes competing allocations instead of spending one received quantity twice', async () => {
    const s = await received();
    const results = await Promise.all([
      f.post('/inventory/room-materials/coating/consumptions', request(s.receipt.operationId), 5),
      f.post('/inventory/room-materials/coating/consumptions', request(s.receipt.operationId), 5),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
  it('refuses offered/discrepant sources, wrong scope, inferred mass, stale epoch and source holds', async () => {
    const s = await received(),
      body = request(s.receipt.operationId);
    expect(
      (
        await f.post(
          '/inventory/room-materials/coating/consumptions',
          {...body, allocations: [{...body.allocations[0], receiptId: s.offer.operationId}]},
          5,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.post(
          '/inventory/room-materials/coating/consumptions',
          {...body, deviceId: f.actors[4].device},
          4,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.post('/inventory/room-materials/coating/consumptions', {...body, actualMg: 301}, 5))
        .statusCode,
    ).toBe(400);
    const old = await f.app.inject({
      method: 'POST',
      url: '/inventory/room-materials/coating/consumptions',
      headers: {...f.headers(5), 'x-inventory-epoch': randomUUID()},
      payload: body,
    });
    expect(old.statusCode).toBe(409);
    await f.pool.query("UPDATE inventory_stocks SET quality='blocked' WHERE id=$1", [s.stockId]);
    expect((await f.post('/inventory/room-materials/coating/consumptions', body, 5)).statusCode).toBe(409);
  });
  it('allocates actual use across multiple independently received lots and retains each remainder and genealogy', async () => {
    const a = await received(),
      b = await received(),
      body = request(a.receipt.operationId, 500);
    body.allocations = [
      {...body.allocations[0], quantity: 200},
      {operationId: randomUUID(), receiptId: b.receipt.operationId, quantity: 300, expectedRevision: 1},
    ];
    const posted = await f.post('/inventory/room-materials/coating/consumptions', body, 5);
    expect(posted.statusCode, posted.body).toBe(201);
    expect(
      posted
        .json()
        .consumption.sources.map(
          (s: {source: {receipt: {operationId: string}}}) => s.source.receipt.operationId,
        ),
    ).toEqual([a.receipt.operationId, b.receipt.operationId]);
    const page = (
      await f.get(`/inventory/room-materials/coating/slurry?deviceId=${f.actors[5].device}`, 5)
    ).json();
    expect(
      page.items.find(
        (r: {receipt: {operationId: string}}) => r.receipt.operationId === a.receipt.operationId,
      ),
    ).toMatchObject({remaining: 200, consumed: 200, revision: 2});
    expect(
      page.items.find(
        (r: {receipt: {operationId: string}}) => r.receipt.operationId === b.receipt.operationId,
      ),
    ).toMatchObject({remaining: 100, consumed: 300, revision: 2});
  });
  it('preserves original ACK after a hold and keeps header/allocation IDs disjoint from all zero-stock events', async () => {
    const a = await received(),
      body = request(a.receipt.operationId, 100),
      posted = await f.post('/inventory/room-materials/coating/consumptions', body, 5);
    expect(posted.statusCode, posted.body).toBe(201);
    await f.pool.query("UPDATE inventory_stocks SET quality='blocked' WHERE id=$1", [a.stockId]);
    expect((await f.post('/inventory/room-materials/coating/consumptions', body, 5)).json()).toEqual({
      ...posted.json(),
      status: 'duplicate',
    });
    const next = request(a.receipt.operationId, 1);
    next.allocations[0].expectedRevision = 2;
    expect((await f.post('/inventory/room-materials/coating/consumptions', next, 5)).statusCode).toBe(409);
    const b = await received(),
      reuse = {...request(b.receipt.operationId, 1), operationId: body.allocations[0].operationId};
    expect((await f.post('/inventory/room-materials/coating/consumptions', reuse, 5)).statusCode).toBe(409);
    const owner = request(b.receipt.operationId, 1);
    owner.allocations[0].operationId = b.receipt.operationId;
    expect((await f.post('/inventory/room-materials/coating/consumptions', owner, 5)).statusCode).toBe(409);
    const ids = [body.operationId, ...body.allocations.map((a) => a.operationId)];
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM inventory_operations WHERE operation_id=ANY($1::uuid[])',
          [ids],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      f.pool.query('UPDATE inventory_coating_allocations SET quantity=quantity+1 WHERE operation_id=$1', [
        body.allocations[0].operationId,
      ]),
    ).rejects.toThrow('immutable');
  });
});
