import {randomUUID} from 'node:crypto';
import {writeFile,unlink,mkdir} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {createInventoryHandoffFixture} from './inventory-test-fixture.js';
describe.skipIf(!process.env.POSTGRES_TEST_URL||!process.env.WIP_BROWSER_MODULE)('Actual mobile Slurry material screen',()=>{
 it('preserves offline proposal, reopens, loses committed reply and retries the exact original body',async()=>{
  const viteModule=new URL('../../../node_modules/vite/dist/node/index.js',import.meta.url).href;
  const {createServer}=await import(viteModule),vite=await createServer({root:new URL('../../../',import.meta.url).pathname,server:{host:'127.0.0.1',port:5173,strictPort:false,hmr:false}});await vite.listen();
  const origin=new URL(vite.resolvedUrls.local[0]).origin;process.env.CORS_ALLOWED_ORIGINS=origin;
  const f=await createInventoryHandoffFixture(),file=new URL('../../../.wip-browser-'+randomUUID()+'.html',import.meta.url);
  const modulePath=process.env.WIP_BROWSER_MODULE!;
  const {chromium}=await import(modulePath),browser=await chromium.launch({...(process.env.WIP_BROWSER_EXECUTABLE?{executablePath:process.env.WIP_BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox']}),context=await browser.newContext({viewport:{width:390,height:844}});
  context.on('page',(p:any)=>p.on('pageerror',(error:Error)=>console.error('Slurry browser error:',error.message)));
  try{
   const {id:stockId,issue}=await f.reserved(600);
   for(const [kind,rev,actor,extra]of [['approve',2,1,{expectedStockRevision:3}],['dispatch',3,1,{expectedStockRevision:3}],['receive',4,4,{}]]as const)expect((await f.act(issue.id,f.operation(kind,rev,actor,extra),actor)).statusCode).toBe(201);
   const serverUrl=await f.app.listen({port:0,host:'127.0.0.1'}),localActorId='browser-slurry-author';
   const scope={serverUrl,organizationId:f.org,actorId:f.actors[4].id,deviceId:f.actors[4].device};
   const session={serverUrl,accessToken:f.actors[4].token,deviceProofToken:f.actors[4].proof,deviceProofDeviceId:f.actors[4].device,deviceProofExpiresAt:Date.now()+60000};
   await writeFile(file,`<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
    import React from 'react';import{createRoot}from'react-dom/client';import{SlurryMaterialsPanel}from'/src/stages/slurry/SlurryMaterials.tsx';import{db}from'/src/core/db/index.ts';import{saveSlurryBatch,SLURRY_UNITS}from'/src/core/manufacturing/slurryBatch.ts';import{SLURRY_BASIS,slurryMassBalance}from'/src/core/manufacturing/slurryMath.ts';import'/src/index.css';
    window.mount=async props=>{const workerId=props.localActorId,components=[{id:'binder',name:'Browser actual binder',kind:'binder',updatedAt:1,solidsMassFraction:1}],weighings=[{componentId:'binder',plannedG:9999,actualG:0.47}];await db.users.put({id:workerId,login:workerId,fullName:'Browser worker',role:'worker',isActive:true,password:'test-only',createdAt:new Date()});await db.mixComponents.bulkPut(components);const batch={id:'browser-measured-slurry',measurementVersion:1,batchCode:'BROWSER-ACTUAL',recipeName:'Browser measured binder',workerId,recordedRole:'worker',createdAt:1000,updatedAt:1000,measurementNote:'Actual browser scale observation',weighings,componentSnapshots:components,batchKg:9.999,recipePlan:{basis:SLURRY_BASIS,lines:[{componentId:'binder',pct:100}]},measurementUnits:SLURRY_UNITS,massBalance:slurryMassBalance(weighings,components)};await saveSlurryBatch(batch,workerId);createRoot(document.getElementById('root')).render(React.createElement(SlurryMaterialsPanel,props));};</script></html>`);
   let page=await context.newPage();const url=origin+'/'+file.pathname.split('/').at(-1);
   const mount=async()=>{await page.goto(url);await page.waitForFunction(()=>typeof (window as any).mount==='function');await page.evaluate((props:unknown)=>(window as any).mount(props),{session,scope,localActorId});};
   await mount();await page.getByRole('button',{name:'Обновить остатки Slurry',exact:true}).click();
   await page.getByText(/неразнесено 600 mg/).waitFor();
   await page.getByLabel('Сохранённый замес для расхода').selectOption('browser-measured-slurry');
   await page.getByLabel('Партия и операция Slurry').selectOption(f.batch+':1');await page.getByRole('button',{name:'Добавить исходный лот'}).click();
   await page.getByRole('combobox',{name:/^Компонент/}).selectOption('binder');await page.getByLabel('Принятый лот').selectOption(issue.id);await page.getByLabel('Распределено фактически, г').fill('0.47');
   await page.getByLabel('Основание расхода').fill('Measured actual use');await page.getByLabel('Свидетельство навесок и соответствия материала').fill('Scale and explicit lot mapping');
   await context.setOffline(true);await page.getByRole('button',{name:'Сохранить предложение расхода без отправки'}).click();await page.getByRole('button',{name:/Отправить исходный расход/}).waitFor();
   expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_slurry_consumptions WHERE organization_id=$1',[f.org])).rows[0].n).toBe(0);
   await context.setOffline(false);await page.close();page=await context.newPage();await mount();
   const bodies:string[]=[];await page.route('**/inventory/room-materials/slurry/consumptions',async (route:any)=>{bodies.push(route.request().postData()!);const reply=await route.fetch();if(bodies.length===1){expect(reply.status()).toBe(201);await route.abort('failed');}else await route.fulfill({response:reply});});
   await page.getByRole('button',{name:/Отправить исходный расход/}).click();await page.getByRole('alert').waitFor();
   await page.getByRole('button',{name:/Отправить исходный расход/}).click();await page.getByText(/Сервер подтвердил фактический расход/).waitFor();
   expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
   expect((await f.pool.query('SELECT on_hand FROM inventory_stocks WHERE id=$1',[stockId])).rows[0].on_hand).toBe('400');
   expect((await f.pool.query("SELECT sum(quantity)::text AS used FROM inventory_issue_outcomes WHERE organization_id=$1 AND kind='consume'",[f.org])).rows[0].used).toBe('470');
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await mkdir('/tmp/production-mf-wip-browser',{recursive:true});await page.screenshot({path:'/tmp/production-mf-wip-browser/slurry-390.png',fullPage:true});
   for(const width of [412,1365]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`/tmp/production-mf-wip-browser/slurry-${width}.png`,fullPage:true});}
   await writeFile('/tmp/production-mf-wip-browser/result.json',JSON.stringify({passed:true,offlineSaved:true,reopened:true,lostCommittedReply:true,identicalOriginalBodies:true,warehouseDebitedOnlyAtDispatch:true,consumedMg:470,sourceInputMg:600,roomRemainderMg:130,viewports:[390,412,1365],sourceRef:process.env.GITHUB_SHA??'local-working-tree'},null,2));
  }catch(error){await mkdir('/tmp/production-mf-wip-browser',{recursive:true});const pages=context.pages();if(pages.length){await pages.at(-1)!.screenshot({path:'/tmp/production-mf-wip-browser/failure.png',fullPage:true});await writeFile('/tmp/production-mf-wip-browser/failure.txt',await pages.at(-1)!.locator('body').innerText());}throw error;
  }finally{await browser.close();await unlink(file).catch(()=>{});await f.app.close();await f.pool.end();await vite.close();}
 },60000);
});
