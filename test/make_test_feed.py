"""Crea un feed GTFS-RT di prova usando la libreria ufficiale protobuf
(serve solo per verificare il lettore js/gtfsrt.js)."""
import sys, json
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

F = descriptor_pb2.FieldDescriptorProto
fdp = descriptor_pb2.FileDescriptorProto(name="gtfsrt_test.proto", package="t", syntax="proto2")

def msg(name, fields):
    m = fdp.message_type.add(name=name)
    for (fname, num, ftype, label, tname) in fields:
        f = m.field.add(name=fname, number=num, type=ftype, label=label)
        if tname:
            f.type_name = ".t." + tname
OPT, REP = F.LABEL_OPTIONAL, F.LABEL_REPEATED
msg("FeedHeader", [("gtfs_realtime_version", 1, F.TYPE_STRING, OPT, None), ("timestamp", 3, F.TYPE_UINT64, OPT, None)])
msg("TripDescriptor", [("trip_id", 1, F.TYPE_STRING, OPT, None), ("start_time", 2, F.TYPE_STRING, OPT, None),
                       ("start_date", 3, F.TYPE_STRING, OPT, None), ("schedule_relationship", 4, F.TYPE_INT32, OPT, None),
                       ("route_id", 5, F.TYPE_STRING, OPT, None), ("direction_id", 6, F.TYPE_UINT32, OPT, None)])
msg("Position", [("latitude", 1, F.TYPE_FLOAT, OPT, None), ("longitude", 2, F.TYPE_FLOAT, OPT, None),
                 ("bearing", 3, F.TYPE_FLOAT, OPT, None), ("odometer", 4, F.TYPE_DOUBLE, OPT, None),
                 ("speed", 5, F.TYPE_FLOAT, OPT, None)])
msg("VehicleDescriptor", [("id", 1, F.TYPE_STRING, OPT, None), ("label", 2, F.TYPE_STRING, OPT, None)])
msg("VehiclePosition", [("trip", 1, F.TYPE_MESSAGE, OPT, "TripDescriptor"), ("position", 2, F.TYPE_MESSAGE, OPT, "Position"),
                        ("current_stop_sequence", 3, F.TYPE_UINT32, OPT, None), ("current_status", 4, F.TYPE_INT32, OPT, None),
                        ("timestamp", 5, F.TYPE_UINT64, OPT, None), ("congestion_level", 6, F.TYPE_INT32, OPT, None),
                        ("stop_id", 7, F.TYPE_STRING, OPT, None),
                        ("vehicle", 8, F.TYPE_MESSAGE, OPT, "VehicleDescriptor"), ("occupancy_status", 9, F.TYPE_INT32, OPT, None)])
msg("TripUpdate", [("trip", 1, F.TYPE_MESSAGE, OPT, "TripDescriptor")])
msg("FeedEntity", [("id", 1, F.TYPE_STRING, OPT, None), ("is_deleted", 2, F.TYPE_BOOL, OPT, None),
                   ("trip_update", 3, F.TYPE_MESSAGE, OPT, "TripUpdate"),
                   ("vehicle", 4, F.TYPE_MESSAGE, OPT, "VehiclePosition")])
msg("FeedMessage", [("header", 1, F.TYPE_MESSAGE, OPT, "FeedHeader"), ("entity", 2, F.TYPE_MESSAGE, REP, "FeedEntity")])

pool = descriptor_pool.DescriptorPool()
pool.Add(fdp)
FeedMessage = message_factory.GetMessageClass(pool.FindMessageTypeByName("t.FeedMessage"))

def build(vehicles, ts=1793000000):
    fm = FeedMessage()
    fm.header.gtfs_realtime_version = "2.0"
    fm.header.timestamp = ts
    # un'entità "trip_update" da ignorare
    e = fm.entity.add(id="tu1"); e.trip_update.trip.trip_id = "x"
    for v in vehicles:
        e = fm.entity.add(id="e" + v["id"])
        vp = e.vehicle
        if v.get("trip_id"): vp.trip.trip_id = v["trip_id"]
        if v.get("route_id"): vp.trip.route_id = v["route_id"]
        if v.get("direction_id") is not None: vp.trip.direction_id = v["direction_id"]
        vp.position.latitude = v["lat"]; vp.position.longitude = v["lon"]
        if v.get("bearing") is not None: vp.position.bearing = v["bearing"]
        vp.position.odometer = 12345.5
        vp.current_stop_sequence = 7
        vp.current_status = 2
        vp.timestamp = ts - 20
        vp.congestion_level = 1
        vp.stop_id = v.get("stop_id", "")
        vp.vehicle.id = v["id"]; vp.vehicle.label = "L" + v["id"]
        vp.occupancy_status = 1
    return fm.SerializeToString()

if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    open(sys.argv[2], "wb").write(build(spec["vehicles"], spec.get("ts", 1793000000)))
