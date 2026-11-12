// USCITE E RIENTRI IN DEPOSITO
// Una "tabella" (turno macchina) è l'insieme delle corse che fa lo stesso bus nella giornata.
// Ogni serie di corse di servizio (separata da collegamenti col deposito o da pause di oltre un'ora)
// comincia con un'USCITA e finisce con un RIENTRO.
// I collegamenti hanno nome "lettera + 2 cifre" (G07, M03, P20…): la lettera indica il deposito.
// La vettura si conosce appena la tabella è in servizio (il GPS dice quale corsa sta facendo ogni bus).

let C = null;
export function initRientri(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const h24 = (t) => String(t).replace(/^(\d+):/, (x, h) => String(+h % 24).padStart(2, '0') + ':');
const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return v; };

// collegamenti deposito <-> capolinea
export const isColl = (line) => /^[A-Z]\d{2}$/.test(String(line || ''));
const DEPOT_NAMES = { G: 'Grottarossa', M: 'Magliana', P: 'Portonaccio', T: 'Tor Vergata', A: 'Prenestina' };

let blocks = null, depotPlace = {}, lineDepot = {}, names = {}, rim = null;
const dayCache = {}; // 'AAAA-MM-GG' -> { blocks, rimessa }
let dayIndex = null;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
async function loadDay(date) {
  if (!date || date === todayISO()) return { blocks, rimessa: rim, today: true };
  if (!dayCache[date]) {
    try { dayCache[date] = await (await fetch(`data/giorni/${date}.json`, { cache: 'no-cache' })).json(); } catch (e) { dayCache[date] = { blocks: {}, rimessa: null }; }
  }
  return { ...dayCache[date], today: false };
}
// corse di una tabella: di oggi o di un altro giorno già caricato
function tripsOf(b) {
  if (blocks && blocks[b]) return blocks[b];
  for (const d of Object.values(dayCache)) if (d.blocks && d.blocks[b]) return d.blocks[b];
  return null;
}
// Orari di USCITA dalla rimessa e RIENTRO in rimessa di una serie di servizio.
// f: 0 = vero (collegamento o fermata del deposito), 1 = dal tempo di un collegamento vicino, 2 = stima dalla distanza
export function rimessaRun(trips, run, R = rim) {
  const D = depotOf(trips, run);
  const tab = (R && R.tempi && R.tempi[D]) || {};
  let out, outF, inn, inF;
  if (run.before) { out = mins(run.before[1]); outF = 0; }
  else if (tab[run.startPlace]) { out = mins(run.start) - tab[run.startPlace][0]; outF = tab[run.startPlace][1]; }
  else { out = mins(run.start); outF = 3; }
  if (run.after) { inn = mins(trips[run.idx + run.colls][2]); inF = 0; }
  else if (tab[run.endPlace]) { inn = mins(run.end) + tab[run.endPlace][0]; inF = tab[run.endPlace][1]; }
  else { inn = mins(run.end); inF = 3; }
  return { out, outF, inn, inF, D };
}
const hmS = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
const tilde = (f) => (f >= 2 ? '≈' : '');
const DEPOT_STOPS = new Set();
export async function loadBlocks() {
  if (blocks) return blocks;
  try { blocks = await (await fetch('data/blocks.json', { cache: 'no-cache' })).json(); } catch (e) { blocks = {}; }
  try { names = await (await fetch('data/tabelle.json', { cache: 'no-cache' })).json(); } catch (e) { names = {}; }
  try { rim = await (await fetch('data/rimessa.json', { cache: 'no-cache' })).json(); } catch (e) { rim = null; }
  Object.assign(names, store('tabelleNomi') || {});
  // dove si trova ogni deposito: la fermata più frequente tra le estremità dei suoi collegamenti
  const count = {};
  for (const trips of Object.values(blocks)) for (const t of trips) {
    if (!isColl(t[3])) continue;
    const L = t[3][0];
    count[L] = count[L] || {};
    for (const p of [t[4], t[5]]) count[L][p] = (count[L][p] || 0) + 1;
  }
  for (const [L, c] of Object.entries(count)) { depotPlace[L] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; DEPOT_STOPS.add(depotPlace[L]); }
  // deposito di ogni linea: dalla lettera dei collegamenti delle sue tabelle
  const votes = {};
  for (const trips of Object.values(blocks)) {
    const Ls = trips.filter((t) => isColl(t[3])).map((t) => t[3][0]);
    if (!Ls.length) continue;
    for (const t of trips) if (!isColl(t[3])) { votes[t[3]] = votes[t[3]] || {}; votes[t[3]][Ls[0]] = (votes[t[3]][Ls[0]] || 0) + 1; }
  }
  for (const [line, v] of Object.entries(votes)) lineDepot[line] = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
  return blocks;
}
export const depotName = (L) => (L ? DEPOT_NAMES[L] || `deposito ${L}${depotPlace[L] ? ' (zona ' + depotPlace[L] + ')' : ''}` : '');

