// MONOPATTINI IN SHARING: posizioni live (dal ponte, che legge i dati pubblici degli operatori)
// e opzione "monopattino" nel calcolo del percorso.

let C = null;
let data = null, loadedAt = 0, timer = null;
export const scooterState = { on: false };

export function initMonopattini(ctx) {
  C = ctx;
  try { scooterState.on = localStorage.getItem('monopattini') === '1'; } catch (e) {}
  const map = C.map;
  const add = () => {
    if (map.getSource('scooter')) return;
    map.addSource('scooter', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'scooter', type: 'circle', source: 'scooter', minzoom: 12.5,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 2.5, 16, 6], 'circle-color': '#10B981', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  };
  if (map.isStyleLoaded()) add(); else map.once('load', add);
  if (scooterState.on) start();
}

const PX = () => ((window.CONFIG && window.CONFIG.PROXY_URL) || '').replace(/\/$/, '');

export async function loadScooters(force = false) {
  if (!force && data && Date.now() - loadedAt < 60_000) return data;
  if (!PX()) return null;
  try {
    const r = await fetch(PX() + '/monopattini', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    loadedAt = Date.now();
  } catch (e) { data = null; }
  return data;
}

function draw() {
  const src = C.map.getSource('scooter');
  if (!src) return;
  const v = scooterState.on && data ? data.v : [];
  src.setData({ type: 'FeatureCollection', features: v.map((x) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x[0], x[1]] }, properties: { op: x[2] } })) });
}

async function start() {
  await loadScooters(true);
  draw();
  clearInterval(timer);
  timer = setInterval(async () => { if (scooterState.on) { await loadScooters(true); draw(); } }, 60_000);
}

export async function toggleScooters() {
  scooterState.on = !scooterState.on;
  try { localStorage.setItem('monopattini', scooterState.on ? '1' : '0'); } catch (e) {}
  if (scooterState.on) {
    await start();
    if (!data) C.toast('Monopattini non disponibili: il ponte va aggiornato con il codice nuovo', 6000);
    else C.toast(`${data.v.length} monopattini liberi (${data.op.join(', ')}) — visibili ingrandendo la mappa`, 5000);
  } else { clearInterval(timer); draw(); }
  return scooterState.on;
}

// ---------- monopattino nel percorso ----------
const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function dist(a, b) {
  const x = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Opzione "solo monopattino": cammino fino al monopattino libero più vicino (entro 500 m), poi in
// monopattino fino a destinazione. Strade ~1,35 volte la linea d'aria, 15 km/h, 2 minuti per sbloccare/parcheggiare.
export async function scooterOption(from, to) {
  const d = await loadScooters();
  if (!d || !d.v.length) return null;
  let best = null, bd = 1e9;
  for (const x of d.v) {
    const dd = dist(from, [x[0], x[1]]);
    if (dd < bd) { bd = dd; best = x; }
  }
  if (!best || bd > 500) return null;
  const ride = dist([best[0], best[1]], to) * 1.35;
  if (ride > 10000 || (best[3] != null && best[3] * 1000 < ride * 1.1)) return null; // troppo lontano o batteria scarsa
  const walkMin = Math.ceil((bd * 1.3) / 80), rideMin = Math.ceil(ride / 250) + 2;
  return { op: d.op[best[2]] || 'sharing', at: [best[0], best[1]], walkMin, walkM: Math.round(bd * 1.3), rideMin, rideKm: ride / 1000, total: walkMin + rideMin, range: best[3] };
}
