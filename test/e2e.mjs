// Prova automatica nel browser con dati finti (nessuna connessione a internet necessaria).
// Uso: node test/e2e.mjs <cartella-uscita-screenshot>
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VENDOR = '/home/claude/vendor';
const DATA = '/home/claude/data';
const OUT = process.argv[2] || '/tmp/shots';
mkdirSync(OUT, { recursive: true });

// ---------- utilità ----------
function enc(points, precision) {
  const f = 10 ** precision; let out = '', plat = 0, plon = 0;
  for (const [lon, lat] of points) {
    const ilat = Math.round(lat * f), ilon = Math.round(lon * f);
    for (let v of [ilat - plat, ilon - plon]) {
      v = v < 0 ? ~(v << 1) : v << 1;
      while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      out += String.fromCharCode(v + 63);
    }
    plat = ilat; plon = ilon;
  }
  return out;
}
const iso = (ms) => new Date(ms).toISOString();
const STOPS = {
  S1: ['TERMINI (MA-MB-FS)', 41.9009, 12.5003], S2: ['NAZIONALE/QUIRINALE', 41.8999, 12.4920], S3: ['PIAZZA VENEZIA', 41.8960, 12.4823],
  S4: ['ARGENTINA', 41.8955, 12.4767], S5: ['CORSO VITTORIO EMANUELE/NAVONA', 41.8977, 12.4706], S6: ['SAN PIETRO', 41.9022, 12.4567],
  S7: ['TRASTEVERE/MINISTERO ISTRUZIONE', 41.8838, 12.4692], S8: ['CASALETTO', 41.8690, 12.4430],
};
const place = (id, t, delayMin = 0) => ({
  name: STOPS[id][0], stopId: 'it-Lazio-Rome_' + id, lat: STOPS[id][1], lon: STOPS[id][2],
  arrival: iso(t + delayMin * 60000), departure: iso(t + delayMin * 60000), scheduledArrival: iso(t), scheduledDeparture: iso(t),
});
const ll = (id) => [STOPS[id][2], STOPS[id][1]];
const T64A = () => '20261025_08:00_it-Lazio-Rome_T64A';

