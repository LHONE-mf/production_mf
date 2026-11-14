import assert from 'node:assert/strict';
import { createDisposableIssueBatch } from './disposable-issue-batch.mjs';
export async function storageIssueSmoke({ pool, org, actors, pages, browser, connection, qualityStock, material, artifact }) {
  const fixture = await createDisposableIssueBatch(pool, org, actors[0].id, actors[2].id), chief = pages[0], operator = pages[1];
  const until = async check => { const deadline = Date.now() + 20000; while (!await check()) { assert(Date.now() < deadline, 'Issue UI/ledger timeout'); await new Promise(r => setTimeout(r, 30)); } };
  const refresh = async page => { await page.getByRole('button', { name: 'Обновить запросы и доступные партии', exact: true }).click(); await until(() => page.getByRole('button', { name: 'Обновить запросы и доступные партии', exact: true }).isEnabled()); await page.getByRole('form', { name: 'Запрос материала в производство', exact: true }).waitFor(); };
  const proposals = (page, kind, issueId) => page.evaluate(async ({ kind, issueId }) => { const { inventoryOutbox } = await import('/src/core/sync/inventoryOutbox.ts'); return (await inventoryOutbox.receivingDrafts.toArray()).filter(r => { if (JSON.parse(r.key)[2] !== 'issue') return false; const intent = JSON.parse(r.fields.intent); return intent.kind === kind && (!issueId || intent.issueId === issueId); }); }, { kind, issueId });
  const send = async (page, row) => { await page.getByRole('button', { name: 'Отправить сохранённое действие ' + row.operationId.slice(0, 8), exact: true }).click(); await until(async () => (await proposals(page, row.fields.kind, JSON.parse(row.fields.intent).issueId)).some(r => r.operationId === row.operationId && r.fields.state === 'accepted')); await until(() => page.getByRole('button', { name: 'Обновить запросы и доступные партии', exact: true }).isEnabled()); };
  await refresh(operator);
  await operator.getByLabel('Производственная партия и шаг', { exact: true }).selectOption(fixture.batchId + ':1'); await operator.getByRole('button', { name: 'Загрузить материалы и получателей шага', exact: true }).click();
  await operator.getByLabel('Материал для производства', { exact: true }).selectOption(material); await operator.getByLabel('Назначенный получатель', { exact: true }).selectOption(actors[2].id);
  await operator.getByLabel('Запрашиваемое количество', { exact: true }).fill('500000'); await operator.getByLabel('Основание запроса материала', { exact: true }).fill('Synthetic assigned batch requirement'); await operator.getByLabel('Документ потребности', { exact: true }).fill('CI batch requirement #42');
  await operator.context().route('http://127.0.0.1:3002/**', route => route.abort());
  await operator.getByRole('button', { name: 'Сохранить запрос без выдачи', exact: true }).click(); await until(async () => (await proposals(operator, 'request')).length === 1);
  const request = (await proposals(operator, 'request'))[0], intent = JSON.parse(request.fields.intent), issueId = intent.issueId;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_issues WHERE organization_id=$1', [org])).rows[0].n, 0);
  await operator.context().unroute('http://127.0.0.1:3002/**'); await operator.reload(); await operator.waitForFunction(() => !!window.mount); await operator.evaluate(c => window.mount(c), connection(actors[1])); await refresh(operator);
  assert.equal((await proposals(operator, 'request'))[0].fields.request, request.fields.request, 'Cold reload changed frozen request');
  await send(operator, request); const opCard = operator.locator('[aria-label="Выдача ' + issueId + '"]'); assert.equal(await opCard.getByRole('option', { name: 'Одобрить выдачу', exact: true }).count(), 0);
  const before = (await pool.query('SELECT on_hand::int FROM inventory_stocks WHERE id=$1', [qualityStock])).rows[0].on_hand;
  await refresh(chief);
  async function prepare(kind) {
    const card = chief.locator('[aria-label="Выдача ' + issueId + '"]'); await card.getByRole('button', { name: 'Загрузить контейнеры материала', exact: true }).click();
    if (kind === 'reserve') await card.getByLabel('Исходный контейнер', { exact: true }).selectOption(qualityStock);
    await card.getByLabel('Действие выдачи', { exact: true }).selectOption(kind); await card.getByLabel('Основание выдачи', { exact: true }).fill('Chief checked actual handoff: ' + kind); await card.getByLabel('Свидетельство передачи / одобрения', { exact: true }).fill('CI signed physical record: ' + kind);
    await card.getByRole('button', { name: 'Сохранить действие для отдельного подтверждения', exact: true }).click(); await until(async () => (await proposals(chief, kind, issueId)).length === 1); return (await proposals(chief, kind, issueId))[0];
  }
  await send(chief, await prepare('reserve')); assert.equal((await pool.query('SELECT on_hand::int FROM inventory_stocks WHERE id=$1', [qualityStock])).rows[0].on_hand, before);
  await send(chief, await prepare('approve')); assert.equal((await pool.query('SELECT on_hand::int FROM inventory_stocks WHERE id=$1', [qualityStock])).rows[0].on_hand, before);
  const dispatch = await prepare('dispatch'); let lost = false;
  await chief.context().route('**/inventory/issues/' + issueId + '/operations', async route => { if (!lost) { await route.fetch(); lost = true; await route.abort(); } else await route.continue(); });
  await chief.getByRole('button', { name: 'Отправить сохранённое действие ' + dispatch.operationId.slice(0, 8), exact: true }).click(); await chief.locator('[aria-label="Запросы и выдача в производство"]').getByRole('alert').waitFor(); await chief.context().unroute('**/inventory/issues/' + issueId + '/operations');
  await send(chief, dispatch);
  const recipientContext = await browser.newContext({ viewport: { width: 390, height: 844 } }), recipient = await recipientContext.newPage();
  const errors = []; recipient.on('pageerror', e => errors.push(e.message));
  try {
    await recipient.goto('http://127.0.0.1:5173/storage-operator-smoke.html'); await recipient.waitForFunction(() => !!window.mount); await recipient.evaluate(c => window.mount(c), connection(actors[2])); await refresh(recipient);
    const card = recipient.locator('[aria-label="Выдача ' + issueId + '"]'); assert.equal(await card.getByRole('button', { name: 'Загрузить контейнеры материала', exact: true }).count(), 0);
    const broad = await recipient.evaluate(async c => { const { inventoryRequest } = await import('/src/core/sync/inventoryClient.ts'); const r = await inventoryRequest(c.session, { serverUrl: c.serverUrl, organizationId: c.organizationId, actorId: c.serverActorId, deviceId: c.selectedDeviceId }, '/inventory/stocks?deviceId=' + c.selectedDeviceId); return r.status; }, connection(actors[2])); assert.equal(broad, 403);
    await card.getByLabel('Основание выдачи', { exact: true }).fill('Actual assigned recipient accepted package'); await card.getByLabel('Свидетельство передачи / одобрения', { exact: true }).fill('CI recipient record #42'); await card.getByRole('button', { name: 'Сохранить действие для отдельного подтверждения', exact: true }).click();
    await until(async () => (await proposals(recipient, 'receive', issueId)).length === 1); await send(recipient, (await proposals(recipient, 'receive', issueId))[0]);
    await card.getByRole('button', { name: 'История выдачи', exact: true }).click(); await card.getByText(/CI recipient record #42/).first().waitFor();
    assert(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await recipient.screenshot({ path: artifact + '/issue-recipient-mobile.png', fullPage: true }); assert.deepEqual(errors, []);
  } finally { await recipientContext.close(); }
  assert.deepEqual((await pool.query('SELECT on_hand::int,reserved::int FROM inventory_stocks WHERE id=$1', [qualityStock])).rows[0], { on_hand: before - 500000, reserved: 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1 AND stock_id=$2 AND kind='issue'", [org, qualityStock])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT state FROM inventory_issues WHERE id=$1', [issueId])).rows[0].state, 'received');
  await chief.screenshot({ path: artifact + '/issue-chief-mobile.png', fullPage: true });
  return ['offline issue request cold-reload preserves exact intent', 'actual Chief reservation/approval/dispatch screens', 'dispatch lost ACK exact retry deducts once', 'assigned recipient with no warehouse grant acknowledges without another debit', 'issue receipt is not consumption'];
}
