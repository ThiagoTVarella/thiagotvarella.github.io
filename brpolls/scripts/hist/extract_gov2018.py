"""Extract 2018 gubernatorial polls (27 UFs, rounds 1 and 2) from Wikipedia.

    python scripts/hist/extract_gov2018.py

Sources: the "Pesquisas" section of pt "Eleições estaduais em/no/na {Estado} em 2018"
articles, plus en "2018 {State} gubernatorial election" pages where those are richer
(see PAGES). Output: data/hist/polls_gov2018.csv (format in AGENT_BRIEF.md).
"""
import csv
import os
import re
import sys
import unicodedata
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikifetch import raw  # noqa: E402
from wikitable import tables, refs, ref_index, clean  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "data", "hist", "polls_gov2018.csv")
YEAR = 2018
R1, R2 = "2018-10-07", "2018-10-28"
COLS = ["poll_id", "year", "office", "state", "round", "pollster", "sponsor", "field_start",
        "field_end", "sample_size", "moe", "option", "party", "pct", "source_page",
        "source_url", "notes"]

# ---------------------------------------------------------------- cell helpers

# wikitable.clean() drops every {{template}}, including {{yes2|25%}} / {{no2|..}} /
# {{party shading|..}} cells that carry the poll numbers; unwrap them first.
_WRAP = re.compile(r"\{\{\s*(?:yes2?|no[12]?|won|lost|nom|maybe|partial|good|bad|"
                   r"hs|bgcolor|font color|center|nowrap|small|big|b|strong)\s*\|"
                   r"(?:[^{}|]*=[^{}|]*\|)*([^{}|]*)\}\}", re.I)


def unwrap(s):
    s = re.sub(r"\[\[(?:File|Ficheiro|Imagem|Image|Arquivo):[^\]]*\]\]", "", s, flags=re.I)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    for _ in range(3):
        s = _WRAP.sub(r"\1", s)
    s = re.sub(r"\{\{\s*(?:party shading|party color cell)[^{}]*\}\}", "", s, flags=re.I)
    return s


def txt(cell):
    return clean(unwrap(cell.raw))


def num(s):
    """Share/number from a cell text: '45,3%', '45.3', '<1' -> 0.5; None if not numeric."""
    t = s.replace("%", "").replace("−", "-").replace("±", "").strip()
    t = re.sub(r"\s*pp?\.?$", "", t)
    if re.fullmatch(r"<\s*[01](?:[.,]\d+)?", t):
        return 0.5
    if re.fullmatch(r"\d+,\d+", t):
        t = t.replace(",", ".")
    m = re.fullmatch(r"~?\s*(\d+(?:\.\d+)?)", t)
    return float(m.group(1)) if m else None


def fmt(x):
    if x is None:
        return ""
    return str(int(x)) if float(x).is_integer() else str(x)


MONTHS = {}
for _i, _m in enumerate("jan fev mar abr mai jun jul ago set out nov dez".split()):
    MONTHS[_m] = _i + 1
for _i, _m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split()):
    MONTHS[_m] = _i + 1


def parse_dates(s, default_year=YEAR):
    """Return (start, end) ISO strings, or (None, None).

    Handles '18/08 a 21/08/2018', '24 a 30 de abril de 2018', '26-28 Sep', 'Aug 18-21',
    '30 Jul - 2 Aug', '14/08'. A year found in the text wins (so 2017 rows get dropped
    by the scope filter); otherwise default_year.
    """
    s = re.sub(r"\s+", " ", s.replace("\u2013", "-").replace("\u2014", "-")
               .replace("º", "").replace("°", "").replace(".º", ""))
    years = [int(y) for y in re.findall(r"\b(20\d\d)\b", s)]
    yr = years[-1] if years else default_year
    ev = []
    nums = list(re.finditer(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s))
    if nums:
        for m in nums:
            y = int(m.group(3)) if m.group(3) else yr
            y = y + 2000 if y < 100 else y
            ev.append((y, int(m.group(2)), int(m.group(1))))
        lead = re.match(r"^\s*(\d{1,2})\s*(?:a|e|-|to)\s*\d{1,2}/", s)
        if lead and len(ev) == 1:
            ev.insert(0, (ev[0][0], ev[0][1], int(lead.group(1))))
    else:
        s2 = re.sub(r"\b(de|of)\b", " ", s, flags=re.I)
        pend, mf = [], None
        for tk in re.findall(r"\d{4}|\d{1,2}|[A-Za-zçÇ]{3,}", s2):
            if re.fullmatch(r"\d{4}", tk):
                continue
            if tk.isdigit():
                pend.append(int(tk))
                continue
            m = MONTHS.get(tk.lower()[:3])
            if not m:
                continue
            if pend:
                tgt = mf if mf is not None else m
                ev += [(yr, tgt, d) for d in pend]
                pend = []
                mf = m if mf is not None else None
            else:
                mf = m
        if pend and mf:
            ev += [(yr, mf, d) for d in pend]
    if not ev:
        return None, None
    try:
        f = lambda e: "%04d-%02d-%02d" % e  # noqa: E731
        import datetime
        for e in ev:
            datetime.date(*e)
        return f(ev[0]), f(ev[-1])
    except ValueError:
        return None, None


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- pages

