// DEVIAZIONI: dalla foto (o dal testo) del messaggio al percorso disegnato sulla mappa.
//
// 1. la foto va al "ponte" Cloudflare, dove un'intelligenza artificiale la legge e la trasforma
//    in un elenco ordinato di strade e svolte (l'autista può correggerlo);
// 2. con OpenStreetMap (servizio Overpass) si trovano gli incroci veri tra una strada e la successiva;
// 3. un calcolatore di percorsi stradali (OSRM) unisce gli incroci seguendo le strade;
// 4. la deviazione viene disegnata, numerata e si può far leggere ad alta voce.

import { decodePolyline } from './api.js';
import { distance } from './vehicles.js';

let C = null; // strumenti della mappa passati da app.js
export function initDeviation(ctx) { C = ctx; }

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const ROMA = { south: 41.70, west: 12.30, north: 42.08, east: 12.72 };
const STORE_KEY = 'deviazioni';
const DEV_COLOR = '#F06A00';

const AZIONI = {
  prosegui: 'Prosegui su',
  dritto: 'Dritto su',
  destra: 'A destra in',
  sinistra: 'A sinistra in',
  giro: 'Fai il giro di',
  inversione: 'Inversione su',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/></svg>',
};

// ---------------- memoria (sul telefono) ----------------
function loadSaved() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    const week = Date.now() - 7 * 86400_000;
    return all.filter((d) => d.quando > week);
  } catch (e) { return []; }
}
function saveAll(list) { try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) { /* memoria piena o bloccata */ } }
let muted = (() => { try { return localStorage.getItem('voce') === 'off'; } catch (e) { return false; } })();
function setMuted(v) { muted = v; try { localStorage.setItem('voce', v ? 'off' : 'on'); } catch (e) { /* ok */ } if (v) speechSynthesis?.cancel(); }

export function speak(text) {
  if (muted || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'it-IT';
  const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('it'));
  if (voice) u.voice = voice;
  u.rate = 1;
  speechSynthesis.speak(u);
}

// ---------------- schermata iniziale ----------------
let current = null; // deviazione in lavorazione { dev, linea, testo, result }

export function openDeviation() {
  const saved = loadSaved().sort((a, b) => b.quando - a.quando);
  const linea = (C.state.lineFilter || (current && current.linea) || '');
  C.openSheet(`
    <h2>Deviazione</h2>
    <p class="sub">Fotografa il messaggio sul display di bordo (o il foglio) quando sei fermo: lo leggo e te lo disegno sulla mappa.</p>
    <label class="dev-field">Linea <input id="devLine" type="text" value="${esc(linea)}" placeholder="es. 64" autocomplete="off"></label>
    <label class="btn dev-photo">${ICON.camera} Fotografa il messaggio
      <input id="devPhoto" type="file" accept="image/*" capture="environment" hidden></label>
    <div id="devPreview"></div>
    <details class="dev-text"><summary>oppure scrivi o incolla il testo</summary>
      <textarea id="devText" rows="4" placeholder="es. Per ingombro giunti a P.zza Risorgimento proseguire su via Cola di Rienzo, dx via Cicerone, giro del Palazzaccio, capolinea"></textarea>
    </details>
    <div class="actions"><button class="btn" id="devRead" disabled>Leggi il messaggio</button></div>
    <div id="devStatus"></div>
    ${saved.length ? `<div class="section-title">Deviazioni salvate</div>
      <ul class="rows">${saved.map((d) => `<li data-id="${esc(d.id)}">
        <span class="badge" style="background:${DEV_COLOR}">${esc(d.linea || '—')}</span>
        <div class="grow"><div class="title">${esc(d.titolo || 'Deviazione')}</div>
          <div class="muted">${new Date(d.quando).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>
        <button class="icon-btn dev-del" data-del="${esc(d.id)}" aria-label="Elimina">✕</button></li>`).join('')}</ul>` : ''}
  `, { type: 'dev' }, { tall: true });

  let photo = null;
  const readBtn = document.getElementById('devRead');
  const textEl = document.getElementById('devText');
  const refresh = () => { readBtn.disabled = !photo && !textEl.value.trim(); };
  textEl.addEventListener('input', refresh);
  document.getElementById('devPhoto').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      photo = await resizeImage(f);
      document.getElementById('devPreview').innerHTML = `<img class="dev-img" src="data:image/jpeg;base64,${photo}" alt="Foto del messaggio">`;
      refresh();
      readBtn.click(); // con la foto si parte subito, senza altri tocchi
    } catch (err) { C.toast('Non riesco ad aprire la foto'); }
  });
  readBtn.onclick = () => readMessage({ image: photo, text: textEl.value, linea: document.getElementById('devLine').value.trim() });

  C.sheetBody.querySelectorAll('li[data-id]').forEach((li) => {
    li.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      const list = loadSaved();
      if (del) {
        saveAll(list.filter((d) => d.id !== del.dataset.del));
        clearDrawing();
        openDeviation();
        return;
      }
      const d = list.find((x) => x.id === li.dataset.id);
      if (d) { current = { ...d }; showResult(); }
    };
  });
}

