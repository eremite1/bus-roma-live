import sys, time
sys.path.insert(0, sys.path[0])
from make_test_feed import build_trip_updates
now = int(time.time())
ups = [
  {"trip_id": "T64A", "route_id": "R64", "vehicle_id": "3456", "stops": [(1, "S1", now - 300, 60), (2, "S2", now + 60, 240), (3, "S3", now + 400, 300)]},
  {"trip_id": "T64B", "vehicle_id": "3457", "stops": [(2, "S5", now + 100, -120)]},
  {"trip_id": "T8A", "delay": 420},
  {"trip_id": "TX", "stops": [(1, "S1", now + 100, None)]},
  {"trip_id": "Z1", "vehicle_id": "4406", "stops": [(4, "S3", now + 200, 360)]},
  {"trip_id": "TOLD", "stops": [(1, "S1", now - 900, 30)]},
]
open(sys.argv[1], "wb").write(build_trip_updates(ups, now))
