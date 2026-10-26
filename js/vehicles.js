// Le due "fonti" delle posizioni dei mezzi:
//  - GPS:     posizioni reali trasmesse dai bus ATAC (serve il ponte Cloudflare, vedi config.js)
//  - STIMATE: posizioni calcolate da Transitous in base a orari e ritardi in tempo reale
// Entrambe restituiscono una lista di mezzi nello stesso formato.

import { decodeVehicleFeed } from './gtfsrt.js';
import { api, decodePolyline, rawTripId } from './api.js';
import { tripInfo, routeInfo, niceName, store } from './data.js';

// ---------- utilità geografiche ----------
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
export function distance(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Area di Roma e dintorni (per la fonte "stimata")
export const ROME_BOUNDS = { south: 41.62, west: 12.18, north: 42.16, east: 12.86 };

// ---------- fonte GPS ----------
export class GpsSource {
  constructor(proxyUrl) {
    this.url = proxyUrl.replace(/\/$/, '') + '/vehicles';
    this.kind = 'gps';
    this.prev = new Map(); // id -> { lng, lat, bearing }
  }

  async fetch() {
    const res = await fetch(this.url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Ponte GPS: risposta ' + res.status);
    const feed = decodeVehicleFeed(await res.arrayBuffer());
    const now = Date.now() / 1000;
    const list = [];
    for (const v of feed.vehicles) {
      // scarta posizioni vecchie di oltre 10 minuti (mezzo fermo in deposito / GPS spento)
      if (v.timestamp && now - v.timestamp > 600) continue;
      // se il GPS non dice la corsa, la prendo dalle previsioni ATAC (quando disponibili)
      if (!v.tripId && this.tripByVehicle && this.tripByVehicle.get(v.id)) v.tripId = this.tripByVehicle.get(v.id);
      const info = v.tripId ? tripInfo(v.tripId) : null;
      const routeId = (info && info.routeId) || v.routeId;
      const route = routeInfo(routeId);
      const lngLat = [v.lon, v.lat];

      // direzione di marcia: dal GPS se affidabile, altrimenti dallo spostamento rispetto a prima
      const p = this.prev.get(v.id);
      let br = null;
      if (p && distance([p.lng, p.lat], lngLat) > 12) br = bearing([p.lng, p.lat], lngLat);
      else if (p && p.bearing != null) br = p.bearing;
      if (v.bearing != null && v.bearing !== 0 && isFinite(v.bearing)) br = v.bearing;
      this.prev.set(v.id, { lng: v.lon, lat: v.lat, bearing: br });

      list.push({
        id: 'g' + v.id,
        vehicleNo: v.label || v.id,
        lng: v.lon, lat: v.lat,
        bearing: br,
        line: route ? route.n : (v.routeId || '?'),
        routeId,
        type: route ? route.t : 3,
        headsign: info ? info.headsign : '',
        dir: info ? info.dir : v.directionId,
        tripId: v.tripId,
        speed: v.speed,
        occupancy: v.occupancy,
        ts: v.timestamp || feed.timestamp,
        source: 'gps',
      });
    }
    if (this.prev.size > 6000) this.prev.clear();
    return { vehicles: list, feedTime: feed.timestamp };
  }
}

// ---------- fonte stimata (Transitous) ----------
// Scarica i tratti di corsa fermata->fermata dei prossimi minuti e calcola,
// secondo per secondo, dove dovrebbe trovarsi ogni mezzo.
const MODES = new Set(['BUS', 'TRAM', 'SUBWAY', 'METRO', 'TROLLEYBUS', 'COACH', 'SUBURBAN', 'REGIONAL_RAIL', 'REGIONAL_FAST_RAIL', 'RAIL', 'FERRY']);

export class EstimatedSource {
  constructor() {
    this.kind = 'est';
    this.trips = new Map(); // tripId -> { info, segs: [{ dep, arr, coords, cum, total, from, to, realTime }] }
    this.fetchedUntil = 0;
  }

  // bounds: area da scaricare (di solito quella visibile sulla mappa, un po' allargata)
  async fetch(bounds = ROME_BOUNDS) {
    const now = Date.now();
    const start = new Date(now - 60_000), end = new Date(now + 4 * 60_000);
    const segs = await api.mapTrips(bounds, start, end);
    this.bounds = bounds;
    const trips = new Map();
    for (const s of segs) {
      if (s.mode && !MODES.has(s.mode)) continue;
      const t0 = s.trips && s.trips[0];
      if (!t0) continue;
      const id = t0.tripId;
      let trip = trips.get(id);
      if (!trip) {
        trip = { id, line: t0.displayName || t0.routeShortName || '?', mode: s.mode, segs: [] };
        trips.set(id, trip);
      }
      const coords = decodePolyline(s.polyline, 5);
      if (coords.length < 2) coords.push([s.to.lon, s.to.lat]);
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
      trip.segs.push({
        dep: Date.parse(s.departure), arr: Date.parse(s.arrival),
        coords, cum, total: cum[cum.length - 1],
        from: s.from, to: s.to, realTime: s.realTime,
      });
    }
    for (const t of trips.values()) t.segs.sort((a, b) => a.dep - b.dep);
    this.trips = trips;
    this.fetchedUntil = end.getTime();
    return { vehicles: this.positions(now), feedTime: now / 1000 };
  }

  // Posizione di ogni mezzo all'istante "now" (millisecondi)
  positions(now = Date.now()) {
    const list = [];
    for (const t of this.trips.values()) {
      let seg = null, frac = 0;
      for (const s of t.segs) {
        if (now >= s.dep && now <= s.arr) { seg = s; frac = s.arr > s.dep ? (now - s.dep) / (s.arr - s.dep) : 1; break; }
      }
      if (!seg) {
        // fermo a una fermata tra due tratti, oppure in partenza dal capolinea entro un minuto
        const next = t.segs.find((s) => s.dep > now);
        const prev = [...t.segs].reverse().find((s) => s.arr < now);
        if (next && (prev || next.dep - now < 60_000)) { seg = next; frac = 0; }
        else continue;
      }
      const target = frac * seg.total;
      let i = 1;
      while (i < seg.cum.length - 1 && seg.cum[i] < target) i++;
      const a = seg.coords[i - 1], b = seg.coords[i];
      const span = seg.cum[i] - seg.cum[i - 1];
      const f = span > 0 ? (target - seg.cum[i - 1]) / span : 0;
      const lng = a[0] + (b[0] - a[0]) * f, lat = a[1] + (b[1] - a[1]) * f;
      const raw = rawTripId(t.id);
      const info = tripInfo(raw);
      const route = info ? routeInfo(info.routeId) : null;
      list.push({
        id: 'e' + t.id,
        lng, lat,
        bearing: distance(a, b) > 1 ? bearing(a, b) : null,
        line: t.line,
        routeId: info ? info.routeId : (store.routeByName.get(t.line) || ''),
        type: route ? route.t : undefined,
        mode: t.mode,
        headsign: info ? info.headsign : '',
        dir: info ? info.dir : undefined,
        tripId: raw,
        ttTripId: t.id,
        nextStop: niceName(seg.to && seg.to.name),
        nextStopTime: seg.arr,
        realTime: seg.realTime,
        source: 'est',
      });
    }
    return list;
  }
}

// Cerca su Transitous la corsa di un mezzo GPS (serve per orari e fermate).
const ttCache = new Map();
export async function findTransitousTrip(v) {
  if (v.ttTripId) return v.ttTripId;
  if (ttCache.has(v.tripId)) return ttCache.get(v.tripId);
  const d = 0.006;
  const now = Date.now();
  const segs = await api.mapTrips(
    { south: v.lat - d, north: v.lat + d, west: v.lng - d, east: v.lng + d },
    new Date(now - 10 * 60_000), new Date(now + 10 * 60_000),
  );
  let found = null;
  for (const s of segs) for (const t of s.trips || []) {
    if (rawTripId(t.tripId) === v.tripId) found = t.tripId;
  }
  if (found) ttCache.set(v.tripId, found);
  return found;
}
