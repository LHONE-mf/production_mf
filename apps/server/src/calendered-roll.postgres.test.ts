import { randomUUID } from "node:crypto";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { createCalenderedRollFixture } from "./calendered-roll-test-fixture.js";
const outputs = "/inventory/calendered-rolls",
  offers = outputs + "/handoffs",
  receipts = outputs + "/acknowledgements";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Measured calendered output and direct Cutting custody",
  () => {
    let f: Awaited<ReturnType<typeof createCalenderedRollFixture>>;
    beforeAll(async () => {
      f = await createCalenderedRollFixture();
    });
    afterAll(async () => {
      await f?.app.close();
      await f?.pool.end();
    });
    it("claims actual Calendaring measurements once, preserves independent outputs and changes no warehouse quantity", async () => {
      const i = await f.inputs(),
        body = f.declaration(i),
        before = (
          await f.pool.query(
            "SELECT * FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows;
      const r = await f.post(outputs, body, 6);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().declaration).toMatchObject({
        ...body,
        sources: [i.consumption],
        qualityStatus: "unreviewed",
        materialAccountingStatus: "unreconciled",
        genealogyScope: "declaration",
        warehouseEffect: "none",
      });
      expect((await f.post(outputs, body, 6)).json().declaration).toEqual(
        r.json().declaration,
      );
      expect(
        (
          await f.post(
            outputs,
            {
              ...body,
              operationId: randomUUID(),
              outputs: [{ ...body.outputs[0], id: randomUUID() }],
            },
            6,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.pool.query(
            "SELECT * FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows,
      ).toEqual(before);
    });
    it("reserves a whole identified roll until the assigned Cutting receiver separately confirms count and label", async () => {
      const i = await f.inputs(),
        body = f.declaration(i);
      expect((await f.post(outputs, body, 6)).statusCode).toBe(201);
      const offer = {
          operationId: randomUUID(),
          deviceId: f.actors[6].device,
          outputLotId: body.outputs[0].id,
          quantity: 1,
          expectedSourceRevision: 1,
          recipientId: f.actors[7].id,
          destinationStepNumber: 4,
          reason: "Physical direct transfer",
          evidence: "Synthetic identified output roll",
        },
        sent = await f.post(offers, offer, 6);
      expect(sent.statusCode, sent.body).toBe(201);
      expect(sent.json().handoff).toMatchObject({
        sourceRoom: "calendaring",
        destinationRoom: "cutting",
        unit: "rolls",
        warehouseEffect: "none",
      });
      expect(
        (await f.post(offers, { ...offer, operationId: randomUUID() }, 6))
          .statusCode,
      ).toBe(409);
      const ack = {
        operationId: randomUUID(),
        deviceId: f.actors[7].device,
        handoffId: offer.operationId,
        kind: "receive",
        observedQuantity: 1,
        observedRollLabel: body.outputs[0].label,
        observedLengthMm: null,
        measurementNote:
          "Physical count and identity checked; length not remeasured",
        reason: "Separate assigned receiver",
        evidence: "Synthetic actual receipt",
      };
      expect(
        (await f.post(receipts, { ...ack, deviceId: f.actors[6].device }, 6))
          .statusCode,
      ).toBe(403);
      expect(
        (await f.post(receipts, { ...ack, observedRollLabel: "OTHER" }, 7))
          .statusCode,
      ).toBe(409);
      const discrepancy = {
        ...ack,
        operationId: randomUUID(),
        kind: "discrepancy",
        observedQuantity: 0,
        observedRollLabel: "OTHER",
      };
      const d = await f.post(receipts, discrepancy, 7);
      expect(d.statusCode, d.body).toBe(201);
      expect(d.json().receipt.custodyEffect).toBe("none");
      const received = await f.post(receipts, ack, 7);
      expect(received.statusCode, received.body).toBe(201);
      expect(received.json().receipt.custodyEffect).toBe("received");
      expect((await f.post(receipts, ack, 7)).json().receipt).toEqual(
        received.json().receipt,
      );
      expect(
        (
          await f.post(
            receipts,
            { ...discrepancy, operationId: randomUUID() },
            7,
          )
        ).statusCode,
      ).toBe(409);
    });
    it("rejects mixed input SKUs, held rolls, route bypass, wrong measurements, proof and epoch", async () => {
      const a = await f.inputs(),
        b = await f.inputs(),
        body = f.declaration(a);
      for (const patch of [
        {
          consumptionIds: [
            a.consumption.operationId,
            b.consumption.operationId,
          ],
        },
        { consumptionIds: [randomUUID()] },
        { outputs: [{ ...body.outputs[0], materialId: f.material }] },
        { outputs: [{ ...body.outputs[0], measuredLengthMm: 0.5 }] },
      ])
        expect([400, 404, 409]).toContain(
          (await f.post(outputs, { ...body, ...patch }, 6)).statusCode,
        );
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: outputs,
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
            url: outputs,
            headers: { ...f.headers(6), "x-inventory-epoch": randomUUID() },
            payload: body,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.post(
            outputs,
            { ...body, outputs: [{ ...body.outputs[0], disposition: "held" }] },
            6,
          )
        ).statusCode,
      ).toBe(201);
      const offer = {
        operationId: randomUUID(),
        deviceId: f.actors[6].device,
        outputLotId: body.outputs[0].id,
        quantity: 1,
        expectedSourceRevision: 1,
        recipientId: f.actors[7].id,
        destinationStepNumber: 4,
        reason: "Held roll cannot move",
        evidence: "Synthetic hold",
      };
      expect((await f.post(offers, offer, 6)).statusCode).toBe(409);
      const c = await f.inputs(),
        ready = f.declaration(c);
      expect((await f.post(outputs, ready, 6)).statusCode).toBe(201);
      expect(
        (
          await f.post(
            offers,
            {
              ...offer,
              outputLotId: ready.outputs[0].id,
              destinationStepNumber: 2,
            },
            6,
          )
        ).statusCode,
      ).toBe(409);
      const old = await f.get(
        "/inventory/coating-rolls?deviceId=" + f.actors[5].device,
        5,
      );
      expect(old.statusCode).toBe(200);
      expect(
        old
          .json()
          .items.every((x: any) => x.snapshot.declaration.slurryConsumptionIds),
      ).toBe(true);
    });
    it("serializes two enrolled senders, retains replay and blocks new receiver custody after parent holds", async () => {
      const i = await f.inputs(),
        body = f.declaration(i);
      expect((await f.post(outputs, body, 6)).statusCode).toBe(201);
      await f.pool.query(
        "INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          f.org,
          f.actors[3].id,
          i.received.receipts[0].sourceSnapshot.recipientWorkshopId,
        ],
      );
      const one = {
          operationId: randomUUID(),
          deviceId: f.actors[6].device,
          outputLotId: body.outputs[0].id,
          quantity: 1,
          expectedSourceRevision: 1,
          recipientId: f.actors[7].id,
          destinationStepNumber: 4,
          reason: "Actual assigned transfer",
          evidence: "Synthetic physical roll",
        },
        two = {
          ...one,
          operationId: randomUUID(),
          deviceId: f.actors[3].device,
        },
        results = await Promise.all([
          f.post(offers, one, 6),
          f.post(offers, two, 3),
        ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const winner =
        results[0].statusCode === 201
          ? { body: one, actor: 6, r: results[0] }
          : { body: two, actor: 3, r: results[1] };
      const hold = await f.post(
        "/inventory/stocks/" +
          i.received.inputs.foil.stockId +
          "/quality-dispositions",
        {
          operationId: randomUUID(),
          stockId: i.received.inputs.foil.stockId,
          deviceId: f.actors[0].device,
          expectedRevision: 4,
          disposition: "hold",
          reason: "Later ancestor hold",
          evidence: "Synthetic Chief QA observation",
        },
      );
      expect(hold.statusCode, hold.body).toBe(201);
      const ack = {
        operationId: randomUUID(),
        deviceId: f.actors[7].device,
        handoffId: winner.body.operationId,
        kind: "receive",
        observedQuantity: 1,
        observedRollLabel: body.outputs[0].label,
        observedLengthMm: null,
        measurementNote: "Physical count checked",
        reason: "Actual receipt",
        evidence: "Synthetic actual observation",
      };
      expect((await f.post(receipts, ack, 7)).statusCode).toBe(409);
      expect(
        (await f.post(offers, winner.body, winner.actor)).json().handoff,
      ).toEqual(winner.r.json().handoff);
      expect((await f.post(outputs, body, 6)).statusCode).toBe(200);
      const page = await f.get(
        outputs + "/handoffs?room=cutting&deviceId=" + f.actors[7].device,
        7,
      );
      expect(page.statusCode, page.body).toBe(200);
      expect(
        page
          .json()
          .items.find((h: any) => h.operationId === winner.body.operationId),
      ).toMatchObject({ received: null, eligible: false });
    });
    it("enforces exact immutable SQL source/ACK and paired claims/lots plus global operation IDs", async () => {
      const i = await f.inputs(),
        body = f.declaration(i),
        client = await f.pool.connect();
      try {
        const source = (
            await client.query("SELECT calendered_roll_sources($1,$2) AS s", [
              f.org,
              body,
            ])
          ).rows[0].s,
          recordedAt = new Date().toISOString(),
          ack = {
            ...body,
            sources: source,
            actorId: f.actors[6].id,
            recordedAt,
            qualityStatus: "unreviewed",
            materialAccountingStatus: "unreconciled",
            genealogyScope: "declaration",
            warehouseEffect: "none",
          };
        const insert = (result: object) =>
          client.query(
            "INSERT INTO inventory_calendaring_outputs(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,epoch,source_snapshot,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,3,$6,$7,$8,$9,$10)",
            [
              body.operationId,
              f.org,
              f.actors[6].id,
              f.actors[6].device,
              f.batch,
              f.epoch,
              JSON.stringify(source),
              body,
              result,
              recordedAt,
            ],
          );
        await client.query("BEGIN");
        await insert(ack);
        await expect(client.query("COMMIT")).rejects.toThrow(
          "calendered_output_pairs_required",
        );
        await client.query("ROLLBACK");
        await expect(
          insert({ ...ack, qualityStatus: "released" }),
        ).rejects.toThrow("calendered_output_ack_required");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await f.post(
            outputs,
            { ...body, operationId: i.consumption.operationId },
            6,
          )
        ).statusCode,
      ).toBe(409);
      expect((await f.post(outputs, body, 6)).statusCode).toBe(201);
      await expect(
        f.pool.query(
          "DELETE FROM inventory_calendaring_outputs WHERE operation_id=$1",
          [body.operationId],
        ),
      ).rejects.toThrow("immutable");
    });
  },
);
