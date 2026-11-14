import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

/** Real two-profile UI/API report, checked against independent PostgreSQL totals. */
export async function storageReconciliationSmoke({pool,org,pages,issueId,artifact}){
 const issue=(await pool.query('SELECT * FROM inventory_issues WHERE organization_id=$1 AND id=$2',[org,issueId])).rows[0];
 const totals=(await pool.query(`SELECT
  COALESCE(SUM(quantity) FILTER(WHERE kind='return'),0)::text AS returned,
  COALESCE(SUM(quantity) FILTER(WHERE kind='scrap'),0)::text AS scrapped
  FROM inventory_issue_outcomes WHERE organization_id=$1 AND issue_id=$2`,[org,issueId])).rows[0];
 const before=(await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n;
 for(const [i,page] of pages.entries()){
  await page.getByRole('button',{name:'Обновить подтверждённые данные',exact:true}).click();
  const panel=page.getByLabel('Сверка выданных материалов',{exact:true});
  await panel.locator('summary').click();
  await panel.getByLabel('Партия производства для сверки',{exact:true}).fill(issue.production_batch_id);
  await panel.getByLabel('Получатель для сверки',{exact:true}).fill(issue.recipient_id);
  await panel.getByLabel('Материал сверки выдач',{exact:true}).selectOption(issue.material_id);
  await panel.getByLabel('Исходный контейнер для сверки',{exact:true}).fill(issue.stock_id);
  await panel.getByRole('button',{name:'Показать сверку выдач',exact:true}).click();
  const row=panel.getByRole('group',{name:'Сверка выдачи '+issueId,exact:true});await row.waitFor();
  const text=await row.textContent();
  assert(text.includes('Принято: '+issue.quantity));assert(text.includes('Возвращено: '+totals.returned));
  assert(text.includes('Списано из выдачи: '+totals.scrapped));
  assert(text.includes('Неразнесено: '+(BigInt(issue.quantity)-BigInt(totals.returned)-BigInt(totals.scrapped))));
  assert(text.includes('Фактический расход: НЕ ЗАПИСАН'));
  const download=page.waitForEvent('download');
  await panel.getByRole('button',{name:i?'Скачать CSV страницы сверки':'Скачать весь срез сверки',exact:true}).click();
  const file=await download,path=artifact+'/issue-reconciliation-'+i+'.csv';await file.saveAs(path);
  const csv=await readFile(path,'utf8');assert(csv.includes('"NOT RECORDED"'));assert(csv.includes(issueId));
  assert(csv.includes('"Through issue sequence","Through outcome sequence"'));
  assert(!/accessToken|proofToken|password_hash|request_payload/.test(csv));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:artifact+'/issue-reconciliation-'+i+'.png',fullPage:true});
  // Changing the filter invalidates the old report and its download controls.
  await panel.getByLabel('Получатель для сверки',{exact:true}).fill(org);
  assert.equal(await panel.getByRole('group').count(),0);
  await panel.getByRole('button',{name:'Показать сверку выдач',exact:true}).click();
  await panel.getByText('Принятых выдач в выбранной области нет.',{exact:true}).waitFor();
  await panel.locator('summary').click();
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n,before);
 return ['two-profile batch/recipient/material/source reconciliation equals PostgreSQL outcomes',
  'full frozen and page reconciliation CSV preserve history and explicit unrecorded consumption',
  'report filters clear obsolete downloads without changing stock'];
}
