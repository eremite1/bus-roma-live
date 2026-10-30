// NAVIGATORE DELLA LINEA
// Segue il percorso ufficiale della linea (dagli orari ATAC) con vista 3D, svolte, fermate e voce.
//
// - Le svolte si ricavano dalla forma del percorso (dove la strada cambia direzione).
// - I nomi delle strade arrivano da OSRM (OpenStreetMap), "agganciando" il percorso alle strade.
// - La posizione arriva dal GPS del telefono, oppure da una simulazione ("Prova").

import { decodePolyline } from './api.js';
import { distance, bearing } from './vehicles.js';
import { speak, isMuted, setMuted } from './voice.js';

let C = null;
export function initNav(ctx) { C = ctx; }

const OSRM_MATCH = 'https://router.project-osrm.org/match/v1/driving/';
const NAV_COLOR = '#2563EB';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- frecce ----------------
const ARROWS = {
  right: '<path d="M7 20V12a3 3 0 0 1 3-3h8M14 5l4 4-4 4"/>',
  left: '<path d="M17 20V12a3 3 0 0 0-3-3H6M10 5L6 9l4 4"/>',
  'slight-right': '<path d="M8 20v-6l8-8M10 6h6v6"/>',
  'slight-left': '<path d="M16 20v-6L8 6M14 6H8v6"/>',
  uturn: '<path d="M8 20V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4"/>',
  straight: '<path d="M12 20V5M7 10l5-5 5 5"/>',
  end: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>',
};
const arrowSvg = (k) => `<svg viewBox="0 0 24 24" class="nav-arrow">${ARROWS[k] || ARROWS.straight}</svg>`;
const DIR_TEXT = {
  right: 'a destra', left: 'a sinistra', 'slight-right': 'leggermente a destra', 'slight-left': 'leggermente a sinistra', uturn: 'inversione',
};

