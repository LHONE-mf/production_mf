import { randomUUID } from "node:crypto";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { createCalendaringFixture } from "./calendaring-consumption-test-fixture.js";
const path = "/inventory/room-materials/calendaring/consumptions",
  sources = "/inventory/room-materials/calendaring/rolls";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Actual Calendaring length use",
  () => {
    let f: Awaited<ReturnType<typeof createCalendaringFixture>>;
    beforeAll(async () => {
      f = await createCalendaringFixture();
    });
    afterAll(async () => {
      await f?.app.close();
      await f?.pool.end();
    });
    it("uses partial lengths from two identified received rolls, preserving independent remainders and zero warehouse effect", async () => {
      const s = await f.receivedRolls(2),
        body = f.consumption(s, [150, 200]),
        before = (
          await f.pool.query(
            "SELECT * FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows;
      const r = await f.post(path, body, 6);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().consumption).toMatchObject({
        ...body,
        room: "calendaring",
        unit: "mm",
        warehouseEffect: "none",
      });
      expect(
        r.json().consumption.sources.map((x: any) => x.source.receipt),
      ).toEqual(s.receipts);
      const page = await f.get(sources + "?deviceId=" + f.actors[6].device, 6);
      expect(page.statusCode, page.body).toBe(200);
      expect(
        page
          .json()
          .items.filter((x: any) =>
            s.receipts.some((r) => r.operationId === x.receipt.operationId),
          )
          .map((x: any) => x.remaining)
          .sort(),
      ).toEqual([200, 250]);
      expect((await f.post(path, body, 6)).json().consumption).toEqual(
        r.json().consumption,
      );
      expect(
        (await f.post(path, { ...body, actualLengthMm: 351 }, 6)).statusCode,
      ).toBe(400);
      expect(
        (
          await f.pool.query(
            "SELECT * FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows,
      ).toEqual(before);
    });
    it("rejects stale, excessive, unreceived, wrong-SKU, wrong-room, fractional or unauthenticated use", async () => {
      const s = await f.receivedRolls(),
        body = f.consumption(s);
      for (const patch of [
        { materialId: f.material },
        { stepNumber: 2 },
        {
          actualLengthMm: 401,
          allocations: [{ ...body.allocations[0], quantity: 401 }],
        },
        { allocations: [{ ...body.allocations[0], expectedRevision: 2 }] },
        { allocations: [{ ...body.allocations[0], receiptId: randomUUID() }] },
        {
          actualLengthMm: 1.5,
          allocations: [{ ...body.allocations[0], quantity: 1.5 }],
        },
      ])
        expect([400, 403, 404, 409]).toContain(
          (await f.post(path, { ...body, ...patch }, 6)).statusCode,
        );
      expect(
        (await f.post(path, { ...body, deviceId: f.actors[5].device }, 5))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: path,
            headers: {
              authorization: "Bearer " + f.actors[6].token,
              "x-inventory-epoch": f.epoch,
            },
            payload: body,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: path,
            headers: { ...f.headers(6), "x-inventory-epoch": randomUUID() },
            payload: body,
          })
        ).statusCode,
      ).toBe(409);
    });
    it("serializes two enrolled devices and retains the original ACK after a parent QA hold", async () => {
      const s = await f.receivedRolls(),
        a = f.consumption(s, [300]);
      await f.pool.query(
        "INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          f.org,
          f.actors[3].id,
          s.receipts[0].sourceSnapshot.recipientWorkshopId,
        ],
      );
      const b = f.consumption(s, [300], 3),
        results = await Promise.all([f.post(path, a, 6), f.post(path, b, 3)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const winner =
        results[0].statusCode === 201
          ? { body: a, actor: 6, r: results[0] }
          : { body: b, actor: 3, r: results[1] };
      const hold = await f.post(
        "/inventory/stocks/" + s.inputs.foil.stockId + "/quality-dispositions",
        {
          operationId: randomUUID(),
          stockId: s.inputs.foil.stockId,
          deviceId: f.actors[0].device,
          expectedRevision: 4,
          disposition: "hold",
          reason: "Later parent hold",
          evidence: "Synthetic Chief observation",
        },
      );
      expect(hold.statusCode, hold.body).toBe(201);
      expect(
        (await f.post(path, winner.body, winner.actor)).json().consumption,
      ).toEqual(winner.r.json().consumption);
      const next = f.consumption(s, [1]);
      next.allocations[0].expectedRevision = 2;
      expect((await f.post(path, next, 6)).statusCode).toBe(409);
      const page = await f.get(sources + "?deviceId=" + f.actors[6].device, 6);
      expect(
        page
          .json()
          .items.find(
            (x: any) => x.receipt.operationId === s.receipts[0].operationId,
          ),
      ).toMatchObject({ remaining: 100, consumed: 300, eligible: false });
    });
    it("enforces paired immutable SQL allocations, exact ACK and global operation ownership", async () => {
      const s = await f.receivedRolls(),
        body = f.consumption(s, [100]),
        client = await f.pool.connect(),
        recordedAt = new Date().toISOString();
      const source = (
        await client.query("SELECT calendaring_roll_balance($1,$2) AS s", [
          f.org,
          s.receipts[0].operationId,
        ])
      ).rows[0].s;
      const ack = {
        ...body,
        room: "calendaring",
        unit: "mm",
        sources: [
          { allocationOperationId: body.allocations[0].operationId, source },
        ],
        actorId: f.actors[6].id,
        recordedAt,
        warehouseEffect: "none",
      };
      const insert = (result: object) =>
        client.query(
          "INSERT INTO inventory_calendaring_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,material_id,actual_length_mm,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,3,$6,100,$7,$8,$9,$10)",
          [
            body.operationId,
            f.org,
            f.actors[6].id,
            f.actors[6].device,
            f.batch,
            body.materialId,
            f.epoch,
            body,
            result,
            recordedAt,
          ],
        );
      try {
        await client.query("BEGIN");
        await insert(ack);
        await expect(client.query("COMMIT")).rejects.toThrow(
          "calendaring_allocation_pair_required",
        );
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await insert({ ...ack, unit: "rolls" });
        await client.query(
          "INSERT INTO inventory_calendaring_allocations(operation_id,organization_id,consumption_id,receipt_id,actor_id,device_id,quantity,expected_revision,source_snapshot,request_payload) VALUES($1,$2,$3,$4,$5,$6,100,1,$7,$8)",
          [
            body.allocations[0].operationId,
            f.org,
            body.operationId,
            s.receipts[0].operationId,
            f.actors[6].id,
            f.actors[6].device,
            source,
            body,
          ],
        );
        await expect(client.query("COMMIT")).rejects.toThrow(
          "calendaring_allocation_pair_required",
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await f.post(
            path,
            { ...body, operationId: s.receipts[0].operationId },
            6,
          )
        ).statusCode,
      ).toBe(409);
      expect((await f.post(path, body, 6)).statusCode).toBe(201);
      await expect(
        f.pool.query(
          "UPDATE inventory_calendaring_allocations SET quantity=1 WHERE consumption_id=$1",
          [body.operationId],
        ),
      ).rejects.toThrow("immutable");
      expect(
        (
          await f.post(
            path,
            { ...body, evidence: "Changed original evidence" },
            6,
          )
        ).statusCode,
      ).toBe(409);
    });
    it("database guards refuse missing pairs, forged ACKs and multi-row overspending in one SQL statement", async () => {
      const received = await f.receivedRolls(),
        request = (_receipt: string, quantity = 300) =>
          f.consumption(received, [quantity]),
        balance = (
          await f.pool.query("SELECT calendaring_roll_balance($1,$2) AS b", [
            f.org,
            received.receipts[0].operationId,
          ])
        ).rows[0].b,
        client = await f.pool.connect();
      async function header(body: ReturnType<typeof request>, forged = false) {
        const recordedAt = new Date().toISOString(),
          result = {
            ...body,
            room: "calendaring",
            unit: "mm",
            actorId: f.actors[6].id,
            recordedAt,
            warehouseEffect: "none",
            sources: [
              {
                allocationOperationId: body.allocations[0].operationId,
                source: balance,
              },
            ],
          };
        await client.query(
          "INSERT INTO inventory_calendaring_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,actual_length_mm,epoch,request_payload,result_payload,recorded_at,material_id) VALUES($1,$2,$3,$4,$5,3,$6,$7,$8,$9,$10,$11)",
          [
            body.operationId,
            f.org,
            f.actors[6].id,
            f.actors[6].device,
            f.batch,
            body.actualLengthMm,
            f.epoch,
            JSON.stringify(body),
            JSON.stringify(
              forged ? { ...result, actualLengthMm: 301 } : result,
            ),
            recordedAt,
            body.materialId,
          ],
        );
      }
      const params = (body: ReturnType<typeof request>) => [
        body.allocations[0].operationId,
        f.org,
        body.operationId,
        received.receipts[0].operationId,
        f.actors[6].id,
        f.actors[6].device,
        300,
        1,
        JSON.stringify(balance),
        JSON.stringify(body),
      ];
      const insert =
        "INSERT INTO inventory_calendaring_allocations(operation_id,organization_id,consumption_id,receipt_id,actor_id,device_id,quantity,expected_revision,source_snapshot,request_payload) VALUES";
      try {
        for (const forged of [false, true]) {
          await client.query("BEGIN");
          const body = request(received.receipts[0].operationId);
          try {
            await header(body, forged);
            if (forged)
              await client.query(
                insert + "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                params(body),
              );
            await expect(
              client.query("SET CONSTRAINTS ALL IMMEDIATE"),
            ).rejects.toThrow("calendaring_allocation_pair_required");
          } finally {
            await client.query("ROLLBACK");
          }
        }
        await client.query("BEGIN");
        try {
          const one = request(received.receipts[0].operationId),
            two = request(received.receipts[0].operationId);
          await header(one);
          await header(two);
          await expect(
            client.query(
              insert +
                "($1,$2,$3,$4,$5,$6,$7,$8,$9,$10),($11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
              [...params(one), ...params(two)],
            ),
          ).rejects.toThrow("calendaring_source_remaining_changed");
        } finally {
          await client.query("ROLLBACK");
        }
        expect(
          (
            await f.pool.query("SELECT calendaring_roll_balance($1,$2) AS b", [
              f.org,
              received.receipts[0].operationId,
            ])
          ).rows[0].b,
        ).toMatchObject({
          received: 400,
          consumed: 0,
          remaining: 400,
          revision: 1,
        });
      } finally {
        client.release();
      }
    });
  },
);
