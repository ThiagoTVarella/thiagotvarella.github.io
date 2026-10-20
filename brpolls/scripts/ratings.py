"""Pollster ratings from historical polls scored against official TSE results.

    python ratings.py   ->  ../data/pollster_ratings.json, ../data/race_errors.csv

Method (a simplified version of the 538 approach):
1. Keep polls fielded in the final 21 days before each election round.
2. Compare the poll's margin between the race's top-two finishers (poll shares renormalised
   over all candidates listed, so blanks/undecided drop out) with the official margin in
   valid votes. Error is in points of margin, positive = poll overstates the winner.
3. "Plus-minus": a poll's absolute error minus the average absolute error of all polls in
   the same race, adjusted for how many days before the election it was fielded.
4. Each (pollster, race) pair is one observation (weight sqrt of its poll count, capped at
   3), scaled by race importance: president 1.0; governor of SP/MG/RJ/BA/RS/PR/PE/CE 0.8;
   other governors 0.4.
5. Shrink toward the average pollster (mean plus-minus 0) with K pseudo-observations.
6. Convert to a weight for the polling average. Bias = mean signed error on the PT
   candidate's share where PT was one of the top two.
Pollster lineage assumptions: Ibope -> Ipec; FSB -> Nexus. Ratings are only as good as the
history we have: no 2002/2006 polls, thin 2014 governors, and the 2018 governor file may
be missing.
"""
import csv
import datetime as dt
import glob
import json
import math
import os
import re
import unicodedata
from collections import defaultdict

HIST = os.path.join(os.path.dirname(__file__), "..", "data", "hist")
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
ELECTION = {  # (year, round) -> election day
    (2002, 1): "2002-10-06", (2002, 2): "2002-10-27", (2006, 1): "2006-10-01", (2006, 2): "2006-10-29",
    (2010, 1): "2010-10-03", (2010, 2): "2010-10-31", (2014, 1): "2014-10-05", (2014, 2): "2014-10-26",
    (2018, 1): "2018-10-07", (2018, 2): "2018-10-28", (2022, 1): "2022-10-02", (2022, 2): "2022-10-30",
    (2026, 1): "2026-10-04",
}
BIG = {"SP", "MG", "RJ", "BA", "RS", "PR", "PE", "CE"}
WINDOW = 21
K_SHRINK = 4.0
STOP = {"silva", "santos", "souza", "junior", "filho", "neto", "dos", "das", "doutor", "doutora",
        "delegado", "delegada", "pastor", "professor", "professora", "capitao", "coronel",
        "general", "major", "sargento", "padre", "irma", "tenente", "cabo", "dona", "seu"}
CANON = {
    "ibope": "Ipec", "ipec": "Ipec", "ipsosipec": "Ipec", "ipsus": "Ipec", "estadoibope": "Ipec",
    "datafolha": "Datafolha", "quaest": "Quaest", "genialquaest": "Quaest", "ipespe": "Ipespe",
    "realtimebigdata": "Real Time Big Data", "realtime": "Real Time Big Data",
    "paranapesquisas": "Paraná Pesquisas", "atlasintel": "AtlasIntel", "altasintel": "AtlasIntel",
    "atlasinstel": "AtlasIntel", "atlas": "AtlasIntel", "poderdata": "PoderData",
    "datapoder360": "PoderData", "datapoder": "PoderData", "ideia": "Ideia", "ideiabigdata": "Ideia",
    "meioideia": "Ideia", "veritá": "Veritá", "verita": "Veritá", "institutoverita": "Veritá",
    "fsb": "Nexus", "fsbpesquisa": "Nexus", "nexus": "Nexus", "btgnexus": "Nexus",
    "futura": "Futura", "futurainteligencia": "Futura", "vox": "Vox Brasil", "voxbrasil": "Vox Brasil",
    "voxpopuli": "Vox Populi", "mda": "MDA", "cntmda": "MDA", "gerp": "Gerp", "indexa": "Indexa",
    "palver": "Palver", "datatrends": "DataTrends", "ifp": "Instituto França (IFP)",
    "rankingbrasil": "Ranking Brasil", "rankingbrasilinteligencia": "Ranking Brasil",
    "ranking": "Instituto Ranking", "institutoranking": "Instituto Ranking",
    "sensus": "Sensus", "brasmarket": "Brasmarket", "franca": "Instituto França (IFP)",
    "francaifp": "Instituto França (IFP)", "ibrape": "Ibrape", "novoibrape": "Ibrape",
    "badra": "Badra", "badracomunicacao": "Badra", "datamax": "DATAmax", "irg": "IRG",
    "ipems": "IPEMS", "ipsensus": "IPSensus", "datasensus": "IPSensus", "exatago": "Exata GO",
}
# words that only decorate institute names ("Instituto X de Pesquisa") and are dropped before matching
DECOR = {"instituto", "de", "do", "da", "e", "pesquisa", "pesquisas", "grupo", "inteligencia",
         "comunicacao", "opiniao", "mercado", "ltda"}
