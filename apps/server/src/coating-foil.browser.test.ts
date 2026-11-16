import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { createCoatingFoilFixture } from "./coating-foil-test-fixture.js";
describe.skipIf(
  !process.env.POSTGRES_TEST_URL || !process.env.WIP_BROWSER_MODULE,
)("Actual Coating foil mobile workflow", () => {
  it("saves measured foil use offline, reopens and retries the identical original body after a lost committed reply", async () => {
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
    const f = await createCoatingFoilFixture(),
      file = new URL(
        "../../../.foil-browser-" + randomUUID() + ".html",
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
      const source = await f.received(),
        warehouseBefore = (
          await f.pool.query(
            "SELECT on_hand,revision FROM inventory_stocks WHERE id=$1",
            [source.stockId],
          )
        ).rows;
      const serverUrl = await f.app.listen({ port: 0, host: "127.0.0.1" }),
        scope = {
          serverUrl,
          organizationId: f.org,
          actorId: f.actors[5].id,
          deviceId: f.actors[5].device,
        },
        session = {
          serverUrl,
          accessToken: f.actors[5].token,
          deviceProofToken: f.actors[5].proof,
          deviceProofDeviceId: f.actors[5].device,
          deviceProofExpiresAt: Date.now() + 300000,
        },
        localActorId = "browser-foil-author";
      await writeFile(
        file,
        `<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{CoatingFoilPanel}from'/src/stages/coating/CoatingFoil.tsx';import{db}from'/src/core/db/index.ts';import'/src/index.css';window.mount=async props=>{await db.users.put({id:props.localActorId,login:props.localActorId,fullName:'Synthetic foil worker',role:'worker',isActive:true,password:'test-only',createdAt:new Date()});createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto max-w-5xl space-y-3 p-3'},React.createElement(CoatingFoilPanel,props)));};</script></html>`,
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
        .getByRole("button", { name: "Обновить остатки фольги", exact: true })
        .click();
      await page.getByText(/осталось 800 mm/).waitFor();
      await page
        .getByLabel("Партия, шаг и материал фольги", { exact: true })
        .selectOption(f.batch + ":2:" + source.materialId);
      await page
        .getByRole("button", {
          name: "Подготовить измерение расхода фольги",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Время фактического расхода фольги", { exact: true })
        .fill("2026-11-16T12:00");
      await page
        .getByLabel("Карта / операция расхода фольги", { exact: true })
        .fill("Synthetic measured operation C-3");
      await page
        .getByLabel("Спецификация выбранной фольги", { exact: true })
        .fill("Explicit collector foil drawing");
      await page
        .getByLabel("Общий измеренный расход фольги, м", { exact: true })
        .fill("0.5");
      await page
        .getByLabel("Принятый лот фольги 1", { exact: true })
        .selectOption(source.issue.id);
      await page
        .getByLabel("Фактически по лоту 1, м", { exact: true })
        .fill("0.5");
      await page
        .getByLabel("Основание расхода фольги", { exact: true })
        .fill("Independently observed actual use");
      await page
        .getByLabel("Свидетельство измерения фольги", { exact: true })
        .fill("Measured length, no roll conversion");
      await context.setOffline(true);
      await page
        .getByRole("button", {
          name: "Сохранить расход фольги без отправки",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: /Отправить исходный расход фольги/ })
        .waitFor();
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_coating_foil_consumptions WHERE organization_id=$1",
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
        "**/inventory/room-materials/coating/foil-consumptions",
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
        .getByRole("button", { name: /Отправить исходный расход фольги/ })
        .click();
      await page.getByRole("alert").waitFor();
      await page
        .getByRole("button", { name: /Отправить исходный расход фольги/ })
        .click();
      await page.getByText(/Сервер подтвердил расход фольги/).waitFor();
      await page.getByText(/осталось 300 mm/).waitFor();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(JSON.parse(bodies[0])).toMatchObject({
        actualQuantity: 500,
        unit: "mm",
        materialId: source.materialId,
      });
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_coating_foil_consumptions WHERE organization_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT on_hand,revision FROM inventory_stocks WHERE id=$1",
            [source.stockId],
          )
        ).rows,
      ).toEqual(warehouseBefore);
      expect(errors).toEqual([]);
      await mkdir("/tmp/production-mf-foil-browser", { recursive: true });
      for (const width of [390, 412, 1365]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `/tmp/production-mf-foil-browser/foil-${width}.png`,
          fullPage: true,
        });
      }
      await writeFile(
        "/tmp/production-mf-foil-browser/result.json",
        JSON.stringify(
          {
            passed: true,
            offlineSaved: true,
            reopened: true,
            lostCommittedReply: true,
            identicalOriginalBodies: true,
            warehouseUnchangedByUse: true,
            issuedMm: 800,
            actualMm: 500,
            remainingMm: 300,
            viewports: [390, 412, 1365],
            sourceRef: process.env.GITHUB_SHA ?? "local-working-tree",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("/tmp/production-mf-foil-browser", { recursive: true });
      const pages = context.pages();
      if (pages.length) {
        await pages
          .at(-1)!
          .screenshot({
            path: "/tmp/production-mf-foil-browser/failure.png",
            fullPage: true,
          });
        await writeFile(
          "/tmp/production-mf-foil-browser/failure.txt",
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
