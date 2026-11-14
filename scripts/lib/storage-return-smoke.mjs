import assert from 'node:assert/strict';
export async function storageReturnSmoke({ pool, org, pages, actors, connection, issueId, qualityStock, locationId, artifact }) {
  const chief = pages[0], operator = pages[1];
  const until = async check => { const end = Date.now() + 20000; while (!await check()) { assert(Date.now() < end, 'Return UI/ledger timeout'); await new Promise(r => setTimeout(r, 30)); } };
  const refreshConfirmed = async page => { const button = page.getByRole('button', { name: 'Обновить подтверждённые данные', exact: true }); await button.click(); await until(() => button.isEnabled()); };
  const refresh = async page => { await refreshConfirmed(page); await page.getByRole('button', { name: 'Загрузить источники возврата', exact: true }).click(); await page.getByLabel('Полученная выдача для возврата', { exact: true }).selectOption(issueId); };
  const proposals = page => page.evaluate(async () => { const { inventoryOutbox } = await import('/src/core/sync/inventoryOutbox.ts'); return (await inventoryOutbox.receivingDrafts.toArray()).filter(r => JSON.parse(r.key)[2] === 'outcome'); });
  async function prepare(page, quantity, condition = 'untouched_unused', kind = 'return') {
    const before = new Set((await proposals(page)).map(r => r.operationId));
    await page.getByLabel('Вид возврата / списания', { exact: true }).selectOption(kind); await page.getByLabel('Количество возврата / списания', { exact: true }).fill(String(quantity));
    if (kind === 'return') { await page.getByLabel('Место возврата', { exact: true }).selectOption(locationId); await page.getByLabel('Состояние возврата', { exact: true }).selectOption(condition); }
    await page.getByLabel('Основание возврата / списания', { exact: true }).fill('Synthetic physical inspection: ' + condition + ' ' + kind);
    await page.getByLabel('Свидетельство состояния / списания', { exact: true }).fill('CI accountable condition/disposal report');
    await page.getByRole('button', { name: 'Сохранить возврат / списание без проведения', exact: true }).click(); await until(async () => (await proposals(page)).some(r => !before.has(r.operationId))); return (await proposals(page)).find(r => !before.has(r.operationId));
  }
  async function send(page, row, state = 'accepted') {
    await page.getByRole('button', { name: 'Подтвердить сохранённый возврат / списание ' + row.operationId.slice(0, 8), exact: true }).click();
    await until(async () => (await proposals(page)).some(r => r.operationId === row.operationId && r.fields.state === state));
    if (state === 'accepted') await until(() => page.getByRole('button', { name: 'Загрузить источники возврата', exact: true }).isEnabled());
  }
  await refresh(operator); assert.equal(await operator.getByRole('option', { name: 'Списать ранее выданное — Chief / Manager', exact: true }).count(), 0);
  const parentBefore = (await pool.query('SELECT on_hand::int,reserved::int,revision FROM inventory_stocks WHERE id=$1', [qualityStock])).rows[0];
  const rejected = await prepare(operator, 1, 'damaged'); await send(operator, rejected, 'conflict');
  const rejectedBody = JSON.parse(rejected.fields.request); assert.equal((await pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1', [rejectedBody.stockId])).rowCount, 0);
  await operator.context().route('http://127.0.0.1:3002/**', route => route.abort()); const original = await prepare(operator, 200000); await operator.context().unroute('http://127.0.0.1:3002/**');
  await operator.reload(); await operator.waitForFunction(() => !!window.mount); await operator.evaluate(c => window.mount(c), connection(actors[1])); await refresh(operator);
  assert.equal((await proposals(operator)).find(r => r.operationId === original.operationId).fields.request, original.fields.request, 'Cold reload lost return intent');
  let lost = false; await operator.context().route('**/inventory/issues/' + issueId + '/outcomes', async route => { if (route.request().method() === 'POST' && !lost) { await route.fetch(); lost = true; await route.abort(); } else await route.continue(); });
  await operator.getByRole('button', { name: 'Подтвердить сохранённый возврат / списание ' + original.operationId.slice(0, 8), exact: true }).click(); await operator.locator('[aria-label="Возвраты и списание выданного"]').getByRole('alert').waitFor(); await operator.context().unroute('**/inventory/issues/' + issueId + '/outcomes'); await send(operator, original);
  const returned = JSON.parse(original.fields.request), child = (await pool.query('SELECT quality,disposition,on_hand::int FROM inventory_stocks WHERE id=$1', [returned.stockId])).rows[0]; assert.deepEqual(child, { quality: 'released', disposition: 'release', on_hand: 200000 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_quality_dispositions WHERE stock_id=$1', [returned.stockId])).rows[0].n, 0, 'Normal return must not require another Chief QA');
  await refresh(chief); await refresh(operator);
  const [a, b] = await Promise.all([prepare(chief, 200000), prepare(operator, 200000)]);
  await Promise.all([chief, operator].map((page, i) => page.getByRole('button', { name: 'Подтвердить сохранённый возврат / списание ' + [a, b][i].operationId.slice(0, 8), exact: true }).click()));
  await until(async () => { const rows = await Promise.all([proposals(chief), proposals(operator)]); return ['accepted', 'conflict'].every(state => rows.some((list, i) => list.some(r => r.operationId === [a, b][i].operationId && r.fields.state === state))); });
  await refresh(chief); const scrap = await prepare(chief, 100000, 'untouched_unused', 'scrap'); await send(chief, scrap);
  assert.equal((await pool.query("SELECT COALESCE(sum(quantity) FILTER(WHERE kind='return'),0)::int AS returned,COALESCE(sum(quantity) FILTER(WHERE kind='scrap'),0)::int AS scrapped FROM inventory_issue_outcomes WHERE organization_id=$1 AND issue_id=$2", [org, issueId])).rows[0].returned, 400000);
  assert.equal((await pool.query("SELECT COALESCE(sum(quantity),0)::int AS n FROM inventory_issue_outcomes WHERE organization_id=$1 AND issue_id=$2 AND kind='scrap'", [org, issueId])).rows[0].n, 100000);
  assert.deepEqual((await pool.query('SELECT on_hand::int,reserved::int,revision FROM inventory_stocks WHERE id=$1', [qualityStock])).rows[0], parentBefore, 'Return/scrap must not debit warehouse source again');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1 AND kind='return'", [org])).rows[0].n, 2);
  await refreshConfirmed(chief);
  const warehouseChild=chief.locator('article').filter({hasText:'Контейнер: '+returned.stockId}).first();
  await warehouseChild.getByText('Перемещение / коррекция / списание контейнера',{exact:true}).click();await warehouseChild.getByLabel('Действие склада',{exact:true}).selectOption('scrap');
  await warehouseChild.getByLabel('Количество складского списания',{exact:true}).fill('1000');await warehouseChild.getByLabel('Основание изменения',{exact:true}).fill('Actual warehouse damaged portion disposed');await warehouseChild.getByLabel('Свидетельство складского списания',{exact:true}).fill('CI-WAREHOUSE-WASTE-42');
  await warehouseChild.getByRole('button',{name:'Проверить изменение',exact:true}).click();await warehouseChild.getByRole('button',{name:'Сохранить изменение в очередь',exact:true}).click();
  await chief.getByRole('button',{name:'Проверить отправку / повтор',exact:true}).click();await chief.getByRole('button',{name:'Подтвердить отправку тех же операций',exact:true}).click();
  await until(async()=> (await pool.query('SELECT on_hand::int FROM inventory_stocks WHERE id=$1',[returned.stockId])).rows[0].on_hand===199000);await refreshConfirmed(chief);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM inventory_operations WHERE stock_id=$1 AND kind='scrap' AND request_payload->>'evidence'='CI-WAREHOUSE-WASTE-42'",[returned.stockId])).rows[0].n,1);
  await warehouseChild.getByText('Полученная серверная история контейнера',{exact:true}).click();await warehouseChild.getByText(/CI-WAREHOUSE-WASTE-42/).first().waitFor();
  await chief.getByRole('button', { name: 'История возвратов и списаний', exact: true }).click(); await chief.getByText(/CI accountable condition\/disposal report/).first().waitFor();
  assert(await chief.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await chief.screenshot({ path: artifact + '/return-chief-mobile.png', fullPage: true });
  return ['unsafe damaged return rejected by real UI/API without stock', 'offline return cold reload retains original ID/provenance', 'lost committed return ACK exact retry creates one distinct AVAILABLE package without new QA', 'two profiles cannot return more than outstanding issue', 'Chief issued-material scrap reduces ownership without another warehouse debit','separate Chief warehouse-scrap UI debits unreserved stock once and exposes witness evidence'];
}
