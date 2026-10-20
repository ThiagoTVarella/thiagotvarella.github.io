"""Extract Lula vs Flávio Bolsonaro second-round polls from the English
Wikipedia "Opinion polling for the 2026 Brazilian presidential election" page.

Wikipedia is used only as a seed index: every row is later checked against the
pollster's own release or a major outlet. Usage:
    python parse_wikipedia.py en_wiki.txt > wiki_seed.json
"""
import json
import re
import sys

MONTHS = {m: i for i, m in enumerate(
    "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}

SECTIONS = ["October (after 1st round)", "Aug–Oct (Campaign period)"]


def strip_markup(s):
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"\{\{n/a\}\}", "", s, flags=re.I)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("''", "")
    return s.strip()


def split_cell(raw):
    """Return (attrs, content) for a wikitext cell."""
    # attrs|content, but not when the pipe belongs to a link/template
    depth = 0
    for i, ch in enumerate(raw):
        if raw.startswith(("[[", "{{"), i):
            depth += 1
        elif raw.startswith(("]]", "}}"), i):
            depth -= 1
        elif ch == "|" and depth == 0:
            return raw[:i], raw[i + 1:]
    return "", raw


def parse_table(lines):
    rows, cur = [], None
    for ln in lines:
        if ln.startswith("|-"):
            cur = {"style": ln, "cells": []}
            rows.append(cur)
        elif ln.startswith("|}"):
            break
        elif ln.startswith("|") and cur is not None:
            for part in re.split(r"\|\|", ln[1:]):
                attrs, content = split_cell(part)
                cur["cells"].append((attrs, content))
        elif ln.startswith("!"):
            continue
        elif cur is not None and cur["cells"]:
            a, c = cur["cells"][-1]
            cur["cells"][-1] = (a, c + "\n" + ln)
    # expand rowspans
    grid, carry = [], {}
    for r in rows:
        if not r["cells"]:
            continue
        out, col, cells = [], 0, list(r["cells"])
        while cells or col in carry:
            if col in carry:
                val, left = carry[col]
                out.append(val)
                if left <= 1:
                    del carry[col]
                else:
                    carry[col] = (val, left - 1)
                col += 1
                continue
            attrs, content = cells.pop(0)
            span = re.search(r'rowspan="?(\d+)', attrs)
            cspan = re.search(r'colspan="?(\d+)', attrs)
            for _ in range(int(cspan.group(1)) if cspan else 1):
                out.append(content)
                if span and int(span.group(1)) > 1:
                    carry[col] = (content, int(span.group(1)) - 1)
                col += 1
        grid.append((r["style"], out))
    return grid


def num(s):
    s = strip_markup(s).replace(",", "").replace("%", "")
    m = re.match(r"^[<~]?\s*(\d+(?:\.\d+)?)$", s)
    return float(m.group(1)) if m else None


def parse_dates(s, year=2026):
    s = strip_markup(s).replace("–", "-").replace("—", "-")
    m = re.match(r"^(\d+)\s*([A-Za-z]{3})?\s*-\s*(\d+)\s*([A-Za-z]{3})$", s)
    if m:
        d1, m1, d2, m2 = m.groups()
        m1 = m1 or m2
        return (f"{year}-{MONTHS[m1[:3]]:02d}-{int(d1):02d}",
                f"{year}-{MONTHS[m2[:3]]:02d}-{int(d2):02d}")
    m = re.match(r"^(\d+)\s*([A-Za-z]{3})$", s)
    if m:
        d = f"{year}-{MONTHS[m.group(2)[:3]]:02d}-{int(m.group(1)):02d}"
        return d, d
    return None, None


def ref_index(text):
    idx = {}
    for m in re.finditer(r'<ref name="?([^">/]+)"?\s*>(.*?)</ref>', text, re.S):
        idx[m.group(1).strip()] = m.group(2)
    return idx


def refs_in(cell, idx):
    out = []
    for m in re.finditer(r'<ref(?: name="?([^">/]+)"?)?\s*(/?)>(.*?)(?:</ref>|$)',
                         cell, re.S):
        name, selfclose, body = m.groups()
        if selfclose:
            body = idx.get(name.strip(), "")
        u = re.search(r"\|\s*url\s*=\s*([^|}\s]+)", body)
        t = re.search(r"\|\s*title\s*=\s*([^|}]+)", body)
        w = re.search(r"\|\s*(?:website|work|publisher)\s*=\s*([^|}]+)", body)
        if u:
            out.append({"url": re.sub(r"[?&]utm_source=chatgpt\.com", "", u.group(1)),
                        "title": t.group(1).strip() if t else None,
                        "site": w.group(1).strip() if w else None})
    return out


def main(path):
    text = open(path, encoding="utf-8").read()
    idx = ref_index(text)
    second = text[text.index("==Second round=="):]
    polls = []
    for sec in SECTIONS:
        start = second.index(f"==== {sec} ====")
        body = second[start:]
        table = body[body.index("{|"):body.index("\n|}") + 3].splitlines()
        header = " ".join(l for l in table if l.startswith("!"))
        cands = re.findall(r"!\[\[[^|\]]+\|([^\]]+)\]\]<br", header)
        for style, cells in parse_table(table):
            if "lightyellow" in style or len(cells) < len(cands) + 7:
                continue
            pollster = strip_markup(cells[0])
            start_d, end_d = parse_dates(cells[1])
            vals = [num(c) for c in cells[2:2 + len(cands)]]
            present = [c for c, v in zip(cands, vals) if v is not None]
            if set(present) != {"Lula", "F. Bolsonaro"}:
                continue
            rest = cells[2 + len(cands):]
            polls.append({
                "wiki_section": sec,
                "pollster": pollster,
                "field_start": start_d,
                "field_end": end_d,
                "lula": vals[cands.index("Lula")],
                "flavio": vals[cands.index("F. Bolsonaro")],
                "blank_null_undecided": num(rest[0]),
                "moe": strip_markup(rest[1]),
                "sample_size": num(rest[2]),
                "refs": refs_in(rest[4], idx),
                "raw_dates": strip_markup(cells[1]),
            })
    json.dump(polls, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
