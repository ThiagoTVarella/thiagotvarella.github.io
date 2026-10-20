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


MONTHS = {m: i + 1 for i, m in enumerate(
    "jan fev mar abr mai jun jul ago set out nov dez".split())}
MONTHS.update({m: i + 1 for i, m in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split())})


def _mon(w):
    return MONTHS.get(w.lower()[:3])


def parse_dates(s):
    """Return (start, end) ISO strings in 2018, or (None, None)."""
    s = s.replace("º", "").replace("°", "").replace("–", "-").replace("—", "-")
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\b(de|of)\b", " ", s, flags=re.I)
    s = re.sub(r"\s+", " ", s)
    y = YEAR
    # numeric dd/mm(/yyyy)
    nums = re.findall(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s)
    if nums:
        ds = []
        for d, m, yy in nums:
            ds.append((int(d), int(m), int(yy) if yy else None))
        # "18 a 21/08" -> leading bare day before first dd/mm
        lead = re.match(r"^(\d{1,2})\s*(?:a|-|e|to)\s*\d{1,2}/", s)
        if lead and len(ds) == 1:
            ds.insert(0, (int(lead.group(1)), ds[0][1], ds[0][2]))
        yrs = [x[2] for x in ds if x[2]]
        yr = yrs[-1] if yrs else y
        yr = yr + 2000 if yr < 100 else yr
        a, b = ds[0], ds[-1]
        return (f"{a[2] + 2000 if a[2] and a[2] < 100 else (a[2] or yr):04d}-{a[1]:02d}-{a[0]:02d}",
                f"{yr:04d}-{b[1]:02d}-{b[0]:02d}")
    # ISO
    iso = re.findall(r"(\d{4})-(\d{2})-(\d{2})", s)
    if iso:
        a, b = iso[0], iso[-1]
        return "-".join(a), "-".join(b)
    # textual: "18-21 Aug 2018", "30 Jul - 2 Aug 2018", "Aug 18-21", "18 a 21 ago"
    toks = re.findall(r"\d{4}|\d{1,2}|[A-Za-zçÇ]{3,}", s)
    days, out, pending = [], [], []
    for tk in toks:
        if re.fullmatch(r"\d{4}", tk):
            continue
        if tk.isdigit():
            pending.append(int(tk))
        elif _mon(tk):
            m = _mon(tk)
            if pending:
                for d in pending:
                    out.append((d, m))
                pending = []
            else:
                days.append(m)  # month-first style: "Aug 18-21"
        if days and pending and not tk.isdigit() is False:
            pass
    if days and pending:  # month first
        m = days[-1]
        out += [(d, m) for d in pending]
        pending = []
    if pending and out:  # "30 Jul - 2" unlikely; attach to last month
        out += [(d, out[-1][1]) for d in pending]
    if not out:
        return None, None
    a, b = out[0], out[-1]
    return f"{y}-{a[1]:02d}-{a[0]:02d}", f"{y}-{b[1]:02d}-{b[0]:02d}"


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")
