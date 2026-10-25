#!/usr/bin/env python3
"""Build a replay of the 2022 presidential runoff count (Lula 13 x Bolsonaro 22)
for testing the live vote-count projection model.

Inputs (TSE open data, downloaded beforehand):
  --zips DIR   bweb_2t_<UF>.zip  (ballot-box bulletins, R2 30/10/2022, one per UF + ZZ)
  --r1zip PATH votacao_secao_2022_BR.zip (section-level presidential results)
  --cache DIR  scratch dir for parsed section tables (pickles)
Outputs (brpolls/data/count/replay2022/ by default):
  baseline.json, snap_<pct>.json, truth.json, params_2022.json

Run with `python3 -I` since inputs are untrusted downloads.
"""
import argparse
import glob
import io
import json
import math
import os
import sys
import zipfile

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "..", "data", "count", "replay2022"))
CHECKPOINTS = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 95, 98, 99, 100]
SIZE_BINS = [0, 2000, 10000, 50000, 200000, np.inf]
SIZE_LABELS = ["<2k", "2-10k", "10-50k", "50-200k", ">200k"]
CLIP = (0.02, 0.98)


def logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    return np.log(p / (1 - p))


def r(x, n=4):
    if x is None:
        return None
    try:
        if not np.isfinite(x):
            return None
    except TypeError:
        return x
    return round(float(x), n)


def elogit(l, f):
    """Empirical logit of l/(l+f) with +0.5 smoothing (robust for tiny counts)."""
    return np.log((np.asarray(l, float) + 0.5) / (np.asarray(f, float) + 0.5))


def rsd(x):
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if len(x) else float("nan")


def wmean(x, w):
    x = np.asarray(x, float); w = np.asarray(w, float)
    m = np.isfinite(x) & (w > 0)
    return float(np.sum(x[m] * w[m]) / np.sum(w[m])) if m.any() else float("nan")


def wsd(x, w):
    x = np.asarray(x, float); w = np.asarray(w, float)
    m = np.isfinite(x) & (w > 0)
    if m.sum() < 2:
        return float("nan")
    mu = np.sum(x[m] * w[m]) / np.sum(w[m])
    return float(np.sqrt(np.sum(w[m] * (x[m] - mu) ** 2) / np.sum(w[m])))


# ---------------------------------------------------------------- parsing

def csv_member(z):
    return [n for n in z.namelist() if n.lower().endswith(".csv")][0]