# (uf, lang, title). en pages are used where they hold more polls than pt (SP, MG, RJ, ES);
# the pt page is then NOT used for that state (no double counting).
PT = {"AC": "no Acre", "AL": "em Alagoas", "AP": "no Amapá", "AM": "no Amazonas",
      "BA": "na Bahia", "CE": "no Ceará", "ES": "no Espírito Santo", "GO": "em Goiás",
      "MA": "no Maranhão", "MT": "em Mato Grosso", "MS": "em Mato Grosso do Sul",
      "MG": "em Minas Gerais", "PA": "no Pará", "PB": "na Paraíba", "PR": "no Paraná",
      "PE": "em Pernambuco", "PI": "no Piauí", "RJ": "no Rio de Janeiro",
      "RN": "no Rio Grande do Norte", "RS": "no Rio Grande do Sul", "RO": "em Rondônia",
      "RR": "em Roraima", "SC": "em Santa Catarina", "SP": "em São Paulo",
      "SE": "em Sergipe", "TO": "no Tocantins"}
PAGES = [(uf, "pt", f"Eleições estaduais {n} em 2018") for uf, n in PT.items()]
PAGES.append(("DF", "pt", "Eleições distritais no Distrito Federal em 2018"))  # odd title
EN = {"SP": "2018 São Paulo gubernatorial election",
      "MG": "2018 Minas Gerais general election",
      "RJ": "2018 Rio de Janeiro gubernatorial election",
      "ES": "2018 Espírito Santo general election"}
PAGES = [p for p in PAGES if p[0] not in EN] + [(uf, "en", t) for uf, t in EN.items()]

PARTIES = set("""MDB PSDB PT PSB PDT PSOL PSL PSD PP PR PRB PODE PODEMOS DEM DEMOCRATAS NOVO REDE PCDOB PCO PSTU PRTB PRP
PROS PHS PMN PTB SD AVANTE PATRI PATRIOTA DC PV PPS PMB PCB PPL PSC PTC PRONA PRD REPUBLICANOS CIDADANIA UP""".split())
KNOWN = {"ibope": "Ibope", "ibope inteligencia": "Ibope", "datafolha": "Datafolha",
         "ipec": "Ipec", "quaest": "Quaest", "paraná pesquisas": "Paraná Pesquisas",
         "parana pesquisas": "Paraná Pesquisas", "real time big data": "Real Time Big Data",
         "realtime big data": "Real Time Big Data", "real time bigdata": "Real Time Big Data",
         "realtime bigdata": "Real Time Big Data", "real time big data ": "Real Time Big Data",
         "vox populi": "Vox Populi", "doxa": "Doxa", "exata": "Exata", "data ilha": "Data Ilha",
         "datapoder": "DataPoder360", "datapoder360": "DataPoder360", "ipespe": "Ipespe"}


def norm_pollster(p):
    p = re.sub(r"^Instituto\s+", "", p.strip()).strip()
    return KNOWN.get(norm(p), p)