// Riduce la foto (le foto del telefono sono enormi) e la converte in testo base64
function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function readMessage({ image, text, linea }) {
  const st = document.getElementById('devStatus');
  if (!C.PROXY) { st.innerHTML = '<p class="late">Serve il ponte Cloudflare per leggere i messaggi.</p>'; return; }
  st.innerHTML = '<div class="spinner">Leggo il messaggio…</div>';
  document.getElementById('devRead').disabled = true;
  try {
    const res = await fetch(C.PROXY.replace(/\/$/, '') + '/deviazione', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, mediaType: 'image/jpeg', text, linea }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.errore || 'risposta ' + res.status);
    current = { id: 'd' + Date.now(), linea: linea || data.linea || '', testo: data.testo || text, dev: normalize(data), quando: Date.now() };
    showReview();
  } catch (e) {
    st.innerHTML = `<p class="late">Non sono riuscito a leggere il messaggio: ${esc(e.message)}</p>`;
    document.getElementById('devRead').disabled = false;
  }
}

function normalize(d) {
  const passi = (d.passi || []).filter((p) => p && p.strada).map((p) => ({
    azione: AZIONI[String(p.azione || '').toLowerCase()] ? String(p.azione).toLowerCase() : 'prosegui',
    strada: String(p.strada).trim(),
    nota: p.nota || '',
  }));
  const fine = d.fine || {};
  return {
    inizio: d.inizio || '',
    passi,
    fine: { tipo: ['riprende_percorso', 'capolinea', 'altro'].includes(fine.tipo) ? fine.tipo : 'riprende_percorso', strada: fine.strada || '', nota: fine.nota || '' },
    motivo: d.motivo || '',
    dubbi: Array.isArray(d.dubbi) ? d.dubbi.filter(Boolean) : [],
  };
}

