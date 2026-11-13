// FOTO DELLA TABELLA: si fotografa il foglio vero della tabella, il telefono legge gli orari (OCR, gratis e
// senza inviare la foto a nessuno), trova a quale tabella ATAC corrispondono e, confermato il numero,
// lo salva per tutti. Ogni tabella confermata aiuta anche a indovinare i numeri delle altre.

import { loadBlocks, loadDay, todayISO, tabName, nameKey, setTabName, openTabella, isColl, ipotesi } from './rientri.js';

let C = null;
export function initFoto(ctx) { C = ctx; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const PX = () => ((window.CONFIG && window.CONFIG.PROXY_URL) || '').replace(/\/$/, '');
const GN = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const dayLabel = (d) => { if (!d || d === todayISO()) return 'Oggi'; const x = new Date(d + 'T12:00'); return `${GN[x.getDay()]} ${x.getDate()}/${x.getMonth() + 1}`; };

let tess = null;
function loadTesseract() {
  if (tess) return tess;
  if (window.Tesseract) return (tess = Promise.resolve(window.Tesseract));
  tess = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => ok(window.Tesseract);
    s.onerror = () => { tess = null; ko(new Error('Non riesco a scaricare il lettore di testo: controlla la connessione')); };
    document.head.appendChild(s);
  });
  return tess;
}

// immagine -> testo, ingrandita e in bianco e nero per leggere meglio
async function prepara(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(2, 2400 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const g = c.getContext('2d');
  g.filter = 'grayscale(1) contrast(1.6)';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// orari letti: 05:59, 6.00, 22,29… (dopo mezzanotte valgono +24h)
function orari(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\d])([01]?\d|2[0-4])\s?[:.,;]\s?([0-5]\d)(?![\d])/g)) {
    let v = +m[1] * 60 + +m[2];
    if (v < 4 * 60) v += 1440;
    out.push(v);
  }
  return out;
}

function confronta(T, blocks) {
  const res = [];
  for (const [b, trips] of Object.entries(blocks || {})) {
    const S = new Set();
    for (const t of trips) for (const x of [t[1], t[2]]) { let v = mins(x); if (v < 240) v += 1440; S.add(v); }
    let hit = 0;
    for (const v of T) if (S.has(v) || S.has(v - 1) || S.has(v + 1)) hit++;
    if (hit >= 5) res.push({ b, hit, trips, cover: hit / Math.max(1, S.size) });
  }
  res.sort((a, b) => b.hit - a.hit || b.cover - a.cover);
  return res.filter((c) => c.hit >= res[0].hit * 0.6).slice(0, 3);
}

export async function openFoto() {
  let idx = [];
  try { idx = await (await fetch('data/giorni/indice.json', { cache: 'no-cache' })).json(); } catch (e) {}
  const days = [todayISO(), ...idx.filter((d) => d > todayISO())];
  C.openSheet(`<h2>📷 Fotografa la tabella</h2>
    <p class="sub">Fai una foto dritta e ben illuminata del foglio della tabella (tutto il foglio). Leggo gli orari e trovo la tabella; tu confermi il numero e vale per tutti.</p>
    <label class="muted">Giorno della tabella <select id="ftDay">${days.map((d) => `<option value="${d === todayISO() ? '' : d}">${dayLabel(d)}</option>`).join('')}</select></label>
    <label class="btn" style="display:block;text-align:center;margin:12px 0">📷 Scatta o scegli la foto
      <input id="ftFile" type="file" accept="image/*" capture="environment" hidden></label>
    <div id="ftRes"></div>`, { type: 'foto' }, { tall: true });
  document.getElementById('ftFile').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) leggi(f, document.getElementById('ftDay').value); };
}

