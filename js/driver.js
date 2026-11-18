// MODALITÀ AUTISTA
// Inserisci il numero della tua vettura: la mappa ti segue, mostra solo la tua linea nel tuo senso di marcia,
// il tuo ritardo, il bus davanti e quello dietro, e il traffico che incontrerai.
// Il telefono vibra e avvisa a voce quando serve.

import { decodePolyline } from './api.js';
import { distance } from './vehicles.js';
import { buildRoute } from './nav.js';
import { trafficAhead, MEDIUM } from './traffic.js';
import { speak, isMuted, setMuted } from './voice.js';
import { blocksNow, blockOf, runsOf, rimessaRun, isColl, tabName } from './rientri.js';

let C = null;
export function initDriver(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BUNCH_M = 350;        // sotto questa distanza dal bus davanti/dietro scatta l'avviso
const DEFAULT_KMH = 15;
const GIRO_PERSO_MIN = 15;  // se arrivi a meno di 15 min dalla partenza del giro dopo, il giro intermedio si perde     // velocità media di un bus in città, per stimare i minuti di distacco

let D = null; // stato della modalità autista

const saved = () => { try { return localStorage.getItem('vettura') || ''; } catch (e) { return ''; } };
const forget = () => { try { localStorage.removeItem('vettura'); } catch (e) { /* ok */ } };

export function openDriver() {
  C.openSheet(`
    <h2>Modalità autista</h2>
    <p class="sub">Scrivi il numero della vettura che stai guidando: ti seguo sulla mappa e ti avviso (vibrazione e voce) su distacchi, ritardo e traffico.</p>
    <form id="drvForm" class="dev-field">Vettura <input id="drvNo" value="${esc(saved())}" inputmode="numeric" placeholder="es. 4512" autocomplete="off"><button class="btn ghost" type="button" id="drvClear" aria-label="Cancella il numero">✕</button><button class="btn" type="submit">Inizia</button></form>
    <p class="muted">Funziona con i GPS reali ATAC. Usa il telefono solo su un supporto fisso.</p>
  `, { type: 'driverpick' });
  document.getElementById('drvClear').onclick = () => { forget(); const i = document.getElementById('drvNo'); i.value = ''; i.focus(); };
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
  D = { no, id: null, line: null, dir: null, route: null, stops: [], follow: true, alerts: {}, lastDelay: null, prevAhead: null, hist: [], big: false };
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
  if (window.Android && Android.keepAwake) Android.keepAwake(false);
  wakeLock = null;
  C.clearLine();
  C.state.selected = null;
}
export const driverActive = () => !!D;
export function showDriverPanel() {
  if (!D) return;
  C.openSheet('<div id="drvView"><div class="spinner">…</div></div>', { type: 'driver' }, { tall: D.big });
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
    if (b) b.onclick = () => { stopDriver(); forget(); C.closeSheet(); };
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

  // ---- cruscotto ----
  if (!el() || C.state.view?.type !== 'driver') return;
  const avgKmh = tr && tr.avg ? tr.avg : DEFAULT_KMH;
  const T = tabInfo(me, delay);
  const head = T ? T.headway : null;
  // distacco in minuti come il SIG: il tempo che secondo la TUA tabella impieghi a coprire quella distanza
  // (velocità programmata della corsa = lunghezza del percorso / durata in orario)
  const schedKmh = T && D.route && T.dur > 5 ? Math.min(40, Math.max(6, (D.route.total / 1000) / (T.dur / 60))) : avgKmh;
  const gapMin = (o) => (o ? minutes(Math.abs(o.at - myAt), schedKmh) : null);
  const ga = gapMin(ahead), gb = gapMin(behind);
  if (delay != null) D.hist.push(delay);
  if (D.hist.length > 6) D.hist.shift();
  const trend = D.hist.length >= 3 ? D.hist[D.hist.length - 1] - D.hist[0] : 0;

  // grande indicatore anticipo/ritardo, come il SIG ma con il consiglio
  const st = delay == null ? 'na' : delay <= -1 ? 'early' : delay >= 2 ? (delay >= 6 ? 'vlate' : 'late') : 'ok';
  const big = delay == null ? '—' : delay === 0 || st === 'ok' ? '0' : (delay > 0 ? '+' : '−') + Math.abs(delay);
  const lab = { na: 'Orario n.d.', early: 'Anticipo', late: 'Ritardo', vlate: 'Ritardo', ok: 'In orario' }[st];
  const trTxt = Math.abs(trend) >= 2 ? (trend > 0 ? `▲ +${trend} di recente` : `▼ ${trend} di recente`) : '';

  // consiglio di regolarità: distacco davanti/dietro rispetto alla frequenza programmata
  let tip = '';
  if (st === 'early' && delay <= -2) tip = `Sei in anticipo di ${-delay} min: rallenta o allunga la sosta`;
  else if (ga != null && gb != null && head) {
    if (ga < head * 0.4 && gb > head * 1.4) tip = `Troppo vicino a quello davanti (${ga} min): rallenta`;
    else if (gb < head * 0.4 && ga > head * 1.4) tip = `Quello dietro ti sta raggiungendo (${gb} min): sei staccato da quello davanti`;
  } else if (ga != null && ahead.at - myAt < BUNCH_M) tip = 'Sei attaccato alla vettura davanti';
  if (T && T.perso) tip = `Giro perso: arrivi al capolinea verso le ${T.endEst}, riparti alle ${T.perso}`;
  else if (T && T.sosta != null && T.sosta < 0) tip = tip || `Arriverai al capolinea dopo l'orario di ripartenza (${-T.sosta} min)`;

  // striscia regolarità: dietro — io — davanti
  const seg = (m) => `<i class="cz-seg ${m == null ? 'none' : head && m < head * 0.4 ? 'tight' : head && m > head * 1.6 ? 'wide' : ''}" style="flex-grow:${m == null ? 1 : Math.max(1, Math.min(m, 40))}"></i>`;
  const node = (o, m, side) => o ? `<span class="cz-bus ${side}"><b>${esc(o.v.vehicleNo)}</b><small>${m} min · ${fmtM(Math.abs(o.at - myAt))}</small>${delayChip((C.lineInfo(o.v) || {}).delay ?? null)}</span>`
    : `<span class="cz-bus ${side} none"><small>${side === 'b' ? 'nessuno dietro' : 'nessuno davanti'}</small></span>`;
  const strip = myAt == null ? '' : `<div class="cz-strip">
      <div class="cz-line">${node(behind, gb, 'b')}${seg(gb)}<span class="cz-me">${esc(me.vehicleNo)}</span>${seg(ga)}${node(ahead, ga, 'a')}</div>
      ${head ? `<div class="cz-sub">frequenza programmata ≈ ${head} min · dietro ← → davanti</div>` : ''}</div>`;

  // prossime fermate
  const stops = myAt == null ? [] : D.stops.filter((x) => x.at > myAt + 15).slice(0, 3);
  const stopsH = stops.length ? stops.map((x, i) => `<div class="cz-stop${i ? '' : ' first'}"><span>${esc(x.name)}</span><small>${fmtM(x.at - myAt)} · ~${minutes(x.at - myAt, avgKmh)} min</small></div>`).join('') : '';
  const prog = myAt != null && D.route ? Math.round((myAt / D.route.total) * 100) : null;
  const trafficH = !tr ? '' : !tr.samples ? '<span class="cz-dim">traffico: dati in arrivo</span>'
    : tr.firstSlow ? `<span class="cz-t slow">Lento tra ${fmtM(tr.firstSlow.at - myAt)} (≈${Math.round(tr.slowKmh)} km/h)</span>`
    : tr.avg < MEDIUM ? `<span class="cz-t mid">Rallentato nei prossimi 3 km (≈${Math.round(tr.avg)} km/h)</span>`
    : `<span class="cz-t ok">Scorrevole nei prossimi 3 km (≈${Math.round(tr.avg)} km/h)</span>`;

  el().innerHTML = `
    <div class="cz">
      <div class="cz-top">
        ${C.badge(me.line, C.colorOf(me), true)}
        <div class="cz-dest"><small>verso</small><b>${esc(me.headsign || D.head || '')}</b></div>
        <div class="cz-clock" id="drvClock">${clock()}</div>
      </div>
      <div class="cz-row">
        <div class="cz-delay ${st}"><small>${lab}</small><b>${big}</b><small>${delay == null ? '' : 'min'} ${trTxt}</small></div>
        <div class="cz-info">
          <div><small>Vettura</small><b>${esc(me.vehicleNo)}</b>${me.speed > 0.5 ? `<small>${Math.round(me.speed * 3.6)} km/h</small>` : ''}</div>
          ${T ? `<div><small>Tabella</small><b>${esc(T.name)}</b><small>corsa ${T.n} di ${T.tot}</small></div>` : ''}
        </div>
      </div>
      ${tip ? `<div class="cz-tip">💡 ${esc(tip)}</div>` : ''}
      ${myAt == null ? '<div class="cz-tip warn">Non sei sul percorso della linea (deviazione o deposito?)</div>' : ''}
      ${strip}
      ${T ? `<div class="cz-grid">
        <div><small>Fine corsa</small><b>${T.endEst}</b><small>${esc(T.endPlace)} · orario ${T.end}</small></div>
        <div><small>${T.nextKind}</small><b>${T.nextAt}</b><small>${esc(T.nextTxt)}</small></div>
        <div><small>Fine servizio</small><b>${T.runEnd}</b><small>rientro rimessa ${T.rientro}</small></div>
      </div>` : ''}
      ${stopsH ? `<div class="cz-stops"><div class="cz-h">Prossime fermate${prog != null ? ` <span class="cz-dim">· percorso ${prog}%</span>` : ''}</div>${stopsH}
        ${prog != null ? `<div class="cz-prog"><i style="width:${prog}%"></i></div>` : ''}</div>` : ''}
      ${trafficH ? `<div class="cz-traffic">${trafficH}</div>` : ''}
    </div>
    <div class="actions">
      <button class="btn" id="drvLim">Limitata</button>
      <button class="btn ghost" id="drvMute">${isMuted() ? 'Voce spenta' : 'Voce attiva'}</button>
      <button class="btn ghost" id="drvBig">${D.big ? 'Riduci' : 'Ingrandisci'}</button>
      <button class="btn ghost" id="drvCenter" ${D.follow ? 'hidden' : ''}>Seguimi</button>
      <button class="btn ghost" id="drvStop">Esci</button>
    </div>`;
  document.getElementById('drvMute').onclick = () => { setMuted(!isMuted()); update(); };
  document.getElementById('drvBig').onclick = () => { D.big = !D.big; showDriverPanel(); };
  document.getElementById('drvCenter').onclick = () => { D.follow = true; update(); };
  document.getElementById('drvStop').onclick = () => { stopDriver(); forget(); C.closeSheet(); };
  document.getElementById('drvLim').onclick = () => C.openLimitata({ line: me.line, dir: D.dir, pos: [me.lng, me.lat] });
  if (D.follow) C.showPoint([me.lng, me.lat], 15.5);
}

const p2 = (n) => String(n).padStart(2, '0');
const hm = (m) => { m = Math.round(m); return `${p2(Math.floor((((m % 1440) + 1440) % 1440) / 60))}:${p2(((m % 60) + 60) % 60)}`; };
const tm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
function clock() { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }
setInterval(() => { const c = document.getElementById('drvClock'); if (c) c.textContent = clock(); }, 10_000);

// dalla corsa che la vettura sta facendo: tabella, numero della corsa, fine corsa, sosta, fine servizio
function tabInfo(me, delay) {
  const B = blocksNow();
  const b = blockOf(me.tripId);
  const trips = b && B[b];
  if (!trips) return null;
  const ci = trips.findIndex((t) => t[0] === me.tripId);
  if (ci < 0) return null;
  const svc = trips.map((t, i) => [t, i]).filter(([t]) => !isColl(t[3]));
  const n = svc.findIndex(([, i]) => i === ci) + 1;
  const cur = trips[ci], d = delay || 0;
  const endEst = tm(cur[2]) + d;
  const nx = trips[ci + 1];
  let nextKind, nextAt, nextTxt, sosta = null, perso = null;
  if (!nx) { nextKind = 'Poi'; nextAt = '—'; nextTxt = 'ultima corsa della tabella'; }
  else if (isColl(nx[3])) { nextKind = 'Rientro'; nextAt = hm(tm(nx[2])); nextTxt = `${nx[3]} → ${nx[5]}`; }
  else {
    sosta = tm(nx[1]) - endEst;
    nextKind = 'Ripartenza'; nextAt = nx[1];
    nextTxt = (nx[3] !== cur[3] ? `linea ${nx[3]} · ` : '') + (sosta >= 0 ? `sosta ~${sosta} min` : `in ritardo di ${-sosta} min`);
    // GIRO PERSO: se con il ritardo arrivi a meno di 15 minuti dalla partenza del giro successivo
    // (stesso capolinea: 1 corsa dopo sulle circolari, 2 corse dopo sulle altre), quel giro si salta
    if (sosta < 0) {
      for (let k = ci + 2; k < trips.length && !isColl(trips[k][3]); k++) {
        if (trips[k][4] !== cur[5]) continue;
        if (endEst >= tm(trips[k][1]) - GIRO_PERSO_MIN) {
          perso = trips[k][1]; nextKind = 'Giro perso'; nextAt = trips[k][1];
          nextTxt = `salti ${k - ci - 1 === 1 ? 'la corsa' : 'le corse'} delle ${nx[1]}`;
          sosta = tm(trips[k][1]) - endEst;
        }
        break;
      }
    }
  }
  const run = runsOf(trips).find((r) => ci >= r.first && ci <= r.idx + r.colls) || null;
  let runEnd = '—', rientro = '—';
  if (run) { const rr = rimessaRun(trips, run); runEnd = run.end; rientro = (rr.inF >= 2 ? '≈' : '') + hm(rr.inn); }
  // frequenza programmata: partenze della stessa linea dallo stesso capolinea vicino a quest'ora
  const t0 = tm(cur[1]), deps = [];
  for (const T of Object.values(B)) for (const t of T) if (t[3] === cur[3] && t[4] === cur[4] && Math.abs(tm(t[1]) - t0) <= 60) deps.push(tm(t[1]));
  deps.sort((x, y) => x - y);
  const dif = deps.slice(1).map((x, i) => x - deps[i]).filter((x) => x > 0).sort((x, y) => x - y);
  const headway = dif.length ? dif[Math.floor(dif.length / 2)] : null;
  const nm = tabName(b);
  return { name: nm && nm.includes('/') ? nm : nm || b.split('#')[1], n, tot: svc.length, end: hm(tm(cur[2])), endEst: hm(endEst), endPlace: cur[5],
    nextKind, nextAt, nextTxt, sosta, perso, dur: tm(cur[2]) - tm(cur[1]), runEnd: runEnd === '—' ? '—' : hm(tm(runEnd)), rientro, headway };
}

let wakeLock = null;
async function keepAwake() {
  if (window.Android && Android.keepAwake) Android.keepAwake(true);
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* non supportato */ }
}
document.addEventListener('visibilitychange', () => { if (D && !document.hidden) keepAwake(); });
