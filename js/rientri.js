// RIENTRI IN DEPOSITO
// Per ogni tabella (turno macchina) di oggi guardo l'ultima corsa: se finisce nella fascia scelta,
// quella tabella rientra in deposito a quell'ora. La vettura si conosce appena la tabella è in servizio
// (il GPS dice quale corsa sta facendo ogni bus).

let C = null;
export function initRientri(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let blocks = null;
async function loadBlocks() {
  if (!blocks) {
    try { blocks = await (await fetch('data/blocks.json', { cache: 'no-cache' })).json(); } catch (e) { blocks = {}; }
  }
  return blocks;
}
const mins = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
// linee di collegamento deposito <-> capolinea (G07, G70, G06, G40…)
export const isColl = (line) => /^G\d+$/i.test(String(line || ''));

// Ogni volta che una serie di corse di servizio finisce (seguita da un collegamento o dalla fine della tabella)
// il bus rientra in deposito. Restituisce [{ first, idx, end, endPlace, line, coll, depot, colls }].
export function rientriOf(trips) {
  const out = [];
  let i = 0;
  while (i < trips.length) {
    while (i < trips.length && isColl(trips[i][3])) i++;
    if (i >= trips.length) break;
    const first = i;
    // la serie finisce prima di un collegamento oppure prima di una pausa lunga (oltre un'ora: il bus rientra)
    while (i + 1 < trips.length && !isColl(trips[i + 1][3]) && mins(trips[i + 1][1]) - mins(trips[i][2]) < 60) i++;
    const last = trips[i];
    let j = i + 1;
    while (j < trips.length && isColl(trips[j][3])) j++;
    const colls = trips.slice(i + 1, j);
    // il collegamento che va verso il deposito è il primo dopo il servizio
    const toDepot = colls[0];
    out.push({ first, idx: i, end: last[2], endPlace: last[5], line: last[3], coll: toDepot ? toDepot[3] : '', depot: toDepot ? toDepot[5] : '', colls: colls.length });
    i = j;
  }
  return out;
}
const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
export const blockOf = (tripId) => (tripId && tripId.includes('#') && tripId.includes('-') ? tripId.slice(0, tripId.lastIndexOf('-')) : '');

let view = { from: 9, to: 21, line: '' };
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
  const now = nowMins();
  const rows = [];
  for (const [b, trips] of Object.entries(blocks || {})) {
    if (!trips.length) continue;
    const lines = [...new Set(trips.map((t) => String(t[3])))];
    if (view.line && !lines.some((l) => l.toLowerCase() === view.line.toLowerCase())) continue;
    const v = vb.get(b);
    const ci = v ? trips.findIndex((t) => t[0] === v.tripId) : -1;
    for (const ev of rientriOf(trips)) {
      const endM = mins(ev.end);
      if (endM < view.from * 60 || endM > view.to * 60) continue;
      // in diretta: se il bus sta facendo l'ultima corsa uso il suo ritardo/anticipo reale
      let live = '', expected = null;
      if (v && ci === ev.idx) {
        const d = C.delayOf ? C.delayOf(v) : null;
        if (d != null) { expected = endM + d; live = d <= -1 ? `in anticipo di ${-d} min` : d >= 2 ? `in ritardo di ${d} min` : 'in orario'; }
        else live = 'sull\'ultima corsa';
      } else if (v && ci > ev.idx && ci <= ev.idx + ev.colls) live = 'sta rientrando ora';
      const runStart = mins(trips[ev.first][1]);
      const state = live ? 'on' : endM < now ? 'done' : runStart > now ? 'later' : 'on';
      rows.push({ b, line: ev.line, end: ev.end, expected, live, endPlace: ev.endPlace, depot: ev.depot, coll: ev.coll,
        n: ev.idx - ev.first + 1, start: trips[ev.first][1], v: state === 'done' ? null : v, state });
    }
  }
  rows.sort((a, b) => mins(a.end) - mins(b.end));
  const upcoming = rows.filter((r) => r.state !== 'done');
  const known = upcoming.filter((r) => r.v).length;
  el.innerHTML = `
    <h2>Rientri in deposito</h2>
    <p class="sub">Tabelle che finiscono il servizio tra le ${view.from} e le ${view.to} di oggi${view.line ? `, linea ${esc(view.line)}` : ''}: ${upcoming.length} ancora da rientrare, di cui ${known} con vettura già nota.</p>
    <form id="rnForm" class="rn-form">
      <input id="rnLine" value="${esc(view.line)}" placeholder="Linea (tutte)" autocomplete="off">
      <select id="rnFrom">${Array.from({ length: 25 }, (_, h) => `<option${h === view.from ? ' selected' : ''}>${h}</option>`).join('')}</select>
      <span>–</span>
      <select id="rnTo">${Array.from({ length: 25 }, (_, h) => `<option${h === view.to ? ' selected' : ''}>${h}</option>`).join('')}</select>
      <button class="btn ghost" type="submit">Filtra</button>
    </form>
    ${rows.length ? `<ul class="rows">${rows.map((r) => `<li class="rn-${r.state}" data-v="${r.v ? esc(r.v.id) : ''}">
        <div class="rn-time">${r.expected != null ? `<span class="rn-exp">${hm(r.expected)}</span><s>${esc(r.end)}</s>` : esc(r.end)}</div>
        ${C.badge(r.line, C.colorOf({ line: r.line.split(' ')[0] }))}
        <div class="grow"><div class="title">a ${esc(r.endPlace)}</div>
          <div class="muted">${r.depot ? `poi ${esc(r.coll)} → <b>${esc(r.depot)}</b> · ` : ''}Tab. ${esc(r.b.replace(/^0#/, ''))} · ${r.n} corse dalle ${esc(r.start)}${r.state === 'done' ? ' · rientrata' : r.state === 'later' ? ' · non ancora uscita' : ''}</div>
          ${r.live ? `<div class="rn-live">● ${esc(r.live)}</div>` : ''}</div>
        <div class="when">${r.v ? `<span class="rn-car">${esc(r.v.vehicleNo)}</span>` : r.state === 'on' ? '<span class="muted">vettura non vista</span>' : ''}</div>
      </li>`).join('')}</ul>` : '<p class="muted">Nessun rientro in questa fascia.</p>'}
    <p class="muted">Il numero di vettura compare quando la tabella è in servizio e il GPS ATAC la segnala. Tocca una riga con la vettura per vederla sulla mappa.</p>`;
  document.getElementById('rnForm').onsubmit = (e) => {
    e.preventDefault();
    view = { line: document.getElementById('rnLine').value.trim(), from: +document.getElementById('rnFrom').value, to: +document.getElementById('rnTo').value };
    render();
  };
  el.querySelectorAll('li[data-v]').forEach((li) => {
    if (!li.dataset.v) return;
    li.onclick = () => { const v = C.vehicleById(li.dataset.v); if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } };
  });
}

