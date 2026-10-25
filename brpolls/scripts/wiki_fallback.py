"""Build unverified runoff-poll records straight from the Portuguese Wikipedia table.

    python wiki_fallback.py pt_runoff.json out.json [--skip-file verified_P.json ...]

Used on election week, when polls arrive faster than they can be checked at the source. A row whose two
candidate numbers sum to about 100 is stored as valid votes (same Lula-versus-Flávio share), otherwise as
totals. Rows already present in a --skip-file (same pollster and fieldwork end) are left out.
"""
import json
import sys

CANON = {"quaest": "Quaest", "poderdata/aya": "PoderData", "palver": "Palver", "nexus/btg": "Nexus", "btg/nexus": "Nexus",
         "gerp": "Gerp", "futura": "Futura", "datafolha": "Datafolha", "colectta": "Colectta", "atlasintel": "AtlasIntel",
         "veritá": "Veritá", "datatrends": "DataTrends"}
WANT = {("Quaest", "2026-10-24"), ("PoderData", "2026-10-24"), ("Palver", "2026-10-24"), ("Nexus", "2026-10-24"),
        ("Gerp", "2026-10-24"), ("Futura", "2026-10-24"), ("Datafolha", "2026-10-24"), ("Colectta", "2026-10-23"),
        ("AtlasIntel", "2026-10-23"), ("Veritá", "2026-10-23"), ("DataTrends", "2026-10-21")}


def main(src, out, skips):
    template = json.load(open("data/raw/verified_N.json"))[0]
    have = set()
    for f in skips:
        try:
            have |= {(r["pollster"], r["field_end"]) for r in json.load(open(f))}
        except FileNotFoundError:
            pass
    recs = []
    for x in json.load(open(src)):
        name = CANON.get(x["pollster"].lower().replace("datafolha", "datafolha"), None)
        if name is None:
            name = CANON.get(x["pollster"].lower().strip())
        if name is None or (name, x["end"]) not in WANT or (name, x["end"]) in have:
            continue
        r = {k: None for k in template}
        valid = x["lula"] + x["flavio"] >= 99.5
        r.update({"pollster": name, "field_start": x["start"], "field_end": x["end"], "release_date": x["end"],
                  "tse_registration": x["tse"], "sample_size": int(x["n"]) if x["n"] else None,
                  "margin_of_error": x["moe"], "mode": "unknown", "population": "national",
                  "scenario_note": None, "verification": "unverified", "wiki_matches": None,
                  "secondary_urls": [], "primary_url": "https://pt.wikipedia.org/wiki/Pesquisas_de_opinião_para_a_eleição_presidencial_no_Brasil_em_2026"})
        if valid:
            r["lula_valid"], r["flavio_valid"] = x["lula"], x["flavio"]
        else:
            r["lula_total"], r["flavio_total"] = x["lula"], x["flavio"]
        r["notes"] = ("Numbers taken from the Portuguese Wikipedia runoff table on 25 Oct (runoff day) without checking the "
                      "source; the row sums to " + ("100, so stored as valid votes." if valid else "less than 100, stored as total votes."))
        recs.append(r)
    json.dump(recs, open(out, "w"), ensure_ascii=False, indent=1)
    for r in recs:
        print(r["pollster"], r["field_start"], r["field_end"], r["lula_total"] or r["lula_valid"], r["flavio_total"] or r["flavio_valid"],
              "valid" if r["lula_valid"] else "total", r["tse_registration"])


if __name__ == "__main__":
    a = sys.argv[1:]
    skips = a[a.index("--skip-file") + 1:] if "--skip-file" in a else []
    main(a[0], a[1], skips)
