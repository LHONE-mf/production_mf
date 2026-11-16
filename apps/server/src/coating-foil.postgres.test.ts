import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createCoatingFoilFixture } from "./coating-foil-test-fixture.js";
const path = "/inventory/room-materials/coating/foil-consumptions";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Actual collector-foil use in Coating",
  () => {
    let f: Awaited<ReturnType<typeof createCoatingFoilFixture>>;
    beforeAll(async () => {
      f = await createCoatingFoilFixture();
    });
    afterAll(async () => {
      await f?.app.close();
      await f?.pool.end();
    });
    it("uses partial received foil in its exact issued unit and shares remainder with returns, without a warehouse debit", async () => {
      const source = await f.received(),
        body = f.consumption(source, 500),
        before = (
          await f.pool.query(
            "SELECT on_hand,revision FROM inventory_stocks WHERE id=$1",
            [source.stockId],
          )
        ).rows;
      const r = await f.post(path, body, 5);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().consumption).toMatchObject({
        ...body,
        room: "coating",
        warehouseEffect: "none",
        actorId: f.actors[5].id,
      });
      expect(
        (
          await f.pool.query(
            "SELECT on_hand,revision FROM inventory_stocks WHERE id=$1",
            [source.stockId],
          )
        ).rows,
      ).toEqual(before);
      const returned = await f.post(
        `/inventory/issues/${source.issue.id}/outcomes`,
        {
          operationId: randomUUID(),
          deviceId: f.actors[2].device,
          issueId: source.issue.id,
          productionBatchId: f.batch,
          sourceStockId: source.stockId,
          expectedSettlementRevision: 2,
          quantity: 200,
          kind: "return",
          expectedSourceRevision: 4,
          stockId: randomUUID(),
          locationId: f.location,
          condition: "untouched_unused",
          reason: "Actual untouched surplus",
          evidence: "Synthetic physical inspection",
        },
        2,
      );
      expect(returned.statusCode, returned.body).toBe(201);
      expect(returned.json().settlement).toMatchObject({
        consumed: 500,
        returned: 200,
        outstanding: 100,
        revision: 3,
      });
      expect(
        (
          await f.post(
            path,
            {
              ...f.consumption(source, 101),
              allocations: [
                {
                  ...body.allocations[0],
                  operationId: randomUUID(),
                  quantity: 101,
                  expectedSettlementRevision: 3,
                },
              ],
            },
            5,
          )
        ).statusCode,
      ).toBe(409);
      expect((await f.post(path, body, 5)).json().consumption).toEqual(
        r.json().consumption,
      );
      const read = await f.get(
        `/inventory/room-materials/coating/foil?deviceId=${f.actors[5].device}`,
        5,
      );
      expect(read.statusCode, read.body).toBe(200);
      expect(
        read.json().items.find((x: any) => x.issue.id === source.issue.id)
          .settlement,
      ).toMatchObject({ outstanding: 100, consumed: 500, returned: 200 });
    });
    it("allocates multiple lots of the same explicit SKU and unit exactly, then retains history", async () => {
      const a = await f.received("mg"),
        b = await f.received("mg", a.materialId),
        body = f.consumption(a, 700);
      body.allocations = [
        { ...body.allocations[0], quantity: 400 },
        {
          operationId: randomUUID(),
          issueId: b.issue.id,
          quantity: 300,
          expectedSettlementRevision: 1,
        },
      ];
      const r = await f.post(path, body, 5);
      expect(r.statusCode, r.body).toBe(201);
      expect(
        r
          .json()
          .consumption.sources.map((s: any) => s.issue.source.manufacturerLot),
      ).toEqual([
        a.issue.source.manufacturerLot,
        b.issue.source.manufacturerLot,
      ]);
      const h = await f.get(path + "?deviceId=" + f.actors[5].device, 5);
      expect(h.statusCode, h.body).toBe(200);
      expect(
        h.json().items.some((c: any) => c.operationId === body.operationId),
      ).toBe(true);
    });
    it("rejects wrong units, unreceived sources, source substitution, holds, scope, proof and history changes", async () => {
      const source = await f.received(),
        body = f.consumption(source);
      for (const patch of [
        { unit: "rolls" },
        { unit: "mg" },
        { actualQuantity: 501 },
        { actualQuantity: 0.5 },
        { materialId: f.material },
        { stepNumber: 1 },
      ])
        expect([400, 403, 409]).toContain(
          (
            await f.post(
              path,
              { ...body, operationId: randomUUID(), ...patch },
              5,
            )
          ).statusCode,
        );
      expect(
        (await f.post(path, { ...body, deviceId: f.actors[4].device }, 4))
          .statusCode,
      ).toBe(403);
      const unreceived = await f.post(
        "/inventory/issues",
        {
          operationId: randomUUID(),
          issueId: randomUUID(),
          deviceId: f.actors[5].device,
          materialId: source.materialId,
          productionBatchId: f.batch,
          stepNumber: 2,
          recipientId: f.actors[5].id,
          quantity: 500,
          reason: "Not yet physically received",
          evidence: "Request only",
        },
        5,
      );
      expect(unreceived.statusCode).toBe(201);
      expect(
        (
          await f.post(
            path,
            {
              ...body,
              allocations: [
                { ...body.allocations[0], issueId: unreceived.json().issue.id },
              ],
            },
            5,
          )
        ).statusCode,
      ).toBe(409);
      const noProof = await f.app.inject({
        method: "POST",
        url: path,
        headers: {
          authorization: "Bearer " + f.actors[5].token,
          "x-inventory-epoch": f.epoch,
        },
        payload: body,
      });
      expect(noProof.statusCode).toBe(403);
      const stale = await f.app.inject({
        method: "POST",
        url: path,
        headers: { ...f.headers(5), "x-inventory-epoch": randomUUID() },
        payload: body,
      });
      expect(stale.statusCode).toBe(409);
      expect(
        (
          await f.post(
            `/inventory/stocks/${source.stockId}/quality-dispositions`,
            {
              operationId: randomUUID(),
              stockId: source.stockId,
              deviceId: f.actors[0].device,
              expectedRevision: 4,
              disposition: "hold",
              reason: "Current hold",
              evidence: "Review pending",
            },
          )
        ).statusCode,
      ).toBe(201);
      expect((await f.post(path, body, 5)).statusCode).toBe(409);
    });
    it("accepts only one competing device allocation and preserves original retry after a later hold", async () => {
      const source = await f.received(),
        body = f.consumption(source, 600);
      await f.pool.query(
        "INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)",
        [f.org, f.actors[3].id, source.issue.workshopId],
      );
      const competing = {
        ...f.consumption(source, 600),
        deviceId: f.actors[3].device,
      };
      const rs = await Promise.all([
        f.post(path, body, 5),
        f.post(path, competing, 3),
      ]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const winner =
        rs[0].statusCode === 201
          ? { body, actor: 5, r: rs[0] }
          : { body: competing, actor: 3, r: rs[1] };
      expect(
        (
          await f.post(
            `/inventory/stocks/${source.stockId}/quality-dispositions`,
            {
              operationId: randomUUID(),
              stockId: source.stockId,
              deviceId: f.actors[0].device,
              expectedRevision: 4,
              disposition: "hold",
              reason: "After original use",
              evidence: "Synthetic hold",
            },
          )
        ).statusCode,
      ).toBe(201);
      const retry = await f.post(path, winner.body, winner.actor);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().consumption).toEqual(winner.r.json().consumption);
      expect(
        (
          await f.post(
            path,
            { ...winner.body, reference: "Changed" },
            winner.actor,
          )
        ).statusCode,
      ).toBe(409);
    });
    it("rejects missing allocation pairs, forged source ACKs and reused global operation IDs", async () => {
      const source = await f.received(),
        body = f.consumption(source),
        client = await f.pool.connect();
      async function header(request: typeof body, forge = false) {
        const snapshot = (
          await client.query("SELECT coating_foil_source($1,$2) AS source", [
            f.org,
            source.issue.id,
          ])
        ).rows[0].source;
        const recordedAt = new Date().toISOString(),
          ack = {
            ...request,
            room: "coating",
            actorId: f.actors[5].id,
            recordedAt,
            warehouseEffect: "none",
            sources: [
              forge
                ? {
                    ...snapshot,
                    settlement: { ...snapshot.settlement, outstanding: 9999 },
                  }
                : snapshot,
            ],
          };
        await client.query(
          "INSERT INTO inventory_coating_foil_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,material_id,unit,actual_quantity,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            request.operationId,
            f.org,
            f.actors[5].id,
            f.actors[5].device,
            f.batch,
            2,
            source.materialId,
            request.unit,
            request.actualQuantity,
            f.epoch,
            request,
            ack,
            recordedAt,
          ],
        );
        return { snapshot, recordedAt };
      }
      try {
        await client.query("BEGIN");
        await header(body);
        await expect(client.query("COMMIT")).rejects.toThrow(
          "foil_allocation_pair_required",
        );
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        const { recordedAt } = await header(body, true),
          a = body.allocations[0];
        await expect(
          client.query(
            "INSERT INTO inventory_issue_outcomes(operation_id,organization_id,issue_id,production_batch_id,source_stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,epoch,reason,evidence,request_payload,result_payload,recorded_at,foil_consumption_id) VALUES($1,$2,$3,$4,$5,$6,$7,'consume',$8,1,2,$9,$10,$11,$12,$13,$14,$15)",
            [
              a.operationId,
              f.org,
              source.issue.id,
              f.batch,
              source.stockId,
              f.actors[5].id,
              f.actors[5].device,
              a.quantity,
              f.epoch,
              body.reason,
              body.evidence,
              { consumptionId: body.operationId, ...a },
              {},
              recordedAt,
              body.operationId,
            ],
          ),
        ).rejects.toThrow("foil_source_or_settlement_changed");
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await f.post(
            path,
            { ...body, operationId: source.issue.receiptOperationId },
            5,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.post(
            path,
            {
              ...body,
              allocations: [
                {
                  ...body.allocations[0],
                  operationId: source.issue.receiptOperationId,
                },
              ],
            },
            5,
          )
        ).statusCode,
      ).toBe(409);
      const r = await f.post(path, body, 5);
      expect(r.statusCode, r.body).toBe(201);
      await expect(
        f.pool.query(
          "UPDATE inventory_coating_foil_consumptions SET actual_quantity=1 WHERE operation_id=$1",
          [body.operationId],
        ),
      ).rejects.toThrow("immutable");
    });
    it("rejects two overallocating children in one SQL statement and rolls both headers back", async () => {
      const source = await f.received(),
        client = await f.pool.connect(),
        requests = [f.consumption(source, 500), f.consumption(source, 500)];
      try {
        await client.query("BEGIN");
        const snapshot = (
            await client.query("SELECT coating_foil_source($1,$2) AS source", [
              f.org,
              source.issue.id,
            ])
          ).rows[0].source,
          children = [];
        for (const request of requests) {
          const recordedAt = new Date().toISOString(),
            ack = {
              ...request,
              room: "coating",
              actorId: f.actors[5].id,
              recordedAt,
              warehouseEffect: "none",
              sources: [snapshot],
            },
            a = request.allocations[0];
          await client.query(
            "INSERT INTO inventory_coating_foil_consumptions(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,material_id,unit,actual_quantity,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,2,$6,$7,$8,$9,$10,$11,$12)",
            [
              request.operationId,
              f.org,
              f.actors[5].id,
              f.actors[5].device,
              f.batch,
              source.materialId,
              request.unit,
              request.actualQuantity,
              f.epoch,
              request,
              ack,
              recordedAt,
            ],
          );
          const outcome = {
            operationId: a.operationId,
            issueId: source.issue.id,
            productionBatchId: f.batch,
            sourceStockId: source.stockId,
            actorId: f.actors[5].id,
            deviceId: f.actors[5].device,
            kind: "consume",
            quantity: 500,
            stockId: null,
            condition: null,
            expectedRevision: 1,
            resultingRevision: 2,
            reason: request.reason,
            evidence: request.evidence,
            recordedAt,
          };
          children.push({
            operation_id: a.operationId,
            organization_id: f.org,
            issue_id: source.issue.id,
            production_batch_id: f.batch,
            source_stock_id: source.stockId,
            actor_id: f.actors[5].id,
            device_id: f.actors[5].device,
            kind: "consume",
            quantity: 500,
            expected_revision: 1,
            resulting_revision: 2,
            epoch: f.epoch,
            reason: request.reason,
            evidence: request.evidence,
            request_payload: { consumptionId: request.operationId, ...a },
            result_payload: {
              operationId: a.operationId,
              outcome,
              settlement: {
                ...snapshot.settlement,
                revision: 2,
                consumed: 500,
                outstanding: 300,
              },
            },
            recorded_at: recordedAt,
            foil_consumption_id: request.operationId,
          });
        }
        await expect(
          client.query(
            `INSERT INTO inventory_issue_outcomes(operation_id,organization_id,issue_id,production_batch_id,source_stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,epoch,reason,evidence,request_payload,result_payload,recorded_at,foil_consumption_id) SELECT * FROM jsonb_to_recordset($1) AS a(operation_id uuid,organization_id uuid,issue_id uuid,production_batch_id uuid,source_stock_id uuid,actor_id uuid,device_id uuid,kind text,quantity bigint,expected_revision bigint,resulting_revision bigint,epoch uuid,reason text,evidence text,request_payload jsonb,result_payload jsonb,recorded_at timestamptz,foil_consumption_id uuid)`,
            [JSON.stringify(children)],
          ),
        ).rejects.toThrow("foil_source_or_settlement_changed");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_coating_foil_consumptions WHERE operation_id=ANY($1::uuid[])",
            [requests.map((r) => r.operationId)],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await f.post(path, f.consumption(source, 800), 5)).statusCode,
      ).toBe(201);
    });
    it("refuses a changed issue projection instead of granting quantity beyond the immutable receipt", async () => {
      const source = await f.received();
      try {
        await f.pool.query(
          "UPDATE inventory_issues SET quantity=900 WHERE id=$1",
          [source.issue.id],
        );
        const snapshot = (
          await f.pool.query("SELECT coating_foil_source($1,$2) AS source", [
            f.org,
            source.issue.id,
          ])
        ).rows[0].source;
        expect(snapshot).toBeNull();
        expect(
          (await f.post(path, f.consumption(source, 801), 5)).statusCode,
        ).toBe(409);
      } finally {
        await f.pool.query(
          "UPDATE inventory_issues SET quantity=800 WHERE id=$1",
          [source.issue.id],
        );
      }
      const r = await f.post(path, f.consumption(source, 800), 5);
      expect(r.statusCode, r.body).toBe(201);
    });
  },
);
