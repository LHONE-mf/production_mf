import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { createInventoryHandoffFixture } from "./inventory-test-fixture.js";
describe.skipIf(
  !process.env.POSTGRES_TEST_URL || !process.env.WIP_BROWSER_MODULE,
)("Tape catalogue, receiving and issue mobile screens", () => {
  it("creates an explicit tape SKU, receives whole rolls offline and retries the identical attributed issue after a lost reply", async () => {
    const { createServer } = await import(
      new URL("../../../node_modules/vite/dist/node/index.js", import.meta.url)
        .href
    );
    const vite = await createServer({
      root: new URL("../../../", import.meta.url).pathname,
      server: { host: "127.0.0.1", port: 5173, strictPort: false, hmr: false },
    });
    await vite.listen();
    const origin = new URL(vite.resolvedUrls.local[0]).origin;
    process.env.CORS_ALLOWED_ORIGINS = origin;
    const f = await createInventoryHandoffFixture(undefined, true),
      file = new URL(
        "../../../.tape-browser-" + randomUUID() + ".html",
        import.meta.url,
      );
    const { chromium } = await import(process.env.WIP_BROWSER_MODULE!);
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
      const serverUrl = await f.app.listen({ port: 0, host: "127.0.0.1" }),
        scope = {
          serverUrl,
          organizationId: f.org,
          actorId: f.actors[0].id,
          deviceId: f.actors[0].device,
        },
        session = {
          serverUrl,
          accessToken: f.actors[0].token,
          deviceProofToken: f.actors[0].proof,
          deviceProofDeviceId: f.actors[0].device,
          deviceProofExpiresAt: Date.now() + 300000,
        },
        localActorId = "browser-tape-author";
      await writeFile(
        file,
        `<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
    import React from'react';import{createRoot}from'react-dom/client';import{StorageAdministration}from'/src/stages/storage/StorageAdministration.tsx';import{ReceivingForm}from'/src/stages/storage/ReceivingForm.tsx';import{InventoryIssuesPanel}from'/src/stages/storage/InventoryIssues.tsx';import{loadInventoryMaterials,loadInventoryLocations,loadWarehouseAccess}from'/src/core/sync/inventoryCatalogClient.ts';import{pushInventoryReceipts}from'/src/core/sync/inventoryClient.ts';import'/src/index.css';
    const root=createRoot(document.getElementById('root'));window.mount=async props=>{const materials=(await loadInventoryMaterials(props.session,props.scope)).items,locations=(await loadInventoryLocations(props.session,props.scope)).items,access=await loadWarehouseAccess(props.session,props.scope);root.render(React.createElement('main',{className:'mx-auto max-w-5xl space-y-4 p-3'},React.createElement(StorageAdministration,{...props,materials,locations,access,onChanged:()=>window.mount(props)}),React.createElement(ReceivingForm,{...props,materials,locations,onQueued:()=>{}}),React.createElement('button',{onClick:async()=>{await pushInventoryReceipts(props.session,props.scope);document.getElementById('synced').textContent='Receipt sent';}},'Send queued receipt'),React.createElement('p',{id:'synced'}),React.createElement(InventoryIssuesPanel,props)));};</script></html>`,
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
        .getByText("Администрирование склада · Chief", { exact: true })
        .click();
      await page
        .getByLabel("Код материала", { exact: true })
        .fill("BROWSER-TAPE");
      await page
        .getByLabel("Название материала", { exact: true })
        .fill("Synthetic phone tape");
      await page
        .getByLabel("Полиимидная лента · выдача целыми рулонами")
        .check();
      await page
        .getByLabel("Назначение ленты", { exact: true })
        .selectOption("coating_support");
      await page.getByLabel("Ширина ленты (мм)", { exact: true }).fill("12,50");
      await page
        .getByLabel("Толщина ленты (мкм)", { exact: true })
        .fill("25.00");
      await page
        .getByLabel("Документ спецификации ленты", { exact: true })
        .fill("Synthetic supplier drawing R2");
      await page
        .getByRole("button", { name: "Проверить новый материал", exact: true })
        .click();
      await page
        .getByRole("button", { name: /Подтвердить отправку предложения/ })
        .click();
      await page.getByText(/ID: .*Сервер подтвердил/).waitFor();
      const material = (
        await f.pool.query(
          "SELECT id,tape_specification FROM inventory_materials WHERE organization_id=$1 AND material_code='BROWSER-TAPE'",
          [f.org],
        )
      ).rows[0];
      expect(material.tape_specification.widthMm).toBe("12.50");
      await page
        .getByLabel("Материал приёмки", { exact: true })
        .selectOption(material.id);
      await page
        .getByLabel("Место приёмки", { exact: true })
        .selectOption(f.location);
      await page
        .getByLabel("Партия производителя", { exact: true })
        .fill("BROWSER-TAPE-LOT");
      // Documented incoming control is mandatory for new operator warehouse receipts.
      // Validate whole-roll preflight only after the provenance field is filled.
      await page
        .getByLabel("Документ / номер и дата входного контроля", { exact: true })
        .fill("TAPE-QC-2026-11-20");
      await page.getByLabel("Количество приёмки", { exact: true }).fill("0.5");
      await page
        .getByLabel("Основание приёмки / свидетельство", { exact: true })
        .fill("Three actual whole rolls");
      expect(
        await page.getByLabel("Единица приёмки", { exact: true }).inputValue(),
      ).toBe("rolls");
      await page
        .getByRole("button", { name: "Проверить приёмку", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: /без округления/ })
        .waitFor();
      await page.getByLabel("Количество приёмки", { exact: true }).fill("3");
      await context.setOffline(true);
      await page
        .getByRole("button", { name: "Проверить приёмку", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: "Сохранить приёмку в очередь",
          exact: true,
        })
        .click();
      await page.getByText(/Операция сохранена:/).waitFor();
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_stocks WHERE material_id=$1",
            [material.id],
          )
        ).rows[0].n,
      ).toBe(0);
      await context.setOffline(false);
      await page.close();
      page = await context.newPage();
      await mount();
      await page.getByText(/Операция сохранена:/).waitFor();
      await page
        .getByRole("button", { name: "Send queued receipt", exact: true })
        .click();
      await page.getByText("Receipt sent", { exact: true }).waitFor();
      const stock = (
        await f.pool.query(
          "SELECT id,on_hand FROM inventory_stocks WHERE material_id=$1",
          [material.id],
        )
      ).rows[0];
      expect(stock.on_hand).toBe("3");
      expect(
        (
          await f.post(`/inventory/stocks/${stock.id}/quality-dispositions`, {
            operationId: randomUUID(),
            stockId: stock.id,
            deviceId: f.actors[0].device,
            expectedRevision: 1,
            disposition: "release",
            reason: "Chief review",
            evidence: "Synthetic tape certificate",
          })
        ).statusCode,
      ).toBe(201);
      await page
        .getByRole("button", {
          name: "Обновить запросы и доступные партии",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Производственная партия и шаг", { exact: true })
        .selectOption(f.batch + ":2");
      await page
        .getByRole("button", {
          name: "Загрузить материалы и получателей шага",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Материал для производства", { exact: true })
        .selectOption(material.id);
      await page
        .getByLabel("Назначенный получатель", { exact: true })
        .selectOption(f.actors[5].id);
      await page
        .getByLabel("Запрашиваемое количество", { exact: true })
        .fill("2");
      await page
        .getByLabel("Операция применения ленты", { exact: true })
        .fill("Synthetic Coating operation card C-1");
      await page
        .getByLabel("Основание запроса материала", { exact: true })
        .fill("Two whole tape rolls");
      await page
        .getByLabel("Документ потребности", { exact: true })
        .fill("Synthetic requirement");
      await context.setOffline(true);
      await page
        .getByRole("button", {
          name: "Сохранить запрос без выдачи",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: /Отправить сохранённое действие/ })
        .waitFor();
      await context.setOffline(false);
      await page.close();
      page = await context.newPage();
      await mount();
      await page
        .getByRole("button", {
          name: "Обновить запросы и доступные партии",
          exact: true,
        })
        .click();
      const bodies: string[] = [];
      await page.route("**/inventory/issues", async (route: any) => {
        if (route.request().method() !== "POST") return route.continue();
        bodies.push(route.request().postData()!);
        const reply = await route.fetch();
        if (bodies.length === 1) {
          expect(reply.status()).toBe(201);
          await route.abort("failed");
        } else await route.fulfill({ response: reply });
      });
      await page
        .getByRole("button", { name: /Отправить сохранённое действие/ })
        .click();
      await page.getByRole("alert").waitFor();
      await page
        .getByRole("button", { name: /Отправить сохранённое действие/ })
        .click();
      await page
        .getByText(/Запросить материал · Операция: .*Сервер подтвердил/)
        .waitFor();
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      const request = JSON.parse(bodies[0]);
      expect(request.tapeSpecification).toEqual(material.tape_specification);
      expect(request.operationReference).toBe(
        "Synthetic Coating operation card C-1",
      );
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_issues WHERE material_id=$1",
            [material.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT on_hand FROM inventory_stocks WHERE id=$1",
            [stock.id],
          )
        ).rows[0].on_hand,
      ).toBe("3");
      expect(errors).toEqual([]);
      await mkdir("/tmp/production-mf-tape-browser", { recursive: true });
      for (const width of [390, 412, 1365]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `/tmp/production-mf-tape-browser/tape-${width}.png`,
          fullPage: true,
        });
      }
      await writeFile(
        "/tmp/production-mf-tape-browser/result.json",
        JSON.stringify(
          {
            passed: true,
            skuCreatedInUi: true,
            exactDimensions: true,
            wholeRollReceiptOffline: true,
            reopened: true,
            issueSavedOffline: true,
            lostCommittedReply: true,
            identicalOriginalBodies: true,
            warehouseUnchangedByRequest: true,
            viewports: [390, 412, 1365],
            sourceRef: process.env.GITHUB_SHA ?? "local-working-tree",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("/tmp/production-mf-tape-browser", { recursive: true });
      const pages = context.pages();
      if (pages.length) {
        await pages
          .at(-1)!
          .screenshot({
            path: "/tmp/production-mf-tape-browser/failure.png",
            fullPage: true,
          });
        await writeFile(
          "/tmp/production-mf-tape-browser/failure.txt",
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
