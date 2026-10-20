"""Win-probability time series, as each day's forecast would have looked on that day.

    python forecast_history.py   ->  ../data/forecast_history.json

For each day D from 2026-09-01 to 2026-10-20: rebuild the house-effect-corrected average
from polls with field_end <= D (first-round polls with midpoint <= D) using average.py's
load / load_r1 / trend_at and the same 40-iteration house-effect loop (vectorised here,
same arithmetic), then P(Lula > 50 on election day) with forecast.py's error model:
t(DF) shared error with sd FLOOR_SD, drift sd 0.2*sqrt(days left), plus the average's se.
Common random numbers across days so day-to-day moves reflect the data, not MC noise.
The small first-round-informed shift is not applied (it needs first-round results).
"""
import datetime as dt
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import average as A  # noqa: E402
import forecast as F  # noqa: E402

FIRST, LAST = dt.date(2026, 9, 1), dt.date(2026, 10, 20)
ELECTION = dt.date.fromisoformat(F.ELECTION_DAY)
NSIM = 20_000


def house_effects(everything):
    """Same as the loop in average.main, with trend_at over 'same' done as a matrix product."""
    n = len(everything)
    t = np.array([p["t"].toordinal() for p in everything], float)
    base = np.array([p["rating"] * p["w_size"] * p["w_freq"] for p in everything])
    y = np.array([p["y"] for p in everything])
    ser = np.array([p["series"] for p in everything])
    age = t[:, None] - t[None, :]                       # row i = target poll, col j = contributor
    W = np.where(age >= 0, base[None, :] * 0.5 ** (age / A.HALF_LIFE), 0.0)
    W[ser[:, None] != ser[None, :]] = 0.0
    np.fill_diagonal(W, 0.0)
    den = W.sum(1)
    ok = den > 0
    names = [p["pollster"] for p in everything]
    house = defaultdict(float)
    for _ in range(40):
        h = np.array([house[k] for k in names])
        tr = np.where(ok, W @ (y - h) / np.where(ok, den, 1), np.nan)
        rsum, rwt = defaultdict(float), defaultdict(float)
        for i in np.nonzero(ok)[0]:
            w = A.R1_WEIGHT if ser[i] == "r1" else 1.0
            rsum[names[i]] += w * (y[i] - tr[i])
            rwt[names[i]] += w
        new = {k: rsum[k] / (rwt[k] + A.SHRINK_K) for k in rsum}
        total = sum(rwt.values())
        mean = sum(new[k] * rwt[k] for k in new) / total
        house = defaultdict(float, {k: v - mean for k, v in new.items()})
    return house


def average_on(day, ratings, r1_all):
    polls = A.load(day, ratings)
    for p in polls:
        p["series"] = "runoff"
    r1 = [p for p in r1_all if p["t"] <= day]
    house = house_effects(polls + r1)
    cur, _ = A.trend_at(day, polls, house)
    ws = [p["rating"] * p["w_size"] * p["w_freq"] * 0.5 ** ((day - p["t"]).days / A.HALF_LIFE) for p in polls]
    n_eff = sum(ws) ** 2 / sum(w * w for w in ws)
    res = []
    for p in polls:
        if (day - p["t"]).days <= 21:
            tr, _ = A.trend_at(p["t"], [q for q in polls if q is not p], house)
            if tr is not None:
                res.append(p["y"] - house[p["pollster"]] - tr)
    sd = math.sqrt(sum(r * r for r in res) / max(1, len(res) - 1))
    return cur, sd / math.sqrt(max(1.0, n_eff)), len(polls)


def main():
    ratings = {k: v["weight"] for k, v in
               json.load(open(os.path.join(A.DATA, "pollster_ratings.json"))).items()}
    r1_all = A.load_r1(ratings) if A.R1_WEIGHT > 0 else []
    rng = np.random.default_rng(1)
    z_t = rng.standard_t(F.DF, NSIM) / math.sqrt(F.DF / (F.DF - 2))   # unit-sd t
    z_d, z_s = rng.standard_normal(NSIM), rng.standard_normal(NSIM)
    series = []
    day = FIRST
    while day <= LAST:
        cur, se, npolls = average_on(day, ratings, r1_all)
        left = (ELECTION - day).days
        drift = F.DRIFT_PER_SQRT_DAY * math.sqrt(left)
        share = cur + F.FLOOR_SD * z_t + drift * z_d + se * z_s
        series.append({"date": day.isoformat(), "lula_avg": round(cur, 2), "se": round(se, 3),
                       "days_left": left, "polls": npolls, "p_lula": round(float((share > 50).mean()), 4)})
        day += dt.timedelta(1)
    out = {"series": series,
           "params": {"election_day": F.ELECTION_DAY, "simulations_per_day": NSIM, "t_df": F.DF,
                      "shared_error_sd": F.FLOOR_SD, "drift_per_sqrt_day": F.DRIFT_PER_SQRT_DAY,
                      "half_life_days": A.HALF_LIFE, "shrink_k": A.SHRINK_K, "ratings_used": True,
                      "common_random_numbers": True, "seed": 1,
                      "first_round_informed_shift": False,
                      "note": "runoff polls with field_end <= date; first-round polls with midpoint <= date"}}
    with open(os.path.join(A.DATA, "forecast_history.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for s in series[:2] + series[-2:]:
        print(s)
    ps = [s["p_lula"] for s in series]
    moves = [abs(b - a) for a, b in zip(ps, ps[1:])]
    print(f"p range {min(ps):.3f}-{max(ps):.3f}; max daily move {max(moves):.3f}")


if __name__ == "__main__":
    main()
