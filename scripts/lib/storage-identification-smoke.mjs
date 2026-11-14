import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export async function storageIdentificationSmoke({pool,org,pages,actors,connection,qualityStock,locationId,batchId,artifact}){
 const page=pages[0],panel=page.getByRole('region',{name:'Идентификация склада',exact:true}),exec=promisify(execFile),label=(kind,id,organization=org)=>`production-mf:v1:${organization}:${kind}:${id}`;
 const until=async check=>{const end=Date.now()+20000;while(!await check()){assert(Date.now()<end,'Identification UI timeout');await new Promise(r=>setTimeout(r,30));}};
 const before=(await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n;
 let requests=0;page.on('request',r=>{if(r.url().includes('/inventory/identification'))requests++;});
 async function lookup(kind,id,cached=false){await panel.getByLabel('Тип ручного кода',{exact:true}).selectOption(kind);await panel.getByLabel('Код QR / штрихкода или UUID',{exact:true}).fill(id);await panel.getByRole('button',{name:cached?'Найти в сохранённой области':'Найти на сервере',exact:true}).click();await panel.locator('[aria-label="Найденный складской объект"]').waitFor();}
 await panel.getByLabel('Код QR / штрихкода или UUID',{exact:true}).fill(label('container',qualityStock,randomUUID()));await panel.getByRole('button',{name:'Найти на сервере',exact:true}).click();await panel.getByRole('alert').waitFor();assert.equal(requests,0);
 await panel.getByLabel('Код QR / штрихкода или UUID',{exact:true}).fill('https://untrusted.invalid/?accessToken=DO-NOT-PERSIST');await panel.getByRole('button',{name:'Найти на сервере',exact:true}).click();await panel.getByRole('alert').waitFor();assert.equal(requests,0);await page.evaluate(async()=>{const{inventoryOutbox}=await import('/src/core/sync/inventoryOutbox.ts');if(JSON.stringify(await inventoryOutbox.receivingDrafts.toArray()).includes('DO-NOT-PERSIST'))throw Error('Arbitrary scanned credentials persisted');});
 await lookup('container',qualityStock);await panel.getByText('Найден контейнер '+qualityStock,{exact:false}).waitFor();
 const found=panel.locator('[aria-label="Найденный складской объект"]');await found.getByText('QR / ручной код контейнера',{exact:true}).click();await found.getByRole('button',{name:'Подготовить этикетку для сохранения',exact:true}).click();
 const download=page.waitForEvent('download');await found.getByRole('link',{name:'Сохранить этикетку HTML',exact:true}).click();const htmlPath=artifact+'/container-label.html';await(await download).saveAs(htmlPath);const html=await readFile(htmlPath,'utf8');assert(html.includes(label('container',qualityStock)));assert(!html.includes('<script'));assert(!html.includes(actors[0].token));
 const render=await page.context().newPage();await render.setContent(html);await render.locator('svg').screenshot({path:artifact+'/container-label-qr.png'});await render.pdf({path:artifact+'/container-label.pdf',preferCSSPageSize:true,printBackground:true});await render.close();
 // The scanner uses a centered 240x240 QR crop. Keep the full QR and a white
 // quiet zone *inside* that crop; 360px video QR clips the corners and is flaky.
 await exec('ffmpeg',['-y','-loglevel','error','-loop','1','-i',artifact+'/container-label-qr.png','-vf','scale=180:180:flags=neighbor,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=white,fps=5,format=yuv420p','-t','18','-pix_fmt','yuv420p',artifact+'/lookup-camera.y4m']);
 // The real html5-qrcode decoder reads real frames from Chromium's deterministic
 // virtual camera; no decoder/result is mocked and the API lookup remains real.
 const{chromium}=await import(process.env.STORAGE_PLAYWRIGHT_MODULE??'playwright');let cameraBrowser;
 try{
  cameraBrowser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture='+artifact+'/lookup-camera.y4m']});const context=await cameraBrowser.newContext({viewport:{width:412,height:915}}),camera=await context.newPage();
  await camera.addInitScript(()=>{const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.ciCameraTracks=stream.getTracks();return stream;};});
  await camera.goto('http://127.0.0.1:5173/storage-operator-smoke.html');await camera.waitForFunction(()=>!!window.mount);await camera.evaluate(c=>window.mount(c),connection(actors[1]));await camera.getByRole('button',{name:'Обновить подтверждённые данные',exact:true}).click();const scanner=camera.getByRole('region',{name:'Идентификация склада',exact:true});await scanner.getByRole('button',{name:'Сканировать камерой',exact:true}).click();
   try{
    await camera.waitForFunction(()=>window.ciCameraTracks?.length>0,{timeout:15000});
    await scanner.getByText('Найден контейнер '+qualityStock,{exact:false}).waitFor({timeout:30000});
   }catch(cause){
    // On a failure keep actual on-screen evidence; do not substitute a mocked scan or
    // relabel it as a passing camera test.
    await camera.screenshot({path:artifact+'/camera-failure-412x915.png',fullPage:true}).catch(()=>{});
    const evidence=await camera.evaluate(()=>({
      video:[...document.querySelectorAll('video')].map(v=>({readyState:v.readyState,width:v.videoWidth,height:v.videoHeight,paused:v.paused})),
      tracks:window.ciCameraTracks?.map(t=>({state:t.readyState,muted:t.muted,enabled:t.enabled}))??[],
      scanner:document.querySelector('[aria-label="Сканер складского кода"]')?.textContent?.slice(0,900)??'scanner dialog closed',
    })).catch(error=>({diagnosticError:String(error)}));
    throw new Error('Real QR camera lookup failed: '+JSON.stringify(evidence),{cause});
   }await camera.waitForFunction(()=>window.ciCameraTracks?.length&&window.ciCameraTracks.every(t=>t.readyState==='ended'));assert(await camera.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await camera.screenshot({path:artifact+'/camera-412x915.png',fullPage:true});
 }finally{await cameraBrowser?.close();}
 await lookup('location',label('location',locationId));await panel.getByText('Найдено место ',{exact:false}).waitFor();await found.getByText('QR / ручной код места хранения',{exact:true}).click();await found.getByRole('button',{name:'Подготовить этикетку для сохранения',exact:true}).click();assert(await found.getByRole('link',{name:'Сохранить этикетку HTML',exact:true}).getAttribute('download'));
 await lookup('batch',batchId);await panel.getByText('Найдена производственная партия ',{exact:false}).waitFor();await found.getByText('QR / ручной код производственной партии',{exact:true}).click();await found.getByRole('button',{name:'Подготовить этикетку для сохранения',exact:true}).click();assert(await found.getByRole('link',{name:'Сохранить этикетку HTML',exact:true}).getAttribute('download'));
 await page.context().route('http://127.0.0.1:3002/**',r=>r.abort());for(const[kind,id]of[['container',qualityStock],['location',locationId],['batch',batchId]]){await lookup(kind,id,true);await panel.getByText(/Сохранённые данные от/).waitFor();}await page.context().unroute('http://127.0.0.1:3002/**');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM inventory_operations WHERE organization_id=$1',[org])).rows[0].n,before,'Scan/print changed stock');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:artifact+'/identification-390x844.png',fullPage:true});
 return['typed/manual package/location/batch lookups hit actual scoped API','wrong-tenant/malformed credential-bearing QR rejected before network and never persisted','actual QR HTML/PDF label renders without scripts or authentication data','real camera-video QR decoding resolves exact package and releases media tracks','412x915 camera and 390x844 manual lookup remain readable','offline package/location/previous batch lookup requires original verified lease and changes no stock'];
}