function mapTrips() {
  const now = Date.now();
  const segs = [];
  const add = (tripId, line, mode, a, b, dep, arr, delayMin = 0) => segs.push({
    trips: [{ tripId, displayName: line }], mode, distance: 900, from: { name: STOPS[a][0], lat: STOPS[a][1], lon: STOPS[a][2] },
    to: { name: STOPS[b][0], lat: STOPS[b][1], lon: STOPS[b][2] }, departure: iso(dep), arrival: iso(arr),
    scheduledDeparture: iso(dep - delayMin * 60000), scheduledArrival: iso(arr - delayMin * 60000), realTime: true, polyline: enc([ll(a), ll(b)], 5),
  });
  add(T64A(), '64', 'BUS', 'S1', 'S2', now - 60000, now + 60000, 4);
  add(T64A(), '64', 'BUS', 'S2', 'S3', now + 70000, now + 300000, 4);
  add('20261025_08:00_it-Lazio-Rome_T64B', '64', 'BUS', 'S5', 'S3', now - 30000, now + 200000, -2);
  add('20261025_08:00_it-Lazio-Rome_T8A', '8', 'TRAM', 'S4', 'S7', now - 100000, now + 200000);
  add('20261025_08:00_it-Lazio-Rome_MA1', 'MA', 'SUBWAY', 'S1', 'S3', now - 50000, now + 100000);
  // tanti altri mezzi finti
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const lines = ['30', '87', '40', '60', '714', '492', 'C3', '2', 'n1'];
  for (let i = 0; i < 250; i++) {
    const lat = 41.9 + (rnd() - 0.5) * 0.12, lon = 12.49 + (rnd() - 0.5) * 0.16;
    const a = [lon, lat], b = [lon + (rnd() - 0.5) * 0.01, lat + (rnd() - 0.5) * 0.01];
    const line = lines[i % lines.length];
    segs.push({ trips: [{ tripId: `20261025_08:00_it-Lazio-Rome_X${i}`, displayName: line }], mode: line === '2' ? 'TRAM' : 'BUS', distance: 500,
      from: { name: 'A', lat, lon }, to: { name: 'VIA DEL CORSO', lat: b[1], lon: b[0] }, departure: iso(now - rnd() * 100000), arrival: iso(now + 20000 + rnd() * 100000),
      scheduledDeparture: iso(now), scheduledArrival: iso(now), realTime: rnd() > 0.3, polyline: enc([a, b], 5) });
  }
  return segs;
}
function tripResp() {
  const now = Date.now();
  return { legs: [{ mode: 'BUS', realTime: true, headsign: 'SAN PIETRO', routeShortName: '64', displayName: '64', tripId: T64A(),
    from: place('S1', now - 5 * 60000, 1), to: place('S6', now + 14 * 60000, 3),
    intermediateStops: [place('S2', now - 60000, 2), place('S3', now + 4 * 60000, 3), place('S5', now + 8 * 60000, 3)],
    legGeometry: { points: enc(['S1', 'S2', 'S3', 'S5', 'S6'].map(ll), 6), precision: 6, length: 5 } }] };
}
function planResp() {
  const now = Date.now();
  const me = [12.5050, 41.9030];
  const walk1 = { mode: 'WALK', from: { name: 'START', lat: me[1], lon: me[0] }, to: place('S1', now + 4 * 60000), duration: 240, distance: 320,
    startTime: iso(now), endTime: iso(now + 240000), legGeometry: { points: enc([me, ll('S1')], 6), precision: 6, length: 2 } };
  const bus = { mode: 'BUS', realTime: true, headsign: 'SAN PIETRO', routeShortName: '64', displayName: '64', tripId: T64A(),
    from: place('S2', now + 5 * 60000, 2), to: place('S5', now + 14 * 60000, 2), startTime: iso(now + 7 * 60000), endTime: iso(now + 16 * 60000),
    scheduledStartTime: iso(now + 5 * 60000), scheduledEndTime: iso(now + 14 * 60000), duration: 540,
    intermediateStops: [place('S3', now + 10 * 60000, 2)],
    legGeometry: { points: enc(['S2', 'S3', 'S5'].map(ll), 6), precision: 6, length: 3 } };
  const walk2 = { mode: 'WALK', from: place('S5', now + 16 * 60000), to: { name: 'END', lat: 41.8986, lon: 12.4731 }, duration: 180, distance: 210,
    startTime: iso(now + 16 * 60000), endTime: iso(now + 19 * 60000), legGeometry: { points: enc([ll('S5'), [12.4731, 41.8986]], 6), precision: 6, length: 2 } };
  const tram = { ...bus, mode: 'TRAM', routeShortName: '8', displayName: '8', tripId: '20261025_08:00_it-Lazio-Rome_T8A', realTime: false, headsign: 'CASALETTO',
    startTime: iso(now + 12 * 60000), scheduledStartTime: iso(now + 12 * 60000), endTime: iso(now + 26 * 60000) };
  return {
    itineraries: [
      { duration: 1140, startTime: iso(now), endTime: iso(now + 19 * 60000), transfers: 0, legs: [walk1, bus, walk2] },
      { duration: 1560, startTime: iso(now + 6 * 60000), endTime: iso(now + 32 * 60000), transfers: 0, legs: [walk1, tram, walk2] },
    ],
    direct: [{ duration: 2400, startTime: iso(now), endTime: iso(now + 2400000), legs: [{ ...walk1, distance: 2900, duration: 2400 }] }],
  };
}
function stoptimes() {
  const now = Date.now();
  const mk = (line, mode, head, min, rt, delay = 0, trip = T64A()) => ({ place: { name: 'PIAZZA VENEZIA', departure: iso(now + (min + delay) * 60000), scheduledDeparture: iso(now + min * 60000) },
    mode, realTime: rt, headsign: head, routeShortName: line, displayName: line, tripId: trip });
  return { stopTimes: [mk('64', 'BUS', 'SAN PIETRO', 2, true, 1), mk('40', 'BUS', 'BORGO PIO', 4, true), mk('8', 'TRAM', 'CASALETTO', 6, false, 0, '20261025_08:00_it-Lazio-Rome_T8A'),
    mk('87', 'BUS', 'COLLI ALBANI', 11, true, 3), mk('n1', 'BUS', 'LAURENTINA', 45, false)] };
}

