# Brief: extract historical Brazilian polls from Wikipedia

Goal: a historical database of published polls for Brazilian **presidential and
gubernatorial** elections, to be scored against official TSE results for pollster
ratings. Wikipedia is trusted as the source; do NOT verify individual polls
elsewhere. Your job is faithful, complete, machine-readable extraction.

Repo: /home/user/thiagotvarella.github.io/brpolls (do NOT git commit; the coordinator does).

## Tools you must use
- `scripts/hist/wikifetch.py` — cached, rate-limit-aware fetcher. Wikipedia rate-limits
  this network, so ALWAYS fetch through it (python API: `from wikifetch import raw, search`),
  never with raw curl loops. It retries with backoff; be patient.
- `scripts/hist/wikitable.py` — table parser (expands rowspan/colspan; `Cell.text`,
  `Cell.number`, `Cell.raw`, `refs()`, `ref_index()`, `Table.section`, `Table.header`).
  Header rows are sometimes in the body (rows with '!' cells mixed with '|'), and candidate
  names are often only in a header row with images/links; inspect the wikitext and adapt.
  You may improve wikitable.py if you find a genuine bug, but keep it backward compatible.

Write your extraction as a reproducible script `scripts/hist/extract_<group>.py` that
fetches the pages via wikifetch and writes the output CSV. Page-specific quirks are fine
(handle them in code with comments).

## Output: data/hist/polls_<group>.csv (long format, UTF-8, one row per poll x option)
Columns, in this order:
  poll_id, year, office, state, round, pollster, sponsor, field_start, field_end,
  sample_size, moe, option, party, pct, source_page, source_url, notes

- poll_id: `{year}-{office}-{state}-r{round}-{slug(pollster)}-{field_end}` plus `-s{n}` if
  one poll has several scenarios kept. Must be unique per poll.
- office: `president` or `governor`. state: `BR` for national, else the UF code (SP, RJ, DF...).
- round: 1 or 2.
- pollster: the institute as written on Wikipedia (e.g. "Datafolha", "Ibope", "Ipec",
  "Quaest", "Paraná Pesquisas", "Real Time Big Data"). If a cell is "Contratante/Instituto"
  like "Folha/Datafolha" or "Globo/Ipec", split: pollster = the institute, sponsor = the rest.
- field_start/field_end: ISO dates. A single date -> both equal. If only a publication date
  is given, use it for both and say so in notes.
- sample_size: integer or blank. moe: number in points or blank.
- option: candidate name as on Wikipedia (short ballot name is fine), or one of the special
  values `BLANK_NULL`, `UNDECIDED`, `BLANK_NULL_UNDECIDED` (when combined), `OTHERS`,
  `ABSTENTION`. Record every column that has a number.
- party: candidate party abbreviation if available from the header, else blank.
- pct: number as published (total votes, i.e. "votos totais" — NOT valid votes, unless the
  table is explicitly valid votes; if so, note "valid votes" in notes for every row of that poll).
- source_page: Wikipedia page title (with language prefix, e.g. "pt:Pesquisas de ...").
- source_url: first cited URL for the poll if present, else blank.

## Scope rules
- Keep polls whose field_end falls in the election year, up to election day.
- Round 1: keep the stimulated (estimulada) vote-intention scenario. If a poll lists several
  scenarios, keep the one whose candidate list best matches the actual ballot (after
  candidate registration in mid-August there is usually only one); keep others only if you
  can't tell, as -s2, -s3 with a note. Skip spontaneous (espontânea) and rejection tables.
- Round 2: keep polls of the matchup that actually happened in that race. Ignore
  hypothetical matchups that never happened. Do include pre-first-round polls of the actual
  matchup (they are useful), they're just tagged by field dates.
- Skip aggregator rows ("Agregação"), election-result rows, and event rows (debates etc.).
- Election days: 2002 Oct 6/Oct 27; 2006 Oct 1/Oct 29; 2010 Oct 3/Oct 31; 2014 Oct 5/Oct 26;
  2018 Oct 7/Oct 28; 2022 Oct 2/Oct 30; 2026 Oct 4/Oct 25.

## Finding pages
Portuguese Wikipedia is usually richer. Useful patterns:
- pt "Pesquisas de opinião para a eleição presidencial no Brasil em {year}" (2010–2026)
- en "Opinion polling for the {year} Brazilian presidential election" (2010, 2018, 2022, 2026)
- pt "Pesquisas eleitorais para a eleição estadual de 2026 em/no/na {Estado}" (all 27 states)
- For governor races before 2026, polls usually sit in a "Pesquisas" section of the state
  election article, e.g. pt "Eleição estadual em São Paulo em 2022" (check exact titles with
  `search('pt', 'intitle:"Eleição estadual" 2022')`), and sometimes in the en article
  "{year} {State} gubernatorial election". Use whichever has more polls; don't double count.

## Quality checks before you finish
- Print, per race (year/office/state/round): number of polls and the date range.
- Spot-check at least 5 random polls against the wikitext.
- Each poll's candidate + special shares should sum to roughly 100 (90–105) for total-vote
  tables; list exceptions in your final message rather than "fixing" numbers.
- Final message: per-race counts, pages used, races with no polls found, and known issues.
