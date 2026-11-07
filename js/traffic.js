// TRAFFICO dalla velocità reale dei bus.
// Ogni volta che il GPS di un bus si aggiorna, calcolo quanto si è spostato e in quanto tempo:
// il tratto percorso diventa un pezzetto di "traffico" colorato (verde, arancio, rosso).
// È il traffico che incontrano davvero i bus (corsie preferenziali comprese).

import { distance, bearing } from './vehicles.js';

const MAX_AGE = 12 * 60_000;   // i tratti più vecchi di 12 minuti spariscono
export const SLOW = 7, MEDIUM = 14; // km/h

export class Traffic {
  constructor() {
    this.prev = new Map(); // vettura -> ultima posizione con orario GPS
    this.segs = [];        // { a, b, kmh, t, line, head }
  }

  // da chiamare a ogni aggiornamento delle posizioni GPS
  ingest(vehicles) {
    const now = Date.now();
    for (const v of vehicles) {
      if (v.source !== 'gps' || !v.ts) continue;
      const p = this.prev.get(v.id);
      if (!p || v.ts !== p.ts) this.prev.set(v.id, { lng: v.lng, lat: v.lat, ts: v.ts });
      if (!p || v.ts <= p.ts) continue;
      const dt = v.ts - p.ts;
      if (dt < 15 || dt > 240) continue;
      const a = [p.lng, p.lat], b = [v.lng, v.lat];
      const d = distance(a, b);
      if (d < 20 || d > 2500) continue; // fermo in fermata/capolinea, oppure dato sbagliato
      const kmh = (d / dt) * 3.6;
      if (kmh > 90) continue;
      this.segs.push({ a, b, kmh, t: now, line: String(v.line), head: bearing(a, b) });
    }
    this.segs = this.segs.filter((s) => now - s.t < MAX_AGE);
    if (this.segs.length > 8000) this.segs.splice(0, this.segs.length - 8000);
    if (this.prev.size > 6000) this.prev.clear();
  }

  geojson() {
    const now = Date.now();
    return {
      type: 'FeatureCollection',
      features: this.segs.map((s) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [s.a, s.b] },
        properties: { kmh: Math.round(s.kmh), age: (now - s.t) / MAX_AGE },
      })),
    };
  }
}

export function trafficColor(kmh) {
  return kmh < SLOW ? '#D7263D' : kmh < MEDIUM ? '#F28C28' : '#2BA84A';
}

// Livelli della mappa: ogni tratto è spostato sul lato destro della strada,
// così i due sensi di marcia non si sovrappongono.
export function setupTrafficLayer(map, beforeId) {
  map.addSource('traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'traffic', type: 'line', source: 'traffic',
    layout: { 'line-cap': 'round', visibility: 'none' },
    paint: {
      'line-color': ['step', ['get', 'kmh'], '#D7263D', SLOW, '#F28C28', MEDIUM, '#2BA84A'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6],
      'line-offset': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 6],
      'line-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 0.9, 1, 0.15],
    } }, beforeId);
}

// Traffico lungo un percorso (es. la linea che sto guidando), nel mio senso di marcia.
// route = { coords, cum } con punti fitti; from/to = distanze lungo il percorso (metri).
export function trafficAhead(traffic, route, from, to) {
  const k = Math.cos((route.coords[0][1] * Math.PI) / 180);
  const near = (p) => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < route.coords.length; i++) {
      const q = route.coords[i];
      const dx = (q[0] - p[0]) * k, dy = q[1] - p[1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, m: Math.sqrt(bd) * 111320 };
  };
  const found = [];
  for (const s of traffic.segs) {
    const mid = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    const { i, m } = near(mid);
    if (m > 35 || i < 0) continue;
    const at = route.cum[i];
    if (at < from || at > to) continue;
    const j = Math.min(route.coords.length - 1, i + 2), h = Math.max(0, i - 2);
    const dir = bearing(route.coords[h], route.coords[j]);
    if (Math.abs(((s.head - dir + 540) % 360) - 180) > 50) continue; // senso opposto
    found.push({ at, kmh: s.kmh });
  }
  found.sort((x, y) => x.at - y.at);
  const slow = found.filter((f) => f.kmh < SLOW);
  const avg = found.length ? found.reduce((a, f) => a + f.kmh, 0) / found.length : null;
  return { samples: found.length, avg, firstSlow: slow.length >= 2 ? slow[0] : null, slowKmh: slow.length ? slow.reduce((a, f) => a + f.kmh, 0) / slow.length : null };
}