async function leggi(file, date) {
  const el = document.getElementById('ftRes');
  const msg = (h) => { if (el) el.innerHTML = h; };
  msg('<div class="spinner">Preparo la foto…</div>');
  try {
    await loadBlocks();
    const day = await loadDay(date);
    const canvas = await prepara(file);
    const T = await loadTesseract();
    msg('<div class="spinner">Leggo gli orari… (la prima volta scarica il lettore, qualche secondo)</div>');
    const { data } = await T.recognize(canvas, 'eng', { logger: (m) => { if (m.status === 'recognizing text') msg(`<div class="spinner">Leggo gli orari… ${Math.round(m.progress * 100)}%</div>`); } });
    const text = data.text || '';
    const Tm = orari(text);
    if (Tm.length < 5) { msg(`<p class="sub">Ho letto solo ${Tm.length} orari: rifai la foto più vicina, dritta e senza riflessi.</p>`); return; }
    const cand = confronta(Tm, day.blocks);
    if (!cand.length) { msg(`<p class="sub">Ho letto ${Tm.length} orari ma nessuna tabella di ${dayLabel(date)} corrisponde. Hai scelto il giorno giusto?</p>`); return; }
    const mTab = /Tab\W{0,3}N\W{0,3}(\d{1,3})/i.exec(text);
    const mLin = /Linea\W{0,2}([0-9]{1,3}[A-Z]?|[A-Z]{1,2}\d{0,2})/i.exec(text);
    const rimT = [...text.matchAll(/(\d{1,2}[:.]\d{2})\s*RIM\b|RIM\W+\w+\W+(\d{1,2}[:.]\d{2})/gi)].map((m) => (m[1] || m[2]).replace('.', ':'));
    el.innerHTML = `<p class="sub">Ho letto <b>${Tm.length}</b> orari. ${cand.length > 1 ? 'Tabelle più simili:' : 'Corrisponde a:'}</p>` + cand.map((c, i) => {
      const lines = [...new Set(c.trips.map((t) => t[3]).filter((l) => !isColl(l)))];
      const pre = tabName(c.b).includes('/') ? tabName(c.b) : '';
      const [pl, pn] = pre ? pre.split('/') : [mLin ? mLin[1] : lines[0], mTab ? mTab[1] : ''];
      const ipo = pre ? '' : ipotesi(c.b, day.blocks);
      return `<div class="tu-card${i === 0 ? ' best' : ''}">
        <div class="tu-head"><b>${esc(tabName(c.b))}</b><span>${esc(lines.join(' › '))}</span></div>
        <div>${c.hit} orari su ${Tm.length} coincidono · corse ${esc(c.trips[0][1])} – ${esc(c.trips[c.trips.length - 1][2])}</div>
        ${ipo ? `<div class="muted">${esc(ipo)}</div>` : ''}
        <form class="tu-form ft-form" data-b="${esc(c.b)}">
          <label>Linea <input name="l" value="${esc(pl || '')}" required></label>
          <label>N° tabella <input name="n" value="${esc(pn || '')}" inputmode="numeric" required></label>
          <label>Uscita rimessa <input name="u" type="time" value="${esc(rimT[0] && rimT[0].length === 5 ? rimT[0] : '')}"></label>
          <label>Rientro rimessa <input name="r" type="time" value="${esc(rimT.length > 1 ? rimT[rimT.length - 1] : '')}"></label>
          <button class="btn" type="submit">✔ Conferma questa tabella</button>
        </form>
        <div class="actions"><button class="btn ghost" data-open="${esc(c.b)}">Apri tabella</button></div>
      </div>`;
    }).join('') + '<p class="muted">Controlla linea e numero (sono scritti in alto sul foglio). Uscita e rientro dalla rimessa, se li inserisci, rendono più precisi gli orari di tutti.</p>';
    el.querySelectorAll('[data-open]').forEach((x) => x.onclick = () => openTabella(x.dataset.open));
    el.querySelectorAll('.ft-form').forEach((f) => f.onsubmit = (e) => { e.preventDefault(); conferma(f, day); });
  } catch (err) {
    msg(`<p class="sub">Errore: ${esc(err.message)}</p>`);
  }
}

async function conferma(form, day) {
  const b = form.dataset.b, trips = day.blocks[b];
  const L = form.l.value.trim().toUpperCase(), N = String(+form.n.value);
  if (!L || !+N) { C.toast('Scrivi linea e numero della tabella'); return; }
  const name = `${L}/${N}`;
  setTabName(b, name);
  // tempi veri deposito-capolinea dalla uscita/rientro scritti sul foglio
  const tempi = [];
  const svc = trips.filter((t) => !isColl(t[3]));
  const coll = trips.find((t) => isColl(t[3]));
  const D = coll ? coll[3][0] : ((day.rimessa && day.rimessa.lineaDeposito) || {})[svc[0] && svc[0][3]] || 'G';
  if (form.u.value && svc.length && !isColl(trips[0][3])) tempi.push({ D, p: svc[0][4], m: mins(svc[0][1]) - mins(form.u.value), h: Math.floor(mins(svc[0][1]) / 60) % 24 });
  if (form.r.value && svc.length && !isColl(trips[trips.length - 1][3])) {
    let r = mins(form.r.value); const e = mins(svc[svc.length - 1][2]); if (r < e - 600) r += 1440;
    tempi.push({ D, p: svc[svc.length - 1][5], m: r - e, h: Math.floor(e / 60) % 24 });
  }
  let shared = false;
  if (PX()) {
    try {
      const r = await fetch(PX() + '/nomi', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: nameKey(trips), name, b, data: day.today ? todayISO() : '', tempi: tempi.filter((t) => t.m > 0 && t.m < 90) }) });
      shared = r.ok;
    } catch (e) {}
  }
  C.toast(shared ? `Tabella ${name} confermata per tutti. Grazie!` : `Tabella ${name} salvata su questo telefono (il ponte non è ancora aggiornato)`, 6000);
  openTabella(b);
}