_seen = {}


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]", " ", s)


def canon(name):
    """Canonical institute name: explicit lineage/alias table first, then a decoration-free
    key so that e.g. "Instituto DataSensus" and "DataSensus" or "DATAmax"/"Datamax" merge."""
    key = re.sub(r"[^a-z0-9]", "", norm(name))
    if key in CANON:
        return CANON[key]
    core = "".join(t for t in norm(name).split() if t not in DECOR) or key
    if core in CANON:
        return CANON[core]
    return _seen.setdefault(core, re.sub(r"^Instituto\s+", "", name.strip()))


# ballot name -> other names pollsters use for the same candidate
ALIAS = {"dilma": {"rousseff"}, "lula": {"lula"}, "aecio": {"neves"}}


def tokens(name):
    toks = {t for t in norm(name).split() if len(t) >= 4 and t not in STOP}
    for t in list(toks):
        toks |= ALIAS.get(t, set())
    return toks


def load_results():
    res = defaultdict(list)
    with open(os.path.join(HIST, "results_all.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            res[(int(r["year"]), int(r["round"]), r["office"], r["state"])].append(
                {"name": r["candidate"], "party": r["party"], "votes": int(r["votes"]),
                 "valid": int(r["valid_votes"]), "tok": tokens(r["candidate"])})
    for k in res:
        res[k].sort(key=lambda c: -c["votes"])
    return res


def load_polls():
    polls = {}
    for path in sorted(glob.glob(os.path.join(HIST, "polls_*.csv"))):
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try:
                    pct = float(r["pct"])
                except ValueError:
                    continue
                p = polls.setdefault(r["poll_id"], {
                    "id": r["poll_id"], "year": int(r["year"]), "office": r["office"],
                    "state": r["state"], "round": int(r["round"]), "pollster": canon(r["pollster"]),
                    "end": r["field_end"], "opts": []})
                p["opts"].append((r["option"], pct))
    return list(polls.values())


def match(opt, cands):
    t = tokens(opt)
    hits = [c for c in cands if t & c["tok"]]
    return hits[0] if len(hits) == 1 else None


def score(polls, results):
    rows = []
    for p in polls:
        day = ELECTION.get((p["year"], p["round"]))
        cands = results.get((p["year"], p["round"], p["office"], p["state"]))
        if not day or not cands or len(cands) < 2:
            continue
        dte = (dt.date.fromisoformat(day) - dt.date.fromisoformat(p["end"])).days
        if not 0 <= dte <= WINDOW:
            continue
        a, b = cands[0], cands[1]
        pa = pb = None
        total = 0.0
        for opt, pct in p["opts"]:
            if opt.startswith("BLANK") or opt in ("UNDECIDED", "OTHERS", "ABSTENTION"):
                continue
            total += pct
            c = match(opt, [a, b])
            if c is a:
                pa = pct if pa is None else pa
            elif c is b:
                pb = pct if pb is None else pb
        if not pa or not pb:
            continue
        if total <= 0:
            continue
        poll_margin = 100 * (pa - pb) / total
        act_margin = 100 * (a["votes"] - b["votes"]) / a["valid"]
        err = poll_margin - act_margin
        pt = next((x for x in (a, b) if x["party"] == "PT"), None)
        bias = None
        if pt is not None:
            bias = err if pt is a else -err
        race = f"{p['year']}-{p['office']}-{p['state']}-r{p['round']}"
        wt = 1.0 if p["office"] == "president" else (0.8 if p["state"] in BIG else 0.4)
        rows.append({"race": race, "year": p["year"], "office": p["office"], "state": p["state"],
                     "round": p["round"], "pollster": p["pollster"], "poll_id": p["id"],
                     "end": p["end"], "dte": dte, "err": err, "abs": abs(err), "bias_pt": bias,
                     "race_w": wt})
    return rows


def plus_minus(rows):
    by = defaultdict(list)
    for r in rows:
        by[r["race"]].append(r)
    # error grows with distance from election day: pooled slope of abs error on dte
    xs, ys = [], []
    for rs in by.values():
        md = sum(r["dte"] for r in rs) / len(rs)
        ma = sum(r["abs"] for r in rs) / len(rs)
        xs += [r["dte"] - md for r in rs]
        ys += [r["abs"] - ma for r in rs]
    sxx = sum(x * x for x in xs)
    slope = sum(x * y for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    for rs in by.values():
        md = sum(r["dte"] for r in rs) / len(rs)
        ma = sum(r["abs"] for r in rs) / len(rs)
        for r in rs:
            r["pm"] = r["abs"] - (ma + slope * (r["dte"] - md))
    return slope


def rate(rows):
    pair = defaultdict(list)
    for r in rows:
        pair[(r["pollster"], r["race"])].append(r)
    agg = defaultdict(lambda: {"num": 0.0, "den": 0.0, "bn": 0.0, "bd": 0.0, "polls": 0,
                               "races": 0, "abs": 0.0})
    for (name, race), rs in pair.items():
        w = rs[0]["race_w"] * math.sqrt(min(len(rs), 3))
        a = agg[name]
        a["num"] += w * sum(r["pm"] for r in rs) / len(rs)
        a["den"] += w
        a["abs"] += sum(r["abs"] for r in rs)
        a["polls"] += len(rs)
        a["races"] += 1
        bs = [r["bias_pt"] for r in rs if r["bias_pt"] is not None]
        if bs:
            a["bn"] += w * sum(bs) / len(bs)
            a["bd"] += w
    out = {}
    for name, a in agg.items():
        pm = a["num"] / (a["den"] + K_SHRINK)
        out[name] = {"plus_minus": round(pm, 3),
                     "mean_abs_error": round(a["abs"] / a["polls"], 2),
                     "bias_pt": round(a["bn"] / (a["bd"] + K_SHRINK), 2) if a["bd"] else None,
                     "polls": a["polls"], "races": a["races"],
                     "evidence": round(a["den"], 1),
                     "weight": round(min(1.6, max(0.5, math.exp(-0.18 * pm))), 3)}
    return out


def grade(ratings):
    ranked = sorted(ratings, key=lambda k: ratings[k]["plus_minus"])
    n = len(ranked)
    labels = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"]
    for i, k in enumerate(ranked):
        ratings[k]["grade"] = labels[min(len(labels) - 1, int(10 * i / n))] \
            if ratings[k]["evidence"] >= 3 else "unrated (thin history)"
        ratings[k]["rank"] = i + 1


def persistence(rows, dte_max=14):
    """Does a pollster's first-round bias carry into the runoff of the same election?

    Uses the signed error on the PT candidate's margin in presidential polls from the final
    two weeks. Reports (a) the industry-wide mean bias per round and (b) the slope of each
    pollster's runoff bias on its first-round bias, both measured relative to that round's
    industry mean. Writes ../data/bias_persistence.json for average.py.
    """
    pres = [r for r in rows if r["office"] == "president" and r["bias_pt"] is not None
            and r["dte"] <= dte_max]
    ind = defaultdict(list)
    by = defaultdict(list)
    for r in pres:
        ind[(r["year"], r["round"])].append(r["bias_pt"])
        by[(r["year"], r["round"], r["pollster"])].append(r["bias_pt"])
    mean = lambda v: sum(v) / len(v)
    xs, ys = [], []
    for (y, rnd, name), v in by.items():
        if rnd == 1 and (y, 2, name) in by:
            xs.append(mean(v) - mean(ind[(y, 1)]))
            ys.append(mean(by[(y, 2, name)]) - mean(ind[(y, 2)]))
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    out = {"relative_slope": round(slope, 3), "pairs": len(xs),
           "industry_pt_margin_bias": {f"{y}-r{rnd}": round(mean(v), 2) for (y, rnd), v in sorted(ind.items())},
           "note": "Signed error on the PT candidate's margin (points), presidential polls in the final "
                   f"{dte_max} days. relative_slope: share of a pollster's first-round bias relative to its "
                   "peers that reappears in the runoff."}
    with open(os.path.join(OUT, "bias_persistence.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    return out


def main():
    results = load_results()
    polls = load_polls()
    rows = score(polls, results)
    slope = plus_minus(rows)
    ratings = rate(rows)
    grade(ratings)
    with open(os.path.join(OUT, "pollster_ratings.json"), "w", encoding="utf-8") as f:
        json.dump(dict(sorted(ratings.items(), key=lambda kv: kv[1]["rank"])), f,
                  ensure_ascii=False, indent=1)
    fields = ["race", "pollster", "poll_id", "end", "dte", "err", "pm", "bias_pt", "race_w"]
    with open(os.path.join(OUT, "race_errors.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fields, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r["race"], r["end"])):
            w.writerow({**r, "err": round(r["err"], 2), "pm": round(r["pm"], 2),
                        "bias_pt": None if r["bias_pt"] is None else round(r["bias_pt"], 2)})
    # this cycle: how each pollster's final-10-day 2026 first-round presidential polls did
    cyc = defaultdict(list)
    for r in rows:
        if r["race"] == "2026-president-BR-r1" and r["dte"] <= 10:
            cyc[r["pollster"]].append(r["err"])
    table = [{"pollster": k, "polls": len(v), "mean_margin_error": round(sum(v) / len(v), 2),
              "mean_abs_error": round(sum(abs(e) for e in v) / len(v), 2)}
             for k, v in cyc.items()]
    table.sort(key=lambda x: x["mean_abs_error"])
    with open(os.path.join(OUT, "cycle2026_first_round.json"), "w", encoding="utf-8") as f:
        json.dump({"note": "Error of the Flávio-minus-Lula margin, in points, vs the official first-round result "
                           "(Flávio 47.0%, Lula 45.2% of valid votes). Positive = poll overstated Flávio. "
                           "Polls fielded in the last 10 days before 4 Oct.",
                   "pollsters": table}, f, ensure_ascii=False, indent=1)
    persistence(rows)
    print(f"{len(polls)} polls read, {len(rows)} scored in {len({r['race'] for r in rows})} races; "
          f"error slope {slope:+.3f} pts/day; overall mean |err| "
          f"{sum(r['abs'] for r in rows) / len(rows):.2f}")
    print(f"{'pollster':26}{'rank':>5}{'grade':>8}{'pm':>8}{'|err|':>7}{'biasPT':>8}{'polls':>6}{'races':>6}{'wt':>6}")
    for k, v in sorted(ratings.items(), key=lambda kv: kv[1]["rank"]):
        if v["polls"] >= 5:
            print(f"{k:26}{v['rank']:>5}{v['grade'][:6]:>8}{v['plus_minus']:>+8.2f}{v['mean_abs_error']:>7.2f}"
                  f"{(v['bias_pt'] if v['bias_pt'] is not None else float('nan')):>+8.2f}{v['polls']:>6}{v['races']:>6}{v['weight']:>6.2f}")


if __name__ == "__main__":
    main()
