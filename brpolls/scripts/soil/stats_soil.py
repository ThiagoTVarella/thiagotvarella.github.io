"""Apêndice estatístico da aba "Solo e voto": gráficos de dispersão (SVG) e tabelas (JSON).

Uso: python3 stats_soil.py data/soil/vars.json <pasta de saída> [fonte.ttf]
Pesos: votos válidos de Lula + Flávio no município. Erros-padrão robustos (HC1).
"""
import json, sys, math, os
import numpy as np, pandas as pd
import statsmodels.api as sm
from scipy.stats import spearmanr
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
d = json.load(open(src))
df = pd.DataFrame.from_dict(d["rows"], orient="index", columns=d["keys"])
df.index.name = "cd"
df["uf"] = df.index.str[:2]
REG = {"1": "Norte", "2": "Nordeste", "3": "Sudeste", "4": "Sul", "5": "Centro-Oeste"}
df["reg"] = df.index.str[0].map(REG)
df = df[df.fl.notna() & (df.v > 0)]
df["lpib"] = np.log10(df.pibpc)

VARS = [("cer", "Cerrado (% da área)"), ("lat", "Latossolos (% da área)"), ("soy", "Soja (% da área, 2024)"),
        ("sul", "Nascidos no Sul (% dos moradores, 2010)"), ("pbf", "Bolsa Família (famílias por 100 domicílios)")]

def wcorr(x, y, w):
    mx, my = np.average(x, weights=w), np.average(y, weights=w)
    return np.sum(w * (x - mx) * (y - my)) / math.sqrt(np.sum(w * (x - mx) ** 2) * np.sum(w * (y - my) ** 2))

# ---------- correlações ----------
corr = []
for k, lab in VARS:
    s = df[df[k].notna()]
    # dentro do estado: tira a média (ponderada) de cada UF das duas variáveis
    dm = s.groupby("uf").apply(lambda g: g.assign(xd=g[k] - np.average(g[k], weights=g.v), yd=g.fl - np.average(g.fl, weights=g.v)), include_groups=False)
    ns = s[s.reg != "Sul"]
    sd = math.sqrt(np.average((s[k] - np.average(s[k], weights=s.v)) ** 2, weights=s.v))
    corr.append(dict(k=k, lab=lab, n=int(len(s)), sd=sd, r_w=wcorr(s[k], s.fl, s.v), r_u=float(np.corrcoef(s[k], s.fl)[0, 1]),
                     rho=float(spearmanr(s[k], s.fl).statistic), r_within=wcorr(dm.xd, dm.yd, dm.v), r_nosul=wcorr(ns[k], ns.fl, ns.v)))

# ---------- regressões (WLS, HC1) ----------
m = df.dropna(subset=["soy", "sul", "pbf", "lat", "cer", "lpib"]).copy()
for k in ["soy", "sul", "pbf", "lat", "cer"]: m[k + "10"] = m[k] / 10          # coeficiente = pontos de Flávio por 10 pontos da variável
SPECS = [("M1", ["pbf10"], False), ("M2", ["soy10"], False), ("M3", ["sul10"], False), ("M4", ["soy10", "sul10"], False),
         ("M5", ["soy10", "sul10", "pbf10"], False), ("M6", ["soy10", "sul10", "pbf10", "lat10", "cer10", "lpib"], False),
         ("M7", ["soy10", "sul10", "pbf10"], True)]
models = []
for name, xs, fe in SPECS:
    X = m[xs].copy()
    if fe: X = pd.concat([X, pd.get_dummies(m.uf, prefix="uf", drop_first=True, dtype=float)], axis=1)
    X = sm.add_constant(X)
    r = sm.WLS(m.fl, X, weights=m.v).fit(cov_type="HC1")
    # R² "dentro do estado" para o modelo com efeito fixo: variação explicada depois de tirar a média de cada UF
    models.append(dict(name=name, fe=fe, n=int(r.nobs), r2=float(r.rsquared),
                       coef={x: [float(r.params[x]), float(r.bse[x])] for x in ["const"] + xs if x in r.params}))
    if name == "M5": m["pred"] = r.fittedvalues
