"""
Prepara i dati "fissi" della rete ATAC per la mappa (gira su GitHub una volta al giorno).

Scarica l'orario ufficiale (GTFS statico) di Roma Mobilità e crea tre file piccoli in data/:
  - routes.json : numero della linea, tipo di mezzo e colore per ogni linea
  - trips.json  : per ogni corsa del giorno -> linea, capolinea di destinazione, direzione
  - shapes.json : il disegno del percorso di ogni linea (andata e ritorno)
  - meta.json   : data di aggiornamento e numeri di controllo

Uso:  python tools/build_static.py            (scarica da internet)
      python tools/build_static.py file.zip   (usa un file già scaricato)
"""
import csv
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    ROME = ZoneInfo("Europe/Rome")
except Exception:  # pragma: no cover
    ROME = timezone(timedelta(hours=1))

SOURCES = [
    "https://romamobilita.it/sites/default/files/rome_static_gtfs.zip",
    # copia di riserva tenuta aggiornata da MobilityData
    "https://files.mobilitydatabase.org/mdb-1294/latest.zip",
]
DAYS_AHEAD = 2  # corse di oggi e dei prossimi giorni (se un giorno l'aggiornamento salta, la mappa funziona lo stesso)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")


def log(*a):
    print(*a, flush=True)


def download():
    last = None
    for url in SOURCES:
        try:
            log("Scarico", url)
            req = urllib.request.Request(url, headers={"User-Agent": "bus-roma-live/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            zipfile.ZipFile(io.BytesIO(data)).testzip()
            log(f"  ok, {len(data) / 1e6:.1f} MB")
            return data, url
        except Exception as e:  # prova la fonte successiva
            log("  non riuscito:", e)
            last = e
    raise SystemExit(f"Impossibile scaricare il GTFS: {last}")


def rows(z, name):
    """Legge un file CSV dentro lo zip riga per riga (anche se enorme)."""
    names = {os.path.basename(n): n for n in z.namelist()}
    if name not in names:
        return
    with z.open(names[name]) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))
        for row in reader:
            yield {k.strip(): (v or "").strip() for k, v in row.items() if k}


def active_services(z, days):
    """Restituisce gli service_id attivi in almeno uno dei giorni indicati."""
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    want = {d.strftime("%Y%m%d"): d for d in days}
    active = set()
    for r in rows(z, "calendar.txt"):
        for ds, d in want.items():
            if r.get("start_date", "") <= ds <= r.get("end_date", "") and r.get(wd[d.weekday()]) == "1":
                active.add(r["service_id"])
    for r in rows(z, "calendar_dates.txt"):
        if r.get("date") in want:
            if r.get("exception_type") == "1":
                active.add(r["service_id"])
    # (le eccezioni "servizio sospeso" non le togliamo: un servizio valido almeno un giorno resta incluso)
    return active


