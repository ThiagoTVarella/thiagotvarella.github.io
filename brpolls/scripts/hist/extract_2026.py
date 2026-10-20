"""Extract 2026 polls (president round 1, governor rounds 1 and 2) from pt Wikipedia.

    python scripts/hist/extract_2026.py      # writes data/hist/polls_2026.csv

Sources (fetched through wikifetch, cached):
  - pt "Pesquisas de opinião para a eleição presidencial no Brasil em 2026" (president r1)
  - pt "Pesquisas eleitorais para a eleição estadual de 2026 {em/no/na} {Estado}" (27 UFs;
    DF is "... eleição distrital de 2026 no Distrito Federal")
Round-2 governor tables are kept only for the matchup that actually happened, using the
finalists in data/hist/results_2026.csv (result == "2º TURNO").

The pages share one table layout (Contratante/Pesquisa | Datas | Amostragem | Margem |
[Cen.] | candidates... | Outros | Indecisos...), with candidate names/parties in a header
row under the photos, mid-table header rows announcing events (skipped), and sometimes a
second header block in the middle of a table when the candidate list changes. We therefore
parse tables ourselves, row by row, keeping the latest header block as the column map.
"""
import csv
import os
import re
import sys
import unicodedata
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikifetch import raw  # noqa: E402
from wikitable import Cell, clean, refs, ref_index, _split_attrs, _split_cells  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "data", "hist", "polls_2026.csv")
RESULTS = os.path.join(ROOT, "data", "hist", "results_2026.csv")

YEAR = 2026
ELECTION = {1: (2026, 10, 4), 2: (2026, 10, 25)}

STATES = {
    "AC": "no Acre", "AL": "em Alagoas", "AP": "no Amapá", "AM": "no Amazonas",
    "BA": "na Bahia", "CE": "no Ceará", "ES": "no Espírito Santo", "GO": "em Goiás",
    "MA": "no Maranhão", "MT": "em Mato Grosso", "MS": "em Mato Grosso do Sul",
    "MG": "em Minas Gerais", "PA": "no Pará", "PB": "na Paraíba", "PR": "no Paraná",
    "PE": "em Pernambuco", "PI": "no Piauí", "RJ": "no Rio de Janeiro",
    "RN": "no Rio Grande do Norte", "RS": "no Rio Grande do Sul", "RO": "em Rondônia",
    "RR": "em Roraima", "SC": "em Santa Catarina", "SP": "em São Paulo", "SE": "em Sergipe",
    "TO": "no Tocantins",
}
PRES_PAGE = "Pesquisas de opinião para a eleição presidencial no Brasil em 2026"
DF_PAGE = "Pesquisas eleitorais para a eleição distrital de 2026 no Distrito Federal"

COLS = ["poll_id", "year", "office", "state", "round", "pollster", "sponsor", "field_start",
        "field_end", "sample_size", "moe", "option", "party", "pct", "source_page",
        "source_url", "notes"]

MONTHS = {"jan": 1, "fev": 2, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "mai": 5, "may": 5,
          "jun": 6, "jul": 7, "ago": 8, "aug": 8, "set": 9, "sep": 9, "out": 10, "oct": 10,
          "nov": 11, "dez": 12, "dec": 12}

# Institutes seen on these pages; used to split "Contratante/Instituto" cells.
KNOWN_POLLSTERS = [
    "datafolha", "quaest", "ipec", "ibope", "atlas", "parana pesquisas", "real time big data",
    "futura", "gerp", "vox", "ipespe", "mda", "poderdata", "ideia", "paraná", "nexus",
    "veritá", "verita", "doxa", "ipri", "item", "seta", "dataform", "opinião", "opiniao",
    "instituto", "pesquisa", "data", "census", "ibpad", "badra", "agili", "real big data",
    "ranking", "radar", "methodus", "delta", "projeta", "pontual", "falpe", "potencial",
]


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s):
    return strip_accents(s).lower().strip()