export const blockOf = (tripId) => (tripId && tripId.includes('#') && tripId.includes('-') ? tripId.slice(0, tripId.lastIndexOf('-')) : '');

// Serie di servizio di una tabella: [{ first, idx, line, start, startPlace, end, endPlace, before, after, colls }]
// before/after = collegamento prima (uscita dal deposito) e dopo (rientro)
export function runsOf(trips) {
  const out = [];
  let i = 0;
  while (i < trips.length) {
    const c0 = i;
    while (i < trips.length && isColl(trips[i][3])) i++;
    if (i >= trips.length) break;
    const before = i > c0 ? trips[i - 1] : null;
    const first = i;
    while (i + 1 < trips.length && !isColl(trips[i + 1][3]) && mins(trips[i + 1][1]) - mins(trips[i][2]) < 60) i++;
    let j = i + 1;
    while (j < trips.length && isColl(trips[j][3])) j++;
    const after = j > i + 1 ? trips[i + 1] : null;
    out.push({ first, idx: i, line: trips[i][3], firstLine: trips[first][3], start: trips[first][1], startPlace: trips[first][4],
      end: trips[i][2], endPlace: trips[i][5], before, after, colls: j - i - 1 });
    i = j;
  }
  return out;
}
export const rientriOf = runsOf;

// Nome della tabella (es. "913/4"): da data/tabelle.json o assegnato a mano; chiave = linea@orario prima corsa
// chiave del nome: linea@orario della prima corsa di servizio, più il capolinea di partenza
// (due tabelle della stessa linea possono partire alla stessa ora da capolinea diversi)
export function nameKey(trips) {
  const r = runsOf(trips)[0];
  if (!r) return '';
  const f = trips.find((t) => !isColl(t[3]));
  return `${r.firstLine}@${r.start}` + (f ? '>' + f[4] : '');
}
const plainKey = (k) => k.split('>')[0];
export function tabName(b) {
  const trips = tripsOf(b);
  const k = trips && nameKey(trips);
  const n = k && (names[k] || names[plainKey(k)]);
  return n || `Tab. ${b.replace(/^0#/, '')}`;
}
export function setTabName(b, value) {
  const trips = blocks && blocks[b];
  if (!trips) return;
  const own = store('tabelleNomi') || {};
  const key = nameKey(trips);
  if (value) { own[key] = value; names[key] = value; } else { delete own[key]; delete names[key]; }
  store('tabelleNomi', own);
}

function depotOf(trips, run) {
  const c = (run && (run.after || run.before)) || trips.find((t) => isColl(t[3]));
  return c ? c[3][0] : lineDepot[run ? run.line : trips[0][3]] || '';
}

// ---------------- schermata ----------------
let view = { tab: 'rientri', from: 0, to: 24, line: '', depot: '', place: '', date: '', ...(store('rientriVista2') || {}) };
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
let timer = null;

export async function openRientri() {
  C.openSheet('<div id="rnView"><div class="spinner">Carico le tabelle di oggi…</div></div>', { type: 'rientri' }, { tall: true });
  await loadBlocks();
  if (!dayIndex) { try { dayIndex = await (await fetch('data/giorni/indice.json', { cache: 'no-cache' })).json(); } catch (e) { dayIndex = []; } }
  if (view.date && view.date < todayISO()) view.date = '';
  C.refreshAtac && C.refreshAtac(); // collega le vetture GPS alle corse anche quando il GPS non lo dice
  render();
  clearInterval(timer);
  timer = setInterval(() => { if (C.state.view?.type === 'rientri') render(); else clearInterval(timer); }, 30_000);
}

export function vehiclesByBlock() {
  const map = new Map();
  for (const s of C.state.shown.values()) {
    const v = s.v;
    if (v.source !== 'gps' || v.spento) continue;
    const b = blockOf(v.tripId);
    if (b) map.set(b, v);
  }
  return map;
}

