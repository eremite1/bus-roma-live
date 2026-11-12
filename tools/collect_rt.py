"""
ARCHIVIO STORICO — gira su GitHub ogni 10 minuti.
Scarica posizioni GPS e previsioni ATAC e somma, per ogni linea e per ogni ora del giorno:
  m = mezzi in servizio (somma sui rilevamenti), k = rilevamenti,
  n = corse con ritardo noto, s = somma dei ritardi (minuti), l = corse con 5+ min di ritardo, e = corse in anticipo.
Una volta al giorno salva anche il riepilogo delle tabelle (quante, prima uscita, ultimo rientro) per seguire i cambi d'orario.

Uso: python tools/collect_rt.py <cartella-archivio>
"""
import json, os, sys, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
from google.transit import gtfs_realtime_pb2

ROME = ZoneInfo("Europe/Rome")
BASE = "https://romamobilita.it/sites/default/files/"
FEEDS = {
    "vehicles": ["rome_rtgtfs_vehicle_positions_feed.pb", "rome_gtfs_rt_vehicle_positions.pb"],
    "trips": ["rome_rtgtfs_trip_updates_feed.pb", "rome_gtfs_rt_trip_updates.pb"],
}
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")


def feed(name):
    for f in FEEDS[name]:
        try:
            req = urllib.request.Request(BASE + f, headers={"User-Agent": "bus-roma-live archivio"})
            with urllib.request.urlopen(req, timeout=60) as r:
                m = gtfs_realtime_pb2.FeedMessage()
                m.ParseFromString(r.read())
                return m
        except Exception as e:
            print("  non riuscito", f, e)
    return None


def main():
    out_dir = sys.argv[1]
    now = datetime.now(ROME)
    routes = json.load(open(os.path.join(HERE, "routes.json")))
    t = json.load(open(os.path.join(HERE, "trips.json")))
    trip_line = {tid: routes.get(t["routes"][v[0]], {}).get("n") for tid, v in t["trips"].items()}

    def line_of(trip_id, route_id):
        return trip_line.get(trip_id) or routes.get(route_id, {}).get("n") or route_id or None

    path = os.path.join(out_dir, now.strftime("%Y-%m"), now.strftime("%d") + ".json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    day = json.load(open(path)) if os.path.exists(path) else {"data": now.strftime("%Y-%m-%d"), "giorno": now.strftime("%a"), "linee": {}}
    hour = str(now.hour)

    def cell(line):
        return day["linee"].setdefault(line, {}).setdefault(hour, {"m": 0, "k": 0, "n": 0, "s": 0, "l": 0, "e": 0})

    vp = feed("vehicles")
    if vp:
        traccia_spenti(out_dir, vp, line_of, now)
        count = {}
        for e in vp.entity:
            if not e.HasField("vehicle"):
                continue
            v = e.vehicle
            line = line_of(v.trip.trip_id, v.trip.route_id)
            if line:
                count[line] = count.get(line, 0) + 1
        for line, c in count.items():
            x = cell(line); x["m"] += c; x["k"] += 1
        print("Mezzi:", sum(count.values()), "su", len(count), "linee")

    tu = feed("trips")
    if tu:
        ts = now.timestamp()
        n = 0
        for e in tu.entity:
            if not e.HasField("trip_update"):
                continue
            u = e.trip_update
            delay = None
            for st in u.stop_time_update:
                ev = st.arrival if st.HasField("arrival") else st.departure
                if ev.HasField("delay") and (not ev.HasField("time") or ev.time >= ts - 30):
                    delay = ev.delay
                    break
            if delay is None and u.HasField("delay"):
                delay = u.delay
            line = line_of(u.trip.trip_id, u.trip.route_id)
            if delay is None or not line or abs(delay) > 7200:
                continue
            d = round(delay / 60)
            x = cell(line); x["n"] += 1; x["s"] += d; x["l"] += d >= 5; x["e"] += d <= -1
            n += 1
        print("Corse con ritardo noto:", n)

    json.dump(day, open(path, "w"), ensure_ascii=False, separators=(",", ":"))

    # riepilogo tabelle (una volta al giorno): per seguire i cambiamenti d'orario negli anni
    tab_path = os.path.join(out_dir, "tabelle", now.strftime("%Y-%m-%d") + ".json")
    blocks_file = os.path.join(HERE, "blocks.json")
    if not os.path.exists(tab_path) and os.path.exists(blocks_file):
        os.makedirs(os.path.dirname(tab_path), exist_ok=True)
        blocks = json.load(open(blocks_file))
        summary = {}
        for b, trips in blocks.items():
            for c in trips:
                s = summary.setdefault(c[3], {"tabelle": set(), "corse": 0, "prima": "99:99", "ultima": "00:00"})
                s["tabelle"].add(b); s["corse"] += 1
                s["prima"] = min(s["prima"], c[1].zfill(5)); s["ultima"] = max(s["ultima"], c[2].zfill(5))
        for s in summary.values():
            s["tabelle"] = len(s["tabelle"])
        json.dump(summary, open(tab_path, "w"), ensure_ascii=False, separators=(",", ":"))
        print("Riepilogo tabelle salvato")


def traccia_spenti(out_dir, vp, line_of, now):
    """Ricorda l'ultima posizione di ogni vettura. Quelle che non trasmettono da oltre 10 minuti
    (fino a 8 ore) finiscono in spenti.json: la mappa le mostra in nero."""
    path = os.path.join(out_dir, "ultimi.json")
    ultimi = json.load(open(path)) if os.path.exists(path) else {}
    nowts = int(now.timestamp())
    stat = {"totale": 0, "senza_corsa": 0, "senza_corsa_in_moto": 0, "vecchi": 0}
    for e in vp.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        vid = v.vehicle.id or e.id
        ts = int(v.timestamp or vp.header.timestamp or nowts)
        stat["totale"] += 1
        if not v.trip.trip_id:
            stat["senza_corsa"] += 1
            if v.position.speed and v.position.speed > 1:
                stat["senza_corsa_in_moto"] += 1
        if nowts - ts > 600:
            stat["vecchi"] += 1
        old = ultimi.get(vid)
        if old and old[4] >= ts:
            continue
        trip = v.trip.trip_id or (old[5] if old else "")
        ultimi[vid] = [v.vehicle.label or vid, round(v.position.latitude, 5), round(v.position.longitude, 5),
                       round(v.position.bearing or 0), ts, trip, line_of(trip, v.trip.route_id) or (old[6] if old else "")]
    ultimi = {k: x for k, x in ultimi.items() if nowts - x[4] < 8 * 3600}
    json.dump(ultimi, open(path, "w"), separators=(",", ":"))
    spenti = {k: x for k, x in ultimi.items() if nowts - x[4] > 600}
    json.dump({"agg": nowts, "stat": stat, "spenti": spenti}, open(os.path.join(out_dir, "spenti.json"), "w"), separators=(",", ":"))
    print("Spenti:", len(spenti), stat)


if __name__ == "__main__":
    main()
