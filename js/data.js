// Dati "fissi" della rete (preparati ogni notte da tools/build_static.py) e colori delle linee.

export const store = {
  routes: null,      // route_id -> { n, l, t, c, tc }
  routeByName: new Map(), // "64" -> route_id
  trips: null,       // { routes:[], headsigns:[], trips:{ id: [routeIdx, headsignIdx, dir] } }
  shapes: null,      // route_id -> [{ d, h, p }]
  meta: null,
};

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ' ' + res.status);
  return res.json();
}

export async function loadRoutes() {
  try {
    store.routes = await getJSON('data/routes.json');
    for (const [id, r] of Object.entries(store.routes)) {
      if (!store.routeByName.has(r.n)) store.routeByName.set(r.n, id);
    }
  } catch (e) {
    console.warn('Dati linee non disponibili', e);
    store.routes = {};
  }
  getJSON('data/meta.json').then((m) => (store.meta = m)).catch(() => {});
}

export async function loadTrips() {
  try {
    store.trips = await getJSON('data/trips.json');
  } catch (e) {
    console.warn('Dati corse non disponibili', e);
    store.trips = { routes: [], headsigns: [], trips: {} };
  }
}

let shapesPromise = null;
export function loadShapes() {
  if (!shapesPromise) {
    shapesPromise = getJSON('data/shapes.json').then((s) => (store.shapes = s)).catch(() => (store.shapes = {}));
  }
  return shapesPromise;
}

export function tripInfo(rawId) {
  const t = store.trips && store.trips.trips[rawId];
  if (!t) return null;
  return { routeId: store.trips.routes[t[0]], headsign: store.trips.headsigns[t[1]], dir: t[2] };
}

export function routeInfo(routeId) {
  return (store.routes && store.routes[routeId]) || null;
}

// Colori: rosso per i bus, arancio per i tram, blu notte per le linee notturne, ecc.
export const PALETTE = {
  bus: '#C8102E',
  tram: '#E87511',
  night: '#24418F',
  metro: '#7A1FA2',
  rail: '#0B6E4F',
  other: '#555B66',
};

export function kindOf({ type, mode, line }) {
  const name = String(line || '');
  if (/^n\d/i.test(name)) return 'night';
  if (mode) {
    if (mode === 'TRAM') return 'tram';
    if (mode === 'SUBWAY' || mode === 'METRO') return 'metro';
    if (/RAIL|SUBURBAN|REGIONAL|TRAIN/.test(mode)) return 'rail';
    if (mode === 'BUS' || mode === 'COACH' || mode === 'TROLLEYBUS') return 'bus';
  }
  if (type === 0) return 'tram';
  if (type === 1) return 'metro';
  if (type === 2) return 'rail';
  if (type === 3 || type === 11 || type === 700) return 'bus';
  return type === undefined && !mode ? 'bus' : 'other';
}

export function colorOf(v) {
  return PALETTE[kindOf(v)] || PALETTE.other;
}

// Nomi tutti maiuscoli -> più leggibili ("PIAZZA VENEZIA" -> "Piazza Venezia")
const SMALL = new Set(['di', 'de', 'del', 'della', 'dei', 'degli', 'delle', 'e', 'a', 'al', 'alla', 'da', 'in', 'su', 'per', 'la', 'le', 'il']);
export function niceName(s) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  const fix = (w, i) => {
    if (w.includes('/')) return w.split('/').map((x) => fix(x, 0)).join('/');
    if (/\d|\(|\)|-/.test(w)) return w;
    const lw = w.toLowerCase();
    if (i > 0 && SMALL.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  };
  return s.split(' ').map(fix).join(' ');
}
