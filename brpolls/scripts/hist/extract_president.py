"""Extract national presidential polls (rounds 1 and 2) for 2002-2022 from Wikipedia.

    python extract_president.py            # writes data/hist/polls_president.csv

Sources (chosen per race as the page with the most / richest polls; never merged,
so nothing is double counted):
  2022  pt "Pesquisas de opinião para a eleição presidencial no Brasil em 2022"  (R1, R2)
  2018  pt "Pesquisas de opinião para a eleição presidencial no Brasil em 2018"  (R1, R2)
  2014  en "2014 Brazilian general election"  (R1, R2; the pt polling page is a stub whose
        template lumps Campos/Marina into one column)
  2010  en "Opinion polling for the 2010 Brazilian presidential election" or the pt article,
        whichever yields more polls (see SOURCES)
  2006  pt "Eleição presidencial no Brasil em 2006" (polls only as <timeline> bar charts)
  2002  no polls on pt/en Wikipedia.
"""
import csv
import os
import re
import sys
import unicodedata
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikifetch import raw  # noqa: E402
from wikitable import clean, tables, refs, ref_index  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "data", "hist", "polls_president.csv")
COLS = ["poll_id", "year", "office", "state", "round", "pollster", "sponsor", "field_start",
        "field_end", "sample_size", "moe", "option", "party", "pct", "source_page",
        "source_url", "notes"]

ELECTION_DAYS = {
    2002: (date(2002, 10, 6), date(2002, 10, 27)),
    2006: (date(2006, 10, 1), date(2006, 10, 29)),
    2010: (date(2010, 10, 3), date(2010, 10, 31)),
    2014: (date(2014, 10, 5), date(2014, 10, 26)),
    2018: (date(2018, 10, 7), date(2018, 10, 28)),
    2022: (date(2022, 10, 2), date(2022, 10, 30)),
}

# Candidates actually on the first-round ballot (aliases, accent-free, lowercase).
BALLOT = {
    2022: [["lula"], ["bolsonaro"], ["tebet", "simone tebet"], ["ciro", "gomes", "ciro gomes"],
           ["thronicke", "soraya"], ["d'avila", "davila", "felipe d'avila", "luiz felipe d'avila"],
           ["kelmon", "padre kelmon"], ["eymael"], ["manzano", "sofia manzano"],
           ["pericles", "leo pericles"], ["salgado", "vera", "vera lucia"]],
    2018: [["bolsonaro"], ["haddad"], ["ciro", "gomes", "ciro gomes"], ["alckmin"],
           ["amoedo"], ["daciolo", "cabo daciolo"], ["meirelles"], ["marina", "marina silva", "silva"],
           ["alvaro dias", "dias"], ["boulos"], ["vera", "vera lucia"], ["eymael"],
           ["goulart", "joao goulart filho", "goulart filho"]],
    2014: [["dilma", "rousseff", "dilma rousseff"], ["aecio", "neves", "aecio neves"],
           ["marina", "silva", "marina silva"], ["everaldo", "pereira", "pastor everaldo"],
           ["genro", "luciana genro"], ["eduardo jorge", "jorge"], ["eymael"],
           ["fidelix", "levy fidelix"], ["iasi", "mauro iasi"], ["ze maria", "jose maria"],
           ["rui costa", "rui costa pimenta", "pimenta"]],
    2010: [["dilma", "rousseff", "dilma rousseff"], ["serra", "jose serra"],
           ["marina", "silva", "marina silva"], ["plinio", "sampaio", "plinio arruda sampaio",
                                                  "plinio de arruda sampaio"],
           ["eymael", "jose maria eymael"], ["fidelix", "levy fidelix"],
           ["ivan pinheiro", "pinheiro"], ["rui costa pimenta", "pimenta"], ["ze maria"]],
    2006: [["lula"], ["alckmin", "geraldo alckmin"], ["heloisa helena", "heloisa"],
           ["cristovam", "buarque", "cristovam buarque"], ["ana maria rangel"], ["eymael"],
           ["bivar", "luciano bivar"]],
}
FINALISTS = {2022: ["lula", "bolsonaro"], 2018: ["haddad", "bolsonaro"],
             2014: ["dilma", "aecio"], 2010: ["dilma", "serra"], 2006: ["lula", "alckmin"]}