// ---------------- controllo e correzione dell'elenco ----------------
function showReview(errors = {}) {
  const { dev } = current;
  const row = (p, i) => `<li class="dev-step${errors[i + 1] ? ' err' : ''}" data-i="${i}">
      <span class="dev-num">${i + 1}</span>
      <select data-k="azione">${Object.keys(AZIONI).map((a) => `<option value="${a}"${a === p.azione ? ' selected' : ''}>${AZIONI[a].replace(/ (su|in|di)$/, '')}</option>`).join('')}</select>
      <input data-k="strada" value="${esc(p.strada)}" aria-label="Strada">
      <button class="icon-btn" data-rm="${i}" aria-label="Togli">✕</button>
    </li>`;
  C.openSheet(`
    <h2>Controlla la deviazione</h2>
    ${current.testo ? `<blockquote class="dev-quote">${esc(current.testo)}</blockquote>` : ''}
    ${dev.dubbi.length ? `<div class="live-box">⚠️<div><b>Da controllare:</b> ${dev.dubbi.map(esc).join(' · ')}</div></div>` : ''}
    <label class="dev-field">Linea <input id="devLine2" value="${esc(current.linea)}" placeholder="es. 64"></label>
    <label class="dev-field${errors[0] ? ' err' : ''}">Inizia da <input id="devStart" value="${esc(dev.inizio)}" placeholder="strada dove lasci il percorso"></label>
    <ol class="dev-steps">${dev.passi.map(row).join('')}</ol>
    <button class="btn ghost" id="devAdd">+ Aggiungi strada</button>
    <label class="dev-field">Alla fine
      <select id="devEndType">
        <option value="riprende_percorso"${dev.fine.tipo === 'riprende_percorso' ? ' selected' : ''}>riprendi il percorso normale</option>
        <option value="capolinea"${dev.fine.tipo === 'capolinea' ? ' selected' : ''}>vai al capolinea</option>
        <option value="altro"${dev.fine.tipo === 'altro' ? ' selected' : ''}>altro</option>
      </select></label>
    <label class="dev-field${errors.fine ? ' err' : ''}">in <input id="devEnd" value="${esc(dev.fine.strada)}" placeholder="(facoltativo) strada"></label>
    ${Object.keys(errors).length ? `<p class="late">Non trovo alcune strade o incroci (in rosso): controlla i nomi, completi di via/piazza/viale.</p>` : ''}
    <div class="actions"><button class="btn" id="devGo">Mostra sulla mappa</button><button class="btn ghost" id="devBack">Rifai</button></div>
    <div id="devStatus"></div>
  `, { type: 'dev' }, { tall: true });

  const collect = () => {
    current.linea = document.getElementById('devLine2').value.trim();
    dev.inizio = document.getElementById('devStart').value.trim();
    dev.passi = [...C.sheetBody.querySelectorAll('.dev-step')].map((li) => ({
      azione: li.querySelector('[data-k="azione"]').value,
      strada: li.querySelector('[data-k="strada"]').value.trim(),
    })).filter((p) => p.strada);
    dev.fine.tipo = document.getElementById('devEndType').value;
    dev.fine.strada = document.getElementById('devEnd').value.trim();
  };
  C.sheetBody.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { collect(); dev.passi.splice(+b.dataset.rm, 1); showReview(); }; });
  document.getElementById('devAdd').onclick = () => { collect(); dev.passi.push({ azione: 'destra', strada: '' }); showReview(); };
  document.getElementById('devBack').onclick = openDeviation;
  document.getElementById('devGo').onclick = async () => {
    collect();
    const st = document.getElementById('devStatus');
    st.innerHTML = '<div class="spinner">Cerco gli incroci e il percorso…</div>';
    try {
      current.result = await computeRoute(current);
      current.titolo = titleOf(current);
      if (current.result.errors && Object.keys(current.result.errors).length) { showReview(current.result.errors); return; }
      const list = loadSaved().filter((d) => d.id !== current.id);
      list.push(current);
      saveAll(list);
      showResult();
    } catch (e) {
      st.innerHTML = `<p class="late">${esc(e.message)}</p>`;
    }
  };
}

function titleOf(c) {
  const p = c.dev.passi;
  return [c.dev.motivo && c.dev.motivo[0].toUpperCase() + c.dev.motivo.slice(1), p.length ? `${c.dev.inizio || ''} → ${p[p.length - 1].strada}` : ''].filter(Boolean).join(': ');
}

// ---------------- incroci con OpenStreetMap ----------------
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();
function nameRegex(name) {
  return norm(name).replace(/[.*+?^${}()|[\]\\"]/g, '\\$&').replace(/'/g, "['’]");
}

async function overpass(query) {
  let last;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (res.ok) return await res.json();
      last = new Error('OpenStreetMap ha risposto ' + res.status);
    } catch (e) { last = e; }
  }
  throw last || new Error('OpenStreetMap non raggiungibile');
}

// Scarica tutte le strade nominate e restituisce, per ogni nome, l'elenco dei tratti con nodi e coordinate
async function fetchStreets(names, box) {
  const uniq = [...new Set(names.map(norm).filter(Boolean))];
  const re = uniq.map(nameRegex).join('|');
  const q = `[out:json][timeout:25];way["highway"]["name"~"^(${re})$",i](${box.south},${box.west},${box.north},${box.east});out body geom;`;
  const data = await overpass(q);
  const byName = new Map(uniq.map((n) => [n, []]));
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const key = norm(el.tags && el.tags.name);
    if (!byName.has(key)) continue;
    byName.get(key).push({ nodes: el.nodes, pts: el.geometry.map((g) => [g.lon, g.lat]), name: el.tags.name });
  }
  return byName;
}

