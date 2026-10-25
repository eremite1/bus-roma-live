// Lettore minimo del formato GTFS-Realtime (protobuf) per le posizioni dei veicoli.
// Legge solo i campi che servono alla mappa, senza librerie esterne.
// Riferimento: https://gtfs.org/realtime/reference/

class Reader {
  constructor(buf) {
    this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
    this.p = 0;
  }
  varint() {
    // Gestisce anche numeri oltre 32 bit (es. timestamp) senza perdere precisione fino a 2^53.
    let result = 0, mul = 1, byte;
    do {
      if (this.p >= this.b.length) throw new Error('varint oltre la fine');
      byte = this.b[this.p++];
      result += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80);
    return result;
  }
  float() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  double() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  bytes() {
    const len = this.varint();
    const s = this.b.subarray(this.p, this.p + len);
    this.p += len;
    return s;
  }
  string() { return TD.decode(this.bytes()); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) { const n = this.varint(); this.p += n; }
    else if (wire === 5) this.p += 4;
    else throw new Error('tipo di campo sconosciuto ' + wire);
  }
  // Scorre i campi di un messaggio chiamando fn(numeroCampo, tipo).
  each(end, fn) {
    while (this.p < end) {
      const key = this.varint();
      const field = Math.floor(key / 8), wire = key & 7;
      if (fn(field, wire) === false) this.skip(wire);
    }
  }
}
const TD = new TextDecoder();

function sub(r, fn) {
  const len = r.varint();
  const end = r.p + len;
  const out = {};
  r.each(end, (f, w) => fn(out, f, w));
  r.p = end;
  return out;
}

function tripDescriptor(r) {
  return sub(r, (o, f, w) => {
    if (f === 1 && w === 2) o.tripId = r.string();
    else if (f === 2 && w === 2) o.startTime = r.string();
    else if (f === 3 && w === 2) o.startDate = r.string();
    else if (f === 4 && w === 0) o.scheduleRelationship = r.varint();
    else if (f === 5 && w === 2) o.routeId = r.string();
    else if (f === 6 && w === 0) o.directionId = r.varint();
    else return false;
  });
}

function position(r) {
  return sub(r, (o, f, w) => {
    if (f === 1 && w === 5) o.lat = r.float();
    else if (f === 2 && w === 5) o.lon = r.float();
    else if (f === 3 && w === 5) o.bearing = r.float();
    else if (f === 4 && w === 1) o.odometer = r.double();
    else if (f === 5 && w === 5) o.speed = r.float();
    else return false;
  });
}

function vehicleDescriptor(r) {
  return sub(r, (o, f, w) => {
    if (f === 1 && w === 2) o.id = r.string();
    else if (f === 2 && w === 2) o.label = r.string();
    else if (f === 3 && w === 2) o.plate = r.string();
    else return false;
  });
}

function vehiclePosition(r) {
  return sub(r, (o, f, w) => {
    if (f === 1 && w === 2) o.trip = tripDescriptor(r);
    else if (f === 2 && w === 2) o.position = position(r);
    else if (f === 3 && w === 0) o.stopSequence = r.varint();
    else if (f === 4 && w === 0) o.status = r.varint();
    else if (f === 5 && w === 0) o.timestamp = r.varint();
    else if (f === 7 && w === 2) o.stopId = r.string();
    else if (f === 8 && w === 2) o.vehicle = vehicleDescriptor(r);
    else if (f === 9 && w === 0) o.occupancy = r.varint();
    else return false;
  });
}

/**
 * Decodifica un feed GTFS-RT e restituisce { timestamp, vehicles: [...] }.
 * Ogni veicolo: { id, lat, lon, bearing, speed, tripId, routeId, directionId,
 *                 label, stopId, status, occupancy, timestamp }
 */
export function decodeVehicleFeed(buffer) {
  const r = new Reader(buffer);
  const out = { timestamp: 0, vehicles: [] };
  r.each(r.b.length, (f, w) => {
    if (f === 1 && w === 2) {
      const h = sub(r, (o, hf, hw) => {
        if (hf === 3 && hw === 0) o.timestamp = r.varint();
        else return false;
      });
      out.timestamp = h.timestamp || 0;
    } else if (f === 2 && w === 2) {
      const e = sub(r, (o, ef, ew) => {
        if (ef === 1 && ew === 2) o.id = r.string();
        else if (ef === 4 && ew === 2) o.vp = vehiclePosition(r);
        else return false;
      });
      const vp = e.vp;
      if (!vp || !vp.position) return;
      const { lat, lon } = vp.position;
      if (!isFinite(lat) || !isFinite(lon) || (Math.abs(lat) < 0.1 && Math.abs(lon) < 0.1)) return;
      const t = vp.trip || {};
      const v = vp.vehicle || {};
      out.vehicles.push({
        id: v.id || e.id,
        label: v.label || v.id || '',
        lat, lon,
        bearing: vp.position.bearing,
        speed: vp.position.speed,
        tripId: t.tripId || '',
        routeId: t.routeId || '',
        directionId: t.directionId,
        stopId: vp.stopId || '',
        status: vp.status,
        occupancy: vp.occupancy,
        timestamp: vp.timestamp || 0,
      });
    } else return false;
  });
  return out;
}
