// LIMITATA
// "Ho N minuti: fin dove posso andare avanti lungo la linea (fuori servizio), girare e tornare qui?"
// - andata: lungo la linea dalla mia posizione alle fermate successive;
// - giro e ritorno: il percorso più breve SOLO su strade dove passano già linee bus (rete costruita dai
//   percorsi di tutte le linee ATAC, nel loro senso di marcia), con priorità alla linea stessa: niente
//   stradine strette né inversioni a U dove un bus non può farle;
// - si torna sulla linea in senso opposto fino all'altezza della mia posizione.
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

// ---------- rete delle strade percorse dai bus ----------
// Ogni percorso di linea viene diviso in punti ogni ~20 m. Un "nodo" è una celletta di ~20 m più la
// direzione di marcia (8 settori): così due linee sulla stessa strada nello stesso senso si uniscono,
// mentre i due sensi opposti della stessa strada restano separati (niente inversione a U in mezzo alla strada).
// Agli incroci si può passare da una linea all'altra solo con svolte fino a 90°.
const CELL = 20, SECT = 8;
const OWN = 1.0, OTHER = 1.35;      // costo al metro: strade della linea stessa / di altre linee
const TURN_COST = [0, 15, 45];      // metri "virtuali" per dritto, curva lieve, svolta a 90°
let netCache = null;

function buildNet(center, radiusM, line) {
  const key = `${line}|${center.map((x) => x.toFixed(2))}|${radiusM}`;
  if (netCache && netCache.key === key) return netCache;
  const k = Math.cos((center[1] * Math.PI) / 180);
  const dLat = CELL / 111320, dLng = CELL / (111320 * k);
  const maxLat = radiusM / 111320, maxLng = radiusM / (111320 * k);
  const idx = new Map(), xy = [], out = [], cellNodes = new Map(), nodeSec = [];
  const nodeOf = (lng, lat, sec) => {
    const cx = Math.floor(lng / dLng), cy = Math.floor(lat / dLat), key = `${cx},${cy},${sec}`;
    let n = idx.get(key);
    if (n === undefined) {
      n = xy.length; idx.set(key, n); xy.push([lng, lat]); out.push(new Map()); nodeSec.push(sec);
      const ck = `${cx},${cy}`;
      (cellNodes.get(ck) || cellNodes.set(ck, []).get(ck)).push(n);
    }
    return n;
  };
  const addEdge = (a, b, w, len, j = 0) => { if (a === b) return; const o = out[a].get(b); if (!o || o[0] > w) out[a].set(b, [w, len, j]); };
  const lineL = String(line).toLowerCase();
  for (const [rid, list] of Object.entries(C.store.shapes || {})) {
    const r = C.store.routes && C.store.routes[rid];
    if (r && r.t != null && +r.t !== 3) continue;   // solo autobus (niente tram, metro, treni)
    const mult = r && String(r.n).toLowerCase() === lineL ? OWN : OTHER;
    for (const sh of list) {
      const pts = decodePolyline(sh.p, 5);
      let prev = null, prevSec = null;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (Math.abs(a[1] - center[1]) > maxLat && Math.abs(b[1] - center[1]) > maxLat) { prev = null; prevSec = null; continue; }
        if (Math.abs(a[0] - center[0]) > maxLng && Math.abs(b[0] - center[0]) > maxLng) { prev = null; prevSec = null; continue; }
        const L = distance(a, b);
        if (L < 12) continue;   // tratti minuscoli = "baffi" del tracciato verso la fermata: li ignoro
        const ang = Math.atan2(b[1] - a[1], (b[0] - a[0]) * k);
        const sec = ((Math.round(ang / (2 * Math.PI / SECT)) % SECT) + SECT) % SECT;
        // inversione secca su un solo vertice (>110°): di solito è un "baffo" del tracciato verso la fermata,
        // non una vera inversione di marcia; interrompo la catena così non diventa un'inversione a U
        if (prevSec != null && secDiff(prevSec, sec) >= 3) prev = null;
        prevSec = sec;
        const n = Math.max(1, Math.ceil(L / CELL));
        for (let j = 0; j <= n; j++) {
          const q = [a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n];
          const cur = nodeOf(q[0], q[1], sec);
          if (prev !== null && prev !== cur) { const len = distance(xy[prev], xy[cur]); const dd = secDiff(nodeSec[prev], sec); addEdge(prev, cur, len * mult + TURN_COST[Math.min(2, dd)], len, dd >= 2 ? 1 : 0); }
          prev = cur;
        }
      }
    }
  }
  // incroci e linee affiancate: collego nodi vicini (stessa celletta o adiacenti) se la svolta è al massimo 90°
  for (const [ck, nodes] of cellNodes) {
    const [cx, cy] = ck.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const other = cellNodes.get(`${cx + dx},${cy + dy}`);
      if (!other) continue;
      for (const a of nodes) {
        for (const b of other) {
          if (a === b) continue;
          const d = secDiff(nodeSec[a], nodeSec[b]);
          if (d > 2) continue;
          const len = distance(xy[a], xy[b]);
          if (d === 2 && len > 15) continue;   // svolte a 90° solo nel punto d'incrocio, non tra strade vicine
          // solo in avanti: lo spostamento deve andare nel verso di marcia (niente retromarce)
          if (len > 8) {
            const mv = Math.atan2(xy[b][1] - xy[a][1], (xy[b][0] - xy[a][0]) * k);
            const sa = (nodeSec[a] * 2 * Math.PI) / SECT;
            let df = Math.abs(mv - sa) % (2 * Math.PI); if (df > Math.PI) df = 2 * Math.PI - df;
            if (df > Math.PI * 0.55) continue;
          }
          addEdge(a, b, len + TURN_COST[d], len, d >= 1 ? 1 : 0);   // ogni cambio di direzione fuori dal tracciato conta come svolta
        }
      }
    }
  }
  netCache = { key, xy, out, sec: nodeSec, nodeOf: (p, sec) => nearestNode(p, sec), k };
  return netCache;

  function nearestNode(p, sec) {
    const cx = Math.floor(p[0] / dLng), cy = Math.floor(p[1] / dLat);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 3 && best < 0; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      for (const n of cellNodes.get(`${cx + dx},${cy + dy}`) || []) {
        if (sec != null && secDiff(nodeSec[n], sec) > 1) continue;
        const d = distance(p, xy[n]);
        if (d < bd) { bd = d; best = n; }
      }
    }
    return best;
  }
}

