"""Affidabilità di uscite e rientri: per ogni prima corsa (uscita) e ultima corsa (rientro) di un servizio,
quante volte negli ultimi 60 giorni è stata fatta davvero, sui giorni in cui era in orario.
"Fatta" = vista nel GPS di ATAC (posizione della vettura o ritardi della corsa).
Le ore in cui il flusso GPS era scarso (meno del 60% delle corse viste) non si contano, per non dare
la colpa al servizio quando è il GPS a mancare.
Scrive data/affidabilita.json: {"u": {chiave: [fatte, in orario]}, "r": {...}}
Uso: python tools/affidabilita.py  (serve git fetch dei rami storico e analisi)"""
import json, subprocess
from collections import defaultdict
from datetime import date, timedelta


def show(ref):
    r = subprocess.run(["git", "show", ref], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout else None


def ls(ref):
    return subprocess.run(["git", "ls-tree", "--name-only", ref], capture_output=True, text=True).stdout.split()


def mins(t):
    h, m = t.split(":")[:2]
    return int(h) * 60 + int(m)


def is_coll(l):
    return len(l) == 3 and l[0].isalpha() and l[1:].isdigit()


def main():
    da = (date.today() - timedelta(days=60)).isoformat()
    oggi = date.today().isoformat()
    giorni = sorted(x.split("/")[-1] for x in ls("origin/storico:corse/") if x.split("/")[-1][:2] == "20")
    res = {"u": defaultdict(lambda: [0, 0]), "r": defaultdict(lambda: [0, 0])}
    usati = 0
    for d in giorni:
        if d < da or d >= oggi:
            continue  # oggi è ancora in corso
        day = show(f"origin/analisi:data/giorni/{d}.json")
        if not day or not day.get("blocks"):
            continue
        visti = set()
        for f in ls(f"origin/storico:corse/{d}/"):
            rec = show(f"origin/storico:corse/{d}/{f.split('/')[-1]}") or {}
            for k, v in rec.items():
                if f.endswith("viste.json") or (v and (v[0] is not None or v[1] is not None)):
                    visti.add(k)
        ore = defaultdict(lambda: [0, 0])
        for T in day["blocks"].values():
            for t in T:
                if not is_coll(t[3]):
                    o = ore[mins(t[1]) // 60]
                    o[1] += 1; o[0] += f"{t[3]}@{t[1]}>{t[4]}" in visti
        usati += 1
        for T in day["blocks"].values():
            S = [t for t in T if not is_coll(t[3])]
            # inizio e fine di ogni servizio (separati da collegamenti o da pause di 2 ore)
            runs, cur = [], []
            for i, t in enumerate(T):
                if is_coll(t[3]):
                    if cur: runs.append(cur); cur = []
                    continue
                if cur and mins(t[1]) - mins(cur[-1][2]) >= 120:
                    runs.append(cur); cur = []
                cur.append(t)
            if cur: runs.append(cur)
            for run in runs:
                for kind, t in (("u", run[0]), ("r", run[-1])):
                    a, n = ore[mins(t[1]) // 60]
                    if not n or a / n < 0.6:
                        continue
                    k = f"{t[3]}@{t[1]}>{t[4]}"
                    res[kind][k][1] += 1
                    res[kind][k][0] += k in visti
    out = {"giorni": usati, "u": dict(res["u"]), "r": dict(res["r"])}
    json.dump(out, open("data/affidabilita.json", "w"), separators=(",", ":"))
    print("giorni usati:", usati, "uscite:", len(out["u"]), "rientri:", len(out["r"]))


if __name__ == "__main__":
    main()
