import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { createCoatingFoilFixture } from "./coating-foil-test-fixture.js";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Populated 036 → 037 foil upgrade",
  () => {
    it("preserves every original row, including tape, received foil and original issue ACKs", async () => {
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
      let f: Awaited<ReturnType<typeof createCoatingFoilFixture>> | undefined;
      try {
        await client.query("CREATE SCHEMA " + schema);
        await client.query("SET search_path TO " + schema);
        for (const file of (await readdir("migrations"))
          .filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 36)
          .sort())
          await client.query(await readFile("migrations/" + file, "utf8"));
        f = await createCoatingFoilFixture(schema);
        const source = await f.received();
        const tape = {
          id: randomUUID(),
          deviceId: f.actors[0].device,
          code: "TAPE",
          name: "Synthetic existing tape",
          category: "component",
          baseUnit: "rolls",
          tapeSpecification: {
            application: "coating_support",
            widthMm: "12.50",
            thicknessUm: "25.00",
            reference: "Synthetic specification",
          },
        };
        expect((await f.post("/inventory/materials", tape)).statusCode).toBe(
          201,
        );
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
        await client.query(
          await readFile("migrations/037_coating_foil_consumption.sql", "utf8"),
        );
        for (const name of names) {
          const after = (
            await client.query("SELECT to_jsonb(t) AS row FROM " + name + " t")
          ).rows
            .map((r) => {
              if (name === "inventory_issue_outcomes") {
                expect(r.row.foil_consumption_id).toBeNull();
                delete r.row.foil_consumption_id;
              }
              return JSON.stringify(r.row);
            })
            .sort();
          expect(after, name).toEqual(rows.get(name));
        }
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM inventory_coating_foil_consumptions",
            )
          ).rows[0].n,
        ).toBe(0);
        const used = await f.post(
          "/inventory/room-materials/coating/foil-consumptions",
          f.consumption(source),
          5,
        );
        expect(used.statusCode, used.body).toBe(201);
        const read = await f.get(
          "/inventory/room-materials/coating/foil?deviceId=" +
            f.actors[5].device,
          5,
        );
        expect(read.json().items[0].settlement).toMatchObject({
          consumed: 500,
          outstanding: 300,
        });
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
