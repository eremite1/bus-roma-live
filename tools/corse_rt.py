"""Raccolta continua (gira per quasi 6 ore, poi riparte da sola):
 - ritardo/anticipo di ogni corsa alla partenza e all'arrivo -> archivio/corse/AAAA-MM-GG/hHH.json
   (HH = ora di arrivo prevista; chiave "linea@HH:MM>capolinea di partenza", uguale ai nomi delle tabelle)
 - vetture che smettono di trasmettere -> archivio/spenti.json (ogni ~10 minuti)
Uso: python tools/corse_rt.py <cartella archivio> <minuti di durata>"""
import json, os, subprocess, sys, time
from datetime import datetime, timedelta
from collect_rt import feed, traccia_spenti, ROME, HERE

ARCH = sys.argv[1]
DURATA = int(sys.argv[2]) if len(sys.argv) > 2 else 340
PEND = os.path.join(ARCH, "corse", "_in_corso.json")


def sh(*a):
    return subprocess.run(a, cwd=ARCH, capture_output=True, text=True)


def salva(msg):
    sh("git", "add", "-A")
    if sh("git", "commit", "-q", "-m", msg).returncode != 0:
        return
    for _ in range(4):
        sh("git", "fetch", "-q", "origin", "storico")
        sh("git", "rebase", "-q", "-X", "theirs", "origin/storico")
        if sh("git", "push", "-q", "origin", "HEAD:storico").returncode == 0:
            return
        time.sleep(5)
    print("push non riuscito")


def mins(t):
    h, m = t.split(":")[:2]
    return int(h) * 60 + int(m)


BLOCKS, POS, RIM = {}, {}, {}


def is_coll(line):
    return len(line) == 3 and line[0].isalpha() and line[1:].isdigit()


def carica_tabelle():
    """corsa -> (chiave, data di servizio, ora di arrivo prevista in minuti) dalle tabelle di oggi e di ieri."""
    idx = {}
    try:
        raw = subprocess.run(["git", "show", "origin/main:data/rimessa.json"], cwd=os.path.dirname(HERE), capture_output=True, text=True).stdout
        RIM.clear(); RIM.update(json.loads(raw))
    except Exception as e:
        print("rimessa non disponibile", e)
    for nome in ("blocks.json",):
        try:
            subprocess.run(["git", "fetch", "-q", "origin", "main"], cwd=os.path.dirname(HERE))
            raw = subprocess.run(["git", "show", "origin/main:data/" + nome], cwd=os.path.dirname(HERE), capture_output=True, text=True).stdout
            blocks = json.loads(raw)
        except Exception as e:
            print("tabelle non disponibili", e)
            continue
        BLOCKS.clear(); BLOCKS.update(blocks); POS.clear()
        for b, trips in blocks.items():
            for i, t in enumerate(trips):
                POS[t[0]] = (b, i)
            for t in trips:
                tid, start, end, line, frm = t[0], t[1], t[2], t[3], t[4]
                idx[tid] = (f"{line}@{start}>{frm}", mins(end))
    return idx


def dist_m(a, b):
    import math
    k = math.cos(math.radians(a[1]))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320


def uscita_di(tid):
    """Se la corsa tid è l'inizio di un servizio (o il collegamento che lo precede): (tabella, deposito, capolinea,
    minuto di inizio in linea, c'è un collegamento?). Altrimenti None."""
    if tid not in POS:
        return None
    b, i = POS[tid]
    trips = BLOCKS[b]
    j = i
    if is_coll(trips[i][3]):
        j = i + 1
        if j >= len(trips) or is_coll(trips[j][3]):
            return None
    elif i > 0 and not is_coll(trips[i - 1][3]) and mins(trips[i][1]) - mins(trips[i - 1][2]) < 120:
        return None  # a metà servizio: non è un'uscita
    first = trips[j]
    D = None
    for t in trips:
        if is_coll(t[3]):
            D = t[3][0]; break
    D = D or (RIM.get("lineaDeposito") or {}).get(first[3])
    if not D or D not in (RIM.get("depositi") or {}):
        return None
    return b, D, first[4], mins(first[1]), j != i or (i > 0 and is_coll(trips[i - 1][3]))


