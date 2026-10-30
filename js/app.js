// Bus Roma Live — mappa, fermate, linee e calcolo del percorso.

import { api, decodePolyline, rawTripId } from './api.js';
import { decodeTripUpdates } from './gtfsrt.js';
import { initDeviation, openDeviation, setupDeviationLayers } from './deviation.js';
import { initNav, openNavPicker, setupNavLayers, navState } from './nav.js';
import { GpsSource, EstimatedSource, findTransitousTrip, distance, ROME_BOUNDS } from './vehicles.js';
import { store, loadRoutes, loadTrips, loadShapes, loadLineStops, colorOf, kindOf, niceName, PALETTE } from './data.js';

const C = window.CONFIG;
const params = new URLSearchParams(location.search);
const PROXY = params.get('proxy') || C.PROXY_URL || '';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMPTY = { type: 'FeatureCollection', features: [] };

const state = {
  source: null,
  gps: PROXY ? new GpsSource(PROXY) : null,
  est: new EstimatedSource(),
  vehicles: [],
  shown: new Map(),       // id -> { from:[lng,lat], to:[lng,lat], v }
  animStart: 0,
  feedTime: 0,
  lastOk: 0,
  errors: 0,
  timer: null,
  lineFilter: null,       // "64"
  selected: null,         // id del mezzo selezionato
  focusTrips: null,       // Set di id corsa da evidenziare (percorso scelto / corsa aperta)
  me: null,               // [lng, lat]
  from: null, to: null,   // { name, lngLat, isMe }
  itins: [], direct: [], selItin: -1,
  planTimer: null,
  showStops: true,
  view: null,             // cosa mostra il pannello: { type, ... }
};

// ---------------- formattazione ----------------
const fmtTime = (d) => new Date(d).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const minutesFrom = (d) => Math.round((new Date(d).getTime() - Date.now()) / 60000);
function fmtIn(d) {
  const m = minutesFrom(d);
  if (m <= 0) return 'ora';
  if (m < 60) return `${m} min`;
  return fmtTime(d);
}
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
function fmtDist(m) {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}
function delayText(real, sched) {
  if (!real || !sched) return '';
  const d = Math.round((new Date(real) - new Date(sched)) / 60000);
  if (d >= 1) return `<span class="late">+${d} min</span>`;
  if (d <= -1) return `<span class="late">${d} min</span>`;
  return '';
}
function badge(line, color, big = false) {
  return `<span class="badge${big ? ' big' : ''}" style="background:${color}">${esc(line || '?')}</span>`;
}
const OCCUPANCY = ['vuoto', 'molti posti liberi', 'pochi posti liberi', 'solo in piedi', 'pochissimo spazio', 'pieno', 'non accetta passeggeri'];

const ICON = {
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M10 21l2-6 3 3v5M9 12l1-4 4 1 2 4h3M10 8l-3 4"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  place: '<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V8l7-5 7 5v13M10 21v-6h4v6"/></svg>',
  me: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><path d="M5 16V7a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v9M5 12h14M7 19v1M17 19v1M5 16h14v3H5z"/></svg>',
};

// ---------------- mappa ----------------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: C.CENTER,
  zoom: C.ZOOM,
  minZoom: 8,
  maxZoom: 19,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: false,
});
map.touchZoomRotate.disableRotation();
window.__busMap = map; // utile per le prove automatiche
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Dati ATAC: <a href="https://romamobilita.it/sistemi-e-tecnologie/open-data/" target="_blank" rel="noopener">Roma Mobilità</a> · Percorsi: <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>',
}), 'bottom-left');

const S = 2; // le immagini sono disegnate a doppia risoluzione per schermi nitidi
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w * S; c.height = h * S;
  const g = c.getContext('2d');
  g.scale(S, S);
  return [c, g];
}
const imageOf = (c) => ({ width: c.width, height: c.height, data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data });

// freccia di direzione: sta fuori dal simbolo del mezzo e viene ruotata nel verso di marcia
function makeArrow(color, size, tipY, baseY, half) {
  const [c, g] = canvas(size, size);
  g.fillStyle = color; g.strokeStyle = '#fff'; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(size / 2, tipY); g.lineTo(size / 2 + half, baseY); g.lineTo(size / 2 - half, baseY);
  g.closePath(); g.stroke(); g.fill();
  return imageOf(c);
}

// icona del mezzo (vista dal davanti) su quadratino colorato
function makeVehicleIcon(kind, color, highlight) {
  const W = 30;
  const [c, g] = canvas(W, W);
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  rr(2, 2, W - 4, W - 4, 8);
  g.fillStyle = color; g.fill();
  g.lineWidth = highlight ? 2.6 : 2; g.strokeStyle = highlight ? '#1B1D22' : '#fff'; g.stroke();
  g.fillStyle = '#fff'; g.strokeStyle = '#fff';
  if (kind === 'metro') {
    g.font = '800 15px Figtree, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('M', W / 2, W / 2 + 1);
    return imageOf(c);
  }
  const train = kind === 'rail', tram = kind === 'tram';
  const top = tram ? 10 : 8;
  // carrozzeria
  rr(9, top, 12, 23 - top, train ? [5, 5, 2, 2] : 2.5); g.fill();
  // ruote
  rr(10, 22.5, 2.6, 2.5, 0.8); g.fill();
  rr(17.4, 22.5, 2.6, 2.5, 0.8); g.fill();
  // parabrezza e fari (nel colore della linea)
  g.fillStyle = color;
  rr(10.6, top + 2, 8.8, train ? 5 : 5.5, 1.2); g.fill();
  g.beginPath(); g.arc(12, 20.2, 1.05, 0, 7); g.arc(18, 20.2, 1.05, 0, 7); g.fill();
  g.fillStyle = '#fff';
  if (tram) {
    // pantografo
    g.lineWidth = 1.3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(12.5, top); g.lineTo(15, 6.2); g.lineTo(17.5, top); g.stroke();
    g.beginPath(); g.moveTo(12.2, 5.6); g.lineTo(17.8, 5.6); g.stroke();
  } else if (!train) {
    // specchietti
    g.lineWidth = 1.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(9, top + 3); g.lineTo(7.6, top + 4.6); g.moveTo(21, top + 3); g.lineTo(22.4, top + 4.6); g.stroke();
  }
  return imageOf(c);
}

// etichetta colorata con il numero di linea (si allarga in base al testo)
function makePill(color) {
  const [c, g] = canvas(20, 18);
  g.beginPath(); g.roundRect(1, 1, 18, 16, 6);
  g.fillStyle = color; g.fill(); g.lineWidth = 1.6; g.strokeStyle = '#fff'; g.stroke();
  return imageOf(c);
}

