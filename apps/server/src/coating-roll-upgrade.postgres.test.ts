import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { createCoatingRollFixture } from "./coating-roll-test-fixture.js";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Populated 037 → 039 coated-roll upgrade",
  () => {
    it("preserves all actual consumption and Slurry custody history before adding explicit roll output and Calendaring receipt", async () => {
      const target = new URL(process.env.POSTGRES_TEST_URL!);
      if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        target.pathname !== "/production_mf_ci" ||
        target.username !== "production_mf_ci"
      )
        throw Error("Owned disposable PostgreSQL required");
      const admin = new Pool({
          connectionString: process.env.POSTGRES_TEST_URL,
        }),
        client = await admin.connect(),
        schema = "room_upgrade_" + randomUUID().replaceAll("-", "");
      let f: Awaited<ReturnType<typeof createCoatingRollFixture>> | undefined;
      try {
        await client.query("CREATE SCHEMA " + schema);
        await client.query("SET search_path TO " + schema);
        for (const file of (await readdir("migrations"))
          .filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 37)
          .sort())
          await client.query(await readFile("migrations/" + file, "utf8"));
        f = await createCoatingRollFixture(schema);
        const source = await f.inputs();
        const names = (
            await client.query(
              "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
              [schema],
            )
          ).rows.map((r) => r.tablename as string),
          rows = new Map<string, string[]>();
        for (const name of names)
          rows.set(
            name,
            (
              await client.query(
                "SELECT to_jsonb(t) AS row FROM " + name + " t",
              )
            ).rows
              .map((r) => JSON.stringify(r.row))
              .sort(),
          );
        for (const file of [
          "038_coating_roll_outputs.sql",
          "039_coating_calendaring_custody.sql",
        ])
          await client.query(await readFile("migrations/" + file, "utf8"));
        for (const name of names) {
          const after = (
            await client.query("SELECT to_jsonb(t) AS row FROM " + name + " t")
          ).rows
            .map((r) => {
              if (name === "inventory_room_output_lots") {
                expect(r.row.coating_declaration_id).toBeNull();
                delete r.row.coating_declaration_id;
              }
              return JSON.stringify(r.row);
            })
            .sort();
          expect(after, name).toEqual(rows.get(name));
        }
        for (const name of [
          "inventory_coating_outputs",
          "inventory_coating_output_claims",
        ])
          expect(
            (await client.query("SELECT count(*)::int AS n FROM " + name))
              .rows[0].n,
          ).toBe(0);
        const body = f.declaration(source);
        expect(
          (await f.post("/inventory/coating-rolls", body, 5)).statusCode,
        ).toBe(201);
        const offer = {
          operationId: randomUUID(),
          deviceId: f.actors[5].device,
          outputLotId: body.outputs[0].id,
          quantity: 1,
          expectedSourceRevision: 1,
          recipientId: f.actors[6].id,
          destinationStepNumber: 3,
          reason: "Physical roll offered after upgrade",
          evidence: "Synthetic physical transfer",
        };
        expect(
          (await f.post("/inventory/coating-rolls/handoffs", offer, 5))
            .statusCode,
        ).toBe(201);
        const receipt = await f.post(
          "/inventory/coating-rolls/acknowledgements",
          {
            operationId: randomUUID(),
            deviceId: f.actors[6].device,
            handoffId: offer.operationId,
            kind: "receive",
            observedQuantity: 1,
            observedRollLabel: body.outputs[0].label,
            observedLengthMm: null,
            measurementNote:
              "Count and identity checked; length not remeasured",
            reason: "Assigned Calendaring receiver",
            evidence: "Synthetic independent check",
          },
          6,
        );
        expect(receipt.statusCode, receipt.body).toBe(201);
        expect(receipt.json().receipt.custodyEffect).toBe("received");
      } finally {
        await f?.app.close();
        await f?.pool.end();
        await client.query("ROLLBACK");
        await client.query("RESET search_path");
        await client.query("DROP SCHEMA " + schema + " CASCADE");
        client.release();
        await admin.end();
      }
    }, 30000);
  },
);