def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", norm(s))
    return s.strip("-")


# ---------------------------------------------------------------- table parsing

def _brace_depth(s):
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    return (s.count("{{") - s.count("}}")) + (len(re.findall(r"<ref[^>/]*>", s))
                                             - s.count("</ref>"))


def parse_tables(text):
    """Yield (section, rows) for each top-level table; rows are lists of
    (kind, cells) with kind in {'H','B'} after rowspan/colspan expansion."""
    section = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        ln = lines[i]
        m = re.match(r"^(={2,6})\s*(.*?)\s*\1\s*$", ln)
        if m:
            level = len(m.group(1)) - 2
            section = section[:level] + [clean(m.group(2))]
        if ln.lstrip().startswith("{|"):
            depth, body, j = 0, [], i
            while j < len(lines):
                s = lines[j].lstrip()
                if s.startswith("{|"):
                    depth += 1
                if s.startswith("|}"):
                    depth -= 1
                    if depth == 0:
                        break
                body.append(lines[j])
                j += 1
            yield list(section), _parse_body(body[1:])
            i = j
        i += 1


def _parse_body(body):
    raw_rows, cur, depth = [], None, 0
    for ln in body:
        s = ln.lstrip()
        # continuation of a multi-line template/ref inside the previous cell
        if cur is not None and cur[1] and _brace_depth(cur[1][-1].raw) > 0:
            cur[1][-1].raw += "\n" + ln
            continue
        if s.startswith("{|"):
            depth += 1
        if depth:
            if s.startswith("|}"):
                depth -= 1
            continue
        if s.startswith("|+"):
            continue
        if s.startswith("|-"):
            cur = [s, [], None]
            raw_rows.append(cur)
            continue
        if cur is None:
            cur = ["", [], None]
            raw_rows.append(cur)
        if s.startswith("!") or s.startswith("|"):
            is_head = s.startswith("!")
            sep = "!!" if is_head else "||"
            pieces = _split_cells(s[1:], sep)
            if is_head and len(pieces) == 1:
                pieces = _split_cells(s[1:], "||")
            for p in pieces:
                a, c = _split_attrs(p)
                cur[1].append(Cell(c.strip(), a))
            if cur[2] is None:
                cur[2] = is_head
        elif cur[1]:
            cur[1][-1].raw += "\n" + ln
    rows = [(("H" if r[2] else "B"), r[1]) for r in raw_rows if r[1]]
    # expand rowspan/colspan over all rows in document order
    out, carry = [], {}
    for kind, cells in rows:
        row, col, cells = [], 0, list(cells)
        while cells or col in carry:
            if col in carry:
                cell, left = carry[col]
                row.append(cell)
                if left <= 1:
                    del carry[col]
                else:
                    carry[col] = (cell, left - 1)
                col += 1
                continue
            cell = cells.pop(0)
            rs = re.search(r'rowspan\s*=\s*"?(\d+)', cell.attrs)
            cs = re.search(r'colspan\s*=\s*"?(\d+)', cell.attrs)
            for _ in range(int(cs.group(1)) if cs else 1):
                row.append(cell)
                if rs and int(rs.group(1)) > 1:
                    carry[col] = (cell, int(rs.group(1)) - 1)
                col += 1
        out.append((kind, row))
    return out


# ---------------------------------------------------------------- header handling

def special_kind(label):
    t = norm(label)
    if re.search(r"vantagem|^lead|^link|diferen", t):
        return "SKIP"
    if re.search(r"^outros|^others|^outro\b", t):
        return "OTHERS"
    blank = re.search(r"branco|nulo|blank|null|nenhum", t)
    und = re.search(r"indecis|undec|nao sab|ns/nr|nao respond|nao opin", t)
    abst = re.search(r"absten|absent", t)
    if (blank or abst) and und:
        return "BLANK_NULL_UNDECIDED"
    if blank:
        return "BLANK_NULL"
    if und:
        return "UNDECIDED"
    if abst:
        return "ABSTENTION"
    return None