async function main() {
  const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const errors = [];
  let feedN = 0;

  async function newPage(viewport, query = '') {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, geolocation: { latitude: 41.9030, longitude: 12.5050 }, permissions: ['geolocation'], locale: 'it-IT', timezoneId: 'Europe/Rome' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ' ' + m.text()); });
    page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(o) });
      if (u.hostname === '127.0.0.1') return route.continue();
      if (u.hostname === 'unpkg.com') {
        const f = u.pathname.endsWith('.css') ? 'maplibre-gl.css' : 'maplibre-gl.js';
        return route.fulfill({ status: 200, contentType: f.endsWith('css') ? 'text/css' : 'application/javascript', body: readFileSync(`${VENDOR}/dist/${f}`) });
      }
      if (u.hostname === 'tiles.openfreemap.org') {
        return json({ version: 8, glyphs: 'https://glyphs.test/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#F2EFE9' } }] });
      }
      if (u.hostname === 'glyphs.test') {
        const parts = decodeURIComponent(u.pathname).split('/');
        const font = parts[1].split(',')[0];
        try { return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: readFileSync(`${VENDOR}/glyphs/${font}/${parts[2]}`) }); } catch { return route.fulfill({ status: 404, body: '' }); }
      }
      if (u.hostname === 'proxy.test') {
        if (u.pathname.endsWith('/trips')) return route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(`${DATA}/tu.pb`) });
        feedN++;
        return route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(`${DATA}/feed${feedN % 2 ? 1 : 2}.pb`) });
      }
      if (u.hostname === 'api.transitous.org') {
        const p = u.pathname;
        if (p.endsWith('/map/trips')) return json(mapTrips());
        if (p.endsWith('/map/stops')) return json(Object.entries(STOPS).map(([id, s]) => ({ name: s[0], stopId: 'it-Lazio-Rome_' + id, lat: s[1], lon: s[2] })));
        if (p.endsWith('/stoptimes')) return json(stoptimes());
        if (p.endsWith('/trip')) return json(tripResp());
        if (p.endsWith('/plan')) return json(planResp());
        if (p.endsWith('/reverse-geocode')) return json([{ type: 'ADDRESS', street: 'Via del Corso', houseNumber: '12', name: 'Via del Corso', lat: 41.9, lon: 12.48 }]);
        if (p.endsWith('/geocode')) return json([
          { type: 'PLACE', name: 'Piazza Navona', lat: 41.8986, lon: 12.4731, areas: [{ name: 'Roma' }, { name: 'Lazio' }] },
          { type: 'STOP', name: 'CORSO VITTORIO EMANUELE/NAVONA', lat: 41.8977, lon: 12.4706, id: 'it-Lazio-Rome_S5', areas: [{ name: 'Roma' }] },
          { type: 'ADDRESS', name: 'Via di Navona', street: 'Via di Navona', houseNumber: '5', lat: 41.89, lon: 12.47, areas: [{ name: 'Roma' }] },
        ]);
        return json({});
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://127.0.0.1:8765/index.html' + query);
    return page;
  }

  const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. telefono, modalità GPS ----
  const phone = { width: 390, height: 844 };
  let page = await newPage(phone, '?proxy=https://proxy.test');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('GPS'), null, { timeout: 15000 });
  await wait(1500);
  await shot(page, '01-gps-overview');
  console.log('status:', await page.textContent('#statusText'));

  await page.evaluate(() => window.__map && 0);
  // zoom sul centro e clic sul 64
  await page.evaluate(() => {});
  const mapObj = 'document.querySelector("#map")';
  await page.mouse.wheel(0, 0);
  await page.evaluate(() => new Promise((r) => { const m = window.__busMap; m.jumpTo({ center: [12.488, 41.899], zoom: 15.3 }); m.once('idle', r); }));
  await wait(2200);
  await shot(page, '02-gps-zoom');
  // clic sul mezzo 3456 (linea 64)
  const pt = await page.evaluate(() => {
    const m = window.__busMap; const f = m.querySourceFeatures('veh').find((x) => x.properties.id === 'g3456');
    const p = m.project(f.geometry.coordinates); return { x: p.x, y: p.y };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.timeline li', { timeout: 8000 });
  await wait(800);
  await shot(page, '03-vehicle-sheet');
  console.log('vehicle dest:', await page.textContent('#vehDest'));

  // linea 64
  await page.click('#showLineBtn');
  await page.waitForSelector('.punct-sum', { timeout: 10000 });
  await wait(1500);
  await shot(page, '04-line-64');
  console.log('route feats:', await page.evaluate(() => { const m = window.__busMap; return JSON.stringify({ z: m.getZoom(), c: m.getCenter(), n: m.querySourceFeatures('route').length }); }));
  console.log('line view:', (await page.textContent('#lineView')).replace(/\s+/g, ' ').slice(0, 200));
  await page.click('#lineChip'); // togli filtro
  await wait(300);

  // fermata
  await page.evaluate(() => new Promise((r) => { const m = window.__busMap; m.jumpTo({ center: [12.4823, 41.8960], zoom: 17 }); m.once('idle', r); }));
  await wait(1500);
  const sp = await page.evaluate(() => { const m = window.__busMap; const f = m.querySourceFeatures('stops').find((x) => x.properties.name === 'Piazza Venezia'); const p = m.project(f.geometry.coordinates); return { x: p.x, y: p.y }; });
  // il mezzo potrebbe stare sopra la fermata: clicco comunque
  await page.evaluate(({ x, y }) => window.__busMap.fire('click', { point: { x, y }, lngLat: window.__busMap.unproject([x, y]) }), sp);
  await page.waitForSelector('#deps .rows li', { timeout: 8000 });
  await wait(500);
  await shot(page, '05-stop-departures');

  // percorso
  await page.click('#sheetClose');
  await page.fill('#toInput', 'navona');
  await page.waitForSelector('#suggest li[data-i]', { timeout: 8000 });
  await shot(page, '06-suggest');
  await page.click('#suggest li[data-i="0"]');
  await page.waitForSelector('.itin', { timeout: 10000 });
  await wait(1200);
  await shot(page, '07-plan-list');
  await page.click('.itin[data-i="0"]');
  await wait(1500);
  await shot(page, '08-itinerary');
  console.log('live box:', (await page.textContent('.live-box')).replace(/\s+/g, ' '));
  await page.click('#infoBtn');
  await wait(400);
  await shot(page, '09-info');
  await page.context().close();

  // ---- 2. desktop, modalità stimata ----
  page = await newPage({ width: 1366, height: 820 });
  await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('stimate'), null, { timeout: 15000 });
  await page.evaluate(() => new Promise((r) => { const m = window.__busMap; m.jumpTo({ center: [12.49, 41.899], zoom: 14 }); m.once('idle', r); }));
  await wait(2000);
  await shot(page, '10-desktop-est');
  const p2 = await page.evaluate(() => { const m = window.__busMap; const f = m.querySourceFeatures('veh').find((x) => x.properties.line === '64'); const p = m.project(f.geometry.coordinates); return { x: p.x, y: p.y }; });
  await page.mouse.click(p2.x, p2.y);
  await page.waitForSelector('.timeline li', { timeout: 8000 });
  await wait(800);
  await shot(page, '11-desktop-vehicle');
  console.log('est vehicle dest:', await page.textContent('#vehDest'));

  await browser.close();
  server.kill();
  const relevant = errors.filter((e) => !/favicon|fonts\.g|404/.test(e));
  console.log('ERRORI CONSOLE:', relevant.length ? relevant : 'nessuno');
}
main().catch((e) => { console.error(e); process.exit(1); });
