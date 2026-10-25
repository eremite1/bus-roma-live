"""Feed GPS di prova con tanti mezzi sparsi per Roma. Uso: make_gps_feed.py out.pb seed shift"""
import sys, random, json, time
sys.path.insert(0, sys.path[0])
from make_test_feed import build
out, seed, shift = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
rnd = random.Random(seed)
routes = ["R64", "R8", "R40", "R30", "R87", "R2", "RN1", "R60", "R714", "R492", "R3", "RC3"]
vs = []
# mezzi "veri" collegati alle corse del GTFS di prova
vs.append({"id": "3456", "trip_id": "T64A", "route_id": "R64", "lat": 41.8999 - shift * 0.3, "lon": 12.4920 - shift, "stop_id": "S2"})
vs.append({"id": "3457", "trip_id": "T64B", "route_id": "R64", "lat": 41.8977, "lon": 12.4706 + shift})
vs.append({"id": "8001", "trip_id": "T8A", "route_id": "R8", "lat": 41.8900 - shift, "lon": 12.4730 - shift * 0.5})
for i in range(420):
    r = rnd.Random() if False else rnd
    lat = 41.9 + rnd.gauss(0, 0.045); lon = 12.49 + rnd.gauss(0, 0.06)
    ang = rnd.random() * 6.28
    import math
    vs.append({"id": str(4000 + i), "route_id": rnd.choice(routes),
               "lat": lat + math.sin(ang) * shift * 0.4, "lon": lon + math.cos(ang) * shift * 0.4,
               "bearing": 0})
open(out, "wb").write(build(vs, int(time.time()) - 25))