function setupLayers() {
  for (const [k, col] of Object.entries(PALETTE)) {
    map.addImage('arrow-' + k, makeArrow(col, 44, 2, 11.5, 7), { pixelRatio: S });
    map.addImage('arrowL-' + k, makeArrow(col, 64, 1.5, 9.5, 6), { pixelRatio: S });
    map.addImage('veh-' + k, makeVehicleIcon(k, col, false), { pixelRatio: S });
    map.addImage('veh-' + k + '-hl', makeVehicleIcon(k, col, true), { pixelRatio: S });
    map.addImage('pill-' + k, makePill(col), { pixelRatio: S, stretchX: [[7 * S, 13 * S]], stretchY: [[7 * S, 11 * S]], content: [5 * S, 3 * S, 15 * S, 15 * S] });
  }
  for (const [k, st] of Object.entries(STATUS)) {
    map.addImage('pill-st-' + k, makePill(st.color), { pixelRatio: S, stretchX: [[7 * S, 13 * S]], stretchY: [[7 * S, 11 * S]], content: [5 * S, 3 * S, 15 * S, 15 * S] });
  }
  map.addImage('arrow-hl', makeArrow('#F2B33D', 44, 2, 11.5, 7), { pixelRatio: S });
  map.addImage('arrowL-hl', makeArrow('#F2B33D', 64, 1.5, 9.5, 6), { pixelRatio: S });

  const font = ['Noto Sans Bold'];
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addSource('plan', { type: 'geojson', data: EMPTY });
  map.addSource('stops', { type: 'geojson', data: EMPTY });
  map.addSource('veh', { type: 'geojson', data: EMPTY });
  map.addSource('me', { type: 'geojson', data: EMPTY });

  // percorso di una linea / corsa
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 10] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-opacity': ['coalesce', ['get', 'op'], 0.9],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 6] } });
  map.addLayer({ id: 'route-stops', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'], minzoom: 12,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5], 'circle-color': '#fff',
      'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.5 } });

  // percorso calcolato
  map.addLayer({ id: 'plan-casing', type: 'line', source: 'plan', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 12] } });
  map.addLayer({ id: 'plan-walk', type: 'line', source: 'plan', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'walk'], 1]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#5B6170', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 5], 'line-dasharray': [0.1, 1.8] } });
  map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'walk'], 0]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 8] } });
  map.addLayer({ id: 'plan-points', type: 'circle', source: 'plan', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': ['match', ['get', 'role'], 'end', 8, 'start', 7, 5.5],
      'circle-color': ['match', ['get', 'role'], 'end', '#8E1537', 'start', '#2563EB', '#fff'],
      'circle-stroke-color': ['match', ['get', 'role'], 'stop', '#1B1D22', '#fff'], 'circle-stroke-width': 2.5 } });

  // fermate
  map.addLayer({ id: 'stops-dot', type: 'circle', source: 'stops', minzoom: 14.5,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 3, 18, 6.5], 'circle-color': '#fff',
      'circle-stroke-color': '#3F4450', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14.5, 1.2, 18, 2] } });
  map.addLayer({ id: 'stops-label', type: 'symbol', source: 'stops', minzoom: 16.3,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-offset': [0, 1.1],
      'text-anchor': 'top', 'text-max-width': 9, 'text-optional': true },
    paint: { 'text-color': '#3F4450', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });

  // mezzi
  const dim = ['case', ['==', ['get', 'dim'], 1], 0.22, 1];
  map.addLayer({ id: 'veh-halo', type: 'circle', source: 'veh', filter: ['==', ['get', 'hl'], 1],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 12.5, 16, 14, 19, 17, 26], 'circle-color': '#F2B33D', 'circle-opacity': 0.42, 'circle-blur': 0.15 } });
  // da lontano: pallini (con numero da zoom 12,5); da vicino (zoom 14+): icone di bus/tram/metro
  const ICON_Z = 14;
  map.addLayer({ id: 'veh-arrow', type: 'symbol', source: 'veh', minzoom: 12.5, maxzoom: ICON_Z, filter: ['>=', ['get', 'b'], 0],
    layout: { 'icon-image': ['case', ['==', ['get', 'hl'], 1], 'arrow-hl', ['concat', 'arrow-', ['get', 'kind']]],
      'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.78, 14, 0.9] },
    paint: { 'icon-opacity': dim } });
  map.addLayer({ id: 'veh-arrow-l', type: 'symbol', source: 'veh', minzoom: ICON_Z, filter: ['>=', ['get', 'b'], 0],
    layout: { 'icon-image': ['case', ['==', ['get', 'hl'], 1], 'arrowL-hl', ['concat', 'arrowL-', ['get', 'kind']]],
      'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], ICON_Z, 0.9, 17, 1.1] },
    paint: { 'icon-opacity': dim } });
  map.addLayer({ id: 'veh-dot', type: 'circle', source: 'veh', maxzoom: ICON_Z,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 12, 4, 12.5, 9, 14, 10.5],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': ['case', ['==', ['get', 'hl'], 1], '#1B1D22', '#fff'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 12.5, 2],
      'circle-opacity': dim, 'circle-stroke-opacity': dim,
    } });
  map.addLayer({ id: 'veh-label', type: 'symbol', source: 'veh', minzoom: 12.5, maxzoom: ICON_Z,
    layout: { 'text-field': ['get', 'line'], 'text-font': font,
      'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, ['case', ['>', ['length', ['get', 'line']], 3], 7.5, 9.5], 14, ['case', ['>', ['length', ['get', 'line']], 3], 8.5, 10.5]],
      'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#fff', 'text-opacity': dim } });
  map.addLayer({ id: 'veh-icon', type: 'symbol', source: 'veh', minzoom: ICON_Z,
    layout: { 'icon-image': ['concat', 'veh-', ['get', 'kind'], ['case', ['==', ['get', 'hl'], 1], '-hl', '']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], ICON_Z, 0.9, 17, 1.1],
      'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'icon-opacity': dim } });
  map.addLayer({ id: 'veh-pill', type: 'symbol', source: 'veh', minzoom: ICON_Z,
    layout: { 'text-field': ['get', 'tag'], 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], ICON_Z, 10.5, 17, 12.5],
      'text-anchor': 'top', 'text-offset': ['interpolate', ['linear'], ['zoom'], ICON_Z, ['literal', [0, 1.25]], 17, ['literal', [0, 1.35]]],
      'icon-image': ['get', 'pill'], 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 4, 0, 4],
      'text-allow-overlap': true, 'text-ignore-placement': true, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    paint: { 'text-color': '#fff', 'text-opacity': dim, 'icon-opacity': dim } });

  setupDeviationLayers(map);
  setupNavLayers(map);

  // la mia posizione
  map.addLayer({ id: 'me-halo', type: 'circle', source: 'me', paint: { 'circle-radius': 16, 'circle-color': '#2563EB', 'circle-opacity': 0.16 } });
  map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: { 'circle-radius': 7, 'circle-color': '#2563EB', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
}

// ---------------- mezzi: aggiornamento e disegno ----------------
function startSource(src) {
  state.source = src;
  state.errors = 0;
  clearTimeout(state.timer);
  refreshVehicles();
}

function estBounds() {
  if (map.getZoom() < 12.5) return ROME_BOUNDS;
  const b = map.getBounds();
  const padLat = (b.getNorth() - b.getSouth()) * 0.35, padLng = (b.getEast() - b.getWest()) * 0.35;
  return { south: b.getSouth() - padLat, north: b.getNorth() + padLat, west: b.getWest() - padLng, east: b.getEast() + padLng };
}

async function refreshVehicles() {
  const src = state.source;
  clearTimeout(state.timer);
  let next = src.kind === 'gps' ? Math.max(10, C.REFRESH_SECONDS || 15) : 60;
  try {
    const res = src.kind === 'gps' ? await src.fetch() : await src.fetch(estBounds());
    if (src !== state.source) return;
    state.errors = 0;
    state.lastOk = Date.now();
    state.feedTime = res.feedTime;
    applyVehicles(res.vehicles);
  } catch (e) {
    console.warn('Aggiornamento mezzi non riuscito', e);
    state.errors++;
    if (src.kind === 'gps' && state.errors >= 3) {
      toast('Il GPS di ATAC non risponde: passo alle posizioni stimate');
      startSource(state.est);
      setTimeout(() => state.gps && state.source === state.est && startSource(state.gps), 3 * 60_000);
      return;
    }
    next = Math.min(next, 15 * state.errors);
  }
  updateStatus();
  state.timer = setTimeout(refreshVehicles, next * 1000);
}

function applyVehicles(list) {
  state.vehicles = list;
  if (state.source.kind === 'gps') {
    // animazione morbida dalla vecchia alla nuova posizione
    const t = performance.now();
    const shown = new Map();
    for (const v of list) {
      const old = state.shown.get(v.id);
      let from = [v.lng, v.lat];
      if (old) {
        const cur = currentPos(old, t);
        if (distance(cur, from) < 1500) from = cur;
      }
      shown.set(v.id, { from, to: [v.lng, v.lat], v });
    }
    state.shown = shown;
    state.animStart = t;
    requestAnimationFrame(animate);
  } else {
    state.shown = new Map(list.map((v) => [v.id, { from: [v.lng, v.lat], to: [v.lng, v.lat], v }]));
    draw();
  }
  onVehiclesUpdated();
}

const ANIM_MS = 1600;
function currentPos(s, t) {
  const f = Math.min(1, (t - state.animStart) / ANIM_MS);
  const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
  return [s.from[0] + (s.to[0] - s.from[0]) * e, s.from[1] + (s.to[1] - s.from[1]) * e];
}
function animate(t) {
  draw(t);
  if (t - state.animStart < ANIM_MS) requestAnimationFrame(animate);
}

// la fonte stimata si muove da sola: ricalcolo delle posizioni ogni mezzo secondo
setInterval(() => {
  if (state.source && state.source.kind === 'est' && state.est.trips.size && !document.hidden) {
    const list = state.est.positions();
    state.vehicles = list;
    state.shown = new Map(list.map((v) => [v.id, { from: [v.lng, v.lat], to: [v.lng, v.lat], v }]));
    draw();
  }
}, 500);

function lineMatches(v) {
  return !state.lineFilter || String(v.line).toLowerCase() === state.lineFilter.toLowerCase();
}