// ---------------- geometria del percorso ----------------
function buildRoute(coordsIn) {
  // punti al massimo ogni 15 m, con distanza progressiva (in metri) dall'inizio
  const coords = [coordsIn[0]], vertex = [true];
  for (let i = 1; i < coordsIn.length; i++) {
    const a = coordsIn[i - 1], b = coordsIn[i];
    const n = Math.ceil(distance(a, b) / 15);
    for (let k = 1; k <= n; k++) { coords.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); vertex.push(k === n); }
  }
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
  return { coords, cum, vertex, total: cum[cum.length - 1] };
}
function indexAt(r, at) {
  let lo = 0, hi = r.cum.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.cum[m] <= at) lo = m; else hi = m - 1; }
  return lo;
}
function pointAt(r, at) {
  at = Math.max(0, Math.min(r.total, at));
  const i = indexAt(r, at);
  if (i >= r.coords.length - 1) return r.coords[r.coords.length - 1];
  const span = r.cum[i + 1] - r.cum[i];
  const f = span > 0 ? (at - r.cum[i]) / span : 0;
  const a = r.coords[i], b = r.coords[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
const headingAt = (r, at, back = 20, ahead = 20) => bearing(pointAt(r, at - back), pointAt(r, at + ahead));
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;

// Svolte: dove il percorso cambia direzione di almeno 30 gradi
function detectTurns(r) {
  const turns = [];
  const vtx = [];
  for (let i = 1; i < r.coords.length - 1; i++) if (r.vertex[i]) vtx.push(r.cum[i]);
  let k = 0;
  while (k < vtx.length) {
    // raggruppo i vertici vicini (curve fatte di più punti, rotatorie)
    let j = k;
    while (j + 1 < vtx.length && vtx[j + 1] - vtx[k] < 35) j++;
    const start = vtx[k], end = vtx[j];
    const before = bearing(pointAt(r, start - 25), pointAt(r, start));
    const after = bearing(pointAt(r, end), pointAt(r, end + 25));
    const d = angleDiff(before, after);
    const a = Math.abs(d);
    if (a >= 30 && start > 20 && end < r.total - 20) {
      const side = d > 0 ? 'right' : 'left';
      const kind = a > 150 ? 'uturn' : a < 55 ? 'slight-' + side : side;
      turns.push({ at: (start + end) / 2, kind, angle: Math.round(d), name: '' });
    }
    k = j + 1;
  }
  return turns;
}

// Nomi delle strade: agganciamo il percorso alla rete stradale con OSRM e leggiamo le svolte
async function fetchStreetNames(r, turns) {
  const step = 60;
  const sample = [];
  for (let at = 0; at < r.total; at += step) sample.push(pointAt(r, at));
  sample.push(r.coords[r.coords.length - 1]);
  const named = []; // [{ p, name }]
  for (let s = 0; s < sample.length - 1; s += 89) {
    const chunk = sample.slice(s, s + 90);
    if (chunk.length < 2) break;
    const url = OSRM_MATCH + chunk.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')
      + `?steps=true&overview=false&tidy=true&gaps=ignore&radiuses=${chunk.map(() => 35).join(';')}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      for (const m of data.matchings || []) for (const leg of m.legs || []) for (const st of leg.steps || []) {
        if (st.name && st.maneuver && st.maneuver.location) named.push({ p: st.maneuver.location, name: st.name });
      }
    } catch (e) { /* senza nomi il navigatore funziona lo stesso */ }
    await new Promise((ok) => setTimeout(ok, 1100)); // il servizio gratuito chiede al massimo una richiesta al secondo
    if (!nav || nav.route !== r) return;
  }
  for (const t of turns) {
    const p = pointAt(r, t.at);
    let best = null, bd = 50;
    for (const n of named) { const d = distance(p, n.p); if (d < bd) { bd = d; best = n; } }
    if (best) t.name = best.name;
  }
}

// ---------------- dati della linea ----------------
function lineOptions(linea) {
  const out = [];
  const ids = Object.entries(C.store.routes || {}).filter(([, r]) => String(r.n).toLowerCase() === String(linea).toLowerCase()).map(([id]) => id);
  for (const id of ids) {
    for (const s of (C.store.shapes && C.store.shapes[id]) || []) {
      const stops = ((C.store.linestops && C.store.linestops[id]) || []).find((x) => x.d === s.d) || null;
      out.push({ routeId: id, d: s.d, h: s.h, p: s.p, stops: stops ? stops.s : [], type: C.store.routes[id].t });
    }
  }
  return out;
}

// ---------------- schermata di scelta ----------------
export async function openNavPicker(prefill) {
  const linea = prefill || C.state.lineFilter || '';
  C.openSheet(`
    <h2>Navigatore della linea</h2>
    <p class="sub">Ti guida lungo il percorso ufficiale della linea, con vista 3D, svolte, fermate e voce.</p>
    <form id="navForm" class="dev-field">Linea <input id="navLine" value="${esc(linea)}" placeholder="es. 913" autocomplete="off"><button class="btn" type="submit">Cerca</button></form>
    <div id="navDirs"></div>
  `, { type: 'navpick' });
  document.getElementById('navForm').onsubmit = (e) => { e.preventDefault(); showDirs(document.getElementById('navLine').value.trim()); };
  if (linea) showDirs(linea);
}

async function showDirs(linea) {
  const el = document.getElementById('navDirs');
  if (!linea || !el) return;
  el.innerHTML = '<div class="spinner">Carico il percorso…</div>';
  await C.loadShapes();
  await C.loadLineStops();
  const opts = lineOptions(linea);
  if (!opts.length) { el.innerHTML = `<p class="late">Non trovo il percorso della linea ${esc(linea)}.</p>`; return; }
  el.innerHTML = `<div class="section-title">Scegli la direzione</div>
    ${opts.map((o, i) => {
      const len = buildRoute(decodePolyline(o.p, 5)).total;
      return `<div class="nav-dir">
        <div><div class="dest"><span class="arrow">verso</span> ${esc(o.h || 'capolinea')}</div>
          <div class="muted">${o.stops.length ? `da ${esc(o.stops[0][2])} · ${o.stops.length} fermate · ` : ''}${(len / 1000).toFixed(1).replace('.', ',')} km</div></div>
        <div class="actions">
          <button class="btn" data-go="${i}">Avvia</button>
          <button class="btn ghost" data-sim="${i}">Prova</button>
          <button class="btn ghost" data-gpx="${i}">GPX</button>
        </div></div>`;
    }).join('')}
    <p class="muted">"Avvia" usa il GPS del telefono. "Prova" simula il viaggio, per vedere la linea da casa. Usa il telefono solo su un supporto fisso.</p>`;
  el.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => startNav(linea, opts[+b.dataset.go], false); });
  el.querySelectorAll('[data-sim]').forEach((b) => { b.onclick = () => startNav(linea, opts[+b.dataset.sim], true); });
  el.querySelectorAll('[data-gpx]').forEach((b) => { b.onclick = () => downloadGpx(linea, opts[+b.dataset.gpx]); });
}

function downloadGpx(linea, o) {
  const pts = decodePolyline(o.p, 5);
  const name = `Linea ${linea} verso ${o.h || ''}`.trim();
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bus Roma Live" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name></metadata>
${o.stops.map((s) => `<wpt lat="${s[1]}" lon="${s[0]}"><name>${esc(s[2])}</name><type>Fermata</type></wpt>`).join('\n')}
<trk><name>${esc(name)}</name><trkseg>
${pts.map((p) => `<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"/>`).join('\n')}
</trkseg></trk>
</gpx>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = `linea-${linea}-verso-${(o.h || 'capolinea').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.gpx`;
  document.body.appendChild(a); a.click(); a.remove();
  C.toast('Percorso GPX scaricato');
}

// ---------------- navigazione ----------------
let nav = null;

function startNav(linea, opt, simulate) {
  const route = buildRoute(decodePolyline(opt.p, 5));
  const turns = detectTurns(route);
  // fermate proiettate sul percorso, in ordine
  const stops = [];
  let from = 0;
  for (const s of opt.stops) {
    let best = -1, bd = Infinity;
    for (let i = from; i < route.coords.length; i++) {
      const d = distance(route.coords[i], [s[0], s[1]]);
      if (d < bd) { bd = d; best = i; }
      if (bd < 15 && d > 400) break;
    }
    if (best >= 0 && bd < 120) { stops.push({ at: route.cum[best], name: s[2], p: [s[0], s[1]] }); from = best; }
  }
  const color = C.colorOf({ type: opt.type, line: linea });
  nav = {
    linea, head: opt.h, route, turns, stops, color, simulate,
    along: 0, lastIdx: 0, speed: 9, follow: true, offRoute: false, offSince: 0,
    said: new Set(), nextStopSaid: -1, watchId: null, timer: null, lastFix: 0, started: Date.now(),
  };
  C.closeSheet();
  document.body.classList.add('navigating');
  buildOverlay();
  drawRoute();
  setNavLayers(true);
  keepAwake();
  C.map.easeTo({ pitch: 60, zoom: 17.2, center: route.coords[0], bearing: headingAt(route, 0, 0, 40), duration: 800 });
  speak(`Navigazione linea ${linea}, verso ${opt.h || 'il capolinea'}.`);
  fetchStreetNames(route, turns).then(() => nav && update());

  if (simulate) {
    let last = performance.now();
    nav.timer = setInterval(() => {
      const t = performance.now();
      nav.along = Math.min(route.total, nav.along + nav.speed * ((t - last) / 1000));
      last = t;
      update();
    }, 250);
  } else {
    if (!navigator.geolocation) { C.toast('GPS non disponibile su questo dispositivo'); return; }
    nav.watchId = navigator.geolocation.watchPosition(onFix, () => C.toast('Non ricevo il GPS: controlla i permessi'), { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  update();
}

function onFix(pos) {
  if (!nav) return;
  const p = [pos.coords.longitude, pos.coords.latitude];
  const r = nav.route;
  // cerco il punto del percorso più vicino, preferendo andare avanti (le linee a volte ripassano dalle stesse strade)
  const first = !nav.lastFix;
  const lo = first ? 0 : Math.max(0, nav.lastIdx - 15);
  const hi = first ? r.coords.length - 1 : Math.min(r.coords.length - 1, nav.lastIdx + 250);
  let best = nav.lastIdx, bd = Infinity;
  for (let i = lo; i <= hi; i++) {
    const d = distance(p, r.coords[i]);
    if (d < bd) { bd = d; best = i; }
  }
  if (!first && bd > 80) {
    // molto lontano dalla finestra: forse ho saltato un tratto, cerco su tutto il percorso
    for (let i = 0; i < r.coords.length; i++) { const d = distance(p, r.coords[i]); if (d < bd) { bd = d; best = i; } }
  }
  nav.lastFix = Date.now();
  nav.gpsPoint = p;
  if (bd > 60) {
    if (!nav.offRoute) { nav.offRoute = true; speak('Sei fuori dal percorso della linea.'); }
  } else {
    if (nav.offRoute) speak('Di nuovo sul percorso.');
    nav.offRoute = false;
    nav.lastIdx = best;
    nav.along = r.cum[best];
  }
  update();
}

const roundDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : m >= 300 ? `${Math.round(m / 50) * 50} m` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

function turnText(t, withName = true) {
  const dir = DIR_TEXT[t.kind] || '';
  if (t.kind === 'uturn') return 'Fai inversione' + (withName && t.name ? ` in ${t.name}` : '');
  return `Gira ${dir}` + (withName && t.name ? ` in ${t.name}` : '');
}

function update() {
  if (!nav) return;
  const { route: r, turns, stops } = nav;
  const along = nav.along;
  const remaining = r.total - along;

  // prossima svolta
  const next = turns.find((t) => t.at > along + 5);
  const after = next ? turns.find((t) => t.at > next.at + 5) : null;
  const top = document.getElementById('navTop');
  if (remaining < 25) {
    top.innerHTML = `${arrowSvg('end')}<div><div class="nav-dist">Capolinea</div><div class="nav-text">${esc(nav.head || '')}</div></div>`;
    if (!nav.said.has('end')) { nav.said.add('end'); speak('Sei arrivato al capolinea.'); }
  } else if (next) {
    const d = next.at - along;
    top.innerHTML = `${arrowSvg(next.kind)}<div><div class="nav-dist">${roundDist(d)}</div><div class="nav-text">${esc(turnText(next))}</div>
      ${after && after.at - next.at < 250 ? `<div class="nav-then">poi ${esc(DIR_TEXT[after.kind] || '')}</div>` : ''}</div>`;
    const key = next.at.toFixed(0);
    if (d < 260 && d > 120 && !nav.said.has('f' + key)) { nav.said.add('f' + key); speak(`Tra ${Math.round(d / 50) * 50} metri, ${turnText(next).replace(/^G/, 'g').replace(/^F/, 'f')}.`); }
    if (d <= 70 && !nav.said.has('n' + key)) { nav.said.add('n' + key); nav.said.add('f' + key); speak(turnText(next) + (after && after.at - next.at < 120 ? `, poi ${DIR_TEXT[after.kind]}` : '') + '.'); }
  } else {
    top.innerHTML = `${arrowSvg('straight')}<div><div class="nav-dist">${roundDist(remaining)}</div><div class="nav-text">Prosegui fino al capolinea</div></div>`;
  }

  // prossima fermata
  const ni = stops.findIndex((s) => s.at > along + 15);
  const ns = ni >= 0 ? stops[ni] : null;
  document.getElementById('navStop').innerHTML = ns
    ? `<span class="nav-stop-dot"></span><div><div class="muted">Prossima fermata · ${roundDist(ns.at - along)}</div><div class="nav-stop-name">${esc(ns.name)}</div></div>`
    : '<div class="muted">Nessuna altra fermata</div>';
  if (ns && ni !== nav.nextStopSaid && ni > 0) { nav.nextStopSaid = ni; speak(`Prossima fermata: ${ns.name}.`, { interrupt: false }); }
  if (ns && nav.nextStopSaid === -1) nav.nextStopSaid = ni;
  document.getElementById('navRemain').textContent = `${roundDist(remaining)} al capolinea`;
  document.getElementById('navOff').hidden = !nav.offRoute;

  // mappa
  const pos = nav.offRoute && nav.gpsPoint ? nav.gpsPoint : pointAt(r, along);
  const head = headingAt(r, along, 15, 35);
  const src = C.map.getSource('nav');
  if (src) {
    const i = indexAt(r, along);
    const done = r.coords.slice(0, i + 1).concat([pos]);
    const todo = [pos].concat(r.coords.slice(i + 1));
    src.setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: todo }, properties: { done: 0 } },
      ...(done.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: done }, properties: { done: 1 } }] : []),
      ...stops.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: s.p }, properties: { stop: 1, name: s.name } })),
      ...turns.filter((t) => t.at > along).slice(0, 8).map((t) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: pointAt(r, t.at) }, properties: { turn: 1 } })),
      { type: 'Feature', geometry: { type: 'Point', coordinates: pos }, properties: { me: 1, b: head } },
    ] });
  }
  if (nav.follow) {
    C.map.easeTo({ center: pos, bearing: head, pitch: 60, zoom: Math.max(16.3, Math.min(18, C.map.getZoom())), duration: nav.simulate ? 280 : 900, easing: (x) => x, offset: [0, Math.round(window.innerHeight * 0.18)] });
  }
}

