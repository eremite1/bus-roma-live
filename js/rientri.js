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
const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return v; };

// collegamenti deposito <-> capolinea
export const isColl = (line) => /^[A-Z]\d{2}$/.test(String(line || ''));
const DEPOT_NAMES = { G: 'Grottarossa', M: 'Magliana', P: 'Portonaccio', T: 'Tor Vergata', A: 'Prenestina' };

let blocks = null, depotPlace = {}, lineDepot = {}, names = {};
async function loadBlocks() {
  if (blocks) return blocks;
  try { blocks = await (await fetch('data/blocks.json', { cache: 'no-cache' })).json(); } catch (e) { blocks = {}; }
  try { names = await (await fetch('data/tabelle.json', { cache: 'no-cache' })).json(); } catch (e) { names = {}; }
  Object.assign(names, store('tabelleNomi') || {});
  // dove si trova ogni deposito: la fermata più frequente tra le estremità dei suoi collegamenti
  const count = {};
  for (const trips of Object.values(blocks)) for (const t of trips) {
    if (!isColl(t[3])) continue;
    const L = t[3][0];
    count[L] = count[L] || {};
    for (const p of [t[4], t[5]]) count[L][p] = (count[L][p] || 0) + 1;
  }
  for (const [L, c] of Object.entries(count)) depotPlace[L] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
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
function nameKey(trips) {
  const r = runsOf(trips)[0];
  return r ? `${r.firstLine}@${r.start}` : '';
}
export function tabName(b) {
  const trips = blocks && blocks[b];
  const n = trips && names[nameKey(trips)];
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
let view = { tab: 'rientri', from: 9, to: 21, line: '', depot: '', place: '', ...(store('rientriVista') || {}) };
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
let timer = null;

export async function openRientri() {
  C.openSheet('<div id="rnView"><div class="spinner">Carico le tabelle di oggi…</div></div>', { type: 'rientri' }, { tall: true });
  await loadBlocks();
  C.refreshAtac && C.refreshAtac(); // collega le vetture GPS alle corse anche quando il GPS non lo dice
  render();
  clearInterval(timer);
  timer = setInterval(() => { if (C.state.view?.type === 'rientri') render(); else clearInterval(timer); }, 30_000);
}

function vehiclesByBlock() {
  const map = new Map();
  for (const s of C.state.shown.values()) {
    const v = s.v;
    if (v.source !== 'gps') continue;
    const b = blockOf(v.tripId);
    if (b) map.set(b, v);
  }
  return map;
}

function render() {
  const el = document.getElementById('rnView');
  if (!el) return;
  const vb = vehiclesByBlock();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const out = view.tab === 'uscite';
  const rows = [];
  const depots = new Set();
  for (const [b, trips] of Object.entries(blocks || {})) {
    if (!trips.length) continue;
    const lines = [...new Set(trips.map((t) => String(t[3])).filter((l) => !isColl(l)))];
    if (view.line && !lines.some((l) => l.toLowerCase() === view.line.toLowerCase())) continue;
    const v = vb.get(b);
    const ci = v ? trips.findIndex((t) => t[0] === v.tripId) : -1;
    for (const run of runsOf(trips)) {
      const dep = depotOf(trips, run);
      if (dep) depots.add(dep);
      if (view.depot && dep !== view.depot) continue;
      const t = out ? mins(run.start) : mins(run.end);
      if (t < view.from * 60 || t > view.to * 60) continue;
      // filtro per capolinea (es. "mancini"): dove finisce il servizio (rientri) o dove comincia (uscite)
      if (view.place && !norm(out ? run.startPlace : run.endPlace).includes(norm(view.place))) continue;
      let live = '', expected = null, state;
      if (out) {
        state = t < now ? 'done' : 'later';
        if (v && ci >= run.first && ci <= run.idx) { state = 'on'; live = 'in servizio'; }
      } else {
        if (v && ci === run.idx) {
          const d = C.delayOf ? C.delayOf(v) : null;
          if (d != null) { expected = t + d; live = d <= -1 ? `in anticipo di ${-d} min` : d >= 2 ? `in ritardo di ${d} min` : 'in orario'; } else live = "sull'ultima corsa";
        } else if (v && ci > run.idx && ci <= run.idx + run.colls) live = 'sta rientrando ora';
        state = live ? 'on' : t < now ? 'done' : mins(run.start) > now ? 'later' : 'on';
      }
      rows.push({ b, run, t, dep, live, expected, state, v: state === 'done' || (out && state === 'later') ? null : v,
        line: lines.length > 1 ? lines.join(' › ') : run.line });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const pending = rows.filter((r) => r.state !== 'done');
  const row = (r) => {
    const R = r.run;
    const time = out ? R.start : R.end;
    const place = out ? R.startPlace : R.endPlace;
    const coll = out ? R.before : R.after;
    const collTxt = coll
      ? (out ? `esce alle <b>${esc(coll[1])}</b> con ${esc(coll[3])} da ${esc(coll[4])}` : `poi ${esc(coll[3])} → ${esc(coll[5])}`)
      : 'senza collegamento';
    return `<li class="rn-${r.state}" data-b="${esc(r.b)}" data-v="${r.v ? esc(r.v.id) : ''}">
      <div class="rn-time">${r.expected != null ? `<span class="rn-exp">${hm(r.expected)}</span><s>${esc(time)}</s>` : esc(time)}</div>
      ${C.badge(r.line, C.colorOf({ line: r.line.split(' ')[0] }))}
      <div class="grow"><div class="title">${out ? 'da' : 'a'} ${esc(place)}</div>
        <div class="muted"><b>${esc(tabName(r.b))}</b> · ${collTxt}${r.dep ? ' · ' + esc(depotName(r.dep)) : ''}${r.state === 'done' ? (out ? ' · uscita' : ' · rientrata') : ''}</div>
        ${r.live ? `<div class="rn-live">● ${esc(r.live)}</div>` : ''}</div>
      <div class="when">${r.v ? `<span class="rn-car">${esc(r.v.vehicleNo)}</span>` : !out && r.state === 'on' ? '<span class="muted">vettura non vista</span>' : ''}
        <button class="link-btn" data-tab-open>tabella</button></div></li>`;
  };
  const opts = (n, sel) => Array.from({ length: n }, (_, h) => `<option${h === sel ? ' selected' : ''}>${h}</option>`).join('');
  el.innerHTML = `
    <div class="dir-tabs">
      <button class="dir-tab${out ? '' : ' on'}" data-tab="rientri"><b>Rientri</b></button>
      <button class="dir-tab${out ? ' on' : ''}" data-tab="uscite"><b>Uscite</b></button>
    </div>
    <p class="sub">${out ? 'Inizio servizio' : 'Fine servizio'} tra le ${view.from} e le ${view.to}${view.line ? `, linea ${esc(view.line)}` : ''}${view.depot ? ', ' + esc(depotName(view.depot)) : ''}: ${pending.length} ${out ? 'ancora da uscire o in corso' : 'ancora da rientrare'}.</p>
    <form id="rnForm" class="rn-form">
      <input id="rnLine" value="${esc(view.line)}" placeholder="Linea (tutte)" autocomplete="off">
      <input id="rnPlace" value="${esc(view.place)}" placeholder="Capolinea (es. Mancini)" autocomplete="off">
      <select id="rnDepot"><option value="">Tutti i depositi</option>${[...depots].sort().map((d) => `<option value="${d}"${d === view.depot ? ' selected' : ''}>${esc(DEPOT_NAMES[d] || 'Deposito ' + d)}</option>`).join('')}</select>
      <select id="rnFrom">${opts(25, view.from)}</select><span>–</span><select id="rnTo">${opts(25, view.to)}</select>
      <button class="btn ghost" type="submit">Filtra</button>
      <button class="btn ghost" type="button" id="rnNow">Prossime 2 ore</button>
    </form>
    ${rows.length ? `<ul class="rows">${rows.map(row).join('')}</ul>` : '<p class="muted">Nessuna tabella in questa fascia.</p>'}
    <p class="muted">${out ? "L'orario è l'inizio della prima corsa; se c'è un collegamento è indicata anche l'ora di uscita dal deposito." : "L'orario è la fine dell'ultima corsa di servizio; il bus spesso rientra prima se arriva in anticipo (vedi stato in diretta)."}
      Il deposito delle linee senza collegamento è dedotto dalle altre tabelle della stessa linea.</p>`;
  el.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { view.tab = b.dataset.tab; store('rientriVista', view); render(); }; });
  document.getElementById('rnForm').onsubmit = (e) => {
    e.preventDefault();
    view = { ...view, line: document.getElementById('rnLine').value.trim(), depot: document.getElementById('rnDepot').value, place: document.getElementById('rnPlace').value.trim(),
      from: +document.getElementById('rnFrom').value, to: +document.getElementById('rnTo').value };
    store('rientriVista', view);
    render();
  };
  document.getElementById('rnNow').onclick = () => {
    const h = new Date().getHours();
    view = { ...view, from: h, to: Math.min(24, h + 2), place: document.getElementById('rnPlace').value.trim(), line: document.getElementById('rnLine').value.trim() };
    store('rientriVista', view);
    render();
  };
  el.querySelectorAll('li[data-b]').forEach((li) => {
    li.onclick = (e) => {
      if (e.target.closest('[data-tab-open]')) { openTabella(li.dataset.b); return; }
      const v = li.dataset.v && C.vehicleById(li.dataset.v);
      if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } else openTabella(li.dataset.b);
    };
  });
}

// ---------------- tabella completa (tutte le corse della giornata) ----------------
export async function openTabella(b, highlightTrip) {
  await loadBlocks();
  const trips = blocks[b];
  if (!trips) { C.toast && C.toast('Tabella non trovata nei dati di oggi'); return; }
  const v = vehiclesByBlock().get(b);
  const cur = highlightTrip || (v && v.tripId);
  const runs = runsOf(trips);
  const dep = depotOf(trips, runs[0]);
  const rowsHtml = [];
  trips.forEach((t, i) => {
    const prev = trips[i - 1];
    if (prev && mins(t[1]) - mins(prev[2]) >= 60) {
      rowsHtml.push(`<tr class="tb-pause"><td colspan="5">pausa / in deposito dalle ${esc(prev[2])} alle ${esc(t[1])}</td></tr>`);
    }
    const coll = isColl(t[3]);
    rowsHtml.push(`<tr class="${coll ? 'tb-coll' : ''}${t[0] === cur ? ' tb-cur' : ''}">
      <td class="tb-n">${i + 1}</td><td class="tb-l">${esc(t[3])}</td>
      <td><b>${esc(t[1])}</b><span>${esc(t[4])}</span></td>
      <td><b>${esc(t[2])}</b><span>${esc(t[5])}</span></td>
      <td class="tb-d">${mins(t[2]) - mins(t[1])}′</td></tr>`);
  });
  const lines = [...new Set(trips.map((t) => t[3]).filter((l) => !isColl(l)))];
  C.openSheet(`
    <div class="head"><span class="badge big" style="background:#1B1D22">${esc(tabName(b).replace(/^Tab\. /, ''))}</span>
      <div><h2 style="margin:0">Tabella ${esc(tabName(b).replace(/^Tab\. /, ""))}</h2><div class="muted">${esc(lines.join(' › '))}${dep ? ' · ' + esc(depotName(dep)) : ''}${v ? ' · vettura <b>' + esc(v.vehicleNo) + '</b>' : ''}</div></div></div>
    <div class="facts">${runs.map((r) => `<span>Uscita <b>${esc(r.before ? r.before[1] : r.start)}</b> · rientro <b>${esc(r.after ? r.after[2] : r.end)}</b></span>`).join('')}<span>${trips.length} corse</span></div>
    <table class="tabella"><thead><tr><th>#</th><th>Linea</th><th>Partenza</th><th>Arrivo</th><th></th></tr></thead><tbody>${rowsHtml.join('')}</tbody></table>
    <p class="muted">In corsivo i collegamenti col deposito. Orari ufficiali ATAC di oggi.</p>
    <div class="actions"><button class="btn ghost" id="tbName">✎ Nome tabella</button>${v ? '<button class="btn" id="tbVeh">Vedi la vettura</button>' : ''}</div>
  `, { type: 'tabella', b }, { tall: true });
  document.getElementById('tbName').onclick = () => {
    const val = window.prompt('Nome della tabella (es. 913/5). Lascia vuoto per togliere.', names[nameKey(trips)] || '');
    if (val !== null) { setTabName(b, val.trim()); openTabella(b, highlightTrip); }
  };
  const vb = document.getElementById('tbVeh');
  if (vb) vb.onclick = () => { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); };
  const curRow = document.querySelector('.tabella .tb-cur');
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
  const val = window.prompt('Nome della tabella (es. 913/5). Lascia vuoto per togliere.', names[nameKey(blocks[b])] || '');
  if (val === null) return;
  setTabName(b, val.trim());
  btn.previousElementSibling.textContent = tabName(b);
});
