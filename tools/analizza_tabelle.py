"""Analisi una tantum: elenca TUTTE le tabelle (codici) presenti nell'archivio ATAC, con i giorni
in cui girano, per capire come ATAC numera le tabelle. Scrive analisi/tabelle_tutte.json."""
import json, os, sys, zipfile, io
from collections import defaultdict
from datetime import date, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_static import download, rows

data, url = download()
z = zipfile.ZipFile(io.BytesIO(data))
wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
d0 = None
svc_dates = defaultdict(set)
for r in rows(z, "calendar.txt"):
    a, b = r["start_date"], r["end_date"]
    d = date(int(a[:4]), int(a[4:6]), int(a[6:]))
    e = date(int(b[:4]), int(b[4:6]), int(b[6:]))
    while d <= e:
        if r.get(wd[d.weekday()]) == "1":
            svc_dates[r["service_id"]].add(d.isoformat())
        d += timedelta(days=1)
for r in rows(z, "calendar_dates.txt"):
    ds = r["date"]; iso = f"{ds[:4]}-{ds[4:6]}-{ds[6:]}"
    if r.get("exception_type") == "1": svc_dates[r["service_id"]].add(iso)
    else: svc_dates[r["service_id"]].discard(iso)
routes = {r["route_id"]: r.get("route_short_name") or r["route_id"] for r in rows(z, "routes.txt")}
trips = {}
for r in rows(z, "trips.txt"):
    trips[r["trip_id"]] = (r["route_id"], r["service_id"])
first = {}
for r in rows(z, "stop_times.txt"):
    tid = r["trip_id"]; t = r.get("departure_time") or r.get("arrival_time")
    if not t: continue
    f = first.get(tid)
    if f is None: first[tid] = [t, t]
    else:
        if t.zfill(8) < f[0].zfill(8): f[0] = t
        if t.zfill(8) > f[1].zfill(8): f[1] = t
out = {}
for tid, (rid, sid) in trips.items():
    if "#" not in tid or "-" not in tid: continue
    k = tid.rsplit("-", 1)[0]
    o = out.setdefault(k, {"lines": defaultdict(int), "svc": set(), "start": "99", "end": "00", "n": 0})
    o["lines"][routes.get(rid, rid)] += 1; o["svc"].add(sid); o["n"] += 1
    ft = first.get(tid)
    if ft:
        if ft[0].zfill(8) < o["start"].zfill(8): o["start"] = ft[0][:5]
        if ft[1].zfill(8) > o["end"].zfill(8): o["end"] = ft[1][:5]
res = {}
for k, o in out.items():
    dates = sorted(set().union(*[svc_dates.get(s, set()) for s in o["svc"]]))
    res[k] = {"lines": dict(o["lines"]), "start": o["start"], "end": o["end"], "n": o["n"], "svc": sorted(o["svc"]), "dates": dates}
os.makedirs("analisi", exist_ok=True)
json.dump({"fonte": url, "tabelle": res}, open("analisi/tabelle_tutte.json", "w"), separators=(",", ":"))
print("tabelle:", len(res))
