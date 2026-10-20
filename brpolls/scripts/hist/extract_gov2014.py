"""Extract 2014 gubernatorial polls (all 27 UFs, rounds 1 and 2) from Wikipedia.

    python scripts/hist/extract_gov2014.py   -> data/hist/polls_gov2014.csv

Sources: "Pesquisas" sections of pt "Eleições estaduais ... em 2014" articles and the
"Opinion polling" sections of en "2014 {State} gubernatorial/general election" articles.
When both languages have a table for a race, both are parsed and merged; a poll present
in both (same pollster and same top-3 shares, or same pollster and field end within a day)
is kept once (version closest to 100% total, then the one with real field dates).
2010 was skipped (coordinator instruction).
"""
import csv
import os
import re
import sys
import unicodedata
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikifetch import raw  # noqa: E402
from wikitable import tables, refs, ref_index, clean  # noqa: E402

YEAR = 2014
EDAY = {1: date(2014, 10, 5), 2: date(2014, 10, 26)}
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "data", "hist", "polls_gov2014.csv")

PT = {
    "AP": "Eleições estaduais no Amapá em 2014", "AM": "Eleições estaduais no Amazonas em 2014",
    "BA": "Eleições estaduais na Bahia em 2014", "DF": "Eleições distritais no Distrito Federal em 2014",
    "ES": "Eleições estaduais no Espírito Santo em 2014", "GO": "Eleições estaduais em Goiás em 2014",
    "MS": "Eleições estaduais em Mato Grosso do Sul em 2014", "PA": "Eleições estaduais no Pará em 2014",
    "PB": "Eleições estaduais na Paraíba em 2014", "PR": "Eleições estaduais no Paraná em 2014",
    "PE": "Eleições estaduais em Pernambuco em 2014", "RJ": "Eleições estaduais no Rio de Janeiro em 2014",
    "RN": "Eleições estaduais no Rio Grande do Norte em 2014",
    "RS": "Eleições estaduais no Rio Grande do Sul em 2014", "SP": "Eleições estaduais em São Paulo em 2014",
}
EN = {
    "AC": "2014 Acre general election", "BA": "2014 Bahia general election",
    "CE": "2014 Ceará general election", "PB": "2014 Paraíba gubernatorial election",
    "PR": "2014 Paraná gubernatorial election", "RJ": "2014 Rio de Janeiro gubernatorial election",
    "RS": "2014 Rio Grande do Sul gubernatorial election", "SP": "2014 São Paulo gubernatorial election",
}
# (uf, round, lang, section regex). Order = priority for duplicate resolution.
SOURCES = [
    ("AC", 1, "en", r"Opinion"),
    ("AP", 1, "pt", r"1° Turno ao Gov"), ("AP", 2, "pt", r"2° Turno ao Gov"),
    ("AM", 1, "pt", r"Primeiro turno para governador"), ("AM", 2, "pt", r"Segundo turno para governador"),
    ("BA", 1, "pt", r"Pesquisa para governador"), ("BA", 1, "en", r"Opinion"),
    ("CE", 1, "en", r"Opinion"),
    ("DF", 1, "pt", r"intenção de voto / Governador"),
    ("ES", 1, "pt", r"Governador / Intenção"),
    ("GO", 1, "pt", r"Governador 1º Turno"), ("GO", 2, "pt", r"Governador 2º Turno"),
    ("MS", 1, "pt", r"Governo do Estado / 1º turno"), ("MS", 2, "pt", r"Governo do Estado / 2° turno"),
    ("PA", 1, "pt", r"Primeiro turno / Intenções"), ("PA", 2, "pt", r"Pesquisa para governador"),
    ("PB", 1, "pt", r"Pesquisas para governador"), ("PB", 1, "en", r"Opinion"),
    ("PR", 1, "pt", r"Pesquisas de Opiniões / Governador"), ("PR", 1, "en", r"Opinion"),
    ("PE", 1, "pt", r"Pesquisas de opinião / Governador"),
    ("RJ", 1, "pt", r"Governador 1ºTurno"), ("RJ", 1, "en", r"Opinion"),
    ("RJ", 2, "pt", r"Governador 2ºTurno"),
    ("RN", 1, "pt", r"Governador 1º turno"), ("RN", 2, "pt", r"Governador 2º turno"),
    ("RS", 1, "pt", r"Governador \(1º turno\)"), ("RS", 1, "en", r"Opinion"),
    ("RS", 2, "pt", r"Governador \(2º turno\)"),
    ("SP", 1, "pt", r"Pesquisas de opinião / Governador"), ("SP", 1, "en", r"Opinions polls / Governor"),
]
NO_POLLS = ["AL", "MA", "MG", "MT", "PI", "RO", "RR", "SC", "SE", "TO"]

