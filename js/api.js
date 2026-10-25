// Collegamento a Transitous (https://transitous.org): servizio libero e gratuito
// che conosce orari e ritardi in tempo reale di ATAC, Cotral e treni.

const BASE = () => (window.CONFIG.TRANSITOUS_API || 'https://api.transitous.org').replace(/\/$/, '');

async function get(path, params, { signal, timeout = 20000 } = {}) {
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Transitous ha risposto ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const LANG = ['it'];

export const api = {
  geocode(text, near, opts) {
    return get('/api/v1/geocode', {
      text,
      language: LANG,
      place: near ? `${near[1]},${near[0]}` : undefined,
      placeBias: near ? 3 : undefined,
      numResults: 8,
    }, opts);
  },

  reverse(lngLat, opts) {
    return get('/api/v1/reverse-geocode', { place: `${lngLat[1]},${lngLat[0]}` }, opts);
  },

  plan(from, to, opts) {
    return get('/api/v6/plan', {
      fromPlace: `${from[1]},${from[0]}`,
      toPlace: `${to[1]},${to[0]}`,
      time: new Date().toISOString(),
      language: LANG,
      detailedTransfers: false,
      maxPreTransitTime: 1200,
      maxPostTransitTime: 1200,
      maxDirectTime: 2400,
    }, { timeout: 30000, ...opts });
  },

  stoptimes(stopId, opts) {
    return get('/api/v6/stoptimes', { stopId, n: 14, language: LANG }, opts);
  },

  trip(tripId, opts) {
    return get('/api/v6/trip', { tripId, language: LANG }, opts);
  },

  // Tutti i tratti di corsa (fermata -> fermata) in un'area e in un intervallo di tempo.
  mapTrips(bounds, start, end, opts) {
    return get('/api/v6/map/trips', {
      zoom: 16, // al livello 16 il servizio include anche bus e tram
      min: `${bounds.south},${bounds.east}`,
      max: `${bounds.north},${bounds.west}`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      precision: 5,
    }, { timeout: 25000, ...opts });
  },

  mapStops(bounds, opts) {
    return get('/api/v6/map/stops', {
      min: `${bounds.south},${bounds.east}`,
      max: `${bounds.north},${bounds.west}`,
      language: LANG,
    }, opts);
  },
};

// Decodifica una linea in formato "polyline" di Google -> [[lon, lat], ...]
export function decodePolyline(str, precision = 5) {
  const f = Math.pow(10, precision);
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / f, lat / f]);
  }
  return out;
}

// L'identificativo di corsa di Transitous è "AAAAMMGG_HH:MM_<sigla-dati>_<id originale ATAC>".
// Questa funzione restituisce solo l'id originale, quello usato anche dal GPS di ATAC.
export function rawTripId(id) {
  if (!id) return '';
  const parts = id.split('_');
  if (parts.length >= 4 && /^\d{8}$/.test(parts[0])) return parts.slice(3).join('_');
  const i = id.indexOf('_');
  return i >= 0 ? id.slice(i + 1) : id;
}
