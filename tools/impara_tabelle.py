"""Impara da solo come ATAC numera le tabelle (es. 53/7), partendo dalle tabelle confermate (foto, autisti, totem).
Ogni notte prova tante regole possibili e tiene quelle che indovinano meglio; più tabelle vengono confermate,
più le regole si mettono alla prova e migliorano. Nessuna regola scritta a mano: le sceglie il confronto.

Regola = "dentro un gruppo di tabelle della stessa linea (tutte / stesso capolinea / stesso numero di servizi / ...),
ordinate per una caratteristica (codice ATAC / prima partenza / uscita / fine / ...), il numero è la posizione
più uno scarto". Lo scarto si ricava dalla tabella confermata più vicina.
Prova di ogni regola: per ogni tabella confermata la nascondo e la indovino con le altre (prova "a occhi chiusi").
Una linea è SICURA quando la sua regola indovina tutte le confermate a occhi chiusi ed esse sono almeno 4:
solo allora i numeri delle altre tabelle di quella linea vengono dedotti e mostrati (con ≈).
Scrive data/regole_tabelle.json."""
import json, collections, itertools
from datetime import date


def mins(t):
    h, m = t.split(":")[:2]
    return int(h) * 60 + int(m)


def is_coll(l):
    return len(l) == 3 and l[0].isalpha() and l[1:].isdigit()


def caratteristiche(blocks):
    info = {}
    for b, T in blocks.items():
        S = [t for t in T if not is_coll(t[3])]
        if not S:
            continue
        L = collections.Counter(t[3] for t in S).most_common(1)[0][0]
        runs = 1 + sum(1 for a, c in zip(S, S[1:]) if mins(c[1]) - mins(a[2]) >= 120)
        code = b.split("#")[-1]
        info[b] = {
            "b": b, "L": L, "key": f"{S[0][3]}@{S[0][1]}>{S[0][4]}",
            # caratteristiche numeriche (per ordinare)
            "codice ATAC": int(code) if code.isdigit() else 0,
            "prima partenza": mins(S[0][1]),
            "uscita dalla rimessa": mins(T[0][1]),
            "fine servizio": mins(S[-1][2]),
            "durata": mins(S[-1][2]) - mins(S[0][1]),
            "numero di corse": len(S),
            # caratteristiche "a categorie" (per fare gruppi)
            "capolinea di partenza": S[0][4],
            "numero di servizi": runs,
            "mattina o pomeriggio": mins(S[0][1]) < 720,
            "giro corto": len(S) <= 4,
            "ha collegamenti": any(is_coll(t[3]) for t in T),
        }
    return info


ORDINI = ["codice ATAC", "prima partenza", "uscita dalla rimessa", "fine servizio", "durata", "numero di corse"]
GRUPPI = [None, "capolinea di partenza", "numero di servizi", "mattina o pomeriggio", "giro corto", "ha collegamenti"]


def prevedi(x, xs, conf, ordine, gruppo, escludi=None):
    """numero previsto per x con la regola (ordine, gruppo), usando le confermate tranne 'escludi'."""
    grp = [y for y in xs if gruppo is None or y[gruppo] == x[gruppo]]
    grp.sort(key=lambda y: (y[ordine], y["codice ATAC"]))
    anc = [y for y in grp if y["b"] in conf and y["b"] != escludi]
    if not anc:
        return None
    i = grp.index(x)
    # scarto dalla confermata più vicina nell'elenco
    a = min(anc, key=lambda y: abs(grp.index(y) - i))
    return i + 1 + conf[a["b"]] - (grp.index(a) + 1)


def main():
    blocks = json.load(open("data/blocks.json"))
    nomi = json.load(open("data/tabelle.json"))
    info = caratteristiche(blocks)
    per_linea = collections.defaultdict(list)
    for x in info.values():
        per_linea[x["L"]].append(x)
    conf = {}
    for x in info.values():
        n = nomi.get(x["key"])
        if n and "/" in n and n.split("/")[0].lower() == str(x["L"]).lower() and n.split("/")[1].isdigit():
            conf[x["b"]] = int(n.split("/")[1])
    regole = [(o, g) for o in ORDINI for g in GRUPPI]
    punti = collections.Counter()
    tot = 0
    linee = {}
    for L, xs in per_linea.items():
        anc = [x for x in xs if x["b"] in conf]
        if len(anc) < 2:
            continue
        tot += len(anc)
        prove = {}
        for r in regole:
            ok = sum(1 for a in anc if prevedi(a, xs, conf, *r, escludi=a["b"]) == conf[a["b"]])
            prove[r] = ok
            punti[r] += ok
        linee[L] = (anc, prove)
    # regola generale: quella che indovina di più su tutte le linee (vale dove una linea non ha regole sue)
    generale = max(regole, key=lambda r: (punti[r], -regole.index(r))) if punti else (ORDINI[0], None)
    out = {"aggiornato": date.today().isoformat(), "confermate": len(conf),
           "generale": {"regola": list(generale), "ok": punti[generale], "tot": tot}, "linee": {}}
    for L, (anc, prove) in linee.items():
        # a parità preferisco la regola generale, poi le più semplici
        best = max(regole, key=lambda r: (prove[r], r == generale, r[1] is None, -regole.index(r)))
        ok, n = prove[best], len(anc)
        sicura = ok == n and n >= 4   # almeno 4 confermate, tutte indovinate a occhi chiusi
        rec = {"regola": list(best), "ok": ok, "tot": n, "stato": "sicura" if sicura else "probabile" if ok == n else "da verificare"}
        # ipotesi con la regola migliore, per tutte le tabelle non confermate della linea
        ipo = {}
        for x in per_linea[L]:
            if x["b"] not in conf:
                p = prevedi(x, per_linea[L], conf, *best)
                if p and 0 < p < 100:
                    ipo[x["key"]] = f"{L}/{p}"
        rec["ipotesi"] = ipo
        if sicura:
            ded = {}
            for x in per_linea[L]:
                if x["b"] in conf:
                    continue
                p = prevedi(x, per_linea[L], conf, *best)
                if p and 0 < p < 100:
                    ded[x["key"]] = f"{L}/{p}"
            # numeri doppi = la regola non regge su tutta la linea: non pubblico niente
            if len(set(ded.values())) == len(ded) and not set(ded.values()) & {f"{L}/{v}" for v in [conf[a['b']] for a in anc]}:
                rec["dedotte"] = ded
            else:
                rec["stato"] = "da verificare"
        out["linee"][L] = rec
    # storia dell'apprendimento: un punto al giorno (confermate, quante indovinate a occhi chiusi, linee sicure)
    try:
        storia = json.load(open("data/regole_tabelle.json")).get("storia", [])
    except Exception:
        storia = []
    punto = [out["aggiornato"], len(conf), out["generale"]["ok"], tot, sum(1 for r in out["linee"].values() if r.get("dedotte"))]
    out["storia"] = [p for p in storia if p[0] != punto[0]][-365:] + [punto]
    json.dump(out, open("data/regole_tabelle.json", "w"), ensure_ascii=False, separators=(",", ":"))
    g = out["generale"]
    print(f"confermate: {len(conf)} · regola generale: {g['regola']} ({g['ok']}/{g['tot']} a occhi chiusi)")
    for L, r in sorted(out["linee"].items()):
        print(f"  {L}: {r['stato']} {r['ok']}/{r['tot']} {r['regola']}" + (f" -> {len(r.get('dedotte', {}))} dedotte" if r.get("dedotte") else ""))


if __name__ == "__main__":
    main()