def meta_kind(label):
    t = norm(label)
    if re.search(r"^data|periodo|polling period|^date|realiza", t):
        return "date"
    if re.search(r"amostra|sample|entrevist", t):
        return "sample"
    if re.search(r"margem|margin", t):
        return "moe"
    if re.fullmatch(r"cen\.?|cenario|cenarios", t):
        return "scen"
    if re.search(r"contratante|pesquisa|instituto|pollster|polling firm|empresa", t):
        return "pollster"
    return None


def party_and_name(cellraw):
    r = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", cellraw, flags=re.S)
    party = ""
    m = re.findall(r"<small>(.*?)</small>", r, flags=re.S | re.I)
    if not m:
        m = re.findall(r"\{\{\s*small\s*\|(.*?)\}\}\s*$", r.strip(), flags=re.S | re.I)
    name_raw = r
    if m:
        party = clean(m[-1])
        name_raw = re.sub(r"<small>.*?</small>", "", r, flags=re.S | re.I)
        name_raw = re.sub(r"\{\{\s*small\s*\|.*\}\}\s*$", "", name_raw.strip(), flags=re.S | re.I)
    name = clean(name_raw)
    if not party:
        mm = re.match(r"^(.*?)\s*\(([^()]+)\)\s*$", name)
        if mm:
            name, party = mm.group(1), mm.group(2)
    party = party.strip("() ")
    return name.strip(), party


def is_event_row(cells):
    distinct = {id(c) for c in cells}
    return len(distinct) <= 2 and len(cells) > 3


def build_colmap(block):
    """block: list of header rows (expanded). Returns list of column descriptors."""
    ncol = max(len(r) for r in block)
    cols = []
    for c in range(ncol):
        texts = []
        for r in block:
            if c < len(r):
                cell = r[c]
                txt = cell.text
                if txt and txt not in [t for t, _ in texts]:
                    texts.append((txt, cell))
        if not texts:
            cols.append(("empty", "", ""))
            continue
        label, cell = texts[0]
        mk = meta_kind(label)
        if mk:
            cols.append((mk, label, ""))
            continue
        sk = special_kind(label)
        if sk:
            cols.append(("special", sk, ""))
            continue
        name, party = party_and_name(cell.raw)
        cols.append(("cand", name or label, party))
    return cols


# ---------------------------------------------------------------- value parsing

def pct_value(raw_cell):
    t = clean(raw_cell).replace("%", "").replace("−", "-").strip()
    t = re.sub(r"\s+", "", t)
    if not t:
        return None, ""
    m = re.fullmatch(r"<(\d+(?:[.,]\d+)?)", t)
    if m:
        b = float(m.group(1).replace(",", "."))
        return round(b / 2, 3), f"'<{m.group(1)}' recorded as half the bound"
    t2 = t.replace(",", ".")
    m = re.fullmatch(r"~?(\d+(?:\.\d+)?)", t2)
    if m:
        return float(m.group(1)), ""
    return None, ""


def sample_value(s):
    t = clean(s)
    t = re.sub(r"\(.*?\)", "", t)
    m = re.search(r"\d[\d .,]*", t)
    if not m:
        return ""
    d = re.sub(r"[^\d]", "", m.group(0))
    return int(d) if d and int(d) >= 100 else ""


def moe_value(s):
    t = clean(s).replace("±", "").replace(",", ".")
    m = re.search(r"\d+(?:\.\d+)?", t)
    return float(m.group(0)) if m else ""


