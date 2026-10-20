"""Extract 2022 gubernatorial polls (27 UFs, rounds 1 and 2) from Wikipedia.

    python scripts/hist/extract_gov2022.py

Sources per state: the pt article "Eleições estaduais ... em 2022" ("Pesquisas" section;
for SP the tables live in transcluded Predefinição pages) and, where it exists, the en
article "2022 {State} gubernatorial/general election" ("Opinion polls"). Every source is
parsed with the same generic table reader; for each race (state x round) the single source
page with the most in-scope polls is kept, so nothing is double counted.

Output: data/hist/polls_gov2022.csv (format in scripts/hist/AGENT_BRIEF.md).
"""
import csv
import os
import re
import sys
import unicodedata
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikifetch import raw  # noqa: E402
from wikitable import Cell, _expand, _split_attrs, _split_cells, clean, refs, ref_index  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "data", "hist", "polls_gov2022.csv")
RESULTS = os.path.join(ROOT, "data", "hist", "results_2022.csv")
YEAR = 2022
ELECTION = {1: "2022-10-02", 2: "2022-10-30"}

PT = {
    "AC": "Eleições estaduais no Acre em 2022", "AL": "Eleições estaduais em Alagoas em 2022",
    "AP": "Eleições estaduais no Amapá em 2022", "AM": "Eleições estaduais no Amazonas em 2022",
    "BA": "Eleições estaduais na Bahia em 2022", "CE": "Eleições estaduais no Ceará em 2022",
    "DF": "Eleições distritais no Distrito Federal em 2022",
    "ES": "Eleições estaduais no Espírito Santo em 2022", "GO": "Eleições estaduais em Goiás em 2022",
    "MA": "Eleições estaduais no Maranhão em 2022", "MT": "Eleições estaduais em Mato Grosso em 2022",
    "MS": "Eleições estaduais em Mato Grosso do Sul em 2022",
    "MG": "Eleições estaduais em Minas Gerais em 2022", "PA": "Eleições estaduais no Pará em 2022",
    "PB": "Eleições estaduais na Paraíba em 2022", "PR": "Eleições estaduais no Paraná em 2022",
    "PE": "Eleições estaduais em Pernambuco em 2022", "PI": "Eleições estaduais no Piauí em 2022",
    "RJ": "Eleições estaduais no Rio de Janeiro em 2022",
    "RN": "Eleições estaduais no Rio Grande do Norte em 2022",
    "RS": "Eleições estaduais no Rio Grande do Sul em 2022",
    "RO": "Eleições estaduais em Rondônia em 2022", "RR": "Eleições estaduais em Roraima em 2022",
    "SC": "Eleições estaduais em Santa Catarina em 2022", "SP": "Eleições estaduais em São Paulo em 2022",
    "SE": "Eleições estaduais em Sergipe em 2022", "TO": "Eleições estaduais no Tocantins em 2022",
}
# en articles that exist (others 404). Federal District / MS en pages have no poll tables.
EN = {
    "BA": "2022 Bahia general election", "CE": "2022 Ceará general election",
    "DF": "2022 Federal District gubernatorial election", "ES": "2022 Espírito Santo general election",
    "MA": "2022 Maranhão gubernatorial election", "MS": "2022 Mato Grosso do Sul gubernatorial election",
    "MG": "2022 Minas Gerais general election", "PR": "2022 Paraná gubernatorial election",
    "PE": "2022 Pernambuco gubernatorial election", "RJ": "2022 Rio de Janeiro general election",
    "RS": "2022 Rio Grande do Sul gubernatorial election",
    "SC": "2022 Santa Catarina gubernatorial election", "SP": "2022 São Paulo general election",
}

PARTIES = {
    "PT", "PL", "PSDB", "MDB", "PSD", "PSB", "PDT", "PP", "PSOL", "PCB", "PCO", "PSTU", "UP", "DC",
    "PMB", "PMN", "PRTB", "PTB", "PROS", "PSC", "PV", "REDE", "NOVO", "UNIÃO", "PODE", "AGIR",
    "AVANTE", "PATRIOTA", "CIDADANIA", "SOLIDARIEDADE", "REPUBLICANOS", "PCDOB", "DEM", "PTC",
    "PHS", "PPS", "PPL", "PR", "PRB", "SD", "SOL.", "REP.", "SOLIDARIEDA", "REPUBLICANO",
}
PARTY_ALIASES = {"SOL.": "SOLIDARIEDADE", "SOLIDARIEDA": "SOLIDARIEDADE", "SD": "SOLIDARIEDADE",
                 "REP.": "REPUBLICANOS", "REPUBLICANO": "REPUBLICANOS", "PRB": "REPUBLICANOS",
                 "UNIAO": "UNIÃO", "PODEMOS": "PODE"}

