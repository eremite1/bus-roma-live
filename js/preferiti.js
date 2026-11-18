// PREFERITI (linee, tabelle, vetture, turni) e "IL MIO TURNO"
// Il turno: scrivi linea, orario di montata e di smontata; cerco nelle tabelle di oggi quella che
// fa una corsa a quell'ora e finisce a quell'ora, e dico quale vettura la sta facendo adesso.

import { loadBlocks, blocksNow as blocksToday, vehiclesByBlock as vbToday, nameKey, tabName, openTabella, isColl, depotName, loadDay, todayISO } from './rientri.js';

// giorno scelto nella ricerca del turno (null = oggi): tabelle di quel giorno, niente vetture in diretta
let dayBlocks = null;
const blocksNow = () => dayBlocks || blocksToday();
const vehiclesByBlock = () => (dayBlocks ? new Map() : vbToday());
const GNOMI = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const dayLabel = (d) => { if (!d || d === todayISO()) return 'Oggi'; const x = new Date(d + 'T12:00'); return `${GNOMI[x.getDay()]} ${x.getDate()}/${x.getMonth() + 1}`; };

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

// Nei preferiti solo tabelle e turni: per ognuno mostro tutto (vettura, dove si trova, corsa in corso).
const prefOk = (f) => f.type === 'tabella' || f.type === 'turno';
function resolveFav(f) {
  if (f.type === 'tabella') return findBlock(f);
  const tmm = TAB_RE.exec(f.line || '');
  if (tmm) { const w = `${tmm[1]}/${+tmm[2]}`.toLowerCase(); return Object.keys(blocksNow()).find((k) => tabName(k).toLowerCase() === w) || ''; }
  const best = f.on ? findTurno(f.line, f.on, f.off, f.cap)[0] : null;
  return best ? best.b : '';
}
function renderPref() {
  const el = document.getElementById('pfView');
  if (!el) return;
  const all = list(), favs = all.filter(prefOk);
  const vb = vehiclesByBlock();
  const bl = blocksNow();
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const nowT = (t) => { const s = mins(t[1]), e = mins(t[2]); return (s <= nowM && e >= nowM) || (s <= nowM + 1440 && e >= nowM + 1440); };
  const cards = favs.map((f) => {
    const i = all.indexOf(f);
    const b = resolveFav(f), trips = b && bl[b], v = b && vb.get(b);
    const title = f.type === 'turno'
      ? `🕑 Turno ${esc(f.line || '')} ${esc(f.on || '')}${f.off ? '–' + esc(f.off) : ''}`
      : `📋 ${esc(b ? tabName(b) : f.label || 'Tabella')}`;
    let body;
    if (!trips) body = '<div class="muted">Oggi questa tabella non gira (o non la trovo negli orari di oggi).</div>';
    else {
      const cur = trips.find(nowT), next = trips.find((t) => mins(t[1]) > nowM);
      const lines = [...new Set(trips.map((t) => t[3]).filter((l) => !isColl(l)))].join(' › ');
      body = `<div><b>${esc(tabName(b))}</b> · ${esc(lines)} · uscita ${esc(h24(trips[0][1]))}, rientro ${esc(h24(trips[trips.length - 1][2]))}</div>
        <div class="tu-vline">${v ? `<b class="tu-veh">Vettura ${esc(v.vehicleNo)}</b>${v.headsign ? ' · verso ' + esc(v.headsign) : ''}` : (mins(trips[0][1]) > nowM ? `Vettura non ancora uscita (esce alle ${esc(h24(trips[0][1]))})` : 'Vettura non visibile ora (GPS spento o fuori servizio)')}</div>
        ${cur ? `<div>Ora: ${esc(isColl(cur[3]) ? 'collegamento ' + cur[3] : 'corsa ' + h24(cur[1]))} ${esc(cur[4])} → ${esc(cur[5])} (arrivo ${esc(h24(cur[2]))})</div>` : next ? `<div>Prossima: ${esc(h24(next[1]))} da ${esc(next[4])}</div>` : '<div class="muted">Servizio di oggi finito.</div>'}
        <div class="actions">${v ? `<button class="btn" data-veh="${esc(b)}">Dov'è adesso</button>` : ''}<button class="btn ghost" data-tab="${esc(b)}">Apri tabella</button></div>`;
    }
    return `<div class="tu-card"><div class="tu-head"><b>${title}</b><button class="pf-del" data-del="${i}" aria-label="Togli dai preferiti">✕</button></div>${body}</div>`;
  }).join('');
  el.innerHTML = `<h2>★ Preferiti</h2>
    ${cards || `<p class="sub">Nessun preferito. Apri una tabella (o cerca il tuo turno) e tocca <b>☆ Aggiungi ai preferiti</b>: qui vedrai vettura, posizione e corsa in corso.</p>`}
    <div class="actions"><button class="btn" id="pfTurno">🕑 Trova il mio turno</button></div>
    <p class="muted">Salvati su questo telefono. Aggiornamento ogni 30 secondi.</p>`;
  document.getElementById('pfTurno').onclick = () => openTurno();
  el.querySelectorAll('[data-del]').forEach((x) => x.onclick = () => { const l = list(); l.splice(+x.dataset.del, 1); ls('preferiti', l); renderPref(); });
  el.querySelectorAll('[data-veh]').forEach((x) => x.onclick = () => { const v = vb.get(x.dataset.veh); if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } });
  el.querySelectorAll('[data-tab]').forEach((x) => x.onclick = () => openTabella(x.dataset.tab));
}

