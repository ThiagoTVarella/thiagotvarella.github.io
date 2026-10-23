"""Polling average for the 2026 runoff, Lula vs Flávio Bolsonaro.

    python average.py [--ratings ../data/pollster_ratings.json] [--as-of YYYY-MM-DD]   (default: today)

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

import numpy as np
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from ratings import canon  # noqa: E402  (shared pollster name canonicalisation)

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
R1_END = dt.date(2026, 10, 3)   # last day of first-round fieldwork
HALF_LIFE = 8.0        # days; recency half-life used to estimate house effects (and by the exponential smoother)
FREQ_WINDOW = 10       # days either side when counting a pollster's recent output
SHRINK_K = 3.0         # house effects shrink as if each pollster had 3 polls at zero
R1_WEIGHT = 0.5        # first-round polls count half when estimating house effects
SMOOTHER = "spline"    # trend line: cubic smoothing spline (csaps-style); the page also offers exponential, Gaussian and window
SPLINE_DAYS = 2.0      # stiffness as an equivalent width in days: lambda = SPLINE_DAYS ** 4, csaps p = 1 / (1 + lambda)
PRIOR_POLLS = 2.0      # first-round bias shrinks as if each pollster had 2 extra polls with no miss
START = dt.date(2026, 8, 14)


def d(s):
    return dt.date.fromisoformat(s)


def load(as_of, ratings):
    polls = []
    for p in json.load(open(os.path.join(DATA, "polls_runoff_lula_flavio.json"), encoding="utf-8")):
        # most polls publish total votes; a few only the valid-vote split, which gives the same
        # Lula-versus-Flávio share (blank, null and undecided drop out either way)
        p["basis"] = "total"
        if not (p["lula_total"] and p["flavio_total"]):
            if not (p.get("lula_valid") and p.get("flavio_valid")):
                continue
            p["lula_total"], p["flavio_total"], p["basis"] = p["lula_valid"], p["flavio_valid"], "valid"
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
                      "start": r["field_start"], "end": r["field_end"], "n": n,
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


def spline_fit(pts, lam):
    """Weighted cubic smoothing spline (what csaps fits): minimise sum w (y - f)^2 + lam * integral f''^2.

    pts = [(x, y, w)]; polls on the same day are merged. Reinsch algorithm as in Green & Silverman (1994),
    the same code as splineFit() in app.js. Held flat outside the data instead of extrapolating."""
    by = {}
    for x, y, w in pts:
        sw, swy = by.get(x, (0.0, 0.0))
        by[x] = (sw + w, swy + w * y)
    xs = sorted(by)
    n = len(xs)
    if n == 0:
        return lambda t: None
    x = np.array(xs, float)
    w = np.array([by[k][0] for k in xs])
    y = np.array([by[k][1] / by[k][0] for k in xs])
    w = w / w.mean()
    if n < 3:
        m = float((w * y).sum() / w.sum())
        return lambda t: m
    h = np.diff(x)
    m = n - 2
    Q = np.zeros((n, m))
    R = np.zeros((m, m))
    for j in range(m):
        Q[j, j] = 1 / h[j]
        Q[j + 1, j] = -1 / h[j] - 1 / h[j + 1]
        Q[j + 2, j] = 1 / h[j + 1]
        R[j, j] = (h[j] + h[j + 1]) / 3
        if j + 1 < m:
            R[j, j + 1] = R[j + 1, j] = h[j + 1] / 6
    gam_in = np.linalg.solve(R + lam * Q.T @ (Q / w[:, None]), Q.T @ y)
    gam = np.concatenate([[0.0], gam_in, [0.0]])
    g = y - lam * (Q @ gam_in) / w

    def f(t):
        if t <= x[0]:
            return float(g[0])
        if t >= x[-1]:
            return float(g[-1])
        i = int(np.searchsorted(x, t, side="right")) - 1
        hi, a_, b_ = h[i], t - x[i], x[i + 1] - t
        return float((a_ * g[i + 1] + b_ * g[i]) / hi
                     - a_ * b_ / 6 * ((1 + a_ / hi) * gam[i + 1] + (1 + b_ / hi) * gam[i]))
    return f


def width_days():
    return min(40.0, max(1.0, SPLINE_DAYS))


def gauss_weights(day, polls):
    """Poll weights with a two-sided Gaussian recency kernel (width = the spline's equivalent days)."""
    return [p["rating"] * p["w_size"] * p["w_freq"] * math.exp(-0.5 * (((day - p["t"]).days) / width_days()) ** 2)
            for p in polls]


def gauss_trend(day, polls, house, skip=None):
    """Two-sided Gaussian-kernel average, used for the uncertainty of the spline trend (as in app.js)."""
    num = den = den2 = 0.0
    for p, w in zip(polls, gauss_weights(day, polls)):
        if p is skip:
            continue
        num += w * (p["y"] - house[p["pollster"]])
        den += w
        den2 += w * w
    return (num / den if den else None), den, (den * den / den2 if den2 else 0.0)


def make_smoother(polls, house):
    """Return f(day) -> the published trend value for the default smoother."""
    if SMOOTHER == "spline":
        f = spline_fit([(p["t"].toordinal(), p["y"] - house[p["pollster"]],
                         p["rating"] * p["w_size"] * p["w_freq"]) for p in polls], SPLINE_DAYS ** 4)
        return lambda day: f(day.toordinal())
    return lambda day: trend_at(day, polls, house)[0]


def poll_noise(as_of, polls, house):
    """Residual spread of recent polls around the trend as it stood without them, and effective poll count."""
    res = []
    for p in polls:
        if (as_of - p["t"]).days <= 21:
            tr, _, _ = gauss_trend(p["t"], polls, house, skip=p)
            if tr is not None:
                res.append(p["y"] - house[p["pollster"]] - tr)
    sd = math.sqrt(sum(r * r for r in res) / max(1, len(res) - 1))
    return sd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default=min(dt.date.today(), dt.date(2026, 10, 25)).isoformat())
    ap.add_argument("--ratings")
    ap.add_argument("--r1-weight", type=float, default=R1_WEIGHT,
                    help="weight of first-round polls when estimating house effects (0 = runoff only)")
    args = ap.parse_args()
    as_of = d(args.as_of)
    ratings = {}
    if args.ratings:
        ratings = {k: v["weight"] for k, v in json.load(open(args.ratings)).items()}
    polls = load(as_of, ratings)
    for p in polls:
        p["series"] = "runoff"
    # First-round polls inform house effects at reduced weight: leans shifted after the first
    # round, and at full weight they overcorrected some pollsters (e.g. Quaest, Real Time).
    r1_all = load_r1(ratings)          # always exported so the page can change the weight
    r1 = r1_all if args.r1_weight > 0 else []
    for p in r1:
        p["hw"] = args.r1_weight
    for p in polls:
        p["hw"] = 1.0
    everything = polls + r1

    house = defaultdict(float)
    for _ in range(40):
        rsum, rwt = defaultdict(float), defaultdict(float)
        for p in everything:
            same = [q for q in everything if q["series"] == p["series"] and q is not p]
            tr, _ = trend_at(p["t"], same, house)
            if tr is not None:
                rsum[p["pollster"]] += p["hw"] * (p["y"] - tr)
                rwt[p["pollster"]] += p["hw"]
        new = {k: rsum[k] / (rwt[k] + SHRINK_K) for k in rsum}
        # centre on the poll-weighted mean so the average stays anchored to the consensus
        total = sum(rwt.values())
        mean = sum(new[k] * rwt[k] for k in new) / total
        house = defaultdict(float, {k: v - mean for k, v in new.items()})

    # First-round-informed estimate. History (bias_persistence.json) says the industry-wide
    # first-round miss does not carry into the runoff, but about a third of each pollster's
    # miss *relative to its peers* does. So each pollster gets an expected runoff bias of
    # slope x (its first-round Lula overstatement minus the industry's), shrunk for few polls,
    # and the average moves by the weighted mean of those expected biases.
    adj = None
    cyc_path = os.path.join(DATA, "cycle2026_first_round.json")
    per_path = os.path.join(DATA, "bias_persistence.json")
    if os.path.exists(cyc_path) and os.path.exists(per_path):
        cyc = json.load(open(cyc_path, encoding="utf-8"))["pollsters"]
        slope = json.load(open(per_path, encoding="utf-8"))["relative_slope"]
        over = {c["pollster"]: -c["mean_margin_error"] / 2 for c in cyc}   # Lula share overstatement
        n = {c["pollster"]: c["polls"] for c in cyc}
        ind = sum(over[k] * n[k] for k in over) / sum(n.values())
        expected = {k: slope * n[k] / (n[k] + PRIOR_POLLS) * (over[k] - ind) for k in over}
        adj = {"slope": slope, "first_round_industry_lula_overstatement": round(ind, 2),
               "expected_runoff_bias": {k: round(v, 2) for k, v in sorted(expected.items(), key=lambda kv: kv[1])}}

    days = [START + dt.timedelta(i) for i in range((as_of - START).days + 1)]
    smooth = make_smoother(polls, house)
    series = []
    for day in days:
        tr, den, _ = gauss_trend(day, polls, house)
        if tr is not None:
            series.append({"date": day.isoformat(), "lula": round(smooth(day), 2), "weight": round(den, 2)})

    cur_trend = smooth(as_of)
    ws = gauss_weights(as_of, polls)
    n_eff = sum(ws) ** 2 / sum(w * w for w in ws)
    sd = poll_noise(as_of, polls, house)
    se = sd / math.sqrt(max(1.0, n_eff))
    if adj is not None:
        shift = -sum(w * adj["expected_runoff_bias"].get(p["pollster"], 0.0)
                     for w, p in zip(ws, polls)) / sum(ws)
        adj["shift"] = round(shift, 2)
        adj["lula"] = round(cur_trend + shift, 2)
        adj["flavio"] = round(100 - cur_trend - shift, 2)

    out = {
        "as_of": as_of.isoformat(),
        "quantity": "Lula share of the two-candidate vote (%), total-vote basis",
        "current": {"lula": round(cur_trend, 2), "flavio": round(100 - cur_trend, 2),
                    "se": round(se, 2), "ci95": [round(cur_trend - 1.96 * se, 2),
                                                 round(cur_trend + 1.96 * se, 2)],
                    "n_eff": round(n_eff, 1), "poll_sd": round(sd, 2)},
        "series": series,
        "first_round_informed": adj,
        "house_effects": {k: {"effect": round(v, 2),
                              "polls": sum(1 for p in polls if p["pollster"] == k),
                              "first_round_polls": sum(1 for p in r1 if p["pollster"] == k)}
                          for k, v in sorted(house.items(), key=lambda kv: kv[1])},
        "polls": [{"id": p["poll_id"], "pollster": p["pollster"], "sponsor": p.get("sponsor"),
                   "start": p["field_start"], "end": p["field_end"], "release": p.get("release_date"),
                   "n": p["sample_size"], "moe": p.get("margin_of_error"),
                   "tse": p.get("tse_registration"), "rating": p["rating"],
                   "lula": p["lula_total"], "flavio": p["flavio_total"], "basis": p["basis"],
                   "blank": p.get("blank_null_total"), "undecided": p.get("undecided_total"),
                   "lula_valid": p.get("lula_valid"), "flavio_valid": p.get("flavio_valid"),
                   "lula_two_party": round(p["y"], 2),
                   "adjusted": round(p["y"] - house[p["pollster"]], 2),
                   "weight": round(ws[i] / sum(ws), 4), "mode": p["mode"],
                   "phase": p["phase"], "verification": p["verification"],
                   "url": p["primary_url"]}
                  for i, p in enumerate(polls)],
        "first_round_polls": [{"pollster": p["pollster"], "start": p["start"], "end": p["end"],
                               "n": p["n"], "y": round(p["y"], 3), "rating": p["rating"]} for p in r1_all],
        "params": {"start": START.isoformat(), "r1_weight": args.r1_weight, "half_life_days": HALF_LIFE, "freq_window_days": FREQ_WINDOW,
                   "shrink_k": SHRINK_K, "ratings_used": bool(ratings),
                   "first_round_polls_in_house_effects": len(r1)},
    }
    with open(os.path.join(DATA, "average.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    c = out["current"]
    print(f"as of {out['as_of']}: Lula {c['lula']:.2f}  Flávio {c['flavio']:.2f}  "
          f"(95% CI on Lula {c['ci95'][0]:.1f}-{c['ci95'][1]:.1f}; n_eff {c['n_eff']}, poll sd {c['poll_sd']})")
    if adj:
        print(f"first-round-informed: Lula {adj['lula']:.2f} (shift {adj['shift']:+.2f}, slope {adj['slope']})")
    for k, v in out["house_effects"].items():
        print(f"  {k:26}{v['polls']:3} +{v['first_round_polls']:3}  {v['effect']:+.2f}")


if __name__ == "__main__":
    main()
