/** Real offline Formation UI + IndexedDB. All source data is SYNTHETIC. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(process.env.STORAGE_PLAYWRIGHT_MODULE??'playwright');
const harness=new URL('../formation-serial-smoke.html',import.meta.url),artifact=process.env.STORAGE_ARTIFACT_DIR??'/tmp/formation-serial-artifacts';
let vite,browser,created=false;
try{
 await mkdir(artifact,{recursive:true});
 await writeFile(harness,`<!doctype html><html lang="ru"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body class="bg-slate-900 text-slate-100"><p>SYNTHETIC engineering check — not factory data</p><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import Dexie from 'dexie';import '/src/index.css';import {db} from '/src/core/db/index.ts';import {UserRole} from '/src/core/types/index.ts';import {useAuthStore} from '/src/core/store/authStore.ts';import {FormationModule} from '/src/stages/formation/FormationRoom.tsx';import {syntheticFormationLineage} from '/tests/fixtures/formation-lineage.ts';
let root=createRoot(document.getElementById('root'));
window.mount=async(id='serial-worker')=>{const user=await db.users.get(id);useAuthStore.setState({currentUser:user});root.render(React.createElement(FormationModule));};
window.seed=async()=>{await db.open();await db.users.bulkAdd([['serial-chief',UserRole.CHIEF],['serial-worker',UserRole.WORKER],['other-worker',UserRole.WORKER]].map(([id,role])=>({id,role,login:id,fullName:id,password:'SYNTHETIC-test-only',isActive:true,createdAt:new Date()})));return syntheticFormationLineage('serial-chief','serial-worker');};
window.upgrade=async()=>{root.unmount();const names=db.tables.filter(t=>t.name!=='formationSerialIdentities').map(t=>t.name),stores=Object.fromEntries(names.map(n=>{const t=db.table(n);return[n,[t.schema.primKey.src,...t.schema.indexes.map(i=>i.src)].join(',')];})),rows=new Map();for(const n of names)rows.set(n,await db.table(n).toArray());db.close();await db.delete();const old=new Dexie(db.name);old.version(22).stores(stores);await old.open();for(const[n,data]of rows)if(data.length)await old.table(n).bulkAdd(data);old.close();await db.open();if(db.verno!==23||await db.formationSerialIdentities.count())throw Error('Bad populated v22 upgrade');for(const[n,data]of rows)if(JSON.stringify(await db.table(n).toArray())!==JSON.stringify(data))throw Error('Upgrade changed '+n);root=createRoot(document.getElementById('root'));await window.mount();return names.length;};
window.read=async()=>({rows:await db.formationSerialIdentities.toArray(),draft:(await db.localFormDrafts.get(JSON.stringify(['serial-worker','formation'])))?.payload,runs:await db.formationRuns.toArray()});
window.failJournal=()=>{const fail=()=>{throw Error('CI serial identity journal unavailable');};db.journal.hook('creating',fail);window.releaseJournal=()=>db.journal.hook('creating').unsubscribe(fail);};
await db.open();if(await db.users.get('serial-worker'))await window.mount();window.ready=true;
</script>`,{flag:'wx'});created=true;
 vite=await createServer({server:{host:'127.0.0.1',port:5173,strictPort:true}});await vite.listen();
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[],inventoryRequests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/inventory/'))inventoryRequests.push(r.url());});
 const go=async()=>{await page.goto('http://127.0.0.1:5173/formation-serial-smoke.html');await page.waitForFunction(()=>window.ready);};
 const open=async()=>{await page.getByRole('button',{name:'Номера обработанных',exact:true}).click();await page.getByRole('status').filter({hasText:/Автосохранение|Черновик формы/}).waitFor();};
 const until=async(check,label)=>{const end=Date.now()+20000;while(!await check()){assert(Date.now()<end,'Timed out: '+label);await new Promise(r=>setTimeout(r,30));}};
 await go();const source=await page.evaluate(()=>window.seed());await page.evaluate(()=>window.mount());await open();
 await page.getByLabel('Источник номеров формирования',{exact:true}).selectOption(source.id);await page.getByLabel('Явные номера обработанных ячеек',{exact:true}).fill('10; 10');await page.getByLabel('Основание номеров формирования',{exact:true}).fill('SYNTHETIC explicit processed channel sheet');
 await page.getByRole('button',{name:'Сохранить исходное заявление номеров',exact:true}).click();await page.getByRole('alert').filter({hasText:/без пересечений/}).waitFor();assert.equal((await page.evaluate(()=>window.read())).rows.length,0);
 await page.getByLabel('Явные номера обработанных ячеек',{exact:true}).fill('10; 12');await until(()=>page.evaluate(async()=>((await window.read()).draft)?.serials==='10; 12'),'durable explicit raw ranges');
 const upgradedTables=await page.evaluate(()=>window.upgrade());await open();assert.equal(await page.getByLabel('Явные номера обработанных ячеек',{exact:true}).inputValue(),'10; 12');
 await page.evaluate(()=>window.failJournal());await context.setOffline(true);await page.getByRole('button',{name:'Сохранить исходное заявление номеров',exact:true}).click();await page.getByRole('alert').filter({hasText:'CI serial identity journal unavailable'}).waitFor();
 const held=await page.evaluate(()=>window.read());assert.equal(held.rows.length,0);assert(held.draft.attempt);assert.deepEqual(held.draft.attempt.source,source);await page.evaluate(()=>window.releaseJournal());await context.setOffline(false);
 await go();await open();const recovered=await page.evaluate(()=>window.read());assert.deepEqual(recovered.draft.attempt,held.draft.attempt);assert.equal(await page.getByLabel('Явные номера обработанных ячеек',{exact:true}).inputValue(),'10; 12');
 await page.evaluate(()=>window.mount('other-worker'));await open();assert.equal(await page.getByLabel('Источник номеров формирования',{exact:true}).locator('option').count(),1);assert.deepEqual((await page.evaluate(()=>window.read())).draft.attempt,held.draft.attempt);
 await page.evaluate(()=>window.mount());await open();await context.setOffline(true);await page.getByRole('button',{name:'Сохранить исходное заявление номеров',exact:true}).click();await page.getByRole('button',{name:'Передать исходное заявление номеров',exact:true}).waitFor();
 const saved=await page.evaluate(()=>window.read());assert.equal(saved.rows.length,1);assert.equal(saved.rows[0].id,held.draft.attempt.id);assert.equal(saved.rows[0].count,2);assert.deepEqual(saved.rows[0].ranges,[{start:10,end:10},{start:12,end:12}]);assert.deepEqual(saved.runs,[source]);assert.deepEqual(saved.rows[0].source,source);assert.equal(source.serialRange.end-source.serialRange.start+1,4);assert.equal(source.cellsUnknown,1);assert.equal(source.cellsScrap,1);
 for(const width of [390,412,1365]){await page.setViewportSize({width,height:width===412?915:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Formation UI overflow at '+width);await page.screenshot({path:artifact+'/formation-serial-'+width+'.png',fullPage:true});}
 assert.deepEqual(inventoryRequests,[]);assert.deepEqual(errors,[]);
 const report={passed:true,synthetic:true,mainSchema:23,upgradedTables,fullInput:4,explicitProcessed:2,explicitRanges:saved.rows[0].ranges,scrap:1,unknown:1,originalDeclarationSurvivedReload:true,atomicJournalFailureRetried:true,offlineDeclaration:true,accountDraftIsolation:true,sourceUnchanged:true,warehouseRequests:0,qaRelease:false,limitation:'Local serial attribution only; authenticated finished-cell warehouse handoff and physical acceptance remain unfinished'};
 await writeFile(artifact+'/formation-serial-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();await vite?.close();if(created)await unlink(harness);}
