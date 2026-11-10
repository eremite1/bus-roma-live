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
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(`${DATA}/feed_rn.pb`) });
  }
  if (u.hostname === 'raw.githubusercontent.com') return json({ data: '2026-11-03', linee: { '913': { '7': { m: 10, k: 2, n: 30, s: 60, l: 6, e: 2 }, '8': { m: 14, k: 2, n: 40, s: 240, l: 20, e: 0 } } } });
  if (u.hostname === 'api.transitous.org') return json([]);
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://127.0.0.1:8765/index.html?proxy=https://proxy.test');
await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('GPS'), null, { timeout: 15000 });
await page.click('#rientriChip');
await page.waitForSelector('#rnPlace', { timeout: 10000 });
await page.fill('#rnLine', ''); await page.fill('#rnPlace', 'cavour'); await page.selectOption('#rnFrom', '0'); await page.selectOption('#rnTo', '24'); await page.click('#rnForm button[type=submit]');
const rows = await page.$$eval('#rnView li', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
console.log('rientri a Cavour:', rows.length, rows.slice(0, 3));
await page.click('[data-tab="uscite"]');
console.log('uscite da Cavour:', await page.locator('#rnView li').count());
await page.click('[data-tab="rientri"]');
await page.click('#rnView li[data-b="0#3748"] [data-tab-open]');
await page.waitForSelector('.tabella', { timeout: 5000 });
console.log('tabella righe:', await page.locator('.tabella tbody tr').count(), '| intestazione:', (await page.textContent('.sheet-body .head')).replace(/\s+/g, ' '), '| corrente:', (await page.textContent('.tb-cur')).replace(/\s+/g, ' '));
await page.screenshot({ path: `${OUT}/6-tabella.png` });
// storico
await page.click('#sheetClose');
await page.click('#lineChip'); await page.fill('#lineInput', '913'); await page.click('#lineForm button');
await page.waitForSelector('#stLineBtn', { timeout: 8000 });
await page.click('#stLineBtn');
await page.waitForSelector('.st tbody tr', { timeout: 8000 });
console.log('storico:', (await page.textContent('.st tbody')).replace(/\s+/g, ' '));
await page.screenshot({ path: `${OUT}/7-storico.png` });
await browser.close(); server.kill();
console.log('ERRORI:', errors.length ? errors : 'nessuno');