async function render() {
  let el = document.getElementById('rnView');
  if (!el) return;
  const day = await loadDay(view.date);
  el = document.getElementById('rnView');
  if (!el) return;
  const vb = day.today ? vehiclesByBlock() : new Map();
  const now = day.today ? new Date().getHours() * 60 + new Date().getMinutes() : -1;
  const out = view.tab === 'uscite';
  const GN = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const dayLabel = (d) => { if (!d || d === todayISO()) return 'Oggi'; const x = new Date(d + 'T12:00'); return `${GN[x.getDay()]} ${x.getDate()}/${x.getMonth() + 1}`; };
  const rows = [];
  const depots = new Set();
  for (const [b, trips] of Object.entries(day.blocks || {})) {
    if (!trips.length) continue;
    const lines = [...new Set(trips.map((t) => String(t[3])).filter((l) => !isColl(l)))];
    if (view.line && !lines.some((l) => l.toLowerCase() === view.line.toLowerCase())) continue;
    const v = vb.get(b);
    const ci = v ? trips.findIndex((t) => t[0] === v.tripId) : -1;
    for (const run of runsOf(trips)) {
      const dep = depotOf(trips, run);
      if (dep) depots.add(dep);
      if (view.depot && dep !== view.depot) continue;
      const rm = rimessaRun(trips, run, day.rimessa);
      const t = out ? rm.out : rm.inn; // orario di uscita dalla / rientro in rimessa
      if (t < view.from * 60 || t > view.to * 60 + (view.to >= 24 ? 360 : 0)) continue;
      // filtro per capolinea (es. "mancini"): dove finisce il servizio (rientri) o dove comincia (uscite)
      if (view.place && !norm(out ? run.startPlace : run.endPlace).includes(norm(view.place))) continue;
      let live = '', expected = null, state;
      if (out) {
        state = now < 0 ? 'later' : t < now ? 'done' : 'later';
        if (v && ci >= run.first && ci <= run.idx) { state = 'on'; live = 'in servizio'; }
      } else {
        if (v && ci === run.idx) {
          const d = C.delayOf ? C.delayOf(v) : null;
          if (d != null) { expected = t + d; live = d <= -1 ? `in anticipo di ${-d} min` : d >= 2 ? `in ritardo di ${d} min` : 'in orario'; } else live = "sull'ultima corsa";
        } else if (v && ci > run.idx && ci <= run.idx + run.colls) live = 'sta rientrando ora';
        state = now < 0 ? 'later' : live ? 'on' : t < now ? 'done' : mins(run.start) > now ? 'later' : 'on';
      }
      rows.push({ b, run, t, rm, dep, live, expected, state, v: state === 'done' || (out && state === 'later') ? null : v,
        line: lines.length > 1 ? lines.join(' › ') : run.line });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const pending = rows.filter((r) => r.state !== 'done');
  const row = (r) => {
    const R = r.run;
    const f = out ? r.rm.outF : r.rm.inF;
    const time = tilde(f) + hmS(r.t);
    const place = out ? R.startPlace : R.endPlace;
    const coll = out ? R.before : R.after;
    const gap = Math.abs(out ? mins(R.start) - r.t : r.t - mins(R.end));
    const collTxt = (out ? `in linea alle <b>${esc(h24(R.start))}</b>` : `fine servizio <b>${esc(h24(R.end))}</b>`)
      + (coll ? ` · ${esc(coll[3])}` : f === 3 ? ' · tempo dal deposito sconosciuto' : gap ? ` · ${f >= 2 ? 'circa ' : ''}${gap} min ${out ? 'dal' : 'al'} deposito${f >= 2 ? ' (stima)' : ''}` : '');
    return `<li class="rn-${r.state}" data-b="${esc(r.b)}" data-v="${r.v ? esc(r.v.id) : ''}">
      <div class="rn-time">${r.expected != null ? `<span class="rn-exp">${hm(r.expected + (r.t - mins(R.end)))}</span><s>${esc(time)}</s>` : esc(time)}</div>
      ${C.badge(r.line, C.colorOf({ line: r.line.split(' ')[0] }))}
      <div class="grow"><div class="title">${out ? 'da' : 'a'} ${esc(place)}</div>
        <div class="muted"><b>${esc(tabName(r.b))}</b> · ${collTxt}${r.dep ? ' · ' + esc(depotName(r.dep)) : ''}${r.state === 'done' ? (out ? ' · uscita' : ' · rientrata') : ''}</div>
        ${r.live ? `<div class="rn-live">● ${esc(r.live)}</div>` : ''}</div>
      <div class="when">${r.v ? `<span class="rn-car">${esc(r.v.vehicleNo)}</span>` : !out && r.state === 'on' ? '<span class="muted">vettura non vista</span>' : ''}
        <button class="link-btn" data-tab-open>tabella</button></div></li>`;
  };
  const opts = (n, sel) => Array.from({ length: n }, (_, h) => `<option${h === sel ? ' selected' : ''}>${h}</option>`).join('');
  const ghosts = out ? [] : [...C.state.shown.values()].map((x) => x.v).filter((v) => v.spento && v.ghost && v.ghost.tipo === 'recupero'
    && (!view.line || String(v.line).toLowerCase() === view.line.toLowerCase()) && (!view.depot || v.ghost.dep === view.depot));
  const ghostRow = (v) => {
    const g = v.ghost, min = Math.round((Date.now() / 1000 - v.ts) / 60);
    return `<li data-ghost="${esc(v.id)}"><div class="rn-time">${esc(g.rientro.replace(/^(\d+):/, (x, h) => String(+h % 24).padStart(2, '0') + ':'))}</div>
      ${C.badge(v.line, '#7C3AED')}<div class="grow"><div class="title">ferma verso ${esc(g.cur[5])}</div>
      <div class="muted"><b>${esc(g.name)}</b> · spenta da ${min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min'}${g.dep ? ' · ' + esc(depotName(g.dep)) : ''}</div></div>
      <div class="when"><span class="rn-car">${esc(v.vehicleNo)}</span></div></li>`;
  };
  el.innerHTML = `
    ${ghosts.length ? `<div class="section-title">🟣 Vetture da recuperare (${ghosts.length})</div>
      <p class="muted">Spente fuori deposito con la tabella finita o che finisce entro 2 ore. L'orario è il rientro previsto.</p>
      <ul class="rows">${ghosts.map(ghostRow).join('')}</ul>` : ''}
    <div class="dir-tabs">
      <button class="dir-tab${out ? '' : ' on'}" data-tab="rientri"><b>Rientri</b></button>
      <button class="dir-tab${out ? ' on' : ''}" data-tab="uscite"><b>Uscite</b></button>
    </div>
    <p class="sub"><b>${dayLabel(view.date)}</b> · ${out ? 'Uscite dalla rimessa' : 'Rientri in rimessa'} ${view.from === 0 && view.to === 24 ? 'di tutta la giornata' : `tra le ${view.from} e le ${view.to}`}${view.line ? `, linea ${esc(view.line)}` : ''}${view.depot ? ', ' + esc(depotName(view.depot)) : ''}: ${pending.length} ${out ? 'ancora da uscire o in corso' : 'ancora da rientrare'}.</p>
    <form id="rnForm" class="rn-form">
      <select id="rnDate">${[todayISO(), ...(dayIndex || []).filter((d) => d > todayISO())].map((d) => `<option value="${d === todayISO() ? '' : d}"${(view.date || '') === (d === todayISO() ? '' : d) ? ' selected' : ''}>${dayLabel(d)}</option>`).join('')}</select>
      <input id="rnLine" value="${esc(view.line)}" placeholder="Linea (tutte)" autocomplete="off">
      <input id="rnPlace" value="${esc(view.place)}" placeholder="Capolinea (es. Mancini)" autocomplete="off">
      <select id="rnDepot"><option value="">Tutti i depositi</option>${[...depots].sort().map((d) => `<option value="${d}"${d === view.depot ? ' selected' : ''}>${esc(DEPOT_NAMES[d] || 'Deposito ' + d)}</option>`).join('')}</select>
      <select id="rnFrom">${opts(25, view.from)}</select><span>–</span><select id="rnTo">${opts(25, view.to)}</select>
      <button class="btn ghost" type="submit">Filtra</button>
      <button class="btn ghost" type="button" id="rnNow">Prossime 2 ore</button>
      <button class="btn ghost" type="button" id="rnAll">Tutto il giorno</button>
    </form>
    ${rows.length ? `<ul class="rows">${rows.map(row).join('')}</ul>` : '<p class="muted">Nessuna tabella in questa fascia.</p>'}
    <p class="muted">L'orario è ${out ? "l'uscita dalla rimessa" : 'il rientro in rimessa'}: preciso quando c'è il collegamento, altrimenti calcolato col tempo deposito-capolinea (con ≈ quando è una stima dalla distanza).${out ? '' : ' Il bus spesso rientra prima se arriva in anticipo (vedi stato in diretta).'}
      Il deposito delle linee senza collegamento è dedotto dalle altre tabelle della stessa linea.</p>`;
  el.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { view.tab = b.dataset.tab; store('rientriVista2', view); render(); }; });
  document.getElementById('rnForm').onsubmit = (e) => {
    e.preventDefault();
    view = { ...view, date: document.getElementById('rnDate').value, line: document.getElementById('rnLine').value.trim(), depot: document.getElementById('rnDepot').value, place: document.getElementById('rnPlace').value.trim(),
      from: +document.getElementById('rnFrom').value, to: +document.getElementById('rnTo').value };
    store('rientriVista2', view);
    render();
  };
  document.getElementById('rnNow').onclick = () => {
    const h = new Date().getHours();
    view = { ...view, date: '', from: h, to: Math.min(24, h + 2), place: document.getElementById('rnPlace').value.trim(), line: document.getElementById('rnLine').value.trim() };
    store('rientriVista2', view);
    render();
  };
  document.getElementById('rnAll').onclick = () => { view = { ...view, from: 0, to: 24 }; store('rientriVista2', view); render(); };
  document.getElementById('rnDate').onchange = (e) => { view = { ...view, date: e.target.value }; store('rientriVista2', view); render(); };
  el.querySelectorAll('li[data-b]').forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest('[data-tab-open]')) { openTabella(li.dataset.b); return; }
      const v = li.dataset.v && C.vehicleById(li.dataset.v);
      if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } else openTabella(li.dataset.b);
    };
  });
  el.querySelectorAll('li[data-ghost]').forEach((li) => {
    li.onclick = () => { const v = C.vehicleById(li.dataset.ghost); if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 16); } };
  });
}