# robustez: M5 sem peso
ru = sm.OLS(m.fl, sm.add_constant(m[["soy10", "sul10", "pbf10"]])).fit(cov_type="HC1")
models.append(dict(name="M5u", fe=False, n=int(ru.nobs), r2=float(ru.rsquared),
                   coef={x: [float(ru.params[x]), float(ru.bse[x])] for x in ["const", "soy10", "sul10", "pbf10"]}))

# ---------- soja x sulistas, fora do Sul ----------
fs = df[(df.reg != "Sul") & df.sul.notna()]
def grp(sel, lab):
    g = fs[sel]
    return dict(lab=lab, n=int(len(g)), votes=int(g.v.sum()), fl=float(np.average(g.fl, weights=g.v)),
                pbf=float(np.average(g.pbf.fillna(0), weights=g.v)))
soy = fs.soy.fillna(0)
cross = [grp((soy >= 15) & (fs.sul >= 5), "Soja forte, com sulistas (≥5%)"), grp((soy >= 15) & (fs.sul < 1), "Soja forte, quase sem sulistas (<1%)"),
         grp((soy < 1) & (fs.sul >= 5), "Quase sem soja, com sulistas"), grp((soy < 1) & (fs.sul < 1), "Nem soja nem sulistas")]

sd_fl = math.sqrt(np.average((df.fl - np.average(df.fl, weights=df.v)) ** 2, weights=df.v))
json.dump(dict(sd_fl=sd_fl, corr=corr, models=models, cross=cross, stats=d["stats"], n_total=int(len(df)), votes=int(df.v.sum()),
               fl_nat=float(np.average(df.fl, weights=df.v))), open(f"{out}/stats.json", "w"), ensure_ascii=False, indent=1)

# ---------- gráficos de dispersão ----------
fam = ["DejaVu Sans"]
if len(sys.argv) > 3:                     # a fonte do site (Comfortaa), se for passada
    from matplotlib import font_manager
    font_manager.fontManager.addfont(sys.argv[3]); fam = [font_manager.FontProperties(fname=sys.argv[3]).get_name(), "DejaVu Sans"]
plt.rcParams.update({"font.family": fam, "font.size": 9, "axes.edgecolor": "#999",
                     "axes.labelcolor": "#333", "xtick.color": "#555", "ytick.color": "#555", "axes.spines.top": False, "axes.spines.right": False})
RC = {"Norte": "#1baf7a", "Nordeste": "#eb6834", "Sudeste": "#6250d6", "Sul": "#eda100", "Centro-Oeste": "#e87ba4"}
NAMES = {"5107925": "Sorriso", "2919553": "Luís E. Magalhães", "2211001": "Teresina", "1100205": "Porto Velho", "4314902": "Porto Alegre"}
LABELS = {"cer": ["5107925", "2919553", "2211001"], "lat": ["5107925", "2919553", "2211001"],
          "soy": ["5107925", "2919553", "2211001", "1100205"], "sul": ["5107925", "2919553", "2211001", "4314902"],
          "pbf": ["5107925", "2919553", "2211001", "1100205"], "pred": ["5107925", "2919553", "2211001", "1100205", "4314902"]}
OFF = {"1100205": (-8, -12), "4314902": (-8, -12)}     # Porto Velho e Porto Alegre: rótulo à esquerda, para não bater no de Luís E. Magalhães
def label(ax, cd, x, y, panel=None):
    dx, dy = (6, -12) if (panel == "soy" and cd == "1100205") else OFF.get(cd, (5, 3))
    ax.annotate(NAMES[cd], (x, y), fontsize=7.5, color="#111", xytext=(dx, dy), textcoords="offset points", ha="right" if dx < 0 else "left",
                arrowprops=dict(arrowstyle="-", color="#444", lw=.5, shrinkA=0, shrinkB=2))
BINS = d["stats"]
sqrtx = {"soy", "sul"}

