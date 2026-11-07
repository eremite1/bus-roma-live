// LIMITATA
// "Ho N minuti: fin dove posso andare avanti lungo la linea (fuori servizio), girare e tornare qui?"
// - andata: lungo la linea dalla mia posizione alle fermate successive;
// - giro: in una fermata dove passa vicino anche la linea in senso opposto;
// - ritorno: lungo la linea in senso opposto fino all'altezza della mia posizione.
// I tempi arrivano da TomTom con il traffico attuale (tramite il ponte); senza TomTom stimo dalla velocità dei bus.

import { decodePolyline } from './api.js';
import { distance } from './vehicles.js';
import { buildRoute } from './nav.js';
import { speak } from './voice.js';

let C = null;
export function initLimitata(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TURN_S = 120;          // tempo per girare il mezzo
const TURN_RADIUS = 250;     // la fermata del senso opposto deve essere entro 250 m
const MAX_AHEAD_M = 20000;
const fmtMin = (s) => `${Math.round(s / 60)} min`;
const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`);

function nearestAt(route, p) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < route.coords.length; i++) {
    const d = distance(route.coords[i], p);
    if (d < bd) { bd = d; best = i; }
  }
  return { at: route.cum[best], m: bd };
}

// percorsi della linea: il mio senso (dir) e quello opposto, con le fermate
async function lineData(line, dir) {
  await C.loadShapes();
  await C.loadLineStops();
  const ids = Object.entries(C.store.routes || {}).filter(([, r]) => String(r.n).toLowerCase() === String(line).toLowerCase()).map(([id]) => id);
  let mine = null, opp = null;
  for (const id of ids) for (const s of C.store.shapes[id] || []) {
    const ls = ((C.store.linestops && C.store.linestops[id]) || []).find((x) => x.d === s.d);
    const item = { ...s, stops: ls ? ls.s : [] };
    if (s.d === dir && !mine) mine = item;
    else if (s.d !== dir && !opp) opp = item;
  }
  return { mine, opp };
}

async function times(points) {
  // tempi in secondi per ogni tratto tra punti consecutivi
  if (C.PROXY) {
    try {
      const res = await fetch(C.PROXY.replace(/\/$/, '') + '/tempi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ punti: points }),
      });
      const data = await res.json();
      if (res.ok && data.tratti && data.tratti.length === points.length - 1) return { legs: data.tratti.map((t) => t.s), live: true };
    } catch (e) { /* passo alla stima */ }
  }
  // stima: velocità dei bus (traffico raccolto dalla mappa) oppure 18 km/h fuori servizio
  const segs = C.traffic.segs;
  const avg = segs.length ? Math.max(8, segs.reduce((a, s) => a + s.kmh, 0) / segs.length) : 18;
  const legs = [];
  for (let i = 1; i < points.length; i++) legs.push((distance(points[i - 1], points[i]) * 1.25) / (avg / 3.6));
  return { legs, live: false, avg };
}

export async function openLimitata(start) {
  // start = { line, dir, pos: [lng, lat] }
  C.openSheet(`
    <h2>Limitata</h2>
    <p class="sub">Linea <b>${esc(start.line)}</b>: quanti minuti hai per andare avanti fuori servizio, girare e tornare qui?</p>
    <form id="limForm" class="dev-field">Minuti <input id="limMin" type="number" inputmode="numeric" min="5" max="120" value="30"><button class="btn" type="submit">Calcola</button></form>
    <div class="lim-quick">${[15, 20, 30, 40].map((m) => `<button class="chip" data-m="${m}">${m} min</button>`).join('')}</div>
    <div id="limOut"></div>
  `, { type: 'limitata' });
  const go = (m) => compute(start, m);
  document.getElementById('limForm').onsubmit = (e) => { e.preventDefault(); go(+document.getElementById('limMin').value); };
  C.sheetBody.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => { document.getElementById('limMin').value = b.dataset.m; go(+b.dataset.m); }; });
}

async function compute(start, minutes) {
  const out = document.getElementById('limOut');
  if (!minutes || minutes < 5) { out.innerHTML = '<p class="late">Inserisci almeno 5 minuti.</p>'; return; }
  out.innerHTML = '<div class="spinner">Calcolo i tempi con il traffico attuale…</div>';
  const { mine, opp } = await lineData(start.line, start.dir);
  if (!mine || !opp) { out.innerHTML = '<p class="late">Mi servono i percorsi di andata e ritorno della linea, che non trovo.</p>'; return; }
  const R = buildRoute(decodePolyline(mine.p, 5));
  const O = buildRoute(decodePolyline(opp.p, 5));
  const me = nearestAt(R, start.pos);
  const meOpp = nearestAt(O, start.pos);
  if (me.m > 200) { out.innerHTML = '<p class="late">Non sei sul percorso della linea: non posso calcolare la limitata.</p>'; return; }

  // fermate davanti a me, ciascuna con la fermata del senso opposto più vicina (dove girare)
  const oppStops = opp.stops.map((s) => ({ name: s[2], p: [s[0], s[1]], at: nearestAt(O, [s[0], s[1]]).at }));
  const cands = [];
  for (const s of mine.stops) {
    const p = [s[0], s[1]];
    const at = nearestAt(R, p).at;
    if (at <= me.at + 100 || at > me.at + MAX_AHEAD_M) continue;
    let best = null, bd = TURN_RADIUS;
    for (const o of oppStops) { const d = distance(p, o.p); if (d < bd && o.at < meOpp.at) { bd = d; best = o; } }
    cands.push({ name: s[2], p, at, opp: best });
  }
  const usable = cands.filter((c) => c.opp);
  if (!usable.length) { out.innerHTML = '<p class="late">Non trovo punti adatti per girare lungo la linea davanti a te.</p>'; return; }

  // andata: io -> fermate davanti (in ordine)
  const fwdPts = [start.pos, ...cands.map((c) => c.p)];
  // ritorno: dalla fermata opposta più lontana, lungo il senso opposto, fino alla mia altezza
  const farOppAt = Math.min(...usable.map((c) => c.opp.at));
  const backStops = oppStops.filter((o) => o.at >= farOppAt && o.at < meOpp.at).sort((a, b) => a.at - b.at);
  const backPts = [...backStops.map((o) => o.p), O.coords[O.cum.findIndex((x) => x >= meOpp.at)] || start.pos];
  const [f, b] = await Promise.all([times(fwdPts), times(backPts)]);

  const fwdCum = [0];
  f.legs.forEach((t, i) => fwdCum.push(fwdCum[i] + t));
  const backFrom = new Array(backPts.length).fill(0);
  for (let i = backPts.length - 2; i >= 0; i--) backFrom[i] = backFrom[i + 1] + b.legs[i];

  const budget = minutes * 60;
  const options = [];
  cands.forEach((c, i) => {
    if (!c.opp) return;
    const bi = backStops.indexOf(c.opp);
    if (bi < 0) return;
    const total = fwdCum[i + 1] + TURN_S + backFrom[bi];
    options.push({ ...c, fwd: fwdCum[i + 1], back: backFrom[bi], total, km: (c.at - me.at) / 1000 });
  });
  const ok = options.filter((o) => o.total <= budget);
  const bestOpt = ok.length ? ok[ok.length - 1] : null;
  const live = f.live && b.live;

  // disegno sulla mappa: andata (arancio) fino al punto, ritorno (verde)
  if (bestOpt) {
    const fwdLine = R.coords.filter((_, i) => R.cum[i] >= me.at && R.cum[i] <= bestOpt.at);
    const backLine = O.coords.filter((_, i) => O.cum[i] >= bestOpt.opp.at && O.cum[i] <= meOpp.at);
    C.map.getSource('route').setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: fwdLine }, properties: { color: '#F06A00', op: 0.95 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: backLine }, properties: { color: '#138A4B', op: 0.95 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: bestOpt.p }, properties: { color: '#F06A00' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: bestOpt.opp.p }, properties: { color: '#138A4B' } },
    ] });
    C.fitTo(fwdLine.concat(backLine));
    speak(`Puoi girare a ${bestOpt.name}. Rientro previsto in ${Math.round(bestOpt.total / 60)} minuti.`);
  }
  const row = (o) => `<li class="${o === bestOpt ? 'lim-best' : ''}"><div class="grow"><div class="title">${esc(o.name)}</div>
      <div class="muted">${fmtKm(o.km * 1000)} avanti · andata ${fmtMin(o.fwd)} · ritorno ${fmtMin(o.back)} da ${esc(o.opp.name)}</div></div>
      <div class="when ${o.total <= budget ? 'rt-time' : 'late'}">${fmtMin(o.total)}</div></li>`;
  const shown = bestOpt ? options.slice(Math.max(0, options.indexOf(bestOpt) - 2), options.indexOf(bestOpt) + 2) : options.slice(0, 3);
  out.innerHTML = `
    ${bestOpt
      ? `<div class="live-box"><div>Gira a <b>${esc(bestOpt.name)}</b> (${fmtKm(bestOpt.km * 1000)} avanti) e riparti da <b>${esc(bestOpt.opp.name)}</b>: rientro in circa <b>${fmtMin(bestOpt.total)}</b> su ${minutes}.</div></div>`
      : `<p class="late">Con ${minutes} minuti non c'è un punto dove girare: il più vicino richiede ${options.length ? fmtMin(options[0].total) : '—'}.</p>`}
    <ul class="rows">${shown.map(row).join('')}</ul>
    <p class="muted">${live ? 'Tempi calcolati da TomTom con il traffico attuale' : `Stima senza dati TomTom (velocità media ${Math.round(f.avg || 18)} km/h)`}, più ${TURN_S / 60} minuti per girare. In arancio l'andata, in verde il ritorno. Fa fede sempre la disposizione della centrale.</p>`;
}