def split_pollster(t, lang):
    """-> (pollster, sponsor). pt cells are Contratante/Instituto, en are Pollster/client."""
    t = t.strip()
    parts = [x.strip() for x in re.split(r"\s*/\s*", t) if x.strip()]
    if len(parts) <= 1:
        return norm_pollster(t), ""
    hit = [x for x in parts if norm(x) in KNOWN]
    if hit:
        pol = hit[0]
    else:
        pol = parts[0] if lang == "en" else parts[-1]
    return norm_pollster(pol), " / ".join(x for x in parts if x != pol)


def table_starts(text):
    """Char offsets of each top-level '{|' in the same order wikitable.tables() yields."""
    out, pos, lines, i = [], 0, text.splitlines(keepends=True), 0
    offs = []
    for ln in lines:
        offs.append(pos)
        pos += len(ln)
    while i < len(lines):
        if lines[i].lstrip().startswith("{|"):
            out.append(offs[i])
            depth, j = 0, i
            while j < len(lines):
                s = lines[j].lstrip()
                if s.startswith("{|"):
                    depth += 1
                if s.startswith("|}"):
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            i = j
        i += 1
    return out


def parse_cand(label):
    """'Costa (PT)' / 'Doria PSDB' -> (name, party)."""
    label = label.strip()
    m = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", label)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    parts = label.split()
    if len(parts) > 1 and parts[-1].upper() in PARTIES:
        return " ".join(parts[:-1]), parts[-1]
    return label, ""


def special(label):
    n = norm(label)
    if re.search(r"\b(lead|vantagem|diferenca|margem)\b", n):
        return "SKIP"
    br = re.search(r"branco|nulo", n)
    und = re.search(r"sabe|indec|nenhum|\bns\b|\bnr\b|undec|sem candidato|abst|nao respond", n)
    if br and und:
        return "BLANK_NULL_UNDECIDED"
    if br:
        return "BLANK_NULL"
    if re.search(r"abst", n) and re.search(r"undec|indec", n):
        return "BLANK_NULL_UNDECIDED"
    if und:
        return "UNDECIDED"
    if re.search(r"\boutros?\b|\bothers?\b", n):
        return "OTHERS"
    return None


def first_url(cells, idx):
    for c in cells:
        u = refs(c.raw, idx)
        if u:
            return u[0]
        m = re.search(r"\[(https?://[^\s\]]+)", c.raw)
        if m:
            return m.group(1)
    return ""


def moe_of(s):
    m = re.search(r"(\d+(?:[.,]\d+)?)", s.replace("±", ""))
    return float(m.group(1).replace(",", ".")) if m else None


def sample_of(s):
    t = re.sub(r"[^\d.,]", "", s.split("(")[0])
    t = t.replace(".", "").replace(",", "")
    return int(t) if t.isdigit() and 50 <= int(t) <= 200000 else None


def label_of(hc, j):
    """Column label: last non-empty header text in column j."""
    lab = ""
    for row in hc:
        if j < len(row):
            t = clean(unwrap(row[j].raw))
            if t:
                lab = t
    return lab


def round_of(section, ncand):
    sec = norm(" ".join(section))
    if re.search(r"rejei|simula|hipot|espont|potencial|senad|debate|cenarios", sec):
        return None
    if re.search(r"2\.?o? turno|segundo turno|second round", sec):
        return 2
    if re.search(r"1\.?o? turno|primeiro turno|first round", sec):
        return 1
    return 2 if ncand == 2 else 1


def election_limit(rnd):
    return R1 if rnd == 1 else R2


