/** Reproduce packaged PWA navigation before native instrumentation, with a real active worker. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(process.env.STORAGE_PLAYWRIGHT_MODULE ?? 'playwright');
const roots = ['android/app/src/debug/assets/public', 'dist'].map(path => resolve(path));
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname), relative = path === '/' ? '/index.html' : path;
    for (const root of roots) {
      const target = resolve(root, '.' + relative); if (!target.startsWith(root + sep)) continue;
      try { const data = await readFile(target); response.writeHead(200, { 'content-type': mime[extname(target)] ?? 'application/octet-stream' }); response.end(data); return; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error; }
    }
    response.writeHead(404); response.end();
  } catch { response.writeHead(500); response.end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
  const context = await browser.newContext(), page = await context.newPage();
  page.on('pageerror',error=>console.error('Packaged page error:',error.message));
  await page.goto(origin); await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration())?.active,undefined,{timeout:15000}); await page.reload();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller,undefined,{timeout:5000});
  await context.setOffline(true); await page.reload(); await page.locator('#root').waitFor();
  await page.waitForFunction(()=>(document.getElementById('root')?.textContent?.length??0)>20,undefined,{timeout:5000});
  await context.setOffline(false);
  await page.goto(origin + '/tests/android-storage/index.html');
  try { await page.waitForFunction(() => !!window.storageCi, undefined, { timeout: 5000 }); }
  catch { throw Error('Packaged Storage harness missing: '+JSON.stringify(await page.evaluate(()=>({path:location.pathname,title:document.title,controlled:!!navigator.serviceWorker.controller})))); }
  assert.equal(await page.title(), 'Storage — disposable Android CI');
  assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'Boot must work without clearing worker/cache/IndexedDB');
  console.log('PASS: active production PWA worker preserves offline shell and loads packaged Storage harness without fallback.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
