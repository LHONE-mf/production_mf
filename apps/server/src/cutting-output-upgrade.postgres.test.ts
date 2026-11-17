import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { createCuttingOutputFixture } from "./cutting-output-test-fixture.js";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Populated 042 → 045 Cutting and Sorting upgrade",
  () => {
    it("preserves every received-roll record and actual use before adding independently counted output and a partial Sorting receipt", async () => {
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
      let f: Awaited<ReturnType<typeof createCuttingOutputFixture>> | undefined;
      try {
        await client.query("CREATE SCHEMA " + schema);
        await client.query("SET search_path TO " + schema);
        for (const file of (await readdir("migrations"))
          .filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 42)
          .sort())
          await client.query(await readFile("migrations/" + file, "utf8"));
        f = await createCuttingOutputFixture(schema);
        const source = await f.receivedRolls();
        async function snapshot() {
          const result = new Map<string, string[]>();
          const names = (
            await client.query(
              "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
              [schema],
            )
          ).rows;
          for (const { tablename } of names)
            result.set(
              tablename,
              (
                await client.query(
                  "SELECT to_jsonb(t) AS row FROM " + tablename + " t",
                )
              ).rows
                .map((r) => JSON.stringify(r.row))
                .sort(),
            );
          return result;
        }
        const beforeUse = await snapshot();
        await client.query(
          await readFile("migrations/043_cutting_roll_consumption.sql", "utf8"),
        );
        const afterUse = await snapshot();
        for (const [name, rows] of beforeUse)
          expect(afterUse.get(name), name).toEqual(rows);
        for (const name of [
          "inventory_cutting_consumptions",
          "inventory_cutting_allocations",
        ])
          expect(afterUse.get(name)).toEqual([]);
        const use = f.consumption(source),
          used = await f.post(
            "/inventory/room-materials/cutting/consumptions",
            use,
            7,
          );
        expect(used.statusCode, used.body).toBe(201);
        const beforeOutput = await snapshot();
        for (const file of [
          "044_cutting_piece_outputs.sql",
          "045_cutting_sorting_custody.sql",
        ])
          await client.query(await readFile("migrations/" + file, "utf8"));
        const afterOutput = await snapshot();
        for (const [name, rows] of beforeOutput) {
          const after = afterOutput
            .get(name)!
            .map((text) => {
              const row = JSON.parse(text);
              if (name === "inventory_room_output_lots") {
                expect(row.cutting_declaration_id).toBeNull();
                delete row.cutting_declaration_id;
              }
              return JSON.stringify(row);
            })
            .sort();
          expect(after, name).toEqual(rows);
        }
        for (const name of [
          "inventory_cutting_outputs",
          "inventory_cutting_output_claims",
        ])
          expect(afterOutput.get(name)).toEqual([]);
        const materialId = randomUUID();
        expect(
          (
            await f.post("/inventory/materials", {
              id: materialId,
              deviceId: f.actors[0].device,
              code: "UNSORTED-" + materialId,
              name: "Synthetic explicitly specified unsorted electrodes",
              category: "electrode",
              baseUnit: "pieces",
            })
          ).statusCode,
        ).toBe(201);
        const body = f.declaration({
          received: source,
          consumption: used.json().consumption,
          materialId,
        });
        expect(
          (await f.post("/inventory/cutting-outputs", body, 7)).statusCode,
        ).toBe(201);
        const offer = {
          operationId: randomUUID(),
          deviceId: f.actors[7].device,
          outputLotId: body.outputs[0].id,
          quantity: 4,
          unit: "pieces",
          expectedSourceRevision: 1,
          recipientId: f.actors[8].id,
          destinationStepNumber: 5,
          reason: "Partial physical lot transfer after upgrade",
          evidence: "Synthetic independent count",
        };
        expect(
          (await f.post("/inventory/cutting-outputs/handoffs", offer, 7))
            .statusCode,
        ).toBe(201);
        const receipt = {
          operationId: randomUUID(),
          deviceId: f.actors[8].device,
          handoffId: offer.operationId,
          kind: "receive",
          unit: "pieces",
          observedQuantity: 4,
          observedLotLabel: body.outputs[0].label,
          measurementNote:
            "Count and original lot identity checked independently",
          reason: "Assigned Sorting receiver",
          evidence: "Synthetic physical count",
        };
        const received = await f.post(
          "/inventory/cutting-outputs/acknowledgements",
          receipt,
          8,
        );
        expect(received.statusCode, received.body).toBe(201);
        expect(received.json().receipt.custodyEffect).toBe("received");
        expect(
          (
            await f.post(
              "/inventory/room-materials/cutting/consumptions",
              use,
              7,
            )
          ).json().consumption,
        ).toEqual(used.json().consumption);
        for (const fn of [
          "coating_slurry_balance",
          "calendaring_roll_balance",
          "cutting_roll_balance",
        ])
          expect(
            (
              await client.query("SELECT " + fn + "($1,$2) AS s", [
                f.org,
                receipt.operationId,
              ])
            ).rows[0].s,
          ).toBeNull();
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
