"""Generic MediaWiki table parser for poll tables.

    from wikitable import tables
    for t in tables(wikitext):
        t.section      # list of headings above the table, outermost first
        t.header       # header rows, each expanded to one string per column
        t.rows         # body rows: list of Row(cells=[Cell(text, raw, attrs)], style)

rowspan/colspan are expanded, so every row has one cell per column. Cell.text
is cleaned plain text; Cell.raw keeps the wikitext (for refs, colors, links).
"""
import re
from dataclasses import dataclass, field


@dataclass
class Cell:
    raw: str
    attrs: str = ""

    @property
    def text(self):
        return clean(self.raw)

    @property
    def number(self):
        return number(self.raw)


@dataclass
class Row:
    cells: list
    style: str = ""


@dataclass
class Table:
    section: list
    header: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    attrs: str = ""


def clean(s):
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"\{\{\s*(?:n/a|N/A|nd|—|-)\s*(?:\|[^}]*)?\}\}", "", s)
    s = re.sub(r"\{\{\s*(?:small|nowrap|abbr|sort|tooltip)\s*\|([^|}]*)(?:\|[^}]*)?\}\}",
               r"\1", s, flags=re.I)
    s = re.sub(r"\{\{\s*(?:dts|date)\s*\|([^}]*)\}\}", r"\1", s, flags=re.I)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:File|Ficheiro|Imagem|Image|Arquivo):[^\]]*\]\]", "", s, flags=re.I)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\]", "", s)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("'''", "").replace("''", "").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", s).strip()


def number(s):
    """Parse a share like '45,3%', '45.3', '<1' (returns 0.5) or None."""
    t = clean(s).replace("%", "").replace("−", "-").strip()
    if re.fullmatch(r"<\s*1", t):
        return 0.5
    t = t.replace(",", ".") if re.fullmatch(r"\d+,\d+", t) else t.replace(",", "")
    m = re.fullmatch(r"~?\s*(\d+(?:\.\d+)?)", t)
    return float(m.group(1)) if m else None


def _split_attrs(raw):
    depth = 0
    for i, ch in enumerate(raw):
        two = raw[i:i + 2]
        if two in ("[[", "{{"):
            depth += 1
        elif two in ("]]", "}}"):
            depth -= 1
        elif ch == "|" and depth == 0:
            if raw[i:i + 2] == "||":
                break
            head = raw[:i]
            if "=" in head or head.strip() == "":
                return head, raw[i + 1:]
            break
    return "", raw


def _split_cells(line, sep):
    parts, depth, cur, i = [], 0, "", 0
    while i < len(line):
        two = line[i:i + 2]
        if two in ("[[", "{{"):
            depth += 1
        elif two in ("]]", "}}"):
            depth -= 1
        if depth <= 0 and two == sep:
            parts.append(cur)
            cur, i = "", i + 2
            continue
        cur += line[i]
        i += 1
    parts.append(cur)
    return parts


def _expand(rows):
    out, carry = [], {}
    for style, cells in rows:
        row, col, cells = [], 0, list(cells)
        while cells or col in carry:
            if col in carry:
                cell, left = carry[col]
                row.append(cell)
                carry[col] = (cell, left - 1)
                if left <= 1:
                    del carry[col]
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
        out.append((style, row))
    return out


def tables(text):
    """Yield every top-level table in the wikitext (nested tables are skipped)."""
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
            yield _parse(body, list(section))
            i = j
        i += 1


def _parse(body, section):
    t = Table(section=section, attrs=body[0].lstrip()[2:])
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
            cur = [s, [], False]
            raw_rows.append(cur)
            continue
        if cur is None:
            cur = ["", [], False]
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
            if is_head and not cur[2] and len(cur[1]) == len(pieces):
                cur[2] = True
        elif cur[1]:
            last = cur[1][-1]
            last.raw += "\n" + ln
    head_rows = [r for r in raw_rows if r[2] and r[1]]
    body_rows = [r for r in raw_rows if not r[2] and r[1]]
    t.header = [[c.text for c in row] for _, row in _expand([(r[0], r[1]) for r in head_rows])]
    t.rows = [Row(cells, style) for style, cells in _expand([(r[0], r[1]) for r in body_rows])]
    return t


def refs(raw, index=None):
    """URLs cited in a cell; named refs (<ref name=x/>) are resolved via index."""
    out = []
    for m in re.finditer(r'<ref(?:\s+name\s*=\s*"?([^">/]+?)"?)?\s*(/?)>(.*?)(?:</ref>|$)',
                         raw, re.S):
        name, selfclose, body = m.groups()
        if selfclose and index is not None:
            body = index.get((name or "").strip(), "")
        u = re.search(r"\|\s*url\s*=\s*([^|}\s]+)", body) or re.search(r"\[(https?://\S+)", body)
        if u:
            out.append(re.sub(r"[?&]utm_source=chatgpt\.com", "", u.group(1)))
    return out


def ref_index(text):
    return {m.group(1).strip(): m.group(2) for m in re.finditer(
        r'<ref\s+name\s*=\s*"?([^">/]+?)"?\s*>(.*?)</ref>', text, re.S)}