const secDiff = (a, b) => { const d = Math.abs(a - b) % SECT; return Math.min(d, SECT - d); };

// costo per arrivare al nodo "target" da ogni nodo (Dijkstra all'indietro), fino a maxCost.
// Regola anti-inversione: dopo una svolta forte (≥90°) o un cambio di linea servono almeno due tratti dritti
// (~40 m) prima della svolta successiva: così due svolte a 90° attaccate non diventano un'inversione a U.
// Stato = nodo*3 + c, con c = tratti dritti ancora da fare prima di poter svoltare (0..2).
const ST = 3;
function costsTo(net, target, maxCost) {
  const N = net.xy.length;
  const rin = net.rin || (net.rin = (() => { const r = Array.from({ length: N }, () => []); net.out.forEach((m, a) => m.forEach(([w, len, j], b) => r[b].push([a, w, j]))); return r; })());
  const dist = new Float64Array(ST * N).fill(Infinity), next = new Int32Array(ST * N).fill(-1);
  const heap = [];
  const push = (x) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (let c = 0; c < ST; c++) { dist[ST * target + c] = 0; push([0, ST * target + c]); }
  // stati precedenti possibili: arco "svolta" porta sempre a c'=2 partendo da c=0; arco dritto porta a max(0,c-1)
  const preds = (j, c2) => (j ? (c2 === 2 ? [0] : []) : c2 === 0 ? [0, 1] : c2 === 1 ? [2] : []);
  while (heap.length) {
    const [d, sv] = pop();
    if (d > dist[sv] || d > maxCost) continue;
    const v = Math.floor(sv / ST), c2 = sv % ST;
    for (const [a, w, j] of rin[v]) {
      for (const c of preds(j, c2)) {
        const sa = ST * a + c, nd = d + w;
        if (nd < dist[sa]) { dist[sa] = nd; next[sa] = sv; push([nd, sa]); }
      }
    }
  }
  return { dist, next };
}