FINALIST_ALIASES = {"dilma": ["dilma", "rousseff", "dilma rousseff"],
                    "aecio": ["aecio", "neves", "aecio neves"],
                    "serra": ["serra", "jose serra"], "lula": ["lula"],
                    "bolsonaro": ["bolsonaro", "jair bolsonaro"], "haddad": ["haddad", "fernando haddad"],
                    "alckmin": ["alckmin", "geraldo alckmin"]}

PT_EN = {"PT": "pt", "EN": "en"}
SPECIAL = {"BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS", "ABSTENTION"}

MONTHS = {
    "jan": 1, "janeiro": 1, "january": 1, "fev": 2, "fevereiro": 2, "feb": 2, "february": 2,
    "mar": 3, "marco": 3, "march": 3, "abr": 4, "abril": 4, "apr": 4, "april": 4,
    "mai": 5, "maio": 5, "may": 5, "jun": 6, "junho": 6, "june": 6, "jul": 7, "julho": 7,
    "july": 7, "ago": 8, "agosto": 8, "aug": 8, "august": 8, "set": 9, "setembro": 9,
    "sep": 9, "sept": 9, "september": 9, "out": 10, "outubro": 10, "oct": 10, "october": 10,
    "nov": 11, "novembro": 11, "november": 11, "dez": 12, "dezembro": 12, "dec": 12,
    "december": 12,
}


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = s.replace("’", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]", " ", s)).strip()


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", norm(s))).strip("-")


# ----------------------------------------------------------------------------- text helpers

FILE_RE = re.compile(r"\[\[(?:File|Ficheiro|Imagem|Image|Arquivo):[^\]]*\]\]", re.I)
LINK_RE = re.compile(r"\[\[(?:[^|\]]*\|)?([^\]|]*)\]\]")


def strip_refs(s):
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    return re.sub(r"<!--.*?-->", "", s, flags=re.S)


def ctext(s):
    """Plain text of a cell: refs, files and links resolved before wikitable.clean."""
    s = strip_refs(s)
    s = FILE_RE.sub("", s)
    s = LINK_RE.sub(r"\1", s)
    s = re.sub(r"<center>|</center>", "", s)
    return clean(s)


