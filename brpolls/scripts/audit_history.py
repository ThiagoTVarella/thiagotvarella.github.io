#!/usr/bin/env python3
"""Audit the historical polls with the largest |err| in data/race_errors.csv."""
import csv, glob, json, os, re
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "data")
N = 25

polls = defaultdict(list)
for f in sorted(glob.glob(os.path.join(D, "hist", "polls_*.csv"))):
    with open(f, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            polls[r["poll_id"]].append(r)

def find(pid):
    if pid in polls:
        return pid
    for k in polls:  # tolerate scenario suffix added/dropped
        if k.startswith(pid + "-s") or pid.startswith(k + "-s"):
            return k
    return None

with open(os.path.join(D, "race_errors.csv"), newline="", encoding="utf-8") as fh:
    rows = [r for r in csv.DictReader(fh) if r["err"] not in ("", "nan")]
rows.sort(key=lambda r: -abs(float(r["err"])))

out = []
for r in rows[:N]:
    pid = find(r["poll_id"])
    recs = polls.get(pid, [])
    opts = []
    for p in recs:
        try: pct = float(p["pct"])
        except ValueError: pct = None
        opts.append({"option": p["option"], "party": p["party"], "pct": pct})
    tot = sum(o["pct"] or 0 for o in opts)
    flags = []
    if not recs:
        flags.append("poll_id not found in hist polls")
    else:
        if not (90 <= tot <= 105):
            flags.append(f"options sum {tot:.1f} outside 90-105")
        txt = " ".join((p.get("notes") or "") + " " + " ".join(o["option"] for o in opts) for p in recs[:1]).lower()
        if re.search(r"v[aá]lid", txt) or tot > 99.5 and not any(re.search(r"branc|nulo|indecis|ns/nr|none|undecided", o["option"].lower()) for o in opts):
            flags.append("possible valid-vote table")
        p0 = recs[0]
        if p0.get("field_start") and p0["field_start"] == p0.get("field_end"):
            flags.append("single-date poll")
        elif not p0.get("field_start"):
            flags.append("no field_start")
    if re.search(r"-s[2-9]\b", pid or r["poll_id"]):
        flags.append("scenario suffix " + re.search(r"-s[2-9]", pid or r["poll_id"]).group())
    out.append({"race": r["race"], "pollster": r["pollster"], "poll_id": r["poll_id"],
                "matched_poll_id": pid, "end": r["end"], "dte": r["dte"],
                "err": float(r["err"]), "pm": r["pm"], "bias_pt": r["bias_pt"],
                "options_sum": round(tot, 1), "options": opts, "flags": flags,
                "notes": recs[0].get("notes", "") if recs else ""})

with open(os.path.join(D, "hist", "audit.json"), "w", encoding="utf-8") as fh:
    json.dump({"n_scored": len(rows), "top": out}, fh, ensure_ascii=False, indent=1)

print(f"{'err':>6} {'sum':>6}  {'race':<26} {'pollster':<12} flags")
for o in out:
    print(f"{o['err']:>6.1f} {o['options_sum']:>6.1f}  {o['race']:<26} {o['pollster'][:12]:<12} {'; '.join(o['flags'])}")