function draw(t = performance.now()) {
  const src = map.getSource('veh');
  if (!src) return;
  const feats = [];
  const focus = state.focusTrips;
  for (const s of state.shown.values()) {
    const v = s.v;
    if (!lineMatches(v)) continue;
    const pos = state.source.kind === 'gps' ? currentPos(s, t) : s.to;
    const inFocus = focus && focus.has(v.tripId);
    const hl = v.id === state.selected || inFocus ? 1 : 0;
    const kind = kindOf(v);
    let color = colorOf(v), pill = 'pill-' + kind, tag = String(v.line || '?');
    if (state.lineFilter) {
      const info = lineInfo(v);
      const st = statusOf(info ? info.delay : null);
      color = STATUS[st].color;
      pill = 'pill-st-' + st;
      if (info && info.delay != null) tag += info.delay >= 2 ? ` +${info.delay}′` : info.delay <= -1 ? ` ${info.delay}′` : ' ✓';
    }
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: {
        id: v.id,
        line: String(v.line || '?'),
        color,
        kind,
        pill,
        tag,
        b: v.bearing == null ? -1 : Math.round(v.bearing),
        hl,
        dim: focus && !inFocus && !hl ? 1 : 0,
      },
    });
  }
  // i mezzi evidenziati vanno disegnati sopra gli altri
  feats.sort((a, b) => a.properties.hl - b.properties.hl || b.properties.dim - a.properties.dim);
  src.setData({ type: 'FeatureCollection', features: feats });
}

function vehicleById(id) {
  const s = state.shown.get(id);
  return s ? s.v : null;
}
function vehicleByTrip(rawId) {
  if (!rawId) return null;
  for (const s of state.shown.values()) if (s.v.tripId === rawId) return s.v;
  return null;
}

function updateStatus() {
  const el = $('status');
  const n = [...state.shown.values()].filter((s) => lineMatches(s.v)).length;
  const src = state.source;
  el.classList.remove('live', 'est', 'err');
  let text;
  if (!state.lastOk) {
    text = state.errors ? 'Dati non disponibili, riprovo…' : 'Carico i mezzi…';
    if (state.errors) el.classList.add('err');
  } else if (src.kind === 'gps') {
    const age = Math.max(0, Math.round(Date.now() / 1000 - (state.feedTime || state.lastOk / 1000)));
    text = `${n.toLocaleString('it-IT')} mezzi · GPS · ${age < 90 ? age + ' s fa' : Math.round(age / 60) + ' min fa'}`;
    el.classList.add(age > 180 ? 'err' : 'live');
  } else {
    text = `${n.toLocaleString('it-IT')} mezzi · posizioni stimate`;
    el.classList.add('est');
  }
  $('statusText').textContent = text;
}
setInterval(updateStatus, 1000);

// ---------------- fermate ----------------
let stopsCtrl = null, stopsBox = null;
async function refreshStops() {
  if (!state.showStops || map.getZoom() < 14.5) {
    if (map.getZoom() < 14.5) { stopsBox = null; }
    return;
  }
  const b = map.getBounds();
  if (stopsBox && b.getSouth() >= stopsBox.south && b.getNorth() <= stopsBox.north && b.getWest() >= stopsBox.west && b.getEast() <= stopsBox.east) return;
  const padLat = (b.getNorth() - b.getSouth()) * 0.5, padLng = (b.getEast() - b.getWest()) * 0.5;
  const box = { south: b.getSouth() - padLat, north: b.getNorth() + padLat, west: b.getWest() - padLng, east: b.getEast() + padLng };
  if (stopsCtrl) stopsCtrl.abort();
  stopsCtrl = new AbortController();
  try {
    const places = await api.mapStops(box, { signal: stopsCtrl.signal });
    stopsBox = box;
    map.getSource('stops').setData({
      type: 'FeatureCollection',
      features: places.filter((p) => p.stopId).map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.stopId, name: niceName(p.name), code: p.stopCode || '' },
      })),
    });
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Fermate non disponibili', e);
  }
}

// ---------------- pannello ----------------
const sheet = $('sheet'), sheetBody = $('sheetBody');
function openSheet(html, view, { tall = false } = {}) {
  sheetBody.innerHTML = html;
  sheet.hidden = false;
  sheet.classList.toggle('tall', tall);
  state.view = view;
  sheetBody.scrollTop = 0;
  layoutFabs();
}
function closeSheet() {
  sheet.hidden = true;
  const v = state.view;
  state.view = null;
  state.selected = null;
  state.focusTrips = null;
  clearInterval(state.viewTimer);
  if (v && (v.type === 'plan' || v.type === 'itin')) clearPlan();
  if (v && v.type === 'line') clearLine();
  map.getSource('route') && map.getSource('route').setData(EMPTY);
  draw();
  layoutFabs();
}
function layoutFabs() {
  const fabs = document.querySelector('.fabs');
  const attrib = document.querySelector('.maplibregl-ctrl-bottom-left');
  const wide = window.innerWidth >= 900;
  const h = !sheet.hidden && !wide ? sheet.offsetHeight : 0;
  fabs.style.bottom = `calc(${h ? h + 12 : 40}px + var(--safe-bottom))`;
  if (attrib) attrib.style.bottom = h ? h + 'px' : '';
}
new ResizeObserver(layoutFabs).observe(sheet);
window.addEventListener('resize', layoutFabs);
$('sheetClose').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideSuggest(); if (!sheet.hidden) closeSheet(); } });

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}

// ---------------- scheda del mezzo ----------------
function showVehicle(v) {
  state.selected = v.id;
  state.focusTrips = null;
  draw();
  const color = colorOf(v);
  const age = v.ts ? Math.max(0, Math.round(Date.now() / 1000 - v.ts)) : null;
  const facts = [];
  if (v.source === 'gps') {
    facts.push(`Vettura <b>${esc(v.vehicleNo)}</b>`);
    if (age != null) facts.push(`<span class="rt">GPS ${age < 90 ? age + ' s' : Math.round(age / 60) + ' min'} fa</span>`);
    if (v.speed > 0.5) facts.push(`${Math.round(v.speed * 3.6)} km/h`);
    if (v.occupancy != null && OCCUPANCY[v.occupancy]) facts.push(OCCUPANCY[v.occupancy]);
  } else {
    facts.push(v.realTime ? '<span class="rt">Posizione stimata con ritardi reali</span>' : 'Posizione stimata da orario');
    if (v.nextStop) facts.push(`Prossima: <b>${esc(v.nextStop)}</b>`);
  }
  openSheet(`
    <div class="head">${badge(v.line, color, true)}
      <div class="dest" id="vehDest">${v.headsign ? `<span class="arrow">verso</span> ${esc(v.headsign)}` : '<span class="arrow">Direzione non disponibile</span>'}</div>
    </div>
    <div class="facts">${facts.join('<span class="muted">·</span>')}</div>
    <div class="actions">
      <button class="btn ghost" id="showLineBtn">${ICON.bus} Tutta la linea ${esc(v.line)}</button>
    </div>
    <div class="section-title">Fermate della corsa</div>
    <div id="tripStops"><div class="spinner">Carico gli orari…</div></div>
  `, { type: 'vehicle', id: v.id });
  $('showLineBtn').onclick = () => showLine(v.line);
  showPoint([v.lng, v.lat], map.getZoom());
  loadTripFor(v);
}

async function loadTripFor(v) {
  const box = () => document.getElementById('tripStops');
  try {
    const ttId = await findTransitousTrip(v);
    if (!ttId) throw new Error('corsa non trovata');
    const it = await api.trip(ttId);
    if (state.view?.type !== 'vehicle' || state.view.id !== v.id) return;
    renderTripStops(it, colorOf(v), box(), v);
  } catch (e) {
    if (box()) box().innerHTML = '<p class="muted">Orari di questa corsa non disponibili al momento.</p>';
  }
}

function tripStopsOf(it) {
  const stops = [];
  for (const leg of it.legs || []) {
    if (!leg.from) continue;
    const seq = [leg.from, ...(leg.intermediateStops || []), leg.to];
    for (const p of seq) {
      const last = stops[stops.length - 1];
      if (last && last.stopId === p.stopId) { last.departure = p.departure || last.departure; continue; }
      stops.push({ ...p });
    }
  }
  return stops;
}

function renderTripStops(it, color, el, v) {
  const legs = (it.legs || []).filter((l) => l.from);
  if (!legs.length || !el) return;
  const leg = legs[0];
  const stops = tripStopsOf(it);
  const now = Date.now();
  let nextIdx = stops.findIndex((p) => new Date(p.arrival || p.departure).getTime() > now - 20_000);
  if (nextIdx < 0) nextIdx = stops.length;

  if (v && !v.headsign && leg.headsign) {
    const d = document.getElementById('vehDest');
    if (d) d.innerHTML = `<span class="arrow">verso</span> ${esc(niceName(leg.headsign))}`;
  }
  const rows = stops.map((p, i) => {
    const t = p.arrival || p.departure;
    const st = p.scheduledArrival || p.scheduledDeparture;
    const cls = i < nextIdx ? 'past' : i === nextIdx ? 'next' : '';
    return `<li class="${cls}"><span>${esc(niceName(p.name))}</span><span class="t">${t ? fmtTime(t) : ''} ${i >= nextIdx ? delayText(t, st) : ''}</span></li>`;
  }).join('');
  el.innerHTML = `
    ${leg.realTime ? '<p class="muted"><span class="rt">Orari aggiornati in tempo reale</span></p>' : '<p class="muted">Orari programmati (nessun dato in tempo reale per questa corsa)</p>'}
    <ol class="timeline" style="--c:${color}">${rows}</ol>`;
  const next = el.querySelector('li.next');
  if (next) setTimeout(() => next.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);

  // disegno della corsa sulla mappa
  const coords = [];
  for (const l of legs) {
    if (l.legGeometry && l.legGeometry.points) coords.push(...decodePolyline(l.legGeometry.points, l.legGeometry.precision || 6));
  }
  const feats = [];
  if (coords.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color } });
  for (const p of stops) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { color } });
  map.getSource('route').setData({ type: 'FeatureCollection', features: feats });
}

