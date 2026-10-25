"""Crea un piccolo GTFS finto (2 linee) per provare tools/build_static.py e la mappa."""
import io, sys, zipfile
from datetime import datetime, timedelta

today = datetime.now()
dates = [(today + timedelta(days=i)).strftime("%Y%m%d") for i in range(-1, 3)]

stops = [
    ("S1", "TERMINI (MA-MB-FS)", 41.9009, 12.5003),
    ("S2", "NAZIONALE/QUIRINALE", 41.8999, 12.4920),
    ("S3", "PIAZZA VENEZIA", 41.8960, 12.4823),
    ("S4", "ARGENTINA", 41.8955, 12.4767),
    ("S5", "CORSO VITTORIO EMANUELE/NAVONA", 41.8977, 12.4706),
    ("S6", "SAN PIETRO", 41.9022, 12.4567),
    ("S7", "TRASTEVERE/MINISTERO ISTRUZIONE", 41.8838, 12.4692),
    ("S8", "CASALETTO", 41.8690, 12.4430),
]
files = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nATAC,ATAC,https://atac.roma.it,Europe/Rome\n",
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n"
                  "R64,ATAC,64,,3,,\nR8,ATAC,8,,0,,\nR40,ATAC,40,,3,,\nR30,ATAC,30,,3,,\nR87,ATAC,87,,3,,\nR2,ATAC,2,,0,,\nRN1,ATAC,n1,,3,,\nR60,ATAC,60,,3,,\nR714,ATAC,714,,3,,\nR492,ATAC,492,,3,,\nR3,ATAC,3,,0,,\nRC3,ATAC,C3,,3,,\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n" + "".join(f"{a},{b},{c},{d}\n" for a, b, c, d in stops),
    "calendar_dates.txt": "service_id,date,exception_type\n" + "".join(f"FER,{d},1\n" for d in dates) + "OLD,20200101,1\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n"
                 "R64,FER,T64A,,0,SH64A\nR64,FER,T64B,,1,SH64B\nR8,FER,T8A,CASALETTO,0,SH8A\nR40,OLD,T40X,,0,\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                      "T64A,08:00:00,08:00:00,S1,1\nT64A,08:05:00,08:05:00,S2,2\nT64A,08:10:00,08:10:00,S3,3\nT64A,08:14:00,08:14:00,S5,4\nT64A,08:22:00,08:22:00,S6,5\n"
                      "T64B,08:00:00,08:00:00,S6,1\nT64B,08:08:00,08:08:00,S5,2\nT64B,08:12:00,08:12:00,S3,3\nT64B,08:22:00,08:22:00,S1,4\n"
                      "T8A,08:00:00,08:00:00,S4,1\nT8A,08:08:00,08:08:00,S7,2\nT8A,08:20:00,08:20:00,S8,3\n",
}
def shape(sid, ids):
    pts = [next(s for s in stops if s[0] == i) for i in ids]
    out, seq = [], 0
    for a, b in zip(pts, pts[1:]):
        for k in range(10):
            t = k / 10
            seq += 1
            out.append(f"{sid},{a[2] + (b[2]-a[2])*t:.6f},{a[3] + (b[3]-a[3])*t:.6f},{seq}\n")
    seq += 1
    out.append(f"{sid},{pts[-1][2]},{pts[-1][3]},{seq}\n")
    return "".join(out)
files["shapes.txt"] = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" + shape("SH64A", ["S1","S2","S3","S5","S6"]) + \
    shape("SH64B", ["S6","S5","S3","S1"]) + shape("SH8A", ["S4","S7","S8"])

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    for n, c in files.items():
        z.writestr(n, c)
open(sys.argv[1], "wb").write(buf.getvalue())
