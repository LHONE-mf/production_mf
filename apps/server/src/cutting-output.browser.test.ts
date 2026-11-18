import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { createCuttingOutputFixture } from "./cutting-output-test-fixture.js";
describe.skipIf(
  !process.env.POSTGRES_TEST_URL || !process.env.WIP_BROWSER_MODULE,
)("Counted Cutting output and two-profile partial Sorting custody", () => {
  it("keeps original offline output/offer/receipt, separates discrepancy and preserves both lost replies", async () => {
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
    const f = await createCuttingOutputFixture(),
      file = new URL(
        "../../../.cut-piece-browser-" + randomUUID() + ".html",
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
      senderContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      receiverContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
    const errors: string[] = [];
    for (const c of [senderContext, receiverContext])
      c.on("page", (p: any) =>
        p.on("pageerror", (e: Error) => errors.push(e.message)),
      );
    try {
      const input = await f.inputs(),
        warehouse = (
          await f.pool.query(
            "SELECT id,on_hand,revision FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows;
      const serverUrl = await f.app.listen({ port: 0, host: "127.0.0.1" }),
        props = (actor: number, room: string) => ({
          scope: {
            serverUrl,
            organizationId: f.org,
            actorId: f.actors[actor].id,
            deviceId: f.actors[actor].device,
          },
          session: {
            serverUrl,
            accessToken: f.actors[actor].token,
            deviceProofToken: f.actors[actor].proof,
            deviceProofDeviceId: f.actors[actor].device,
            deviceProofExpiresAt: Date.now() + 300000,
          },
          localActorId: "roll-browser-" + actor,
          room,
        });
      await writeFile(
        file,
        `<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{CuttingOutputPanel}from'/src/stages/cutting/CuttingOutputs.tsx';import{db}from'/src/core/db/index.ts';import'/src/index.css';window.sortingWorkflowCount=()=>db.sortingWorkflows.count();window.mount=async props=>{await db.users.put({id:props.localActorId,login:props.localActorId,fullName:'Synthetic Cutting/Sorting operator',role:'worker',isActive:true,password:'test-only',createdAt:new Date()});createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto max-w-5xl space-y-3 p-3'},React.createElement(CuttingOutputPanel,props)));};</script></html>`,
      );
      const url = origin + "/" + file.pathname.split("/").at(-1),
        mount = async (page: any, actor: number, room: string) => {
          await page.goto(url);
          await page.waitForFunction(
            () => typeof (window as any).mount === "function",
          );
          await page.evaluate(
            (p: unknown) => (window as any).mount(p),
            props(actor, room),
          );
        };
      let sender = await senderContext.newPage();
      await mount(sender, 7, "cutting");
      await sender
        .getByRole("button", {
          name: "Обновить измерения для выпуска Cutting",
          exact: true,
        })
        .click();
      await sender
        .getByLabel("Партия, шаг и входной SKU выпуска", { exact: true })
        .selectOption(f.batch + ":4:" + input.consumption.materialId);
      await sender
        .getByRole("button", {
          name: "Подготовить выпуск Cutting",
          exact: true,
        })
        .click();
      await sender
        .getByRole("checkbox", {
          name: new RegExp(input.consumption.reference),
        })
        .check();
      await sender
        .getByLabel("Время наблюдения выпуска", { exact: true })
        .fill("2026-11-16T15:00");
      await sender
        .getByLabel("Карта или операция выпуска", { exact: true })
        .fill("Synthetic measured Cutting C-5");
      await sender
        .getByLabel("Спецификация выхода", { exact: true })
        .fill("Explicit coated electrode specification");
      await sender
        .getByLabel("SKU выхода 1", { exact: true })
        .selectOption(input.materialId);
      await sender
        .getByLabel("Маркировка исходного лота 1", { exact: true })
        .fill("BROWSER-COUNTED-LOT-A");
      await sender
        .getByLabel("Количество несортированных электродов 1, шт", {
          exact: true,
        })
        .fill("9");
      await sender
        .getByLabel("Состояние передачи лота 1", { exact: true })
        .selectOption("ready");
      await sender
        .getByLabel("Что известно о балансе и потерях", { exact: true })
        .fill("Mass and losses are unmeasured; no mass-length conversion");
      await sender
        .getByLabel("Основание выпуска", { exact: true })
        .fill("Actual independently counted unsorted lot");
      await sender
        .getByLabel("Свидетельство отдельного подсчёта выхода", {
          exact: true,
        })
        .fill("Independent measured length and physical label");
      const firstForm = await sender
        .getByLabel("Сохранённая форма выпуска Cutting", { exact: true })
        .inputValue();
      let release!: () => void, started!: () => void;
      const waiting = new Promise<void>((resolve) => {
          release = resolve;
        }),
        intercepted = new Promise<void>((resolve) => {
          started = resolve;
        });
      await sender.route(
        "**/inventory/cutting-outputs/materials?*",
        async (route: any) => {
          started();
          await waiting;
          await route.continue();
        },
      );
      await sender
        .getByRole("button", {
          name: "Подготовить выпуск Cutting",
          exact: true,
        })
        .click();
      await intercepted;
      expect(
        await sender
          .getByLabel("Маркировка исходного лота 1", { exact: true })
          .isDisabled(),
      ).toBe(true);
      release();
      await sender.waitForFunction(
        () =>
          !document.querySelector<HTMLSelectElement>(
            '[aria-label="Сохранённая форма выпуска Cutting"]',
          )!.disabled,
      );
      await sender.unroute("**/inventory/cutting-outputs/materials?*");
      await sender
        .getByLabel("Сохранённая форма выпуска Cutting", { exact: true })
        .selectOption(firstForm);
      await sender
        .getByLabel("Маркировка исходного лота 1", { exact: true })
        .waitFor();
      expect(
        await sender
          .getByLabel("Маркировка исходного лота 1", { exact: true })
          .inputValue(),
      ).toBe("BROWSER-COUNTED-LOT-A");
      await mkdir("/tmp/production-mf-cut-piece-browser", { recursive: true });
      await sender.screenshot({
        path: "/tmp/production-mf-cut-piece-browser/output-form-390.png",
        fullPage: true,
      });
      await senderContext.setOffline(true);
      await sender
        .getByRole("button", {
          name: "Сохранить выпуск Cutting без отправки",
          exact: true,
        })
        .click();
      await sender
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .waitFor();
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_cutting_outputs WHERE organization_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe(0);
      await senderContext.setOffline(false);
      await sender.close();
      sender = await senderContext.newPage();
      await mount(sender, 7, "cutting");
      const outputBodies: string[] = [];
      await sender.route("**/inventory/cutting-outputs", async (route: any) => {
        if (route.request().method() !== "POST") return route.continue();
        outputBodies.push(route.request().postData()!);
        const reply = await route.fetch();
        if (outputBodies.length === 1) {
          expect(reply.status()).toBe(201);
          await route.abort("failed");
        } else await route.fulfill({ response: reply });
      });
      await sender
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .click();
      await sender.getByRole("alert").waitFor();
      await sender
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .click();
      await sender
        .getByRole("button", {
          name: "Подготовить передачу BROWSER-COUNTED-LOT-A",
          exact: true,
        })
        .waitFor();
      expect(outputBodies).toHaveLength(2);
      expect(outputBodies[0]).toBe(outputBodies[1]);
      await sender
        .getByRole("button", {
          name: "Подготовить передачу BROWSER-COUNTED-LOT-A",
          exact: true,
        })
        .click();
      await sender
        .getByLabel("Количество к передаче, шт", { exact: true })
        .fill("4");
      await sender
        .getByLabel("Получатель электродов Sorting", { exact: true })
        .selectOption(f.actors[8].id);
      await sender
        .getByLabel("Основание действия с лотом", { exact: true })
        .fill("Actual direct handoff");
      await sender
        .getByLabel("Свидетельство действия с лотом", { exact: true })
        .fill("Counted partial lot handed to assigned Sorting receiver");
      await senderContext.setOffline(true);
      await sender
        .getByRole("button", {
          name: "Сохранить действие с лотом без отправки",
          exact: true,
        })
        .click();
      await sender
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .waitFor();
      await senderContext.setOffline(false);
      await sender
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .click();
      await sender
        .getByText(/Доступно для передачи 5; зарезервировано 4; принято 0/)
        .waitFor();
      let receiver = await receiverContext.newPage();
      await mount(receiver, 8, "sorting");
      await receiver
        .getByRole("button", {
          name: "Сообщить о несоответствии BROWSER-COUNTED-LOT-A",
          exact: true,
        })
        .click();
      await receiver
        .getByLabel("Фактически получено электродов, шт", { exact: true })
        .fill("0");
      await receiver
        .getByLabel("Маркировка полученного исходного лота", {
          exact: true,
        })
        .fill("OTHER-ROLL");
      await receiver
        .getByLabel("Как проверены количество и исходный лот", {
          exact: true,
        })
        .fill("Actual count and lot identity checked separately");
      await receiver
        .getByLabel("Основание действия с лотом", { exact: true })
        .fill("Physical mismatch");
      await receiver
        .getByLabel("Свидетельство действия с лотом", { exact: true })
        .fill("Different observed physical label");
      await receiver
        .getByRole("button", {
          name: "Сохранить действие с лотом без отправки",
          exact: true,
        })
        .click();
      await receiver
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .click();
      await receiver
        .getByText(/Есть записи проверки; получение ещё не подтверждено/)
        .waitFor();
      const offered = (
        await f.pool.query(
          "SELECT operation_id FROM inventory_room_handoffs WHERE organization_id=$1 AND result_payload->>'sourceRoom'='cutting' AND result_payload->>'destinationRoom'='sorting'",
          [f.org],
        )
      ).rows[0].operation_id;
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_room_handoff_events WHERE handoff_id=$1 AND kind='receive'",
            [offered],
          )
        ).rows[0].n,
      ).toBe(0);
      await receiver
        .getByRole("button", {
          name: "Подготовить получение BROWSER-COUNTED-LOT-A",
          exact: true,
        })
        .click();
      await receiver
        .getByLabel("Фактически получено электродов, шт", { exact: true })
        .fill("4");
      await receiver
        .getByLabel("Маркировка полученного исходного лота", {
          exact: true,
        })
        .fill("BROWSER-COUNTED-LOT-A");
      await receiver
        .getByLabel("Как проверены количество и исходный лот", {
          exact: true,
        })
        .fill("Independent piece count and source-lot label checked");
      await receiver
        .getByLabel("Основание действия с лотом", { exact: true })
        .fill("Separate actual Cutting receipt");
      await receiver
        .getByLabel("Свидетельство действия с лотом", { exact: true })
        .fill("Assigned receiver physical verification");
      await receiver.screenshot({
        path: "/tmp/production-mf-cut-piece-browser/receipt-form-390.png",
        fullPage: true,
      });
      await receiverContext.setOffline(true);
      await receiver
        .getByRole("button", {
          name: "Сохранить действие с лотом без отправки",
          exact: true,
        })
        .click();
      await receiver
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .waitFor();
      await receiverContext.setOffline(false);
      await receiver.close();
      receiver = await receiverContext.newPage();
      await mount(receiver, 8, "sorting");
      const receiptBodies: string[] = [];
      await receiver.route(
        "**/inventory/cutting-outputs/acknowledgements",
        async (route: any) => {
          receiptBodies.push(route.request().postData()!);
          const reply = await route.fetch();
          if (receiptBodies.length === 1) {
            expect(reply.status()).toBe(201);
            await route.abort("failed");
          } else await route.fulfill({ response: reply });
        },
      );
      await receiver
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .click();
      await receiver.getByRole("alert").waitFor();
      await receiver
        .getByRole("button", { name: /Отправить исходное действие с лотом/ })
        .click();
      await receiver
        .getByText(/Назначенный получатель подтвердил получение/)
        .waitFor();
      expect(receiptBodies).toHaveLength(2);
      expect(receiptBodies[0]).toBe(receiptBodies[1]);
      expect(JSON.parse(receiptBodies[0])).toMatchObject({
        kind: "receive",
        observedQuantity: 4,
        unit: "pieces",
        observedLotLabel: "BROWSER-COUNTED-LOT-A",
      });
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_cutting_outputs WHERE organization_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_cutting_output_claims WHERE organization_id=$1",
            [f.org],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM inventory_room_handoff_events WHERE handoff_id=$1 AND kind='receive'",
            [offered],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            "SELECT id,on_hand,revision FROM inventory_stocks WHERE organization_id=$1 ORDER BY id",
            [f.org],
          )
        ).rows,
      ).toEqual(warehouse);
      expect(
        await receiver.evaluate(() => (window as any).sortingWorkflowCount()),
      ).toBe(0);
      expect(errors).toEqual([]);
      await sender
        .getByRole("button", {
          name: "Обновить передачи электродов",
          exact: true,
        })
        .click();
      await sender
        .getByText(/Доступно для передачи 5; зарезервировано 4; принято 4/)
        .waitFor();
      for (const width of [390, 412, 1365])
        for (const [name, page] of [
          ["cutting", sender],
          ["sorting", receiver],
        ] as const) {
          await page.setViewportSize({ width, height: 900 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: `/tmp/production-mf-cut-piece-browser/${name}-${width}.png`,
            fullPage: true,
          });
        }
      await writeFile(
        "/tmp/production-mf-cut-piece-browser/result.json",
        JSON.stringify(
          {
            passed: true,
            twoProfiles: true,
            outputSavedOffline: true,
            offerSavedOffline: true,
            receiptSavedOffline: true,
            reopened: true,
            lostOutputReply: true,
            lostReceiptReply: true,
            identicalOriginalBodies: true,
            preparingFormDisablesPriorEdits: true,
            discrepancyCreatesNoCustody: true,
            receivedPieces: 4,
            automaticSortingWorkflowCreated: false,
            countedOutputPieces: 9,
            remainingPieces: 5,
            actualInputMm: 150,
            warehouseUnchanged: true,
            viewports: [390, 412, 1365],
            sourceRef: process.env.GITHUB_SHA ?? "local-working-tree",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("/tmp/production-mf-cut-piece-browser", { recursive: true });
      const pages = [...senderContext.pages(), ...receiverContext.pages()];
      if (pages.length) {
        await pages.at(-1)!.screenshot({
          path: "/tmp/production-mf-cut-piece-browser/failure.png",
          fullPage: true,
        });
        await writeFile(
          "/tmp/production-mf-cut-piece-browser/failure.txt",
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
  }, 120000);
});