// Punti d'incrocio tra due strade (nodi in comune; in mancanza, punti a meno di 40 m)
function crossings(a, b) {
  const out = [];
  const bNodes = new Map();
  for (const w of b) w.nodes.forEach((id, i) => bNodes.set(id, w.pts[i]));
  for (const w of a) w.nodes.forEach((id, i) => { if (bNodes.has(id)) out.push(w.pts[i]); });
  if (out.length) return out;
  let best = null, bd = 40;
  for (const wa of a) for (const p of wa.pts) for (const wb of b) for (const q of wb.pts) {
    const d = distance(p, q);
    if (d < bd) { bd = d; best = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; }
  }
  return best ? [best] : [];
}
const nearest = (list, ref) => list.reduce((best, p) => (!best || distance(p, ref) < distance(best, ref) ? p : best), null);

// Punto più vicino del percorso normale della linea (per riprendere il percorso o andare al capolinea)
function lineShapes(linea) {
  if (!linea || !C.store.routes || !C.store.shapes) return [];
  const ids = Object.entries(C.store.routes).filter(([, r]) => String(r.n).toLowerCase() === String(linea).toLowerCase()).map(([id]) => id);
  return ids.flatMap((id) => (C.store.shapes[id] || []).map((s) => ({ ...s, pts: decodePolyline(s.p, 5) })));
}