// ---------------- il mio turno ----------------
// Punteggio di ogni tabella: quanto la montata è vicina alla partenza di una corsa e la smontata
// all'arrivo di una corsa (minuti di differenza). Vince il punteggio più basso.
// Ricerca del turno. Si monta e si smonta SOLO ai capolinea o in rimessa (niente cambi in linea,
// tranne la 252). La corsa di montata è quella che parte dal capolinea scelto subito dopo l'orario
// di montata; la smontata è un arrivo (o una partenza) al capolinea dopo la montata, oppure il rientro.
export function findTurno(line, on, off, cap) {
  const hasOn = !!on, hasOff = !!off;
  if (!hasOn && !hasOff) return [];
  const M = hasOn ? mins(on) : null;
  let S = hasOff ? mins(off) : null;
  if (hasOn && hasOff && S <= M) S += 1440; // smontata dopo mezzanotte
  const L = String(line || '').trim().toLowerCase();
  const inLinea = L === '252';
  const rim = cap === 'RIMESSA';
  const runStart = (trips, i) => i === 0 || mins(trips[i][1]) - mins(trips[i - 1][2]) > 60;
  const runEnd = (trips, i) => i === trips.length - 1 || mins(trips[i + 1][1]) - mins(trips[i][2]) > 60;
  const out = [];
  for (const [b, trips] of Object.entries(blocksNow())) {
    if (!trips.length) continue;
    if (L && !trips.some((t) => String(t[3]).toLowerCase() === L)) continue;
    let dm = 0, tm = null, iM = 0, inCorso = null;
    if (hasOn) {
      trips.forEach((t, i) => {
        const d = mins(t[1]) - M;
        let ok;
        if (rim) ok = runStart(trips, i) && d >= 0 && d <= (isColl(t[3]) ? 10 : 60); // presa servizio in rimessa = uscita
        else ok = !isColl(t[3]) && (!L || String(t[3]).toLowerCase() === L) && (!cap || t[4] === cap) && d >= 0 && d <= 20;
        if (ok && (tm === null || d < dm)) { dm = d; tm = t; iM = i; }
      });
      if (!tm && inLinea) {
        inCorso = trips.find((t) => mins(t[1]) < M && mins(t[2]) > M);
        if (inCorso) { tm = inCorso; dm = 10; iM = trips.indexOf(inCorso); }
      }
      if (!tm) continue;
    }
    let ds = 0, tsm = null;
    if (hasOff) {
      let best = 1e9;
      trips.forEach((t, i) => {
        if (i < iM) return;
        const cands = [Math.abs(mins(t[2]) - S)];
        if (i > iM) cands.push(Math.abs(mins(t[1]) - S)); // smonta al capolinea quando la vettura riparte
        if (runEnd(trips, i) && !isColl(t[3]) && S >= mins(t[2]) && S - mins(t[2]) <= 60) cands.push(5); // rientro in rimessa senza collegamento
        const d = Math.min(...cands);
        if (d < best) { best = d; tsm = t; }
      });
      if (best > 15) continue;
      ds = best;
    }
    out.push({ b, score: dm + ds * 1.5, dm, ds, tm, ts: tsm, inCorso, trips });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 5);
}

// capolinea da cui parte una linea (per il menu della montata), dal più usato
function capolineaDi(line) {
  const L = String(line || '').trim().toLowerCase(), c = {};
  if (!L) return [];
  for (const trips of Object.values(blocksNow())) for (const t of trips) if (String(t[3]).toLowerCase() === L) c[t[4]] = (c[t[4]] || 0) + 1;
  return Object.keys(c).sort((a, b) => c[b] - c[a]);
}

