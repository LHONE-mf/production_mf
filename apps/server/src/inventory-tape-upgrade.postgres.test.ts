import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { createRoomHandoffFixture } from "./room-handoff-test-fixture.js";
describe.skipIf(!process.env.POSTGRES_TEST_URL)(
  "Populated 035 → 036 tape upgrade",
  () => {
    it("preserves every original row and ACK without inferring specifications or changing units", async () => {
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
      let f: Awaited<ReturnType<typeof createRoomHandoffFixture>> | undefined;
      try {
        await client.query("CREATE SCHEMA " + schema);
        await client.query("SET search_path TO " + schema);
        for (const file of (await readdir("migrations"))
          .filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= 35)
          .sort())
          await client.query(await readFile("migrations/" + file, "utf8"));
        f = await createRoomHandoffFixture(schema);
        const source = await f.receivedSlurry();
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
          await readFile("migrations/036_inventory_tape_rolls.sql", "utf8"),
        );
        for (const name of names) {
          const after = (
            await client.query("SELECT to_jsonb(t) AS row FROM " + name + " t")
          ).rows
            .map((r) => {
              if (
                name === "inventory_materials" ||
                name === "inventory_issues"
              ) {
                expect(r.row.tape_specification).toBeNull();
                delete r.row.tape_specification;
              }
              if (name === "inventory_issues") {
                expect(r.row.operation_reference).toBeNull();
                delete r.row.operation_reference;
              }
              return JSON.stringify(r.row);
            })
            .sort();
          expect(after, name).toEqual(rows.get(name));
        }
        const retry = await f.post(
          "/inventory/room-handoffs/acknowledgements",
          source.receiptRequest,
          5,
        );
        expect(retry.statusCode, retry.body).toBe(200);
        expect(retry.json().receipt).toEqual(source.receipt);
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM inventory_materials WHERE base_unit='rolls'",
            )
          ).rows[0].n,
        ).toBe(0);
        expect((await f.stock()).length).toBeGreaterThan(0);
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