def panel(ax, k, lab):
    s = df[df[k].notna()].sort_values("v", ascending=False)       # grandes atrás
    tr = (lambda x: np.sqrt(np.clip(x, 0, None))) if k in sqrtx else (lambda x: x)
    ax.scatter(tr(s[k]), s.fl, s=4 + 300 * np.sqrt(s.v / df.v.max()), c=s.reg.map(RC), alpha=.45, linewidths=.25, edgecolors="white")
    # médias ponderadas por faixa (as mesmas faixas dos mapas), desenhadas no meio de cada faixa
    bx, by = [], []
    for b in BINS[k]["bins"]:
        sel = s[(s[k] >= b["lo"]) & (s[k] < (b["hi"] if b["hi"] < 100 else 101))]
        if len(sel): bx.append(np.average(tr(sel[k]), weights=sel.v)); by.append(b["fl"])
    ax.plot(bx, by, "-o", color="#111", lw=1.6, ms=4.5, zorder=5, label="média por faixa (pesada por votos)")
    # reta de mínimos quadrados ponderados (só nos eixos lineares; na escala de raiz ela viraria curva)
    if k not in sqrtx:
        X = sm.add_constant(s[k]); r = sm.WLS(s.fl, X, weights=s.v).fit()
        xs = np.linspace(s[k].min(), s[k].max(), 100)
        ax.plot(xs, r.params.iloc[0] + r.params.iloc[1] * xs, "--", color="#555", lw=1, zorder=4)
    ax.axhline(50, color="#aaa", lw=.8, ls=":")
    for cd in LABELS[k]:
        if cd in s.index and not pd.isna(s.at[cd, k]): label(ax, cd, tr(s.at[cd, k]), s.at[cd, "fl"], k)
    c = next(c for c in corr if c["k"] == k)
    ax.set_title(lab, fontsize=10, loc="left", color="#111")
    top = k == "pbf"
    ax.text(.98, .97 if top else .03, f"r = {c['r_w']:.2f} (pesado)\nρ = {c['rho']:.2f} (postos)", transform=ax.transAxes, ha="right", va="top" if top else "bottom",
            fontsize=8, color="#222", bbox=dict(boxstyle="round,pad=.3", fc="white", ec="#ccc", alpha=.9), zorder=6)
    ax.set_ylim(0, 100); ax.set_ylabel("% do Flávio no 2º turno")
    if k in sqrtx:
        ticks = [0, 1, 5, 15, 30, 60, 100]
        ax.set_xticks(np.sqrt(ticks)); ax.set_xticklabels(ticks); ax.set_xlabel("escala de raiz quadrada")
    ax.grid(axis="y", color="#eee", lw=.6)

fig, axes = plt.subplots(3, 2, figsize=(7.4, 10.2))
for ax, (k, lab) in zip(axes.flat, VARS): panel(ax, k, lab)
ax = axes.flat[5]
s = m.sort_values("v", ascending=False)
ax.scatter(s.pred, s.fl, s=4 + 300 * np.sqrt(s.v / df.v.max()), c=s.reg.map(RC), alpha=.45, linewidths=.25, edgecolors="white")
ax.plot([0, 100], [0, 100], "--", color="#555", lw=1)
ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.grid(axis="y", color="#eee", lw=.6)
m5 = next(x for x in models if x["name"] == "M5")
ax.set_title("Previsto pelo modelo M5 x real", fontsize=10, loc="left", color="#111")
ax.set_xlabel("% do Flávio previsto (soja + sulistas + Bolsa Família)"); ax.set_ylabel("% do Flávio no 2º turno")
ax.text(.03, .97, f"R² = {m5['r2']:.2f}", transform=ax.transAxes, va="top", fontsize=8.5)
for cd in LABELS["pred"]:
    if cd in s.index: label(ax, cd, s.at[cd, "pred"], s.at[cd, "fl"])
from matplotlib.lines import Line2D
h = [Line2D([], [], marker="o", ls="", color=c, alpha=.7, ms=6, label=r) for r, c in RC.items()]
h += [Line2D([], [], color="#111", marker="o", ms=4, lw=1.6, label="média por faixa"), Line2D([], [], color="#555", ls="--", lw=1, label="reta ponderada (eixos lineares) / 45°")]
fig.legend(handles=h, loc="lower center", ncol=4, frameon=False, fontsize=8.5, bbox_to_anchor=(.5, -.005))
fig.tight_layout(rect=(0, .045, 1, 1))
fig.savefig(f"{out}/scatter.png", dpi=250)
print(json.dumps({c["k"]: round(c["r_w"], 3) for c in corr}), [(x["name"], round(x["r2"], 3)) for x in models])