// ---------------- tabella completa (tutte le corse della giornata) ----------------
export const blocksNow = () => blocks || {};
export async function openTabella(b, highlightTrip) {
  await loadBlocks();
  const trips = tripsOf(b);
  if (!trips) { C.toast && C.toast('Tabella non trovata nei dati di oggi'); return; }
  const dayR = blocks[b] ? rim : (Object.values(dayCache).find((d) => d.blocks && d.blocks[b]) || {}).rimessa;
  const v = vehiclesByBlock().get(b);
  const cur = highlightTrip || (v && v.tripId);
  const runs = runsOf(trips);
  const dep = depotOf(trips, runs[0]);
  const up = (x) => String(x || '').toUpperCase();
  const cells = [];
  trips.forEach((t, i) => {
    const prev = trips[i - 1];
    if (prev && mins(t[1]) - mins(prev[2]) >= 60) cells.push(`<div class="tb-cell tb-pause">PAUSA ${esc(prev[2])} – ${esc(t[1])}</div>`);
    const coll = isColl(t[3]) || ((i === 0 || i === trips.length - 1) && DEPOT_STOPS.has(t[i === 0 ? 4 : 5]));
    const prevColl = prev && (isColl(prev[3]) || (i - 1 === 0 && DEPOT_STOPS.has(prev[4])));
    const newLine = !prev || prev[3] !== t[3] || !!prevColl !== !!coll;
    cells.push(`${newLine ? `<div class="tb-line">${esc(t[3])}${coll ? ' <small>collegamento</small>' : ''}</div>` : ''}
      <div class="tb-cell${coll ? ' tb-coll' : ''}${t[0] === cur ? ' tb-cur' : ''}"><b>${esc(h24(t[1]))} ${esc(up(t[4]))}</b><span>${esc(h24(t[2]))} ${esc(up(t[5]))}</span></div>`);
  });
  const lines = [...new Set(trips.map((t) => t[3]).filter((l) => !isColl(l)))];
  const name = tabName(b);
  const m = name.match(/^(.+?)\/(\d+)$/);
  const first = runs[0], last = runs[runs.length - 1];
  const svc = trips.filter((t, i) => !(isColl(t[3]) || ((i === 0 || i === trips.length - 1) && DEPOT_STOPS.has(t[i === 0 ? 4 : 5]))));
  const capAnd = svc.length ? svc[0][4] : first.startPlace, capRit = svc.length ? svc[svc.length - 1][5] : last.endPlace;
  const rmF = rimessaRun(trips, first, dayR), rmL = rimessaRun(trips, last, dayR);
  const outT = tilde(rmF.outF) + hmS(rmF.out), inT = tilde(rmL.inF) + hmS(rmL.inn);
  const totalMin = trips.reduce((a, t) => a + mins(t[2]) - mins(t[1]), 0);
  C.openSheet(`
    <div class="tb-sheet">
      <div class="tb-box">
        <div class="tb-title">${m ? `Tab. N° <big>${esc(m[2])}</big> Linea <big>${esc(m[1])}</big>` : `<big>${esc(name)}</big> · Linea <big>${esc(lines.join(' › '))}</big>`} ${dep ? `<span class="tb-dep">${esc(dep)}</span>` : ''}</div>
        <div class="tb-grid">
          <span>Cap. And.: <b>${esc(up(capAnd))}</b></span><span>Cap. Rit.: <b>${esc(up(capRit))}</b></span>
          <span>Dep. appart.: <b>${esc(depotName(dep) || '—')}</b></span><span>${v ? `Vettura: <b>${esc(v.vehicleNo)}</b>` : `Corse: <b>${trips.length}</b>`}</span>
          <span class="tb-big">Uscita: ${esc(h24(outT))}</span><span class="tb-big">Rientro: ${esc(h24(inT))}</span>
          <span>Ore di guida in linea: <b>${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}</b></span><span>Codice: <b>${esc(b.replace(/^0#/, ''))}</b></span>
        </div>
      </div>
      <div class="tb-cols">${cells.join('')}</div>
    </div>
    <p class="muted">Orari ufficiali ATAC di oggi. In grigio i collegamenti col deposito; evidenziata la corsa in corso.</p>
    <div class="actions"><button class="btn ghost" id="tbName">✎ Nome tabella</button><button class="btn ghost" id="tbIpo">≈ Ipotesi numero</button>${C.favBtn ? C.favBtn({ type: 'tabella', b, key: nameKey(trips), label: name }) : ''}${v ? '<button class="btn" id="tbVeh">Vedi la vettura</button>' : ''}</div>
  `, { type: 'tabella', b }, { tall: true });
  document.getElementById('tbIpo').onclick = () => C.toast(ipotesi(b), 9000);
  document.getElementById('tbName').onclick = () => {
    const val = window.prompt('Nome della tabella (es. 913/5). Lascia vuoto per togliere.', (names[nameKey(trips)] || names[plainKey(nameKey(trips))] || ''));
    if (val !== null) { setTabName(b, val.trim()); openTabella(b, highlightTrip); }
  };
  const vb = document.getElementById('tbVeh');
  if (vb) vb.onclick = () => { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); };
  const curRow = document.querySelector('.tb-cols .tb-cur');
  if (curRow) setTimeout(() => curRow.scrollIntoView({ block: 'center' }), 100);
}