def parse_table(tb, uf, lang, page, idx, pre_text, report):
    """Yield poll dicts: {..., 'opts': [(option, party, pct)]}."""
    hc = tb.header_cells
    if not hc or not tb.rows:
        return
    ncol = max(len(r) for r in hc)
    labels = [label_of(hc, j) for j in range(ncol)]
    nl = [norm(x) for x in labels]
    # transposed tables (Pará): polls in columns, first column holds row labels
    if len(hc) > 1 and any(row and norm(clean(row[0].raw)) == "instituto" for row in hc[1:]):
        yield from parse_transposed(tb, uf, lang, page, idx, pre_text, report)
        return
    col = {}
    for j, n in enumerate(nl):
        if "date" not in col and re.match(r"(data|periodo|divulga|date)", n):
            col["date"] = j
        elif "pollster" not in col and re.match(r"(instituto|pollster|institute)", n):
            col["pollster"] = j
        elif "moe" not in col and re.search(r"margem|margin", n):
            col["moe"] = j
        elif "sample" not in col and re.search(r"amostra|sample|entrevistad|eleitores", n):
            col["sample"] = j
        elif "ref" not in col and re.match(r"(ref|fonte)", n):
            col["ref"] = j
    if "date" not in col or "pollster" not in col:
        return
    fixed = set(col.values())
    cols = []  # (j, option, party)
    for j in range(ncol):
        if j in fixed or not labels[j]:
            continue
        if norm(labels[j]) in ("candidato", "candidatos", "candidate", "candidates"):
            continue
        sp = special(labels[j])
        if sp == "SKIP":
            continue
        if sp:
            cols.append((j, sp, ""))
        else:
            nm, pt = parse_cand(labels[j])
            cols.append((j, nm, pt))
    ncand = sum(1 for _, o, _p in cols if o not in
                ("BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS"))
    rnd = round_of(tb.section, ncand)
    if rnd is None or ncand < 2:
        return
    valid = bool(re.search(r"v[óo]tos v[áa]lidos|valid votes|apenas v[áa]lidos",
                           " ".join(tb.section) + " " + pre_text[-250:], re.I))
    pub_only = "divulga" in nl[col["date"]]
    # group consecutive rows that share the same expanded pollster cell (rowspan scenarios)
    prev_key, grp = None, 0
    for r in tb.rows:
        cells = r.cells
        if len(cells) < ncol:
            continue
        pol_cell = cells[col["pollster"]]
        date_cell = cells[col["date"]]
        pol_t = txt(pol_cell)
        dt_t = txt(date_cell)
        if not pol_t or re.search(r"resultado|election|elei[cç][aã]o|agrega|debate", norm(pol_t + " " + dt_t)):
            continue
        fs, fe = parse_dates(dt_t)
        if not fe:
            report.append(f"{uf}: unparsed date {dt_t!r} pollster {pol_t!r}")
            continue
        opts = []
        for j, o, pt in cols:
            v = num(txt(cells[j]))
            if v is not None:
                opts.append((o, pt, v))
        if sum(1 for o, _, _ in opts if o not in
               ("BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS")) < 2:
            continue
        pollster, sponsor = split_pollster(pol_t, lang)
        key = (id(pol_cell), id(date_cell))
        grp = grp + 1 if key == prev_key else 0
        prev_key = key
        notes = []
        if pub_only and fs == fe:
            notes.append("only publication date given; used for field_start/end")
        if valid:
            notes.append("valid votes")
        src = first_url([date_cell, pol_cell] + ([cells[col["ref"]]] if "ref" in col else []) +
                        [c for c in cells], idx)
        yield dict(state=uf, round=rnd, pollster=pollster, sponsor=sponsor, field_start=fs,
                   field_end=fe,
                   sample=sample_of(txt(cells[col["sample"]])) if "sample" in col else None,
                   moe=moe_of(txt(cells[col["moe"]])) if "moe" in col and txt(cells[col["moe"]]) else None,
                   opts=opts, page=page, url=src, notes=notes, valid=valid, grp=grp, tkey=id(tb))


