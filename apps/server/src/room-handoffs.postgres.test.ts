import {randomUUID} from 'node:crypto';
import {beforeAll, afterAll, describe, it, expect} from 'vitest';
import {createRoomHandoffFixture} from './room-handoff-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  'Measured Slurry output and acknowledged Coating custody',
  () => {
    let f: Awaited<ReturnType<typeof createRoomHandoffFixture>>;
    beforeAll(async () => {
      f = await createRoomHandoffFixture();
    });
    afterAll(async () => {
      await f?.app.close();
      await f?.pool.end();
    });
    async function output() {
      const {stockId, consumption} = await f.consumed();
      const body = {
        operationId: randomUUID(),
        deviceId: f.actors[4].device,
        consumptionId: consumption.operationId,
        outputs: [{id: randomUUID(), materialId: f.material, quantity: 900}],
        scrapMg: 20,
        measuredLossMg: 30,
        unknownMg: 50,
        basis: 'weighed-slurry-mass',
        specificationReference: 'Synthetic approved product card',
        observedAt: Date.now(),
        reason: 'Independently weighed output',
        evidence: 'Net measured output; scrap/loss/unknown separately entered',
      };
      const r = await f.post('/inventory/room-outputs/slurry', body, 4);
      expect(r.statusCode, r.body).toBe(201);
      return {body, stockId, consumption, declaration: r.json().declaration};
    }
    const offer = (lotId: string, quantity = 400, revision = 1) => ({
      operationId: randomUUID(),
      deviceId: f.actors[4].device,
      outputLotId: lotId,
      quantity,
      expectedSourceRevision: revision,
      recipientId: f.actors[5].id,
      destinationStepNumber: 2,
      reason: 'Explicit physical handoff',
      evidence: 'Counted transfer container',
    });
    const receipt = (handoffId: string, kind = 'receive', quantity: number | null = 400) => ({
      operationId: randomUUID(),
      deviceId: f.actors[5].device,
      handoffId,
      kind,
      observedQuantity: quantity,
      reason: 'Independent receiver observation',
      evidence: 'Coating operator actual count',
    });
    it('declares measured output/losses, reserves partial offers and moves custody only on receiver ACK without warehouse writes', async () => {
      const {body, stockId} = await output(),
        lotId = body.outputs[0].id;
      const before = (
        await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1', [stockId])
      ).rows;
      const request = offer(lotId),
        sent = await f.post('/inventory/room-handoffs', request, 4);
      expect(sent.statusCode, sent.body).toBe(201);
      const sender = (await f.get(`/inventory/room-outputs/slurry?deviceId=${f.actors[4].device}`, 4)).json();
      expect(sender.items.find((r: {id: string}) => r.id === lotId)).toMatchObject({
        available: 500,
        inTransit: 400,
        received: 0,
        revision: 2,
        unit: 'mg',
        qualityStatus: 'unreviewed',
      });
      let incoming = (
        await f.get(`/inventory/room-handoffs/coating?deviceId=${f.actors[5].device}`, 5)
      ).json();
      expect(
        incoming.items.find((r: {operationId: string}) => r.operationId === request.operationId).status,
      ).toBe('awaiting_receiver');
      const ackRequest = receipt(request.operationId),
        ack = await f.post('/inventory/room-handoffs/acknowledgements', ackRequest, 5);
      expect(ack.statusCode, ack.body).toBe(201);
      expect((await f.post('/inventory/room-handoffs/acknowledgements', ackRequest, 5)).json()).toEqual({
        ...ack.json(),
        status: 'duplicate',
      });
      incoming = (await f.get(`/inventory/room-handoffs/coating?deviceId=${f.actors[5].device}`, 5)).json();
      expect(
        incoming.items.find((r: {operationId: string}) => r.operationId === request.operationId),
      ).toMatchObject({status: 'received', custodyQuantity: 400, unit: 'mg', warehouseEffect: 'none'});
      expect(
        (await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1', [stockId])).rows,
      ).toEqual(before);
      expect((await f.post('/inventory/room-outputs/slurry', body, 4)).statusCode).toBe(200);
      expect((await f.post('/inventory/room-handoffs', request, 4)).statusCode).toBe(200);
    });
    it('retains discrepancies and pending reservations instead of inferring acceptance or releasing stock', async () => {
      const {body} = await output(),
        send = offer(body.outputs[0].id);
      expect((await f.post('/inventory/room-handoffs', send, 4)).statusCode).toBe(201);
      expect(
        (
          await f.post(
            '/inventory/room-handoffs/acknowledgements',
            receipt(send.operationId, 'receive', 399),
            5,
          )
        ).statusCode,
      ).toBe(409);
      const mismatch = await f.post(
        '/inventory/room-handoffs/acknowledgements',
        receipt(send.operationId, 'discrepancy', 399),
        5,
      );
      expect(mismatch.statusCode, mismatch.body).toBe(201);
      const incoming = (
        await f.get(`/inventory/room-handoffs/coating?deviceId=${f.actors[5].device}`, 5)
      ).json();
      expect(
        incoming.items.find((r: {operationId: string}) => r.operationId === send.operationId),
      ).toMatchObject({status: 'discrepancy', custodyQuantity: 0});
      expect(
        (await f.post('/inventory/room-handoffs/acknowledgements', receipt(send.operationId), 5)).statusCode,
      ).toBe(201);
      expect(
        (await f.post('/inventory/room-handoffs/acknowledgements', receipt(send.operationId), 5)).statusCode,
      ).toBe(409);
    });
    it('conserves multi-output declarations and refuses duplicate source adoption, unmeasured output and concurrent overspending', async () => {
      const {consumption} = await f.consumed(),
        op = randomUUID();
      const body = {
        operationId: op,
        deviceId: f.actors[4].device,
        consumptionId: consumption.operationId,
        outputs: [
          {id: randomUUID(), materialId: f.material, quantity: 500},
          {id: randomUUID(), materialId: f.material, quantity: 400},
        ],
        scrapMg: 0,
        measuredLossMg: 0,
        unknownMg: 100,
        basis: 'weighed-slurry-mass',
        specificationReference: 'Explicit product spec',
        observedAt: Date.now(),
        reason: 'Two actual output containers',
        evidence: 'Both separately weighed',
      };
      expect((await f.post('/inventory/room-outputs/slurry', {...body, unknownMg: 0}, 4)).statusCode).toBe(
        409,
      );
      expect((await f.post('/inventory/room-outputs/slurry', body, 4)).statusCode).toBe(201);
      expect(
        (await f.post('/inventory/room-outputs/slurry', {...body, operationId: randomUUID()}, 4)).statusCode,
      ).toBe(409);
      const a = offer(body.outputs[0].id, 400),
        b = {...offer(body.outputs[0].id, 400), deviceId: f.actors[3].device};
      const results = await Promise.all([
        f.post('/inventory/room-handoffs', a, 4),
        f.post('/inventory/room-handoffs', b, 3),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });
    it('checks room/workshop/device/recipient/QA and immutable operation ownership inside the transaction', async () => {
      const {body, stockId} = await output(),
        send = offer(body.outputs[0].id);
      expect(
        (await f.post('/inventory/room-handoffs', {...send, destinationStepNumber: 1}, 4)).statusCode,
      ).toBe(409);
      expect(
        (await f.post('/inventory/room-handoffs', {...send, recipientId: f.actors[4].id}, 4)).statusCode,
      ).toBe(409);
      const r = await f.post('/inventory/room-handoffs', send, 4);
      expect(r.statusCode, r.body).toBe(201);
      expect(
        (
          await f.post(
            '/inventory/room-handoffs/acknowledgements',
            {...receipt(send.operationId), deviceId: f.actors[4].device},
            4,
          )
        ).statusCode,
      ).toBe(403);
      await f.pool.query("UPDATE inventory_stocks SET quality='blocked' WHERE id=$1", [stockId]);
      expect(
        (await f.post('/inventory/room-handoffs/acknowledgements', receipt(send.operationId), 5)).statusCode,
      ).toBe(409);
      expect(
        (await f.post('/inventory/room-handoffs', {...send, evidence: 'changed original'}, 4)).statusCode,
      ).toBe(409);
    });
    it('keeps bounded discrepancy previews and scoped paginated history, including explicit zero and unknown', async () => {
      const {body} = await output(),
        send = offer(body.outputs[0].id);
      expect((await f.post('/inventory/room-handoffs', send, 4)).statusCode).toBe(201);
      for (let i = 0; i < 12; i++)
        expect(
          (
            await f.post(
              '/inventory/room-handoffs/acknowledgements',
              receipt(send.operationId, 'discrepancy', i % 2 ? null : 0),
              5,
            )
          ).statusCode,
        ).toBe(201);
      const page = (await f.get(`/inventory/room-handoffs/coating?deviceId=${f.actors[5].device}`, 5)).json(),
        item = page.items.find((r: {operationId: string}) => r.operationId === send.operationId);
      expect(item).toMatchObject({
        status: 'discrepancy',
        custodyQuantity: 0,
        eventCount: 12,
        eventsTruncated: true,
        eligible: true,
      });
      expect(item.events).toHaveLength(10);
      let after = '',
        all: string[] = [];
      do {
        const r = await f.get(
          `/inventory/room-handoffs/coating/${send.operationId}/events?deviceId=${f.actors[5].device}&limit=5${after ? '&after=' + after : ''}`,
          5,
        );
        expect(r.statusCode, r.body).toBe(200);
        const p = r.json();
        all.push(...p.items.map((e: {operationId: string}) => e.operationId));
        after = p.nextAfter ?? '';
      } while (after);
      expect(all).toHaveLength(12);
      expect(new Set(all).size).toBe(12);
      expect(
        (
          await f.get(
            `/inventory/room-handoffs/coating/${send.operationId}/events?deviceId=${f.actors[4].device}`,
            4,
          )
        ).statusCode,
      ).toBe(404);
    });
    it('allows original recovery after a hold but never a new receipt or reservation against held material', async () => {
      const {body, stockId} = await output(),
        send = offer(body.outputs[0].id);
      expect((await f.post('/inventory/room-handoffs', send, 4)).statusCode).toBe(201);
      await f.pool.query("UPDATE inventory_stocks SET quality='blocked' WHERE id=$1", [stockId]);
      expect((await f.post('/inventory/room-outputs/slurry', body, 4)).statusCode).toBe(200);
      expect((await f.post('/inventory/room-handoffs', send, 4)).statusCode).toBe(200);
      expect(
        (await f.post('/inventory/room-handoffs', offer(body.outputs[0].id, 100, 2), 4)).statusCode,
      ).toBe(409);
      const page = (await f.get(`/inventory/room-handoffs/coating?deviceId=${f.actors[5].device}`, 5)).json();
      expect(page.items.find((r: {operationId: string}) => r.operationId === send.operationId).eligible).toBe(
        false,
      );
      expect(
        (
          await f.post(
            '/inventory/room-handoffs/acknowledgements',
            receipt(send.operationId, 'discrepancy', null),
            5,
          )
        ).statusCode,
      ).toBe(201);
      expect(
        (await f.post('/inventory/room-handoffs/acknowledgements', receipt(send.operationId), 5)).statusCode,
      ).toBe(409);
    });
    it('database rejects negative loss, missing output children, forged ACKs and immutable rewrites', async () => {
      const {consumption} = await f.consumed();
      const source = (
        await f.pool.query('SELECT room_slurry_source_snapshot($1,$2) AS s', [f.org, consumption.operationId])
      ).rows[0].s;
      const client = await f.pool.connect();
      try {
        for (const mode of ['negative', 'missing', 'forged']) {
          const operationId = randomUUID(),
            at = new Date().toISOString(),
            request = {
              operationId,
              deviceId: f.actors[4].device,
              consumptionId: consumption.operationId,
              outputs: [
                {id: randomUUID(), materialId: f.material, quantity: mode === 'negative' ? 1100 : 900},
              ],
              scrapMg: mode === 'negative' ? -100 : 0,
              measuredLossMg: 0,
              unknownMg: mode === 'negative' ? 0 : 100,
              basis: 'weighed-slurry-mass',
              specificationReference: 'Synthetic approved spec',
              observedAt: Date.now(),
              reason: 'Direct guard test',
              evidence: 'Synthetic only',
            };
          const result = {
            ...request,
            productionBatchId: f.batch,
            stepNumber: 1,
            inputQuantity: 1000,
            source,
            actorId: f.actors[4].id,
            recordedAt: at,
            qualityStatus: 'unreviewed',
            warehouseEffect: 'none',
          };
          await client.query('BEGIN');
          try {
            await client.query(
              "INSERT INTO inventory_room_outputs(operation_id,organization_id,actor_id,device_id,consumption_id,production_batch_id,step_number,room_id,input_quantity,source_snapshot,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,1,'slurry',1000,$7,$8,$9,$10,$11)",
              [
                operationId,
                f.org,
                f.actors[4].id,
                f.actors[4].device,
                consumption.operationId,
                f.batch,
                JSON.stringify(source),
                f.epoch,
                JSON.stringify(request),
                JSON.stringify(mode === 'forged' ? {...result, inputQuantity: 999} : result),
                at,
              ],
            );
            if (mode !== 'missing')
              await client.query(
                "INSERT INTO inventory_room_output_lots(id,organization_id,declaration_id,material_id,quantity,unit) VALUES($1,$2,$3,$4,$5,'mg')",
                [request.outputs[0].id, f.org, operationId, f.material, request.outputs[0].quantity],
              );
            await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(
              'room_output_lot_pair_required',
            );
          } catch (e) {
            if (mode !== 'negative') throw e;
            expect(String(e)).toContain('room_output_mass_balance_required');
          } finally {
            await client.query('ROLLBACK');
          }
        }
      } finally {
        client.release();
      }
      const {body} = await output();
      await expect(
        f.pool.query('DELETE FROM inventory_room_outputs WHERE operation_id=$1', [body.operationId]),
      ).rejects.toThrow();
    });

    it('uses the global zero-stock operation namespace and current enrollment on exact replay', async () => {
      const {body, consumption} = await output();
      expect(
        (
          await f.post(
            '/inventory/room-handoffs',
            {...offer(body.outputs[0].id), operationId: consumption.operationId},
            4,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.post(
            '/inventory/room-handoffs',
            {...offer(body.outputs[0].id), operationId: body.operationId},
            4,
          )
        ).statusCode,
      ).toBe(409);
      const send = offer(body.outputs[0].id);
      expect((await f.post('/inventory/room-handoffs', send, 4)).statusCode).toBe(201);
      expect(
        (
          await f.post(
            '/inventory/room-handoffs/acknowledgements',
            {...receipt(send.operationId), operationId: send.operationId},
            5,
          )
        ).statusCode,
      ).toBe(409);
      const r = receipt(send.operationId);
      expect((await f.post('/inventory/room-handoffs/acknowledgements', r, 5)).statusCode).toBe(201);
      await f.pool.query('UPDATE devices SET revoked_at=now() WHERE id=$1', [f.actors[5].device]);
      expect((await f.post('/inventory/room-handoffs/acknowledgements', r, 5)).statusCode).toBe(403);
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS n FROM inventory_operations WHERE operation_id=ANY($1::uuid[])',
            [[body.operationId, send.operationId, r.operationId]],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  },
);
