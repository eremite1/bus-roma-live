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
    const last = trips[trips.length - 1];
    const end = mins(last[2]);
    if (end < view.from * 60 || end > view.to * 60) continue;
    // una tabella può fare più linee nella giornata (es. 913 e poi G70): la filtro se ne contiene una
    const lines = [...new Set(trips.map((t) => String(t[3])))];
    const line = lines.length > 1 ? lines.join(' › ') : last[3];
    if (view.line && !lines.some((l) => l.toLowerCase() === view.line.toLowerCase())) continue;
    const start = mins(trips[0][1]);
    const v = vb.get(b);
    const state = end < now ? 'done' : start > now ? 'later' : 'on';
    rows.push({ b, line, end: last[2], endPlace: last[5], n: trips.length, start: trips[0][1], v, state });
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
        <div class="rn-time">${esc(r.end)}</div>
        ${C.badge(r.line, C.colorOf({ line: r.line.split(' ')[0] }))}
        <div class="grow"><div class="title">a ${esc(r.endPlace)}</div>
          <div class="muted">Tab. ${esc(r.b.replace(/^0#/, ''))} · ${r.n} corse dalle ${esc(r.start)}${r.state === 'done' ? ' · rientrata' : r.state === 'later' ? ' · non ancora uscita' : ''}</div></div>
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
  const last = trips[trips.length - 1];
  const isLast = i === trips.length - 1;
  return `Tab. ${b.replace(/^0#/, '')}${i >= 0 ? ` · corsa ${i + 1} di ${trips.length}` : ''} · `
    + (isLast ? `<b class="late">ultima corsa: poi rientra in deposito (${last[2]})</b>` : `fine servizio alle ${last[2]} a ${last[5]}`);
}