KNOWN = ["ibope", "datafolha", "ibrape", "vale consultoria", "ipespe", "sensus", "bapesp", "babesp",
         "souza lopes", "companhia de pesquisa", "verita", "vox populi", "methodus", "gerp", "delta",
         "phoenix", "enquet", "futura", "flexconsult", "brand", "serpes", "verus", "fortiori",
         "datamax", "ipems", "escutec", "r.c.g", "consult", "acritica action", "instituto diario"]

MONTHS = {"jan": 1, "fev": 2, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "mai": 5, "may": 5, "jun": 6,
          "jul": 7, "ago": 8, "aug": 8, "set": 9, "sep": 9, "out": 10, "oct": 10, "nov": 11,
          "dez": 12, "dec": 12}


def strip_acc(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", strip_acc(s).lower()).strip("-")


def preprocess(text):
    # shading templates around numbers: {{yes2|40%}}, {{no|27%}} -> the number
    text = re.sub(r"\{\{\s*[\w ]+\|\s*([<~]?\s*\d[\d.,]*\s*%?\*?)\s*\}\}", r"\1", text)
    return text.replace("&ndash;", "–")


def num(s):
    t = clean(s).replace("%", "").replace("*", "").replace("−", "-").strip()
    if re.fullmatch(r"<\s*1", t):
        return 0.5
    t = t.replace(",", ".") if re.fullmatch(r"\d+,\d+", t) else t.replace(",", "")
    m = re.fullmatch(r"~?\s*(\d+(?:\.\d+)?)", t)
    return float(m.group(1)) if m else None


def parse_dates(s):
    s = strip_acc(clean(s)).lower().replace(".º", "").replace("º", "").replace("°", "")
    s = re.sub(r"(\d)o\b", r"\1", s)
    toks = re.findall(r"\d{1,2}/\d{1,2}(?:/\d{4})?|\d{4}|\d{1,2}|[a-z]+", s)
    month_first = bool(toks) and toks[0][:3] in MONTHS
    dates, pending, cur, years = [], [], None, []
    for tk in toks:
        if "/" in tk:
            p = tk.split("/")
            d = [int(p[0]), int(p[1]), int(p[2]) if len(p) > 2 else None]
            for q in pending:
                q[1] = d[1]
            pending = []
            dates.append(d)
        elif re.fullmatch(r"\d{4}", tk):
            years.append(int(tk))
            for d in dates:
                if d[2] is None:
                    d[2] = int(tk)
        elif tk.isdigit():
            d = [int(tk), cur if month_first else None, None]
            dates.append(d)
            if d[1] is None:
                pending.append(d)
        elif tk[:3] in MONTHS:
            m = MONTHS[tk[:3]]
            if pending and not month_first:
                for q in pending:
                    q[1] = m
                pending = []
            cur = m
    out = []
    for d in dates:
        if d[1] is None:
            continue
        try:
            out.append(date(d[2] or YEAR, d[1], d[0]))
        except ValueError:
            pass
    if not out:
        return None, None
    return out[0], out[-1]


def label_of(raw_cell):
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", raw_cell)
    s = re.sub(r"\{\{\s*small\s*\|(.*?)\}\}", r"\1", s, flags=re.I | re.S)
    return clean(s)


GENERIC = re.compile(r"^(candidat[oe].*|fonte:.*|)$", re.I)


def role(lbl):
    l = strip_acc(lbl).lower()
    if re.search(r"^(data|periodo|date|divulga)", l):
        return "date"
    if re.search(r"instituto|institute|pollster", l):
        return "pollster"
    if "margem" in l:
        return "moe"
    if re.search(r"amostra|sample", l):
        return "sample"
    if re.search(r"^ref|vantagem|^lead", l):
        return "skip"
    if re.search(r"^others?$|^outros", l):
        return "OTHERS"
    bn = re.search(r"branc|nul|blank|null", l)
    und = re.search(r"sabe|souber|opina|\bns\b|\bnr\b|indec|undec|absent|abst|respond", l)
    if "sem candidato" in l or (bn and und):
        return "BLANK_NULL_UNDECIDED"
    if bn:
        return "BLANK_NULL"
    if und:
        return "UNDECIDED"
    return "cand"


def split_name(lbl):
    m = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", lbl)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = re.match(r"^(.*?)\s+([A-Z][A-Za-z]*[A-Z](?:/[A-Z][A-Za-z]*[A-Z])*)$", lbl)
    if m and m.group(1):
        return m.group(1).strip(), m.group(2)
    return lbl, ""


def split_pollster(s, hint_first):
    s = re.sub(r"\s*\(\*\)", "", s).strip()
    parts = [p.strip() for p in s.split("/") if p.strip()]
    if len(parts) == 1:
        return parts[0], ""
    for i, p in enumerate(parts):
        if any(k in strip_acc(p).lower() for k in KNOWN):
            return p, "/".join(parts[:i] + parts[i + 1:])
    i = 0 if hint_first else len(parts) - 1
    return parts[i], "/".join(parts[:i] + parts[i + 1:])


def parse_table(tb, text_raw, uf, rnd, lang, title):
    idx = ref_index(text_raw)
    # table width = most common body-row length (header rows can claim extra colspan)
    lens = [len(r.cells) for r in tb.rows if len(set(c.text for c in r.cells)) > 1]
    ncol = max(set(lens), key=lens.count) if lens else 0
    # header rows as raw-ish labels: recompute from tb.header text, but SP en needs raw links,
    # so take labels from tb.header and fix '[[' leftovers via label_of on the text.
    labels = []
    for c in range(ncol):
        lab = ""
        for h in reversed(tb.header):
            if c < len(h) and not GENERIC.match(h[c].strip()):
                lab = h[c]
                break
        labels.append(lab)
    # GO r2 quirk: last column has no label in the inner header row; use the outer row's last label
    if labels and labels[-1] == "" and tb.header:
        labels[-1] = max(tb.header, key=len)[-1]
    hdr_raw = header_raw_labels(text_raw, tb)
    for c, lab in enumerate(labels):
        if "[[" in lab and c in hdr_raw:
            labels[c] = hdr_raw[c]
    roles = [role(l) for l in labels]
    pubdate = any(re.match(r"divulga", strip_acc(l).lower()) for l in labels)
    hint_first = any("comprador" in l.lower() for l in labels)
    cand_cols = [i for i, r in enumerate(roles) if r == "cand"]
    polls = []
    for row in tb.rows:
        cells = row.cells
        texts = [c.text for c in cells]
        if len(set(texts)) == 1:
            continue  # footnote rows spanning the table
        notes = []
        if len(cells) > ncol:
            print(f"  SKIP {uf} r{rnd} {lang}: row longer than header: {texts[:3]}")
            continue
        if len(cells) < ncol:
            # RN quirk: row with fewer cells; candidates first, the rest go to the last columns
            n_lead = cand_cols[0]
            vals = cells[n_lead:]
            k = len(vals)
            ncand_present = k - len([r for r in roles if r not in ("cand", "date", "pollster", "moe", "sample", "skip")])
            new = list(cells[:n_lead]) + [None] * (ncol - n_lead)
            ncand_present = max(0, ncand_present)
            for j in range(ncand_present):
                new[n_lead + j] = vals[j]
            tail = vals[ncand_present:]
            for j, v in enumerate(tail):
                new[ncol - len(tail) + j] = v
            cells = new
            notes.append("row has fewer cells than header; trailing values assigned to the last columns")
        get = lambda r: next((cells[i] for i, x in enumerate(roles) if x == r and cells[i] is not None), None)
        dcell, pcell = get("date"), get("pollster")
        if dcell is None or pcell is None:
            continue
        ptxt = pcell.text
        if re.search(r"election|eleição|agrega|resultado", ptxt, re.I):
            continue
        if re.search(r"v[aá]lidos", ptxt, re.I):
            continue  # PA r2: valid-vote duplicate rows
        ptxt = re.sub(r"\s*Votos Totais", "", ptxt)
        start, end = parse_dates(dcell.raw)
        if end is None:
            print(f"  SKIP {uf} r{rnd} {lang}: no date: {texts[:3]}")
            continue
        if pubdate:
            notes.append("only publication date given; used as field dates")
        elif start == end:
            notes.append("single date on Wikipedia (may be publication date)")
        pollster, sponsor = split_pollster(ptxt, hint_first)
        mc, sc = get("moe"), get("sample")
        moe = num(mc.raw.replace("±", "")) if mc else None
        ss = None
        if sc:
            m = re.search(r"\d[\d.,]*", sc.text)
            ss = int(re.sub(r"[.,]", "", m.group(0))) if m else None
        opts = []
        for i, r in enumerate(roles):
            if r in ("date", "pollster", "moe", "sample", "skip") or cells[i] is None:
                continue
            v = num(cells[i].raw)
            if v is None:
                continue
            if r == "cand":
                name, party = split_name(labels[i])
                opts.append((name, party, v))
            else:
                opts.append((r, "", v))
        if not any(o[0] not in SPECIAL for o in opts):
            continue
        url = (refs(pcell.raw, idx) or refs(dcell.raw, idx) or [""])[0]
        polls.append(dict(uf=uf, round=rnd, pollster=pollster, sponsor=sponsor, start=start, end=end,
                          ss=ss, moe=moe, opts=opts, page=f"{lang}:{title}", url=url, notes=notes,
                          pubdate=pubdate))
    return polls


SPECIAL = {"BLANK_NULL", "UNDECIDED", "BLANK_NULL_UNDECIDED", "OTHERS", "ABSTENTION"}


def header_raw_labels(text_raw, tb):
    """For en tables with linked names in headers: map column -> label from raw header lines."""
    out = {}
    m = re.search(r"Pollster/client", text_raw)
    if not m:
        return out
    seg = text_raw[m.start():text_raw.find("|-", m.start())]
    cells = [ln.lstrip("!").split("|", 1)[-1] for ln in seg.splitlines()[1:] if ln.startswith("!")]
    for i, c in enumerate(cells):
        out[i + 1] = label_of(c)
    return out


def total(p):
    return sum(o[2] for o in p["opts"])


def has_special(p):
    return any(o[0] in SPECIAL for o in p["opts"])


def ncand(p):
    return sum(1 for o in p["opts"] if o[0] not in SPECIAL)


def select_scenarios(polls):
    groups = {}
    for p in polls:
        groups.setdefault((slug(p["pollster"]), p["end"]), []).append(p)
    out = []
    for g in groups.values():
        if any(has_special(p) for p in g):
            g2 = [p for p in g if has_special(p) or not 98 <= total(p) <= 102]
            g = g2 or g
        best = max(ncand(p) for p in g)
        g = [p for p in g if ncand(p) == best]
        if len(g) > 1:
            for i, p in enumerate(g):
                p["scen"] = i + 1
                p["notes"].append(f"several scenarios with {best} candidates on Wikipedia; scenario {i + 1} of {len(g)}")
        out.extend(g)
    return out


def top3(p):
    return tuple(sorted((round(o[2], 1) for o in p["opts"] if o[0] not in SPECIAL), reverse=True)[:3])


def pkey(p):
    # "Babesp" (en) and "Bapesp" (pt) are the same Bahia institute
    return slug(p["pollster"]).split("-")[0].replace("babesp", "bapesp")


def is_dup(a, b):
    if pkey(a) != pkey(b):
        return False
    dd = abs((a["end"] - b["end"]).days)
    if top3(a) == top3(b) and dd <= 10:
        return True
    return dd <= 1 and not a["pubdate"] and not b["pubdate"] and a.get("scen") is None and b.get("scen") is None


def merge(primary, extra):
    out = list(primary)
    for e in extra:
        cands = [i for i, p in enumerate(out) if p["page"] != e["page"] and is_dup(p, e)
                 and f"also on {e['page']}" not in p["notes"]]
        hit = min(cands, key=lambda i: abs((out[i]["end"] - e["end"]).days)) if cands else None
        if hit is None:
            out.append(e)
            continue
        p = out[hit]
        dp, de = abs(total(p) - 100), abs(total(e) - 100)
        if de + 2 < dp:
            win, lose = e, p
        elif dp + 2 < de:
            win, lose = p, e
        elif p["pubdate"] and not e["pubdate"]:
            win, lose = e, p
        else:
            win, lose = p, e
        if win["pubdate"] and not lose["pubdate"]:
            win["start"], win["end"], win["pubdate"] = lose["start"], lose["end"], False
            win["notes"] = [n for n in win["notes"] if "publication" not in n]
            win["notes"].append(f"field dates taken from {lose['page']}")
        if not win["ss"] and lose["ss"]:
            win["ss"] = lose["ss"]
        win["notes"].append(f"also on {lose['page']}")
        out[hit] = win
    return out


def main():
    texts = {}
    races = {}
    for uf, rnd, lang, pat in SOURCES:
        title = PT[uf] if lang == "pt" else EN[uf]
        if (lang, title) not in texts:
            t = raw(lang, title)
            texts[(lang, title)] = (t, preprocess(t))
        orig, text = texts[(lang, title)]
        found = [tb for tb in tables(text) if re.search(pat, " / ".join(tb.section))]
        if not found:
            print("NO TABLE", uf, rnd, lang, pat)
            continue
        polls = parse_table(found[0], orig, uf, rnd, lang, title)
        kept = []
        for p in polls:
            if p["end"].year != YEAR or p["end"] > EDAY[rnd]:
                continue
            if p["start"] == EDAY[rnd]:
                print(f"  SKIP exit poll {uf} r{rnd} {p['pollster']} {p['end']}")
                continue
            if rnd == 2 and ncand(p) != 2:
                continue
            kept.append(p)
        kept = select_scenarios(kept)
        races[(uf, rnd)] = merge(races.get((uf, rnd), []), kept)

    rows, ids = [], set()
    for (uf, rnd), polls in sorted(races.items()):
        polls.sort(key=lambda p: (p["end"], p["pollster"]))
        for p in polls:
            if not has_special(p) and 98 <= total(p) <= 102:
                p["notes"].append("no blank/undecided reported and shares sum to ~100: likely valid votes")
            pid = f"{YEAR}-governor-{uf}-r{rnd}-{slug(p['pollster'])}-{p['end'].isoformat()}"
            if p.get("scen"):
                pid += f"-s{p['scen']}"
            base, k = pid, 2
            while pid in ids:
                pid = f"{base}-dup{k}"
                k += 1
            ids.add(pid)
            for name, party, v in p["opts"]:
                rows.append([pid, YEAR, "governor", uf, rnd, p["pollster"], p["sponsor"],
                             p["start"].isoformat(), p["end"].isoformat(), p["ss"] or "",
                             "" if p["moe"] is None else p["moe"], name, party,
                             int(v) if v == int(v) else v, p["page"], p["url"], "; ".join(p["notes"])])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["poll_id", "year", "office", "state", "round", "pollster", "sponsor", "field_start",
                    "field_end", "sample_size", "moe", "option", "party", "pct", "source_page",
                    "source_url", "notes"])
        w.writerows(rows)

    print("\nPer race:")
    for (uf, rnd), polls in sorted(races.items()):
        if polls:
            print(f"  2014 governor {uf} r{rnd}: {len(polls)} polls, {min(p['end'] for p in polls)}"
                  f" .. {max(p['end'] for p in polls)}")
    print("No polls on Wikipedia:", ", ".join(NO_POLLS))
    print("\nTotals outside 90-105:")
    for (uf, rnd), polls in sorted(races.items()):
        for p in polls:
            t = total(p)
            if not 90 <= t <= 105:
                print(f"  {uf} r{rnd} {p['pollster']} {p['end']}: {t:.1f}")


if __name__ == "__main__":
    main()
