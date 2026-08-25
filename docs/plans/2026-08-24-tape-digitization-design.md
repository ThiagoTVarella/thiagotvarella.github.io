# Greek Tape Diary Digitizer

> **Revised after design review.** Two load-bearing research claims in the first draft were
> wrong (verified verbatim against OpenRouter's docs). See "Correction" below — it changes
> the pipeline substantially.

## Context

Thiago's girlfriend inherited hundreds of magnetic tapes from her grandfather — a daily
audio diary, recorded in Greek, kept at the family house in Athens. She brought back as many
as fit in a carry-on. She can't read them: they're analog, they're in a language she doesn't
speak, and there are hundreds of hours of them.

She handles analog capture herself (tape deck → audio interface → files). **This tool starts
from audio files** and produces a searchable, readable, correctly-dated English diary — with
the proper nouns spelled right, because the names are what she'll care about most.

Fixed constraints:

- **No backend.** Static page on `thiagotvarella.github.io`. Nothing to deploy or maintain.
- **His OpenRouter key**, pasted into her browser, like the GitHub PAT in `admin/index.html`.
- **Her data stays on her machine** (File System Access folder), except audio sent for ASR.
- **She does not read Greek** — "proofread the transcript" is not a workflow she can perform.
- **Hundreds of tapes**, so an unattended overnight queue is mandatory.

---

## Correction: what the chosen model actually returns

Verified against OpenRouter's STT guide and the MAI model page:

- **`"prompt` is accepted but ignored."** Verbatim. Generic prompt biasing is a **silent
  no-op** — the request succeeds and nothing happens. Only Groq has a documented passthrough
  (`provider.options.groq.prompt`).
- **`"verbose_json` is only available on OpenAI-compatible providers (OpenAI, Groq, Together).
  Other providers reject it with a 400."** `microsoft/mai-transcribe-1.5` is hosted by
  **Azure alone** ("This model is hosted by one provider"), so it is not eligible.
- MAI also **does not support diarization** (stated on its model page). Fine — one speaker.

**Therefore: through OpenRouter, MAI-Transcribe returns plain text only. No segment
timestamps, no word timestamps, no per-segment confidence, no keyword biasing.**

The first draft assumed all four existed. Alignment, flagging, and the glossary must all be
built from **text plus chunk boundaries alone.** That single sentence drives the redesign.

Claims that did check out: the endpoint `POST /api/v1/audio/transcriptions` exists behind the
same key and base URL as chat; 25 MB multipart cap; the ~60s figure is an *upstream processing
timeout, not a length limit* (MAI does an hour in under 15s); $0.36/hr.

### Both backends get built — the model becomes a setting, not a decision

The dividing line is **not** OpenAI vs. everyone else — it's **Whisper vs. everything newer**.
`gpt-4o-transcribe` is an OpenAI model and also refuses: *"response_format 'verbose_json' is not
compatible with model 'gpt-4o-transcribe'."* Every vendor's newer, more accurate model dropped
timestamps. **No separate OpenAI account is needed** — OpenRouter already routes to
OpenAI/Groq/Together, so the single-key setup holds either way.

| | Whisper (`openai/whisper-large-v3`) | MAI (`microsoft/mai-transcribe-1.5`) |
|---|---|---|
| Segment + word timestamps | Yes, via `verbose_json` | **None** |
| Per-segment confidence | `avg_logprob`, `no_speech_prob`, `compression_ratio` | **None** |
| Vocabulary biasing | Yes — `provider.options.groq.prompt`, 224-token cap | **None via OpenRouter** |
| Greek accuracy | Lower | Higher (best-in-class FLEURS) |
| Cost / 300 hrs | ~$8–33 | ~$110 |

Since **no tapes are in hand to decide this empirically**, the ASR stage is an adapter with
three selectable modes rather than a hardcoded choice:

1. **Precise text** — MAI only. Best words; navigation only to the nearest chunk; no confidence.
2. **Precise navigation** — Whisper only. Sentence-level seeking, confidence flags, glossary
   biasing, ~10× cheaper; rougher words.
3. **Cross-check (default)** — both, ~$120–140 total. MAI supplies the text, Whisper supplies
   timing and confidence, **and disagreement between them becomes the confidence signal MAI
   otherwise lacks.**

Mode 3 is the reason to build the adapter rather than pick a model. MAI's real danger for an
irreplaceable archive isn't lower accuracy, it's returning a *confident wall of text with no way
to know which parts are invented*. Running both and diffing per chunk fixes precisely that.
Critically, **silence-aware chunking makes this nearly free to implement**: both models
transcribe the same chunk, so there is no cross-transcript alignment problem — the comparison is
per-chunk, and a large divergence flags the chunk for review.

Presented to her as a plain-language choice, not model names. Default mode 3; per-tape override.
Leaves room later for per-chunk escalation (transcribe cheap, re-run only low-confidence chunks
through MAI).

---

## Architecture

The website is the app. **Her folder is the database.** Nothing persists server-side.

### Her project folder

Folder handle picked once via File System Access, persisted in IndexedDB. Plain JSON/TXT —
greppable, backup-able, readable long after this tool dies.

```
GrandpaTapes/
  glossary.json
  tapes/
    tape-001/
      source.wav                 immutable; never opened writable
      tape.json                  summary + metadata (NOT the resume authority)
      chunks/
        chunk_000.mp3            kept, ~15 MB/hr total — re-transcription is a button
        chunk_000.gr.json        { text, start, duration, model, cost }
        chunk_001.mp3 ...
      translation.en.json
      flags.json
      transcript.gr.txt / translation.en.txt
```

**The chunk is the unit of everything**: alignment, playback, retry, billing, and resume.
Since MAI gives no intra-chunk timestamps, chunk granularity *is* alignment granularity.

### Normalized transcript — the contract that lets both backends coexist

Every backend normalizes to one shape, so nothing downstream branches on which model ran:

```json
{ "chunk": 3, "start": 187.4, "duration": 74.2,
  "sources": [{ "model": "microsoft/mai-transcribe-1.5", "role": "text", "cost": 0.0074 },
              { "model": "openai/whisper-large-v3",      "role": "timing", "cost": 0.0006 }],
  "hasTimestamps": true, "hasConfidence": true,
  "agreement": 0.91,
  "segments": [
    { "id": "c3s0", "text": "...", "start": 191.2, "end": 196.8, "confidence": -0.31 }
  ] }
```

- **MAI-only:** one segment per client-side sentence split; `start`/`end`/`confidence` are `null`.
- **Whisper-only:** one segment per returned segment, `confidence` mapped from `avg_logprob`.
- **Cross-check:** MAI text, Whisper timing, plus `agreement` (normalized similarity per chunk).

Downstream rule: `seek(seg) → seg.start ?? chunk.start`, and flagging uses `confidence` when
present and falls back to LLM-derived flags when absent. **Every view must render correctly with
all three optional fields null** — that is the single most important invariant to test, and it is
testable with no tapes and no API calls.

### Files to create

Follows the `scheduler/` + `admin/` precedent — self-contained tool, opts out of site chrome
(no Bootstrap, no `header.html`), like `bear.html` and `admin/index.html`.

```
/tapes/
  index.html          app shell, tabbed (mirror admin/index.html)
  app.css
  manifest.json       installable PWA, same pattern as admin/
  js/store.js         folder handle, IndexedDB, atomic writes, directory reconciliation
  js/audio.js         ffmpeg.wasm: silencedetect → cut → encode
  js/api.js           OpenRouter calls, retry/backoff, cost accounting
  js/queue.js         timer-free worker-driven scheduler, Web Locks guard
  js/glossary.js      entity model, matching, prompt injection
  js/ui.js            the five views
  vendor/             ffmpeg.wasm single-threaded core
```

> ⚠️ **Single-threaded `@ffmpeg/core`.** The MT build needs `SharedArrayBuffer`, which requires
> COOP/COEP response headers — **GitHub Pages cannot set headers.** ST is slower (~5–10×
> realtime, so 10–20 min per 90-min tape); irrelevant for an overnight queue, but show it as a
> real stage in the UI, not a blip.

---

## Pipeline

### 1. Prepare — silence-aware chunking (replaces fixed segments + overlap)

The first draft used `-f segment -segment_time 600` with "~5s overlap" and transcript dedupe.
**Both halves were broken:** `-f segment` cannot emit overlapping segments in that invocation,
and even with overlap, two ASR passes over 5s of hissy cassette produce *different* token
sequences — with no timestamps (see Correction) there's no principled cut point, so fuzzy
matching would sometimes duplicate and sometimes **delete a sentence**. Silent data loss at
every boundary across 300 tapes is the worst possible failure shape for a diary.

Replace with two passes:

```
# pass 1 — find pauses
ffmpeg -i in -af silencedetect=noise=-35dB:d=0.6 -f null -
# pass 2 — per chunk, cut at the pause nearest each 60–90s target
ffmpeg -ss <t> -t <d> -i in -ac 1 -ar 16000 -c:a libmp3lame -b:a 32k chunk_NNN.mp3
```

- No mid-word cuts, **no overlap, no dedupe stage at all.**
- Chunks that are entirely silence (leader tape, dead ends of sides) are **skipped, not sent** —
  the cheapest hallucination guard available.
- 60–90s targets: MAI bills **per hour of audio**, so chunk count is nearly cost-neutral;
  smaller chunks buy finer alignment almost free. Don't go below ~60s — ASR loses context.
- `-35dB` needs calibration against tape hiss (the hiss floor may sit above it). Phase 0 tunes it.
- **Accumulate actual chunk durations** for start offsets; never compute `index × target`.

> ⚠️ **Mount the input with WORKERFS**, not `writeFile`. `writeFile` copies the whole file into
> the wasm heap: a 90-min WAV is ~0.9 GB, a 3-hour tape ~1.9 GB — at or past the wasm32 2 GB
> ceiling before ffmpeg's own working memory. `ffmpeg.mount(FFFSType.WORKERFS, {files:[file]}, '/in')`
> reads lazily from disk. Delete each output chunk from MEMFS after reading it out.

**Preprocessing** (A/B'd in Phase 0, not assumed): `highpass=f=80` for rumble/hum,
`dynaudnorm` or `loudnorm` because decades-old recordings vary wildly in level and quiet
passages under hiss are where ASR dies, and *optionally* `afftdn` for broadband hiss — test it,
denoisers sometimes hurt modern ASR. Wow/flutter and speed drift aren't fixable here; they go
in the capture guidance instead (decent deck, clean/demagnetized heads, correct Dolby setting,
capture to WAV and keep it).

### 2. Transcribe

`POST /api/v1/audio/transcriptions`, `model: microsoft/mai-transcribe-1.5`, `language: "el"`,
`response_format: "json"` (**not** `verbose_json` — it 400s). Write `chunk_NNN.gr.json`
immediately. Run a **repetition detector** on the output: the same n-gram looping is Whisper's
classic hallucination signature and a decent garbage check for any model — flag the chunk for
re-listen rather than shipping it into the diary.

### 3. Translate + flag + date — one call, three outputs

Batch **30–50 sentences** (not 100 — id-mapped JSON at that size reliably drops, merges, and
hallucinates ids). Client-side sentence split on Greek punctuation (Latin-like; note `;` is the
Greek question mark). Use structured output where the model supports it through OpenRouter.
System prompt carries the glossary; previous batch's tail carries narrative continuity.

Return per batch: English text, **flags** `[{type: "name"|"garbled"|"uncertain", greek_span,
english_guess}]`, and **spoken dates** with chunk refs. Garbled-Greek detection by an LLM is a
serviceable proxy for the confidence signal we don't have. Three stages for one token cost.

**Validate every input id appears exactly once**; re-request only the missing ids.

### 4. Write outputs, update `tape.json` summary, emit TXT exports.

---

## Resumability

**Files on disk are the ground truth; `tape.json` is a cache, never the authority.** A crash
between "chunk written" and "counter updated" otherwise either double-bills or *silently skips
a chunk*. On resume, **reconcile from a directory listing**: a chunk is done iff its
`.gr.json` exists and parses. Worst case on any crash is re-transcribing one chunk (~$0.01).

Rely on `createWritable()`'s temp-file-and-commit-on-`close()` semantics — always `close()`,
never truncate-then-write.

### Surviving the night

The first draft said the queue "resumes cleanly" but specified nothing that keeps it *running*:

- **System sleep is the actual killer.** A page cannot prevent it except via the **Screen Wake
  Lock API**, which requires the page visible and is released when the tab hides. Add an
  explicit **run mode**: hold a wake lock, tell her to keep the tab foregrounded, lid open,
  plugged in.
- **Background-tab throttling** clamps `setTimeout` to ~1/min (worse under intensive
  throttling). Drive the queue from promise chains off `fetch` completions in a **worker** —
  **never from timers.**
- **Tab discard / browser restart:** Chrome discards background tabs under memory pressure, and
  File System Access re-permission **requires a user gesture** — so the queue *cannot*
  self-resume. Design for it: one prominent **Resume** button on load, and a status line —
  "stopped 3:12 AM after tape 41, $23.80 spent." Morning recovery must be one click.
- **Concurrent tabs** would interleave `tape.json` writes and double-bill. Take a
  `navigator.locks.request('tapes-queue', …)`; second tab goes read-only.

---

## The glossary

### Entity model (flat surface forms don't survive Greek)

Greek is heavily inflected — Κώστας / Κώστα / Κώστᾳ, genitives everywhere in a diary ("του
Κώστα το σπίτι"), vocatives, plus Katharevousa-era orthographic variants. And since ASR biasing
doesn't pass through at all, the glossary's real consumers are the translation prompt and Greek
text-matching for retroactive re-translation.

```json
{ "id": "kostas", "english": "Kostas", "kind": "person",
  "canonical_greek": "Κώστας",
  "observed_forms": ["Κώστας", "Κώστα", "Γκόστα"],
  "notes": "her great-uncle, Athens" }
```

`observed_forms` deliberately captures **ASR manglings**, which is what makes matching converge
despite the lack of biasing. Match retroactively by accent-stripped stem (`Κώστ-`), not exact
string. Instruct the translation model to treat entries as matching any inflected or
phonetically-close form — normalizing "Γκόστα" → Kostas post-ASR, which handles inflection
better than biasing would have anyway.

### Bootstrapping — it's empty exactly when it matters most

After tape 1's transcript exists, run one cheap **NER pass** over the whole Greek transcript,
cluster candidates by stem/phonetics, and present them **frequency-ranked**: "this name occurs
31 times — listen and tell me who it is." Ten answers seed the glossary before tape 2 starts.
Letting flags trickle out of translation leaves it empty through the tapes that need it most.

### Closing the review loop for someone who doesn't read Greek

She hears audio and types **Latin** ("Kostas"); the glossary is keyed on **Greek** she can't
produce, and the Greek at that spot is a different mangling each time. So each flag must carry
the **Greek span the ASR emitted** plus surrounding English context, so her English answer
attaches to that observed form. Add an **LLM unification step** — "is this flagged span the
same entity as an existing entry?" — so she isn't asked about Kostas forty times. Show her the
current guess and nearby occurrences of the same suspected entity, so she **confirms rather
than invents**.

Retroactive re-translation re-runs **only batches containing the changed term**, not whole tapes.

---

## Chronology — this is the product, not a nice-to-have

It's a *dated daily diary*. He almost certainly speaks the date ("Σήμερα, 14 Μαρτίου του '78…").
The date-extraction rides along in the translation call (stage 3) and writes `spoken_dates[]`
and `date_range` into `tape.json`. Then:

- The Read view orders by **date, not tape number**, and flags gaps and overlaps.
- It can discover that side B of tape 12 precedes side A of tape 9.
- Import-time metadata she supplies: tape label text (**tell her to photograph the labels**),
  side A/B, and `continues_from` so a sentence cut by a side flip reads through.

This is the difference between "a pile of transcripts" and "her grandfather's diary."

---

## Views

| View | Purpose |
|---|---|
| **Queue** | Drop files, per-tape/per-chunk progress, running cost, pause/resume/retry, run-mode status |
| **Read** | English diary ordered by date; click a paragraph to play its chunk; search all tapes |
| **Review** | Frequency-ranked name queue: hear the clip, confirm or name it, feed the glossary |
| **Glossary** | Entity list; "re-translate affected batches" |
| **Settings** | API key, model override, spend cap, folder picker |

---

## Cost

- **ASR:** ~$110 for 300 hours (MAI at $0.36/hr). Whisper-via-Groq fallback ≈ $8.
- **Translation:** ~2.4–2.7M spoken words ≈ 5–7M Greek input tokens, plus glossary and
  rolling-context overhead re-sent per batch, plus comparable output. At frontier
  ~$3/$15 per M ≈ **$40–120 per full pass** — and re-translation multiplies passes. The first
  draft's "$50" was optimistic.
- Add OpenRouter's ~5% credit fee.
- Accumulate `usage.cost` per request into `tape.json`; **pause the queue at a spend ceiling.**

## Settings & privacy

- Key in `localStorage.or_key`, mirroring `localStorage.gh_token` in `admin/index.html:170-245`.
  Include a "test key" button.
- **Create a dedicated OpenRouter key with a per-key credit limit** — bounds the risk of a key
  living in someone else's browser to a number he chooses.
- Hidden model override, so a model swap doesn't need a redeploy. MAI-1.5 shipped 2026-06-02
  with a single provider; **keeping the chunk MP3s** (~15 MB/hr) makes full re-transcription
  under a future model a button, not a re-capture.
- **`data_collection: "deny"`** for family material. With a sole provider this *fails closed* —
  if Azure doesn't satisfy the filter you get "no providers available," not a silent downgrade.
  Verify in Phase 0 and make the error message say why.
- **Archival invariants:** never open `source.*` writable; checksum it in `tape.json`; show a
  persistent "your folder is the archive — back it up" nudge. All of this is irreplaceable
  material sitting on one laptop.

---

## Build order

- **Phase 0a — API contract test. Not blocked on tapes; run it now.** Probes 2–6 don't care what
  the audio contains, so any clip settles them: confirm CORS on `/audio/transcriptions`; confirm
  `verbose_json` 400s on MAI; capture the exact plain-`json` response shape; probe whether an
  undocumented `provider.options.azure.*` phrase-list passthrough exists (the model page does
  advertise keyword biasing); confirm MAI still routes under `data_collection: "deny"`; confirm
  Whisper returns `avg_logprob`/`no_speech_prob` and that `provider.options.groq.prompt` measurably
  changes output. **This is the gate that invalidated the first draft.** Built: `tapes/probe.html`.
- **Phase 0b — quality bake-off. Deferred until real tapes exist.** Same capture through both
  models, containing names, a mumbled stretch, and **30s of pure hiss**. Scores word accuracy,
  whether hiss produces hallucinated text, and whether Whisper's confidence fields catch it. This
  sets the *default mode*, not the architecture — the adapter supports all three regardless, so
  nothing downstream waits on it. Also calibrates the silencedetect threshold against tape hiss.
- **Phase 1 — spine.** Folder picker + store with directory reconciliation, silence-aware
  chunking with WORKERFS, transcribe one chunk, write files. Prove the path end-to-end.
- **Phase 2 — pipeline.** Translation/flag/date call with id validation, worker queue, wake lock,
  Web Locks, cost tracking, spend ceiling.
- **Phase 3 — glossary + Review**, incl. NER bootstrap, entity unification, targeted re-translation.
- **Phase 4 — Read view**, date ordering, search, click-to-play-chunk, TXT export.
- **Phase 5 — polish.** PWA manifest; link from the Coding card in `portfolio.html:105-118`
  (matching how `bear.html` and `scheduler/` were added — a tool, not a nav section).

**Dropped:** the Safari download fallback. Per-file prompts across hundreds of tapes and
thousands of artifacts is not a usable path. Declare **desktop Chrome/Edge a requirement** in
Settings; at most ship a read-only export viewer later.

Repo convention is a design doc then an implementation plan under `docs/plans/`; write
`docs/plans/2026-08-24-tape-digitization-design.md` alongside the code.

---

## Testing without tapes

No tapes are in hand, and they may be weeks away. The pipeline must therefore be buildable and
verifiable end-to-end with **zero tapes and zero API spend**. Three mechanisms:

**1. Mock ASR backend.** `?mock=1` makes `api.js` replay recorded fixtures instead of calling out.
Fixtures are real responses captured once by `probe.html` — both models, plus the error cases that
matter: the `verbose_json` 400, a 429, a 500, a truncated body, and an empty transcript. This makes
the whole queue — chunking, stitching, translation, glossary, review, resume, cost accounting —
deterministic, free, and runnable in CI-less manual testing.

**2. Synthetic tapes, generated in pure Python** (no ffmpeg needed locally — WAV is a header plus
PCM). A generator emits fixtures with **known ground truth**:
- speech-like bursts at known offsets separated by known silences, over a tape-hiss floor, with
  drifting levels — gives exact expected chunk boundaries.
- hiss-only and silence-only clips — the hallucination probe.
- a **3-hour** WAV (~950 MB) generated on demand, not committed — this is the WORKERFS memory test,
  and it's the case that actually breaks, not the 90-minute one.

Structural correctness — boundary placement, no words lost at joins, offset accumulation, resume,
Web Locks, spend ceiling, background-tab survival — **does not require speech at all** and is where
most of the risky code lives. It can all be tested from synthetic audio today.

**3. The null-field invariant.** Because MAI-only mode yields `start`/`end`/`confidence` as `null`,
every view must be exercised against a null-field fixture. A mode-switcher in the mock harness
renders the same tape as all three modes, which catches the entire class of "worked because
timestamps happened to exist" bugs before a single real tape is captured.

**What genuinely needs real tapes:** only the accuracy comparison (Phase 0b), the silencedetect
threshold calibration against real hiss, and the final go/no-go on whether the Greek is worth
reading. Everything else ships first.

## Verification

No test framework in this repo — plans here state "manual browser verification":

```
python3 -m http.server 8000     # from repo root
# open http://localhost:8000/tapes/
```

`portfolio.html` uses absolute `https://thiagotvarella.github.io/...` links, which don't resolve
under local preview — use a relative href, or expect that one link to break locally.

Must verify:

1. **Phase 0a contract probes** (now, any audio) and **0b bake-off** (when tapes arrive).
1. **All three modes over one mock tape** — confirm every view renders with `start`, `end`, and
   `confidence` all null. The most important test in this list.
2. **A generated 3-hour WAV** through WORKERFS chunking without exhausting the wasm heap (the
   90-min case is not the hard one).
1. **Synthetic tape with known silence offsets** — confirm chunk boundaries land in the gaps and
   that concatenating chunk transcripts loses no words.
3. **Kill the tab mid-chunk**, resume, and diff billing — confirm at most one chunk is redone
   and none are skipped.
4. **Overnight run, lid open** — confirm the wake lock held and the queue never touched a timer.
5. **Browser restart mid-queue** — confirm one-click Resume re-grants permission and continues.
6. **Two tabs on one folder** — confirm the Web Lock makes the second read-only.
7. **30s of pure hiss** — confirm no hallucinated text reaches the transcript.
8. **A dropped id in a translation batch** — confirm the repair loop catches and re-requests it.
9. **Bad/expired key** and **spend ceiling** produce clear stops, not silent stalls.
10. **Glossary round-trip**: confirm a name, re-translate, confirm it changed everywhere — and
    that only affected batches were re-billed.
11. **The honest go/no-go**: is the real-world Greek good enough to be worth reading?

## Deliverable

Committed and pushed to `claude/tape-digitization-tool-r9uhq6`. No PR unless asked.
