"""Diagnostics on runoff house effects (Lula two-candidate share).

    python house_diagnostics.py [--ratings ../data/pollster_ratings.json] [--as-of YYYY-MM-DD]   (default: today)

Re-runs average.py's joint trend/house-effect estimation, then takes each runoff poll's
residual from the house-effect-free trend (leave-one-out, as in average.py):
    resid = y - trend_at(t, other runoff polls, house)
i.e. the poll's raw deviation before subtracting its own house effect. Reports:
  mode         mean residual by interview mode, n, SE = sd/sqrt(n)
  phase_shift  per pollster mean residual pre vs post first round, and the cross-pollster correlation
  significance per pollster mean residual, SE = sd/sqrt(n), t, and the shrunk house effect from average.py
Writes ../data/house_diagnostics.json.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from average import DATA, SHRINK_K, d, load, load_r1, trend_at  # noqa: E402

MODES = ["phone-ivr", "phone-live", "face-to-face", "online-panel", "online-rdd", "unknown"]


def stats(v):
    n = len(v)
    if n == 0:
        return {"n": 0, "mean": None, "sd": None, "se": None}
    m = sum(v) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / (n - 1)) if n > 1 else None
    se = sd / math.sqrt(n) if sd is not None else None
    return {"n": n, "mean": round(m, 2), "sd": None if sd is None else round(sd, 2),
            "se": None if se is None else round(se, 2)}


def corr(x, y):
    n = len(x)
    if n < 3:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    return sxy / math.sqrt(sxx * syy) if sxx and syy else None


def estimate_house(everything):
    # identical to average.main()
    house = defaultdict(float)
    for _ in range(40):
        resid = defaultdict(list)
        for p in everything:
            same = [q for q in everything if q["series"] == p["series"] and q is not p]
            tr, _ = trend_at(p["t"], same, house)
            if tr is not None:
                resid[p["pollster"]].append(p["y"] - tr)
        new = {k: sum(v) / (len(v) + SHRINK_K) for k, v in resid.items()}
        total = sum(len(v) for v in resid.values())
        mean = sum(new[k] * len(resid[k]) for k in new) / total
        house = defaultdict(float, {k: v - mean for k, v in new.items()})
    return house


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default=min(dt.date.today(), dt.date(2026, 10, 25)).isoformat())
    ap.add_argument("--ratings", default=os.path.join(DATA, "pollster_ratings.json"))
    args = ap.parse_args()
    as_of = d(args.as_of)
    ratings = {}
    if args.ratings and os.path.exists(args.ratings):
        ratings = {k: v["weight"] for k, v in json.load(open(args.ratings)).items()}
    polls = load(as_of, ratings)
    for p in polls:
        p["series"] = "runoff"
    house = estimate_house(polls + load_r1(ratings))

    rows = []
    for p in polls:
        tr, _ = trend_at(p["t"], [q for q in polls if q is not p], house)
        if tr is not None:
            rows.append({"pollster": p["pollster"], "mode": p.get("mode") or "unknown",
                         "phase": p["phase"], "resid": p["y"] - tr})

    # (a) mode
    by_mode = defaultdict(list)
    for r in rows:
        by_mode[r["mode"] if r["mode"] in MODES else "unknown"].append(r["resid"])
    mode = {m: stats(by_mode[m]) for m in MODES}
    for m in by_mode:
        if m not in mode:
            mode[m] = stats(by_mode[m])
    # also: residual net of house effect, to see if mode explains anything beyond pollster
    net = defaultdict(list)
    for r in rows:
        net[r["mode"] if r["mode"] in MODES else "unknown"].append(r["resid"] - house[r["pollster"]])
    mode_pollsters = defaultdict(set)
    for r in rows:
        mode_pollsters[r["mode"]].add(r["pollster"])
    for m in mode:
        mode[m]["mean_after_house"] = stats(net[m])["mean"]
        mode[m]["pollsters"] = sorted(mode_pollsters[m])

    # (b) phase shift
    ph = defaultdict(lambda: defaultdict(list))
    for r in rows:
        ph[r["pollster"]][r["phase"]].append(r["resid"])
    shift_rows = {}
    xs, ys = [], []
    for k, v in sorted(ph.items()):
        if v["pre_first_round"] and v["post_first_round"]:
            a, b = stats(v["pre_first_round"]), stats(v["post_first_round"])
            shift_rows[k] = {"pre": a["mean"], "n_pre": a["n"], "post": b["mean"], "n_post": b["n"],
                             "change": round(b["mean"] - a["mean"], 2)}
            xs.append(sum(v["pre_first_round"]) / a["n"])
            ys.append(sum(v["post_first_round"]) / b["n"])
    c = corr(xs, ys)
    phase_all = {k: stats([r["resid"] for r in rows if r["phase"] == k])
                 for k in ("pre_first_round", "post_first_round")}
    phase_shift = {"pollsters": shift_rows, "n_pollsters": len(xs),
                   "correlation_pre_post": None if c is None else round(c, 2),
                   "mean_abs_change": round(sum(abs(v["change"]) for v in shift_rows.values()) / len(shift_rows), 2)
                   if shift_rows else None,
                   "all_polls_by_phase": phase_all}

    # (c) significance
    sig = {}
    pooled = [r["resid"] - (sum(x["resid"] for x in rows if x["pollster"] == r["pollster"]) /
                            sum(1 for x in rows if x["pollster"] == r["pollster"])) for r in rows]
    by_p = defaultdict(list)
    for r in rows:
        by_p[r["pollster"]].append(r["resid"])
    pooled_sd = math.sqrt(sum(e * e for e in pooled) / max(1, len(rows) - len(by_p)))
    for k, v in by_p.items():
        s = stats(v)
        se = s["se"] if s["se"] else pooled_sd / math.sqrt(s["n"])
        t = s["mean"] / se if se else None
        sig[k] = {"effect_raw_mean": s["mean"], "n": s["n"], "sd": s["sd"], "se": round(se, 2),
                  "se_source": "own sd" if s["se"] else "pooled sd (n=1)",
                  "t": None if t is None else round(t, 2),
                  "significant_2se": bool(t is not None and abs(t) >= 2),
                  "house_effect_shrunk": round(house[k], 2)}
    sig = dict(sorted(sig.items(), key=lambda kv: kv[1]["effect_raw_mean"]))
    n_sig = sum(v["significant_2se"] for v in sig.values())

    # summary
    md = [(m, s) for m, s in mode.items() if s["n"] >= 2]
    lo = min(md, key=lambda ms: ms[1]["mean"])
    hi = max(md, key=lambda ms: ms[1]["mean"])
    sig_names = [k for k, v in sig.items() if v["significant_2se"]]
    summary = (
        f"Mode: mean residuals range from {lo[1]['mean']:+.2f} ({lo[0]}, n={lo[1]['n']}, SE {lo[1]['se']}) "
        f"to {hi[1]['mean']:+.2f} ({hi[0]}, n={hi[1]['n']}, SE {hi[1]['se']}), but each mode holds only a handful of "
        f"pollsters and after subtracting house effects the mode means only span "
        f"{min(v['mean_after_house'] for v in mode.values() if v['n']):+.2f} to {max(v['mean_after_house'] for v in mode.values() if v['n']):+.2f}, so there is no clear mode effect beyond pollster. "
        f"Phase: across the {len(xs)} pollsters polling both before and after the first round, pre- and post-round mean "
        f"residuals correlate at r={c:.2f} (mean absolute change {phase_shift['mean_abs_change']:.2f} points), "
        f"{'so house effects largely persisted' if c is not None and c >= 0.5 else 'so house effects were not very stable across phases'}. "
        f"Significance: {n_sig} of {len(sig)} pollsters have a mean residual beyond 2 rough SEs "
        f"({', '.join(sig_names) if sig_names else 'none'}); the rest are not distinguishable from zero with these few polls."
    )

    out = {"as_of": as_of.isoformat(),
           "quantity": "residual of Lula two-candidate share from the house-effect-free leave-one-out trend (points)",
           "n_polls": len(rows), "mode": mode, "phase_shift": phase_shift,
           "significance": {"pollsters": sig, "n_significant_2se": n_sig, "pooled_within_sd": round(pooled_sd, 2)},
           "summary": summary}
    with open(os.path.join(DATA, "house_diagnostics.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("mode:")
    for m, s in mode.items():
        print(f"  {m:14}n={s['n']:3} mean={s['mean']} se={s['se']} net={s['mean_after_house']} {s['pollsters']}")
    print(f"phase: r={phase_shift['correlation_pre_post']} n={len(xs)}")
    for k, v in shift_rows.items():
        print(f"  {k:24}{v['pre']:+.2f} ({v['n_pre']}) -> {v['post']:+.2f} ({v['n_post']})")
    print("significance:")
    for k, v in sig.items():
        print(f"  {k:24}n={v['n']:3} {v['effect_raw_mean']:+.2f} se={v['se']} t={v['t']} shrunk={v['house_effect_shrunk']:+.2f}")
    print(summary)


if __name__ == "__main__":
    main()