export function onVehicles() { if (C && C.state.view?.type === 'rientri') render(); }

// Riga per la scheda del mezzo
export async function tabellaText(v) {
  const b = blockOf(v.tripId);
  if (!b) return v.source === 'gps' && !v.tripId ? 'Nessuna corsa assegnata: fuori servizio o verso il deposito' : '';
  await loadBlocks();
  const trips = blocks[b];
  if (!trips) return esc(`Tab. ${b.replace(/^0#/, '')}`);
  const i = trips.findIndex((t) => t[0] === v.tripId);
  const head = `<b>${esc(tabName(b))}</b> <button class="link-btn" data-tabname="${esc(b)}" aria-label="Rinomina tabella">✎</button> <button class="link-btn" data-tabopen="${esc(b)}" data-trip="${esc(v.tripId)}">apri tabella</button>${i >= 0 ? ` · corsa ${i + 1} di ${trips.length}` : ''} · `;
  if (i >= 0 && isColl(trips[i][3])) return head + `<b class="late">collegamento ${esc(trips[i][3])} → ${esc(trips[i][5])}</b>`;
  const run = runsOf(trips).find((e) => i >= e.first && i <= e.idx);
  if (!run) return head + `fine servizio alle ${trips[trips.length - 1][2]}`;
  const dest = run.after ? ` (poi ${esc(run.after[3])} → ${esc(run.after[5])})` : '';
  return head + (i === run.idx
    ? `<b class="late">ultima corsa: poi rientra in deposito alle ${run.end}${dest}</b>`
    : `rientro alle ${run.end} a ${esc(run.endPlace)}${dest}`);
}
// pulsante ✎ nella scheda: assegna il vostro nome alla tabella (es. 913/5)
document.addEventListener('click', (e) => {
  const op = e.target.closest && e.target.closest('[data-tabopen]');
  if (op) { openTabella(op.dataset.tabopen, op.dataset.trip); return; }
  const btn = e.target.closest && e.target.closest('[data-tabname]');
  if (!btn) return;
  const b = btn.dataset.tabname;
  const val = window.prompt('Nome della tabella (es. 913/5). Lascia vuoto per togliere.', (names[nameKey(blocks[b])] || names[plainKey(nameKey(blocks[b]))] || ''));
  if (val === null) return;
  setTabName(b, val.trim());
  btn.previousElementSibling.textContent = tabName(b);
});