// inversione a U: la direzione cambia di più di 150° nel giro di 80 metri
function hasUturn(path) {
  const k = Math.cos((path[0][1] * Math.PI) / 180);
  const hs = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], L = distance(a, b);
    if (L < 3) continue;
    hs.push([Math.atan2(b[1] - a[1], (b[0] - a[0]) * k), L]);
  }
  for (let i = 0; i < hs.length; i++) {
    let run = 0;
    for (let j = i + 1; j < hs.length && run < 80; j++) {
      let d = Math.abs(hs[j][0] - hs[i][0]) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > (150 * Math.PI) / 180) return true;
      run += hs[j][1];
    }
  }
  return false;
}

const secAt = (route, at, k) => {
  const i = Math.max(1, route.cum.findIndex((x) => x >= at));
  const a = route.coords[Math.min(i, route.coords.length - 1) - 1], b = route.coords[Math.min(i, route.coords.length - 1)];
  const ang = Math.atan2(b[1] - a[1], (b[0] - a[0]) * k);
  return ((Math.round(ang / (2 * Math.PI / SECT)) % SECT) + SECT) % SECT;
};
const pointAt = (route, at) => route.coords[Math.max(0, route.cum.findIndex((x) => x >= at))] || route.coords[route.coords.length - 1];

async function compute(start, minutes) {
  const out = document.getElementById('limOut');
  if (!minutes || minutes < 5) { out.innerHTML = '<p class="late">Inserisci almeno 5 minuti.</p>'; return; }
  out.innerHTML = '<div class="spinner">Calcolo il giro sulle strade dei bus…</div>';
  await new Promise((r) => setTimeout(r, 30));
  const { mine, opp } = await lineData(start.line, start.dir);
  if (!mine) { out.innerHTML = '<p class="late">Non trovo il percorso della linea.</p>'; return; }
  const R = buildRoute(decodePolyline(mine.p, 5));
  const O = opp ? buildRoute(decodePolyline(opp.p, 5)) : R;   // circolare: si torna sulla linea stessa
  const me = nearestAt(R, start.pos);
  const meOpp = nearestAt(O, start.pos);
  if (me.m > 200) { out.innerHTML = '<p class="late">Non sei sul percorso della linea: non posso calcolare la limitata.</p>'; return; }

  // velocità per le stime (traffico raccolto dalla mappa), poi rifinita con TomTom sul giro scelto
  const segs = C.traffic.segs || [];
  const kmh = segs.length ? Math.max(8, Math.min(30, segs.reduce((a, x) => a + x.kmh, 0) / segs.length)) : 18;
  const mps = kmh / 3.6;
  const budget = minutes * 60;
  const reach = Math.min(MAX_AHEAD_M, budget * mps * 0.6 + 1500);   // fin dove ha senso cercare

  const net = buildNet(start.pos, reach + 2000, start.line);
  const target = net.nodeOf(pointAt(O, meOpp.at), secAt(O, meOpp.at, net.k));
  if (target < 0) { out.innerHTML = '<p class="late">Non riesco a costruire la rete stradale qui intorno.</p>'; return; }
  const { dist, next } = costsTo(net, target, reach * 3);

  // punti dove girare: le fermate davanti a me (più la fine del percorso)
  const stopsAhead = (mine.stops || []).map((x) => ({ name: x[2], p: [x[0], x[1]], at: nearestAt(R, [x[0], x[1]]).at }))
    .filter((x) => x.at > me.at + 100 && x.at <= me.at + reach).sort((a, b) => a.at - b.at);
  const options = [];
  for (const c of stopsAhead) {
    const n = net.nodeOf(c.p, secAt(R, c.at, net.k));
    if (n < 0 || !isFinite(dist[ST * n])) continue;
    // ricostruisco il ritorno: lunghezza vera
    const path = [];
    let len = 0, su = ST * n, guard = 0;
    while (Math.floor(su / ST) !== target && su >= 0 && guard++ < 20000) { const u = Math.floor(su / ST); path.push(net.xy[u]); const sv = next[su]; if (sv < 0) break; len += net.out[u].get(Math.floor(sv / ST))[1]; su = sv; }
    path.push(net.xy[target]);
    if (hasUturn(path)) continue;   // controllo di sicurezza: niente inversioni a U nel giro
    const fwdM = c.at - me.at;
    const fwd = fwdM / mps, back = len / mps;
    options.push({ ...c, fwdM, backM: len, fwd, back, total: fwd + TURN_S / 2 + back, path, km: fwdM / 1000 });
  }
  if (!options.length) { out.innerHTML = '<p class="late">Non trovo un giro possibile sulle strade dei bus qui intorno.</p>'; return; }

  // il giro più lungo che sta nei minuti; con TomTom ricontrollo i tempi col traffico vero (fino a 3 tentativi)
  let ok = options.filter((o) => o.total <= budget);
  let bestOpt = ok.length ? ok[ok.length - 1] : null, live = false;
  for (let tries = 0; bestOpt && tries < 3; tries++) {
    const t = await tomtom(R, me.at, bestOpt);
    if (!t) break;
    live = true;
    bestOpt.fwd = t.fwd; bestOpt.back = t.back; bestOpt.total = t.fwd + TURN_S / 2 + t.back;
    if (bestOpt.total <= budget) break;
    const i = options.indexOf(bestOpt);
    bestOpt = i > 0 ? options[i - 1] : null;
  }

  if (bestOpt) {
    const fwdLine = R.coords.filter((_, i) => R.cum[i] >= me.at && R.cum[i] <= bestOpt.at);
    C.map.getSource('route').setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: fwdLine }, properties: { color: '#F06A00', op: 0.95 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: bestOpt.path }, properties: { color: '#138A4B', op: 0.95 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: bestOpt.p }, properties: { color: '#F06A00' } },
    ] });
    C.fitTo(fwdLine.concat(bestOpt.path));
    speak(`Puoi girare a ${bestOpt.name}. Rientro previsto in ${Math.round(bestOpt.total / 60)} minuti.`);
  }
  const row = (o) => `<li class="${o === bestOpt ? 'lim-best' : ''}"><div class="grow"><div class="title">${esc(o.name)}</div>
      <div class="muted">${fmtKm(o.fwdM)} avanti · andata ${fmtMin(o.fwd)} · giro e ritorno ${fmtKm(o.backM)}, ${fmtMin(o.back)}</div></div>
      <div class="when ${o.total <= budget ? 'rt-time' : 'late'}">${fmtMin(o.total)}</div></li>`;
  const bi = bestOpt ? options.indexOf(bestOpt) : 0;
  const shown = options.slice(Math.max(0, bi - 2), bi + 2);
  out.innerHTML = `
    ${bestOpt
      ? `<div class="live-box"><div>Gira dopo <b>${esc(bestOpt.name)}</b> (${fmtKm(bestOpt.fwdM)} avanti) seguendo il percorso verde: rientro in circa <b>${fmtMin(bestOpt.total)}</b> su ${minutes}.</div></div>`
      : `<p class="late">Con ${minutes} minuti non c'è un punto dove girare: il più vicino richiede ${fmtMin(options[0].total)}.</p>`}
    <ul class="rows">${shown.map(row).join('')}</ul>
    <p class="muted">Il giro passa solo su strade dove circolano già linee bus, nel loro senso di marcia, preferendo il percorso della ${esc(start.line)}. ${live ? 'Tempi da TomTom con il traffico attuale' : `Tempi stimati (≈${Math.round(kmh)} km/h)`}. In arancio l'andata, in verde giro e ritorno. Fa fede sempre la disposizione della centrale.</p>`;
}

// tempi veri con TomTom: punti presi lungo il percorso ogni ~300 m, così segue le stesse strade
async function tomtom(R, fromAt, o) {
  if (!C.PROXY) return null;
  const fwdPts = [];
  for (let a = fromAt; a < o.at; a += 300) fwdPts.push(pointAt(R, a));
  fwdPts.push(o.p);
  const step = Math.max(1, Math.floor(o.path.length / Math.max(2, Math.ceil(o.backM / 300))));
  const backPts = o.path.filter((_, i) => i % step === 0).concat([o.path[o.path.length - 1]]);
  if (fwdPts.length + backPts.length > 140) return null;
  try {
    const res = await fetch(C.PROXY.replace(/\/$/, '') + '/tempi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ punti: fwdPts.concat(backPts) }) });
    const data = await res.json();
    if (!res.ok || !data.tratti) return null;
    const s = data.tratti.map((t) => t.s);
    const nf = fwdPts.length - 1;
    return { fwd: s.slice(0, nf).reduce((a, x) => a + x, 0), back: s.slice(nf).reduce((a, x) => a + x, 0) };
  } catch (e) { return null; }
}