def parse_dates(s):
    """Return list of (day, month, year|None) in order."""
    t = norm(clean(s))
    t = re.sub(r"(\d)(º|o)\b", r"\1", t)
    out = []
    for m in re.finditer(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", t):
        y = m.group(3)
        y = int(y) + (2000 if y and len(y) == 2 else 0) if y else None
        out.append([int(m.group(1)), int(m.group(2)), y])
    if out:
        return out
    toks = re.findall(r"\d{4}|\d{1,2}|[a-z]{3,}", t)
    dates, pending = [], []
    last_month = None
    for tk in toks:
        if tk.isdigit() and len(tk) == 4:
            for d in dates:
                if d[2] is None:
                    d[2] = int(tk)
            continue
        if tk.isdigit():
            pending.append(int(tk))
            continue
        mo = MONTHS.get(tk[:3])
        if mo:
            if pending:
                for d in pending:
                    dates.append([d, mo, None])
                pending = []
            elif dates and dates[-1][1] is None:
                dates[-1][1] = mo
            last_month = mo
    for d in pending:  # trailing days without month: use last month seen
        if last_month:
            dates.append([d, last_month, None])
    return [d for d in dates if d[1] and 1 <= d[0] <= 31]


def iso(y, m, d):
    return f"{y:04d}-{m:02d}-{d:02d}"


def split_pollster(txt):
    txt = re.sub(r"\s+", " ", txt).strip()
    if "/" not in txt:
        return txt, ""
    parts = [p.strip() for p in txt.split("/") if p.strip()]
    if len(parts) < 2:
        return txt, ""
    # "100% Cidades" etc: prefer the part that is a known institute, else the last part
    for i in range(len(parts) - 1, -1, -1):
        if any(k in norm(parts[i]) for k in KNOWN_POLLSTERS[:12]):
            return parts[i], "/".join(parts[:i] + parts[i + 1:])
    return parts[-1], "/".join(parts[:-1])


# ---------------------------------------------------------------- candidate matching

STOP = {"de", "da", "do", "dos", "das", "e", "dr", "dra", "professor", "professora", "prof",
        "delegado", "delegada", "coronel", "capitao", "general", "pastor", "pastora", "cabo",
        "sargento", "soldado", "filho", "junior", "jr", "neto", "bolsonaro", "silva", "santos",
        "lula"}


def tokens(name):
    t = re.sub(r"[^a-z ]", " ", norm(name))
    return {w for w in t.split() if len(w) >= 3 and w not in STOP}


def matches(wiki_name, official_names):
    tw = tokens(wiki_name)
    n = norm(wiki_name)
    for o in official_names:
        if norm(o) == n:
            return True
        to = tokens(o)
        if tw & to:
            return True
        if not tw and n and n in norm(o).split():
            return True
    return False


def load_results():
    cands = defaultdict(list)
    finalists = defaultdict(list)
    with open(RESULTS, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            key = (r["office"], r["state"])
            cands[key].append(r["candidate"])
            if r["result"] == "2º TURNO":
                finalists[key].append(r["candidate"])
    return cands, finalists


def cand_match(wiki_name, official):
    # "Lula" is in STOP for token matching of compound names, handle exact short names here
    if norm(wiki_name) in {norm(o) for o in official}:
        return True
    if norm(wiki_name) == "lula":
        return any("lula" in norm(o).split() for o in official)
    return matches(wiki_name, official)


# ---------------------------------------------------------------- extraction

def classify_round(section, office):
    s = norm(" / ".join(section))
    if re.search(r"senad|deputad|resultado|agrega|aggregat|rejei|espontane|avaliac|aprovac", s):
        return None
    if office == "governor" and re.search(r"presiden", s):
        return None
    if re.search(r"segundo turno|2o turno|second round", s):
        return 2
    if re.search(r"primeiro turno|1o turno|first round", s):
        return 1
    if re.search(r"governador", s):
        return 1
    return None


def section_year(section):
    ys = [int(y) for s in section for y in re.findall(r"\b(20\d\d)\b", s)]
    return ys[-1] if ys else None


def extract_page(lang, title, office, state, official, finalists, log):
    text = raw(lang, title)
    if not text:
        log.append(f"{state}: page missing: {title}")
        return []
    idx = ref_index(text)
    polls = []  # dicts
    cur_year, prev_month, prev_secyear = YEAR, None, None
    for ti, (section, rows) in enumerate(parse_tables(text)):
        rnd = classify_round(section, office)
        if rnd is None:
            continue
        if office == "president" and rnd != 1:
            continue
        sy = section_year(section)
        if sy != prev_secyear:
            if sy:
                cur_year, prev_month = sy, None
            prev_secyear = sy
        colmap, block, last_kind = None, [], None
        for kind, cells in rows:
            if kind == "H":
                if is_event_row(cells):
                    last_kind = "E"
                    continue
                if last_kind != "H":
                    block = []
                block.append(cells)
                last_kind = "H"
                continue
            if last_kind == "H" or colmap is None:
                if block:
                    colmap = build_colmap(block)
            last_kind = "B"
            if colmap is None or is_event_row(cells):
                continue
            p = row_to_poll(cells, colmap, idx)
            if p is None:
                continue
            # dates / year inference (tables are reverse chronological)
            ds = p.pop("_dates")
            if not ds:
                log.append(f"{state} r{rnd}: unparsable date {p['_datetext']!r} ({p['pollster']})")
                continue
            end, start = ds[-1], ds[0]
            if end[2] is None:
                if prev_month is not None and end[1] - prev_month >= 6:
                    cur_year -= 1
                end[2] = cur_year
            else:
                cur_year = end[2]
            prev_month = end[1]
            if start[2] is None:
                start[2] = end[2] - 1 if (start[1], start[0]) > (end[1], end[0]) else end[2]
            p["field_start"] = iso(start[2], start[1], start[0])
            p["field_end"] = iso(end[2], end[1], end[0])
            ey = ELECTION[rnd]
            if not (iso(YEAR, 1, 1) <= p["field_end"] <= iso(*ey)):
                continue
            if p["field_start"] > p["field_end"]:
                log.append(f"{state}: start>end {p['_datetext']!r}")
            p.update(round=rnd, table=ti, section=" / ".join(section))
            if rnd == 2:
                names = [o for o, kind_, _ in p["options"] if kind_ == "cand"]
                fin = finalists.get((office, state), [])
                if len(fin) != 2 or len(names) != 2:
                    continue
                if not all(cand_match(n, fin) for n in names):
                    continue
                if not all(any(cand_match(n, [f]) for n in names) for f in fin):
                    continue
            polls.append(p)
    return polls


def row_to_poll(cells, colmap, idx):
    p = {"options": [], "notes": []}
    datetext = pollster = sample = moe = scen = ""
    for c, desc in enumerate(colmap):
        if c >= len(cells):
            break
        kind, label, party = desc
        cell = cells[c]
        if kind == "pollster":
            pollster = cell.text
            p["_pollraw"] = cell.raw
        elif kind == "date":
            datetext = cell.text
        elif kind == "sample":
            sample = sample_value(cell.raw)
        elif kind == "moe":
            moe = moe_value(cell.raw)
        elif kind == "scen":
            scen = cell.text
        elif kind in ("cand", "special"):
            v, note = pct_value(cell.raw)
            if v is None:
                continue
            if note:
                p["notes"].append(f"{label}: {note}")
            if kind == "cand":
                p["options"].append((label, "cand", party))
            else:
                p["options"].append((label, "special", ""))
            p.setdefault("pcts", []).append(v)
    if not pollster or not any(k == "cand" for _, k, _ in p["options"]):
        return None
    if re.search(r"resultado|eleic|elei[cç]", norm(pollster)):
        return None
    urls = []
    for cell in cells:
        urls += refs(cell.raw, idx)
        if urls:
            break
    pol, spons = split_pollster(pollster)
    p.update(pollster=pol, sponsor=spons, sample_size=sample, moe=moe, scen=scen,
             source_url=urls[0] if urls else "", _datetext=datetext,
             _dates=parse_dates(datetext))
    return p


def choose_scenarios(polls, official):
    """Group by poll (pollster, dates, sample) and keep best-matching scenario(s)."""
    groups = defaultdict(list)
    for p in polls:
        key = (p["round"], norm(p["pollster"]), p["field_start"], p["field_end"])
        groups[key].append(p)
    kept = []
    for key, ps in groups.items():
        # drop exact duplicates (same option/pct set)
        uniq, seen = [], set()
        for p in ps:
            sig = tuple(zip([o for o, _, _ in p["options"]], p["pcts"]))
            if sig in seen:
                continue
            seen.add(sig)
            uniq.append(p)
        ps = uniq
        if key[0] == 2 or len(ps) == 1:
            if len(ps) > 1:
                for i, p in enumerate(ps, 1):
                    p["suffix"] = f"-s{i}"
                    p["notes"].append(f"poll listed {len(ps)} times with different numbers; all kept")
            kept += ps
            continue

        def score(p):
            names = [o for o, k, _ in p["options"] if k == "cand"]
            m = sum(1 for n in names if cand_match(n, official))
            return m - (len(names) - m)
        best = max(score(p) for p in ps)
        top = [p for p in ps if score(p) == best]
        if len(top) == 1:
            top[0]["notes"].append(f"best-matching of {len(ps)} scenarios")
        else:
            for i, p in enumerate(top, 1):
                p["suffix"] = f"-s{i}"
                p["notes"].append(f"scenario {i} of {len(top)} kept (tied best match among {len(ps)})")
        kept += top
    return kept


def main():
    official, finalists = load_results()
    out, log, summary = [], [], []
    jobs = [("president", "BR", "pt", PRES_PAGE)]
    for uf, s in sorted(STATES.items()):
        jobs.append(("governor", uf, "pt", f"Pesquisas eleitorais para a eleição estadual de 2026 {s}"))
    jobs.append(("governor", "DF", "pt", DF_PAGE))
    jobs.sort(key=lambda j: (j[0] != "president", j[1]))
    for office, state, lang, title in jobs:
        off = official.get((office, state), [])
        polls = extract_page(lang, title, office, state, off, finalists, log)
        polls = choose_scenarios(polls, off)
        polls.sort(key=lambda p: (p["round"], p["field_end"], p["pollster"]))
        page = f"{lang}:{title}"
        ids = set()
        for p in polls:
            pid = (f"{YEAR}-{office}-{state}-r{p['round']}-{slug(p['pollster'])}-"
                   f"{p['field_end']}{p.get('suffix', '')}")
            n = 2
            base = pid
            while pid in ids:  # distinct polls by same pollster ending same day
                pid = f"{base}-{n}"
                n += 1
            ids.add(pid)
            notes = list(p["notes"])
            if "votos v" in norm(p["section"]) or "valid" in norm(p["section"]):
                notes.append("valid votes")
            for (opt, kind, party), v in zip(p["options"], p["pcts"]):
                out.append({
                    "poll_id": pid, "year": YEAR, "office": office, "state": state,
                    "round": p["round"], "pollster": p["pollster"], "sponsor": p["sponsor"],
                    "field_start": p["field_start"], "field_end": p["field_end"],
                    "sample_size": p["sample_size"], "moe": p["moe"],
                    "option": opt, "party": party,
                    "pct": ("%g" % v), "source_page": page, "source_url": p["source_url"],
                    "notes": "; ".join(notes),
                })
            p["poll_id"] = pid
        for rnd in (1, 2):
            ps = [p for p in polls if p["round"] == rnd]
            if ps:
                summary.append((office, state, rnd, len(ps), min(p["field_end"] for p in ps),
                                max(p["field_end"] for p in ps)))
            elif rnd == 1 or len(finalists.get((office, state), [])) == 2 and office == "governor":
                summary.append((office, state, rnd, 0, "", ""))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(out)
    for s in summary:
        print(*s, sep="\t")
    print(f"{len(out)} rows -> {OUT}")
    for line in log:
        print("LOG", line, file=sys.stderr)


if __name__ == "__main__":
    main()
