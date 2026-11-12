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
    # per le tabelle servono anche i prossimi 7 giorni (scelta del giorno in Rientri/Uscite)
    week = [today + timedelta(days=i) for i in range(0, 7)]
    week_services = {d: active_services(z, [d]) for d in week}
    all_week = set().union(*week_services.values())
    btrips = {}
    for t in rows(z, "trips.txt"):
        if t.get("service_id") in all_week and t.get("route_id") in routes:
            btrips[t["trip_id"]] = t
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
    first_stop = {}  # per le tabelle: orario e fermata di partenza di ogni corsa
    for st in rows(z, "stop_times.txt"):
        tid = st.get("trip_id")
        if tid in trips or tid in btrips:
            seq = int(st.get("stop_sequence") or 0)
            cur = last_stop.get(tid)
            if cur is None or seq > cur[0]:
                last_stop[tid] = (seq, st.get("stop_id"), st.get("arrival_time") or st.get("departure_time") or "")
            cur = first_stop.get(tid)
            if cur is None or seq < cur[0]:
                first_stop[tid] = (seq, st.get("stop_id"), st.get("departure_time") or st.get("arrival_time") or "")

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

    # --- tabelle (turni macchina): tutte le corse fatte dallo stesso bus nella giornata ---
    # ATAC non usa la colonna block_id: la tabella è la parte del codice corsa prima dell'ultimo "-"
    # (es. "0#3737-5" -> tabella "0#3737", corsa n. 5).
    hm = lambda t: t[:5] if len(t) >= 5 else t
    import re as _re
    is_coll = lambda n: bool(_re.fullmatch(r"[A-Z]\d{2}", n or ""))

    def make_blocks(svcs):
        bl = defaultdict(list)
        for tid, t in btrips.items():
            if t.get("service_id") not in svcs or tid not in first_stop:
                continue
            key = t.get("block_id") or (tid.rsplit("-", 1)[0] if "#" in tid and "-" in tid else "")
            if not key:
                continue
            f, l = first_stop[tid], last_stop.get(tid, (0, "", ""))
            bl[key].append([tid, hm(f[2]), hm(l[2]), routes[t["route_id"]]["n"], nice(stop_names.get(f[1], "")),
                            nice(stop_names.get(l[1], "")), f[1], l[1]])
        for v in bl.values():
            v.sort(key=lambda c: c[1].zfill(5))
        return bl

    def mins(t):
        h, m = t.split(":")[:2]
        return int(h) * 60 + int(m)

    def km(a, b):
        from math import radians, cos, sqrt
        dx = (a[0] - b[0]) * 111.32 * cos(radians((a[1] + b[1]) / 2))
        dy = (a[1] - b[1]) * 110.57
        return sqrt(dx * dx + dy * dy)

    def rimessa(bl):
        """Tempi deposito <-> capolinea per ogni deposito (lettera del collegamento):
        dai collegamenti veri quando esistono, altrimenti stimati dalla distanza."""
        from statistics import median
        depot_stop = defaultdict(lambda: defaultdict(int))
        coll_min = defaultdict(list)  # (deposito, fermata) -> minuti
        speed = []
        line_dep = defaultdict(lambda: defaultdict(int))
        for trips_ in bl.values():
            for i, t in enumerate(trips_):
                if not is_coll(t[3]):
                    continue
                D = t[3][0]
                # uscita: il collegamento parte dal deposito; rientro: ci arriva
                exit_ = i + 1 < len(trips_) and not is_coll(trips_[i + 1][3])
                dstop, other = (t[6], t[7]) if exit_ else (t[7], t[6])
                depot_stop[D][dstop] += 1
            for t in trips_:
                if is_coll(t[3]):
                    for u in trips_:
                        if not is_coll(u[3]):
                            line_dep[u[3]][t[3][0]] += 1
                    break
        dpos = {D: stop_pos.get(max(c, key=c.get)) for D, c in depot_stop.items()}
        # fattore orario del traffico: quanto durano le corse a ogni ora rispetto alla loro durata tipica
        # (dagli orari ATAC stessi: nelle ore di punta le corse sono programmate più lunghe)
        by_key = defaultdict(list)
        for trips_ in bl.values():
            for t in trips_:
                if not is_coll(t[3]):
                    d_ = mins(t[2]) - mins(t[1])
                    if d_ > 0:
                        by_key[(t[3], t[6], t[7])].append((mins(t[1]) // 60, d_))
        ratios = defaultdict(list)
        for v in by_key.values():
            if len(v) < 4:
                continue
            med = median(x[1] for x in v)
            for h, d_ in v:
                ratios[h % 24].append(d_ / med)
        fatt = [round(median(ratios[h]), 3) if len(ratios[h]) > 20 else None for h in range(24)]
        known = [f for f in fatt if f]
        base = min(known) if known else 1.0  # ora più scorrevole = 1
        fatt = [round((f or base) / base, 3) for f in fatt]
        fh = lambda m: fatt[(m // 60) % 24]
        for trips_ in bl.values():
            for t in trips_:
                if not is_coll(t[3]):
                    continue
                D = t[3][0]
                dur = mins(t[2]) - mins(t[1])
                if dur <= 0 or not dpos.get(D):
                    continue
                for sid in (t[6], t[7]):
                    p = stop_pos.get(sid)
                    if p and km(p, dpos[D]) > 0.4:
                        coll_min[(D, sid)].append(dur / fh(mins(t[1])))  # tempo "a strade libere"
                        speed.append(dur / fh(mins(t[1])) / max(km(p, dpos[D]), 0.5))
        k = median(speed) if speed else 3.0  # minuti per km in linea d'aria, a strade libere
        out = {"depositi": {D: list(p) for D, p in dpos.items() if p}, "lineaDeposito": {}, "tempi": {}, "fattoreOra": fatt}
        for L, c in line_dep.items():
            out["lineaDeposito"][L] = max(c, key=c.get)
        coll_pos = defaultdict(list)
        for (D, sid), v in coll_min.items():
            if stop_pos.get(sid):
                coll_pos[D].append((stop_pos[sid], median(v)))
        for trips_ in bl.values():
            D = next((t[3][0] for t in trips_ if is_coll(t[3])), None) or out["lineaDeposito"].get(next((t[3] for t in trips_ if not is_coll(t[3])), ""))
            if not D or not dpos.get(D):
                continue
            tab = out["tempi"].setdefault(D, {})
            for t in trips_:
                for sid, name in ((t[6], t[4]), (t[7], t[5])):
                    if name in tab or not stop_pos.get(sid):
                        continue
                    p = stop_pos[sid]
                    dist = km(p, dpos[D])
                    if dist < 0.4:
                        tab[name] = [0, 0]  # fermata del deposito
                        continue
                    near = [m for q, m in coll_pos[D] if km(q, p) < 0.5]
                    # minuti a strade libere: l'app li moltiplica per il fattore dell'ora
                    tab[name] = [round(median(near), 1), 1] if near else [round(2 + dist * k, 1), 2]
        out["minutiPerKm"] = round(k, 2)
        return out

    def slim(bl):
        return {b: [t[:6] for t in v] for b, v in bl.items()}

    gdir = os.path.join(OUT, "giorni")
    os.makedirs(gdir, exist_ok=True)
    for f_ in os.listdir(gdir):
        os.remove(os.path.join(gdir, f_))
    index = []
    for d in week:
        bl = make_blocks(week_services[d])
        if not bl:
            continue
        rim = rimessa(bl)
        if d == today:
            log("Tabelle di oggi:", len(bl))
            dump("blocks.json", slim(bl))
            dump("rimessa.json", rim)
        dump(f"giorni/{d.isoformat()}.json", {"blocks": slim(bl), "rimessa": rim})
        index.append(d.isoformat())
    dump("giorni/indice.json", index)
    dump("meta.json", {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "days": [d.isoformat() for d in days],
        "routes": len(used_routes),
        "trips": len(compact),
    })


if __name__ == "__main__":
    main()