async function computeRoute(cur) {
  const { dev } = cur;
  await C.loadShapes();
  const shapes = lineShapes(cur.linea);
  const allShape = shapes.flatMap((s) => s.pts);
  const shapeLines = shapes.map((s) => s.pts);

  const seq = [dev.inizio, ...dev.passi.map((p) => p.strada)].filter(Boolean);
  if (seq.length < 2) throw new Error('Servono almeno la strada di partenza e una strada della deviazione.');
  const names = [...seq, dev.fine.strada].filter(Boolean);

  // zona di ricerca: intorno alla linea, oppure tutta Roma
  let box = ROMA;
  if (allShape.length) {
    let w = 180, s = 90, e = -180, n = -90;
    for (const [x, y] of allShape) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    box = { south: s - 0.03, west: w - 0.04, north: n + 0.03, east: e + 0.04 };
  }
  const streets = await fetchStreets(names, box);

  const errors = {};
  seq.forEach((name, i) => { if (!(streets.get(norm(name)) || []).length) errors[i] = name; });
  if (dev.fine.strada && !(streets.get(norm(dev.fine.strada)) || []).length) errors.fine = dev.fine.strada;
  if (Object.keys(errors).length) return { errors };

  // uso la grafia ufficiale di OpenStreetMap ("via panisperna" -> "Via Panisperna")
  const official = (name) => { const w = streets.get(norm(name)); return (w && w[0] && w[0].name) || name; };
  dev.inizio = official(dev.inizio);
  dev.passi.forEach((p) => { p.strada = official(p.strada); });
  if (dev.fine.strada) dev.fine.strada = official(dev.fine.strada);

  const ways = (name) => streets.get(norm(name));
  let ref = allShape.length ? allShape[Math.floor(allShape.length / 2)] : C.map.getCenter().toArray();
  const points = [];   // punti da toccare, in ordine
  const marks = [];    // punti di svolta numerati per la mappa
  for (let i = 0; i < seq.length - 1; i++) {
    if (norm(seq[i]) === norm(seq[i + 1])) continue;
    const cands = crossings(ways(seq[i]), ways(seq[i + 1]));
    if (!cands.length) { errors[i + 1] = seq[i + 1]; continue; }
    // il primo incrocio: il più vicino al percorso della linea; gli altri: il più vicino al precedente
    const p = i === 0 && allShape.length ? cands.reduce((b, c) => (!b || nearestDist(c, shapeLines) < nearestDist(b, shapeLines) ? c : b), null) : nearest(cands, ref);
    points.push(p);
    marks.push({ p, n: i + 1, label: `${AZIONI[dev.passi[i] ? dev.passi[i].azione : 'prosegui']} ${seq[i + 1]}` });
    ref = p;
    // "giro" intorno a una piazza: passo anche dal punto più lontano della piazza
    if (dev.passi[i] && dev.passi[i].azione === 'giro') {
      const far = ways(seq[i + 1]).flatMap((w) => w.pts).reduce((b, q) => (!b || distance(q, p) > distance(b, p) ? q : b), null);
      if (far && distance(far, p) > 60) points.push(far);
    }
  }
  if (Object.keys(errors).length) return { errors };

  // fine della deviazione
  const last = seq[seq.length - 1];
  let end = null;
  if (dev.fine.strada && norm(dev.fine.strada) !== norm(last)) {
    end = nearest(crossings(ways(last), ways(dev.fine.strada)), ref);
  }
  if (!end && allShape.length) {
    if (dev.fine.tipo === 'capolinea') {
      // capolinea: l'estremo di un percorso della linea più vicino al punto in cui siamo
      const ends = shapes.map((s) => s.pts[s.pts.length - 1]);
      end = nearest(ends, ref);
    } else {
      // si riprende il percorso: punto della linea più vicino all'ultima strada della deviazione (escluso l'incrocio appena fatto)
      let best = null, bd = 80;
      for (const w of ways(last)) for (const p of w.pts) {
        if (distance(p, ref) < 40) continue;
        const d = nearestDist(p, shapeLines);
        if (d < bd) { bd = d; best = p; }
      }
      end = best;
    }
  }
  if (end) { points.push(end); marks.push({ p: end, n: marks.length + 1, label: dev.fine.tipo === 'capolinea' ? 'Capolinea' : 'Riprendi il percorso normale' }); }

  // percorso stradale che unisce i punti
  let coords = points, routed = false, km = null;
  try {
    const r = await osrm(points);
    coords = r.coords; km = r.km; routed = true;
  } catch (e) { /* senza calcolatore di percorsi disegno solo i collegamenti diretti */ }
  return { coords, marks, routed, km };
}
// distanza (metri) di un punto dalla linea spezzata più vicina tra quelle date
function segDist(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111320, m = 110540;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * m, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * m;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function nearestDist(p, lines) {
  let d = Infinity;
  for (const pts of lines) for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1], pts[i]));
  return d;
}

async function osrm(points) {
  if (points.length < 2) throw new Error('pochi punti');
  const url = OSRM + points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';') + '?overview=full&geometries=geojson&steps=false&continue_straight=true';
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== 'Ok') throw new Error('percorso non calcolato');
  return { coords: data.routes[0].geometry.coordinates, km: data.routes[0].distance / 1000 };
}

// ---------------- risultato sulla mappa ----------------
export function setupDeviationLayers(map) {
  map.addSource('dev', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const beforeId = map.getLayer('stops-dot') ? 'stops-dot' : undefined;
  map.addLayer({ id: 'dev-casing', type: 'line', source: 'dev', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 7, 17, 15] } }, beforeId);
  map.addLayer({ id: 'dev-line', type: 'line', source: 'dev', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': DEV_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 17, 9] } }, beforeId);
  map.addLayer({ id: 'dev-arrows', type: 'symbol', source: 'dev', filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '›', 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 14, 17, 26], 'text-keep-upright': false, 'text-allow-overlap': true, 'text-offset': [0, -0.08] },
    paint: { 'text-color': '#fff' } }, beforeId);
  map.addLayer({ id: 'dev-marks', type: 'circle', source: 'dev', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 11, 'circle-color': '#1B1D22', 'circle-stroke-color': DEV_COLOR, 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'dev-marks-n', type: 'symbol', source: 'dev', filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#fff' } });
}
function draw(result) {
  const feats = [];
  if (result && result.coords.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: result.coords }, properties: {} });
  if (result) for (const m of result.marks) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: m.p }, properties: { n: String(m.n) } });
  const src = C.map.getSource('dev');
  if (src) src.setData({ type: 'FeatureCollection', features: feats });
}
export function clearDrawing() { draw(null); }