// ---------------- grafica ----------------
function buildOverlay() {
  let el = document.getElementById('nav');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'nav';
  el.innerHTML = `
    <div class="nav-top" id="navTop"></div>
    <div class="nav-off" id="navOff" hidden>Fuori percorso · torna sulla linea ${esc(nav.linea)}</div>
    <div class="nav-bottom">
      <div class="nav-info">
        <div class="nav-line"><span class="badge" style="background:${nav.color}">${esc(nav.linea)}</span> <span>verso ${esc(nav.head || '')}</span> ${nav.simulate ? '<span class="nav-sim">PROVA</span>' : ''}</div>
        <div class="nav-stop" id="navStop"></div>
        <div class="muted" id="navRemain"></div>
      </div>
      <div class="nav-btns">
        <button class="fab" id="navMute" aria-label="Voce"></button>
        <button class="fab" id="navCenter" aria-label="Ricentra" hidden><svg viewBox="0 0 24 24"><path d="M12 3l7 18-7-4-7 4z"/></svg></button>
        ${nav.simulate ? '<button class="fab" id="navFast" aria-label="Velocità">2×</button>' : ''}
        <button class="fab nav-exit" id="navExit" aria-label="Esci"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
    </div>`;
  document.body.appendChild(el);
  const muteBtn = el.querySelector('#navMute');
  const paintMute = () => {
    muteBtn.innerHTML = isMuted()
      ? '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
    muteBtn.classList.toggle('off', isMuted());
  };
  paintMute();
  muteBtn.onclick = () => { setMuted(!isMuted()); paintMute(); };
  el.querySelector('#navExit').onclick = stopNav;
  el.querySelector('#navCenter').onclick = () => { nav.follow = true; el.querySelector('#navCenter').hidden = true; update(); };
  const fast = el.querySelector('#navFast');
  if (fast) fast.onclick = () => { nav.speed = nav.speed > 10 ? 9 : 25; fast.textContent = nav.speed > 10 ? '1×' : '2×'; };
  // se sposti la mappa col dito smetto di seguirti, finché non premi "Ricentra"
  C.map.on('dragstart', onUserMove);
}
function onUserMove() {
  if (!nav) return;
  nav.follow = false;
  const b = document.getElementById('navCenter');
  if (b) b.hidden = false;
}

