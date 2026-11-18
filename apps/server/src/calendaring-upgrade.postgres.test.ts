import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { createCalendaringFixture } from "./calendaring-consumption-test-fixture.js";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Populated 039 → 040 Calendaring use upgrade",
  () => {
    it("preserves every received roll and original history before adding measured Calendaring use", async () => {
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
      let f: Awaited<ReturnType<typeof createCalendaringFixture>> | undefined;
      try {
        await client.query("CREATE SCHEMA " + schema);
        await client.query("SET search_path TO " + schema);
        for (const file of (await readdir("migrations"))
          .filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 39)
          .sort())
          await client.query(await readFile("migrations/" + file, "utf8"));
        f = await createCalendaringFixture(schema);
        const source = await f.receivedRolls();
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
          await readFile(
            "migrations/040_calendaring_roll_consumption.sql",
            "utf8",
          ),
        );
        for (const name of names) {
          const after = (
            await client.query("SELECT to_jsonb(t) AS row FROM " + name + " t")
          ).rows
            .map((r) => {
              return JSON.stringify(r.row);
            })
            .sort();
          expect(after, name).toEqual(rows.get(name));
        }
        for (const name of [
          "inventory_calendaring_consumptions",
          "inventory_calendaring_allocations",
        ])
          expect(
            (await client.query("SELECT count(*)::int AS n FROM " + name))
              .rows[0].n,
          ).toBe(0);
        const used = await f.post(
          "/inventory/room-materials/calendaring/consumptions",
          f.consumption(source),
          6,
        );
        expect(used.statusCode, used.body).toBe(201);
        const page = await f.get(
          "/inventory/room-materials/calendaring/rolls?deviceId=" +
            f.actors[6].device,
          6,
        );
        expect(page.json().items[0]).toMatchObject({
          received: 400,
          consumed: 250,
          remaining: 150,
          capacityBasis: "coating_measured_roll_length",
          unit: "mm",
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
