import { randomUUID } from "node:crypto";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { createCoatingRollFixture } from "./coating-roll-test-fixture.js";
const outputs = "/inventory/coating-rolls",
  offers = "/inventory/coating-rolls/handoffs",
  receipts = "/inventory/coating-rolls/acknowledgements";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Measured coated rolls and direct Calendaring custody",
  () => {
    let f: Awaited<ReturnType<typeof createCoatingRollFixture>>;
    beforeAll(async () => {
      f = await createCoatingRollFixture();
    });
    afterAll(async () => {
      await f?.app.close();
      await f?.pool.end();
    });
    it("declares physical rolls from explicit actual inputs without manufacturing mass/length conversion or warehouse stock", async () => {
      const i = await f.inputs(),
        body = f.declaration(i),
        warehouse = (
          await f.pool.query(
            "SELECT id,on_hand,revision FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows;
      const r = await f.post(outputs, body, 5);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().declaration).toMatchObject({
        ...body,
        qualityStatus: "unreviewed",
        materialAccountingStatus: "unreconciled",
        genealogyScope: "declaration",
        warehouseEffect: "none",
      });
      expect(r.json().declaration.sources.slurry[0]).toEqual(
        i.slurryConsumption,
      );
      expect(r.json().declaration.sources.foil[0]).toEqual(i.foilConsumption);
      expect((await f.post(outputs, body, 5)).json().declaration).toEqual(
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
            5,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.pool.query(
            "SELECT id,on_hand,revision FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows,
      ).toEqual(warehouse);
      expect(
        (
          await f.pool.query(
            "SELECT unit,quantity FROM inventory_room_output_lots WHERE id=$1",
            [body.outputs[0].id],
          )
        ).rows[0],
      ).toMatchObject({ unit: "rolls", quantity: "1" });
    });
    it("reserves one whole identified roll and requires the assigned Calendaring receiver to confirm its physical identity", async () => {
      const i = await f.inputs(),
        body = f.declaration(i),
        r = await f.post(outputs, body, 5);
      expect(r.statusCode, r.body).toBe(201);
      const offer = {
        operationId: randomUUID(),
        deviceId: f.actors[5].device,
        outputLotId: body.outputs[0].id,
        quantity: 1,
        expectedSourceRevision: 1,
        recipientId: f.actors[6].id,
        destinationStepNumber: 3,
        reason: "Actual direct roll transfer",
        evidence: "Synthetic physical roll label",
      };
      const sent = await f.post(offers, offer, 5);
      expect(sent.statusCode, sent.body).toBe(201);
      expect(sent.json().handoff).toMatchObject({
        sourceRoom: "coating",
        destinationRoom: "calendaring",
        unit: "rolls",
        quantity: 1,
        warehouseEffect: "none",
      });
      expect(
        (await f.post(offers, { ...offer, operationId: randomUUID() }, 5))
          .statusCode,
      ).toBe(409);
      const ack = {
        operationId: randomUUID(),
        deviceId: f.actors[6].device,
        handoffId: offer.operationId,
        kind: "receive",
        observedQuantity: 1,
        observedRollLabel: body.outputs[0].label,
        observedLengthMm: null,
        measurementNote:
          "Physical roll counted and label verified; length not remeasured",
        reason: "Separate actual receipt",
        evidence: "Synthetic signed receiver check",
      };
      expect(
        (await f.post(receipts, { ...ack, deviceId: f.actors[5].device }, 5))
          .statusCode,
      ).toBe(403);
      expect(
        (await f.post(receipts, { ...ack, observedRollLabel: "OTHER-ROLL" }, 6))
          .statusCode,
      ).toBe(409);
      const discrepancy = {
        ...ack,
        operationId: randomUUID(),
        kind: "discrepancy",
        observedRollLabel: "OTHER-ROLL",
      };
      const d = await f.post(receipts, discrepancy, 6);
      expect(d.statusCode, d.body).toBe(201);
      expect(d.json().receipt.custodyEffect).toBe("none");
      const accepted = await f.post(receipts, ack, 6);
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(accepted.json().receipt).toMatchObject({
        unit: "rolls",
        custodyEffect: "received",
        observedLengthMm: null,
        warehouseEffect: "none",
      });
      expect((await f.post(receipts, ack, 6)).json().receipt).toEqual(
        accepted.json().receipt,
      );
      expect(
        (
          await f.post(
            receipts,
            { ...discrepancy, operationId: randomUUID() },
            6,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_room_handoffs WHERE operation_id=$1",
            [offer.operationId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("rejects held or incorrectly measured rolls, wrong source/card units, missing proof and history changes", async () => {
      const i = await f.inputs(),
        body = f.declaration(i);
      for (const patch of [
        { slurryConsumptionIds: [randomUUID()] },
        { outputs: [{ ...body.outputs[0], materialId: f.material }] },
        { outputs: [{ ...body.outputs[0], measuredLengthMm: 0.5 }] },
        {
          tape: {
            status: "unmeasured",
            issueIds: [i.foil.issue.id],
            note: "Wrong material as tape",
          },
        },
      ])
        expect([400, 409]).toContain(
          (await f.post(outputs, { ...body, ...patch }, 5)).statusCode,
        );
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: outputs,
            headers: {
              authorization: "Bearer " + f.actors[5].token,
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
            headers: { ...f.headers(5), "x-inventory-epoch": randomUUID() },
            payload: body,
          })
        ).statusCode,
      ).toBe(409);
      const held = {
          ...body,
          outputs: [{ ...body.outputs[0], disposition: "held" }],
        },
        r = await f.post(outputs, held, 5);
      expect(r.statusCode, r.body).toBe(201);
      expect(
        (
          await f.post(
            offers,
            {
              operationId: randomUUID(),
              deviceId: f.actors[5].device,
              outputLotId: body.outputs[0].id,
              quantity: 1,
              expectedSourceRevision: 1,
              recipientId: f.actors[6].id,
              destinationStepNumber: 3,
              reason: "Cannot transfer held roll",
              evidence: "Synthetic hold",
            },
            5,
          )
        ).statusCode,
      ).toBe(409);
      const legacy = await f.get(
        "/inventory/room-handoffs/coating?deviceId=" + f.actors[5].device,
        5,
      );
      expect(legacy.statusCode, legacy.body).toBe(200);
      expect(legacy.json().items.every((h: any) => h.unit === "mg")).toBe(true);
    });
    it("lets only one of two current sender devices reserve a roll, preserves replay and applies later QA holds to receipt", async () => {
      const i = await f.inputs(),
        body = f.declaration(i);
      expect((await f.post(outputs, body, 5)).statusCode).toBe(201);
      await f.pool.query(
        "INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [f.org, f.actors[3].id, i.foil.issue.workshopId],
      );
      const offer = {
        operationId: randomUUID(),
        deviceId: f.actors[5].device,
        outputLotId: body.outputs[0].id,
        quantity: 1,
        expectedSourceRevision: 1,
        recipientId: f.actors[6].id,
        destinationStepNumber: 3,
        reason: "Current sender",
        evidence: "Synthetic physical roll",
      };
      const other = {
        ...offer,
        operationId: randomUUID(),
        deviceId: f.actors[3].device,
      };
      const rs = await Promise.all([
        f.post(offers, offer, 5),
        f.post(offers, other, 3),
      ]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const winner =
        rs[0].statusCode === 201
          ? { body: offer, actor: 5, r: rs[0] }
          : { body: other, actor: 3, r: rs[1] };
      expect(
        (
          await f.post(
            `/inventory/stocks/${i.foil.stockId}/quality-dispositions`,
            {
              operationId: randomUUID(),
              stockId: i.foil.stockId,
              deviceId: f.actors[0].device,
              expectedRevision: 4,
              disposition: "hold",
              reason: "Later parent hold",
              evidence: "Synthetic Chief hold",
            },
          )
        ).statusCode,
      ).toBe(201);
      const ack = {
        operationId: randomUUID(),
        deviceId: f.actors[6].device,
        handoffId: winner.body.operationId,
        kind: "receive",
        observedQuantity: 1,
        observedRollLabel: body.outputs[0].label,
        observedLengthMm: 400,
        measurementNote: "Actual independent check",
        reason: "Explicit receiver",
        evidence: "Synthetic label check",
      };
      expect((await f.post(receipts, ack, 6)).statusCode).toBe(409);
      expect(
        (await f.post(offers, winner.body, winner.actor)).json().handoff,
      ).toEqual(winner.r.json().handoff);
      expect((await f.post(outputs, body, 5)).statusCode).toBe(200);
      const page = await f.get(
        "/inventory/coating-rolls/handoffs?room=calendaring&deviceId=" +
          f.actors[6].device,
        6,
      );
      expect(page.statusCode, page.body).toBe(200);
      expect(
        page
          .json()
          .items.find((h: any) => h.operationId === winner.body.operationId),
      ).toMatchObject({ received: null, eligible: false });
    });
    it("requires paired claims/lots and an exact output acknowledgement even for direct SQL", async () => {
      const i = await f.inputs(),
        body = f.declaration(i),
        client = await f.pool.connect();
      try {
        const source = (
            await client.query("SELECT coating_roll_sources($1,$2) AS source", [
              f.org,
              body,
            ])
          ).rows[0].source,
          recordedAt = new Date().toISOString(),
          ack = {
            ...body,
            sources: source,
            actorId: f.actors[5].id,
            recordedAt,
            qualityStatus: "unreviewed",
            materialAccountingStatus: "unreconciled",
            genealogyScope: "declaration",
            warehouseEffect: "none",
          };
        const insert = (result: object) =>
          client.query(
            "INSERT INTO inventory_coating_outputs(operation_id,organization_id,actor_id,device_id,production_batch_id,step_number,epoch,source_snapshot,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,2,$6,$7,$8,$9,$10)",
            [
              body.operationId,
              f.org,
              f.actors[5].id,
              f.actors[5].device,
              f.batch,
              f.epoch,
              source,
              body,
              result,
              recordedAt,
            ],
          );
        await client.query("BEGIN");
        await insert(ack);
        await expect(client.query("COMMIT")).rejects.toThrow(
          "coating_output_pairs_required",
        );
        await client.query("ROLLBACK");
        await expect(
          insert({ ...ack, qualityStatus: "released" }),
        ).rejects.toThrow("coating_output_ack_required");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(
        (
          await f.post(
            outputs,
            { ...body, operationId: i.foilConsumption.operationId },
            5,
          )
        ).statusCode,
      ).toBe(409);
      expect((await f.post(outputs, body, 5)).statusCode).toBe(201);
      await expect(
        f.pool.query(
          "DELETE FROM inventory_coating_outputs WHERE operation_id=$1",
          [body.operationId],
        ),
      ).rejects.toThrow("immutable");
    });
  },
);