function drawRoute() { /* il percorso viene disegnato a ogni aggiornamento in update() */ }

export function setupNavLayers(map) {
  // edifici in 3D (se la mappa di base li fornisce)
  const vector = Object.entries(map.getStyle().sources || {}).find(([, s]) => s.type === 'vector');
  if (vector) {
    map.addLayer({ id: 'nav-buildings', type: 'fill-extrusion', source: vector[0], 'source-layer': 'building', minzoom: 14.5,
      layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': '#DDD6CB', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 12],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.85 } }, map.getLayer('route-casing') ? 'route-casing' : undefined);
  }
  map.addSource('nav', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const line = ['==', ['geometry-type'], 'LineString'];
  map.addLayer({ id: 'nav-casing', type: 'line', source: 'nav', filter: line, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 8, 18, 26] } });
  map.addLayer({ id: 'nav-line', type: 'line', source: 'nav', filter: line, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: { 'line-color': ['case', ['==', ['get', 'done'], 1], '#A3A8B2', NAV_COLOR], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 18, 18] } });
  map.addLayer({ id: 'nav-chevrons', type: 'symbol', source: 'nav', filter: ['all', line, ['==', ['get', 'done'], 0]],
    layout: { visibility: 'none', 'symbol-placement': 'line', 'symbol-spacing': 70, 'text-field': '›', 'text-font': ['Noto Sans Bold'], 'text-size': 26, 'text-keep-upright': false, 'text-allow-overlap': true, 'text-offset': [0, -0.1] },
    paint: { 'text-color': '#fff' } });
  map.addLayer({ id: 'nav-turns', type: 'circle', source: 'nav', filter: ['==', ['get', 'turn'], 1], layout: { visibility: 'none' },
    paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': NAV_COLOR, 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'nav-stops', type: 'circle', source: 'nav', filter: ['==', ['get', 'stop'], 1], layout: { visibility: 'none' },
    paint: { 'circle-radius': 8, 'circle-color': '#F2B33D', 'circle-stroke-color': '#1B1D22', 'circle-stroke-width': 2.5 } });
  map.addLayer({ id: 'nav-stops-label', type: 'symbol', source: 'nav', filter: ['==', ['get', 'stop'], 1],
    layout: { visibility: 'none', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-max-width': 10 },
    paint: { 'text-color': '#1B1D22', 'text-halo-color': '#fff', 'text-halo-width': 2 } });
  // il "mio" bus: freccia blu
  const W = 64, c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(W / 2, W / 2, 26, 0, 7); g.fillStyle = '#fff'; g.fill();
  g.beginPath(); g.moveTo(W / 2, 10); g.lineTo(W / 2 + 16, W - 14); g.lineTo(W / 2, W - 22); g.lineTo(W / 2 - 16, W - 14); g.closePath();
  g.fillStyle = NAV_COLOR; g.fill();
  map.addImage('nav-me', { width: W, height: W, data: g.getImageData(0, 0, W, W).data }, { pixelRatio: 2 });
  map.addLayer({ id: 'nav-me', type: 'symbol', source: 'nav', filter: ['==', ['get', 'me'], 1],
    layout: { visibility: 'none', 'icon-image': 'nav-me', 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-size': 1.25 } });
}
const NAV_LAYERS = ['nav-buildings', 'nav-casing', 'nav-line', 'nav-chevrons', 'nav-turns', 'nav-stops', 'nav-stops-label', 'nav-me'];
function setNavLayers(on) {
  for (const id of NAV_LAYERS) if (C.map.getLayer(id)) C.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  // durante la guida nascondo gli altri mezzi e le fermate generiche: meno confusione
  for (const id of ['veh-halo', 'veh-arrow', 'veh-arrow-l', 'veh-dot', 'veh-label', 'veh-icon', 'veh-pill', 'stops-dot', 'stops-label', 'me-halo', 'me-dot']) {
    if (C.map.getLayer(id)) C.map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
  }
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* non supportato */ }
}
document.addEventListener('visibilitychange', () => { if (nav && !document.hidden) keepAwake(); });

export function stopNav() {
  if (!nav) return;
  clearInterval(nav.timer);
  if (nav.watchId != null) navigator.geolocation.clearWatch(nav.watchId);
  C.map.off('dragstart', onUserMove);
  nav = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  try { wakeLock && wakeLock.release(); } catch (e) { /* ok */ }
  wakeLock = null;
  document.getElementById('nav')?.remove();
  document.body.classList.remove('navigating');
  setNavLayers(false);
  C.map.getSource('nav')?.setData({ type: 'FeatureCollection', features: [] });
  C.map.easeTo({ pitch: 0, bearing: 0, zoom: Math.min(C.map.getZoom(), 15), duration: 700 });
}

export const navState = () => nav;
