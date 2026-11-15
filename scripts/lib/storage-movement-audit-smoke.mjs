import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

export async function storageMovementAuditSmoke({pool,org,pages,artifact}){
 const count=(await pool.query(`SELECT c.operation_id,c.count_id,c.observation_id,c.quantity,
  c.observed_stock->>'onHand' AS before,o.actor_id AS observed_by,c.actor_id AS approved_by
  FROM inventory_count_events c JOIN inventory_count_events o ON o.organization_id=c.organization_id AND o.operation_id=c.observation_id
  WHERE c.organization_id=$1 AND c.kind='correct'`,[org])).rows[0];
 const split=(await pool.query('SELECT * FROM inventory_splits WHERE organization_id=$1',[org])).rows[0];
 const returned=(await pool.query("SELECT * FROM inventory_issue_outcomes WHERE organization_id=$1 AND kind='return' ORDER BY sequence",[org])).rows;
 const before=(await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n;
 for(const [i,page] of pages.entries()){
  const panel=page.getByLabel('Журнал движений склада',{exact:true});await panel.locator('summary').click();
  await panel.getByLabel('Фильтр по историческому месту',{exact:true}).fill('');
  await panel.getByLabel('Фильтр по типу движения',{exact:true}).selectOption('');
  await panel.getByRole('button',{name:'Показать журнал',exact:true}).click();
  const correction=panel.getByRole('group',{name:'Операция склада '+count.operation_id,exact:true});await correction.waitFor();
  const text=await correction.getByLabel('Подробности коррекции пересчёта',{exact:true}).textContent();
  for(const value of [count.count_id,count.observation_id,count.before,count.quantity,count.observed_by,count.approved_by])assert(text.includes(String(value)));
  assert(text.includes('Расхождение: -1000'));assert(text.includes('Само наблюдение не меняло остаток'));
  const qa=panel.getByLabel('Подробности решения QA',{exact:true});await qa.waitFor();assert((await qa.textContent()).includes('Разрешено'));
  const genealogy=panel.getByRole('group',{name:'Операция склада '+split.operation_id,exact:true});
  assert((await genealogy.textContent()).includes(split.child_stock_id));assert((await genealogy.textContent()).includes(split.child_operation_id));
  for(const row of returned){const card=panel.getByRole('group',{name:'Операция склада '+row.operation_id,exact:true});const detail=await card.getByLabel('Подробности происхождения возврата',{exact:true}).textContent();assert(detail.includes(row.source_stock_id)&&detail.includes(row.return_stock_id)&&detail.includes(row.issue_id));}
  const download=page.waitForEvent('download');
  await panel.getByRole('button',{name:i?'Скачать CSV страницы журнала':'Скачать весь срез до 10 000 строк',exact:true}).click();
  const file=await download,path=artifact+'/movement-audit-'+i+'.csv';await file.saveAs(path);
  const csv=await readFile(path,'utf8');for(const value of [count.count_id,count.observation_id,count.observed_by,count.approved_by,split.child_stock_id,'QA disposition','Count variance (signed)'])assert(csv.includes(value));
  assert(csv.includes('"\'-1000"'));assert(!/password_hash|request_payload|proofToken|accessToken/.test(csv));
  await correction.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:artifact+'/movement-audit-'+i+'.png',fullPage:true});
  await panel.locator('summary').click();
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n,before);
 return ['two-profile immutable QA/count/return/split report details match independent PostgreSQL evidence',
  'page and frozen full CSV preserve original observation/approval, genealogy and formula-safe signed variance'];
}