// ---------------- scheda della fermata ----------------
function showStop(stop) {
  state.selected = null;
  draw();
  openSheet(`
    <h2>${esc(stop.name)}</h2>
    <p class="sub">Fermata${stop.code ? ' ' + esc(stop.code) : ''} · prossimi passaggi</p>
    <div id="deps"><div class="spinner">Carico i passaggi…</div></div>
    <div class="actions"><button class="btn ghost" id="goStop">${ICON.walk} Portami qui</button></div>
  `, { type: 'stop', id: stop.id });
  $('goStop').onclick = () => setDestination({ name: stop.name, lngLat: stop.lngLat });
  const load = async () => {
    try {
      const res = await api.stoptimes(stop.id);
      if (state.view?.type !== 'stop' || state.view.id !== stop.id) return;
      renderDepartures(res.stopTimes || []);
    } catch (e) {
      const el = document.getElementById('deps');
      if (el) el.innerHTML = '<p class="muted">Passaggi non disponibili al momento. Riprova tra poco.</p>';
    }
  };
  load();
  clearInterval(state.viewTimer);
  state.viewTimer = setInterval(load, 30_000);
}

function renderDepartures(list) {
  const el = document.getElementById('deps');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<p class="muted">Nessun passaggio nella prossima ora.</p>'; return; }
  el.innerHTML = `<ul class="rows">${list.map((s, i) => {
    const p = s.place;
    const t = p.departure || p.arrival, st = p.scheduledDeparture || p.scheduledArrival;
    const line = s.displayName || s.routeShortName || '?';
    const color = colorOf({ mode: s.mode, line });
    const head = niceName(s.headsign || (s.tripTo && s.tripTo.name) || '');
    const cancelled = s.cancelled || s.tripCancelled;
    return `<li data-i="${i}">${badge(line, color)}
      <div class="grow"><div class="title">${esc(head)}</div>
        ${cancelled ? '<div class="muted late">Soppressa</div>' : ''}</div>
      <div class="when ${s.realTime ? 'rt-time' : ''}">${cancelled ? '—' : fmtIn(t)}<small>${fmtTime(t)} ${delayText(t, st)}</small></div></li>`;
  }).join('')}</ul>
  <p class="muted"><span class="rt">verde</span> = orario in tempo reale · nero = orario programmato</p>`;
  el.querySelectorAll('li').forEach((li) => {
    li.onclick = () => {
      const s = list[+li.dataset.i];
      showTrip(s.tripId, { line: s.displayName || s.routeShortName, mode: s.mode, headsign: niceName(s.headsign) });
    };
  });
}

// ---------------- scheda di una corsa (da fermata) ----------------
async function showTrip(ttTripId, { line, mode, headsign }) {
  const raw = rawTripId(ttTripId);
  const color = colorOf({ mode, line });
  state.selected = null;
  state.focusTrips = new Set([raw]);
  draw();
  openSheet(`
    <div class="head">${badge(line, color, true)}<div class="dest"><span class="arrow">verso</span> ${esc(headsign || '')}</div></div>
    <div id="tripLive"></div>
    <div class="actions"><button class="btn ghost" id="showLineBtn">${ICON.bus} Tutta la linea ${esc(line)}</button></div>
    <div class="section-title">Fermate della corsa</div>
    <div id="tripStops"><div class="spinner">Carico gli orari…</div></div>
  `, { type: 'trip', raw });
  $('showLineBtn').onclick = () => showLine(line);
  updateTripLive();
  try {
    const it = await api.trip(ttTripId);
    if (state.view?.type !== 'trip' || state.view.raw !== raw) return;
    renderTripStops(it, color, document.getElementById('tripStops'), null);
  } catch (e) {
    const el = document.getElementById('tripStops');
    if (el) el.innerHTML = '<p class="muted">Orari non disponibili al momento.</p>';
  }
}
function updateTripLive() {
  const el = document.getElementById('tripLive');
  if (!el || state.view?.type !== 'trip') return;
  const v = vehicleByTrip(state.view.raw);
  el.innerHTML = v
    ? `<div class="live-box" id="flyVeh">${ICON.bus}<div>Il mezzo è sulla mappa${v.source === 'gps' ? ` (vettura <b>${esc(v.vehicleNo)}</b>, posizione GPS)` : ' (posizione stimata)'}. Tocca per vederlo.</div></div>`
    : `<div class="live-box none">${ICON.bus}<div>Il mezzo non è ancora visibile: forse non è ancora partito dal capolinea.</div></div>`;
  const b = document.getElementById('flyVeh');
  if (b) b.onclick = () => showPoint([v.lng, v.lat], 15.5);
}

// ---------------- puntualità ----------------
const STATUS = {
  ok: { color: '#138A4B', label: 'In orario' },
  early: { color: '#2563EB', label: 'In anticipo' },
  late: { color: '#E07A00', label: 'In ritardo' },
  vlate: { color: '#C81E1E', label: 'Forte ritardo' },
  na: { color: '#7A808C', label: 'Dato non disponibile' },
};
function statusOf(d) {
  if (d == null) return 'na';
  if (d <= -1) return 'early';
  if (d < 2) return 'ok';
  if (d < 5) return 'late';
  return 'vlate';
}
function delayWords(d) {
  if (d == null) return 'puntualità non disponibile';
  if (d <= -1) return `${-d} min in anticipo`;
  if (d < 2) return 'in orario';
  return `${d} min di ritardo`;
}

// Per ogni corsa della linea: ritardo (minuti), prossima fermata e orario previsto.
// I dati arrivano da Transitous, che usa le previsioni in tempo reale pubblicate da ATAC.
async function fetchLineDelays() {
  const view = state.view;
  if (view?.type !== 'line') return;
  if (PROXY) fetchAtacDelays(view);
  const vehicles = [...state.shown.values()].map((x) => x.v).filter(lineMatches);
  const pts = (view.shapePts || []).concat(vehicles.map((v) => [v.lng, v.lat]));
  if (!pts.length) return;
  let w = 180, so = 90, e = -180, n = -90;
  for (const [x, y] of pts) { w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y); }
  const pad = 0.01, now = Date.now();
  try {
    const segs = await api.mapTrips({ south: so - pad, north: n + pad, west: w - pad, east: e + pad }, new Date(now - 3 * 60_000), new Date(now + 3 * 60_000));
    if (state.view !== view) return;
    const byTrip = new Map();
    for (const sg of segs) {
      for (const t of sg.trips || []) {
        const line = t.displayName || t.routeShortName;
        if (String(line).toLowerCase() !== view.name.toLowerCase()) continue;
        const raw = rawTripId(t.tripId);
        if (!byTrip.has(raw)) byTrip.set(raw, []);
        byTrip.get(raw).push(sg);
      }
    }
    const delays = new Map();
    for (const [raw, list] of byTrip) {
      list.sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure));
      const t = Date.now();
      let seg = list.find((x) => Date.parse(x.departure) <= t && Date.parse(x.arrival) >= t);
      let ms;
      if (seg) ms = Date.parse(seg.arrival) - Date.parse(seg.scheduledArrival);
      else {
        seg = list.find((x) => Date.parse(x.departure) > t) || list[list.length - 1];
        ms = Date.parse(seg.departure) - Date.parse(seg.scheduledDeparture);
      }
      delays.set(raw, {
        delay: seg.realTime ? Math.round(ms / 60000) : null,
        nextStop: niceName(seg.to && seg.to.name),
        nextTime: seg.arrival,
      });
    }
    view.delays = delays;
    draw();
    renderLineView();
  } catch (err) {
    console.warn('Puntualità non disponibile', err);
  }
}
// Secondo canale: il file delle previsioni pubblicato direttamente da ATAC (tramite il ponte Cloudflare).
// Serve per i mezzi che Transitous non riesce a collegare a una corsa.
async function fetchAtacDelays(view) {
  try {
    const res = await fetch(PROXY.replace(/\/$/, '') + '/trips', { cache: 'no-store' });
    if (!res.ok) throw new Error('risposta ' + res.status);
    const list = decodeTripUpdates(await res.arrayBuffer());
    if (state.view !== view) return;
    const byTrip = new Map(), byVehicle = new Map();
    for (const u of list) {
      const info = { delay: u.delay == null ? null : Math.round(u.delay / 60), tripId: u.tripId };
      if (u.tripId) byTrip.set(u.tripId, info);
      if (u.vehicleId) byVehicle.set(u.vehicleId, info);
    }
    view.atac = { byTrip, byVehicle };
    // i mezzi GPS senza corsa ricevono la corsa dalle previsioni: così si sa anche la direzione
    if (state.gps) state.gps.tripByVehicle = new Map([...byVehicle].map(([k, x]) => [k, x.tripId]));
    draw();
    renderLineView();
  } catch (err) {
    console.warn('Previsioni ATAC non disponibili', err);
  }
}

