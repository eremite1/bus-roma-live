// PREFERITI (linee, tabelle, vetture, turni) e "IL MIO TURNO"
// Il turno: scrivi linea, orario di montata e di smontata; cerco nelle tabelle di oggi quella che
// fa una corsa a quell'ora e finisce a quell'ora, e dico quale vettura la sta facendo adesso.

import { loadBlocks, blocksNow, vehiclesByBlock, nameKey, tabName, openTabella, isColl, depotName } from './rientri.js';

let C = null;
export function initPreferiti(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const h24 = (t) => String(t).replace(/^(\d+):/, (x, h) => String(+h % 24).padStart(2, '0') + ':');
const ls = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return v; };

// ---------------- preferiti ----------------
const idOf = (f) => f.type === 'linea' ? 'L:' + f.line.toLowerCase() : f.type === 'vettura' ? 'V:' + f.no
  : f.type === 'tabella' ? 'T:' + (f.key || f.b) : 'U:' + (f.line || '').toLowerCase() + '@' + f.on + '-' + f.off;
const list = () => ls('preferiti') || [];
const isFav = (f) => list().some((x) => idOf(x) === idOf(f));
function toggle(f) {
  let l = list();
  if (isFav(f)) l = l.filter((x) => idOf(x) !== idOf(f)); else l.push(f);
  ls('preferiti', l);
  return isFav(f);
}
const label = (on) => on ? '★ Nei preferiti' : '☆ Aggiungi ai preferiti';
export function favBtn(f) {
  return `<button class="btn ghost fav-btn${isFav(f) ? ' on' : ''}" data-fav="${esc(JSON.stringify(f))}">${label(isFav(f))}</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-fav]');
  if (!b) return;
  const on = toggle(JSON.parse(b.dataset.fav));
  b.classList.toggle('on', on);
  b.textContent = label(on);
  C && C.toast && C.toast(on ? 'Aggiunto ai preferiti' : 'Tolto dai preferiti');
});

const sameNo = (a, b) => String(a).replace(/\D/g, '') === String(b).replace(/\D/g, '') && /\d/.test(String(b));
const liveVehicles = () => [...C.state.shown.values()].map((s) => s.v);
const findBlock = (f) => {
  const bl = blocksNow();
  if (f.key) for (const [b, trips] of Object.entries(bl)) if (nameKey(trips) === f.key) return b;
  return bl[f.b] ? f.b : '';
};

let timer = null;
export async function openPreferiti() {
  C.openSheet('<div id="pfView"><div class="spinner">Carico i preferiti…</div></div>', { type: 'preferiti' }, { tall: true });
  await loadBlocks();
  C.refreshAtac && C.refreshAtac();
  renderPref();
  clearInterval(timer);
  timer = setInterval(() => { if (C.state.view?.type === 'preferiti') renderPref(); else clearInterval(timer); }, 30_000);
}

function renderPref() {
  const el = document.getElementById('pfView');
  if (!el) return;
  const favs = list();
  const vs = liveVehicles();
  const vb = vehiclesByBlock();
  const rows = favs.map((f, i) => {
    let icon = '', title = '', sub = '';
    if (f.type === 'linea') {
      const n = vs.filter((v) => String(v.line).toLowerCase() === f.line.toLowerCase()).length;
      icon = '🚌'; title = `Linea ${esc(f.line)}`; sub = n ? `${n} ${n === 1 ? 'mezzo' : 'mezzi'} in viaggio ora` : 'nessun mezzo in viaggio ora';
    } else if (f.type === 'vettura') {
      const v = vs.find((x) => x.source === 'gps' && sameNo(x.vehicleNo, f.no));
      icon = '🔢'; title = `Vettura ${esc(f.no)}`;
      sub = v ? `in servizio sulla <b>${esc(v.line)}</b>${v.headsign ? ' verso ' + esc(v.headsign) : ''}` : 'non in servizio ora (o GPS spento)';
    } else if (f.type === 'tabella') {
      const b = findBlock(f), v = b && vb.get(b);
      icon = '📋'; title = esc(b ? tabName(b) : f.label || 'Tabella');
      sub = !b ? 'non presente negli orari di oggi' : v ? `vettura <b>${esc(v.vehicleNo)}</b> · ${esc(v.line)}${v.headsign ? ' verso ' + esc(v.headsign) : ''}` : 'vettura non ancora in servizio';
    } else {
      const tmm = TAB_RE.exec(f.line || '');
      const best = tmm ? (() => { const w = `${tmm[1]}/${+tmm[2]}`.toLowerCase(); const b = Object.keys(blocksNow()).find((k) => tabName(k).toLowerCase() === w); return b ? { b } : null; })() : findTurno(f.line, f.on, f.off)[0];
      const v = best && vb.get(best.b);
      icon = '🕑'; title = `Turno ${f.line ? esc(f.line) + ' ' : ''}${esc(f.on || '')}${f.off ? ' – ' + esc(f.off) : ''}`;
      sub = !best ? 'nessuna tabella trovata oggi' : `${esc(tabName(best.b))} · ${v ? `vettura <b>${esc(v.vehicleNo)}</b>` : 'vettura non ancora in servizio'}`;
    }
    return `<li class="pf-row"><button class="pf-open" data-i="${i}"><span class="pf-ico">${icon}</span><span><b>${title}</b><small>${sub}</small></span></button>
      <button class="pf-del" data-del="${i}" aria-label="Togli dai preferiti">✕</button></li>`;
  }).join('');
  el.innerHTML = `<h2>★ Preferiti</h2>
    ${rows ? `<ul class="pf-list">${rows}</ul>` : `<p class="sub">Nessun preferito. Usa <b>☆ Aggiungi ai preferiti</b> nella scheda di una linea, di una vettura o di una tabella, oppure salva il tuo turno.</p>`}
    <form class="pf-add" id="pfVeh"><input id="pfVehNo" inputmode="numeric" placeholder="Numero vettura (es. 4512)" aria-label="Numero vettura"><button class="btn ghost" type="submit">+ Vettura</button></form>
    <div class="actions"><button class="btn" id="pfTurno">🕑 Trova il mio turno</button></div>
    <p class="muted">I preferiti restano salvati su questo telefono. Aggiornamento ogni 30 secondi.</p>`;
  document.getElementById('pfVeh').onsubmit = (e) => {
    e.preventDefault();
    const no = document.getElementById('pfVehNo').value.trim();
    if (!no) return;
    if (!isFav({ type: 'vettura', no })) toggle({ type: 'vettura', no });
    renderPref();
  };
  document.getElementById('pfTurno').onclick = () => openTurno();
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { const l = list(); l.splice(+b.dataset.del, 1); ls('preferiti', l); renderPref(); });
  el.querySelectorAll('.pf-open').forEach((b) => b.onclick = () => {
    const f = favs[+b.dataset.i];
    if (f.type === 'linea') C.showLine(f.line);
    else if (f.type === 'vettura') {
      const v = liveVehicles().find((x) => x.source === 'gps' && sameNo(x.vehicleNo, f.no));
      if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } else C.toast('La vettura ' + f.no + ' ora non è in servizio');
    } else if (f.type === 'tabella') { const blk = findBlock(f); if (blk) openTabella(blk); else C.toast('Tabella non presente negli orari di oggi'); }
    else openTurno(f);
  });
}

// ---------------- il mio turno ----------------
// Punteggio di ogni tabella: quanto la montata è vicina alla partenza di una corsa e la smontata
// all'arrivo di una corsa (minuti di differenza). Vince il punteggio più basso.
export function findTurno(line, on, off) {
  const M = mins(on);
  const hasOff = !!off;
  let S = hasOff ? mins(off) : M;
  if (hasOff && S <= M) S += 1440; // smontata dopo mezzanotte
  const L = String(line || '').trim().toLowerCase();
  const out = [];
  for (const [b, trips] of Object.entries(blocksNow())) {
    if (!trips.length) continue;
    const svc = trips.filter((t) => !isColl(t[3]));
    if (L && !svc.some((t) => String(t[3]).toLowerCase() === L)) continue;
    const first = mins(trips[0][1]), last = mins(trips[trips.length - 1][2]);
    if (first > M + 15 || last < (hasOff ? S - 15 : M)) continue; // la tabella deve essere in giro sia alla montata sia alla smontata
    const cand = L ? trips.filter((t) => isColl(t[3]) || String(t[3]).toLowerCase() === L) : trips;
    let dm = 1e9, tm = null, ds = 1e9, tsm = null;
    for (const t of cand) {
      const d = Math.abs(mins(t[1]) - M);
      if (d < dm) { dm = d; tm = t; }
    }
    if (hasOff) for (const t of trips) {
      const d = Math.abs(mins(t[2]) - S);
      if (d < ds) { ds = d; tsm = t; }
    }
    // montata a metà corsa (cambio in linea): conta la corsa in corso
    const inCorso = trips.find((t) => mins(t[1]) <= M && mins(t[2]) > M);
    if (!hasOff) ds = 0;
    out.push({ b, score: dm + ds, dm, ds, tm, ts: tsm, inCorso, trips });
  }
  return out.sort((a, b) => a.score - b.score).filter((r, i) => i < 3 && r.score <= 60);
}

let turnoTimer = null;
export async function openTurno(saved) {
  const last = saved || ls('turnoUltimo') || {};
  C.openSheet(`<h2>🕑 Il mio turno</h2>
    <p class="sub">Scrivi la linea e l'orario di montata (la smontata aiuta ma non serve), oppure direttamente la tabella, es. <b>80-1</b>: trovo la vettura che la sta facendo.</p>
    <form id="tuForm" class="tu-form">
      <label>Linea <input id="tuLine" value="${esc(last.line || '')}" placeholder="es. 913 oppure 80-1" autocomplete="off"></label>
      <label>Montata <input id="tuOn" type="time" value="${esc(last.on || '')}"></label>
      <label>Smontata <input id="tuOff" type="time" value="${esc(last.off || '')}"></label>
      <button class="btn" type="submit">Cerca</button>
    </form>
    <div id="tuRes"></div>`, { type: 'turno' }, { tall: true });
  await loadBlocks();
  C.refreshAtac && C.refreshAtac();
  const run = () => {
    const q = { type: 'turno', line: document.getElementById('tuLine').value.trim(), on: document.getElementById('tuOn').value, off: document.getElementById('tuOff').value };
    if (!q.on && !TAB_RE.test(q.line)) { C.toast("Scrivi almeno l'orario di montata, oppure la tabella (es. 80-1)"); return; }
    ls('turnoUltimo', q);
    renderTurno(q);
  };
  document.getElementById('tuForm').onsubmit = (e) => { e.preventDefault(); run(); };
  if (last.on || TAB_RE.test(last.line || '')) run();
  clearInterval(turnoTimer);
  turnoTimer = setInterval(() => { if (C.state.view?.type === 'turno' && document.getElementById('tuRes')?.dataset.q) renderTurno(JSON.parse(document.getElementById('tuRes').dataset.q)); else if (C.state.view?.type !== 'turno') clearInterval(turnoTimer); }, 30_000);
}

const TAB_RE = /^\s*([A-Za-z]?\d+[A-Za-z]?)\s*[-\/]\s*(\d+)\s*$/;

// ricerca per numero di tabella: solo per le tabelle col numero CONFERMATO
function renderTabella(el, q, m) {
  const want = `${m[1]}/${+m[2]}`.toLowerCase();
  const bl = blocksNow();
  const found = Object.keys(bl).filter((b) => tabName(b).toLowerCase() === want);
  const vb = vehiclesByBlock();
  if (!found.length) {
    el.innerHTML = `<p class="sub">La tabella <b>${esc(want)}</b> non ha ancora un numero confermato (oppure oggi non gira). Per ora cerca con linea e orario di montata.</p>`;
    return;
  }
  const M = q.on ? mins(q.on) : null;
  el.innerHTML = found.map((b) => {
    const trips = bl[b], v = vb.get(b);
    const at = M == null ? null : (trips.find((t) => mins(t[1]) <= M && mins(t[2]) > M) || trips.find((t) => mins(t[1]) >= M));
    return `<div class="tu-card best">
      <div class="tu-head"><b>${esc(tabName(b))}</b><span>${esc([...new Set(trips.map((t) => t[3]).filter((l) => !isColl(l)))].join(' › '))}</span></div>
      <div>Uscita ${esc(h24(trips[0][1]))} · rientro ${esc(h24(trips[trips.length - 1][2]))}</div>
      ${at ? `<div>Alle ${esc(q.on)}: corsa ${esc(h24(at[1]))} ${esc(at[4])} → ${esc(at[5])}</div>` : ''}
      <div class="tu-vline">${v ? `<b class="tu-veh">Vettura ${esc(v.vehicleNo)}</b> · ora sulla ${esc(v.line)}${v.headsign ? ' verso ' + esc(v.headsign) : ''}` : 'Vettura non visibile ora (non ancora uscita o GPS spento)'}</div>
      <div class="actions">${v ? `<button class="btn" data-tuveh="${esc(b)}">Dov'è adesso</button>` : ''}<button class="btn ghost" data-tutab="${esc(b)}">Apri tabella</button>${favBtn({ type: 'tabella', b, key: nameKey(trips), label: tabName(b) })}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-tuveh]').forEach((x) => x.onclick = () => { const v = vb.get(x.dataset.tuveh); if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } });
  el.querySelectorAll('[data-tutab]').forEach((x) => x.onclick = () => openTabella(x.dataset.tutab));
}

