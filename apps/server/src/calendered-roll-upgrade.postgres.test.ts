import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { createCalenderedRollFixture } from "./calendered-roll-test-fixture.js";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Populated 040 → 042 calendered-roll upgrade",
  () => {
    it("preserves actual use and every original custody record before adding explicit calendered output and Cutting receipt", async () => {
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
      let f:
        | Awaited<ReturnType<typeof createCalenderedRollFixture>>
        | undefined;
      try {
        await client.query("CREATE SCHEMA " + schema);
        await client.query("SET search_path TO " + schema);
        for (const file of (await readdir("migrations"))
          .filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 40)
          .sort())
          await client.query(await readFile("migrations/" + file, "utf8"));
        f = await createCalenderedRollFixture(schema);
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
          "041_calendered_roll_outputs.sql",
          "042_calendaring_cutting_custody.sql",
        ])
          await client.query(await readFile("migrations/" + file, "utf8"));
        for (const name of names) {
          const after = (
            await client.query("SELECT to_jsonb(t) AS row FROM " + name + " t")
          ).rows
            .map((r) => {
              if (name === "inventory_room_output_lots") {
                expect(r.row.calendaring_declaration_id).toBeNull();
                delete r.row.calendaring_declaration_id;
              }
              return JSON.stringify(r.row);
            })
            .sort();
          expect(after, name).toEqual(rows.get(name));
        }
        for (const name of [
          "inventory_calendaring_outputs",
          "inventory_calendaring_output_claims",
        ])
          expect(
            (await client.query("SELECT count(*)::int AS n FROM " + name))
              .rows[0].n,
          ).toBe(0);
        const body = f.declaration(source);
        expect(
          (await f.post("/inventory/calendered-rolls", body, 6)).statusCode,
        ).toBe(201);
        const offer = {
          operationId: randomUUID(),
          deviceId: f.actors[6].device,
          outputLotId: body.outputs[0].id,
          quantity: 1,
          expectedSourceRevision: 1,
          recipientId: f.actors[7].id,
          destinationStepNumber: 4,
          reason: "Physical roll offered after upgrade",
          evidence: "Synthetic physical transfer",
        };
        expect(
          (await f.post("/inventory/calendered-rolls/handoffs", offer, 6))
            .statusCode,
        ).toBe(201);
        const receipt = await f.post(
          "/inventory/calendered-rolls/acknowledgements",
          {
            operationId: randomUUID(),
            deviceId: f.actors[7].device,
            handoffId: offer.operationId,
            kind: "receive",
            observedQuantity: 1,
            observedRollLabel: body.outputs[0].label,
            observedLengthMm: null,
            measurementNote:
              "Count and identity checked; length not remeasured",
            reason: "Assigned Cutting receiver",
            evidence: "Synthetic independent check",
          },
          7,
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