function lineInfo(v) {
  const view = state.view;
  if (view?.type !== 'line') return null;
  const tt = view.delays ? view.delays.get(v.tripId) : null;
  if (tt && tt.delay != null) return tt;
  const a = view.atac;
  const at = a && ((v.tripId && a.byTrip.get(v.tripId)) || (v.source === 'gps' && a.byVehicle.get(v.id.slice(1))));
  if (at && at.delay != null) return { ...(tt || {}), delay: at.delay };
  return tt || at || null;
}

// ---------------- linea ----------------
$('lineChip').onclick = () => {
  if (state.lineFilter) { clearLine(); if (state.view?.type === 'line') closeSheet(); return; }
  const f = $('lineForm');
  f.hidden = !f.hidden;
  if (!f.hidden) $('lineInput').focus();
};
$('lineForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('lineInput').value.trim();
  if (v) showLine(v);
};

async function showLine(name) {
  name = String(name).trim();
  state.lineFilter = name;
  state.selected = null;
  state.focusTrips = null;
  $('lineForm').hidden = true;
  $('lineInput').value = '';
  $('lineInput').blur();
  $('lineChip').classList.add('active');
  $('lineChipText').textContent = `Linea ${name} ✕`;
  draw();
  updateStatus();
  openSheet(`<div id="lineView"><div class="spinner">Carico la linea…</div></div>`, { type: 'line', name });
  await loadShapes();
  if (state.view?.type !== 'line' || state.view.name !== name) return;
  const routeIds = Object.entries(store.routes || {}).filter(([, r]) => String(r.n).toLowerCase() === name.toLowerCase()).map(([id]) => id);
  const feats = [];
  const shapes = [];
  for (const rid of routeIds) for (const s of (store.shapes[rid] || [])) shapes.push(s);
  const vehicles = [...state.shown.values()].map((s) => s.v).filter(lineMatches);
  const color = colorOf(vehicles[0] || { type: routeIds.length ? store.routes[routeIds[0]].t : 3, line: name });
  shapes.forEach((s, i) => {
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: decodePolyline(s.p, 5) }, properties: { color, op: i % 2 ? 0.55 : 0.9 } });
  });
  map.getSource('route').setData({ type: 'FeatureCollection', features: feats });
  const pts = feats.length ? feats.flatMap((f) => f.geometry.coordinates) : vehicles.map((v) => [v.lng, v.lat]);
  state.view.shapes = shapes;
  state.view.shapePts = feats.flatMap((f) => f.geometry.coordinates);
  state.view.color = color;
  renderLineView();
  fetchLineDelays();
  clearInterval(state.lineTimer);
  state.lineTimer = setInterval(fetchLineDelays, 30_000);
  // aspetto che il pannello abbia la sua altezza definitiva, poi inquadro la linea
  if (pts.length) requestAnimationFrame(() => fitTo(pts));
}
function renderLineView() {
  const el = document.getElementById('lineView');
  if (!el || state.view?.type !== 'line') return;
  const { name, shapes = [], color = PALETTE.bus } = state.view;
  const vehicles = [...state.shown.values()].map((s) => s.v).filter(lineMatches);
  if (state.me) vehicles.sort((a, b) => distance(state.me, [a.lng, a.lat]) - distance(state.me, [b.lng, b.lat]));
  const groups = new Map();
  for (const v of vehicles) {
    const k = v.headsign || 'Direzione non nota';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  for (const s of shapes) if (s.h && !groups.has(s.h)) groups.set(s.h, []);
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === 'Direzione non nota') - (b[0] === 'Direzione non nota'));
  const delays = state.view.delays || state.view.atac;
  const count = { ok: 0, early: 0, late: 0, vlate: 0, na: 0 };
  const row = (v) => {
    const info = lineInfo(v);
    const d = info ? info.delay : null;
    const st = statusOf(d);
    count[st]++;
    const who = v.source === 'gps' ? 'Vettura ' + esc(v.vehicleNo) : 'Posizione stimata';
    const nextName = (info && info.nextStop) || v.nextStop || '';
    const next = nextName ? `→ ${esc(nextName)}` : '';
    const nextAt = info && info.nextTime && nextName ? `prossima fermata alle ${fmtTime(info.nextTime)}` : '';
    const dist = [nextAt, state.me ? `a ${fmtDist(distance(state.me, [v.lng, v.lat]))} da te` : ''].filter(Boolean).join(' · ');
    const when = !delays ? '<span class="muted">…</span>'
      : d == null ? '<span class="punct na">n.d.</span>'
      : st === 'ok' ? '<span class="punct ok">In orario</span>'
      : st === 'early' ? `<span class="punct early">−${-d} min</span>`
      : `<span class="punct ${st}">+${d} min</span>`;
    return `<li data-id="${esc(v.id)}">${badge(v.line, delays ? STATUS[st].color : colorOf(v))}
      <div class="grow"><div class="title">${next || who}</div>
        <div class="muted">${[next ? who : '', dist].filter(Boolean).join(' · ')}</div></div>
      <div class="when">${when}</div></li>`;
  };
  const html = ordered.map(([h, list]) => `
    <div class="section-title">${h === 'Direzione non nota' ? h : 'verso ' + esc(h)} · ${list.length} ${list.length === 1 ? 'mezzo' : 'mezzi'}</div>
    ${list.length ? `<ul class="rows">${list.map(row).join('')}</ul>` : '<p class="muted">Nessun mezzo in viaggio in questa direzione.</p>'}`).join('');
  const summary = vehicles.length && delays ? `<div class="punct-sum">
      <span><b>${count.ok}</b> in orario</span>
      <span class="late-t"><b>${count.late + count.vlate}</b> in ritardo</span>
      <span class="early-t"><b>${count.early}</b> in anticipo</span>
      ${count.na ? `<span class="muted"><b>${count.na}</b> senza dato</span>` : ''}
    </div>` : vehicles.length ? '<p class="muted">Calcolo la puntualità…</p>' : '';
  el.innerHTML = `
    <div class="head">${badge(name, color, true)}<h2>Linea ${esc(name)}</h2></div>
    <div class="actions" style="margin:-4px 0 10px"><button class="btn" id="navLineBtn">Naviga questa linea</button></div>
    ${!vehicles.length ? '<p class="sub">Nessun mezzo di questa linea in circolazione in questo momento.</p>' : ''}
    ${summary}
    ${html}
    ${vehicles.length ? `<p class="muted" style="margin-top:12px">Sulla mappa: <b style="color:${STATUS.ok.color}">verde</b> in orario,
      <b style="color:${STATUS.late.color}">arancio</b> ritardo 2-4 min, <b style="color:${STATUS.vlate.color}">rosso</b> 5 min o più,
      <b style="color:${STATUS.early.color}">blu</b> in anticipo, grigio senza dato. Ritardi calcolati sulle previsioni in tempo reale di ATAC; si aggiornano ogni 30 secondi.</p>` : ''}`;
  document.getElementById('navLineBtn').onclick = () => openNavPicker(name);
  el.querySelectorAll('li[data-id]').forEach((li) => {
    li.onclick = () => {
      const v = vehicleById(li.dataset.id);
      if (!v) return;
      showVehicle(v);
      showPoint([v.lng, v.lat], 15);
    };
  });
}
function clearLine() {
  state.lineFilter = null;
  clearInterval(state.lineTimer);
  $('lineChip').classList.remove('active');
  $('lineChipText').textContent = 'Linea';
  map.getSource('route') && map.getSource('route').setData(EMPTY);
  draw();
  updateStatus();
}

