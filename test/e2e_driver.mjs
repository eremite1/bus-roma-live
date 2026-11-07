// Prova: pannello richiudibile, schede andata/ritorno, traffico dai bus, modalità autista.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VENDOR = '/home/claude/vendor', DATA = '/home/claude/data';
const OUT = process.argv[2] || '/tmp/shots-drv';
mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const errors = [];
let feedN = 0, tiles = 0;
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(() => { window.__spoken = []; window.__vib = []; window.speechSynthesis.speak = (u) => window.__spoken.push(u.text); navigator.vibrate = (p) => { window.__vib.push(p); return true; }; });
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
  if (u.hostname === '127.0.0.1') return route.continue();
  if (u.hostname === 'unpkg.com') return route.fulfill({ status: 200, contentType: u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(`${VENDOR}/dist/${u.pathname.endsWith('.css') ? 'maplibre-gl.css' : 'maplibre-gl.js'}`) });
  if (u.hostname === 'tiles.openfreemap.org') return json({ version: 8, glyphs: 'https://glyphs.test/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#F2EFE9' } }] });
  if (u.hostname === 'glyphs.test') { const p = decodeURIComponent(u.pathname).split('/'); try { return route.fulfill({ body: readFileSync(`${VENDOR}/glyphs/${p[1].split(',')[0]}/${p[2]}`) }); } catch { return route.fulfill({ status: 404 }); } }
  if (u.hostname === 'proxy.test') {
    if (u.pathname === '/traffico-stato') return json({ tomtom: true });
    if (u.pathname.startsWith('/traffico/')) { tiles++; return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }); }
    if (u.pathname === '/tempi') { const n = JSON.parse(route.request().postData()).punti.length; return json({ tratti: Array.from({ length: n - 1 }, () => ({ s: 300, s0: 200, m: 900 })) }); }
    if (u.pathname.endsWith('/trips')) return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(`${DATA}/tu.pb`) });
    feedN++;
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(`${DATA}/feed${feedN === 1 ? 1 : 2}.pb`) });
  }
  if (u.hostname === 'api.transitous.org') return json([]);
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://127.0.0.1:8765/index.html?proxy=https://proxy.test');
await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('GPS'), null, { timeout: 15000 });
// linea 64
await page.click('#lineChip');
await page.fill('#lineInput', '64');
await page.click('#lineForm button');
await page.waitForSelector('.dir-tab', { timeout: 8000 });
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${OUT}/1-linea.png` });
console.log('schede:', (await page.$$eval('.dir-tab', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))));
console.log('mezzi in elenco (verso 1):', await page.locator('#lineView li[data-id]').count());
await page.click('.dir-tab:nth-child(2)');
console.log('mezzi in elenco (verso 2):', await page.locator('#lineView li[data-id]').count());
// abbasso il pannello toccando la mappa vuota, poi lo rialzo con la linguetta
await page.mouse.click(60, 330);
await new Promise((r) => setTimeout(r, 400));
console.log('pannello abbassato:', await page.evaluate(() => document.getElementById('sheet').classList.contains('peek')), 'altezza', await page.evaluate(() => document.getElementById('sheet').offsetHeight));
await page.screenshot({ path: `${OUT}/2-abbassato.png` });
await page.click('#sheetHandle');
console.log('rialzato:', !(await page.evaluate(() => document.getElementById('sheet').classList.contains('peek'))));
// cambio linea dal pannello
await page.fill('#lineChangeInput', '8');
await page.click('#lineChange button');
await page.waitForFunction(() => document.querySelector('#lineChangeInput')?.value === '8', null, { timeout: 5000 });
console.log('cambiata in linea 8:', await page.textContent('#lineChipText'));
await page.click('#sheetClose');
// traffico + autista
await page.click('#trafficChip');
await page.click('#driverChip');
await page.fill('#drvNo', '3456');
await page.click('#drvForm button');
await page.waitForFunction(() => document.querySelector('.drv-grid'), null, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 23000)); // secondo aggiornamento GPS: velocità e traffico
await page.screenshot({ path: `${OUT}/3-autista.png` });
console.log('autista:', (await page.textContent('#drvView')).replace(/\s+/g, ' ').slice(0, 400));
console.log('tratti di traffico:', await page.evaluate(() => window.__busMap.querySourceFeatures('traffic').length));
console.log('vibrazioni:', JSON.stringify(await page.evaluate(() => window.__vib)), 'voce:', JSON.stringify(await page.evaluate(() => window.__spoken)));
console.log('riquadri traffico TomTom caricati:', tiles);
await page.click('#drvLim');
await page.click('.lim-quick [data-m="30"]');
await page.waitForSelector('#limOut .rows li', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${OUT}/4-limitata.png` });
console.log('limitata:', (await page.textContent('#limOut')).replace(/\s+/g, ' ').slice(0, 420));
await page.click('#sheetClose');
await page.waitForSelector('#drvStop', { timeout: 5000 });
console.log('tornato al pannello autista: ok');
await page.click('#drvStop');
console.log('uscita autista ok:', await page.evaluate(() => !document.body.classList.contains('driving')));
await browser.close();
server.kill();
console.log('ERRORI:', errors.length ? errors : 'nessuno');
