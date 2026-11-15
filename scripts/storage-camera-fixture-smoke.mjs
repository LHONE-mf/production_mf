/** The exact SYNTHETIC label whose resized camera video failed in PR CI. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {createServer} from 'vite';
import {prepareInventoryCameraFixture} from './lib/storage-identification-smoke.mjs';
const {chromium}=await import(process.env.STORAGE_PLAYWRIGHT_MODULE??'playwright');
const artifact=process.env.STORAGE_ARTIFACT_DIR??'/tmp/storage-camera-fixture',path=new URL('../storage-camera-fixture-smoke.html',import.meta.url);
const expected='production-mf:v1:25d5c152-65c8-4db7-96e5-102a941add31:container:2575ef80-2013-421b-a28e-f37a7e88a0df';
let vite,browser,cameraBrowser,created=false;
try{
 await mkdir(artifact,{recursive:true});await writeFile(path,`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root" style="width:344px"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import {QRCodeSVG} from 'qrcode.react';import {QrScanner} from '/src/transfer/QrScanner.tsx';import {inventoryLabelHtml} from '/src/core/sync/inventoryLabelPrinting.ts';import '/src/index.css';
const root=createRoot(document.getElementById('root')),label='${expected}';root.render(React.createElement(QRCodeSVG,{value:label,size:180,title:'SYNTHETIC fixed camera regression'}));
window.labelHtml=()=>inventoryLabelHtml('25d5c152-65c8-4db7-96e5-102a941add31','container','2575ef80-2013-421b-a28e-f37a7e88a0df','SYNTHETIC fixed camera regression',document.querySelector('svg').outerHTML);
const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.cameraTracks=stream.getTracks();return stream;};
window.scan=()=>root.render(React.createElement(QrScanner,{continuous:false,onClose:()=>root.unmount(),onResult:text=>{window.decoded=text;root.unmount();}}));window.ready=true;
</script>`,{flag:'wx'});created=true;
 vite=await createServer({server:{host:'127.0.0.1',port:5173,strictPort:true}});await vite.listen();
 const options={headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})};browser=await chromium.launch(options);const render=await browser.newPage();await render.goto('http://127.0.0.1:5173/storage-camera-fixture-smoke.html');await render.locator('svg').waitFor();const html=await render.evaluate(()=>window.labelHtml()),cameraVideo=await prepareInventoryCameraFixture(render,html,artifact);
 cameraBrowser=await chromium.launch({...options,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-video-capture='+cameraVideo]});const page=await cameraBrowser.newPage({viewport:{width:412,height:915}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:5173/storage-camera-fixture-smoke.html');await page.waitForFunction(()=>window.ready);await page.evaluate(()=>window.scan());
 try{await page.waitForFunction(()=>!!window.decoded,null,{timeout:10000});}catch(error){await page.screenshot({path:artifact+'/fixed-camera-failure.png',fullPage:true});throw error;}
 assert.equal(await page.evaluate(()=>window.decoded),expected);await page.waitForFunction(()=>window.cameraTracks?.length&&window.cameraTracks.every(track=>track.readyState==='ended'));assert.deepEqual(errors,[]);
 const result={passed:true,synthetic:true,exactFailedPayload:expected,realDecoder:true,realVideoFrames:true,mediaTracksEnded:true,limitation:'Deterministic virtual-camera fixture; physical camera/factory acceptance is separate'};await writeFile(artifact+'/camera-fixture-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await cameraBrowser?.close();await browser?.close();await vite?.close();if(created)await unlink(path);}
