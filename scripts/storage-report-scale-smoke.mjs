/** Real 10,000/10,001-event API/browser acceptance. Disposable CI database only. */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {createRequire} from 'node:module';
import {writeFile,readFile,unlink,mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {buildApp} from '../apps/server/dist/app.js';
import {tokenHash} from '../apps/server/dist/auth.js';
import {disposableDatabase} from './lib/disposable-migrations.mjs';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url)),{Pool}=require('pg');
const pool=new Pool({connectionString:disposableDatabase(process.env.POSTGRES_TEST_URL).toString()}),app=buildApp(pool);
const {chromium}=await import(process.env.STORAGE_PLAYWRIGHT_MODULE??'playwright');
const org=randomUUID(),actor=randomUUID(),token=randomBytes(32).toString('base64url'),material=randomUUID(),location=randomUUID();
const artifact=process.env.STORAGE_ARTIFACT_DIR??'/tmp/storage-artifacts',harness=new URL('../storage-report-scale.html',import.meta.url);
let device,proof,epoch,browser,vite,harnessCreated=false;
const headers=()=>({authorization:'Bearer '+token,...(proof?{'x-device-proof':proof}:{}),...(epoch?{'x-inventory-epoch':epoch}:{})});
async function post(path,payload,status=201){const r=await app.inject({method:'POST',url:path,headers:headers(),payload});assert.equal(r.statusCode,status,r.body);return r.json();}
async function receipt(n){return post('/inventory/receipts',{operationId:randomUUID(),stockId:randomUUID(),deviceId:device,materialId:material,locationId:location,manufacturerLot:'SYNTHETIC-SCALE-'+n,quantity:n,expectedRevision:0,reason:n===1?'=SYNTHETIC scale evidence':'SYNTHETIC scale acceptance'});}
try{
 const db=(await pool.query('SELECT current_database() AS name,current_user AS owner')).rows[0];
 assert.equal(db.name,'production_mf_ci');assert.equal(db.owner,'production_mf_ci');
 await mkdir(artifact,{recursive:true});
 await pool.query("INSERT INTO organizations(id,name) VALUES($1,'SYNTHETIC report-scale CI')",[org]);
 await pool.query("INSERT INTO users(id,organization_id,login,password_hash,role) VALUES($1::uuid,$2,$1::uuid::text,'test-only','chief')",[actor,org]);
 await pool.query("INSERT INTO sessions(id,organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[randomUUID(),org,actor,tokenHash(token)]);
 const keys=generateKeyPairSync('ed25519');device=(await post('/devices',{userId:actor,publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString()})).id;
 const challenge=await post('/devices/challenge',{deviceId:device},200);
 proof=(await post('/devices/challenge/verify',{deviceId:device,challengeId:challenge.challengeId,challenge:challenge.challenge,signature:sign(null,Buffer.from('production-mf:device-proof:v1:'+challenge.challenge),keys.privateKey).toString('base64url')},200)).proofToken;
 const stream=await app.inject({method:'GET',url:'/inventory/stream?deviceId='+device,headers:headers()});assert.equal(stream.statusCode,200,stream.body);epoch=stream.json().epoch;
 await post('/inventory/materials',{id:material,deviceId:device,code:'CI-SCALE',name:'SYNTHETIC scale powder',category:'raw_material',baseUnit:'mg'});
 await post('/inventory/locations',{id:location,deviceId:device,parentId:null,label:'SYNTHETIC scale warehouse',kind:'warehouse'});
 const started=Date.now();for(let n=1;n<=10_000;n++){await receipt(n);if(n%1000===0)console.log('Accepted SYNTHETIC receipts:',n);}
 const seedMs=Date.now()-started;
 await app.listen({host:'127.0.0.1',port:3002});
 await writeFile(harness,`<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{InventoryMovementsPanel}from'/src/stages/storage/InventoryMovementsPanel.tsx';import'/src/index.css';window.mount=p=>createRoot(document.getElementById('root')).render(React.createElement(InventoryMovementsPanel,p));</script></html>`,{flag:'wx'});harnessCreated=true;
 vite=await createServer({server:{host:'127.0.0.1',port:5173,strictPort:true,hmr:false}});await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(60_000);
 await page.goto('http://127.0.0.1:5173/storage-report-scale.html');await page.waitForFunction(()=>!!window.mount);
 await page.evaluate(p=>window.mount(p),{scope:{serverUrl:'http://127.0.0.1:3002',organizationId:org,actorId:actor,deviceId:device},session:{serverUrl:'http://127.0.0.1:3002',accessToken:token,deviceProofDeviceId:device,deviceProofToken:proof,deviceProofExpiresAt:Date.now()+300000},epoch,materials:[]});
 const panel=page.getByLabel('Журнал движений склада',{exact:true});await panel.locator('summary').click();await panel.getByRole('button',{name:'Показать журнал',exact:true}).click();
 await panel.getByRole('region',{name:'Результат журнала движений',exact:true}).waitFor();
 const fullStarted=Date.now(),download=page.waitForEvent('download');
 await panel.getByRole('button',{name:'Скачать весь срез до 10 000 строк',exact:true}).click();
 const file=await download,path=artifact+'/movements-exact-10000.csv';await file.saveAs(path);
 const csv=await readFile(path,'utf8'),lines=csv.trim().split('\r\n');assert.equal(lines.length,10_001);
 assert(csv.includes('SYNTHETIC-SCALE-10000'));assert(csv.includes('"\'=SYNTHETIC scale evidence"'));
 assert(!csv.includes(token)&&!csv.includes(proof));
 const upper=lines[1].split(',')[1];let exportedQuantity=0n;
 for(const [i,line] of lines.slice(1).entries()){
  const cells=line.split(',');assert.equal(cells[0],'"'+epoch+'"');assert.equal(cells[1],upper);
  assert.equal(cells[10],'"'+(i+1)+'"');assert.equal(cells[11],'"mg"');assert.equal(cells[12],cells[10]);assert.equal(cells[13],'"0"');
  exportedQuantity+=BigInt(i+1);
 }
 assert.equal(exportedQuantity,50005000n);
 assert.equal(new Set(lines.slice(1).map(line=>line.split(',')[4])).size,10_000);
 const exportMs=Date.now()-fullStarted;
 await receipt(10_001);await panel.getByRole('button',{name:'Показать журнал',exact:true}).click();
 await panel.getByText(/текущая страница: 50 записей/).waitFor();
 let partialFiles=0;page.on('download',()=>partialFiles++);
 await panel.getByRole('button',{name:'Скачать весь срез до 10 000 строк',exact:true}).click();
 const limitError=panel.getByRole('alert').filter({hasText:/Too many movement rows/});await limitError.waitFor();await limitError.scrollIntoViewIfNeeded();assert.equal(partialFiles,0,'Over-limit export created a partial file');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:artifact+'/movement-scale-over-limit-390.png',fullPage:true});
 const ledger=(await pool.query("SELECT count(*)::int AS events,SUM(quantity)::text AS quantity FROM inventory_operations WHERE organization_id=$1 AND kind='receive'",[org])).rows[0];
 assert.deepEqual(ledger,{events:10_001,quantity:'50015001'});assert.deepEqual(errors,[]);
 const result={passed:true,synthetic:true,acceptedEvents:10_001,exportedRows:10_000,overLimitPartialFiles:partialFiles,csvBytes:Buffer.byteLength(csv),seedMs,exportMs,viewport:'390x844',limitation:'Chromium engineering acceptance; physical Android memory, factory and deployment acceptance remain separate'};
 await writeFile(artifact+'/report-scale-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await vite?.close();await app.close();await pool.end();if(harnessCreated)await unlink(harness).catch(error=>{if(error.code!=='ENOENT')throw error;});}
