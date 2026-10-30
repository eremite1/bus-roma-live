// Prova automatica della funzione "Deviazione" con risposte finte (AI, OpenStreetMap, percorso).
// Uso: node test/e2e_dev.mjs <cartella-screenshot>
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VENDOR = '/home/claude/vendor';
const OUT = process.argv[2] || '/tmp/shots-dev';
mkdirSync(OUT, { recursive: true });

// strade finte vicino al percorso della linea 64 di prova
const N = {
  1: [12.5003, 41.9009], 2: [12.4920, 41.8999], 3: [12.4870, 41.8980],
  10: [12.4925, 41.8970], 11: [12.4930, 41.8940],
  20: [12.4880, 41.8965], 21: [12.4840, 41.8962],
};
const WAYS = [
  { name: 'Via Nazionale', nodes: [1, 2, 3] },
  { name: 'Via Milano', nodes: [2, 10, 11] },
  { name: 'Via Panisperna', nodes: [10, 20, 21] },
];
const AI = {
  testo: 'PER INCIDENTE IN VIA NAZIONALE: DX VIA MILANO, SX VIA PANISPERNA, POI NORMALE ITINERARIO',
  linea: '64', motivo: 'incidente', inizio: 'Via Nazionale',
  passi: [{ azione: 'destra', strada: 'Via Milano' }, { azione: 'sinistra', strada: 'via panisperna' }],
  fine: { tipo: 'riprende_percorso', strada: null }, dubbi: ['"Panisperna" letto da foto sfocata'],
};

const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const errors = [];
const seen = { ai: null, overpass: null, osrm: null };
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => { window.speechSynthesis.speak = (u) => { window.__spoken = u.text; }; });
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
  if (u.hostname === '127.0.0.1') return route.continue();
  if (u.hostname === 'unpkg.com') return route.fulfill({ status: 200, contentType: u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(`${VENDOR}/dist/${u.pathname.endsWith('.css') ? 'maplibre-gl.css' : 'maplibre-gl.js'}`) });
  if (u.hostname === 'tiles.openfreemap.org') return json({ version: 8, glyphs: 'https://glyphs.test/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#F2EFE9' } }] });
  if (u.hostname === 'glyphs.test') { const p = decodeURIComponent(u.pathname).split('/'); try { return route.fulfill({ body: readFileSync(`${VENDOR}/glyphs/${p[1].split(',')[0]}/${p[2]}`) }); } catch { return route.fulfill({ status: 404 }); } }
  if (u.hostname === 'proxy.test') {
    if (u.pathname === '/deviazione') {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' } });
      seen.ai = JSON.parse(req.postData());
      return json(AI);
    }
    return route.fulfill({ status: 502, body: 'no' });
  }
  if (u.hostname.includes('overpass')) {
    seen.overpass = decodeURIComponent(req.postData().slice(5));
    const m = seen.overpass.match(/"name"~"\^\((.*)\)\$",i/);
    const wanted = m[1].split('|').map((x) => new RegExp('^' + x + '$', 'i'));
    const elements = WAYS.filter((w) => wanted.some((r) => r.test(w.name))).map((w, i) => ({
      type: 'way', id: i + 1, tags: { highway: 'secondary', name: w.name }, nodes: w.nodes, geometry: w.nodes.map((n) => ({ lon: N[n][0], lat: N[n][1] })),
    }));
    return json({ elements });
  }
  if (u.hostname === 'router.project-osrm.org') {
    seen.osrm = u.pathname;
    const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
    return json({ code: 'Ok', routes: [{ distance: 1450, geometry: { type: 'LineString', coordinates: pts } }] });
  }
  if (u.hostname === 'api.transitous.org') return json([]);
  return route.fulfill({ status: 404, body: '' });
});

await page.goto('http://127.0.0.1:8765/index.html?proxy=https://proxy.test');
await page.waitForFunction(() => window.__busMap && window.__busMap.getSource('dev'), null, { timeout: 15000 });
await page.click('#devBtn');
await page.waitForSelector('#devPhoto', { state: 'attached' });
await page.screenshot({ path: `${OUT}/d1-start.png` });

// foto del messaggio: genero un'immagine finta
await page.setInputFiles('#devPhoto', { name: 'msg.png', mimeType: 'image/png', buffer: readFileSync(`${VENDOR}/../data/shots3/01-gps-overview.png`) });
await page.waitForSelector('.dev-step', { timeout: 10000 });
await page.screenshot({ path: `${OUT}/d2-review.png` });
console.log('foto inviata all\'AI:', !!seen.ai.image, 'byte:', seen.ai.image.length, 'linea:', JSON.stringify(seen.ai.linea));

await page.fill('#devLine2', '64');
await page.click('#devGo');
await page.waitForSelector('.dev-instr', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${OUT}/d3-result.png` });
console.log('istruzioni:', (await page.textContent('.dev-instr')).replace(/\s+/g, ' '));
console.log('letto ad alta voce:', await page.evaluate(() => window.__spoken));
console.log('punti OSRM:', seen.osrm);
const feats = await page.evaluate(() => window.__busMap.querySourceFeatures('dev').length);
console.log('elementi deviazione sulla mappa:', feats);

// errore: strada inesistente
await page.click('#devEdit');
await page.fill('.dev-step[data-i="1"] input', 'Via Inesistente');
await page.click('#devGo');
await page.waitForSelector('.dev-step.err', { timeout: 10000 });
console.log('strada sbagliata evidenziata:', await page.getAttribute('.dev-step.err input', 'value'));
await page.screenshot({ path: `${OUT}/d4-error.png` });

// salvata e ricaricabile
await page.click('#devBack');
console.log('salvate:', await page.locator('li[data-id]').count());

await browser.close();
server.kill();
console.log('ERRORI:', errors.length ? errors : 'nessuno');