function renderTurno(q) {
  const el = document.getElementById('tuRes');
  if (!el) return;
  el.dataset.q = JSON.stringify(q);
  const tm0 = TAB_RE.exec(q.line || '');
  if (tm0) return renderTabella(el, q, tm0);
  const res = findTurno(q.line, q.on, q.off);
  const vb = vehiclesByBlock();
  if (!res.length) {
    el.innerHTML = `<p class="sub">Nessuna tabella di oggi${q.line ? ' sulla ' + esc(q.line) : ''} corrisponde a montata ${esc(q.on)}${q.off ? ' e smontata ' + esc(q.off) : ''}. Controlla linea e orari${q.line ? ', oppure prova senza linea' : ''}.</p>`;
    return;
  }
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  el.innerHTML = (res.length > 1 && res[0].score === res[1].score ? '<p class="muted">Più tabelle corrispondono: scegli la tua.</p>' : '') +
    res.map((r, i) => {
      const v = vb.get(r.b);
      const tm = r.dm <= 3 || !r.inCorso ? r.tm : r.inCorso;
      const mont = r.dm <= 3
        ? `parte alle <b>${esc(h24(tm[1]))}</b> da ${esc(tm[4])} → ${esc(tm[5])}`
        : r.inCorso ? `cambio in linea: alle ${esc(q.on)} è sulla corsa ${esc(h24(r.inCorso[1]))} ${esc(r.inCorso[4])} → ${esc(r.inCorso[5])}`
          : `corsa più vicina: ${esc(h24(tm[1]))} da ${esc(tm[4])}`;
      const coll = r.ts && isColl(r.ts[3]);
      const smont = !r.ts ? '' : coll ? `rientra in deposito (${esc(r.ts[3])}) alle <b>${esc(h24(r.ts[2]))}</b> a ${esc(r.ts[5])}`
        : `arriva alle <b>${esc(h24(r.ts[2]))}</b> a ${esc(r.ts[5])}`;
      const outT = r.trips[0][1];
      const vehLine = v
        ? `<b class="tu-veh">Vettura ${esc(v.vehicleNo)}</b> · ora sulla ${esc(v.line)}${v.headsign ? ' verso ' + esc(v.headsign) : ''}`
        : mins(outT) > now ? `Vettura non ancora nota: esce dal deposito alle ${esc(h24(outT))} (${esc(depotName(r.trips.find((t) => isColl(t[3]))?.[3]?.[0]) || 'deposito')})`
          : 'Vettura non visibile ora (GPS spento o fuori servizio)';
      return `<div class="tu-card${i === 0 ? ' best' : ''}">
        <div class="tu-head"><b>${esc(tabName(r.b))}</b><span>${esc([...new Set(r.trips.map((t) => t[3]).filter((l) => !isColl(l)))].join(' › '))}</span></div>
        <div>Montata ${esc(q.on)}: ${mont}</div>
        ${q.off ? `<div>Smontata ${esc(q.off)}: ${smont}</div>` : `<div>Fine tabella: ${esc(h24(r.trips[r.trips.length - 1][2]))}${isColl(r.trips[r.trips.length - 1][3]) ? ' (rientro in deposito)' : ''}</div>`}
        <div class="tu-vline">${vehLine}</div>
        <div class="actions">${v ? `<button class="btn" data-tuveh="${esc(r.b)}">Dov'è adesso</button>` : ''}<button class="btn ghost" data-tutab="${esc(r.b)}" data-trip="${esc(tm[0])}">Apri tabella</button>
          ${i === 0 ? favBtn({ type: 'turno', line: q.line, on: q.on, off: q.off }) : ''}</div>
      </div>`;
    }).join('') + '<p class="muted">Calcolato sugli orari ATAC di oggi. La vettura compare appena la tabella è in servizio col GPS acceso.</p>';
  el.querySelectorAll('[data-tuveh]').forEach((b) => b.onclick = () => { const v = vb.get(b.dataset.tuveh); if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } });
  el.querySelectorAll('[data-tutab]').forEach((b) => b.onclick = () => openTabella(b.dataset.tutab, b.dataset.trip));
}
