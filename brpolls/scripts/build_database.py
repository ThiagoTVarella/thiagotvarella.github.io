"""Merge the verified poll records into the clean database and run sanity checks.

    python build_database.py [--registry pesquisa_eleitoral_2026_BRASIL.csv]

Reads ../data/raw/verified_*.json plus the manual decisions in
../data/raw/overrides.json, writes ../data/polls_runoff_lula_flavio.{csv,json}
and prints any check failures. With --registry, each poll is joined to its TSE
registration (registrant company, planned field dates and sample size).
"""
import glob
import csv
import json
import os
import re
import sys
import unicodedata

FIRST_ROUND = "2026-10-04"
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

FIELDS = [
    "poll_id", "pollster", "sponsor", "phase", "field_start", "field_end",
    "release_date", "tse_registration", "sample_size", "margin_of_error",
    "confidence_level", "mode", "population", "lula_total", "flavio_total",
    "blank_null_total", "undecided_total", "lula_valid", "flavio_valid",
    "lula_two_party", "verification", "wiki_matches", "scenario_note",
    "primary_url", "secondary_urls", "notes", "tse_registrant",
    "tse_planned_start", "tse_planned_end", "tse_planned_sample", "checks",
]

MODES = {"face-to-face", "phone-live", "phone-ivr", "online-panel",
         "online-rdd", "mixed", "unknown"}


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def check(p):
    issues = []
    if p["field_start"] and p["field_end"] and p["field_start"] > p["field_end"]:
        issues.append("field_start after field_end")
    if p.get("release_date") and p["field_end"] and p["release_date"] < p["field_end"]:
        issues.append("released before fieldwork ended")
    parts = [p.get(k) for k in ("lula_total", "flavio_total",
                                "blank_null_total", "undecided_total")]
    if all(v is not None for v in parts[:2]):
        total = sum(v for v in parts if v is not None)
        if not 97 <= total <= 103:
            issues.append(f"total-vote shares sum to {total:g}")
    lv, fv = p.get("lula_valid"), p.get("flavio_valid")
    if lv is not None and fv is not None:
        if not 99 <= lv + fv <= 101:
            issues.append(f"valid votes sum to {lv + fv:g}")
        lt, ft = p.get("lula_total"), p.get("flavio_total")
        if lt and ft and abs(100 * lt / (lt + ft) - lv) > 1.6:
            issues.append("valid share inconsistent with total-vote shares")
    if p.get("mode") not in MODES:
        issues.append(f"unknown mode {p.get('mode')!r}")
    if p.get("sample_size") is None:
        issues.append("missing sample size")
    if not p.get("tse_registration"):
        issues.append("missing TSE registration")
    return issues


def load_registry(path):
    with open(path, encoding="latin1") as f:
        rows = csv.DictReader(f, delimiter=";")
        return {f"{r['NR_PROTOCOLO_REGISTRO'][:2]}-{r['NR_PROTOCOLO_REGISTRO'][2:7]}/"
                f"{r['NR_PROTOCOLO_REGISTRO'][7:]}": r for r in rows}


def apply_overrides(polls, path):
    for o in json.load(open(path, encoding="utf-8")):
        hits = [p for p in polls
                if all(p.get(k) == v for k, v in o["match"].items())]
        if len(hits) != 1:
            sys.exit(f"override matched {len(hits)} polls: {o['match']}")
        hits[0].update(o["set"])
        hits[0]["notes"] = f"{hits[0].get('notes') or ''} [Override: {o['why']}]".strip()


def main(args):
    registry = load_registry(args[1]) if args[:1] == ["--registry"] else {}
    polls = []
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "raw", "verified_*.json"))):
        polls.extend(json.load(open(path, encoding="utf-8")))
    apply_overrides(polls, os.path.join(DATA_DIR, "raw", "overrides.json"))

    # drop exact duplicates (same pollster and field window), keeping the better-verified one
    rank = {"verified-primary": 0, "verified-secondary": 1, "conflict": 2, "unverified": 3}
    best = {}
    for p in polls:
        key = (slug(p["pollster"]), p["field_start"], p["field_end"])
        if key not in best or rank.get(p["verification"], 9) < rank.get(best[key]["verification"], 9):
            best[key] = p
    polls = sorted(best.values(), key=lambda p: (p["field_end"], p["pollster"]), reverse=True)

    for p in polls:
        p["poll_id"] = f"{slug(p['pollster'])}-{p['field_end']}"
        p["phase"] = "post_first_round" if p["field_start"] > FIRST_ROUND else "pre_first_round"
        lt, ft = p.get("lula_total"), p.get("flavio_total")
        p["lula_two_party"] = round(100 * lt / (lt + ft), 2) if lt and ft else None
        reg = registry.get((p.get("tse_registration") or "").strip())
        if reg:
            p["tse_registrant"] = reg["NM_EMPRESA"]
            p["tse_planned_start"] = reg["DT_INICIO_PESQUISA"][:10]
            p["tse_planned_end"] = reg["DT_FIM_PESQUISA"][:10]
            p["tse_planned_sample"] = int(reg["QT_ENTREVISTADO"])
        p["checks"] = "; ".join(check(p))
        if registry and p.get("tse_registration") and not reg:
            p["checks"] = "; ".join(filter(None, [p["checks"], "registration not found in TSE registry"]))
    ids = [p["poll_id"] for p in polls]
    dupes = {i for i in ids if ids.count(i) > 1}
    for p in polls:
        if p["poll_id"] in dupes:
            p["poll_id"] += "-" + p["field_start"][5:].replace("-", "")

    base = os.path.join(DATA_DIR, "polls_runoff_lula_flavio")
    with open(base + ".json", "w", encoding="utf-8") as f:
        json.dump([{k: p.get(k) for k in FIELDS} for p in polls], f,
                  ensure_ascii=False, indent=1)
    with open(base + ".csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, FIELDS)
        w.writeheader()
        for p in polls:
            row = {k: p.get(k) for k in FIELDS}
            row["secondary_urls"] = " ".join(p.get("secondary_urls") or [])
            w.writerow(row)

    print(f"{len(polls)} polls written")
    by = {}
    for p in polls:
        by[p["verification"]] = by.get(p["verification"], 0) + 1
    print("verification:", by)
    for p in polls:
        if p["checks"]:
            print(f"  {p['poll_id']}: {p['checks']}")


if __name__ == "__main__":
    main(sys.argv[1:])