// IPOTESI del numero di tabella (regola non ancora sicura, da confrontare col numero vero):
// le tabelle di una linea, in ordine di codice ATAC tra quelle che girano oggi, numerate 1, 2, 3…
// Variante: senza i giri corti che fanno solo la mattina (rimessa-rimessa).
function mainLine(trips) {
  const c = {};
  let last = '';
  for (const t of trips) if (!isColl(t[3])) { c[t[3]] = (c[t[3]] || 0) + 1; last = t[3]; }
  // a parità vince la linea su cui il giro finisce
  return Object.keys(c).sort((a, b) => c[b] - c[a] || (b === last) - (a === last))[0] || '';
}
const codeNum = (b) => parseInt(String(b).split('#').pop(), 10) || 0;
const shortMorning = (trips) => { const e = trips[trips.length - 1][2]; return parseInt(e, 10) < 14 && parseInt(trips[0][1], 10) < 10; };
export function ipotesi(b) {
  const all = blocks || {}, trips = all[b];
  if (!trips) return 'Tabella non trovata';
  const L = mainLine(trips);
  const same = Object.keys(all).filter((k) => mainLine(all[k]) === L).sort((x, y) => codeNum(x) - codeNum(y));
  const n1 = same.indexOf(b) + 1;
  const noShort = same.filter((k) => k === b || !shortMorning(all[k]));
  const n2 = noShort.indexOf(b) + 1;
  let msg = `Ipotesi: ${L}/${n1}`;
  if (shortMorning(trips)) msg += ' (è un giro corto della mattina: potrebbe avere un numero a parte)';
  else if (n2 !== n1) msg += ` oppure ${L}/${n2} se i giri corti della mattina non si contano`;
  return msg + '. Confrontala col numero vero: se è diversa, dimmelo!';
}

