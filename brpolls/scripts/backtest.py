"""Backtest the average + forecast on past presidential runoffs (2010-2022).

    python backtest.py  ->  ../data/backtest.json

For each runoff, rebuild the average from that year's Wikipedia runoff polls exactly as
average.py does for 2026 (same weights, house effects, half-life), as of N days before the
election (default 5, today's horizon), and compare with the official result. Pollster
ratings are not used here, because they were computed with these same elections.
"""
import csv
import datetime as dt
import json
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
import average as A  # noqa: E402
from average import FREQ_WINDOW, SHRINK_K, trend_at  # noqa: E402
from ratings import ELECTION, canon, load_results, tokens  # noqa: E402
from forecast import DF, t_draw  # noqa: E402

import random  # noqa: E402

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
HORIZON = 5
SD = 2.0


def polls_for(year, results):
    a, b = results[(year, 2, "president", "BR")][:2]
    pt = a if a["party"] == "PT" else b
    other = b if pt is a else a
    by = defaultdict(dict)
    meta = {}
    with open(os.path.join(DATA, "hist", "polls_president.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if int(r["year"]) != year or r["round"] != "2":
                continue
            t = tokens(r["option"])
            try:
                v = float(r["pct"])
            except ValueError:
                continue
            if t & pt["tok"]:
                by[r["poll_id"]]["pt"] = v
            elif t & other["tok"]:
                by[r["poll_id"]]["other"] = v
            meta[r["poll_id"]] = r
    out = []
    for pid, o in by.items():
        if "pt" not in o or "other" not in o:
            continue
        r = meta[pid]
        s, e = dt.date.fromisoformat(r["field_start"]), dt.date.fromisoformat(r["field_end"])
        n = min(int(float(r["sample_size"])) if r["sample_size"] else 1500, 5000)
        out.append({"pollster": canon(r["pollster"]), "t": s + (e - s) / 2, "end": e,
                    "y": 100 * o["pt"] / (o["pt"] + o["other"]), "rating": 1.0,
                    "w_size": math.sqrt(n / 2000)})
    actual = 100 * pt["votes"] / (pt["votes"] + other["votes"])
    return out, actual, pt["name"], other["name"]


def average(polls, as_of):
    polls = [p for p in polls if p["end"] <= as_of]
    for p in polls:
        k = sum(1 for q in polls if q["pollster"] == p["pollster"] and abs((q["t"] - p["t"]).days) <= FREQ_WINDOW)
        p["w_freq"] = 1 / math.sqrt(max(1.0, k / 2))
    house = defaultdict(float)
    for _ in range(30):
        resid = defaultdict(list)
        for p in polls:
            tr, _ = trend_at(p["t"], [q for q in polls if q is not p], house)
            if tr is not None:
                resid[p["pollster"]].append(p["y"] - tr)
        new = {k: sum(v) / (len(v) + SHRINK_K) for k, v in resid.items()}
        tot = sum(len(v) for v in resid.values())
        m = sum(new[k] * len(resid[k]) for k in new) / tot
        house = defaultdict(float, {k: v - m for k, v in new.items()})
    return A.make_smoother(polls, house)(as_of), len(polls)


def prob(center, n=100_000, seed=7):
    rng = random.Random(seed)
    scale = SD / math.sqrt(DF / (DF - 2))
    return sum(1 for _ in range(n) if center + scale * t_draw(rng, DF) > 50) / n


def main():
    results = load_results()
    rows = []
    for year in (2010, 2014, 2018, 2022):
        polls, actual, pt, other = polls_for(year, results)
        day = dt.date.fromisoformat(ELECTION[(year, 2)])
        as_of = day - dt.timedelta(HORIZON)
        avg, n = average(polls, as_of)
        if avg is None:
            continue
        p = prob(avg)
        rows.append({"year": year, "pt_candidate": pt, "opponent": other, "polls_used": n,
                     "average_pt_share": round(avg, 2), "actual_pt_share": round(actual, 2),
                     "error": round(avg - actual, 2), "p_pt_win": round(p, 3),
                     "pt_won": actual > 50})
    brier = sum((r["p_pt_win"] - r["pt_won"]) ** 2 for r in rows) / len(rows)
    rmse = math.sqrt(sum(r["error"] ** 2 for r in rows) / len(rows))
    out = {"horizon_days": HORIZON, "shared_error_sd": SD, "races": rows,
           "rmse_share": round(rmse, 2), "brier": round(brier, 3)}
    json.dump(out, open(os.path.join(DATA, "backtest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for r in rows:
        print(f"{r['year']} {r['pt_candidate']:>8} vs {r['opponent']:<16} polls {r['polls_used']:3}  "
              f"avg {r['average_pt_share']:.1f}  actual {r['actual_pt_share']:.1f}  err {r['error']:+.1f}  "
              f"P(PT) {r['p_pt_win']:.0%}  {'won' if r['pt_won'] else 'lost'}")
    print(f"RMSE {rmse:.2f} pts of share; Brier {brier:.3f}")


if __name__ == "__main__":
    main()