let turnoTimer = null;
export async function openTurno(saved) {
  const last = saved || ls('turnoUltimo') || {};
  C.openSheet(`<h2>🕑 Il mio turno</h2>
    <button class="btn ghost" type="button" id="tuFoto" style="width:100%;margin-bottom:6px">📷 Fotografa la tabella</button>
    <p class="sub">Scrivi la linea e l'orario di montata <b>o</b> di smontata (con tutti e due è più preciso), oppure direttamente la tabella, es. <b>80-1</b>: trovo la vettura che la sta facendo.</p>
    <form id="tuForm" class="tu-form">
      <label>Giorno <select id="tuDay"><option value="">Oggi</option></select></label>
      <label>Linea <input id="tuLine" value="${esc(last.line || '')}" placeholder="es. 913 oppure 80-1" autocomplete="off"></label>
      <label>Montata a <select id="tuCap"><option value="">qualsiasi capolinea</option></select></label>
      <label>Montata <input id="tuOn" type="time" value="${esc(last.on || '')}"></label>
      <label>Smontata <input id="tuOff" type="time" value="${esc(last.off || '')}"></label>
      <button class="btn" type="submit">Cerca</button>
    </form>
    <div id="tuRes"></div>`, { type: 'turno' }, { tall: true });
  await loadBlocks();
  C.refreshAtac && C.refreshAtac();
  try {
    const idx = await (await fetch('data/giorni/indice.json', { cache: 'no-cache' })).json();
    const sel = document.getElementById('tuDay');
    for (const d of idx.filter((x) => x > todayISO())) sel.insertAdjacentHTML('beforeend', `<option value="${d}"${last.date === d ? ' selected' : ''}>${dayLabel(d)}</option>`);
  } catch (e) { /* solo oggi */ }
  // menu dei capolinea della linea scritta (si ricorda l'ultimo scelto per ogni linea)
  const capSel = document.getElementById('tuCap');
  const fillCap = async () => {
    const line = document.getElementById('tuLine').value.trim();
    const d = document.getElementById('tuDay').value;
    dayBlocks = d && d !== todayISO() ? (await loadDay(d)).blocks || {} : null;
    const caps = TAB_RE.test(line) ? [] : capolineaDi(line);
    const pref = (ls('capPerLinea') || {})[line.toLowerCase()] || (last.line === line ? last.cap : '');
    capSel.innerHTML = '<option value="">qualsiasi capolinea</option><option value="RIMESSA">rimessa (presa servizio in deposito)</option>'
      + caps.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    capSel.value = [...capSel.options].some((o) => o.value === pref) ? pref : '';
  };
  let capT = null;
  document.getElementById('tuLine').addEventListener('input', () => { clearTimeout(capT); capT = setTimeout(fillCap, 400); });
  document.getElementById('tuDay').addEventListener('change', fillCap);
  await fillCap();
  const run = () => {
    const q = { type: 'turno', date: document.getElementById('tuDay').value, line: document.getElementById('tuLine').value.trim(), cap: capSel.value, on: document.getElementById('tuOn').value, off: document.getElementById('tuOff').value };
    if (q.line) { const cp = ls('capPerLinea') || {}; cp[q.line.toLowerCase()] = q.cap; ls('capPerLinea', cp); }
    if (!q.on && !q.off && !TAB_RE.test(q.line)) { C.toast("Scrivi l'orario di montata o di smontata, oppure la tabella (es. 80-1)"); return; }
    ls('turnoUltimo', q);
    renderTurno(q);
  };
  document.getElementById('tuFoto').onclick = () => C.openFoto && C.openFoto();
  document.getElementById('tuForm').onsubmit = (e) => { e.preventDefault(); run(); };
  if (last.on || last.off || TAB_RE.test(last.line || '')) run();
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

async function renderTurno(q) {
  let el = document.getElementById('tuRes');
  if (!el) return;
  dayBlocks = q.date && q.date !== todayISO() ? (await loadDay(q.date)).blocks || {} : null;
  el = document.getElementById('tuRes');
  if (!el) return;
  el.dataset.q = JSON.stringify(q);
  const tm0 = TAB_RE.exec(q.line || '');
  if (tm0) return renderTabella(el, q, tm0);
  const res = findTurno(q.line, q.on, q.off, q.cap);
  const vb = vehiclesByBlock();
  if (!res.length) {
    el.innerHTML = `<p class="sub">Nessuna tabella di ${dayLabel(q.date).toLowerCase()}${q.line ? ' sulla ' + esc(q.line) : ''} corrisponde a ${[q.on && 'montata ' + esc(q.on), q.off && 'smontata ' + esc(q.off)].filter(Boolean).join(' e ')}. Controlla linea e orari${q.line ? ', oppure prova senza linea' : ''}.</p>`;
    return;
  }
  const now = dayBlocks ? -1 : new Date().getHours() * 60 + new Date().getMinutes();
  el.innerHTML = (q.date ? `<p class="muted">Tabelle di <b>${esc(dayLabel(q.date))}</b> (le vetture si vedono solo il giorno stesso).</p>` : '') + (res.length > 1 && res[0].score === res[1].score ? '<p class="muted">Più tabelle corrispondono: scegli la tua.</p>' : '') +
    res.map((r, i) => {
      const v = vb.get(r.b);
      const tm = r.tm;
      const mont = !q.on ? '' : r.inCorso ? `cambio in linea: alle ${esc(q.on)} è sulla corsa ${esc(h24(r.inCorso[1]))} ${esc(r.inCorso[4])} → ${esc(r.inCorso[5])}`
        : isColl(tm[3]) ? `esci dalla rimessa alle <b>${esc(h24(tm[1]))}</b> (${esc(tm[3])} → ${esc(tm[5])})`
        : q.cap === 'RIMESSA' ? `esci dalla rimessa, prima corsa alle <b>${esc(h24(tm[1]))}</b> da ${esc(tm[4])}`
        : `parti alle <b>${esc(h24(tm[1]))}</b> da ${esc(tm[4])} → ${esc(tm[5])}${r.dm ? ` (${r.dm} min dopo la montata)` : ''}`;
      const coll = r.ts && isColl(r.ts[3]);
      const smont = !r.ts ? '' : coll ? `rientra in deposito (${esc(r.ts[3])}) alle <b>${esc(h24(r.ts[2]))}</b> a ${esc(r.ts[5])}`
        : Math.abs(mins(r.ts[1]) - mins(q.off)) < Math.abs(mins(r.ts[2]) - mins(q.off))
          ? `smonti al capolinea ${esc(r.ts[4])}: la vettura riparte alle <b>${esc(h24(r.ts[1]))}</b>`
          : `arriva alle <b>${esc(h24(r.ts[2]))}</b> a ${esc(r.ts[5])}`;
      const outT = r.trips[0][1];
      const vehLine = v
        ? `<b class="tu-veh">Vettura ${esc(v.vehicleNo)}</b> · ora sulla ${esc(v.line)}${v.headsign ? ' verso ' + esc(v.headsign) : ''}`
        : mins(outT) > now ? `Vettura non ancora nota: esce dal deposito alle ${esc(h24(outT))} (${esc(depotName(r.trips.find((t) => isColl(t[3]))?.[3]?.[0]) || 'deposito')})`
          : 'Vettura non visibile ora (GPS spento o fuori servizio)';
      return `<div class="tu-card${i === 0 ? ' best' : ''}">
        <div class="tu-head"><b>${esc(tabName(r.b))}</b><span>${esc([...new Set(r.trips.map((t) => t[3]).filter((l) => !isColl(l)))].join(' › '))}</span></div>
        ${q.on ? `<div>Montata ${esc(q.on)}: ${mont}</div>` : `<div>Inizio tabella: uscita ${esc(h24(r.trips[0][1]))}</div>`}
        ${q.off ? `<div>Smontata ${esc(q.off)}: ${smont}</div>` : `<div>Fine tabella: ${esc(h24(r.trips[r.trips.length - 1][2]))}${isColl(r.trips[r.trips.length - 1][3]) ? ' (rientro in deposito)' : ''}</div>`}
        <div class="tu-vline">${vehLine}</div>
        <div class="actions">${v ? `<button class="btn" data-tuveh="${esc(r.b)}">Dov'è adesso</button>` : ''}<button class="btn ghost" data-tutab="${esc(r.b)}" data-trip="${esc((tm || r.ts || r.trips[0])[0])}">Apri tabella</button>
          ${i === 0 ? favBtn({ type: 'turno', line: q.line, cap: q.cap, on: q.on, off: q.off }) : ''}</div>
      </div>`;
    }).join('') + '<p class="muted">Calcolato sugli orari ATAC di oggi. La vettura compare appena la tabella è in servizio col GPS acceso.</p>';
  el.querySelectorAll('[data-tuveh]').forEach((b) => b.onclick = () => { const v = vb.get(b.dataset.tuveh); if (v) { C.showVehicle(v); C.showPoint([v.lng, v.lat], 15.5); } });
  el.querySelectorAll('[data-tutab]').forEach((b) => b.onclick = () => openTabella(b.dataset.tutab, b.dataset.trip));
}