def simplify(points, tol=0.00004):
    """Riduce i punti di una linea (Douglas-Peucker), ~4 metri di tolleranza."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if L == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, idx = d, i
        if best > tol * tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points, precision=5):
    """Codifica [(lat, lon), ...] nel formato compatto 'polyline' di Google."""
    f = 10 ** precision
    out, plat, plon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * f), round(lon * f)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def clean_color(c, default):
    c = (c or "").lstrip("#")
    return c.upper() if len(c) == 6 else default


def main():
    if len(sys.argv) > 1:
        data, source = open(sys.argv[1], "rb").read(), sys.argv[1]
    else:
        data, source = download()
    z = zipfile.ZipFile(io.BytesIO(data))
    os.makedirs(OUT, exist_ok=True)

    today = datetime.now(ROME).date()
    # dalle 0 alle 4 di notte valgono ancora le corse "di ieri" (orari oltre le 24:00)
    days = [today + timedelta(days=i) for i in range(-1, DAYS_AHEAD)]
    services = active_services(z, days)
    log("Servizi attivi nei giorni considerati:", len(services))

    # --- linee ---
    routes = {}
    for r in rows(z, "routes.txt"):
        rtype = int(r.get("route_type") or 3)
        default_color = {0: "E3001B", 1: "E3001B", 2: "005C9E", 3: "8B1538", 7: "006B3F", 11: "8B1538"}.get(rtype, "8B1538")
        routes[r["route_id"]] = {
            "n": r.get("route_short_name") or r.get("route_long_name") or r["route_id"],
            "l": r.get("route_long_name", ""),
            "t": rtype,
            "c": clean_color(r.get("route_color"), default_color),
            "tc": clean_color(r.get("route_text_color"), "FFFFFF"),
        }
    log("Linee:", len(routes))

    # --- corse attive ---
    trips = {}
    for t in rows(z, "trips.txt"):
        if t.get("service_id") in services and t.get("route_id") in routes:
            trips[t["trip_id"]] = t
    log("Corse attive:", len(trips))
    if not trips:
        raise SystemExit("Nessuna corsa attiva trovata: il GTFS potrebbe essere scaduto.")

    # --- fermate e ultima fermata di ogni corsa (per sapere il capolinea) ---
    stop_names, stop_pos = {}, {}
    for s_ in rows(z, "stops.txt"):
        stop_names[s_["stop_id"]] = s_.get("stop_name", "")
        try:
            stop_pos[s_["stop_id"]] = (round(float(s_["stop_lon"]), 6), round(float(s_["stop_lat"]), 6))
        except (KeyError, ValueError):
            pass
    last_stop = {}
    for st in rows(z, "stop_times.txt"):
        tid = st.get("trip_id")
        if tid in trips:
            seq = int(st.get("stop_sequence") or 0)
            cur = last_stop.get(tid)
            if cur is None or seq > cur[0]:
                last_stop[tid] = (seq, st.get("stop_id"))

    small = {"di", "de", "del", "della", "dello", "dei", "degli", "delle", "e", "a", "al", "alla", "ai",
             "da", "dal", "dalla", "in", "su", "sul", "per", "lo", "la", "le", "il", "l'"}

    def nice(name):
        """'PIAZZA DEI CINQUECENTO' -> 'Piazza dei Cinquecento'; sigle come (MA-MB-FS) restano uguali."""
        name = " ".join((name or "").split())
        if not name.isupper():
            return name
        def fix(w, i):
            if "/" in w:
                return "/".join(fix(x, 0) for x in w.split("/"))
            if any(c.isdigit() for c in w) or any(c in w for c in "()-"):
                return w
            if i > 0 and w.lower() in small:
                return w.lower()
            return w.capitalize()

        out = [fix(w, i) for i, w in enumerate(name.split(" "))]
        return " ".join(out)

    headsigns, h_index = [], {}
    route_ids, r_index = [], {}

    def idx(value, lst, index):
        if value not in index:
            index[value] = len(lst)
            lst.append(value)
        return index[value]

    compact = {}
    shape_use = defaultdict(Counter)  # (route, direzione) -> conteggio shape
    shape_head = {}
    shape_trip = {}  # una corsa "tipo" per ogni percorso (serve per l'elenco delle fermate)
    for tid, t in trips.items():
        h = t.get("trip_headsign") or ""
        if not h and tid in last_stop:
            h = stop_names.get(last_stop[tid][1], "")
        h = nice(h)
        d = t.get("direction_id")
        d = int(d) if d in ("0", "1") else -1
        sid = t.get("shape_id") or ""
        compact[tid] = [
            idx(t["route_id"], route_ids, r_index),
            idx(h, headsigns, h_index),
            d,
        ]
        if sid:
            shape_use[(t["route_id"], d)][sid] += 1
            shape_head[sid] = h
            shape_trip.setdefault(sid, tid)

    # --- percorsi: per ogni linea e direzione teniamo il percorso più usato ---
    wanted = {}
    for (rid, d), cnt in shape_use.items():
        sid = cnt.most_common(1)[0][0]
        wanted[sid] = (rid, d)
    pts = defaultdict(list)
    for s in rows(z, "shapes.txt"):
        sid = s.get("shape_id")
        if sid in wanted:
            pts[sid].append((int(s.get("shape_pt_sequence") or 0), float(s["shape_pt_lat"]), float(s["shape_pt_lon"])))
    shapes = defaultdict(list)
    for sid, plist in pts.items():
        plist.sort()
        line = simplify([(la, lo) for _, la, lo in plist])
        rid, d = wanted[sid]
        shapes[rid].append({"d": d, "h": shape_head.get(sid, ""), "p": encode_polyline(line)})
    log("Percorsi:", sum(len(v) for v in shapes.values()))

    # --- fermate in ordine per ogni linea e direzione (per il navigatore) ---
    rep_trips = {shape_trip[sid]: sid for sid in wanted if sid in shape_trip}
    seqs = defaultdict(list)
    for st in rows(z, "stop_times.txt"):
        tid = st.get("trip_id")
        if tid in rep_trips:
            seqs[tid].append((int(st.get("stop_sequence") or 0), st.get("stop_id")))
    linestops = defaultdict(list)
    for tid, lst in seqs.items():
        lst.sort()
        sid = rep_trips[tid]
        rid, d = wanted[sid]
        stops_out = [[*stop_pos[x], nice(stop_names.get(x, ""))] for _, x in lst if x in stop_pos]
        linestops[rid].append({"d": d, "h": shape_head.get(sid, ""), "s": stops_out})
    log("Fermate per linea:", sum(len(v) for v in linestops.values()))

    used_routes = {rid: routes[rid] for rid in route_ids}
    # aggiungiamo anche le linee senza corse oggi (per riconoscere il numero dal codice linea)
    for rid, r in routes.items():
        used_routes.setdefault(rid, r)

    def dump(name, obj):
        path = os.path.join(OUT, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        log(f"Scritto {name}: {os.path.getsize(path) / 1e6:.2f} MB")

    dump("routes.json", used_routes)
    dump("trips.json", {"routes": route_ids, "headsigns": headsigns, "trips": compact})
    dump("shapes.json", shapes)
    dump("linestops.json", linestops)
    dump("meta.json", {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "days": [d.isoformat() for d in days],
        "routes": len(used_routes),
        "trips": len(compact),
    })


if __name__ == "__main__":
    main()
