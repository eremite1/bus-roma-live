// MODALITÀ AUTISTA
// Inserisci il numero della tua vettura: la mappa ti segue, mostra solo la tua linea nel tuo senso di marcia,
// il tuo ritardo, il bus davanti e quello dietro, e il traffico che incontrerai.
// Il telefono vibra e avvisa a voce quando serve.

import { decodePolyline } from './api.js';
import { distance } from './vehicles.js';
import { buildRoute } from './nav.js';
import { trafficAhead, MEDIUM } from './traffic.js';
import { speak, isMuted, setMuted } from './voice.js';

let C = null;
export function initDriver(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BUNCH_M = 350;        // sotto questa distanza dal bus davanti/dietro scatta l'avviso
const DEFAULT_KMH = 15;     // velocità media di un bus in città, per stimare i minuti di distacco

let D = null; // stato della modalità autista

const saved = () => { try { return localStorage.getItem('vettura') || ''; } catch (e) { return ''; } };

export function openDriver() {
  C.openSheet(`
    <h2>Modalità autista</h2>
    <p class="sub">Scrivi il numero della vettura che stai guidando: ti seguo sulla mappa e ti avviso (vibrazione e voce) su distacchi, ritardo e traffico.</p>
    <form id="drvForm" class="dev-field">Vettura <input id="drvNo" value="${esc(saved())}" inputmode="numeric" placeholder="es. 4512" autocomplete="off"><button class="btn" type="submit">Inizia</button></form>
    <p class="muted">Funziona con i GPS reali ATAC. Usa il telefono solo su un supporto fisso.</p>
  `, { type: 'driverpick' });
  document.getElementById('drvForm').onsubmit = (e) => {
    e.preventDefault();
    const no = document.getElementById('drvNo').value.trim();
    if (!no) return;
    try { localStorage.setItem('vettura', no); } catch (err) { /* ok */ }
    startDriver(no);
  };
}

function startDriver(no) {
  if (!C.hasGps()) { C.toast('Serve il ponte GPS per la modalità autista'); return; }
  D = { no, id: null, line: null, dir: null, route: null, stops: [], follow: true, alerts: {}, lastDelay: null, prevAhead: null };
  document.body.classList.add('driving');
  keepAwake();
  C.openSheet('<div id="drvView"><div class="spinner">Cerco la vettura ' + esc(no) + '…</div></div>', { type: 'driver' });
  C.map.on('dragstart', onDrag);
  if ('vibrate' in navigator) navigator.vibrate(60);
  update();
}

export function stopDriver() {
  if (!D) return;
  D = null;
  document.body.classList.remove('driving');
  C.map.off('dragstart', onDrag);
  try { wakeLock && wakeLock.release(); } catch (e) { /* ok */ }
  wakeLock = null;
  C.clearLine();
  C.state.selected = null;
}
export const driverActive = () => !!D;
export function showDriverPanel() {
  if (!D) return;
  C.openSheet('<div id="drvView"><div class="spinner">…</div></div>', { type: 'driver' });
  update();
}

function onDrag() {
  if (!D) return;
  D.follow = false;
  const b = document.getElementById('drvCenter');
  if (b) b.hidden = false;
}

function findMe() {
  const want = String(D.no).replace(/^0+/, '');
  for (const s of C.state.shown.values()) {
    const v = s.v;
    if (v.source !== 'gps') continue;
    const ids = [String(v.vehicleNo || ''), String(v.id).slice(1)].map((x) => x.replace(/^0+/, ''));
    if (ids.includes(want)) return v;
  }
  return null;
}

async function ensureRoute(v) {
  const dir = C.vDir(v);
  if (D.route && D.line === v.line && D.dir === dir) return;
  D.line = v.line; D.dir = dir; D.route = null; D.stops = [];
  C.setLine(v.line, dir);
  await C.loadShapes();
  await C.loadLineStops();
  const ids = Object.entries(C.store.routes || {}).filter(([, r]) => String(r.n).toLowerCase() === String(v.line).toLowerCase()).map(([id]) => id);
  let shape = null, rid = null;
  for (const id of ids) for (const s of C.store.shapes[id] || []) {
    if (!shape || (dir != null ? s.d === dir : s.h === v.headsign)) { shape = s; rid = id; }
  }
  if (!shape) return;
  D.route = buildRoute(decodePolyline(shape.p, 5));
  D.head = shape.h;
  const ls = ((C.store.linestops && C.store.linestops[rid]) || []).find((x) => x.d === shape.d);
  D.stops = ls ? ls.s.map((s) => ({ name: s[2], at: alongOf([s[0], s[1]]) })).filter((s) => s.at != null) : [];
}

// distanza lungo il percorso (metri dall'inizio) del punto più vicino; null se troppo lontano
function alongOf(p, maxM = 120) {
  const r = D.route;
  const k = Math.cos((p[1] * Math.PI) / 180);
  let best = -1, bd = Infinity;
  for (let i = 0; i < r.coords.length; i++) {
    const q = r.coords[i];
    const dx = (q[0] - p[0]) * k, dy = q[1] - p[1];
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return Math.sqrt(bd) * 111320 <= maxM ? r.cum[best] : null;
}

function vibrateAlert(key, text, pattern = [220, 120, 220], gapMs = 180_000) {
  const now = Date.now();
  if (D.alerts[key] && now - D.alerts[key] < gapMs) return;
  D.alerts[key] = now;
  if ('vibrate' in navigator) navigator.vibrate(pattern);
  speak(text, { interrupt: false });
  C.toast(text);
}

const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`);
const minutes = (m, kmh) => Math.max(1, Math.round(m / ((kmh || DEFAULT_KMH) / 3.6) / 60));

function delayChip(d) {
  const st = C.statusOf(d);
  if (d == null) return '<span class="punct na">n.d.</span>';
  if (st === 'ok') return '<span class="punct ok">In orario</span>';
  if (st === 'early') return `<span class="punct early">−${-d} min</span>`;
  return `<span class="punct ${st}">+${d} min</span>`;
}

// chiamata a ogni aggiornamento dei GPS e dei ritardi
export async function update() {
  if (!D) return;
  const el = () => document.getElementById('drvView');
  const me = findMe();
  if (!me) {
    D.id = null;
    if (el() && C.state.view?.type === 'driver') el().innerHTML = `<h2>Vettura ${esc(D.no)}</h2>
      <p class="sub">Non la trovo ancora nei dati GPS di ATAC. Se hai appena acceso il mezzo può volerci un paio di minuti; controlla anche il numero.</p>
      <div class="actions"><button class="btn ghost" id="drvStop">Esci</button></div>`;
    const b = document.getElementById('drvStop');
    if (b) b.onclick = () => C.closeSheet();
    return;
  }
  D.id = me.id;
  C.state.selected = me.id;
  await ensureRoute(me);
  if (!D) return;
  const info = C.lineInfo(me);
  const delay = info ? info.delay : null;

  let myAt = D.route ? alongOf([me.lng, me.lat], 200) : null;
  let ahead = null, behind = null, tr = null, nextStop = null;
  if (myAt != null) {
    for (const s of C.state.shown.values()) {
      const v = s.v;
      if (v.id === me.id || String(v.line).toLowerCase() !== String(me.line).toLowerCase()) continue;
      if (D.dir != null && C.vDir(v) !== D.dir) continue;
      const at = alongOf([v.lng, v.lat]);
      if (at == null) continue;
      if (at > myAt && (!ahead || at < ahead.at)) ahead = { v, at };
      if (at < myAt && (!behind || at > behind.at)) behind = { v, at };
    }
    tr = trafficAhead(C.traffic, D.route, myAt, myAt + 3000);
    nextStop = D.stops.find((s) => s.at > myAt + 15) || null;
  }

  // ---- avvisi ----
  if (ahead && ahead.at - myAt < BUNCH_M) vibrateAlert('bunchA', `Attenzione: sei a ${Math.round((ahead.at - myAt) / 10) * 10} metri dalla vettura ${ahead.v.vehicleNo} davanti.`);
  if (behind && myAt - behind.at < BUNCH_M) vibrateAlert('bunchB', `La vettura ${behind.v.vehicleNo} dietro è a ${Math.round((myAt - behind.at) / 10) * 10} metri.`, [120, 80, 120]);
  if (delay != null) {
    if (D.lastDelay == null) D.lastDelay = delay;
    else if (Math.abs(delay - D.lastDelay) >= 3) {
      vibrateAlert('delay', delay >= 2 ? `Ritardo attuale: ${delay} minuti.` : delay <= -1 ? `Sei in anticipo di ${-delay} minuti.` : 'Sei tornato in orario.', [150], 60_000);
      D.lastDelay = delay;
    }
  }
  if (tr && tr.firstSlow && tr.firstSlow.at - myAt < 1500) {
    vibrateAlert('traffic', `Traffico lento tra ${Math.max(100, Math.round((tr.firstSlow.at - myAt) / 100) * 100)} metri.`, [300], 300_000);
  }

  // ---- pannello ----
  const avgKmh = tr && tr.avg ? tr.avg : DEFAULT_KMH;
  const gap = (o, sign) => {
    if (!o) return `<span class="muted">nessuna vettura ${sign > 0 ? 'davanti' : 'dietro'} sulla linea</span>`;
    const m = Math.abs(o.at - myAt);
    const oi = C.lineInfo(o.v);
    return `<b>${esc(o.v.vehicleNo)}</b> a ${fmtM(m)} · ~${minutes(m, avgKmh)} min ${delayChip(oi ? oi.delay : null)}`;
  };
  const traffic = !tr ? '' : !tr.samples ? '<span class="muted">dati non ancora disponibili (servono un paio di minuti)</span>'
    : tr.firstSlow ? `<b class="late">lento tra ${fmtM(tr.firstSlow.at - myAt)}</b> (≈${Math.round(tr.slowKmh)} km/h)`
    : tr.avg < MEDIUM ? `<b style="color:#E07A00">rallentato</b> nei prossimi 3 km (≈${Math.round(tr.avg)} km/h)`
    : `<b style="color:#2BA84A">scorrevole</b> nei prossimi 3 km (≈${Math.round(tr.avg)} km/h)`;
  if (!el() || C.state.view?.type !== 'driver') return;
  el().innerHTML = `
    <div class="head drv-head">${C.badge(me.line, C.colorOf(me), true)}
      <div><div class="dest"><span class="arrow">verso</span> ${esc(me.headsign || D.head || '')}</div>
      <div class="muted">Vettura ${esc(me.vehicleNo)}${me.speed > 0.5 ? ' · ' + Math.round(me.speed * 3.6) + ' km/h' : ''}</div></div>
      <div class="drv-delay">${delayChip(delay)}</div></div>
    ${myAt == null ? '<p class="late">Non sei sul percorso della linea (deviazione o deposito?).</p>' : ''}
    <div class="drv-grid">
      <span class="drv-k">Prossima</span><span>${nextStop ? `<b>${esc(nextStop.name)}</b> · ${fmtM(nextStop.at - myAt)}` : '<span class="muted">—</span>'}</span>
      <span class="drv-k">Davanti</span><span>${myAt == null ? '—' : gap(ahead, 1)}</span>
      <span class="drv-k">Dietro</span><span>${myAt == null ? '—' : gap(behind, -1)}</span>
      <span class="drv-k">Traffico</span><span>${traffic || '—'}</span>
    </div>
    <div class="actions">
      <button class="btn" id="drvLim">Limitata</button>
      <button class="btn ghost" id="drvMute">${isMuted() ? 'Voce spenta' : 'Voce attiva'}</button>
      <button class="btn ghost" id="drvCenter" ${D.follow ? 'hidden' : ''}>Seguimi</button>
      <button class="btn ghost" id="drvStop">Esci</button>
    </div>`;
  document.getElementById('drvMute').onclick = () => { setMuted(!isMuted()); update(); };
  document.getElementById('drvCenter').onclick = () => { D.follow = true; update(); };
  document.getElementById('drvStop').onclick = () => C.closeSheet();
  document.getElementById('drvLim').onclick = () => C.openLimitata({ line: me.line, dir: D.dir, pos: [me.lng, me.lat] });
  if (D.follow) C.showPoint([me.lng, me.lat], 15.5);
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* non supportato */ }
}
document.addEventListener('visibilitychange', () => { if (D && !document.hidden) keepAwake(); });