function mapPadding() {
  const wide = window.innerWidth >= 900;
  const H = window.innerHeight;
  let top = 150;
  let bottom = wide ? 40 : (sheet.hidden ? 60 : Math.min(H * 0.6, sheet.offsetHeight || H * 0.45) + 24);
  if (H - top - bottom < 140) { top = 110; bottom = Math.max(40, H - top - 140); }
  return { top, bottom, left: wide && !sheet.hidden ? 440 : 30, right: 70 };
}
function fitTo(points) {
  if (!points.length) return;
  let w = 180, s = 90, e = -180, n = -90;
  for (const [x, y] of points) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  map.fitBounds([[w, s], [e, n]], { padding: mapPadding(), maxZoom: 16.5, duration: 700 });
}
// porta un punto al centro della parte di mappa non coperta dal pannello
function showPoint(lngLat, minZoom = 15) {
  // (uso "offset" e non "padding": il padding resterebbe memorizzato nella mappa e falserebbe gli inquadramenti successivi)
  requestAnimationFrame(() => {
    const p = mapPadding();
    map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), minZoom), offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2], duration: 600 });
  });
}

// ---------------- la mia posizione ----------------
let watchId = null;
function getMe({ quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geo')); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      setMe([p.coords.longitude, p.coords.latitude]);
      if (watchId == null) {
        watchId = navigator.geolocation.watchPosition((q) => setMe([q.coords.longitude, q.coords.latitude]), () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
      }
      resolve(state.me);
    }, (err) => {
      if (!quiet) toast('Non riesco a leggere la tua posizione: controlla i permessi del browser');
      reject(err);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}
function setMe(lngLat) {
  state.me = lngLat;
  const src = map.getSource('me');
  if (src) src.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: {} });
  if (state.from && state.from.isMe) state.from.lngLat = lngLat;
}
$('locateBtn').onclick = async () => {
  try {
    const me = await getMe();
    map.flyTo({ center: me, zoom: Math.max(map.getZoom(), 16) });
    $('locateBtn').classList.add('on');
    setTimeout(() => $('locateBtn').classList.remove('on'), 1500);
  } catch (e) { /* già avvisato */ }
};

$('stopsBtn').onclick = () => {
  state.showStops = !state.showStops;
  $('stopsBtn').setAttribute('aria-pressed', String(state.showStops));
  for (const id of ['stops-dot', 'stops-label']) map.setLayoutProperty(id, 'visibility', state.showStops ? 'visible' : 'none');
  if (state.showStops) { stopsBox = null; refreshStops(); }
  toast(state.showStops ? 'Fermate visibili (avvicina lo zoom)' : 'Fermate nascoste');
};

// ---------------- ricerca e percorso ----------------
const toInput = $('toInput'), fromInput = $('fromInput'), suggest = $('suggest');
let suggestFor = null, suggestItems = [], geoCtrl = null, geoTimer = null, activeIdx = -1;

function hideSuggest() { suggest.hidden = true; suggestItems = []; activeIdx = -1; }

