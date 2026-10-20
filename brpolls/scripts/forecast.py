"""Win-probability simulation for the 25 Oct 2026 runoff (Lula vs Flávio Bolsonaro).

    python forecast.py   ->  ../data/forecast.json

Lula's share of the two-candidate (valid) vote = poll average
  + drift over the remaining days
  + a shared polling error (t-distributed, fat tails), sized from how far final-week poll
    averages missed in past presidential runoffs (rounds 2 of 2010-2022 in race_errors.csv)
Lula wins if his share is above 50. Two scenarios are reported:
  base          the poll average as is
  anchored      the average corrected pollster by pollster for how far its own final
                2026 first-round polls missed the official result (they understated
                Flávio), assuming half of that miss carries into the runoff
This is a first version: error sizes rest on only four past runoffs.
"""
import csv
import json
import math
import os
import random
import statistics as st
from collections import defaultdict

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
ELECTION_DAY = "2026-10-25"
N = 200_000
DF = 4
FLOOR_SD = 2.0   # points of two-party share; four runoffs (2010-2022) give ~1.2 rms, but the 2026 first round missed by ~1.7, so we stay cautious
DRIFT_PER_SQRT_DAY = 0.2


def history():
    rows = list(csv.DictReader(open(os.path.join(DATA, "race_errors.csv"), encoding="utf-8")))
    by = defaultdict(list)
    for r in rows:
        if r["race"].startswith(("2010-president", "2014-president", "2018-president", "2022-president")) \
                and r["race"].endswith("r2") and int(r["dte"]) <= 10:
            by[r["race"]].append(float(r["err"]))
    per_race = {k: st.mean(v) for k, v in by.items() if len(v) >= 2}
    miss26 = [float(r["err"]) for r in rows
              if r["race"] == "2026-president-BR-r1" and int(r["dte"]) <= 7]
    return per_race, (st.mean(miss26) if miss26 else 0.0), len(miss26)


def t_draw(rng, df):
    return rng.gauss(0, 1) / math.sqrt(rng.gammavariate(df / 2, 2) / df)


def simulate(center, sd_share, drift_sd, avg_se, shift, seed):
    rng = random.Random(seed)
    scale = sd_share / math.sqrt(DF / (DF - 2))   # so the t draw has the requested sd
    shares = []
    for _ in range(N):
        s = center + shift + scale * t_draw(rng, DF) + rng.gauss(0, drift_sd) + rng.gauss(0, avg_se)
        shares.append(s)
    return shares


def summary(shares):
    p = sum(1 for s in shares if s > 50) / len(shares)
    shares = sorted(shares)
    q = lambda f: round(shares[int(f * (len(shares) - 1))], 2)
    lo, hi = min(shares), max(shares)
    bins = [round(40 + i * 0.5, 1) for i in range(0, 41)]
    counts = [0] * (len(bins) - 1)
    for s in shares:
        if 40 <= s < 60:
            counts[int((s - 40) / 0.5)] += 1
    return {"p_lula": round(p, 4), "p_flavio": round(1 - p, 4),
            "lula_share": {"p05": q(0.05), "p25": q(0.25), "median": q(0.5), "p75": q(0.75), "p95": q(0.95)},
            "hist": {"bin_start": bins[:-1], "share": [round(c / len(shares), 5) for c in counts]}}


def main():
    avg = json.load(open(os.path.join(DATA, "average.json"), encoding="utf-8"))
    as_of = avg["as_of"]
    days = (__import__("datetime").date.fromisoformat(ELECTION_DAY)
            - __import__("datetime").date.fromisoformat(as_of)).days
    center, avg_se = avg["current"]["lula"], avg["current"]["se"]
    per_race, miss26, n26 = history()
    # per-race error is in margin points; share error is half of that
    errs_share = [e / 2 for e in per_race.values()]
    rmse = math.sqrt(sum(e * e for e in errs_share) / len(errs_share)) if errs_share else FLOOR_SD
    sd = max(rmse, FLOOR_SD)
    drift_sd = DRIFT_PER_SQRT_DAY * math.sqrt(max(days, 0))
    shift = miss26 / 2    # polls overstated Lula's share by -miss/2 if miss<0 (understated the winner Flávio)
    out = {
        "as_of": as_of, "election_day": ELECTION_DAY, "days_left": days,
        "poll_average_lula": center,
        "inputs": {"shared_error_sd": round(sd, 2), "empirical_rmse": round(rmse, 2),
                   "floor_sd": FLOOR_SD, "t_df": DF, "drift_sd": round(drift_sd, 2),
                   "average_se": avg_se, "simulations": N,
                   "past_runoff_final_week_error_margin_pts": {k: round(v, 2) for k, v in per_race.items()},
                   "first_round_2026_final_week_margin_error": round(miss26, 2),
                   "first_round_2026_polls_used": n26},
        "base": summary(simulate(center, sd, drift_sd, avg_se, 0.0, 1)),
    }
    if avg.get("anchored"):
        a_center = avg["anchored"]["lula"]
        out["anchored_poll_average_lula"] = a_center
        out["anchored"] = summary(simulate(a_center, sd, drift_sd, avg_se, 0.0, 2))
        out["anchored"]["note"] = ("Average corrected for each pollster's 2026 first-round miss "
                                   "(half assumed to persist): Lula %.2f vs %.2f." % (a_center, center))
    out["repeat_miss_uniform_shift_pts"] = round(shift, 2)
    with open(os.path.join(DATA, "forecast.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    b = out["base"]
    r = out.get("anchored", b)
    print(f"average Lula {center:.2f} ({days} days left); error sd {sd:.2f} (empirical {rmse:.2f})")
    print(f"base:        Lula {b['p_lula']:.1%}  Flávio {b['p_flavio']:.1%}  median Lula share {b['lula_share']['median']}")
    print(f"anchored:    Lula {r['p_lula']:.1%}  Flávio {r['p_flavio']:.1%}  (center {out.get('anchored_poll_average_lula')})")
    print(out["inputs"]["past_runoff_final_week_error_margin_pts"], out["inputs"]["first_round_2026_final_week_margin_error"])


if __name__ == "__main__":
    main()