function instructions(cur) {
  const d = cur.dev;
  const lines = [];
  if (d.inizio) lines.push(`Da ${d.inizio}`);
  d.passi.forEach((p) => lines.push(`${AZIONI[p.azione] || 'Prosegui su'} ${p.strada}`));
  if (d.fine.tipo === 'capolinea') lines.push(d.fine.strada ? `Capolinea in ${d.fine.strada}` : 'Vai al capolinea');
  else if (d.fine.tipo === 'riprende_percorso') lines.push(d.fine.strada ? `Riprendi il percorso normale in ${d.fine.strada}` : 'Riprendi il percorso normale');
  return lines;
}

function showResult() {
  const cur = current;
  const r = cur.result;
  if (!r) { showReview(); return; }
  draw(r);
  // il percorso normale della linea, in grigio, per capire dove si esce e dove si rientra
  const shapes = lineShapes(cur.linea);
  const route = C.map.getSource('route');
  if (route) route.setData({ type: 'FeatureCollection', features: shapes.map((sh) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: sh.pts }, properties: { color: '#8A8F99', op: 0.55 } })) });
  const lines = instructions(cur);
  C.openSheet(`
    <div class="head"><span class="badge big" style="background:${DEV_COLOR}">${esc(cur.linea || '!')}</span>
      <div><h2 style="margin:0">Deviazione</h2>${cur.dev.motivo ? `<div class="muted">${esc(cur.dev.motivo)}</div>` : ''}</div></div>
    ${cur.dev.inizio ? `<p class="dev-from">${esc(lines[0])}</p>` : ''}
    <ol class="dev-instr">${lines.slice(cur.dev.inizio ? 1 : 0).map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
    ${r.km ? `<p class="muted">Lunghezza della deviazione: circa ${r.km.toFixed(1).replace('.', ',')} km</p>` : ''}
    ${!r.routed ? '<p class="late">Percorso stradale non disponibile: ho collegato gli incroci con linee dritte.</p>' : ''}
    <p class="muted">Controlla sempre che corrisponda al messaggio ufficiale.</p>
    <div class="actions">
      <button class="btn" id="devSpeak">${muted ? ICON.mute + ' Voce spenta' : ICON.sound + ' Leggi ad alta voce'}</button>
      <button class="btn ghost" id="devMute">${muted ? 'Riattiva voce' : 'Muto'}</button>
      <button class="btn ghost" id="devEdit">Correggi</button>
      <button class="btn ghost" id="devNew">Nuova</button>
    </div>
  `, { type: 'dev' });
  document.getElementById('devSpeak').onclick = () => { if (!muted) speak(lines.join('. ')); };
  document.getElementById('devMute').onclick = () => { setMuted(!muted); showResult(); };
  document.getElementById('devEdit').onclick = () => showReview();
  document.getElementById('devNew').onclick = () => { current = null; openDeviation(); };
  const pts = r.coords.length ? r.coords : r.marks.map((m) => m.p);
  if (pts.length) requestAnimationFrame(() => C.fitTo(pts));
  if (!muted) speak('Deviazione. ' + lines.join('. '));
}

// La deviazione attiva per una linea (servirà al navigatore)
export function activeDeviation(linea) {
  const list = loadSaved().filter((d) => d.result && (!linea || String(d.linea).toLowerCase() === String(linea).toLowerCase()));
  return list.sort((a, b) => b.quando - a.quando)[0] || null;
}