function onType(input, which) {
  clearTimeout(geoTimer);
  const text = input.value.trim();
  if (which === 'to' && !text) { hideSuggest(); return; }
  geoTimer = setTimeout(() => runGeocode(text, which), 250);
}
async function runGeocode(text, which) {
  suggestFor = which;
  const items = [];
  if (which === 'from' && (!text || 'la mia posizione'.startsWith(text.toLowerCase()))) {
    items.push({ kind: 'me', name: 'La mia posizione', sub: 'Usa il GPS del telefono' });
  }
  if (text.length >= 2) {
    if (geoCtrl) geoCtrl.abort();
    geoCtrl = new AbortController();
    try {
      const near = state.me || map.getCenter().toArray();
      const res = await api.geocode(text, near, { signal: geoCtrl.signal });
      for (const m of res) {
        const areas = (m.areas || []).filter((a) => !a.default).map((a) => a.name);
        const sub = [m.street && m.type !== 'ADDRESS' ? m.street : '', ...areas.slice(0, 2)].filter(Boolean).join(', ');
        items.push({
          kind: m.type === 'STOP' ? 'stop' : m.type === 'ADDRESS' ? 'address' : 'place',
          name: m.type === 'ADDRESS' ? [m.street || m.name, m.houseNumber].filter(Boolean).join(' ') : niceName(m.name),
          sub: m.type === 'STOP' ? 'Fermata' + (sub ? ' · ' + sub : '') : sub,
          lngLat: [m.lon, m.lat],
        });
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      items.push({ kind: 'err', name: 'Ricerca non disponibile', sub: 'Controlla la connessione e riprova' });
    }
  }
  renderSuggest(items);
}
function renderSuggest(items) {
  suggestItems = items;
  activeIdx = -1;
  if (!items.length) { suggest.innerHTML = '<li><div class="s-sub">Nessun risultato</div></li>'; suggest.hidden = false; return; }
  suggest.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}">
    <span class="s-ico">${it.kind === 'me' ? ICON.me : it.kind === 'stop' ? ICON.stop : it.kind === 'place' ? ICON.place : ICON.stop}</span>
    <div><div class="s-main">${esc(it.name)}</div>${it.sub ? `<div class="s-sub">${esc(it.sub)}</div>` : ''}</div></li>`).join('');
  suggest.hidden = false;
  suggest.querySelectorAll('li[data-i]').forEach((li) => {
    li.onmousedown = (e) => e.preventDefault();
    li.onclick = () => pickSuggestion(suggestItems[+li.dataset.i]);
  });
}
async function pickSuggestion(it) {
  if (!it || it.kind === 'err') return;
  hideSuggest();
  if (suggestFor === 'from') {
    if (it.kind === 'me') await useMyLocationAsFrom();
    else { state.from = { name: it.name, lngLat: it.lngLat }; fromInput.value = it.name; }
    fromInput.blur();
    if (state.to) plan();
  } else {
    setDestination({ name: it.name, lngLat: it.lngLat });
  }
}
async function useMyLocationAsFrom() {
  fromInput.value = 'La mia posizione';
  state.from = { name: 'La mia posizione', lngLat: state.me, isMe: true };
  if (!state.me) {
    try { await getMe(); state.from.lngLat = state.me; } catch (e) { state.from = null; fromInput.value = ''; fromInput.focus(); return false; }
  }
  return true;
}

toInput.addEventListener('input', () => onType(toInput, 'to'));
fromInput.addEventListener('input', () => onType(fromInput, 'from'));
fromInput.addEventListener('focus', () => { fromInput.select(); runGeocode(fromInput.value === 'La mia posizione' ? '' : fromInput.value.trim(), 'from'); });
toInput.addEventListener('focus', () => { $('lineForm').hidden = true; if (toInput.value.trim() && !state.to) onType(toInput, 'to'); });
for (const inp of [toInput, fromInput]) {
  inp.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  inp.addEventListener('keydown', (e) => {
    const lis = [...suggest.querySelectorAll('li[data-i]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!lis.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
      lis.forEach((l, i) => l.setAttribute('aria-selected', String(i === activeIdx)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestItems.length) pickSuggestion(suggestItems[Math.max(0, activeIdx)]);
    }
  });
}
$('clearSearch').onclick = () => { if (state.view && (state.view.type === 'plan' || state.view.type === 'itin')) closeSheet(); else clearPlan(); };

async function setDestination(dest) {
  state.to = dest;
  toInput.value = dest.name;
  toInput.blur();
  $('fromRow').hidden = false;
  $('toPin').hidden = false;
  $('clearSearch').hidden = false;
  if (!state.from) {
    const ok = await useMyLocationAsFrom();
    if (!ok) { toast('Scrivi da dove parti'); return; }
  }
  plan();
}
function clearPlan() {
  state.to = null; state.from = null; state.itins = []; state.direct = []; state.selItin = -1;
  clearInterval(state.planTimer);
  toInput.value = ''; fromInput.value = '';
  $('fromRow').hidden = true; $('toPin').hidden = true; $('clearSearch').hidden = true;
  state.focusTrips = null;
  map.getSource('plan') && map.getSource('plan').setData(EMPTY);
  draw();
}

async function plan({ silent = false } = {}) {
  if (!state.from || !state.to || !state.from.lngLat) return;
  if (!silent) openSheet('<div class="spinner">Calcolo il percorso con i dati in tempo reale…</div>', { type: 'plan' }, { tall: true });
  const keepTrip = silent && state.selItin >= 0 ? firstTransitTrip(state.itins[state.selItin]) : null;
  try {
    const res = await api.plan(state.from.lngLat, state.to.lngLat);
    if (!state.view || (state.view.type !== 'plan' && state.view.type !== 'itin')) return;
    state.itins = (res.itineraries || []).filter((it) => new Date(it.endTime) > Date.now()).slice(0, 6);
    state.direct = res.direct || [];
    if (silent && state.view.type === 'itin') {
      const idx = state.itins.findIndex((it) => firstTransitTrip(it) === keepTrip);
      if (idx >= 0) { showItinerary(idx, { keepView: true }); return; }
    }
    if (!silent || state.view.type === 'plan') renderPlanList();
  } catch (e) {
    if (!silent) openSheet(`<h2>Percorso non disponibile</h2><p class="sub">Il servizio di calcolo non ha risposto (${esc(e.message)}). Riprova tra qualche istante.</p>
      <div class="actions"><button class="btn" id="retryPlan">Riprova</button></div>`, { type: 'plan' });
    const r = document.getElementById('retryPlan');
    if (r) r.onclick = () => plan();
  }
  clearInterval(state.planTimer);
  state.planTimer = setInterval(() => plan({ silent: true }), 60_000);
}
const firstTransitTrip = (it) => (it && (it.legs.find((l) => l.tripId) || {}).tripId) || null;

function legBadges(it) {
  return it.legs.map((l) => {
    if (!l.tripId) return l.duration >= 90 ? `<span class="walk">${ICON.walk}${Math.round(l.duration / 60)}</span>` : '';
    const line = l.displayName || l.routeShortName || '';
    return badge(line, colorOf({ mode: l.mode, line }));
  }).filter(Boolean).join('<span class="sep">›</span>');
}

function renderPlanList() {
  state.selItin = -1;
  state.focusTrips = null;
  draw();
  map.getSource('plan').setData(EMPTY);
  const title = `<h2>${esc(state.to.name)}</h2><p class="sub">da ${esc(state.from.name)}</p>`;
  if (!state.itins.length && !state.direct.length) {
    openSheet(`${title}<p>Nessun percorso trovato nei prossimi minuti. Prova a scegliere un punto di partenza o arrivo più vicino a una fermata.</p>`, { type: 'plan' }, { tall: true });
    return;
  }
  const cards = state.itins.map((it, i) => {
    const first = it.legs.find((l) => l.tripId);
    let note = '';
    if (first) {
      const line = first.displayName || first.routeShortName;
      const live = first.realTime ? '<span class="rt">in tempo reale</span>' : 'da orario';
      note = `Il <b>${esc(line)}</b> passa ${fmtIn(first.startTime) === 'ora' ? '<b>ora</b>' : 'tra <b>' + fmtIn(first.startTime) + '</b>'} da ${esc(niceName(first.from.name))} · ${live} ${delayText(first.startTime, first.scheduledStartTime)}`;
    }
    return `<button class="itin" data-i="${i}">
      <div class="itin-top"><span class="itin-time">${fmtTime(it.startTime)} → ${fmtTime(it.endTime)}</span><span class="itin-dur">${fmtDur(it.duration)}</span></div>
      <div class="itin-legs">${legBadges(it)}</div>
      <div class="itin-note">${note}</div></button>`;
  });
  const walk = state.direct.find((d) => d.legs && d.legs.length);
  if (walk) {
    cards.push(`<button class="itin" data-direct="1"><div class="itin-top"><span class="itin-time">Tutto a piedi</span><span class="itin-dur">${fmtDur(walk.duration)}</span></div>
      <div class="itin-note">${fmtDist(walk.legs.reduce((a, l) => a + (l.distance || 0), 0))}</div></button>`);
  }
  openSheet(`${title}<div class="itins">${cards.join('')}</div>
    <p class="muted" style="margin-top:12px">I percorsi tengono conto dei ritardi in tempo reale e si aggiornano ogni minuto.</p>`, { type: 'plan' }, { tall: true });
  sheetBody.querySelectorAll('.itin').forEach((b) => {
    b.onclick = () => (b.dataset.direct ? showWalk(walk) : showItinerary(+b.dataset.i));
  });
  const pts = [state.from.lngLat, state.to.lngLat];
  drawPlan(null);
  fitTo(pts);
}

function drawPlan(it) {
  const feats = [];
  if (it) {
    for (const l of it.legs) {
      if (!l.legGeometry || !l.legGeometry.points) continue;
      const coords = decodePolyline(l.legGeometry.points, l.legGeometry.precision || 6);
      const line = l.displayName || l.routeShortName;
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
        properties: { walk: l.tripId ? 0 : 1, color: l.tripId ? colorOf({ mode: l.mode, line }) : '#5B6170' } });
      if (l.tripId) {
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.from.lon, l.from.lat] }, properties: { role: 'stop' } });
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.to.lon, l.to.lat] }, properties: { role: 'stop' } });
      }
    }
  }
  if (state.from?.lngLat) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: state.from.lngLat }, properties: { role: 'start' } });
  if (state.to?.lngLat) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: state.to.lngLat }, properties: { role: 'end' } });
  map.getSource('plan').setData({ type: 'FeatureCollection', features: feats });
}

function showWalk(walk) {
  state.focusTrips = null;
  drawPlan(walk);
  openSheet(`<button class="btn ghost" id="backPlan">‹ Altre soluzioni</button>
    <h2 style="margin-top:12px">A piedi fino a ${esc(state.to.name)}</h2>
    <p class="sub">${fmtDur(walk.duration)} · ${fmtDist(walk.legs.reduce((a, l) => a + (l.distance || 0), 0))}</p>`, { type: 'itin' }, { tall: true });
  $('backPlan').onclick = renderPlanList;
  fitTo(walk.legs.flatMap((l) => (l.legGeometry ? decodePolyline(l.legGeometry.points, l.legGeometry.precision || 6) : [])));
}

function showItinerary(i, { keepView = false } = {}) {
  const it = state.itins[i];
  if (!it) return;
  state.selItin = i;
  state.focusTrips = new Set(it.legs.filter((l) => l.tripId).map((l) => rawTripId(l.tripId)));
  draw();
  drawPlan(it);
  const legsHtml = it.legs.map((l, k) => {
    if (!l.tripId) {
      if (l.duration < 30 && (l.distance || 0) < 40) return '';
      const toName = k === it.legs.length - 1 ? state.to.name : niceName(l.to.name);
      return `<div class="leg"><div class="leg-ico"><span class="walk-ico">${ICON.walk}</span></div>
        <div class="leg-main"><div class="lt">A piedi fino a ${esc(toName)}</div>
        <div class="ls">${fmtDur(l.duration)}${l.distance ? ' · ' + fmtDist(l.distance) : ''}</div></div></div>`;
    }
    const line = l.displayName || l.routeShortName;
    const color = colorOf({ mode: l.mode, line });
    const nStops = (l.intermediateStops || []).length + 1;
    return `<div class="leg"><div class="leg-ico">${badge(line, color)}</div>
      <div class="leg-main"><div class="lt">verso ${esc(niceName(l.headsign || (l.tripTo && l.tripTo.name) || ''))}</div>
        <div class="ls">Sali a <b>${esc(niceName(l.from.name))}</b> alle <b>${fmtTime(l.startTime)}</b> ${l.realTime ? '<span class="rt">tempo reale</span>' : ''} ${delayText(l.startTime, l.scheduledStartTime)}</div>
        <div class="ls">Scendi a <b>${esc(niceName(l.to.name))}</b> alle ${fmtTime(l.endTime)} · ${nStops} ${nStops === 1 ? 'fermata' : 'fermate'}</div>
        <div class="live-box none" data-leg="${k}">${ICON.bus}<div>Cerco il mezzo sulla mappa…</div></div>
      </div></div>`;
  }).join('');
  const html = `<button class="btn ghost" id="backPlan">‹ Altre soluzioni</button>
    <div class="itin-top" style="margin-top:14px"><span class="itin-time">${fmtTime(it.startTime)} → ${fmtTime(it.endTime)}</span><span class="itin-dur">${fmtDur(it.duration)}</span></div>
    <p class="sub">${it.transfers ? it.transfers + (it.transfers === 1 ? ' cambio' : ' cambi') : 'Nessun cambio'} · arrivo a ${esc(state.to.name)}</p>
    ${legsHtml}`;
  if (keepView && state.view?.type === 'itin') {
    const top = sheetBody.scrollTop;
    sheetBody.innerHTML = html;
    sheetBody.scrollTop = top;
    state.view = { type: 'itin', i };
  } else {
    openSheet(html, { type: 'itin', i }, { tall: true });
  }
  $('backPlan').onclick = renderPlanList;
  updateLiveBoxes();
  if (!keepView) {
    const pts = it.legs.flatMap((l) => (l.legGeometry ? decodePolyline(l.legGeometry.points, l.legGeometry.precision || 6) : []));
    fitTo(pts.length ? pts : [state.from.lngLat, state.to.lngLat]);
  }
}

// Collega ogni tratto in bus/tram del percorso al mezzo vero che si vede sulla mappa.
function updateLiveBoxes() {
  if (state.view?.type !== 'itin') return;
  const it = state.itins[state.view.i];
  if (!it) return;
  sheetBody.querySelectorAll('.live-box[data-leg]').forEach((box) => {
    const l = it.legs[+box.dataset.leg];
    const v = vehicleByTrip(rawTripId(l.tripId));
    const stop = [l.from.lon, l.from.lat];
    const gps = state.source.kind === 'gps';
    if (!v) {
      box.className = 'live-box none';
      box.innerHTML = `${ICON.bus}<div>${minutesFrom(l.startTime) > 15
        ? 'Il mezzo non è ancora in viaggio: comparirà sulla mappa quando parte dal capolinea.'
        : gps ? 'Posizione GPS di questo mezzo non disponibile al momento.' : 'Posizione del mezzo non disponibile al momento.'}</div>`;
      box.onclick = null;
      return;
    }
    const d = distance([v.lng, v.lat], stop);
    const mins = minutesFrom(l.startTime);
    const at = d < 60;
    const where = at
      ? `Il tuo ${esc(v.line)} è <b>alla fermata</b> ${esc(niceName(l.from.name))}${mins > 0 ? ' (partenza prevista tra ' + fmtIn(l.startTime) + ')' : ''}.`
      : mins > 0
      ? `Il tuo ${esc(v.line)} è a <b>${fmtDist(d)}</b> dalla fermata ${esc(niceName(l.from.name))} e arriva tra <b>${fmtIn(l.startTime)}</b>.`
      : `Il tuo ${esc(v.line)} è a <b>${fmtDist(d)}</b> dalla fermata ${esc(niceName(l.from.name))}.`;
    box.className = 'live-box';
    box.innerHTML = `${ICON.bus}<div>${where}<br><span class="muted">${gps ? 'Posizione GPS reale' : 'Posizione stimata'} · tocca per vederlo</span></div>`;
    box.onclick = () => fitTo([[v.lng, v.lat], stop]);
  });
}

function onVehiclesUpdated() {
  if (!state.view) return;
  if (state.view.type === 'itin') updateLiveBoxes();
  else if (state.view.type === 'line') renderLineView();
  else if (state.view.type === 'trip') updateTripLive();
}

// ---------------- informazioni ----------------
$('infoBtn').onclick = () => {
  const gps = state.source && state.source.kind === 'gps';
  const upd = store.meta ? new Date(store.meta.generated).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : 'non ancora disponibile';
  openSheet(`<div class="info">
    <h2>Bus Roma Live</h2>
    <p>Mappa in tempo reale di bus e tram ATAC. Tocca un mezzo per vedere dove va e le sue fermate, tocca una fermata per i prossimi passaggi, scrivi una destinazione in alto per il percorso.</p>
    <div class="section-title">Colori</div>
    <div class="legend">
      <span class="sw" style="background:${PALETTE.bus}"></span><span>Bus</span>
      <span class="sw" style="background:${PALETTE.tram}"></span><span>Tram</span>
      <span class="sw" style="background:${PALETTE.night}"></span><span>Linee notturne</span>
      <span class="sw" style="background:${PALETTE.metro}"></span><span>Metro (posizione stimata)</span>
      <span class="sw" style="background:${PALETTE.rail}"></span><span>Treni regionali (posizione stimata)</span>
    </div>
    <p>La freccetta sul pallino indica la direzione di marcia.</p>
    <div class="section-title">Da dove arrivano i dati</div>
    <p><b>Posizioni dei mezzi:</b> ${gps
      ? 'GPS reali dei mezzi ATAC, aggiornati ogni ' + (C.REFRESH_SECONDS || 15) + ' secondi (i dati di ATAC possono avere 1-2 minuti di ritardo).'
      : 'stimate da orari e ritardi in tempo reale. Per vedere le posizioni GPS reali va attivato il "ponte" (vedi le istruzioni nel repository).'}</p>
    <p><b>Percorsi, fermate e passaggi:</b> <a href="https://transitous.org" target="_blank" rel="noopener">Transitous</a>, servizio libero e gratuito che usa i dati in tempo reale di ATAC, Cotral e Trenitalia.</p>
    <p><b>Dati ATAC:</b> <a href="https://romamobilita.it/sistemi-e-tecnologie/open-data/" target="_blank" rel="noopener">Roma Servizi per la Mobilità</a> (open data). Ultimo aggiornamento linee e orari: ${esc(upd)}.</p>
    <p><b>Mappa:</b> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>.</p>
    <p class="muted">Progetto personale non commerciale, senza legami con ATAC o Roma Mobilità.</p>
  </div>`, { type: 'info' });
};

// ---------------- clic e pressione lunga sulla mappa ----------------
function featureAt(point, layers, px = 12) {
  const box = [[point.x - px, point.y - px], [point.x + px, point.y + px]];
  const fs = map.queryRenderedFeatures(box, { layers: layers.filter((l) => map.getLayer(l)) });
  if (!fs.length) return null;
  // il più vicino al dito
  let best = fs[0], bd = Infinity;
  for (const f of fs) {
    const p = map.project(f.geometry.coordinates);
    const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

map.on('click', (e) => {
  if (navState()) return;
  hideSuggest();
  $('lineForm').hidden = true;
  if (ctxPopup) { ctxPopup.remove(); ctxPopup = null; }
  const veh = featureAt(e.point, ['veh-dot', 'veh-icon', 'veh-pill'], map.getZoom() < 12.5 ? 8 : 16);
  if (veh) {
    const v = vehicleById(veh.properties.id);
    if (v) { showVehicle(v); return; }
  }
  const stop = featureAt(e.point, ['stops-dot'], 12);
  if (stop) {
    showStop({ id: stop.properties.id, name: stop.properties.name, code: stop.properties.code, lngLat: stop.geometry.coordinates });
  }
});
map.on('mousemove', (e) => {
  const f = featureAt(e.point, ['veh-dot', 'veh-icon', 'stops-dot'], 8);
  map.getCanvas().style.cursor = f ? 'pointer' : '';
});

let ctxPopup = null;
function openContext(lngLat) {
  if (ctxPopup) ctxPopup.remove();
  const el = document.createElement('div');
  el.className = 'ctx';
  el.innerHTML = `<button data-a="to">${ICON.walk} Portami qui</button><button data-a="from">Parti da qui</button>`;
  ctxPopup = new maplibregl.Popup({ closeButton: false, offset: 8 }).setLngLat(lngLat).setDOMContent(el).addTo(map);
  el.onclick = async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    ctxPopup.remove(); ctxPopup = null;
    const ll = [lngLat.lng, lngLat.lat];
    let name = 'Punto sulla mappa';
    try {
      const r = await api.reverse(ll);
      if (r && r[0]) name = r[0].type === 'ADDRESS' ? [r[0].street || r[0].name, r[0].houseNumber].filter(Boolean).join(' ') : niceName(r[0].name);
    } catch (e) { /* va bene il nome generico */ }
    if (a === 'to') setDestination({ name, lngLat: ll });
    else {
      state.from = { name, lngLat: ll };
      fromInput.value = name;
      $('fromRow').hidden = false;
      $('clearSearch').hidden = false;
      if (state.to) plan(); else { toInput.focus(); toast('Ora scrivi dove vuoi andare'); }
    }
  };
}
map.on('contextmenu', (e) => openContext(e.lngLat));
let pressTimer = null;
map.on('touchstart', (e) => {
  if (e.originalEvent.touches.length !== 1) { clearTimeout(pressTimer); return; }
  const ll = e.lngLat;
  pressTimer = setTimeout(() => openContext(ll), 600);
});
for (const ev of ['touchend', 'touchcancel', 'touchmove', 'movestart', 'zoomstart']) map.on(ev, () => clearTimeout(pressTimer));

let moveTimer = null;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    refreshStops();
    // con le posizioni stimate scarico di nuovo se la zona visibile è cambiata molto
    const src = state.source;
    if (src && src.kind === 'est' && src.bounds) {
      const b = map.getBounds(), sb = src.bounds;
      const outside = b.getSouth() < sb.south || b.getNorth() > sb.north || b.getWest() < sb.west || b.getEast() > sb.east;
      if (outside) refreshVehicles();
    }
  }, 350);
});

document.addEventListener('visibilitychange', () => {
  // torna sulla pagina dopo un po': aggiorno subito
  if (!document.hidden && state.source && Date.now() - state.lastOk > 20_000) refreshVehicles();
});

// ---------------- deviazioni ----------------
initDeviation({ map, state, store, loadShapes, openSheet, sheetBody, toast, fitTo, PROXY });
$('devBtn').onclick = () => { hideSuggest(); openDeviation(); };

// ---------------- navigatore ----------------
initNav({ map, state, store, loadShapes, loadLineStops, openSheet, closeSheet, toast, colorOf });
$('navBtn').onclick = () => { hideSuggest(); openNavPicker(); };

// ---------------- avvio ----------------
map.on('load', async () => {
  setupLayers();
  await loadRoutes();
  startSource(state.gps || state.est);
  loadTrips().then(() => { if (state.source) refreshVehicles(); });
  refreshStops();
  // se il permesso di posizione è già stato dato in passato, mostro subito il pallino blu
  try {
    const perm = await navigator.permissions.query({ name: 'geolocation' });
    if (perm.state === 'granted') getMe({ quiet: true }).catch(() => {});
  } catch (e) { /* browser senza questa funzione */ }
});