def match_braces(s, start):
    """Index just past the '}}' closing the '{{' at start."""
    depth, i = 0, start
    while i < len(s):
        if s.startswith("{{", i):
            depth += 1
            i += 2
            continue
        if s.startswith("}}", i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
            continue
        i += 1
    return len(s)


def split_params(body):
    parts, depth, cur, i = [], 0, "", 0
    while i < len(body):
        two = body[i:i + 2]
        if two in ("{{", "[["):
            depth += 1
            cur += two
            i += 2
            continue
        if two in ("}}", "]]"):
            depth -= 1
            cur += two
            i += 2
            continue
        if body[i] == "|" and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += body[i]
        i += 1
    parts.append(cur)
    return parts


def expand_templates(text):
    """Inline the few templates that hide numbers or headers from the table parser."""
    # {{yes2|40%}}, {{no2|21%}}, {{no1|24%}} -> 40% ...
    text = re.sub(r"\{\{\s*(?:yes2|no2|no1|yes|no|won)\s*\|([^{}|]*)\}\}", r"\1", text)
    # pt 2022 2nd round: {{Pesquisa eleitoral/cabeçalho|f1|n1|p1|a1|f2|n2|p2|a2}}
    out, i = [], 0
    for m in re.finditer(r"\{\{\s*Pesquisa eleitoral\s*(/cabeçalho)?\s*\|", text):
        if m.start() < i:
            continue
        end = match_braces(text, m.start())
        params = [p.strip() for p in split_params(text[m.start() + 2:end - 2])[1:]]
        out.append(text[i:m.start()])
        if m.group(1):
            p = params + [""] * 8
            out.append(
                "! Instituto de Pesquisa\n! Data(s) de Pesquisa\n! Tamanho da Amostra\n"
                f"! [[{p[0]}|{p[1]}]]<br>{{{{small|[[{p[2]}|{p[3]}]]}}}}\n"
                f"! [[{p[4]}|{p[5]}]]<br>{{{{small|[[{p[6]}|{p[7]}]]}}}}\n"
                "! Indecisos e Absentos\n! Vantagem")
        else:
            v = params[2:5]
            out.append(" || ".join(f"{x}%" for x in v))
        i = end
    out.append(text[i:])
    return "".join(out)


def parse_pct(s):
    t = s.replace("−", "-").strip()
    t = re.sub(r"^\(|\)$", "", t)
    if re.match(r"^<\s*1", t):
        return 0.5
    m = re.match(r"^~?\s*(\d+(?:[.,]\d+)?)\s*%?", t)
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


def cell_value(raw_):
    """(pct, embedded name, embedded party) from a vote cell like "22%<br><small>(Haddad)</small>"
    or "1%<br>'''[[Pablo Marçal|Marçal]]'''<br>{{small|([[PROS]])}}"."""
    s = strip_refs(raw_)
    s = FILE_RE.sub("", s)
    s = LINK_RE.sub(r"\1", s)
    s = re.sub(r"\{\{\s*small\s*\|", "{{small|", s)
    s = re.sub(r"\{\{small\|([^{}]*)\}\}", r" \1 ", s)
    t = clean(s)
    m = re.match(r"^\s*(?:<\s*1|~?\s*\d+(?:[.,]\d+)?)\s*%?", t)
    if not m:
        return None, None, None
    pct = parse_pct(m.group(0))
    rest = t[m.end():].strip()
    name = party = None
    if rest:
        pm = re.fullmatch(r"\(?\s*([^()]*?)\s*\)?\s*(?:\(([^()]*)\))?", rest)
        if pm:
            name = pm.group(1).strip() or None
            party = (pm.group(2) or "").strip() or None
    return pct, name, party


def header_candidate(cells):
    """(name, party) from the distinct raw header cells of a column."""
    name = party = None
    for c in cells:
        s = strip_refs(c.raw)
        s = FILE_RE.sub("", s)
        s = LINK_RE.sub(r"\1", s)
        sm = re.search(r"\{\{\s*small\s*\|([^{}]*)\}\}", s)
        if sm:
            party = party or sm.group(1).split("|")[0].strip("'() ") or None
            s = s[:sm.start()] + s[sm.end():]
        t = clean(s)
        pm = re.search(r"\(([^()]+)\)\s*$", t)
        if pm:
            party = party or pm.group(1).strip()
            t = t[:pm.start()].strip()
        if t and not name and norm(t) not in ("candidato", "candidate", "candidatos"):
            name = t
    return name, party


def special_of(label):
    l = norm(label)
    if not l:
        return None
    if re.search(r"\b(lead|vantagem|diferenca|dif)\b", l):
        return "SKIP"
    if "outro" in l or "other" in l:
        return "OTHERS"
    if "absent" in l or "abst" in l or "nenhum" in l:
        return "BLANK_NULL_UNDECIDED"
    if "branco" in l or "nulo" in l or "blank" in l or "null" in l:
        if re.search(r"\b(ns|indec|nao sabe|undec)", l):
            return "BLANK_NULL_UNDECIDED"
        return "BLANK_NULL"
    if re.search(r"\b(ns ou nr|nao soube|indecis|nao sabe|undecided|undec|nao decid)", l):
        return "UNDECIDED"
    return None


def column_roles(t):
    roles = []
    # '!'-formatted result rows (e.g. "Eleições de 2014") land among the header rows; drop
    # header rows that carry percentages.
    hrows = [r for r in t.header_cells
             if not any(re.search(r"\d\s*%", ctext(c.raw)) for c in r)]
    ncol = max((len(r) for r in hrows), default=0)
    for j in range(ncol):
        cells, seen = [], set()
        for row in hrows:
            if j < len(row) and id(row[j]) not in seen:
                seen.add(id(row[j]))
                cells.append(row[j])
        label = " ".join(ctext(c.raw) for c in cells)
        l = norm(label)
        if not l:
            roles.append(("skip",))
        elif re.search(r"\b(periodo|data|date|polling period|conducted)", l) and "registro" not in l:
            roles.append(("date",))
        elif re.search(r"(instituto|pollster|polling firm|contratante|publica)", l):
            roles.append(("pollster",))
        elif re.search(r"(amostra|sample|entrevistados)", l):
            roles.append(("sample",))
        elif re.search(r"(margem|margin)", l):
            roles.append(("moe",))
        else:
            sp = special_of(label)
            if sp == "SKIP":
                roles.append(("skip",))
            elif sp:
                roles.append(("special", sp))
            elif l in ("candidato", "candidate"):
                roles.append(("skip",))
            else:
                name, party = header_candidate(cells)
                roles.append(("cand", name, party))
    return roles


# ----------------------------------------------------------------------------- dates

def parse_dates(text, default_year=None):
    """Return (start, end, explicit_year) or None. Handles '30 Set–01 Out', '24–26 Jun',
    '5–6 de outubro de 2018', '29 de setembro a 01 de outubro', '30 Sep – 1 Oct 2022'."""
    t = norm(text.replace("–", " - ").replace("—", " - "))
    toks = re.findall(r"[a-z]+|\d+", t)
    items = []
    for tok in toks:
        if tok.isdigit():
            n = int(tok)
            if len(tok) == 4:
                items.append(("y", n))
            elif 1 <= n <= 31:
                items.append(("d", n))
        elif tok in MONTHS:
            items.append(("m", MONTHS[tok]))
    days = [i for i, it in enumerate(items) if it[0] == "d"]
    if not days:
        return None
    sel = [days[0], days[-1]]
    res = []
    for di in sel:
        mon = next((items[k][1] for k in range(di + 1, len(items)) if items[k][0] == "m"), None)
        yr = next((items[k][1] for k in range(di + 1, len(items)) if items[k][0] == "y"), None)
        res.append([items[di][1], mon, yr])
    if res[1][1] is None:
        return None
    explicit = res[1][2] is not None
    if res[1][2] is None:
        res[1][2] = default_year
    if res[1][2] is None:
        return None
    if res[0][1] is None:
        res[0][1] = res[1][1]
    if res[0][2] is None:
        res[0][2] = res[1][2]
    try:
        end = date(res[1][2], res[1][1], res[1][0])
        try:
            start = date(res[0][2], res[0][1], res[0][0])
        except ValueError:  # "31–5 Abr": day 31 can only be in the previous month
            m, y = res[0][1] - 1, res[0][2]
            if m == 0:
                m, y = 12, y - 1
            start = date(y, m, res[0][0])
        if start > end:  # "30–1 Set": start is in the previous month
            m, y = res[0][1] - 1, res[0][2]
            if m == 0:
                m, y = 12, y - 1
            start = date(y, m, res[0][0])
            if start > end:
                start = date(res[0][2] - 1, res[0][1], res[0][0])
    except ValueError:
        return None
    return start, end, explicit


# ----------------------------------------------------------------------------- pollster

REG_RE = re.compile(r"\bBR\s*[-‐–]?\s*\d{4,5}(?:\s*/\s*\d{4})?", re.I)


def split_pollster(raw_):
    s = strip_refs(raw_)
    s = re.sub(r"<small>.*?</small>", " ", s, flags=re.S)
    t = ctext(s)
    t = REG_RE.sub("", t)
    t = re.sub(r"\(exit poll\)", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" ,;")
    t = t.replace(" / ", "/")
    if "/" in t:
        sponsor, pollster = t.rsplit("/", 1)
        return pollster.strip(), sponsor.strip()
    return t, ""


def first_url(raw_, index):
    u = refs(raw_, index)
    if u:
        return u[0].strip()
    m = re.search(r"\[(https?://[^\s\]]+)", raw_)
    return m.group(1) if m else ""


# ----------------------------------------------------------------------------- tables -> polls

def match_alias(name, aliases):
    n = norm(name)
    for a in aliases:
        if n == a or re.search(r"(^| )" + re.escape(a) + r"( |$)", n):
            return True
    return False


def ballot_key(year, name):
    for i, al in enumerate(BALLOT[year]):
        if match_alias(name, al):
            return i
    return None


def table_polls(t, ctx, index):
    """Yield raw poll dicts from one table."""
    roles = column_roles(t)
    if not any(r[0] == "pollster" for r in roles) or not any(r[0] == "cand" for r in roles):
        return
    if not any(r[0] == "date" for r in roles):
        return
    col = {r[0]: j for j, r in reversed(list(enumerate(roles)))}
    opt_cols = [j for j, r in enumerate(roles) if r[0] in ("cand", "special")]
    others_cols = [j for j, r in enumerate(roles) if r[0] == "special" and r[1] == "OTHERS"]
    key_cols = [j for j in opt_cols if j not in others_cols]
    sec_year = None
    for s in t.section:
        m = re.fullmatch(r"(19|20)\d\d", s.strip())
        if m:
            sec_year = int(s.strip())
    mode = "total"
    groups = []
    for row in t.rows:
        cells = row.cells
        if len(cells) <= max(opt_cols):
            cells = cells + [None] * (max(opt_cols) + 1 - len(cells))
        pc, dc = cells[col["pollster"]], cells[col["date"]]
        if pc is None or dc is None:
            continue
        uniq = list({id(c): c for c in cells if c is not None}.values())
        rowtext = norm(" ".join(ctext(c.raw) for c in uniq))
        if pc is dc:
            # colspan marker rows: event rows, or "Valid votes"/"Total votes" switches
            if re.fullmatch(r"valid votes|votos validos", rowtext):
                mode = "valid"
            elif re.fullmatch(r"total votes|votos totais", rowtext):
                mode = "total"
            continue
        if mode == "valid":
            continue
        ptxt = norm(ctext(pc.raw))
        if re.search(r"exit poll|boca de urna|election|eleicao|resultado|result", ptxt):
            continue
        if "agrega" in ptxt or "average" in ptxt or "media" in ptxt:
            continue
        vals = {}
        for j in opt_cols:
            c = cells[j]
            if c is None:
                continue
            vals[j] = (c, cell_value(c.raw))
        if not any(v[1][0] is not None for v in vals.values()):
            continue
        if groups and groups[-1]["pc"] is pc and groups[-1]["dc"] is dc:
            g = groups[-1]
        else:
            g = {"pc": pc, "dc": dc, "cells": cells, "scen": []}
            groups.append(g)
        key = tuple(id(cells[j]) if cells[j] is not None else None for j in key_cols)
        cont = False
        if g["scen"] and g["scen"][-1]["key"] != key:
            # Continuation row listing one more named minor candidate ("0% Santos Cruz
            # (PODE)") whose cell landed outside the Outros column because a neighbour
            # cell's rowspan was malformed: all non-carried cells are named or empty.
            prev = g["scen"][-1]["key"]
            new_js = [j for k, j in enumerate(key_cols) if key[k] != prev[k]]
            carried = len(key_cols) - len(new_js)
            if carried > len(key_cols) / 2 and all(
                    j not in vals or vals[j][1][0] is None or vals[j][1][1] for j in new_js):
                cont = True
        if g["scen"] and (g["scen"][-1]["key"] == key or cont):
            sc = g["scen"][-1]
        else:
            sc = {"key": key, "opts": [], "seen": set()}
            g["scen"].append(sc)
        for j in opt_cols:
            if j not in vals:
                continue
            c, (pct, ename, eparty) = vals[j]
            if id(c) in sc["seen"] or pct is None:
                continue
            sc["seen"].add(id(c))
            r = roles[j]
            if cont and ename:
                sc["opts"].append((ename, eparty or "", pct))
                continue
            if r[0] == "special":
                if r[1] == "OTHERS" and ename:
                    sc["opts"].append((ename, eparty or "", pct))
                else:
                    sc["opts"].append((r[1], "", pct))
            else:
                name = ename or r[1]
                party = r[2] or ""
                if ename and r[1] and re.fullmatch(r"[A-Z][A-Za-z]{1,9}|PC do B|PCdoB", r[1]):
                    party = r[1]  # pt 2018: columns are parties, the name is in the cell
                if ename and eparty:
                    party = eparty
                if name and ", apoiado por" in name:
                    name = name.split(",")[0].strip()  # "Haddad, apoiado por Lula"
                    sc.setdefault("notes", []).append("Haddad presented as supported by Lula")
                if not name:
                    continue
                sc["opts"].append((name, party, pct))
    prev_month, cur_year = None, ctx["year"]
    for g in groups:
        cells = g["cells"]
        dtext = ctext(g["dc"].raw)
        d = parse_dates(dtext, sec_year)
        if d is None and sec_year is None:
            d0 = parse_dates(dtext, cur_year)
            if d0 is not None:
                if prev_month is not None and d0[1].month - prev_month >= 6:
                    cur_year -= 1
                d = parse_dates(dtext, cur_year)
        elif d is not None and d[2]:
            cur_year = d[1].year
        if d is None:
            print(f"  ! unparsed date {dtext!r} in {ctx['page']}", file=sys.stderr)
            continue
        prev_month = d[1].month
        pollster, sponsor = split_pollster(g["pc"].raw)
        sample = moe = ""
        if "sample" in col and cells[col["sample"]] is not None:
            digits = re.sub(r"\D", "", ctext(cells[col["sample"]].raw))
            sample = int(digits) if digits and len(digits) <= 7 else ""
        if "moe" in col and cells[col["moe"]] is not None:
            mt = ctext(cells[col["moe"]].raw).replace("±", "").replace("+/-", "")
            moe = parse_pct(mt) if mt else None
            moe = "" if moe is None else moe
        yield {
            "pollster": pollster, "sponsor": sponsor, "start": d[0], "end": d[1],
            "sample": sample, "moe": moe, "url": first_url(g["pc"].raw, index),
            "scenarios": [s["opts"] for s in g["scen"] if s["opts"]], "notes": [],
            "scen_notes": {id(s["opts"]): s.get("notes", []) for s in g["scen"]},
        }


# ----------------------------------------------------------------------------- 2006 timelines

def timeline_polls(text, year):
    """pt 2006 article: each poll is a <timeline> bar chart followed by a bullet list."""
    sec = text[text.index("== Pesquisas =="):]
    sec = sec[:sec.index("\n== ", 5)]
    rnd = None
    out = []
    pos = 0
    for m in re.finditer(r"^; *(Primeiro turno|Segundo turno)\s*$|<timeline>(.*?)</timeline>(.*?)(?=^;|\Z)",
                         sec, re.M | re.S):
        if m.group(1):
            rnd = 1 if m.group(1).startswith("Primeiro") else 2
            continue
        tl, after = m.group(2), m.group(3)
        opts = []
        for name, pct in re.findall(r'text:"([^"(]+?)\s*\((\d+(?:[.,]\d+)?)%\)"', tl):
            name = name.strip()
            if "branco" in norm(name) and "indecis" in norm(name):
                name = "BLANK_NULL_UNDECIDED"
            elif "branco" in norm(name) or "nulo" in norm(name):
                name = "BLANK_NULL"
            elif "indecis" in norm(name):
                name = "UNDECIDED"
            elif "outro" in norm(name) or "demais" in norm(name):
                name = "OTHERS"
            opts.append((name, "", float(pct.replace(",", "."))))
        dm = re.search(r'text:"Pesquisa (\d+)/(\d+)/(\d+)"', tl)
        src = re.search(r'text:"Fonte: ([^"]+)"', tl)
        d = date(2000 + int(dm.group(3)), int(dm.group(2)), int(dm.group(1)))
        moe = re.search(r"Margem de erro: ([\d.,]+)", after)
        samp = re.search(r"Total de entrevistados: *([\d.]+)", after)
        out.append({
            "round": rnd, "pollster": src.group(1).strip(), "sponsor": "", "start": d, "end": d,
            "sample": int(samp.group(1).replace(".", "")) if samp else "",
            "moe": float(moe.group(1).replace(",", ".")) if moe else "",
            "url": "", "scenarios": [opts],
            "notes": ["date is the poll date given in the chart caption (likely publication/last field day)"],
        })
    return out


# ----------------------------------------------------------------------------- selection

def pick_r1(year, scenarios):
    def score(sc):
        inb = sum(1 for n, _, _ in sc if n not in SPECIAL and ballot_key(year, n) is not None)
        out = sum(1 for n, _, _ in sc if n not in SPECIAL and ballot_key(year, n) is None)
        return inb - out
    if len(scenarios) <= 1:
        return scenarios
    best = max(score(s) for s in scenarios)
    return [s for s in scenarios if score(s) == best]


def pick_r2(year, scenarios):
    fa = [FINALIST_ALIASES[f] for f in FINALISTS[year]]
    keep = []
    for sc in scenarios:
        names = [n for n, _, _ in sc if n not in SPECIAL]
        hits = [any(match_alias(n, a) for n in names) for a in fa]
        if all(hits) and len(names) == 2:
            keep.append(sc)
    return keep


PT14 = "Predefinição:Pesquisas de opinião da Eleição presidencial no Brasil em 2014 ({}º turno)"


def pt14_pre(text):
    # rows start with a '! 44' index header cell, which would make the parser treat the
    # whole row as a header row; turn it into a plain cell.
    return re.sub(r"^!\s*(\d+)\s*$", r"| \1", text, flags=re.M)


ANY = lambda sec: True  # noqa: E731

# Each source: year, round, lang, title, table filter (section path), and optionally
#   pre: text preprocessor; supplement: (min_end) -> only polls not already present from
#   the primary source (same pollster slug, end date within 1 day) and ending >= min_end.
SOURCES = [
    dict(year=2022, rnd=1, lang="pt", title="Pesquisas de opinião para a eleição presidencial no Brasil em 2022",
         filt=lambda sec: sec and sec[0] == "Primeiro turno"),
    dict(year=2022, rnd=2, lang="pt", title="Pesquisas de opinião para a eleição presidencial no Brasil em 2022",
         filt=lambda sec: sec[:2] == ["Segundo turno", "Bolsonaro x Lula"]),
    dict(year=2018, rnd=1, lang="pt", title="Pesquisas de opinião para a eleição presidencial no Brasil em 2018",
         filt=lambda sec: sec[:2] == ["Primeiro turno", "Pesquisas"]),
    dict(year=2018, rnd=2, lang="pt", title="Pesquisas de opinião para a eleição presidencial no Brasil em 2018",
         filt=lambda sec: sec[:2] == ["Segundo turno", "Pesquisas"] and not any("boca" in x for x in sec)),
    dict(year=2014, rnd=1, lang="en", title="2014 Brazilian general election",
         filt=lambda sec: sec[-1:] == ["First round"]),
    dict(year=2014, rnd=2, lang="en", title="2014 Brazilian general election",
         filt=lambda sec: sec[-1:] == ["Second round"]),
    # The pt 2014 template lists more polls, but omits Eduardo Campos from pre-August
    # polls, so it only supplements the en table from Campos's death (13 Aug) onwards.
    dict(year=2014, rnd=1, lang="pt", title=PT14.format(1), filt=ANY, pre=pt14_pre,
         supplement=date(2014, 8, 14)),
    dict(year=2014, rnd=2, lang="pt", title=PT14.format(2), filt=ANY, pre=pt14_pre,
         supplement=date(2014, 1, 1)),
    dict(year=2010, rnd=1, lang="en", title="Opinion polling for the 2010 Brazilian presidential election",
         filt=lambda sec: sec[-1:] == ["First round"]),
    dict(year=2010, rnd=2, lang="en", title="Opinion polling for the 2010 Brazilian presidential election",
         filt=lambda sec: sec[-1:] == ["Second round"]),
]


def same_poll(a, b):
    sa, sb = slug(a["pollster"]), slug(b["pollster"])
    return (sa == sb or sa in sb or sb in sa) and abs((a["end"] - b["end"]).days) <= 1


def main():
    rows, seen_ids = [], {}
    raw_polls = []  # (year, round, lang, title, poll)
    for src in SOURCES:
        year, rnd, lang, title = src["year"], src["rnd"], src["lang"], src["title"]
        text = raw(lang, title)
        if text is None:
            print(f"missing page {lang}:{title}", file=sys.stderr)
            continue
        index = ref_index(text)
        if src.get("pre"):
            text = src["pre"](text)
        text = expand_templates(text)
        n = 0
        prior = [p for (y, r, _, _, p) in raw_polls if y == year and r == rnd]
        for t in tables(text):
            if not src["filt"](t.section):
                continue
            for p in table_polls(t, {"year": year, "page": title}, index):
                if src.get("supplement"):
                    if p["end"] < src["supplement"] or any(same_poll(p, q) for q in prior):
                        continue
                    p["notes"].append("not in the primary (en) table; added from pt page")
                raw_polls.append((year, rnd, lang, title, p))
                n += 1
        print(f"{lang}:{title} r{rnd}: {n} raw polls", file=sys.stderr)
    t06 = "Eleição presidencial no Brasil em 2006"
    for p in timeline_polls(raw("pt", t06), 2006):
        raw_polls.append((2006, p.pop("round"), "pt", t06, p))

    for year, rnd, lang, title, p in raw_polls:
        r1day, r2day = ELECTION_DAYS[year]
        limit = r1day if rnd == 1 else r2day
        if p["end"].year != year or p["end"] > limit:
            continue
        scen = pick_r1(year, p["scenarios"]) if rnd == 1 else pick_r2(year, p["scenarios"])
        if not scen:
            continue
        base = f"{year}-president-BR-r{rnd}-{slug(p['pollster'])}-{p['end'].isoformat()}"
        for k, sc in enumerate(scen, 1):
            notes = list(p["notes"]) + sorted(set(p.get("scen_notes", {}).get(id(sc), [])))
            pid = base
            if len(scen) > 1:
                pid = f"{base}-s{k}"
                notes.append(f"scenario {k} of {len(scen)} equally ballot-like scenarios kept")
            if pid in seen_ids:
                seen_ids[pid] += 1
                pid = f"{pid}-{seen_ids[pid]}"
                notes.append("duplicate pollster/end-date on source page (separate poll row)")
            else:
                seen_ids[pid] = 1
            for opt, party, pct in sc:
                rows.append({
                    "poll_id": pid, "year": year, "office": "president", "state": "BR",
                    "round": rnd, "pollster": p["pollster"], "sponsor": p["sponsor"],
                    "field_start": p["start"].isoformat(), "field_end": p["end"].isoformat(),
                    "sample_size": p["sample"], "moe": p["moe"], "option": opt, "party": party,
                    "pct": f"{pct:g}", "source_page": f"{lang}:{title}",
                    "source_url": p["url"], "notes": "; ".join(notes),
                })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