MONTHS = {"jan": 1, "fev": 2, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "mai": 5, "may": 5,
          "jun": 6, "jul": 7, "ago": 8, "aug": 8, "set": 9, "sep": 9, "out": 10, "oct": 10,
          "nov": 11, "dez": 12, "dec": 12}

# Words that mark the "contratante" (media sponsor) side of "A/B" pollster cells.
MEDIA = re.compile(r"\b(tv|rede|r[aá]dio|jornal|folha|globo|g1|estad[aã]o|exame|portal|not[ií]cias|"
                   r"di[aá]rio|gazeta|band|record|sbt|cnn|uol|tribuna|metr[oó]pole|a tarde|correio|"
                   r"blog|site|revista|veja|istoe|isto[ée]|cp2|cbn|o povo|agora|mais|ac24|cadaminuto|"
                   r"genial|modalmais|xp|btg|pol[ií]tica livre|bahia not|bnews|o liberal|zero hora|"
                   r"rbs|nsc|ndmais|op|jc|opovo|o tempo|hoje em dia|em tempo|a cr[ií]tica|"
                   r"diario|times|news|tribuna)\b", re.I)


def strip_acc(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s):
    return re.sub(r"\s+", " ", strip_acc(s).lower()).strip()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", norm(s)).strip("-")


# ---------------------------------------------------------------- wikitext preprocessing
def _flatten_templates(x):
    """Join the lines of multi-line {{templates}} and <ref>s so their '|param=' lines are not
    mistaken for table cells. Only spans that close within a few KB are touched, so a stray
    unbalanced brace cannot swallow the page."""
    x = re.sub(r"<ref(?:\s[^>]*)?(?<!/)>.{0,4000}?</ref>", lambda m: m.group(0).replace("\n", " "),
               x, flags=re.S)
    out, i = [], 0
    while True:
        j = x.find("{{", i)
        if j == -1:
            out.append(x[i:])
            break
        out.append(x[i:j])
        depth, k, end = 0, j, None
        while k < len(x) and k - j < 6000:
            if x.startswith("{{", k):
                depth += 1
                k += 2
                continue
            if x.startswith("}}", k):
                depth -= 1
                k += 2
                if depth == 0:
                    end = k
                    break
                continue
            k += 1
        if end is None:
            out.append("{{")
            i = j + 2
            continue
        seg = x[j:end]
        if not seg.startswith("{{Graph"):
            seg = seg.replace("\n", " ")
        out.append(seg)
        i = end
    return "".join(out)


def pre(x):
    x = _flatten_templates(x)
    # Colour templates around shares: {{yes2|36,5%}} -> 36,5%
    x = re.sub(r"\{\{\s*(?:yes|no|partial|yes2|no2|partial2|won|lost|hs|sim|nao|n[aã]o)\s*\|([^{}|]*)\}\}",
               r"\1", x, flags=re.I)
    # Resolve plain wikilinks to their display text so {{small|[[X|ABC]]}} cleans properly.
    x = re.sub(r"\[\[(?!(?:File|Ficheiro|Imagem|Image|Arquivo|Categoria|Category):)(?:[^|\]\[]*\|)?([^\]\[]*)\]\]",
               r"\1", x, flags=re.I)
    return x


def tables_inorder(text):
    """Yield (section, rows) for every top-level table; rows keep header and body rows in
    their original order (rowspans expand across them). Each cell gets .head (bool)."""
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
            yield list(section), _rows(body)
            i = j
        i += 1


