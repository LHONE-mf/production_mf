import {randomUUID} from 'node:crypto';
import {writeFile, unlink, mkdir} from 'node:fs/promises';
import {describe, it, expect, vi} from 'vitest';
import {createRoomHandoffFixture} from './room-handoff-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL || !process.env.WIP_BROWSER_MODULE)(
  'Actual Slurry → Coating mobile custody screens',
  () => {
    it('keeps offline measured output, retries original bytes after lost replies and requires a separate receiver observation', async () => {
      const viteModule = new URL('../../../node_modules/vite/dist/node/index.js', import.meta.url).href,
        {createServer} = await import(viteModule);
      const vite = await createServer({
        root: new URL('../../../', import.meta.url).pathname,
        server: {host: '127.0.0.1', port: 5173, strictPort: false, hmr: false},
      });
      await vite.listen();
      const origin = new URL(vite.resolvedUrls.local[0]).origin;
      process.env.CORS_ALLOWED_ORIGINS = origin;
      const f = await createRoomHandoffFixture(),
        file = new URL('../../../.custody-browser-' + randomUUID() + '.html', import.meta.url),
        {chromium} = await import(process.env.WIP_BROWSER_MODULE!);
      const browser = await chromium.launch({
        ...(process.env.WIP_BROWSER_EXECUTABLE ? {executablePath: process.env.WIP_BROWSER_EXECUTABLE} : {}),
        headless: true,
        args: ['--no-sandbox'],
      });
      const sender = await browser.newContext({viewport: {width: 390, height: 844}}),
        receiver = await browser.newContext({viewport: {width: 390, height: 844}});
      try {
        const {stockId, consumption} = await f.consumed(),
          before = (
            await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1', [stockId])
          ).rows;
        const serverUrl = await f.app.listen({port: 0, host: '127.0.0.1'});
        await writeFile(
          file,
          `<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
    import React from'react';import{createRoot}from'react-dom/client';import{RoomCustodyPanel}from'/src/stages/_common/RoomCustody.tsx';import{db}from'/src/core/db/index.ts';import'/src/index.css';
    window.mount=async props=>{await db.users.put({id:props.localActorId,role:'worker',isActive:true,fullName:'Synthetic custody operator',login:props.localActorId,createdAt:new Date()});createRoot(document.getElementById('root')).render(React.createElement(RoomCustodyPanel,props));};</script></html>`,
        );
        const url = origin + '/' + file.pathname.split('/').at(-1),
          props = (index: number, room: string) => ({
            session: {
              serverUrl,
              accessToken: f.actors[index].token,
              deviceProofToken: f.actors[index].proof,
              deviceProofDeviceId: f.actors[index].device,
              deviceProofExpiresAt: Date.now() + 60000,
            },
            scope: {
              serverUrl,
              organizationId: f.org,
              actorId: f.actors[index].id,
              deviceId: f.actors[index].device,
            },
            room,
            localActorId: 'browser-custody-' + index,
          });
        let page = await sender.newPage();
        const receiving = await receiver.newPage();
        const mount = async (p: any, index: number, room: string) => {
          p.on('pageerror', (e: Error) => console.error('Custody browser error:', e.message));
          await p.goto(url);
          await p.waitForFunction(() => typeof (window as any).mount === 'function');
          await p.evaluate((v: unknown) => (window as any).mount(v), props(index, room));
        };
        await mount(page, 4, 'slurry');
        await page.getByRole('button', {name: 'Обновить движение Slurry', exact: true}).click();
        await page.getByLabel('Подтверждённый расход для выпуска').selectOption(consumption.operationId);
        await page.getByRole('button', {name: 'Подготовить форму фактического выпуска', exact: true}).click();
        await page.getByRole('combobox', {name: /^Материал выхода 1/}).selectOption(f.material);
        await page.getByLabel('Фактическая масса выхода 1, г', {exact: true}).fill('0.9');
        await page.getByLabel('Измеренный брак, г', {exact: true}).fill('0.02');
        await page.getByLabel('Измеренные потери, г', {exact: true}).fill('0.03');
        await page.getByLabel('Неразнесённая масса, г', {exact: true}).fill('0.05');
        await page.getByLabel('Утверждённая спецификация выпуска').fill('Synthetic approved card');
        await page.getByLabel('Время фактического взвешивания').fill('2026-11-16T08:00');
        await page.getByLabel('Основание события').fill('Actual measured output');
        await page
          .getByLabel('Свидетельство измерения и сверки')
          .fill('Separate output, scrap, measured loss and unaccounted mass');
        await sender.setOffline(true);
        await page
          .getByRole('button', {name: 'Сохранить исходное событие без отправки', exact: true})
          .click();
        await page.getByRole('button', {name: /Отправить исходное событие/}).waitFor();
        expect(
          (
            await f.pool.query(
              'SELECT count(*)::int AS n FROM inventory_room_outputs WHERE organization_id=$1',
              [f.org],
            )
          ).rows[0].n,
        ).toBe(0);
        await sender.setOffline(false);
        await page.close();
        page = await sender.newPage();
        await mount(page, 4, 'slurry');
        const bodies: Record<string, string[]> = {};
        async function loseFirst(p: any, path: string) {
          bodies[path] = [];
          await p.route('**' + path, async (route: any) => {
            bodies[path].push(route.request().postData()!);
            const r = await route.fetch();
            if (bodies[path].length === 1) {
              expect(r.status()).toBe(201);
              await route.abort('failed');
            } else await route.fulfill({response: r});
          });
        }
        await loseFirst(page, '/inventory/room-outputs/slurry');
        await page.getByRole('button', {name: /Отправить исходное событие/}).click();
        await page.getByRole('alert').waitFor();
        await page.getByRole('button', {name: /Отправить исходное событие/}).click();
        await page.getByText(/Сервер подтвердил событие/).waitFor();
        const lot = (
          await f.pool.query('SELECT id FROM inventory_room_output_lots WHERE organization_id=$1', [f.org])
        ).rows[0].id;
        const originalForm = await page
          .getByLabel('Сохранённая форма')
          .locator('option')
          .nth(1)
          .getAttribute('value');
        await page.getByLabel('Сохранённая форма').selectOption(originalForm!);
        await page.getByLabel('Основание события').waitFor();
        await page.getByLabel('Лот для передачи в Coating').selectOption(lot);
        let blockedOptions: any;
        await page.route('**/inventory/room-handoffs/options?**', async (route: any) => {
          if (route.request().method() !== 'GET') await route.continue();
          else blockedOptions = route;
        });
        await page.getByRole('button', {name: 'Подготовить передачу выбранного лота', exact: true}).click();
        await vi.waitFor(() => expect(blockedOptions).toBeTruthy());
        expect(await page.getByLabel('Основание события').isDisabled()).toBe(true);
        const optionsReply = await blockedOptions.fetch();
        await blockedOptions.fulfill({response: optionsReply});
        await page.unroute('**/inventory/room-handoffs/options?**');

        await page.getByLabel('Назначенный получатель Coating').selectOption(f.actors[5].id);
        await page.getByLabel('Фактически передаваемая масса, г').fill('0.4');
        await page.getByLabel('Основание события').fill('Actual transfer');
        await page.getByLabel('Свидетельство измерения и сверки').fill('Observed transfer container');
        await page
          .getByRole('button', {name: 'Сохранить исходное событие без отправки', exact: true})
          .click();
        await loseFirst(page, '/inventory/room-handoffs');
        await page.getByRole('button', {name: /Отправить исходное событие/}).click();
        await page.getByRole('alert').waitFor();
        await page.getByRole('button', {name: /Отправить исходное событие/}).click();
        await page.getByText(/Отправка записана/).waitFor();
        await mount(receiving, 5, 'coating');
        await receiving.getByRole('button', {name: 'Обновить движение Coating', exact: true}).click();
        await receiving.getByText('Подтверждённая масса в Coating: 0 г.', {exact: false}).waitFor();
        await receiving.getByRole('button', {name: /Подготовить наблюдение приёмки/}).click();
        await receiving.getByLabel('Результат физической приёмки').selectOption('discrepancy');
        await receiving.getByLabel('Фактически наблюдаемая масса, г').fill('0.399');
        await receiving.getByLabel('Основание события').fill('Mismatch at first count');
        await receiving.getByLabel('Свидетельство измерения и сверки').fill('Independent receiver scale');
        await receiving
          .getByRole('button', {name: 'Сохранить исходное событие без отправки', exact: true})
          .click();
        await receiving.getByRole('button', {name: /Отправить исходное событие/}).click();
        await receiving.getByText(/Расхождение — приёмка не подтверждена/).waitFor();
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM inventory_room_handoff_events WHERE organization_id=$1 AND kind='receive'",
              [f.org],
            )
          ).rows[0].n,
        ).toBe(0);
        await receiving.getByRole('button', {name: /Подготовить наблюдение приёмки/}).click();
        await receiving.getByLabel('Фактически наблюдаемая масса, г').fill('0.4');
        await receiving.getByLabel('Основание события').fill('Recount reconciled');
        await receiving
          .getByLabel('Свидетельство измерения и сверки')
          .fill('Exactly 0.4 g physically received');
        await receiver.setOffline(true);
        await receiving
          .getByRole('button', {name: 'Сохранить исходное событие без отправки', exact: true})
          .click();
        await receiving.getByRole('button', {name: /Отправить исходное событие/}).waitFor();
        await receiver.setOffline(false);
        await loseFirst(receiving, '/inventory/room-handoffs/acknowledgements');
        await receiving.getByRole('button', {name: /Отправить исходное событие/}).click();
        await receiving.getByRole('alert').waitFor();
        await receiving.getByRole('button', {name: /Отправить исходное событие/}).click();
        await receiving.getByText(/Подтверждённая масса в Coating: 0.4 г/).waitFor();
        for (const requests of Object.values(bodies)) {
          expect(requests).toHaveLength(2);
          expect(requests[0]).toBe(requests[1]);
        }
        expect(
          (await f.pool.query('SELECT on_hand,revision FROM inventory_stocks WHERE id=$1', [stockId])).rows,
        ).toEqual(before);
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM inventory_room_handoff_events WHERE organization_id=$1 AND kind='receive'",
              [f.org],
            )
          ).rows[0].n,
        ).toBe(1);
        await mkdir('/tmp/production-mf-custody-browser', {recursive: true});
        await page.getByLabel('Сохранённая форма').selectOption('');
        await receiving.getByLabel('Сохранённая форма').selectOption('');
        for (const width of [390, 412, 1365])
          for (const [p, room] of [
            [page, 'slurry'],
            [receiving, 'coating'],
          ] as const) {
            await p.setViewportSize({width, height: 900});
            expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await p.evaluate(() => {
              document.querySelectorAll('*').forEach((e) => {
                if (e.scrollTop) e.scrollTop = 0;
              });
              window.scrollTo(0, 0);
            });
            await p.screenshot({
              path: `/tmp/production-mf-custody-browser/${room}-${width}.png`,
              fullPage: true,
            });
          }
        await writeFile(
          '/tmp/production-mf-custody-browser/result.json',
          JSON.stringify(
            {
              passed: true,
              offlineSaved: true,
              reopened: true,
              lostCommittedOutputOfferReceipt: true,
              identicalOriginalBodies: true,
              discrepancyPreserved: true,
              warehouseUnchanged: true,
              outputMg: 900,
              offeredMg: 400,
              receivedMg: 400,
              senderAvailableMg: 500,
              viewports: [390, 412, 1365],
              sourceRef: process.env.GITHUB_SHA ?? 'local-working-tree',
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await mkdir('/tmp/production-mf-custody-browser', {recursive: true});
        for (const [context, name] of [
          [sender, 'sender'],
          [receiver, 'receiver'],
        ] as const) {
          const pages = context.pages();
          if (pages.length) {
            await pages
              .at(-1)!
              .screenshot({path: `/tmp/production-mf-custody-browser/${name}-failure.png`, fullPage: true});
            await writeFile(
              `/tmp/production-mf-custody-browser/${name}-failure.txt`,
              await pages.at(-1)!.locator('body').innerText(),
            );
          }
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
  },
);
