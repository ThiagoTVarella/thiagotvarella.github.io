"""Junta, por município (código IBGE), os dados da aba "Solo e voto".

Entradas (baixadas à mão, ver a lista de fontes na página), na pasta passada como argumento:
  overlap.json      fração da área do município no Cerrado e em Latossolos (IBGE Biomas e Solos 1:5.000.000)
  sidra/soja.json   área plantada de soja, PAM 2024 (SIDRA 5457)
  sidra/pop.json    população e área territorial, Censo 2022 (SIDRA 4714)
  sidra/dom.json    domicílios particulares permanentes ocupados, Censo 2022 (SIDRA 4712)
  sidra/pib.json    PIB e VAB da agropecuária, 2021 (SIDRA 5938)
  c10/mig2010.json  [população, nascidos no Sul, nascidos em outra UF], microdados da amostra do Censo 2010
  pbf_mun.json      famílias no Bolsa Família em ago/2026 por UF|código SIAFI (Portal da Transparência)
  kelvins.csv       código IBGE x código SIAFI
  tse_ibge.csv      código TSE x código IBGE
  mun_final.json    votos de Lula (l) e Flávio (f) no 2º turno de 2026 por município (boletins do TSE)
Saída: data/soil/vars.json
"""
import json, csv, sys, math, collections
D = sys.argv[1]; OUT = sys.argv[2]
J = lambda f: json.load(open(f"{D}/{f}"))
def sidra(f, var=None):
    out = collections.defaultdict(dict)
    for r in J(f"sidra/{f}")[1:]:
        try: v = float(r["V"])
        except ValueError: v = None
        out[r["D1C"]][r["D2C"] + ("|" + r["D4C"] if "D4C" in r else "")] = v
    return out
ov = J("overlap.json"); soja = sidra("soja.json"); pop = sidra("pop.json"); dom = sidra("dom.json"); pib = sidra("pib.json")
mig = J("c10/mig2010.json"); pbf = J("pbf_mun.json")["fam"]
siafi = {}
for r in csv.DictReader(open(f"{D}/kelvins.csv")): siafi[r["codigo_ibge"]] = r["siafi_id"].lstrip("0")
uf_of = {r["codigo_ibge"]: r["uf"] for r in csv.DictReader(open(f"{D}/tse_ibge.csv"))}
tse = {r["codigo_ibge"]: r["uf"].lower() + r["codigo_tse"].zfill(5) for r in csv.DictReader(open(f"{D}/tse_ibge.csv"))}
el = J("mun_final.json")
pbf_by = {}
for k, v in pbf.items():
    uf, s = k.split("|"); pbf_by[(uf, s.lstrip("0"))] = v
rows = {}; miss = collections.Counter()
for cd, (cer, lat) in ov.items():
    if cd in ("4300001", "4300002"): continue          # lagoas dos Patos e Mirim
    p = pop.get(cd, {}); area = p.get("6318"); popn = p.get("93")
    s = soja.get(cd, {}).get("8331|40124") or 0
    m = mig.get(cd); d = dom.get(cd, {}).get("381"); uf = uf_of.get(cd)
    fam = pbf_by.get((uf, siafi.get(cd, "")))
    e = el.get(tse.get(cd, ""))
    if m is None: miss["mig"] += 1
    if fam is None: miss["pbf"] += 1
    if e is None: miss["el"] += 1
    if area is None: miss["area"] += 1
    pb = pib.get(cd, {})
    rows[cd] = dict(
        cer=round(100 * cer, 1), lat=round(100 * lat, 1),
        soy=round(min(100, s / (area * 100) * 100), 2) if area else None,        # ha / (km² × 100)
        sul=round(100 * m[1] / m[0], 1) if m and m[0] else None,
        pbf=round(min(100, 100 * fam / d), 1) if fam and d else None,
        agro=pb.get("516"), pibpc=round(pb["37"] * 1000 / popn) if pb.get("37") and popn else None,
        fl=round(100 * e["f"] / (e["l"] + e["f"]), 2) if e and e["l"] + e["f"] else None,
        v=(e["l"] + e["f"]) if e else 0, pop=popn, uf=uf)
print("faltando:", dict(miss), "municípios:", len(rows))
# estatísticas: correlação ponderada por votos e voto em Flávio por faixa
def wcorr(xs, ys, ws):
    W = sum(ws); mx = sum(w * x for x, w in zip(xs, ws)) / W; my = sum(w * y for y, w in zip(ys, ws)) / W
    sxy = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws)); sx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws)); sy = sum(w * (y - my) ** 2 for y, w in zip(ys, ws))
    return sxy / math.sqrt(sx * sy)
BINS = {"cer": [0, 1, 50, 90, 101], "lat": [0, 10, 40, 70, 101], "soy": [0, 1, 5, 15, 30, 101],
        "sul": [0, 1, 5, 15, 30, 101], "pbf": [0, 20, 35, 50, 65, 101]}
stats = {}
for k, b in BINS.items():
    pts = [(r[k], r["fl"], r["v"]) for r in rows.values() if r[k] is not None and r["fl"] is not None and r["v"]]
    st = {"r": round(wcorr(*zip(*pts)), 3), "bins": []}
    for lo, hi in zip(b, b[1:]):
        sel = [(x, f, v) for x, f, v in pts if lo <= x < hi]
        V = sum(v for _, _, v in sel)
        st["bins"].append({"lo": lo, "hi": min(hi, 100), "n": len(sel), "votes": V,
                           "fl": round(sum(f * v for _, f, v in sel) / V, 1) if V else None})
    stats[k] = st
    print(k, st["r"], [(x["lo"], x["n"], x["fl"]) for x in st["bins"]])
keys = ["cer", "lat", "soy", "sul", "pbf", "fl", "agro", "pibpc", "v"]
json.dump({"keys": keys, "rows": {cd: [r[k] for k in keys] for cd, r in rows.items()}, "stats": stats},
          open(OUT, "w"), separators=(",", ":"))