def traccia_uscite(vp, now, usc):
    """Vetture che escono dalla rimessa già con la corsa assegnata: quando si allontanano dal deposito
    segno l'orario. Minuti tra uscita e inizio in linea = tempo vero deposito -> capolinea."""
    dep = RIM.get("depositi") or {}
    nowm = now.hour * 60 + now.minute
    for e in vp.entity:
        if not e.HasField("vehicle") or not e.vehicle.trip.trip_id:
            continue
        v = e.vehicle
        vid = v.vehicle.id or e.id
        u = uscita_di(v.trip.trip_id)
        if not u:
            continue
        b, D, place, start, coll = u
        if not (-10 <= start - nowm <= 120):
            continue
        d = dist_m([v.position.longitude, v.position.latitude], dep[D])
        ts = int(v.timestamp or time.time())
        s = usc["vicino"].get(vid)
        if d < 350:
            usc["vicino"][vid] = [b, ts]
        elif d > 600 and s and s[0] == b and ts - s[1] < 900:
            uscita = datetime.fromtimestamp((s[1] + ts) / 2, ROME)
            um = uscita.hour * 60 + uscita.minute
            m = start - um
            del usc["vicino"][vid]
            if 2 <= m <= 90:
                usc["nuove"].append({"b": b, "D": D, "p": place, "uscita": uscita.strftime("%H:%M"), "m": m,
                                     "h": um // 60, "coll": coll, "v": v.vehicle.label or vid})
    # dimentico le vetture rimaste ferme in deposito da più di 3 ore
    usc["vicino"] = {k: x for k, x in usc["vicino"].items() if time.time() - x[1] < 3 * 3600}


def salva_uscite(usc, now):
    if not usc["nuove"]:
        return
    p = os.path.join(ARCH, "uscite", now.strftime("%Y-%m-%d") + ".json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    old = json.load(open(p)) if os.path.exists(p) else []
    old += usc["nuove"]
    json.dump(old, open(p, "w"), separators=(",", ":"), ensure_ascii=False)
    print("uscite viste:", len(usc["nuove"]))
    usc["nuove"] = []


def main():
    fine = time.time() + DURATA * 60
    stato = json.load(open(PEND)) if os.path.exists(PEND) else {}  # tid -> [chiave, data, fineMin, dep, arr, visto]
    tab, tab_t = carica_tabelle(), time.time()
    ultimo_salva = time.time()
    usc = {"vicino": {}, "nuove": []}
    while time.time() < fine:
        now = datetime.now(ROME)
        if time.time() - tab_t > 3600:
            tab, tab_t = carica_tabelle(), time.time()
        tu = feed("trips")
        if tu:
            for e in tu.entity:
                if not e.HasField("trip_update"):
                    continue
                u = e.trip_update
                tid = u.trip.trip_id
                info = tab.get(tid)
                if not info or not u.stop_time_update:
                    continue
                s = stato.get(tid)
                if not s:
                    # data di servizio: le corse dopo mezzanotte (orari 24:xx) appartengono al giorno prima
                    day = (now - timedelta(days=1)) if now.hour < 4 and info[1] >= 1440 else now
                    s = stato[tid] = [info[0], day.strftime("%Y-%m-%d"), info[1], None, None, 0]
                first, last = u.stop_time_update[0], u.stop_time_update[-1]
                ev = lambda x: x.departure if x.HasField("departure") and x.departure.HasField("delay") else x.arrival
                if first.stop_sequence <= 1 and ev(first).HasField("delay"):
                    s[3] = ev(first).delay  # ritardo alla partenza (l'ultimo visto prima che parta)
                if last.HasField("arrival") and last.arrival.HasField("delay"):
                    s[4] = last.arrival.delay
                elif ev(last).HasField("delay"):
                    s[4] = ev(last).delay
                s[5] = int(time.time())
        vp = feed("vehicles")
        if vp and RIM:
            try:
                traccia_uscite(vp, now, usc)
            except Exception as e:
                print("uscite:", e)
        if vp and time.time() - ultimo_salva > 540:
            line_of = lambda trip_id, route_id: (tab.get(trip_id, ("",))[0].split("@")[0] or route_id or None)
            traccia_spenti(ARCH, vp, line_of, now)
        # chiudo le ore finite da almeno 90 minuti
        if time.time() - ultimo_salva > 540:
            nowm = now.hour * 60 + now.minute
            pronti = {}
            for tid, s in list(stato.items()):
                rel = nowm + (1440 if s[1] != now.strftime("%Y-%m-%d") else 0)
                if rel - s[2] > 90 or time.time() - s[5] > 4 * 3600:
                    if s[3] is not None or s[4] is not None:
                        pronti.setdefault((s[1], (s[2] // 60) % 24 if s[2] < 1440 else s[2] // 60), {})[s[0]] = [None if s[3] is None else round(s[3] / 60, 1),
                                                                           None if s[4] is None else round(s[4] / 60, 1)]
                    del stato[tid]
            for (d, h), rec in pronti.items():
                p = os.path.join(ARCH, "corse", d, f"h{h:02d}.json")
                os.makedirs(os.path.dirname(p), exist_ok=True)
                old = json.load(open(p)) if os.path.exists(p) else {}
                old.update(rec)
                json.dump(old, open(p, "w"), separators=(",", ":"))
            os.makedirs(os.path.dirname(PEND), exist_ok=True)
            json.dump(stato, open(PEND, "w"), separators=(",", ":"))
            salva_uscite(usc, now)
            salva(f"Corse e vetture {now:%Y-%m-%d %H:%M}")
            print(now.strftime("%H:%M"), "ore chiuse:", len(pronti), "in corso:", len(stato))
            ultimo_salva = time.time()
        time.sleep(110)
    json.dump(stato, open(PEND, "w"), separators=(",", ":"))
    salva("Corse: fine giro")


if __name__ == "__main__":
    main()