// Vettura che non trasmette più. Due casi utili agli autisti:
//  "riprende": la tabella ha ancora servizio oltre le prossime 2 ore -> in sosta, potrebbe ripartire
//  "recupero": la tabella finisce entro 2 ore (o è già finita) ma la vettura non è in deposito -> da recuperare
// Non la mostro se era già in deposito (rientro col collegamento o arrivo alla fermata del deposito).
export function ghostInfo(v) {
  if (!blocks || !v.tripId || !String(v.tripId).includes('-')) return null;
  const b = String(v.tripId).replace(/-[^-]*$/, '');
  const trips = blocks[b];
  if (!trips) return null;
  const cur = trips.find((t) => t[0] === v.tripId);
  if (!cur) return null;
  const i = trips.indexOf(cur);
  if (DEPOT_STOPS.has(cur[5])) return null; // arrivata al deposito
  if (isColl(cur[3]) && i > 0 && !isColl(trips[i - 1][3])) return null; // collegamento verso il deposito
  const now = new Date();
  let N = now.getHours() * 60 + now.getMinutes();
  if (N < 240) N += 1440;
  const rientro = mins(trips[trips.length - 1][2]);
  const next = trips.slice(i + 1).find((t) => !isColl(t[3])) || null;
  const tipo = !next || rientro - N <= 120 ? 'recupero' : 'riprende';
  return { b, name: tabName(b), cur, next, rientro: trips[trips.length - 1][2], tipo, dep: depotOf(trips, runsOf(trips).slice(-1)[0]) };
}
