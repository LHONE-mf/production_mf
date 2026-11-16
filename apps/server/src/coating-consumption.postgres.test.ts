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
  const received = () => f.receivedSlurry();
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
    const history = await f.get(
      `/inventory/room-materials/coating/consumptions?deviceId=${f.actors[5].device}`,
      5,
    );
    expect(history.statusCode, history.body).toBe(200);
    expect(
      history.json().items.find((r: {operationId: string}) => r.operationId === body.operationId),
    ).toEqual(posted.json().consumption);
    const other = await f.get(
      `/inventory/room-materials/coating/consumptions?deviceId=${f.actors[4].device}`,
      4,
    );
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().items).toEqual([]);

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
    await f.pool.query(
      'INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)',
      [f.org, f.actors[3].id, s.receipt.sourceSnapshot.recipientWorkshopId],
    );
    const second = {...request(s.receipt.operationId), deviceId: f.actors[3].device};
    const results = await Promise.all([
      f.post('/inventory/room-materials/coating/consumptions', request(s.receipt.operationId), 5),
      f.post('/inventory/room-materials/coating/consumptions', second, 3),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
  it('refuses offered/discrepant sources, wrong scope, inferred mass, stale epoch and source holds', async () => {
    const s = await received(),
      body = request(s.receipt.operationId);
    const withoutProof = await f.app.inject({
      method: 'POST',
      url: '/inventory/room-materials/coating/consumptions',
      headers: {authorization: 'Bearer ' + f.actors[5].token, 'x-inventory-epoch': f.epoch},
      payload: body,
    });
    expect(withoutProof.statusCode).toBe(403);
    const offered = {...s.offer, operationId: randomUUID(), quantity: 100, expectedSourceRevision: 2};
    expect((await f.post('/inventory/room-handoffs', offered, 4)).statusCode).toBe(201);
    const discrepant = {
      ...s.receiptRequest,
      operationId: randomUUID(),
      handoffId: offered.operationId,
      kind: 'discrepancy',
      observedQuantity: 0,
    };
    expect((await f.post('/inventory/room-handoffs/acknowledgements', discrepant, 5)).statusCode).toBe(201);
    expect(
      (await f.post('/inventory/room-materials/coating/consumptions', request(discrepant.operationId, 1), 5))
        .statusCode,
    ).toBe(404);
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
  it('database guards refuse missing pairs, forged ACKs and multi-row overspending in one SQL statement', async () => {
    const received = await f.receivedSlurry(),
      balance = (
        await f.pool.query('SELECT coating_slurry_balance($1,$2) AS b', [f.org, received.receipt.operationId])
      ).rows[0].b,
      client = await f.pool.connect();
    async function header(body: ReturnType<typeof request>, forged = false) {
      const recordedAt = new Date().toISOString(),
        result = {
          ...body,
          room: 'coating',
          unit: 'mg',
          actorId: f.actors[5].id,
          recordedAt,
          warehouseEffect: 'none',
          sources: [{allocationOperationId: body.allocations[0].operationId, source: balance}],
        };
      await client.query(
        'INSERT INTO inventory_coating_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,actual_mg,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,2,$6,$7,$8,$9,$10)',
        [
          body.operationId,
          f.org,
          f.actors[5].id,
          f.actors[5].device,
          f.batch,
          body.actualMg,
          f.epoch,
          JSON.stringify(body),
          JSON.stringify(forged ? {...result, actualMg: 301} : result),
          recordedAt,
        ],
      );
    }
    const params = (body: ReturnType<typeof request>) => [
      body.allocations[0].operationId,
      f.org,
      body.operationId,
      received.receipt.operationId,
      f.actors[5].id,
      f.actors[5].device,
      300,
      1,
      JSON.stringify(balance),
      JSON.stringify(body),
    ];
    const insert =
      'INSERT INTO inventory_coating_allocations(operation_id,organization_id,consumption_id,receipt_id,actor_id,device_id,quantity,expected_revision,source_snapshot,request_payload) VALUES';
    try {
      for (const forged of [false, true]) {
        await client.query('BEGIN');
        const body = request(received.receipt.operationId);
        try {
          await header(body, forged);
          if (forged) await client.query(insert + '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', params(body));
          await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(
            'coating_allocation_pair_required',
          );
        } finally {
          await client.query('ROLLBACK');
        }
      }
      await client.query('BEGIN');
      try {
        const one = request(received.receipt.operationId),
          two = request(received.receipt.operationId);
        await header(one);
        await header(two);
        await expect(
          client.query(
            insert + '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10),($11,$12,$13,$14,$15,$16,$17,$18,$19,$20)',
            [...params(one), ...params(two)],
          ),
        ).rejects.toThrow('coating_source_remaining_changed');
      } finally {
        await client.query('ROLLBACK');
      }
      expect(
        (
          await f.pool.query('SELECT coating_slurry_balance($1,$2) AS b', [
            f.org,
            received.receipt.operationId,
          ])
        ).rows[0].b,
      ).toMatchObject({received: 400, consumed: 0, remaining: 400, revision: 1});
    } finally {
      client.release();
    }
  });
});