def parse_r2(zips_dir, cache):
    path = os.path.join(cache, "r2_sections.pkl")
    if os.path.exists(path):
        return pd.read_pickle(path)
    cols = ["SG_UF", "CD_MUNICIPIO", "NM_MUNICIPIO", "NR_ZONA", "NR_SECAO", "DS_CARGO_PERGUNTA",
            "DT_BU_RECEBIDO", "QT_APTOS", "QT_COMPARECIMENTO", "NR_VOTAVEL", "QT_VOTOS"]
    parts = []
    for zp in sorted(glob.glob(os.path.join(zips_dir, "bweb_2t_*.zip"))):
        z = zipfile.ZipFile(zp)
        with z.open(csv_member(z)) as fh:
            rdr = pd.read_csv(fh, sep=";", encoding="latin-1", usecols=cols, dtype=str, chunksize=1_000_000)
            for ch in rdr:
                ch = ch[ch["DS_CARGO_PERGUNTA"] == "Presidente"]
                parts.append(ch.drop(columns="DS_CARGO_PERGUNTA"))
        print("parsed", os.path.basename(zp), file=sys.stderr)
    df = pd.concat(parts, ignore_index=True)
    for c in ["CD_MUNICIPIO", "NR_ZONA", "NR_SECAO", "QT_APTOS", "QT_COMPARECIMENTO", "NR_VOTAVEL", "QT_VOTOS"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("int64")
    key = ["SG_UF", "CD_MUNICIPIO", "NR_ZONA", "NR_SECAO"]
    df["cat"] = np.select([df.NR_VOTAVEL == 13, df.NR_VOTAVEL == 22, df.NR_VOTAVEL == 95, df.NR_VOTAVEL == 96],
                          ["l", "f", "b", "n"], "x")
    votes = df.pivot_table(index=key, columns="cat", values="QT_VOTOS", aggfunc="sum", fill_value=0)
    for c in "lfbnx":
        if c not in votes:
            votes[c] = 0
    first = df.groupby(key).agg(nm=("NM_MUNICIPIO", "first"), t=("DT_BU_RECEBIDO", "first"),
                                aptos=("QT_APTOS", "first"), comp=("QT_COMPARECIMENTO", "first"))
    sec = first.join(votes[list("lfbnx")]).reset_index()
    sec["t"] = pd.to_datetime(sec["t"], format="%d/%m/%Y %H:%M:%S", errors="coerce")
    sec = sec.rename(columns={"SG_UF": "uf", "CD_MUNICIPIO": "cd", "NR_ZONA": "zona", "NR_SECAO": "secao"})
    sec["uf"] = sec["uf"].str.lower()
    sec.to_pickle(path)
    return sec


def parse_r1(r1zip, cache):
    path = os.path.join(cache, "r1_sections.pkl")
    if os.path.exists(path):
        return pd.read_pickle(path)
    cols = ["NR_TURNO", "SG_UF", "CD_MUNICIPIO", "NM_MUNICIPIO", "NR_ZONA", "NR_SECAO", "CD_CARGO", "NR_VOTAVEL", "QT_VOTOS"]
    z = zipfile.ZipFile(r1zip)
    parts = []
    with z.open(csv_member(z)) as fh:
        rdr = pd.read_csv(fh, sep=";", encoding="latin-1", usecols=cols, dtype=str, chunksize=2_000_000)
        for i, ch in enumerate(rdr):
            ch = ch[(ch["NR_TURNO"] == "1") & (ch["CD_CARGO"] == "1")]
            parts.append(ch.drop(columns=["NR_TURNO", "CD_CARGO"]))
            print("r1 chunk", i, file=sys.stderr)
    df = pd.concat(parts, ignore_index=True)
    for c in ["CD_MUNICIPIO", "NR_ZONA", "NR_SECAO", "NR_VOTAVEL", "QT_VOTOS"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("int64")
    key = ["SG_UF", "CD_MUNICIPIO", "NR_ZONA", "NR_SECAO"]
    df["cat"] = np.select([df.NR_VOTAVEL == 13, df.NR_VOTAVEL == 22, df.NR_VOTAVEL.isin([95, 96, 97])],
                          ["l1", "f1", "bn1"], "o1")
    votes = df.pivot_table(index=key, columns="cat", values="QT_VOTOS", aggfunc="sum", fill_value=0)
    nm = df.groupby(key)["NM_MUNICIPIO"].first()
    sec = votes.join(nm).reset_index().rename(columns={"SG_UF": "uf", "CD_MUNICIPIO": "cd", "NR_ZONA": "zona",
                                                       "NR_SECAO": "secao", "NM_MUNICIPIO": "nm"})
    sec["uf"] = sec["uf"].str.lower()
    sec.to_pickle(path)
    return sec


# ---------------------------------------------------------------- helpers

def ukey(uf, cd):
    return f"{uf}{int(cd):05d}"


def within_sd(sec, lcol, fcol, min_n=3):
    """Weighted sd across sections of clipped logit two-party share, per municipality."""
    s = sec[["uf", "cd", lcol, fcol]].copy()
    s["w"] = s[lcol] + s[fcol]
    s = s[s.w > 0]
    s["x"] = logit(np.clip(s[lcol] / s.w, *CLIP))
    s["wx"] = s.w * s.x
    s["wxx"] = s.w * s.x ** 2
    g = s.groupby(["uf", "cd"]).agg(n=("w", "size"), W=("w", "sum"), WX=("wx", "sum"), WXX=("wxx", "sum"))
    mu = g.WX / g.W
    var = (g.WXX / g.W - mu ** 2).clip(lower=0)
    sd = np.sqrt(var)
    sd[g.n < min_n] = np.nan
    return sd


def size_bin(v):
    return pd.cut(v, SIZE_BINS, labels=SIZE_LABELS, right=False)


# ---------------------------------------------------------------- outputs

def build_baseline(r1, out):
    sd = within_sd(r1, "l1", "f1")
    m = r1.groupby(["uf", "cd"]).agg(nm=("nm", "first"), sec=("secao", "size"), l1=("l1", "sum"),
                                       f1=("f1", "sum"), o1=("o1", "sum"))
    m["v1"] = m.l1 + m.f1 + m.o1
    m["sd"] = sd
    rows = []
    for (uf, cd), x in m.sort_index().iterrows():
        rows.append([uf, f"{int(cd):05d}", x.nm, int(x.sec), int(x.v1), int(x.l1), int(x.f1), int(x.o1),
                     None if not np.isfinite(x.sd) else round(float(x.sd), 4)])
    tot = m[["l1", "f1", "o1", "v1"]].sum()
    meta = {"source": "TSE votacao_secao_2022_BR (1st round, Presidente)", "election": "2022-10-02 R1",
            "candidates": {"l": "Lula (13)", "f": "Bolsonaro (22) [stored in the f slot]"},
            "sd": "within-municipality weighted sd of logit(Lula/(Lula+Bolsonaro)) across sections, shares clipped [0.02,0.98], null if <3 sections",
            "n_mun": len(rows), "n_sections": int(m.sec.sum()),
            "totals": {k: int(v) for k, v in tot.items()},
            "lula_valid_share": round(float(tot.l1 / tot.v1), 5),
            "lula_two_party_share": round(float(tot.l1 / (tot.l1 + tot.f1)), 5)}
    with open(os.path.join(out, "baseline.json"), "w") as fh:
        json.dump({"meta": meta, "cols": ["uf", "cd", "nm", "sec", "v1", "l1", "f1", "o1", "sd"], "mun": rows},
                  fh, ensure_ascii=False, separators=(",", ":"))
    return m


def order_sections(r2):
    """Sort sections by receipt time; missing times go last. Returns sorted frame with rank."""
    s = r2.copy()
    tmax = s.t.max()
    s["t_eff"] = s.t.fillna(tmax + pd.Timedelta(seconds=1))
    s = s.sort_values(["t_eff", "uf", "cd", "zona", "secao"], kind="mergesort").reset_index(drop=True)
    return s


def checkpoint_times(s):
    n = len(s)
    res = []
    for p in CHECKPOINTS:
        k = max(1, int(math.ceil(p / 100 * n)))
        t = s.t_eff.iloc[k - 1]
        res.append((p, t))
    return res


def pct_label(p):
    return ("%g" % p).replace(".", "_")


def build_snapshots(s, out):
    ts = s.groupby(["uf", "cd"]).size().rename("ts")
    keys = [ukey(u, c) for u, c in ts.index]
    st_tot = s.groupby("uf").size()
    info = []
    for p, t in checkpoint_times(s):
        sub = s[s.t_eff <= t]
        g = sub.groupby(["uf", "cd"]).agg(st=("secao", "size"), l=("l", "sum"), f=("f", "sum"))
        g = g.reindex(ts.index, fill_value=0)
        units = {k: [int(a), int(b), int(c), int(d)] for k, a, b, c, d in
                 zip(keys, ts.values, g.st.values, g.l.values, g.f.values)}
        sg = sub.groupby("uf").agg(st=("secao", "size"), l=("l", "sum"), f=("f", "sum")).reindex(st_tot.index, fill_value=0)
        states = {u: [int(st_tot[u]), int(x.st), int(x.l), int(x.f)] for u, x in sg.iterrows()}
        br = [int(len(s)), int(len(sub)), int(sub.l.sum()), int(sub.f.sum())]
        doc = {"pct": p, "time": t.strftime("%H:%M:%S"), "units": units, "states": states, "br": br}
        with open(os.path.join(out, f"snap_{pct_label(p)}.json"), "w") as fh:
            json.dump(doc, fh, separators=(",", ":"))
        info.append({"pct": p, "time": doc["time"], "ts": t, "sections": br[1], "lula_share_raw": br[2] / max(1, br[2] + br[3])})
    return info


def build_truth(s, out):
    m = s.groupby(["uf", "cd"]).agg(ts=("secao", "size"), l=("l", "sum"), f=("f", "sum"),
                                     b=("b", "sum"), n=("n", "sum"), comp=("comp", "sum"), aptos=("aptos", "sum"))
    units = {ukey(u, c): [int(x.ts), int(x.l), int(x.f)] for (u, c), x in m.iterrows()}
    L, F = int(m.l.sum()), int(m.f.sum())
    doc = {"units": units, "br": [int(m.ts.sum()), L, F],
           "national": {"sections": int(m.ts.sum()), "lula": L, "bolsonaro": F, "branco": int(m.b.sum()),
                        "nulo": int(m.n.sum()), "lula_valid_share": round(L / (L + F), 6)}}
    with open(os.path.join(out, "truth.json"), "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    return m


# ---------------------------------------------------------------- params

def build_params(r1, r2s, m1, m2, snapinfo, out):
    P = {"note": "logit units of Lula two-party share (Lula/(Lula+Bolsonaro)) unless noted; 2022 R1 (02/10) -> R2 (30/10)"}
    L1, F1 = m1.l1.sum(), m1.f1.sum()
    L2, F2 = m2.l.sum(), m2.f.sum()
    nat1, nat2 = logit(L1 / (L1 + F1)), logit(L2 / (L2 + F2))
    nsw = float(nat2 - nat1)
    P["national"] = {"r1_two_party": r(L1 / (L1 + F1), 5), "r2_two_party": r(L2 / (L2 + F2), 5),
                     "r1_lula_valid": r(L1 / m1.v1.sum(), 5), "swing_logit": r(nsw, 5)}

    # municipal frame
    M = m1.join(m2[["ts", "l", "f", "comp"]], how="inner")
    M["w2"] = M.l + M.f
    M = M[(M.l1 + M.f1 > 0) & (M.w2 > 0)].copy()
    M["x1"] = elogit(M.l1, M.f1)
    M["x2"] = elogit(M.l, M.f)
    M["sw"] = M.x2 - M.x1
    M = M.reset_index()
    MZ = M[M.uf == "zz"].copy()
    M = M[M.uf != "zz"].copy()  # municipal-level stats are Brazil only

    # state swings
    S = pd.concat([M, MZ]).groupby("uf").agg(l1=("l1", "sum"), f1=("f1", "sum"), l=("l", "sum"), f=("f", "sum"), o1=("o1", "sum"))
    S["sw"] = logit(S.l / (S.l + S.f)) - logit(S.l1 / (S.l1 + S.f1))
    S["dev"] = S.sw - nsw
    S["w"] = S.l + S.f
    S_no_zz = S.drop(index="zz", errors="ignore")
    P["state_swing"] = {
        "sd_weighted": r(wsd(S_no_zz.dev, S_no_zz.w)), "sd_unweighted": r(float(S_no_zz.dev.std(ddof=1))),
        "rms_weighted_about_national": r(math.sqrt(wmean(S_no_zz.dev ** 2, S_no_zz.w))),
        "excludes": "zz (abroad) from sd",
        "by_state": {u: {"swing": r(x.sw), "dev": r(x.dev), "r1": r(x.l1 / (x.l1 + x.f1)), "r2": r(x.l / (x.l + x.f))}
                     for u, x in S.iterrows()}}

    # municipal residual
    M["state_sw"] = M.uf.map(S.sw)
    M["eps"] = M.sw - M.state_sw
    M["bin"] = size_bin(M.w2)
    eps = {"excludes": "zz (abroad); empirical logit with +0.5", "robust_sd_mad": r(rsd(M.eps)),
           "sd_unweighted_trim_1pct": r(float(M.eps[(M.eps > M.eps.quantile(0.01)) & (M.eps < M.eps.quantile(0.99))].std())),
           "sd_weighted": r(wsd(M.eps, M.w2)), "sd_unweighted": r(float(M.eps.std())),
           "mean_unweighted": r(float(M.eps.mean())), "n": int(len(M)), "by_size_bin": {}}
    for b, g in M.groupby("bin", observed=True):
        q = np.percentile(g.eps, [5, 25, 50, 75, 95])
        eps["by_size_bin"][b] = {"n": int(len(g)), "sd": r(float(g.eps.std())), "sd_weighted": r(wsd(g.eps, g.w2)),
                                 "mad_sd": r(float(1.4826 * np.median(np.abs(g.eps - g.eps.median())))),
                                 "mean": r(float(g.eps.mean())), "p05_p25_p50_p75_p95": [r(v) for v in q]}
    # simple fit sd^2 = a + b/votes
    try:
        X = np.column_stack([np.ones(len(M)), 1 / M.w2.values])
        coef, *_ = np.linalg.lstsq(X, M.eps.values ** 2, rcond=None)
        eps["fit_var_eq_a_plus_b_over_votes"] = {"a": r(coef[0], 5), "b": r(coef[1], 2)}
    except Exception:
        pass
    # residual correlated with R1 lean? slope of eps on (x1 - state x1)
    M["x1_rel"] = M.x1 - M.uf.map(pd.Series(elogit(S.l1, S.f1), index=S.index))
    sl = np.polyfit(M.x1_rel, M.eps, 1, w=np.sqrt(M.w2))
    eps["slope_on_r1_relative_lean_weighted"] = r(sl[0])
    P["sigma_eps_municipal"] = eps

    # within-municipality section heterogeneity
    sd1 = within_sd(r1, "l1", "f1").rename("sd1")
    sd2 = within_sd(r2s, "l", "f").rename("sd2")
    H = M.set_index(["uf", "cd"]).join(sd1).join(sd2)
    het = {"by_size_bin": {}}
    for b, g in H.groupby("bin", observed=True):
        het["by_size_bin"][b] = {"n_with_3plus_sections": int(g.sd2.notna().sum()),
                                 "median_sd_r2": r(float(g.sd2.median())), "median_sd_r1": r(float(g.sd1.median())),
                                 "median_ratio_r2_over_r1": r(float((g.sd2 / g.sd1).median()))}
    het["overall_median_sd_r2"] = r(float(H.sd2.median()))
    het["overall_median_sd_r1"] = r(float(H.sd1.median()))
    het["corr_sd1_sd2"] = r(float(H[["sd1", "sd2"]].corr().iloc[0, 1]))
    P["within_municipality_section_sd"] = het

    # order bias
    s = r2s  # already sorted, has t_eff
    key = ["uf", "cd", "zona", "secao"]
    s1 = s.merge(r1[key + ["l1", "f1"]], on=key, how="left")
    fin = M.set_index(["uf", "cd"])[["l", "f", "l1", "f1", "w2", "bin"]]
    ob = {"definition": "d = logit(counted Lula two-party share) - logit(final municipal share), for municipalities with 0<st<ts at the national checkpoint; d_r1 = same for the R1 votes of the same sections (matched by zona/secao); d_swing = d - d_r1",
          "national_swing_sign": int(np.sign(nsw)), "checkpoints": {}}
    n = len(s)
    for p in [5, 10, 25, 50, 75, 90]:
        k = int(math.ceil(p / 100 * n))
        t = s.t_eff.iloc[k - 1]
        sub = s1[s1.t_eff <= t]
        g = sub.groupby(["uf", "cd"]).agg(st=("secao", "size"), l=("l", "sum"), f=("f", "sum"),
                                          l1=("l1", "sum"), f1=("f1", "sum"))
        g = g.join(M.set_index(["uf", "cd"])[["ts"]], how="inner").join(fin, rsuffix="_fin", how="inner")
        g = g[[u != "zz" for u in g.index.get_level_values(0)]]
        part = g[(g.st > 0) & (g.st < g.ts) & (g.l + g.f > 0) & (g.l1 + g.f1 > 0)].copy()
        part["d"] = elogit(part.l, part.f) - elogit(part.l_fin, part.f_fin)
        part["d_r1"] = elogit(part.l1, part.f1) - elogit(part.l1_fin, part.f1_fin)
        part["d_sw"] = part.d - part.d_r1
        part["frac"] = part.st / part.ts
        w = part.l + part.f
        cp = {"time": t.strftime("%H:%M:%S"), "n_partial_mun": int(len(part)),
              "n_complete_mun": int(((g.st == g.ts)).sum()),
              "mean_d": r(float(part.d.mean())), "mean_d_weighted": r(wmean(part.d, w)),
              "sd_d": r(float(part.d.std())), "sd_d_weighted": r(wsd(part.d, w)), "robust_sd_d": r(rsd(part.d)),
              "counted_votes_ge_500": (lambda q: {"n": int(len(q)), "mean_d": r(float(q.d.mean())), "sd_d": r(float(q.d.std())),
                                                  "robust_sd_d": r(rsd(q.d)), "mean_d_r1": r(float(q.d_r1.mean())),
                                                  "sd_d_swing": r(float(q.d_sw.std()))})(part[(part.l + part.f) >= 500]),
              "frac_d_positive": r(float((part.d > 0).mean()), 3),
              "mean_d_r1": r(float(part.d_r1.mean())), "mean_d_r1_weighted": r(wmean(part.d_r1, w)),
              "sd_d_swing": r(float(part.d_sw.std())), "mean_d_swing_weighted": r(wmean(part.d_sw, w)),
              "slope_d_on_d_r1": r(float(np.polyfit(part.d_r1, part.d, 1)[0])) if len(part) > 5 else None,
              "corr_d_d_r1": r(float(np.corrcoef(part.d_r1, part.d)[0, 1])) if len(part) > 5 else None,
              "by_size_bin": {}}
        for b, gg in part.groupby("bin", observed=True):
            cp["by_size_bin"][b] = {"n": int(len(gg)), "mean_d": r(float(gg.d.mean())), "sd_d": r(float(gg.d.std())),
                                    "robust_sd_d": r(rsd(gg.d)), "robust_sd_d_swing": r(rsd(gg.d_sw)), "mean_frac_counted": r(float(gg.frac.mean()), 3), "sd_d_swing": r(float(gg.d_sw.std()))}
        # dependence on fraction counted
        fb = pd.cut(part.frac, [0, 0.25, 0.5, 0.75, 1.0])
        cp["sd_d_by_fraction_counted"] = {str(b): {"n": int(len(gg)), "sd_d": r(float(gg.d.std())), "robust_sd_d": r(rsd(gg.d)), "mean_d": r(float(gg.d.mean())), "mean_d_r1": r(float(gg.d_r1.mean()))}
                                          for b, gg in part.groupby(fb, observed=True)}
        # all-sections-so-far level: counted R2 sections' swing relative to final national swing
        Lc, Fc, L1c, F1c = sub.l.sum(), sub.f.sum(), sub.l1.sum(), sub.f1.sum()
        cp["counted_sections_swing_vs_r1_same_sections"] = r(float(logit(Lc / (Lc + Fc)) - logit(L1c / (L1c + F1c))))
        # state level: counted state share vs final state share
        sg = sub.groupby("uf").agg(l=("l", "sum"), f=("f", "sum"))
        sf = s.groupby("uf").agg(l=("l", "sum"), f=("f", "sum"))
        cp["state_d_counted_minus_final"] = {u: r(float(elogit(sg.l.get(u, 0), sg.f.get(u, 0)) - elogit(sf.l[u], sf.f[u])))
                                             for u in sf.index}
        ob["checkpoints"][str(p)] = cp
    P["order_bias"] = ob

    # raw national running share
    P["national_running_raw"] = [{"pct": x["pct"], "time": x["time"], "lula_two_party_raw": r(x["lula_share_raw"], 5)}
                                 for x in snapinfo]
    P["national_running_raw_final"] = r(L2 / (L2 + F2), 5)

    # turnout
    S["v1"] = S.l1 + S.f1 + S.o1
    S["ratio"] = (S.l + S.f) / S.v1
    M["ratio"] = M.w2 / M.v1
    M["lratio"] = np.log(M.ratio)
    tdict = {"definition": "R2 two-party votes / R1 valid votes (two-party + others)",
             "national": r(float((L2 + F2) / m1.v1.sum())),
             "by_state": {u: r(float(x.ratio)) for u, x in S.iterrows()},
             "mun_sd_ratio": r(float(M.ratio.std())), "mun_sd_log_ratio": r(float(M.lratio.std())),
             "mun_sd_log_ratio_within_state": r(float((M.lratio - M.groupby("uf").lratio.transform("mean")).std())),
             "by_size_bin": {b: {"median": r(float(g.ratio.median())), "sd_log": r(float(g.lratio.std()))}
                             for b, g in M.groupby("bin", observed=True)}}
    # R2 turnout and R1 turnout per elector (comparecimento / aptos) national
    tdict["r2_comparecimento_over_aptos"] = r(float(m2.comp.sum() / m2.aptos.sum()))
    P["turnout"] = tdict

    # timing
    t0 = pd.Timestamp(s.t.dropna().iloc[0].date()) + pd.Timedelta(hours=17)
    mins = (s.t_eff - t0).dt.total_seconds() / 60
    cum = np.arange(1, n + 1) / n
    grid = {}
    for mm in [5, 10, 15, 20, 30, 40, 45, 60, 75, 90, 105, 120, 150, 180, 240, 300, 360]:
        grid[str(mm)] = r(float(cum[mins.values <= mm][-1] * 100 if (mins.values <= mm).any() else 0.0), 2)
    # two-party votes fraction too
    wv = (s.l + s.f).values.astype(float)
    cumv = np.cumsum(wv) / wv.sum()
    gridv = {k: r(float(cumv[mins.values <= int(k)][-1] * 100 if (mins.values <= int(k)).any() else 0.0), 2) for k in grid}
    P["timing"] = {"reference": "minutes after 17:00 BRT 30/10/2022 (DT_BU_RECEBIDO, Brasilia time)",
                   "pct_sections_received_by_minute": grid, "pct_two_party_votes_received_by_minute": gridv,
                   "checkpoints": [{"pct": x["pct"], "time": x["time"],
                                    "min_after_17": r(float((x["ts"] - t0).total_seconds() / 60), 1)}
                                   for x in snapinfo],
                   "missing_receipt_time_sections": int(s.t.isna().sum())}
    # by-state timing: median minutes to 50% and 90% of state's sections
    stt = {}
    for u, g in s.assign(mins=mins).groupby("uf"):
        q = g.mins.quantile([0.1, 0.5, 0.9])
        stt[u] = [r(float(q.iloc[0]), 1), r(float(q.iloc[1]), 1), r(float(q.iloc[2]), 1)]
    P["timing"]["by_state_minutes_p10_p50_p90"] = stt

    with open(os.path.join(out, "params_2022.json"), "w") as fh:
        json.dump(P, fh, indent=1, ensure_ascii=False)
    return P


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zips", required=True)
    ap.add_argument("--r1zip", required=True)
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--skip-params", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)
    r2 = parse_r2(a.zips, a.cache)
    print("R2 sections", len(r2), "missing t", int(r2.t.isna().sum()), file=sys.stderr)
    r1 = parse_r1(a.r1zip, a.cache)
    print("R1 sections", len(r1), file=sys.stderr)
    m1 = build_baseline(r1, a.out)
    s = order_sections(r2)
    snapinfo = build_snapshots(s, a.out)
    m2 = build_truth(s, a.out)
    with open(os.path.join(a.out, "STATUS.txt"), "w") as fh:
        fh.write("baseline.json, snap_*.json, truth.json written.\n")
        fh.write(f"R2 sections {len(s)}; R1 sections {len(r1)}; municipalities R1 {len(m1)} R2 {len(m2)}\n")
        for x in snapinfo:
            fh.write(f"  {x['pct']:>5}%  {x['time']}  raw Lula 2p {x['lula_share_raw']:.4f}\n")
        fh.write("params_2022.json: " + ("pending\n" if not a.skip_params else "skipped\n"))
    if not a.skip_params:
        build_params(r1, s, m1, m2, snapinfo, a.out)
        with open(os.path.join(a.out, "STATUS.txt"), "a") as fh:
            fh.write("params_2022.json written.\n")
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
