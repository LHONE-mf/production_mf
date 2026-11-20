import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
export async function storageCountSmoke({pool,org,pages,actors,connection,qualityStock,artifact}){
 const chief=pages[0],operator=pages[1],panel=p=>p.getByRole('region',{name:'Физические пересчёты',exact:true});
 const until=async check=>{const end=Date.now()+20000;while(!await check()){assert(Date.now()<end,'Count UI/ledger timeout');await new Promise(r=>setTimeout(r,30));}};
 const proposals=p=>p.evaluate(async()=>{const{inventoryOutbox:db}=await import('/src/core/sync/inventoryOutbox.ts');return(await db.receivingDrafts.toArray()).filter(r=>JSON.parse(r.key)[2]==='count');});
 const refresh=async p=>{const b=p.getByRole('button',{name:'Обновить подтверждённые данные',exact:true});await b.click();await until(()=>b.isEnabled());};
 const fill=async(p,reason)=>{await panel(p).getByLabel('Основание пересчёта / коррекции',{exact:true}).fill(reason);await panel(p).getByLabel('Свидетельство пересчёта / коррекции',{exact:true}).fill('CI-PHYSICAL-COUNT-42');};
 const latest=async(p,kind)=>{await until(async()=>(await proposals(p)).some(r=>r.fields.kind===kind));return(await proposals(p)).filter(r=>r.fields.kind===kind).at(-1);};
 const send=async(p,row)=>{await panel(p).getByRole('button',{name:'Подтвердить пересчёт '+row.operationId.slice(0,8),exact:true}).click();await until(async()=>(await proposals(p)).some(r=>r.operationId===row.operationId&&r.fields.state==='accepted'));};
 const exportCsv=async(p,name)=>{const downloaded=p.waitForEvent('download');await panel(p).getByRole('button',{name:'Скачать полный срез пересчёта CSV',exact:true}).click();const file=await downloaded,path=artifact+'/'+name;await file.saveAs(path);return readFile(path,'utf8');};
 // An earlier split regression reloads the Chief profile, closing its native
 // inventory disclosure. Restore the public operator navigation on both pages
 // instead of relying on UI expansion left over from another smoke test.
 const openCounts=async p=>{
  await p.getByRole('button',{name:'Тест: Инвентарь',exact:true}).click();
  const advanced=p.getByText('Дополнительные операции, инвентаризация и администрирование',{exact:true});
  if(!await advanced.evaluate(el=>el.closest('details')?.open??false))await advanced.click();
  await panel(p).getByRole('button',{name:'Загрузить пересчёты',exact:true}).waitFor({state:'visible'});
 };
 await openCounts(chief);await openCounts(operator);
 await refresh(operator);await panel(operator).getByRole('button',{name:'Загрузить пересчёты',exact:true}).click();await fill(operator,'Physical any-time operator count');await panel(operator).getByRole('button',{name:'Начать пересчёт — сохранить предложение',exact:true}).click();const opening=await latest(operator,'open');await send(operator,opening);const countId=JSON.parse(opening.fields.request).countId;
 await panel(operator).getByLabel('Сессия пересчёта',{exact:true}).selectOption(countId);await panel(operator).getByLabel('Контейнер пересчёта',{exact:true}).selectOption(qualityStock);
 const before=(await pool.query('SELECT on_hand::int,revision FROM inventory_stocks WHERE id=$1',[qualityStock])).rows[0],quantity=before.on_hand-1000;await panel(operator).getByLabel('Фактически посчитано',{exact:true}).fill(String(quantity));
 await operator.context().route('http://127.0.0.1:3002/**',r=>r.abort());await panel(operator).getByRole('button',{name:'Сохранить наблюдение без изменения остатка',exact:true}).click();const observed=await latest(operator,'observe');await operator.context().unroute('http://127.0.0.1:3002/**');assert.deepEqual((await pool.query('SELECT on_hand::int,revision FROM inventory_stocks WHERE id=$1',[qualityStock])).rows[0],before);
 await operator.reload();await operator.waitForFunction(()=>!!window.mount);await operator.evaluate(c=>window.mount(c),connection(actors[1]));
 // A reload returns the redesigned operator warehouse to the Receiving tab.
 // Reenter Inventory and explicitly reopen its advanced physical-count controls.
 await operator.getByRole('button',{name:'Тест: Инвентарь',exact:true}).click();
 await refresh(operator);
 await operator.getByText('Дополнительные операции, инвентаризация и администрирование',{exact:true}).click();assert.equal((await proposals(operator)).find(r=>r.operationId===observed.operationId).fields.request,observed.fields.request);
 let lost=false;await operator.context().route('**/inventory/counts/operations',async route=>{if(route.request().method()==='POST'&&!lost){await route.fetch();lost=true;await route.abort();}else await route.continue();});await panel(operator).getByRole('button',{name:'Подтвердить пересчёт '+observed.operationId.slice(0,8),exact:true}).click();await panel(operator).getByRole('alert').waitFor();await operator.context().unroute('**/inventory/counts/operations');await send(operator,observed);assert.deepEqual((await pool.query('SELECT on_hand::int,revision FROM inventory_stocks WHERE id=$1',[qualityStock])).rows[0],before);
 assert.equal(await panel(operator).getByRole('button',{name:/Проверить коррекцию по наблюдению/}).count(),0);
 await panel(operator).getByRole('button',{name:'Наблюдения и решения пересчёта',exact:true}).click();
 const unapproved=await exportCsv(operator,'count-unapproved.csv');assert(unapproved.includes('"observe"')&&!unapproved.includes('"correct"')&&!unapproved.includes('"close"'));assert(unapproved.includes(observed.operationId));
 await refresh(chief);await panel(chief).getByRole('button',{name:'Загрузить пересчёты',exact:true}).click();await panel(chief).getByLabel('Сессия пересчёта',{exact:true}).selectOption(countId);await fill(chief,'Chief reviewed original discrepancy and witness');await panel(chief).getByRole('button',{name:'Наблюдения и решения пересчёта',exact:true}).click();await panel(chief).getByRole('button',{name:'Проверить коррекцию по наблюдению '+observed.operationId.slice(0,8),exact:true}).click();const correction=await latest(chief,'correct');
 lost=false;await chief.context().route('**/inventory/counts/operations',async route=>{if(route.request().method()==='POST'&&!lost){await route.fetch();lost=true;await route.abort();}else await route.continue();});await panel(chief).getByRole('button',{name:'Подтвердить пересчёт '+correction.operationId.slice(0,8),exact:true}).click();await panel(chief).getByRole('alert').waitFor();await chief.context().unroute('**/inventory/counts/operations');await send(chief,correction);await refresh(chief);await refresh(operator);
 assert.deepEqual((await pool.query('SELECT on_hand::int,revision FROM inventory_stocks WHERE id=$1',[qualityStock])).rows[0],{on_hand:quantity,revision:before.revision+1});assert.equal((await pool.query("SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1 AND kind='count_adjustment'",[org])).rows[0].n,1);
 assert.equal(await exportCsv(operator,'count-frozen-before-approval.csv'),unapproved,'Another device approval changed the displayed count snapshot');
 await panel(operator).getByRole('button',{name:'Загрузить пересчёты',exact:true}).click();await panel(operator).getByLabel('Сессия пересчёта',{exact:true}).selectOption(countId);await panel(operator).getByRole('button',{name:'Завершить пересчёт — сохранить предложение',exact:true}).click();const closing=await latest(operator,'close');await send(operator,closing);assert.equal((await pool.query("SELECT count(*)::int AS n FROM inventory_count_events WHERE organization_id=$1 AND count_id=$2",[org,countId])).rows[0].n,4);
 const completed=await exportCsv(operator,'count-complete-history.csv');assert(completed.includes('"open"')&&completed.includes('"observe"')&&completed.includes('"correct"')&&completed.includes('"close"'));assert(completed.includes(observed.operationId)&&completed.includes(correction.operationId)&&completed.includes('"\'-1000"'));assert(!/request_payload|accessToken|proofToken/.test(completed));
 assert(await chief.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await chief.screenshot({path:artifact+'/count-chief-mobile.png',fullPage:true});return['operator starts count anytime without Chief approval','offline count/reopen/lost ACK retains immutable observation without any stock change','operator correction is hidden and Chief explicitly confirms original counted variance','lost correction ACK exact retry posts once; evidence/session close retained','unapproved-count CSV stays frozen across another device approval; refreshed full history exports distinct correction and closure'];
}
