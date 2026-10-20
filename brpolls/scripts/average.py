"""Polling average for the 2026 runoff, Lula vs Flávio Bolsonaro.

    python average.py [--ratings ../data/pollster_ratings.json] [--as-of 2026-10-20]

Reads ../data/polls_runoff_lula_flavio.json and writes ../data/average.json.

Quantity averaged: Lula's share of the two-candidate vote, 100*L/(L+F), taken from
total-vote figures (so undecided/blank do not distort it). 50 means a tie.

Each poll's influence = pollster rating x sample size x recency x publication-frequency
penalty. Pollster house effects are estimated jointly with the trend and subtracted.
House effects are measured against the consensus of pollsters, not against the truth,
so the average inherits any industry-wide miss; the forecast accounts for that
separately (forecast.py).
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from ratings import canon  # noqa: E402  (shared pollster name canonicalisation)

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
R1_END = dt.date(2026, 10, 3)   # last day of first-round fieldwork
HALF_LIFE = 8.0        # days; weight halves every 8 days
FREQ_WINDOW = 10       # days either side when counting a pollster's recent output
SHRINK_K = 3.0         # house effects shrink as if each pollster had 3 polls at zero
START = dt.date(2026, 8, 14)


def d(s):
    return dt.date.fromisoformat(s)


def load(as_of, ratings):
    polls = []
    for p in json.load(open(os.path.join(DATA, "polls_runoff_lula_flavio.json"), encoding="utf-8")):
        if not (p["lula_total"] and p["flavio_total"]):
            continue
        a, b = d(p["field_start"]), d(p["field_end"])
        if b > as_of:
            continue
        p["t"] = a + (b - a) / 2
        p["y"] = 100 * p["lula_total"] / (p["lula_total"] + p["flavio_total"])
        p["rating"] = ratings.get(p["pollster"], 1.0)
        n = min(p["sample_size"] or 1500, 5000)
        p["w_size"] = math.sqrt(n / 2000)
        polls.append(p)
    # publication-frequency penalty: a pollster that releases many polls close together
    # should not dominate the average
    for p in polls:
        k = sum(1 for q in polls if q["pollster"] == p["pollster"]
                and abs((q["t"] - p["t"]).days) <= FREQ_WINDOW)
        p["w_freq"] = 1 / math.sqrt(max(1.0, k / 2))
    return polls


def load_r1(ratings):
    """First-round polls (Lula vs Flávio shares) used only to sharpen house effects.

    They carry the same pollsters' lean on the same two candidates, so they roughly
    double the evidence per pollster. Each series (first round, runoff) has its own trend.
    """
    by = defaultdict(dict)
    meta = {}
    with open(os.path.join(DATA, "hist", "polls_2026.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["office"] != "president" or r["round"] != "1" or r["field_end"] < START.isoformat():
                continue
            if r["option"] in ("Lula", "Flávio"):
                try:
                    by[r["poll_id"]][r["option"]] = float(r["pct"])
                except ValueError:
                    pass
            meta[r["poll_id"]] = r
    polls = []
    for pid, o in by.items():
        if "Lula" not in o or "Flávio" not in o or o["Lula"] + o["Flávio"] <= 0:
            continue
        r = meta[pid]
        a, b = d(r["field_start"]), d(r["field_end"])
        if b > R1_END or a > b:
            continue
        name = canon(r["pollster"])
        n = min(int(float(r["sample_size"])) if r["sample_size"] else 1500, 5000)
        polls.append({"poll_id": pid, "pollster": name, "series": "r1", "t": a + (b - a) / 2,
                      "y": 100 * o["Lula"] / (o["Lula"] + o["Flávio"]),
                      "rating": ratings.get(name, 1.0), "w_size": math.sqrt(n / 2000)})
    for p in polls:
        k = sum(1 for q in polls if q["pollster"] == p["pollster"]
                and abs((q["t"] - p["t"]).days) <= FREQ_WINDOW)
        p["w_freq"] = 1 / math.sqrt(max(1.0, k / 2))
    return polls


def trend_at(day, polls, house):
    num = den = 0.0
    for p in polls:
        age = (day - p["t"]).days
        if age < 0:
            continue
        w = p["rating"] * p["w_size"] * p["w_freq"] * 0.5 ** (age / HALF_LIFE)
        num += w * (p["y"] - house[p["pollster"]])
        den += w
    return (num / den if den else None), den


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default="2026-10-20")
    ap.add_argument("--ratings")
    args = ap.parse_args()
    as_of = d(args.as_of)
    ratings = {}
    if args.ratings:
        ratings = {k: v["weight"] for k, v in json.load(open(args.ratings)).items()}
    polls = load(as_of, ratings)
    for p in polls:
        p["series"] = "runoff"
    r1 = load_r1(ratings)
    everything = polls + r1

    house = defaultdict(float)
    for _ in range(40):
        resid = defaultdict(list)
        for p in everything:
            same = [q for q in everything if q["series"] == p["series"] and q is not p]
            tr, _ = trend_at(p["t"], same, house)
            if tr is not None:
                resid[p["pollster"]].append(p["y"] - tr)
        new = {k: sum(v) / (len(v) + SHRINK_K) for k, v in resid.items()}
        # centre on the poll-weighted mean so the average stays anchored to the consensus
        total = sum(len(v) for v in resid.values())
        mean = sum(new[k] * len(resid[k]) for k in new) / total
        house = defaultdict(float, {k: v - mean for k, v in new.items()})

    days = [START + dt.timedelta(i) for i in range((as_of - START).days + 1)]
    series = []
    for day in days:
        tr, den = trend_at(day, polls, house)
        if tr is not None:
            series.append({"date": day.isoformat(), "lula": round(tr, 2), "weight": round(den, 2)})

    cur_trend, _ = trend_at(as_of, polls, house)
    ws = [p["rating"] * p["w_size"] * p["w_freq"] * 0.5 ** ((as_of - p["t"]).days / HALF_LIFE)
          for p in polls]
    n_eff = sum(ws) ** 2 / sum(w * w for w in ws)
    # residual spread of recent polls around the trend as it stood the day before
    res = []
    for p in polls:
        if (as_of - p["t"]).days <= 21:
            tr, _ = trend_at(p["t"], [q for q in polls if q is not p], house)
            if tr is not None:
                res.append(p["y"] - house[p["pollster"]] - tr)
    sd = math.sqrt(sum(r * r for r in res) / max(1, len(res) - 1))
    se = sd / math.sqrt(max(1.0, n_eff))

    out = {
        "as_of": as_of.isoformat(),
        "quantity": "Lula share of the two-candidate vote (%), total-vote basis",
        "current": {"lula": round(cur_trend, 2), "flavio": round(100 - cur_trend, 2),
                    "se": round(se, 2), "ci95": [round(cur_trend - 1.96 * se, 2),
                                                 round(cur_trend + 1.96 * se, 2)],
                    "n_eff": round(n_eff, 1), "poll_sd": round(sd, 2)},
        "series": series,
        "house_effects": {k: {"effect": round(v, 2),
                              "polls": sum(1 for p in polls if p["pollster"] == k),
                              "first_round_polls": sum(1 for p in r1 if p["pollster"] == k)}
                          for k, v in sorted(house.items(), key=lambda kv: kv[1])},
        "polls": [{"id": p["poll_id"], "pollster": p["pollster"],
                   "start": p["field_start"], "end": p["field_end"], "n": p["sample_size"],
                   "lula": p["lula_total"], "flavio": p["flavio_total"],
                   "lula_two_party": round(p["y"], 2),
                   "adjusted": round(p["y"] - house[p["pollster"]], 2),
                   "weight": round(ws[i] / sum(ws), 4), "mode": p["mode"],
                   "phase": p["phase"], "verification": p["verification"],
                   "url": p["primary_url"]}
                  for i, p in enumerate(polls)],
        "params": {"half_life_days": HALF_LIFE, "freq_window_days": FREQ_WINDOW,
                   "shrink_k": SHRINK_K, "ratings_used": bool(ratings),
                   "first_round_polls_in_house_effects": len(r1)},
    }
    with open(os.path.join(DATA, "average.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    c = out["current"]
    print(f"as of {out['as_of']}: Lula {c['lula']:.2f}  Flávio {c['flavio']:.2f}  "
          f"(95% CI on Lula {c['ci95'][0]:.1f}-{c['ci95'][1]:.1f}; n_eff {c['n_eff']}, poll sd {c['poll_sd']})")
    for k, v in out["house_effects"].items():
        print(f"  {k:26}{v['polls']:3} +{v['first_round_polls']:3}  {v['effect']:+.2f}")


if __name__ == "__main__":
    main()
