// Prova automatica del navigatore in modalità "Prova" (simulazione), con dati finti.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VENDOR = '/home/claude/vendor';
const OUT = process.argv[2] || '/tmp/shots-nav';
mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const errors = [];
let matchCalls = 0;
async function run(viewport, tag) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'it-IT', timezoneId: 'Europe/Rome', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => { window.__spoken = []; window.speechSynthesis.speak = (u) => window.__spoken.push(u.text); });
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
    if (u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname === 'unpkg.com') return route.fulfill({ status: 200, contentType: u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: readFileSync(`${VENDOR}/dist/${u.pathname.endsWith('.css') ? 'maplibre-gl.css' : 'maplibre-gl.js'}`) });
    if (u.hostname === 'tiles.openfreemap.org') return json({ version: 8, glyphs: 'https://glyphs.test/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#F2EFE9' } }] });
    if (u.hostname === 'glyphs.test') { const p = decodeURIComponent(u.pathname).split('/'); try { return route.fulfill({ body: readFileSync(`${VENDOR}/glyphs/${p[1].split(',')[0]}/${p[2]}`) }); } catch { return route.fulfill({ status: 404 }); } }
    if (u.hostname === 'router.project-osrm.org') {
      matchCalls++;
      return json({ code: 'Ok', matchings: [{ legs: [{ steps: [
        { name: 'Via Cola di Rienzo', maneuver: { location: [12.4586, 41.9067] } },
        { name: 'Via Cicerone', maneuver: { location: [12.4660, 41.9077] } },
        { name: 'Via Crescenzio', maneuver: { location: [12.4672, 41.9040] } },
      ] }] }] });
    }
    if (u.hostname === 'api.transitous.org') return json([]);
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://127.0.0.1:8765/index.html');
  await page.waitForFunction(() => window.__busMap && window.__busMap.getSource('nav'), null, { timeout: 15000 });
  await page.click('#navBtn');
  await page.fill('#navLine', '913');
  await page.click('#navForm button[type=submit]');
  await page.waitForSelector('[data-sim="0"]', { timeout: 8000 });
  await page.screenshot({ path: `${OUT}/${tag}-1-scelta.png` });
  console.log(tag, 'direzioni:', (await page.textContent('#navDirs')).replace(/\s+/g, ' ').slice(0, 140));

  // GPX
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-gpx="0"]')]);
  const gpx = readFileSync(await dl.path(), 'utf8');
  console.log(tag, 'GPX:', dl.suggestedFilename(), 'punti', (gpx.match(/<trkpt/g) || []).length, 'fermate', (gpx.match(/<wpt/g) || []).length);

  await page.click('[data-sim="0"]');
  await page.waitForSelector('#navTop .nav-dist', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${OUT}/${tag}-2-partenza.png` });
  console.log(tag, 'banner:', (await page.textContent('#navTop')).replace(/\s+/g, ' '));
  await page.click('#navFast');
  await new Promise((r) => setTimeout(r, 5000));
  await page.screenshot({ path: `${OUT}/${tag}-3-in-viaggio.png` });
  console.log(tag, 'banner dopo:', (await page.textContent('#navTop')).replace(/\s+/g, ' '), '| fermata:', (await page.textContent('#navStop')).replace(/\s+/g, ' '));
  // accelero la simulazione per arrivare in fondo
  await page.evaluate(async () => { const m = await import('/js/nav.js'); m.navState().speed = 60; });
  await new Promise((r) => setTimeout(r, 22000));
  console.log(tag, 'voce:', JSON.stringify(await page.evaluate(() => window.__spoken)));
  console.log(tag, 'banner fine:', (await page.textContent('#navTop')).replace(/\s+/g, ' '));
  await page.click('#navMute');
  const n0 = await page.evaluate(() => window.__spoken.length);
  await page.evaluate(async () => { const v = await import('/js/voice.js'); v.speak('prova'); });
  console.log(tag, 'frasi dopo il muto (attese 0):', (await page.evaluate(() => window.__spoken.length)) - n0);
  await page.screenshot({ path: `${OUT}/${tag}-4-fine.png` });
  await page.click('#navExit');
  console.log(tag, 'uscita ok:', await page.evaluate(() => !document.body.classList.contains('navigating') && !document.getElementById('nav')));
  await page.evaluate(() => localStorage.setItem('voce', 'on'));
  await ctx.close();
}
await run({ width: 390, height: 844 }, 'v');
await run({ width: 844, height: 390 }, 'o');
await browser.close();
server.kill();
console.log('chiamate OSRM:', matchCalls, 'ERRORI:', errors.length ? errors : 'nessuno');