def _rows(body):
    raw_rows, cur, depth = [], None, 0
    for ln in body[1:]:
        s = ln.lstrip()
        if s.startswith("{|"):
            depth += 1
        if depth:
            if s.startswith("|}"):
                depth -= 1
            continue
        if s.startswith("|+"):
            continue
        if s.startswith("|-"):
            cur = [s, []]
            raw_rows.append(cur)
            continue
        if cur is None:
            cur = ["", []]
            raw_rows.append(cur)
        if s.startswith("!") or s.startswith("|"):
            is_head = s.startswith("!")
            pieces = _split_cells(s[1:], "!!" if is_head else "||")
            if is_head and len(pieces) == 1:
                pieces = _split_cells(s[1:], "||")
            for p in pieces:
                a, c = _split_attrs(p)
                cell = Cell(c.strip(), a)
                cell.head = is_head
                cur[1].append(cell)
        elif cur[1]:
            cur[1][-1].raw += "\n" + ln
    return [cells for _, cells in _expand([(r[0], r[1]) for r in raw_rows if r[1]])]


# ---------------------------------------------------------------- cell parsers
def pct(cell):
    t = clean(cell.raw).replace("%", " ").strip()
    if re.match(r"^<\s*1\b", t):
        return 0.5, "<1"
    m = re.match(r"^~?\s*(\d+(?:[.,]\d+)?)(?:\s|$)", t + " ")
    if not m:
        return None, None
    return float(m.group(1).replace(",", ".")), None


def sample(text):
    t = re.sub(r"\(.*?\)", "", text)
    m = re.search(r"\d[\d .]*", t)
    if not m:
        return ""
    d = re.sub(r"\D", "", m.group(0))
    return int(d) if d and int(d) >= 100 else ""


def moe(text):
    m = re.search(r"(\d+(?:[.,]\d+)?)", text)
    return float(m.group(1).replace(",", ".")) if m else ""


