// STORICO: come si comporta mediamente una linea, ora per ora, nei giorni dello stesso tipo
// (feriali, sabati, domeniche). I dati li raccoglie GitHub ogni 10 minuti nel ramo "storico".

let C = null;
export function initStorico(ctx) { C = ctx; }
const RAW = 'https://raw.githubusercontent.com/eremite1/bus-roma-live/storico/';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cache = new Map();
const pad = (n) => String(n).padStart(2, '0');
const kind = (d) => (d.getDay() === 0 ? 'domenica' : d.getDay() === 6 ? 'sabato' : 'feriale');

async function day(d) {
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  if (!cache.has(key)) cache.set(key, fetch(RAW + key + '.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(key);
}

export async function openStorico(line) {
  const today = new Date();
  const k = kind(today);
  C.openSheet(`<h2>Storico linea ${esc(line)}</h2><div id="stView"><div class="spinner">Carico i giorni ${k === 'feriale' ? 'feriali' : k === 'sabato' ? 'di sabato' : 'di domenica'} precedenti…</div></div>`, { type: 'storico' }, { tall: true });
  const days = [];
  for (let i = 0; i < 42 && days.length < 12; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    if (kind(d) === k) days.push(d);
  }
  const data = (await Promise.all(days.map(day))).filter(Boolean);
  const el = document.getElementById('stView');
  if (!el) return;
  const hours = {};
  let n = 0;
  for (const dd of data) {
    const L = dd.linee && dd.linee[line];
    if (!L) continue;
    n++;
    for (const [h, x] of Object.entries(L)) {
      const a = (hours[h] = hours[h] || { m: 0, k: 0, n: 0, s: 0, l: 0, e: 0 });
      for (const f of Object.keys(a)) a[f] += x[f] || 0;
    }
  }
  if (!n) {
    el.innerHTML = `<p class="sub">Ancora nessun dato per la linea ${esc(line)}: l'archivio si riempie da solo ogni 10 minuti, ripassa tra qualche giorno.</p>`;
    return;
  }
  const rows = Object.keys(hours).map(Number).sort((a, b) => a - b).map((h) => {
    const x = hours[h];
    const buses = x.k ? x.m / x.k : 0;
    const delay = x.n ? x.s / x.n : null;
    const late = x.n ? Math.round((100 * x.l) / x.n) : null;
    const w = delay == null ? 0 : Math.min(100, Math.max(4, (Math.abs(delay) / 10) * 100));
    const col = delay == null ? '#C9CCD2' : delay >= 5 ? '#C81E1E' : delay >= 2 ? '#E07A00' : delay <= -1 ? '#2563EB' : '#138A4B';
    return `<tr><td class="st-h">${pad(h)}:00</td><td>${buses.toFixed(1).replace('.', ',')}</td>
      <td><div class="st-bar"><span style="width:${w}%;background:${col}"></span></div></td>
      <td class="st-v">${delay == null ? '—' : (delay > 0 ? '+' : '') + delay.toFixed(1).replace('.', ',') + '′'}</td>
      <td class="st-v">${late == null ? '' : late + '%'}</td></tr>`;
  }).join('');
  el.innerHTML = `
    <p class="sub">Media di ${n} ${k === 'feriale' ? 'giorni feriali' : k === 'sabato' ? 'sabati' : 'domeniche'} recenti (fino a 12).</p>
    <table class="tabella st"><thead><tr><th>Ora</th><th>Mezzi</th><th>Ritardo medio</th><th></th><th>5′+</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">"Mezzi" = bus in servizio in media in quell'ora. "5′+" = corse con almeno 5 minuti di ritardo. L'archivio è iniziato il 10 novembre 2026 e cresce da solo; i cambi d'orario vengono registrati ogni giorno.</p>`;
}
