// LIMITATA
// "Sono in ritardo, ho N minuti per arrivare al capolinea: dove rientro in servizio?"
// - andata FUORI SERVIZIO: dalla mia posizione al punto di inversione, qualsiasi percorso purché su strade
//   dove passano già linee bus (rete costruita dai percorsi di tutte le linee ATAC, nel loro senso di marcia),
//   con una leggera preferenza per la linea stessa: niente stradine strette né inversioni a U impossibili;
// - ritorno IN SERVIZIO: dal punto di inversione (una fermata della linea in senso opposto) fino al capolinea,
//   SEMPRE sul percorso della linea, perché quel tratto si fa con i passeggeri.
// Scelgo il punto che fa servire più strada possibile restando nei minuti.
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
  const addEdge = (a, b, w, len, j = 0, kind = 0) => { if (a === b) return; const o = out[a].get(b); if (!o || o[0] > w) out[a].set(b, [w, len, j, kind]); };
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
          addEdge(a, b, len + TURN_COST[d], len, d >= 1 ? 1 : 0, 1);   // ogni cambio di direzione fuori dal tracciato conta come svolta
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

// costo per arrivare da "source" a ogni nodo (Dijkstra), fino a maxCost.
// Regola anti-inversione: dopo una svolta forte (≥90°) o un cambio di linea servono almeno due tratti dritti
// (~40 m) prima della svolta successiva: così due svolte a 90° attaccate non diventano un'inversione a U.
// Stato = nodo*3 + c, con c = tratti dritti ancora da fare prima di poter svoltare (0..2).
const ST = 3;
function costsFrom(net, source, maxCost) {
  const N = net.xy.length;
  const dist = new Float64Array(ST * N).fill(Infinity), prev = new Int32Array(ST * N).fill(-1);
  const heap = [];
  const push = (x) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  dist[ST * source] = 0; push([0, ST * source]);
  while (heap.length) {
    const [d, su] = pop();
    if (d > dist[su] || d > maxCost) continue;
    const u = Math.floor(su / ST), c = su % ST;
    for (const [v, [w, , j]] of net.out[u]) {
      if (j && c) continue;                       // svolta non ancora permessa
      const sv = ST * v + (j ? 2 : Math.max(0, c - 1)), nd = d + w;
      if (nd < dist[sv]) { dist[sv] = nd; prev[sv] = su; push([nd, sv]); }
    }
  }
  return { dist, prev };
}

// percorso (coordinate e metri veri) dalla sorgente al nodo n, nel suo stato migliore
function pathTo(net, D, n) {
  let best = -1, bd = Infinity;
  for (let c = 0; c < ST; c++) if (D.dist[ST * n + c] < bd) { bd = D.dist[ST * n + c]; best = ST * n + c; }
  if (best < 0) return null;
  const pts = []; let len = 0, s = best, guard = 0;
  while (s >= 0 && guard++ < 50000) {
    const u = Math.floor(s / ST); pts.push(net.xy[u]);
    const p = D.prev[s]; if (p < 0) break;
    len += net.out[Math.floor(p / ST)].get(u)[1]; s = p;
  }
  return { pts: pts.reverse(), len, cost: bd };
}

function cutJunctions(net, pts) {
  let n = 0;
  net.out.forEach((m, a) => {
    if (!pts.some((p) => distance(p, net.xy[a]) < 40)) return;
    for (const [b, e] of m) if (e[3] === 1) { m.delete(b); n++; }
  });
  return n > 0;
}

