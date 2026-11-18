import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { createCuttingFixture } from "./cutting-consumption-test-fixture.js";
describe.skipIf(
  !process.env.POSTGRES_TEST_URL || !process.env.WIP_BROWSER_MODULE,
)("Actual Cutting measured-length mobile workflow", () => {
  it("saves measured Cutting use offline, reopens and retries the identical original body after a lost committed reply", async () => {
    const { createServer } = await import(
        new URL(
          "../../../node_modules/vite/dist/node/index.js",
          import.meta.url,
        ).href
      ),
      vite = await createServer({
        root: new URL("../../../", import.meta.url).pathname,
        server: {
          host: "127.0.0.1",
          port: 5173,
          strictPort: false,
          hmr: false,
        },
      });
    await vite.listen();
    const origin = new URL(vite.resolvedUrls.local[0]).origin;
    process.env.CORS_ALLOWED_ORIGINS = origin;
    const f = await createCuttingFixture(),
      file = new URL(
        "../../../.cutting-browser-" + randomUUID() + ".html",
        import.meta.url,
      ),
      { chromium } = await import(process.env.WIP_BROWSER_MODULE!);
    const browser = await chromium.launch({
        ...(process.env.WIP_BROWSER_EXECUTABLE
          ? { executablePath: process.env.WIP_BROWSER_EXECUTABLE }
          : {}),
        headless: true,
        args: ["--no-sandbox"],
      }),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
    const errors: string[] = [];
    context.on("page", (p: any) =>
      p.on("pageerror", (e: Error) => errors.push(e.message)),
    );
    try {
      const source = await f.receivedRolls(),
        warehouseBefore = (
          await f.pool.query(
            "SELECT on_hand,revision FROM inventory_stocks WHERE id=$1",
            [source.inputs.foil.stockId],
          )
        ).rows;
      const serverUrl = await f.app.listen({ port: 0, host: "127.0.0.1" }),
        scope = {
          serverUrl,
          organizationId: f.org,
          actorId: f.actors[7].id,
          deviceId: f.actors[7].device,
        },
        session = {
          serverUrl,
          accessToken: f.actors[7].token,
          deviceProofToken: f.actors[7].proof,
          deviceProofDeviceId: f.actors[7].device,
          deviceProofExpiresAt: Date.now() + 300000,
        },
        localActorId = "browser-cutting-author";
      await writeFile(
        file,
        `<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{CuttingMaterialsPanel}from'/src/stages/cutting/CuttingMaterials.tsx';import{db}from'/src/core/db/index.ts';import'/src/index.css';window.mount=async props=>{await db.users.put({id:props.localActorId,login:props.localActorId,fullName:'Synthetic foil worker',role:'worker',isActive:true,password:'test-only',createdAt:new Date()});createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto max-w-5xl space-y-3 p-3'},React.createElement(CuttingMaterialsPanel,props)));};</script></html>`,
      );
      let page = await context.newPage();
      const url = origin + "/" + file.pathname.split("/").at(-1),
        mount = async () => {
          await page.goto(url);
          await page.waitForFunction(
            () => typeof (window as any).mount === "function",
          );
          await page.evaluate(
            (props: unknown) => (window as any).mount(props),
            { scope, session, localActorId },
          );
        };
      await mount();
      await page
        .getByRole("button", {
          name: "Обновить принятые рулоны Cutting",
          exact: true,
        })
        .click();
      await page.getByText(/осталось 0.24/).waitFor();
      await page
        .getByLabel("Партия, шаг и SKU расхода Cutting", { exact: true })
        .selectOption(f.batch + ":4:" + source.inputs.materialId);
      await page
        .getByRole("button", {
          name: "Подготовить измерение расхода рулонов",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Время измерения расхода", { exact: true })
        .fill("2026-11-16T12:00");
      await page
        .getByLabel("Операционная карта или ссылка на запись Cutting", {
          exact: true,
        })
        .fill("Synthetic measured operation C-3");
      await page
        .getByLabel("Фактически обработано, м", { exact: true })
        .fill("0.15");
      await page
        .getByLabel("Подтверждённая приёмка 1", { exact: true })
        .selectOption(source.receipts[0].operationId);
      await page
        .getByLabel("Фактически из этого рулона 1, м", { exact: true })
        .fill("0.15");
      await page
        .getByLabel("Основание расхода Cutting", { exact: true })
        .fill("Independently observed actual use");
      await page
        .getByLabel("Свидетельство фактической длины", { exact: true })
        .fill("Measured length, no roll conversion");
      await mkdir("/tmp/production-mf-cutting-browser", {
        recursive: true,
      });
      for (const width of [390, 412, 1365]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `/tmp/production-mf-cutting-browser/form-${width}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await context.setOffline(true);
      await page
        .getByRole("button", {
          name: "Сохранить расход Cutting без отправки",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: /Отправить исходный расход Cutting/ })
        .waitFor();
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_cutting_consumptions WHERE organization_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe(0);
      await context.setOffline(false);
      await page.close();
      page = await context.newPage();
      await mount();
      const bodies: string[] = [];
      await page.route(
        "**/inventory/room-materials/cutting/consumptions",
        async (route: any) => {
          if (route.request().method() !== "POST") return route.continue();
          bodies.push(route.request().postData()!);
          const reply = await route.fetch();
          if (bodies.length === 1) {
            expect(reply.status()).toBe(201);
            await route.abort("failed");
          } else await route.fulfill({ response: reply });
        },
      );
      await page
        .getByRole("button", { name: /Отправить исходный расход Cutting/ })
        .click();
      await page.getByRole("alert").waitFor();
      await page
        .getByRole("button", { name: /Отправить исходный расход Cutting/ })
        .click();
      await page
        .getByText(/Сервер подтвердил фактический расход Cutting/)
        .waitFor();
      await page.getByText(/осталось 0.09/).waitFor();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[0])).toMatchObject({
        actualLengthMm: 150,
        materialId: source.inputs.materialId,
      });
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_cutting_consumptions WHERE organization_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT on_hand,revision FROM inventory_stocks WHERE id=$1",
            [source.inputs.foil.stockId],
          )
        ).rows,
      ).toEqual(warehouseBefore);
      expect(errors).toEqual([]);
      await mkdir("/tmp/production-mf-cutting-browser", {
        recursive: true,
      });
      for (const width of [390, 412, 1365]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `/tmp/production-mf-cutting-browser/cutting-${width}.png`,
          fullPage: true,
        });
      }
      await writeFile(
        "/tmp/production-mf-cutting-browser/result.json",
        JSON.stringify(
          {
            passed: true,
            offlineSaved: true,
            reopened: true,
            lostCommittedReply: true,
            identicalOriginalBodies: true,
            warehouseUnchangedByUse: true,
            sourceMeasuredMm: 240,
            actualMm: 150,
            remainingMm: 90,
            capacityBasis: "calendered_measured_roll_length",
            viewports: [390, 412, 1365],
            sourceRef: process.env.GITHUB_SHA ?? "local-working-tree",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("/tmp/production-mf-cutting-browser", {
        recursive: true,
      });
      const pages = context.pages();
      if (pages.length) {
        await pages.at(-1)!.screenshot({
          path: "/tmp/production-mf-cutting-browser/failure.png",
          fullPage: true,
        });
        await writeFile(
          "/tmp/production-mf-cutting-browser/failure.txt",
          await pages.at(-1)!.locator("body").innerText(),
        );
      }
      throw error;
    } finally {
      await browser.close();
      await unlink(file).catch(() => {});
      await f.app.close();
      await f.pool.end();
      await vite.close();
    }
  }, 60000);
});