def parse_transposed(tb, uf, lang, page, idx, pre_text, report):
    hc = tb.header_cells
    by = {norm(clean(unwrap(row[0].raw))): row for row in hc if row}
    drow, prow = by.get("data"), by.get("instituto")
    if not drow or not prow:
        return
    rows = tb.rows
    cand = [(clean(unwrap(r.cells[0].raw)), r) for r in rows]
    ncand = len(cand)
    rnd = round_of(tb.section, ncand)
    if rnd is None:
        return
    valid = bool(re.search(r"v[óo]tos v[áa]lidos", " ".join(tb.section), re.I))
    for j in range(1, len(drow)):
        fs, fe = parse_dates(clean(unwrap(drow[j].raw)))
        if not fe:
            continue
        opts = []
        for lab, r in cand:
            v = num(clean(unwrap(r.cells[j].raw)))
            if v is not None:
                nm, pt = parse_cand(lab)
                opts.append((nm, pt, v))
        for k, row in by.items():
            sp = special(row[0].raw and clean(unwrap(row[0].raw)))
            if sp and sp != "SKIP" and j < len(row):
                v = num(clean(unwrap(row[j].raw)))
                if v is not None:
                    opts.append((sp, "", v))
        moe = None
        for k, row in by.items():
            if "margem" in k and j < len(row):
                moe = moe_of(clean(unwrap(row[j].raw)))
        src = ""
        for k, row in by.items():
            if k in ("fonte", "ref") and j < len(row):
                u = refs(row[j].raw, idx)
                src = u[0] if u else ""
        pollster, sponsor = split_pollster(clean(unwrap(prow[j].raw)), lang)
        yield dict(state=uf, round=rnd, pollster=pollster, sponsor=sponsor, field_start=fs,
                   field_end=fe, sample=None, moe=moe, opts=opts, page=page, url=src,
                   notes=(["valid votes"] if valid else []), valid=valid, grp=0, tkey=id(tb))


def main():
    polls, report = [], []
    for uf, lang, title in PAGES:
        text = raw(lang, title)
        if text is None:
            report.append(f"{uf}: page missing {lang}:{title}")
            continue
        idx = ref_index(text)
        starts = table_starts(text)
        page = f"{lang}:{title}"
        n0 = len(polls)
        for k, tb in enumerate(tables(text)):
            pre = text[max(0, starts[k] - 400):starts[k]] if k < len(starts) else ""
            if not any(w in " ".join(tb.section).lower() + " " + norm(" ".join(tb.section))
                       for w in ("pesquis", "opini", "poll", "intencao", "intenção")):
                continue
            polls.extend(parse_table(tb, uf, lang, page, idx, pre, report))
        if len(polls) == n0:
            report.append(f"{uf}: no polls extracted from {page}")

    # scope: election year up to election day
    keep = []
    for p in polls:
        if not p["field_end"].startswith("2018"):
            continue
        if p["field_end"] > election_limit(p["round"]):
            continue
        if p["field_start"] > p["field_end"]:
            p["field_start"], p["field_end"] = p["field_end"], p["field_start"]
        keep.append(p)
    polls = keep

    # drop valid-vote polls that duplicate a total-vote poll
    tot = {(p["state"], p["round"], p["pollster"], p["field_end"]) for p in polls if not p["valid"]}
    polls = [p for p in polls if not (p["valid"] and
             (p["state"], p["round"], p["pollster"], p["field_end"]) in tot)]

    # ids
    base = defaultdict(list)
    for p in polls:
        p["base"] = f"{YEAR}-governor-{p['state']}-r{p['round']}-{slug(p['pollster'])}-{p['field_end']}"
        base[p["base"]].append(p)
    for b, ps in base.items():
        for n, p in enumerate(ps, 1):
            p["poll_id"] = b if len(ps) == 1 else f"{b}-s{n}"
            if len(ps) > 1:
                p["notes"].append("several scenarios/polls share pollster+date on Wikipedia; kept all")

    polls.sort(key=lambda p: (p["state"], p["round"], p["field_end"], p["poll_id"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(COLS)
        for p in polls:
            for o, pt, v in p["opts"]:
                w.writerow([p["poll_id"], YEAR, "governor", p["state"], p["round"], p["pollster"],
                            p["sponsor"], p["field_start"], p["field_end"], fmt(p["sample"]),
                            fmt(p["moe"]), o, pt, fmt(v), p["page"], p["url"],
                            "; ".join(p["notes"])])
    # reporting
    by = defaultdict(list)
    for p in polls:
        by[(p["state"], p["round"])].append(p)
    for k in sorted(by):
        ds = sorted(p["field_end"] for p in by[k])
        print(f"{k[0]} r{k[1]}: {len(by[k])} polls {ds[0]}..{ds[-1]}")
    print("total polls", len(polls))
    bad = [(p["poll_id"], round(sum(v for _, _, v in p["opts"]), 1)) for p in polls
           if not 90 <= sum(v for _, _, v in p["opts"]) <= 105]
    print("sum outside 90-105:", len(bad))
    for b in bad:
        print("  ", b)
    print("\n".join(report))


if __name__ == "__main__":
    main()
