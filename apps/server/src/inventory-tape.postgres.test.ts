import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createInventoryHandoffFixture } from "./inventory-test-fixture.js";
const spec = {
  application: "coating_support",
  widthMm: "12.50",
  thicknessUm: "25.00",
  reference: "Synthetic supplier drawing R2",
};
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Roll-issued polyimide tape",
  () => {
    let f: Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
    beforeAll(async () => {
      f = await createInventoryHandoffFixture(undefined, true);
    });
    afterAll(async () => {
      await f?.app.close();
      await f?.pool.end();
    });
    const sku = (tapeSpecification: object = spec) => ({
      id: randomUUID(),
      deviceId: f.actors[0].device,
      code: "TAPE-" + randomUUID(),
      name: "Synthetic polyimide tape",
      category: "component",
      baseUnit: "rolls",
      tapeSpecification,
    });
    const issue = (materialId: string, patch: object = {}) => ({
      operationId: randomUUID(),
      issueId: randomUUID(),
      deviceId: f.actors[5].device,
      materialId,
      productionBatchId: f.batch,
      stepNumber: 2,
      recipientId: f.actors[5].id,
      quantity: 2,
      tapeSpecification: spec,
      operationReference: "Synthetic Coating card / temporary lip support",
      reason: "Explicit tape request",
      evidence: "Synthetic approved requirement",
      ...patch,
    });
    it("creates immutable application-specific roll SKUs and preserves exact creation retry and catalogue edits", async () => {
      const body = sku(),
        r = await f.post("/inventory/materials", body);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().tapeSpecification).toEqual(spec);
      expect((await f.post("/inventory/materials", body)).json()).toEqual(
        r.json(),
      );
      expect(
        (
          await f.post("/inventory/materials", {
            ...body,
            tapeSpecification: { ...spec, widthMm: "12.5" },
          })
        ).statusCode,
      ).toBe(409);
      for (const patch of [
        { baseUnit: "pieces" },
        { category: "raw_material" },
        { tapeSpecification: { ...spec, widthMm: 12.5 } },
        { tapeSpecification: { ...spec, widthMm: "0" } },
        { tapeSpecification: { ...spec, rollLength: 100 } },
      ])
        expect(
          (await f.post("/inventory/materials", { ...sku(), ...patch }))
            .statusCode,
        ).toBe(400);
      const read = await f.get(
        "/inventory/materials?deviceId=" + f.actors[0].device,
      );
      expect(
        read.json().materials.find((m: { id: string }) => m.id === body.id)
          .tapeSpecification,
      ).toEqual(spec);
      const edit = await f.post(`/inventory/materials/${body.id}/changes`, {
        id: body.id,
        changeId: randomUUID(),
        deviceId: f.actors[0].device,
        expectedRevision: 1,
        name: "Updated display label",
        active: true,
        supplierReference: "Synthetic supplier",
        reason: "Display correction",
      });
      expect(edit.statusCode, edit.body).toBe(201);
      expect(edit.json().tapeSpecification).toEqual(spec);
      await expect(
        f.pool.query(
          "UPDATE inventory_materials SET tape_specification=$2 WHERE id=$1",
          [body.id, { ...spec, widthMm: "14" }],
        ),
      ).rejects.toThrow("inventory_tape_identity_immutable");
      await expect(
        f.pool.query(
          "UPDATE inventory_materials SET base_unit='pieces' WHERE id=$1",
          [body.id],
        ),
      ).rejects.toThrow();
    });
    it("requires the exact SKU specification, operation attribution and compatible actual room", async () => {
      const body = sku();
      expect((await f.post("/inventory/materials", body)).statusCode).toBe(201);
      for (const patch of [
        { tapeSpecification: undefined },
        { operationReference: undefined },
        { operationReference: "" },
        { tapeSpecification: { ...spec, widthMm: "13" } },
        {
          stepNumber: 1,
          recipientId: f.actors[4].id,
          deviceId: f.actors[0].device,
        },
      ]) {
        const request = issue(body.id, patch),
          r = await f.post(
            "/inventory/issues",
            request,
            patch.stepNumber ? 0 : 5,
          );
        expect([400, 409], r.body).toContain(r.statusCode);
      }
      const noProof = await f.app.inject({
        method: "POST",
        url: "/inventory/issues",
        headers: {
          authorization: "Bearer " + f.actors[5].token,
          "x-inventory-epoch": f.epoch,
        },
        payload: issue(body.id),
      });
      expect(noProof.statusCode).toBe(403);
      const options = await f.get(
        `/inventory/issue-options?deviceId=${f.actors[5].device}&productionBatchId=${f.batch}&stepNumber=2&resource=materials`,
        5,
      );
      expect(options.statusCode, options.body).toBe(200);
      expect(
        options.json().items.find((m: { id: string }) => m.id === body.id)
          .tapeSpecification,
      ).toEqual(spec);
      const generic = issue(f.material);
      expect((await f.post("/inventory/issues", generic, 5)).statusCode).toBe(
        409,
      );
    });
    it("receives whole rolls in quarantine and uses the existing approved issue once, with exact immutable metadata on every ACK", async () => {
      const material = sku();
      expect((await f.post("/inventory/materials", material)).statusCode).toBe(
        201,
      );
      const stockId = randomUUID(),
        receipt = {
          operationId: randomUUID(),
          stockId,
          deviceId: f.actors[2].device,
          materialId: material.id,
          locationId: f.location,
          manufacturerLot: "SYNTHETIC-TAPE-LOT",
          quantity: 3,
          expectedRevision: 0,
          reason: "Three physical rolls received",
        };
      expect(
        (await f.post("/inventory/receipts", { ...receipt, quantity: 0.5 }, 2))
          .statusCode,
      ).toBe(400);
      const received = await f.post("/inventory/receipts", receipt, 2);
      expect(received.statusCode, received.body).toBe(201);
      expect(received.json().stock).toMatchObject({
        unit: "rolls",
        onHand: 3,
        quality: "quarantine",
      });
      const request = issue(material.id),
        requested = await f.post("/inventory/issues", request, 5);
      expect(requested.statusCode, requested.body).toBe(201);
      expect(
        (
          await f.act(
            request.issueId,
            f.operation("reserve", 1, 1, { stockId, expectedStockRevision: 1 }),
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await f.post(`/inventory/stocks/${stockId}/quality-dispositions`, {
            operationId: randomUUID(),
            stockId,
            deviceId: f.actors[0].device,
            expectedRevision: 1,
            disposition: "release",
            reason: "Chief release",
            evidence: "Synthetic supplier certificate",
          })
        ).statusCode,
      ).toBe(201);
      const reserve = f.operation("reserve", 1, 1, {
        stockId,
        expectedStockRevision: 2,
      });
      expect(
        (
          await f.act(
            request.issueId,
            { ...reserve, deviceId: f.actors[2].device },
            2,
          )
        ).statusCode,
      ).toBe(403);
      for (const [kind, rev, actor, extra] of [
        ["reserve", 1, 1, { stockId, expectedStockRevision: 2 }],
        ["approve", 2, 1, { expectedStockRevision: 3 }],
        ["dispatch", 3, 1, { expectedStockRevision: 3 }],
        ["receive", 4, 5, {}],
      ] as const) {
        const op = f.operation(kind, rev, actor, extra),
          r = await f.act(request.issueId, op, actor);
        expect(r.statusCode, r.body).toBe(201);
        expect(r.json().issue).toMatchObject({
          unit: "rolls",
          quantity: 2,
          tapeSpecification: spec,
          operationReference: request.operationReference,
        });
        const duplicate = await f.act(request.issueId, op, actor);
        expect(duplicate.statusCode, duplicate.body).toBe(200);
        expect(duplicate.json().issue).toEqual(r.json().issue);
      }
      expect(
        (await f.post("/inventory/issues", request, 5)).json().issue,
      ).toEqual(requested.json().issue);
      expect(
        (
          await f.pool.query(
            "SELECT on_hand,reserved,revision FROM inventory_stocks WHERE id=$1",
            [stockId],
          )
        ).rows[0],
      ).toMatchObject({ on_hand: "1", reserved: "0", revision: 4 });
      await expect(
        f.pool.query(
          "UPDATE inventory_issues SET operation_reference='Changed after receipt' WHERE id=$1",
          [request.issueId],
        ),
      ).rejects.toThrow("inventory_tape_identity_immutable");
      const room = await f.get(
        `/inventory/room-materials/coating?deviceId=${f.actors[5].device}`,
        5,
      );
      expect(room.statusCode, room.body).toBe(200);
      expect(JSON.stringify(room.json())).toContain("rolls");
    });
    it("keeps tab insulation and winding tape as distinct Assembly SKUs and rejects their use in Coating", async () => {
      const workshop = "tape-assembly-" + randomUUID(),
        route = randomUUID(),
        order = randomUUID(),
        batch = randomUUID();
      await f.pool.query(
        "INSERT INTO workshops(organization_id,id,name) VALUES($1,$2,$2)",
        [f.org, workshop],
      );
      await f.pool.query(
        "INSERT INTO user_workshop_memberships(organization_id,user_id,workshop_id) VALUES($1,$2,$3)",
        [f.org, f.actors[5].id, workshop],
      );
      await f.pool.query(
        "INSERT INTO process_routes(organization_id,id,code,name,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic cell Assembly route',$3)",
        [f.org, route, f.actors[0].id],
      );
      await f.pool.query(
        "INSERT INTO process_route_versions(organization_id,route_id,version) VALUES($1,$2,1)",
        [f.org, route],
      );
      await f.pool.query(
        "INSERT INTO process_route_steps(organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line) VALUES($1,$2,1,1,'Synthetic Assembly','assembly',$3,'common')",
        [f.org, route, workshop],
      );
      await f.pool.query(
        "UPDATE process_route_versions SET state='approved',approved_at=now(),approved_by=$3 WHERE organization_id=$1 AND route_id=$2",
        [f.org, route, f.actors[0].id],
      );
      await f.pool.query(
        "INSERT INTO production_orders(organization_id,id,order_code,product_code,route_id,route_version,status,planned_quantity,quantity_unit,created_by) VALUES($1,$2::uuid,$2::uuid::text,'Synthetic cell',$3,1,'released',1,'cells',$4)",
        [f.org, order, route, f.actors[0].id],
      );
      await f.pool.query(
        "INSERT INTO production_batches(organization_id,id,order_id,batch_code,material_line,status,created_by) VALUES($1,$2::uuid,$3,$2::uuid::text,'cell','created',$4)",
        [f.org, batch, order, f.actors[0].id],
      );
      for (const application of [
        "assembly_tab_insulation",
        "assembly_winding",
      ]) {
        const tapeSpecification = {
            ...spec,
            application,
            widthMm: application === "assembly_winding" ? "20.00" : "5.00",
            thicknessUm: "50.00",
          },
          material = sku(tapeSpecification);
        expect(
          (await f.post("/inventory/materials", material)).statusCode,
        ).toBe(201);
        const wrong = await f.post(
          "/inventory/issues",
          issue(material.id, { tapeSpecification }),
          5,
        );
        expect(wrong.statusCode).toBe(409);
        const request = issue(material.id, {
          tapeSpecification,
          productionBatchId: batch,
          stepNumber: 1,
          operationReference: "Synthetic Assembly card / " + application,
        });
        const r = await f.post("/inventory/issues", request, 5);
        expect(r.statusCode, r.body).toBe(201);
        expect(r.json().issue).toMatchObject({
          tapeSpecification,
          operationReference: request.operationReference,
          unit: "rolls",
          workshopId: workshop,
        });
      }
    });
    it("rejects direct SQL specification bypasses and forged issue acknowledgements", async () => {
      const material = sku();
      expect((await f.post("/inventory/materials", material)).statusCode).toBe(
        201,
      );
      await expect(
        f.pool.query(
          "INSERT INTO inventory_materials(id,organization_id,material_code,display_name,category,base_unit,tape_specification) VALUES($1,$2,$1::text,'Bad tape','component','rolls',$3)",
          [randomUUID(), f.org, { ...spec, widthMm: "0" }],
        ),
      ).rejects.toThrow();
      const request = issue(material.id),
        r = await f.post("/inventory/issues", request, 5);
      expect(r.statusCode, r.body).toBe(201);
      await expect(
        f.pool.query(
          "INSERT INTO inventory_issues(id,organization_id,material_id,production_batch_id,step_number,workshop_id,recipient_id,requested_by,quantity,unit,state) SELECT $2,organization_id,material_id,production_batch_id,step_number,workshop_id,recipient_id,requested_by,quantity,unit,state FROM inventory_issues WHERE id=$1",
          [request.issueId, randomUUID()],
        ),
      ).rejects.toThrow("inventory_tape_specification_mismatch");
      await expect(
        f.pool.query(
          "INSERT INTO inventory_issue_events(operation_id,organization_id,issue_id,actor_id,device_id,kind,expected_revision,resulting_revision,epoch,reason,evidence,stock_effect,request_payload,result_issue,result_stock) SELECT $2,organization_id,issue_id,actor_id,device_id,kind,expected_revision,resulting_revision,epoch,reason,evidence,stock_effect,request_payload,result_issue-'tapeSpecification',result_stock FROM inventory_issue_events WHERE operation_id=$1",
          [request.operationId, randomUUID()],
        ),
      ).rejects.toThrow("inventory_tape_ack_mismatch");
    });
  },
);
