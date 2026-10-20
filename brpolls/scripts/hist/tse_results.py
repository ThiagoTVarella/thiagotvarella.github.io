"""Official president and governor results from TSE open data, by state and round.

    python tse_results.py 2022 2026 ... > results.csv   (appends header once per run)

Streams votacao_candidato_munzona_<year>.zip from the TSE CDN, keeps president
and governor rows from the regular election, and sums votes over
municipalities and zones. President rows are also summed to a national "BR"
total (including votes cast abroad, UF "ZZ"). Shares are of valid votes, the
basis TSE uses to declare results.
"""
import csv
import io
import os
import sys
import tempfile
import urllib.request
import zipfile
from collections import defaultdict

URL = "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_candidato_munzona/votacao_candidato_munzona_{}.zip"
OFFICES = {"PRESIDENTE": "president", "GOVERNADOR": "governor"}


def rows(year):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "f.zip")
        urllib.request.urlretrieve(URL.format(year), path)
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                # one file per UF plus a BRASIL file that repeats them all
                if not name.endswith(".csv") or "BRASIL" in name.upper():
                    continue
                with z.open(name) as f:
                    yield from csv.DictReader(io.TextIOWrapper(f, encoding="latin1"),
                                              delimiter=";")


def main(years):
    out = csv.writer(sys.stdout)
    out.writerow(["year", "round", "office", "state", "candidate_number",
                  "candidate", "party", "votes", "valid_votes", "share_valid", "result"])
    for year in years:
        votes = defaultdict(int)
        meta = {}
        for r in rows(year):
            office = OFFICES.get(r["DS_CARGO"].strip().upper())
            if not office or "SUPLEMENTAR" in r.get("NM_TIPO_ELEICAO", "").upper():
                continue
            v = r.get("QT_VOTOS_NOMINAIS_VALIDOS") or r["QT_VOTOS_NOMINAIS"]
            v = int(v) if v and v.lstrip("-").isdigit() and int(v) > 0 else 0
            states = [r["SG_UF"]] + (["BR"] if office == "president" else [])
            for st in states:
                if office == "president" and st != "BR":
                    continue  # state-level president totals not needed for ratings
                key = (r["NR_TURNO"], office, st, r["NR_CANDIDATO"])
                votes[key] += v
                meta[key] = (r["NM_URNA_CANDIDATO"], r["SG_PARTIDO"],
                             r.get("DS_SIT_TOT_TURNO", ""))
        totals = defaultdict(int)
        for (rnd, office, st, _), v in votes.items():
            totals[(rnd, office, st)] += v
        for key in sorted(votes, key=lambda k: (k[0], k[1], k[2], -votes[k])):
            rnd, office, st, num = key
            tot = totals[(rnd, office, st)]
            name, party, res = meta[key]
            out.writerow([year, rnd, office, st, num, name, party, votes[key], tot,
                          round(100 * votes[key] / tot, 3) if tot else "", res])
        sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv[1:])
