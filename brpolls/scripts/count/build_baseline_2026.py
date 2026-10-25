"""Build the first-round 2026 municipal baseline for the live runoff count projection.

Download the section-level first-round results (161 MB zip, ~1 GB CSV inside):
    curl -O https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip
then run (the zip is streamed; it does not need to be extracted):
    python build_baseline_2026.py votacao_secao_2026_BR.zip ../../data/count/baseline_2026.json

Output: compact JSON with one row per municipality (abroad cities under uf 'zz'):
    uf, cd (TSE CD_MUNICIPIO, 5 digits), nm, sec (sections with president votes),
    v1 (valid R1 votes = l1+f1+o1), l1 (Lula, 13), f1 (Flávio, 22), o1 (other valid),
    sd (vote-weighted SD across sections of logit(Lula/(Lula+Flávio)), shares
        clipped to [0.02, 0.98]; null when fewer than 3 sections have L+F votes).
"""
import csv
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

SOURCE = "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip"
LULA, FLAVIO, BRANCO, NULO = 13, 22, 95, 96
CLIP = 0.02


def open_csv(path):
    if path.endswith(".zip"):
        z = zipfile.ZipFile(path)
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        return io.TextIOWrapper(z.open(name), encoding="latin-1", newline="")
    return open(path, encoding="latin-1", newline="")


def logit(p):
    p = min(max(p, CLIP), 1 - CLIP)
    return math.log(p / (1 - p))


def main(src, out):
    reader = csv.reader(open_csv(src), delimiter=";")
    header = next(reader)
    ix = {h: i for i, h in enumerate(header)}
    i_turno, i_uf, i_mun, i_nm = ix["NR_TURNO"], ix["SG_UF"], ix["CD_MUNICIPIO"], ix["NM_MUNICIPIO"]
    i_zona, i_sec, i_cargo, i_dcargo = ix["NR_ZONA"], ix["NR_SECAO"], ix["CD_CARGO"], ix["DS_CARGO"]
    i_nr, i_qt = ix["NR_VOTAVEL"], ix["QT_VOTOS"]

    names = {}
    # section key -> [lula, flavio, other_valid]
    secs = defaultdict(lambda: [0, 0, 0])
    nrows = skipped = 0
    for r in reader:
        if r[i_cargo] != "1" and r[i_dcargo] != "Presidente":
            continue
        if r[i_turno] != "1":
            skipped += 1
            continue
        nrows += 1
        mk = (r[i_uf].lower(), r[i_mun].zfill(5))
        names[mk] = r[i_nm]
        s = secs[mk + (r[i_zona], r[i_sec])]
        nr, q = int(r[i_nr]), int(r[i_qt])
        if nr == LULA:
            s[0] += q
        elif nr == FLAVIO:
            s[1] += q
        elif nr in (BRANCO, NULO):
            pass
        else:
            s[2] += q

    muns = defaultdict(list)
    for k, v in secs.items():
        muns[k[:2]].append(v)

    rows, lf_per_sec = [], []
    tl = tf = to = 0
    for mk in sorted(muns):
        ss = muns[mk]
        l1 = sum(s[0] for s in ss)
        f1 = sum(s[1] for s in ss)
        o1 = sum(s[2] for s in ss)
        tl, tf, to = tl + l1, tf + f1, to + o1
        lf_per_sec.extend(s[0] + s[1] for s in ss)
        pts = [(logit(s[0] / (s[0] + s[1])), s[0] + s[1]) for s in ss if s[0] + s[1] > 0]
        sd = None
        if len(pts) >= 3:
            w = sum(p[1] for p in pts)
            m = sum(x * wt for x, wt in pts) / w
            sd = round(math.sqrt(sum(wt * (x - m) ** 2 for x, wt in pts) / w), 4)
        rows.append([mk[0], mk[1], names[mk], len(ss), l1 + f1 + o1, l1, f1, o1, sd])

    meta = {
        "source": SOURCE,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "election": "2026 R1 presidente",
        "notes": ("Section-level TSE first-round results aggregated to TSE municipality codes "
                  "(abroad cities under uf 'zz'). v1 = valid votes (excl. 95 branco, 96 nulo); "
                  "o1 = valid votes for candidates other than 13 and 22. sd = (L+F)-vote-weighted "
                  "SD across sections of logit(L/(L+F)), shares clipped to [0.02,0.98]; null if "
                  "fewer than 3 sections with L+F votes."),
        "sec_lf_mean": round(sum(lf_per_sec) / len(lf_per_sec), 3),
        "n_mun": len(rows),
        "n_sec": len(secs),
        "tot_l1": tl, "tot_f1": tf, "tot_o1": to, "tot_v1": tl + tf + to,
        "lula_2p": round(tl / (tl + tf), 6),
    }
    doc = {"meta": meta, "cols": ["uf", "cd", "nm", "sec", "v1", "l1", "f1", "o1", "sd"], "mun": rows}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"president rows {nrows:,}; non-R1 skipped {skipped:,}", file=sys.stderr)
    print(json.dumps(meta, ensure_ascii=False, indent=1), file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