export function onVehicles() { if (C && C.state.view?.type === 'rientri') render(); }

// Riga per la scheda del mezzo: "Tab. 3741 · corsa 7 di 11 · fine servizio 13:04 → deposito"
export async function tabellaText(v) {
  const b = blockOf(v.tripId);
  if (!b) return v.source === 'gps' && !v.tripId ? 'Nessuna corsa assegnata: fuori servizio o verso il deposito' : '';
  await loadBlocks();
  const trips = blocks[b];
  if (!trips) return `Tab. ${b.replace(/^0#/, '')}`;
  const i = trips.findIndex((t) => t[0] === v.tripId);
  const head = `Tab. ${b.replace(/^0#/, '')}${i >= 0 ? ` · corsa ${i + 1} di ${trips.length}` : ''} · `;
  if (i >= 0 && isColl(trips[i][3])) return head + `<b class="late">collegamento ${esc(trips[i][3])} → ${esc(trips[i][5])}</b>`;
  const ev = rientriOf(trips).find((e) => i >= e.first && i <= e.idx);
  if (!ev) return head + `fine servizio alle ${trips[trips.length - 1][2]}`;
  const dest = ev.depot ? ` (poi ${esc(ev.coll)} → ${esc(ev.depot)})` : '';
  return head + (i === ev.idx
    ? `<b class="late">ultima corsa: poi rientra in deposito alle ${ev.end}${dest}</b>`
    : `rientro alle ${ev.end} a ${esc(ev.endPlace)}${dest}`);
}