def parse_dates(text, default_year=YEAR, en=False):
    s = norm(text).replace("º", "").replace("°", "")
    s = re.sub(r"(\d)\.(?=\s|$|[a-z])", r"\1", s)  # "1.º" -> "1"
    toks = []
    for m in re.finditer(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?|(\d{4})|(\d{1,2})|([a-z]+)", s):
        if m.group(1):
            toks.append(("d", int(m.group(1))))
            toks.append(("m", int(m.group(2))))
            if m.group(3):
                y = int(m.group(3))
                toks.append(("y", y + 2000 if y < 100 else y))
        elif m.group(4):
            toks.append(("y", int(m.group(4))))
        elif m.group(5):
            toks.append(("n", int(m.group(5))))
        else:
            w = m.group(6)[:3]
            if w in MONTHS and (len(m.group(6)) <= 3 or m.group(6).startswith(
                    ("jan", "fev", "feb", "mar", "abr", "apr", "mai", "may", "jun", "jul", "ago",
                     "aug", "set", "sep", "out", "oct", "nov", "dez", "dec"))):
                if m.group(6) in ("de", "a", "e", "to"):
                    continue
                toks.append(("m", MONTHS[w]))
    # A bare 2-digit number right after a month at the very end is a year ("1–6 Jul 22").
    if len(toks) >= 2 and toks[-1][0] == "n" and toks[-2][0] == "m" and en:
        toks[-1] = ("y", 2000 + toks[-1][1])
    dates = []
    for kind, v in toks:
        if kind in ("d", "n"):
            dates.append([v, None, None])
        elif kind == "m":
            for d in dates:
                if d[1] is None:
                    d[1] = v
        elif kind == "y":
            for d in dates:
                if d[2] is None:
                    d[2] = v
    dates = [d for d in dates if d[1] is not None]
    if not dates:
        return None, None
    for d in dates:
        if d[2] is None:
            d[2] = default_year
    a, b = dates[0], dates[-1]
    try:
        import datetime
        da = datetime.date(a[2], a[1], a[0])
        db = datetime.date(b[2], b[1], b[0])
    except ValueError:
        return None, None
    if da > db:  # e.g. "30/12-02/01" without years
        da = da.replace(year=da.year - 1)
    return da.isoformat(), db.isoformat()


KNOWN_INSTITUTES = re.compile(
    r"datafolha|ipec|ibope|quaest|paran[aá] pesquisas|real ?time|big data|atlas|ipespe|futura|"
    r"\bmda\b|verit[aá]|dataqualy|ibrape|fundepes|datasensus|badra|perfil|travessia|ranking|"
    r"econom[eé]trica|data ?ilha|datamax|exatus|promotion|mt dados|ideia|datatempo|brasmarket|"
    r"gerp|instituto|pesquisa|consult|opini|ipri|ipat|simplex|seta|doxa|amostragem|"
    r"vox|datam|data\w*|\w+data|escutec|ibpe|ipms|methodus|ipespe|item|gp |gpp|ipem|ires|"
    r"agili|parana|potencial|indice|índice|vertice|vértice|vector|sensus|census|dados|"
    r"real big|qualitest|ibest|macro|unidade|labi|instituto|ipop|ipsos",
    re.I)


def split_pollster(text):
    t = re.sub(r"\b[A-Z]{2}-\d{4,6}/20\d{2}\b", "", text)
    t = re.sub(r"\bBR-\d+/20\d{2}\b", "", t)
    t = re.sub(r"\s+", " ", t).strip(" -–,;")
    parts = [p.strip() for p in re.split(r"\s*/\s*", t) if p.strip()]
    if len(parts) <= 1:
        return t, ""
    # choose the institute part: prefer one that looks like a pollster and not like media
    def score(p):
        s = 0
        if KNOWN_INSTITUTES.search(p):
            s += 2
        if MEDIA.search(p):
            s -= 2
        return s
    best = max(range(len(parts)), key=lambda i: (score(parts[i]), -i))
    inst = parts[best]
    sponsor = "/".join(p for i, p in enumerate(parts) if i != best)
    return inst, sponsor


def split_name_party(text):
    t = re.sub(r"\s+", " ", text).strip()
    m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", t)
    if m and m.group(1):
        return m.group(1).strip(), m.group(2).strip()
    toks = t.split(" ")
    if len(toks) >= 2 and (toks[-1].upper() in PARTIES or strip_acc(toks[-1]).upper() in PARTIES):
        return " ".join(toks[:-1]), toks[-1]
    return t, ""


def canon_party(p):
    u = strip_acc(p).upper().strip()
    u = PARTY_ALIASES.get(u, PARTY_ALIASES.get(p.upper().strip(), u))
    return strip_acc(u)


# ---------------------------------------------------------------- column roles
def role(label):
    t = norm(label)
    if not t:
        return None
    if re.search(r"^(institut|pollster|empresa|contratante|pesquisa\b)", t):
        return "POLLSTER"
    if re.search(r"^(periodo|data|date|realiza|fieldwork)", t):
        return "DATE"
    if re.search(r"^(amostra|entrevist|sample|tamanho)", t):
        return "SAMPLE"
    if re.search(r"margem|erro|^moe|margin", t):
        return "MOE"
    if re.search(r"vantagem|^lead|diferen|registro", t):
        return "SKIP"
    blank = re.search(r"\bb/n\b|branc|nul|nenhum|blank|\bnone\b|abst", t)
    und = re.search(r"ns/nr|nao sabe|indecis|undec|nao respond|\bns\b|\bnr\b|don.t know", t)
    if blank and und:
        return "BLANK_NULL_UNDECIDED"
    if blank:
        return "BLANK_NULL"
    if und:
        return "UNDECIDED"
    if re.search(r"^(outros|others|other)\b", t):
        return "OTHERS"
    return "CAND"


def is_label_row(row):
    texts = [norm(c.text) for c in row[:4]]
    hits = sum(bool(re.search(r"^(institut|pollster|empresa|periodo|data|date|amostra|entrevist|sample)",
                              t)) for t in texts)
    return hits >= 2


SKIP_SECTIONS = re.compile(r"senad|senat|vice|deputad|presid|assembl|camara|chamber|legislat", re.I)
POLL_SECTIONS = re.compile(r"pesquisa|poll|opini", re.I)
R2_SECTIONS = re.compile(r"segundo turno|second round|2\.?\s*º?\s*turno|run-?off", re.I)


# ---------------------------------------------------------------- ballot
def load_ballot():
    ballot = defaultdict(lambda: {1: [], 2: []})
    with open(RESULTS, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["office"] != "governor":
                continue
            ballot[r["state"]][int(r["round"])].append((r["candidate"], r["party"]))
    return ballot


ALIASES = {  # wiki short name -> TSE ballot name (only where tokens don't overlap)
    ("SP", "freitas"): "TARCÍSIO", ("SP", "tarcisio de freitas"): "TARCÍSIO",
}


def match(uf, name, party, cands):
    """Return the TSE ballot name that this wiki option refers to, else None."""
    n = norm(name)
    if (uf, n) in ALIASES:
        return ALIASES[(uf, n)]
    toks = set(re.findall(r"[a-z]+", n)) - {"jr", "de", "da", "do", "dos", "das", "filho", "neto"} \
        if n not in ("neto",) else {"neto"}
    for cname, cparty in cands:
        ct = set(re.findall(r"[a-z]+", norm(cname)))
        if toks and toks & ct:
            return cname
    if party:
        cp = canon_party(party)
        for cname, cparty in cands:
            if cp and cp == canon_party(cparty):
                return cname
    return None


# ---------------------------------------------------------------- extraction
def extract_page(uf, lang, title, text, ballot):
    """Return list of candidate poll rows (dicts) found on a page, before scenario selection."""
    text = pre(text)
    idx = ref_index(text)
    src = f"{lang}:{title}"
    out = []
    for tno, (section, rows) in enumerate(tables_inorder(text)):
        if title.startswith("Predefinição:"):  # transcluded poll template: no headings
            section = ["Pesquisas"] + section
        sec = " / ".join(section)
        if not any(POLL_SECTIONS.search(s) for s in section):
            continue
        if SKIP_SECTIONS.search(sec):
            continue
        year_heading = next((int(s) for s in reversed(section) if re.fullmatch(r"20\d\d", s)), YEAR)
        cols = None
        prev_label = False
        for ri, row in enumerate(rows):
            if is_label_row(row):
                new = []
                for ci, c in enumerate(row):
                    r = role(c.text)
                    if r == "CAND":
                        nm, pty = split_name_party(c.text)
                        new.append((r, nm, pty, id(c)))
                    else:
                        new.append((r, None, None, id(c)))
                if prev_label and cols is not None:
                    # second header line (party colours / rowspan carry-over): merge, keeping
                    # the first line's labels wherever the new line is empty or carried over
                    merged = []
                    for ci in range(max(len(cols), len(new))):
                        a = cols[ci] if ci < len(cols) else None
                        b = new[ci] if ci < len(new) else None
                        if a is None or (b is not None and b[0] is not None and b[3] != a[3]
                                         and (a[0] is None)):
                            merged.append(b)
                        else:
                            merged.append(a)
                    new = merged
                cols = new
                prev_label = True
                continue
            if all(not c.text for c in row) and prev_label:
                continue
            prev_label = False
            if cols is None:
                continue
            if len({id(c) for c in row}) <= 2:  # event row spanning the table
                continue
            if all(getattr(c, "head", False) for c in row):
                continue
            if len(row) < len(cols):
                row = row + [Cell("")] * (len(cols) - len(row))
            rec = {"pollster": "", "date": "", "sample": "", "moe": "", "opts": [], "urls": [],
                   "notes": []}
            used = set()
            span_roles = defaultdict(list)
            for ci, (r, nm, pty, hid) in enumerate(cols):
                c = row[ci]
                span_roles[id(c)].append(r)
            for ci, (r, nm, pty, hid) in enumerate(cols):
                c = row[ci]
                if r == "POLLSTER":
                    rec["pollster"] = c.text
                    rec["urls"] += refs(c.raw, idx) + re.findall(r"\[(https?://[^\s\]]+)", c.raw)
                elif r == "DATE":
                    rec["date"] = c.text
                elif r == "SAMPLE":
                    rec["sample"] = c.text
                elif r == "MOE":
                    rec["moe"] = c.text
                elif r in (None, "SKIP"):
                    continue
                else:
                    if id(c) in used:
                        continue
                    used.add(id(c))
                    v, flag = pct(c)
                    if v is None:
                        continue
                    roles = set(span_roles[id(c)]) - {None, "SKIP"}
                    if roles == {"BLANK_NULL", "UNDECIDED"}:
                        r = "BLANK_NULL_UNDECIDED"
                    elif len(span_roles[id(c)]) > 1 and roles != {r}:
                        rec["notes"].append(f"cell spans {sorted(roles)}")
                    if r == "CAND":
                        rec["opts"].append((nm, pty, v, flag))
                    else:
                        rec["opts"].append((r, "", v, flag))
            for c in row:
                rec["urls"] += refs(c.raw, idx) + re.findall(r"\[(https?://[^\s\]]+)", c.raw)
            if not rec["pollster"] or sum(1 for o in rec["opts"] if o[0] not in (
                    "BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS")) < 2:
                continue
            if re.search(r"elei[cç][aã]o|election|resultado|result", norm(rec["pollster"])) or \
                    re.search(r"agrega", norm(rec["pollster"])):
                continue
            fs, fe = parse_dates(rec["date"], year_heading, en=(lang == "en"))
            if fe is None:
                print(f"  WARN {uf} {src} T{tno}: unparsed date {rec['date']!r} ({rec['pollster']})",
                      file=sys.stderr)
                continue
            cand_opts = [o for o in rec["opts"] if o[0] not in (
                "BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS")]
            ncand_cols = sum(1 for c in cols if c[0] == "CAND")
            # Round: two-candidate tables are runoff matchups; keep only the actual one.
            if ncand_cols == 2:
                fin = ballot[uf][2]
                if not fin:
                    continue
                m = {match(uf, o[0], o[1], fin) for o in cand_opts}
                if None in m or len(m) != 2:
                    continue
                rnd = 2
            else:
                if R2_SECTIONS.search(sec) and ncand_cols < 3:
                    continue
                rnd = 1
            if fe > ELECTION[rnd] or fe < f"{YEAR}-01-01":
                continue
            inst, sponsor = split_pollster(rec["pollster"])
            urls = [u for u in rec["urls"] if u.startswith("http")]
            score = 0
            if rnd == 1:
                b = ballot[uf][1]
                for o in cand_opts:
                    score += 1 if match(uf, o[0], o[1], b) else -1
            out.append({
                "state": uf, "round": rnd, "pollster": inst, "sponsor": sponsor,
                "field_start": fs, "field_end": fe, "sample_size": sample(rec["sample"]),
                "moe": moe(rec["moe"]) if rec["moe"] else "", "opts": rec["opts"],
                "source_page": src, "source_url": urls[0] if urls else "",
                "notes": rec["notes"], "score": score, "table": tno,
                "rawkey": (norm(rec["pollster"]), fs, fe),
            })
    return out


def select_scenarios(polls):
    """Group rows of one page/race by poll identity; keep the best-matching scenario(s)."""
    groups = defaultdict(list)
    for p in polls:
        groups[(p["round"],) + p["rawkey"]].append(p)
    kept = []
    for key, ps in groups.items():
        # identical duplicates (same numbers) collapse to one
        uniq = []
        for p in ps:
            sig = tuple(sorted((o[0], o[2]) for o in p["opts"]))
            if all(sig != tuple(sorted((o[0], o[2]) for o in q["opts"])) for q in uniq):
                uniq.append(p)
        best = max(p["score"] for p in uniq)
        top = [p for p in uniq if p["score"] == best]
        for i, p in enumerate(top, 1):
            p["scen"] = i if len(top) > 1 else 0
            if len(top) > 1:
                p["notes"].append(f"scenario {i} of {len(top)} kept (could not pick best match)")
            if len(uniq) > len(top):
                p["notes"].append(f"best-matching of {len(uniq)} scenarios")
        kept += top
    return kept


def _top(p):
    c = sorted((o[2] for o in p["opts"] if o[0] not in (
        "BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS")), reverse=True)
    return tuple(c[:2])


def same_poll(a, b):
    import datetime
    da = datetime.date.fromisoformat(a["field_end"])
    db = datetime.date.fromisoformat(b["field_end"])
    if abs((da - db).days) > 2:
        return False
    ka = slug(a["pollster"]).replace("-", "")[:4]
    kb = slug(b["pollster"]).replace("-", "")[:4]
    return ka == kb or _top(a) == _top(b)


def main():
    ballot = load_ballot()
    pages = []  # (uf, lang, title)
    for uf, t in PT.items():
        pages.append((uf, "pt", t))
        if uf == "SP":  # SP's poll tables are transcluded templates
            x = raw("pt", t)
            for tp in re.findall(r"\{\{\s*(Pesquisas de opinião das Eleições estaduais[^{}|]*Governador[^{}|]*)\}\}", x):
                pages.append((uf, "pt", "Predefinição:" + tp.strip()))
    for uf, t in EN.items():
        pages.append((uf, "en", t))

    by_race = defaultdict(lambda: defaultdict(list))  # (uf, rnd) -> src -> polls
    for uf, lang, title in pages:
        text = raw(lang, title)
        if text is None:
            print(f"missing page {lang}:{title}", file=sys.stderr)
            continue
        m = re.match(r"#(?:REDIRECT|REDIRECIONAMENTO)\s*\[\[([^\]#]+)", text, re.I)
        if m:
            title = m.group(1).strip()
            text = raw(lang, title)
        polls = extract_page(uf, lang, title, text, ballot)
        # SP: the main article and its templates form one source
        src_group = f"{lang}:{PT['SP']}" if (uf == "SP" and lang == "pt") else f"{lang}:{title}"
        for p in select_scenarios(polls):
            by_race[(uf, p["round"])][src_group].append(p)

    rows, report, used_pages = [], [], set()
    for uf in PT:
        for rnd in (1, 2):
            srcs = by_race.get((uf, rnd), {})
            if rnd == 2 and not ballot[uf][2]:
                continue
            counts = {s: len({(p["rawkey"]) for p in ps}) for s, ps in srcs.items()}
            if not counts:
                report.append((uf, rnd, 0, "", "", "", counts))
                continue
            order = sorted(counts, key=lambda s: (counts[s], s.startswith("pt:")), reverse=True)
            src = order[0]
            # Primary = richest page. Polls only present on the other page (e.g. en has the
            # early-2022 polls, pt the September ones) are added; duplicates are dropped.
            ps = list(srcs[src])
            added = defaultdict(int)
            for other in order[1:]:
                groups = defaultdict(list)
                for p in srcs[other]:
                    groups[p["rawkey"]].append(p)
                for g in groups.values():
                    if not any(same_poll(g[0], q) for q in ps):
                        ps += g
                        added[other] += 1
            counts = {s: (counts[s] if s == src else f"{counts[s]} (+{added[s]} added)")
                      for s in counts}
            ps = sorted(ps, key=lambda p: (p["field_end"], p["pollster"], p.get("scen", 0)))
            used_pages |= {p["source_page"] for p in ps}
            ids = set()
            for p in ps:
                pid = f"{YEAR}-governor-{uf}-r{rnd}-{slug(p['pollster'])}-{p['field_end']}"
                if p.get("scen"):
                    pid += f"-s{p['scen']}"
                base, k = pid, 2
                while pid in ids:
                    pid = f"{base}-{k}"
                    k += 1
                if pid != base:
                    p["notes"].append("distinct poll with same pollster/end date on page")
                ids.add(pid)
                notes = list(dict.fromkeys(p["notes"]))
                if any(o[3] == "<1" for o in p["opts"]):
                    notes.append("'<1' recorded as 0.5")
                for opt, party, v, flag in p["opts"]:
                    rows.append({
                        "poll_id": pid, "year": YEAR, "office": "governor", "state": uf,
                        "round": rnd, "pollster": p["pollster"], "sponsor": p["sponsor"],
                        "field_start": p["field_start"], "field_end": p["field_end"],
                        "sample_size": p["sample_size"], "moe": p["moe"], "option": opt,
                        "party": party, "pct": v, "source_page": p["source_page"],
                        "source_url": p["source_url"], "notes": "; ".join(notes),
                    })
            dates = [p["field_end"] for p in ps]
            report.append((uf, rnd, len({(p["source_page"],) + p["rawkey"] for p in ps}),
                           min(dates), max(dates), src, counts))

    cols = ["poll_id", "year", "office", "state", "round", "pollster", "sponsor", "field_start",
            "field_end", "sample_size", "moe", "option", "party", "pct", "source_page",
            "source_url", "notes"]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    print(f"wrote {len(rows)} rows to {OUT}")
    for uf, rnd, n, a, b, src, counts in report:
        alt = ", ".join(f"{s}={c}" for s, c in counts.items() if s != src)
        print(f"{uf} r{rnd}: {n:3d} polls {a}..{b}  [{src}]" + (f"  (alt: {alt})" if alt else ""))


if __name__ == "__main__":
    main()