// inversione a U: la direzione cambia di più di 150° nel giro di 80 metri
function hasUturn(path, where) {
  const k = Math.cos((path[0][1] * Math.PI) / 180);
  const hs = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], L = distance(a, b);
    if (L < 3) continue;
    hs.push([Math.atan2(b[1] - a[1], (b[0] - a[0]) * k), L, b]);
  }
  for (let i = 0; i < hs.length; i++) {
    let run = 0;
    for (let j = i + 1; j < hs.length && run < 80; j++) {
      let d = Math.abs(hs[j][0] - hs[i][0]) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > (150 * Math.PI) / 180) return where ? hs[j][2] : true;
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
  out.innerHTML = '<div class="spinner">Calcolo la limitata sulle strade dei bus…</div>';
  await new Promise((r) => setTimeout(r, 30));
  const { mine, opp } = await lineData(start.line, start.dir);
  if (!mine) { out.innerHTML = '<p class="late">Non trovo il percorso della linea.</p>'; return; }
  const R = buildRoute(decodePolyline(mine.p, 5));
  const O = opp ? buildRoute(decodePolyline(opp.p, 5)) : R;   // circolare: si rientra sulla linea stessa
  const oStops = (opp || mine).stops || [];
  const me = nearestAt(R, start.pos);
  if (me.m > 300) { out.innerHTML = '<p class="late">Non sei sul percorso della linea: non posso calcolare la limitata.</p>'; return; }

  // velocità per le stime (traffico raccolto dalla mappa), poi rifinita con TomTom sul giro scelto
  const segs = C.traffic.segs || [];
  const kmh = segs.length ? Math.max(8, Math.min(30, segs.reduce((a, x) => a + x.kmh, 0) / segs.length)) : 18;
  const mps = kmh / 3.6;
  const budget = minutes * 60;
  const reach = Math.min(MAX_AHEAD_M, budget * mps * 0.7 + 1500);

  const net = buildNet(start.pos, reach + 2000, start.line);
  const src = net.nodeOf(pointAt(R, me.at), secAt(R, me.at, net.k));
  if (src < 0) { out.innerHTML = '<p class="late">Non riesco a costruire la rete stradale qui intorno.</p>'; return; }
  // punti di inversione: le fermate della linea in senso opposto (da lì in servizio fino al capolinea)
  const capo = oStops.length ? oStops[oStops.length - 1][2] : 'capolinea';
  let options = [], bad = [];
  for (let round = 0; round < 4; round++) {
  const D = costsFrom(net, src, reach * 2);
  options = []; bad = [];
  for (const x of oStops.slice(0, -1)) {
    const p = [x[0], x[1]];
    const at = nearestAt(O, p).at;
    if (distance(p, start.pos) > reach) continue;
    const n = net.nodeOf(p, secAt(O, at, net.k));
    if (n < 0) continue;
    const f = pathTo(net, D, n);
    if (!f || f.pts.length < 2) continue;
    const ut = hasUturn(f.pts, true);
    if (ut) { bad.push(ut); continue; }             // inversione a U: riprovo dopo aver tolto quel raccordo                 // controllo di sicurezza: niente inversioni a U
    const servM = O.total - at;                     // tratto in servizio fino al capolinea
    const fwd = f.len / mps, back = servM / mps;
    options.push({ name: x[2], p, at, fwdM: f.len, backM: servM, fwd, back, total: fwd + TURN_S / 2 + back, path: f.pts });
  }
  // dove il percorso più breve fa un'inversione a U impossibile, tolgo i raccordi tra linee in quel punto
  // (restano solo i tracciati veri delle linee) e ricalcolo
  if (!bad.length || !cutJunctions(net, bad)) break;
  }
  if (!options.length) { out.innerHTML = '<p class="late">Non trovo un punto dove girare sulle strade dei bus qui intorno.</p>'; return; }
  options.sort((a, b) => b.backM - a.backM);        // prima quelli che servono più strada

  // il punto che serve più strada restando nei minuti; con TomTom ricontrollo i tempi (fino a 3 tentativi)
  const fits = () => options.filter((o) => o.total <= budget);
  let bestOpt = fits()[0] || null, live = false;
  for (let tries = 0; bestOpt && tries < 3; tries++) {
    const t = await tomtom(O, bestOpt);
    if (!t) break;
    live = true;
    bestOpt.fwd = t.fwd; bestOpt.back = t.back; bestOpt.total = t.fwd + TURN_S / 2 + t.back; bestOpt.tt = true;
    if (bestOpt.total <= budget) break;
    bestOpt = fits().find((o) => !o.tt) || null;
  }

  if (bestOpt) {
    const servLine = O.coords.filter((_, i) => O.cum[i] >= bestOpt.at);
    C.map.getSource('route').setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: bestOpt.path }, properties: { color: '#F06A00', op: 0.95 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: servLine }, properties: { color: '#138A4B', op: 0.95 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: bestOpt.p }, properties: { color: '#138A4B' } },
    ] });
    C.fitTo(bestOpt.path.concat(servLine));
    speak(`Limitata: rientri in servizio a ${bestOpt.name}. Arrivo al capolinea in circa ${Math.round(bestOpt.total / 60)} minuti.`);
  }
  const row = (o) => `<li class="${o === bestOpt ? 'lim-best' : ''}"><div class="grow"><div class="title">${esc(o.name)}</div>
      <div class="muted">fuori servizio ${fmtKm(o.fwdM)}, ${fmtMin(o.fwd)} · in servizio ${fmtKm(o.backM)}, ${fmtMin(o.back)}</div></div>
      <div class="when ${o.total <= budget ? 'rt-time' : 'late'}">${fmtMin(o.total)}</div></li>`;
  const bi = bestOpt ? options.indexOf(bestOpt) : options.reduce((b, o, i) => (o.total < options[b].total ? i : b), 0);
  const shown = options.slice(Math.max(0, bi - 2), bi + 3);
  out.innerHTML = `
    ${bestOpt
      ? `<div class="live-box"><div>Fuori servizio fino a <b>${esc(bestOpt.name)}</b> (percorso arancio), poi <b>in servizio</b> sul percorso della ${esc(start.line)} fino a <b>${esc(capo)}</b> (verde): arrivo in circa <b>${fmtMin(bestOpt.total)}</b> su ${minutes}.</div></div>`
      : `<p class="late">Con ${minutes} minuti non ci sta nessuna limitata: la più corta richiede ${fmtMin(options[bi].total)}.</p>`}
    <ul class="rows">${shown.map(row).join('')}</ul>
    <p class="muted">Il tratto fuori servizio passa solo su strade dove circolano già linee bus, nel loro senso di marcia. Il tratto in servizio segue sempre il percorso della linea. ${live ? 'Tempi da TomTom con il traffico attuale' : `Tempi stimati (≈${Math.round(kmh)} km/h)`}. Fa fede sempre la disposizione della centrale.</p>`;
}

// tempi veri con TomTom: punti presi lungo i due tratti ogni ~300 m, così segue le stesse strade
async function tomtom(O, o) {
  if (!C.PROXY) return null;
  const step = Math.max(1, Math.floor(o.path.length / Math.max(2, Math.ceil(o.fwdM / 300))));
  const fwdPts = o.path.filter((_, i) => i % step === 0).concat([o.p]);
  const backPts = [];
  for (let a = o.at + 300; a < O.total; a += 300) backPts.push(pointAt(O, a));
  backPts.push(O.coords[O.coords.length - 1]);
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

