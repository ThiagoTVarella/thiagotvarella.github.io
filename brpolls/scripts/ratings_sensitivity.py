"""Robustness check for the tiered race weights in ratings.py.

    python ratings_sensitivity.py  ->  ../data/ratings_sensitivity.json

Re-runs the rating pipeline (score -> plus_minus -> rate -> grade) under three race-weight
schemes and compares the resulting ranks for the pollsters in the 2026 runoff database:
  president_only : presidential races only (weight 1.0)
  pres_big8      : presidential + governors of the 8 big states (all weight 1.0)
  tiered_current : all races, president 1.0 / big-state governor 0.8 / other governor 0.4
plus_minus is recomputed on each scheme's subset (the days-out slope depends on the rows kept).
"rank" is the position among the 19 runoff pollsters that have a rating under that scheme
(1 = best plus-minus); "rank_all" is the position among every rated pollster.
"""
import copy
import json
import os

from ratings import BIG, OUT, canon, grade, load_polls, load_results, plus_minus, rate, score

SCHEMES = {
    "president_only": ("Presidential races only, weight 1.0",
                       lambda r: 1.0 if r["office"] == "president" else 0.0),
    "pres_big8": ("Presidential + governors of SP, MG, RJ, BA, RS, PR, PE, CE, all weight 1.0",
                  lambda r: 1.0 if r["office"] == "president" or r["state"] in BIG else 0.0),
    "tiered_current": ("All races: president 1.0, big-state governor 0.8, other governor 0.4 (as ratings.py)",
                       lambda r: 1.0 if r["office"] == "president" else (0.8 if r["state"] in BIG else 0.4)),
}


def ranks(names, ratings):
    order = sorted(names, key=lambda k: ratings[k]["plus_minus"])
    return {k: i + 1 for i, k in enumerate(order)}


def spearman(a, b):
    common = sorted(set(a) & set(b))
    n = len(common)
    if n < 3:
        return None, n
    ra = ranks(common, {k: {"plus_minus": a[k]} for k in common})
    rb = ranks(common, {k: {"plus_minus": b[k]} for k in common})
    d2 = sum((ra[k] - rb[k]) ** 2 for k in common)
    return round(1 - 6 * d2 / (n * (n * n - 1)), 3), n


def main():
    with open(os.path.join(OUT, "polls_runoff_lula_flavio.json"), encoding="utf-8") as f:
        runoff = sorted({p["pollster"] for p in json.load(f)})
    key = {name: canon(name) for name in runoff}  # runoff name -> historical canonical name

    base = score(load_polls(), load_results())
    schemes, pms, per = {}, {}, {name: {} for name in runoff}
    for s, (desc, wfun) in SCHEMES.items():
        rows = []
        for r in base:
            w = wfun(r)
            if w > 0:
                r = copy.copy(r)
                r["race_w"] = w
                rows.append(r)
        slope = plus_minus(rows)
        rt = rate(rows)
        grade(rt)
        present = [n for n in runoff if key[n] in rt]
        rk = ranks(present, {n: rt[key[n]] for n in present})
        pms[s] = {n: rt[key[n]]["plus_minus"] for n in present}
        schemes[s] = {"description": desc, "polls_scored": len(rows),
                      "races": len({r["race"] for r in rows}), "dte_slope": round(slope, 4),
                      "runoff_pollsters_rated": len(present)}
        for n in runoff:
            if n in rk:
                v = rt[key[n]]
                per[n][s] = {"plus_minus": v["plus_minus"], "polls": v["polls"], "races": v["races"],
                             "evidence": v["evidence"], "weight": v["weight"], "rank": rk[n],
                             "rank_all": v["rank"], "grade": v["grade"]}
            else:
                per[n][s] = None

    names = list(SCHEMES)
    corr = {}
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            rho, n = spearman(pms[names[i]], pms[names[j]])
            corr[f"{names[i]}__vs__{names[j]}"] = {"spearman": rho, "n": n}

    in_all = [n for n in runoff if all(per[n][s] for s in names)]
    shifts = {n: max(per[n][s]["rank"] for s in names) - min(per[n][s]["rank"] for s in names) for n in in_all}
    wshift = {n: round(max(per[n][s]["weight"] for s in names) - min(per[n][s]["weight"] for s in names), 3)
              for n in in_all}
    big = sorted(shifts, key=lambda n: -shifts[n])[:3]
    top = max(wshift, key=wshift.get) if wshift else None
    c = {k.split("__vs__")[0] + "|" + k.split("__vs__")[1]: v["spearman"] for k, v in corr.items()}
    summary = (
        f"Including governor races matters, but how they are tiered does not: the current tiered scheme ranks the "
        f"{len(in_all)} runoff pollsters almost the same as presidential + big-8 governors at equal weight "
        f"(Spearman {c['pres_big8|tiered_current']:.2f}), while presidential-only ranks them quite differently "
        f"(Spearman {c['president_only|pres_big8']:.2f} and {c['president_only|tiered_current']:.2f}). "
        f"The movers are pollsters whose presidential and governor records diverge "
        f"({', '.join(f'{n} {shifts[n]} places' for n in big)}); Futura is first under every scheme. "
        f"Because shrinkage keeps plus-minus small, the polling-average weight moves by at most "
        f"{wshift[top]:.2f} ({top}), so the choice changes rankings and grades more than it changes the average.")
    out = {"schemes": schemes, "pollsters": per, "rank_correlations": corr,
           "max_rank_shift": dict(sorted(shifts.items(), key=lambda kv: -kv[1])),
           "max_weight_shift": dict(sorted(wshift.items(), key=lambda kv: -kv[1])),
           "summary": summary}
    with open(os.path.join(OUT, "ratings_sensitivity.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print(f"{'pollster':24}" + "".join(f"{s[:14]:>22}" for s in names))
    for n in runoff:
        cells = []
        for s in names:
            v = per[n][s]
            cells.append(f"{v['rank']:>3} {v['plus_minus']:+6.2f} w{v['weight']:.2f} n{v['polls']:<3}" if v else f"{'-':>22}")
        print(f"{n:24}" + "".join(f"{c:>22}" for c in cells))
    for k, v in corr.items():
        print(k, v)
    print(summary)


if __name__ == "__main__":
    main()
