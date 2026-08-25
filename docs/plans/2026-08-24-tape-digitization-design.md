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
- **No hardware required.** A tape can be captured by holding a microphone to the player's
  speaker, so a line-out cable and a USB interface are optional rather than blocking.
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

## Verified live (Aug 2026)

Run against the real API with a capped test key, using Greek speech generated by
`openai/gpt-audio` so the ground truth was known. Total spend: **under $0.10**.

**Every contract assumption held.** `verbose_json` → 400 on MAI. Plain `json` returns
`{text, usage}` — no timestamps, no confidence, exactly as assumed. Azure keyword biasing:
**no effect**, confirming the glossary must work post-ASR. `data_collection: "deny"` **still
routes** to MAI, which had been an open question. Whisper returns `avg_logprob`,
`no_speech_prob` and `compression_ratio` as documented.

**Greek accuracy is excellent, and MAI is better on degraded audio.** On clean speech both
models were word-perfect, names included. On a simulated cassette (hiss, rolled-off top,
level drift) MAI stayed word-perfect while Whisper produced a real error — "Η ημερά είναι
τρίτη" for "Σήμερα είναι Τρίτη". That validates MAI as the default.

**Pure hiss produced empty output from both.** No hallucinated speech.

### Three things the live data changed

1. **The textbook hallucination rule is wrong in both directions.** `no_speech_prob > 0.6 ||
   avg_logprob < -1.0` **over-flags**: a correct 2-second segment reading just "1978." came
   back at −1.134. Requiring both instead **under-flags**: pure hiss came back at
   `no_speech_prob 1.000, avg_logprob 0.000`, so an AND would have missed the only case that
   matters. `isSuspect()` now trusts `no_speech_prob` alone and applies `avg_logprob` only to
   segments of ≥4 words.
2. **Confidence does not catch misrecognition.** Whisper's "Η ημερά είναι τρίτη" scored
   `no_speech 0.000, avg_logprob −0.527` — entirely unflagged. This revises an earlier claim
   in this document: Whisper's confidence catches *hallucination on silence*, **not** confident
   errors. Only **cross-check** surfaced it, since MAI and Whisper disagreed on that chunk.
   This is now the strongest argument for the cross-check default.
3. **WER scoring must normalise numerals**, or Phase 0b will mislead. Both models write
   "14 Μαρτίου 1978" where the speaker says the numbers as words; naive WER scored that
   11.9% against a word-perfect transcript.

**The translation stage works end to end.** Real MAI output → `translateAll()` → clean English,
exact id discipline, the date extracted as `1978-03-14`, and flags typed `word` with **no**
person/place classification. A glossary note ("her grandfather's brother") reached the model and
was **not** repeated in the translation — both prompt guards hold against a real model.

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

### Files

Follows the `scheduler/` + `admin/` precedent — self-contained tool, opts out of site chrome
(no Bootstrap, no `header.html`), like `bear.html` and `admin/index.html`.

```
/tapes/
  index.html        ✅ app shell, five screens
  app.css           ✅ warm archival palette, light + dark
  manifest.json     ✅ installable PWA
  probe.html        ✅ Phase 0a API contract probe (a lab tool for him, not for her)
  js/asr.js         ✅ three-mode adapter, normalized transcript, cross-check
  js/audio.js       ✅ silence-aware chunk planning + ffmpeg argv (pure, testable)
  js/store.js       ✅ folder handle, atomic writes, directory-listing resume
  js/translate.js   ✅ batched translate + flags + dates, id-repair, model A/B
  js/glossary.js    ✅ Greek matching, three-tier corrections, undo
  js/ui.js          ✅ the five screens
  js/demo.js        ✅ invented 1978 content for ?demo=1
  test/run-tests.mjs ✅ 76 tests, no network, no tapes, no key
  js/ffmpeg.js      ✅ WORKERFS mount, per-chunk cut, MEMFS freed as it goes
  js/queue.js       ✅ timer-free loop, wake lock, Web Locks, spend ceiling, resume
  js/entry.js       ✅ join Greek+English+flags from disk, correction sweep, blob URLs
  js/record.js      ✅ capture from a microphone held to the player, level meter, file sink
```

> ⚠️ **Single-threaded `@ffmpeg/core`.** The MT build needs `SharedArrayBuffer`, which requires
> COOP/COEP response headers — **GitHub Pages cannot set headers.** ST is slower (~5–10×
> realtime, so 10–20 min per 90-min tape); acceptable for a long unattended run, but show it
> as a real stage in the UI, not a blip.

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

### Surviving a long run

The first draft said the queue "resumes cleanly" but specified nothing that keeps it *running*:

- **System sleep is the actual killer.** A page cannot prevent it except via the **Screen Wake
  Lock API**, which requires the page visible and is released when the tab hides. Add an
  explicit **run screen**: hold a wake lock and tell her to keep the window open and stop the
  machine sleeping. **Say nothing about time of day** — she may run this overnight or during a
  workday in the background, and "lid" assumes a laptop. The constraint is the same either way.
- **Background-tab throttling** clamps `setTimeout` to ~1/min (worse under intensive
  throttling). Drive the queue from promise chains off `fetch` completions in a **worker** —
  **never from timers.**
- **Tab discard / browser restart:** Chrome discards background tabs under memory pressure, and
  File System Access re-permission **requires a user gesture** — so the queue *cannot*
  self-resume. Design for it: one prominent **Resume** button on load, and a status line —
  "stopped after tape 41, $23.80 spent." Picking it back up must be one click.
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
{ "id": "kostas", "english": "Kostas", "kind": "word",
  "canonical_greek": "Κώστας",
  "observed_forms": ["Κώστας", "Κώστα", "Γκόστα"],
  "note": "" }
```

**`kind` is not an ontology.** It records only whether the tape blurred a single word she
could hear and spell back (`word`) or a longer stretch (`phrase`) — the shape of the audio
problem, nothing about the world. The app never claims something is a person or a place:
Κώστας may be a man, a boat, or a name day; Καλαμάτα may be a city or the olives, and
nothing in the audio settles it. The translation prompt is explicitly forbidden from
categorising. `note` is free text she writes, or stays empty — never inferred.

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

### What a correction actually costs

She will fix names *after* tapes are already translated, so the cost of a correction is a
load-bearing design question. The answer is that it is almost always **free**, and it
**never re-transcribes**.

Transcription is the expensive, irreversible pass. A glossary fix changes how a word is
rendered *in English* — it changes no Greek character on disk, so the transcript stays
valid forever. (In the default mode ASR biasing does not reach the model at all, so
re-transcribing would change nothing anyway. Offered only as a rare, explicit,
per-tape action, never automatically.)

Three tiers, decided without calling any model:

| Tier | When | Cost |
|---|---|---|
| **0 — nothing** | She confirms the existing guess. The entry is recorded so future tapes match. | free |
| **1 — substitute** | The rendering changes and the old one appears verbatim. Whole-word swap on disk. | free, instant |
| **2 — re-translate** | The Greek mentions the term but the English lost it — the model read the mangled name as an ordinary word ("Γκόστα" → "the cost"). A blind swap would leave a broken sentence. | ~$0.0002 **per sentence** |

Tier 1 covers the overwhelming majority. Tier 2 touches a handful of *sentences* — never a
batch, never a tape. The first draft's "re-translate affected batches" was already 40× too
coarse.

Scoping is by Greek matching, not by scanning English: accent-folded stem comparison
catches inflection (Κώστας/Κώστα/Κώστᾳ), and `observed_forms` catches ASR manglings, which
differ at the *front* of the word and so can never be caught by stemming.

Corrections are **batched** — answering ten names is one sweep over the files, not ten —
and a segment queued for re-translation is never also substituted in the same sweep.

Every substitution preserves the model's original wording in `enOriginal` (the *true*
original, not an intermediate, across repeated corrections) with an audit entry, so a bad
correction is reversible. This is irreplaceable material; a silent wrong edit is the worst
failure available.

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

Built. Named for what she is doing, never for what the machine is doing.

| Screen | Purpose |
|---|---|
| **Diary** | Entries ordered by the date *he speaks*, not tape number; tapes with no date found say so rather than being silently misfiled |
| *(reading)* | The payoff, so it gets the most care: serif, wide leading, narrow measure. Click any line to hear him say it. Unclear passages shaded softly, never alarmingly |
| **Glossary** | "Needs your ear" queue above, confirmed entries below — one place, not a task list with no visible output |
| **Add** | Drop files, name the tape, nudge to photograph the label first |
| **Settings** | Key, folder, quality (**Best / Faster** — never model names), spend cap |
| *(run screen)* | Shown while it works: progress ring, honest time remaining, dismissible |

### What the interface never asserts

Three separate corrections in review all turned out to be the same bug — **the tool stating
something it had merely inferred** — so it is a standing rule, not three fixes:

- **No relationships.** The glossary once read "Eleni · his wife". Nothing on the tape
  established that. A plausible invented detail in a family archive is worse than a blank,
  because nobody thinks to check it. Notes are free text *she* writes, or empty.
- **No categories.** "Person" / "Place" chips were the model's guesses shown as fact, and not
  safe ones: Κώστας may be a man, a boat, or a name day; Καλαμάτα may be a city or the olives.
  `kind` now records only `word` vs `phrase` — the shape of the audio problem, which is
  mechanical and checkable.
- **No time of day.** The run screen assumed overnight, and "lid up" assumed a laptop.

The translation prompt is where this must actually be enforced, not the UI: it is explicitly
forbidden from categorising or annotating relationships. Her notes reach it as
`she says: …`, framed as family-stated fact — usable to resolve ambiguity, **not** to be
repeated in the translation and **not** to be extended to anyone else.

> Lesson worth keeping: the UI change alone did not fix any of these. Each survived in the
> prompt, and one (`e.note` vs `e.notes`) meant her input reached the model not at all. Fixing
> the display is not fixing the behaviour.

---

## Cost

- **ASR:** ~$110 for 300 hours (MAI at $0.36/hr). Whisper-via-Groq fallback ≈ $8.
- **Translation:** `google/gemini-3.7-flash`, chosen on **Greek-specific evidence**, not price.
  On **GreekMMLU** (ACL 2026 Findings; 21,805 native-Greek questions, 80+ models) Gemini 3
  Flash scores **93.16%**, ahead of GPT-5.2 (87.75%) and GPT-4o (86.81%) — a Flash-tier model
  beating every flagship on Greek. **GreekBarBench** agrees independently: Gemini-2.5-Flash 8.4
  > GPT-4.1 8.32 > Claude-3.7-Sonnet 7.71 (human expert 7.78). Claude was absent from
  GreekMMLU, so it is *unevidenced* on Greek rather than proven worse. Kimi K3 is **more**
  expensive than Sonnet 5 ($2.80/$14) with no Greek evidence, so it is not a budget option.
  At $0.375/M in and $1.875/M out this is **≈ $13 per full pass** vs ~$70 for the GPT/Claude tier.
  **Caveat:** both benchmarks measure *comprehension of clean Greek*, while this task is
  *generation into English from ASR-garbled Greek* — which no public benchmark covers. Hence
  `compareModels()`: because the Greek transcripts are stored, re-translating one tape under
  several models costs cents, and the verdict is **English prose, which she can judge herself.**
  That converts an unanswerable benchmark question into a five-minute human decision.
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

## Build order — status

- ✅ **Phase 0a — API contract test.** Built as `tapes/probe.html`. Not blocked on tapes: any
  Greek clip settles it. Confirms CORS, that `verbose_json` 400s on MAI, the real plain-`json`
  shape, whether an undocumented Azure biasing passthrough exists, that MAI still routes under
  `data_collection: "deny"`, and that Whisper returns the confidence fields. Exports
  `fixtures.json` for the mock backend. **Optional now** — its job was picking a model, and
  building both backends removed that decision.
- ⬜ **Phase 0b — quality bake-off.** Needs real tapes. Sets the *default mode*, not the
  architecture. Also calibrates the silencedetect threshold against real hiss.
- ✅ **Phase 1 — spine (logic).** `store.js`, `audio.js`, `asr.js` with 42 tests. Chunk planning,
  directory-listing resume, three-mode ASR normalization.
- ✅ **Phase 2a — translation.** `translate.js`: batched, id-validated with targeted repair,
  flags and spoken dates in the same call, model A/B.
- ✅ **Phase 3 — glossary.** `glossary.js`: Greek stem + observed-form matching, three-tier
  corrections, batching, undo.
- ✅ **Phase 4 — interface.** All five screens, demo mode, warm archival design, light + dark.
- ✅ **Phase 2b — the engine.** `ffmpeg.js` + `queue.js`, wired to `Add → Start`. The library
  now loads from her folder on reload.
- ✅ **Phase 5a — reading a real tape.** `entry.js`; playback reads blobs from her folder;
  glossary confirmations rewrite the English on disk.
- ⬜ **Phase 5b — polish.** Search across entries, TXT export, link from the Coding card in
  `portfolio.html:105-118`.

**Dropped:** the Safari download fallback. Per-file prompts across hundreds of tapes and
thousands of artifacts is not a usable path. Desktop Chrome/Edge is a stated requirement.

---

## Next phase: make a real tape readable

### Context

The engine runs and the interface looks finished, but **a real processed tape cannot actually
be read**. Reading `tapes/js/ui.js` closely turned up two defects that are not "not wired yet" —
they cannot work as written:

1. **`openRead()` renders `tape.segments`**, which only `demo.js` ever populates.
   `refreshLibrary()` sets `segments: []` for every real tape, so opening one shows an empty
   entry. Nothing joins the per-chunk Greek on disk to the translated English.
2. **`playFrom()` builds a URL**: `` `./tapes/${tape.id}/chunks/000.mp3` ``. That is a *web*
   path, but the audio lives in **her chosen folder**, reachable only through File System
   Access handles — it has no URL and is not under the site root. This can never resolve. It
   also reads `s.chunkStart`, which nothing sets.

Both are the same root cause: the reading path was built against demo data and never against
the store. Third, `commit()` in the glossary only pushes to `state.glossary` in memory —
`glossary.js` is fully built and tested but **nothing calls it**, so a confirmed name changes
no English on disk.

### 1. `tapes/js/entry.js` — assemble an entry from disk

New module. One function does the join that `openRead` needs:

```js
loadEntry(store, tapeId) -> { id, label, heading, date, segments: [
  { id, gr, en, chunk, start, confidence, unsure, unresolved }
] }
```

- Reuse **`collectSegments()`** from `js/queue.js` — it already walks `plan` and reads each
  `chunks/NNN.gr.json`, returning `{id, text, chunk, start, confidence}`.
- Join `translation.en.json` by segment `id`; join `flags.json` to set `unsure` (the flag's
  `guess` string, which `openRead` already highlights).
- `heading` from `tape.json.dates` via **`dateRange()`** in `js/translate.js`; fall back to
  "Undated entry", which `openRead` already handles.
- A translation entry with `en: null` (the `unresolved` case the queue already reports) must
  render the **Greek** with a marker, never an empty paragraph — a blank line would read as
  though he said nothing.

`openRead` becomes async and calls this; the demo path stays as-is so `?demo=1` keeps working.

### 2. Playback through the store, not URLs

Replace the URL construction in `playFrom()`:

- `store.readBlob(paths.chunkAudio(tapeId, seg.chunk))` → `URL.createObjectURL(blob)`.
- Seek to `seg.start - chunkStart`, taking `chunkStart` from `tape.plan[seg.chunk].start`
  (the field `s.chunkStart` was never populated; drop it).
- **Revoke the previous object URL on every play.** Chunks are ~1.5 MB and she may click
  dozens of lines; unrevoked blobs leak until reload.
- When `hasTimestamps` is false (MAI-only mode) `seg.start` is `null` — fall back to the chunk
  start, which is the documented `seek(seg) → seg.start ?? chunk.start` rule.
- The glossary card's **"Hear this bit"** uses the same helper, seeking to the flag's segment.

### 3. Wire glossary corrections to `glossary.js`

`commit()` currently updates memory only. It should:

1. Write `glossary.json`.
2. For each tape, load its segments (via `entry.js`), call **`planCorrection()`**, then
   **`applySubstitutions()`**, and write the amended `translation.en.json` back.
3. Collect the tier-2 `retranslate` list and re-run **only those segments** through
   `translateAll()`.
4. Append the returned `audit` entry to `corrections.json` so **`undo()`** stays usable.
5. Report with **`describePlan()`** — already written to say "updated in 3 places, 1 sentence
   re-read" and never to mention re-transcribing.

Replace the current unconditional toast ("now fixed everywhere") with the real plan summary:
today it claims work it does not do.

Corrections must **batch** (`mergePlans()`) rather than sweeping every tape per answer.

### 4. Polish

Search across entries, TXT export via `paths.transcriptTxt` / `paths.translationTxt`, and a
link from the Coding card in `portfolio.html:105-118` (use a **relative** href — the existing
entries are absolute `https://thiagotvarella.github.io/...` and break under local preview).

### Verification

Everything below runs with **no tapes, no key, no network**:

```
node tapes/test/run-tests.mjs      # currently 99 passing
python3 -m http.server 8000        # then /tapes/?demo=1
```

New tests to add:

1. `loadEntry` joins Greek, English, and flags by id — and renders Greek with a marker where
   `en` is null, rather than an empty paragraph.
2. `loadEntry` on a tape that is transcribed but not yet translated returns Greek segments
   rather than throwing.
3. Playback resolves `seg.start ?? chunk.start`, so MAI-only mode (all timestamps null) still
   seeks somewhere valid.
4. A confirmed name rewrites `translation.en.json` on disk, appends an audit entry, and
   `undo()` restores the model's original wording.
5. Answering several names produces **one** merged sweep, not one per answer.
6. Object URLs are revoked — assert the previous URL is released before a new one is created.

Then, still un-run and the real risk: **one live pass** on any audio file with a real key.
Nothing has yet met ffmpeg.wasm, WORKERFS, or an actual OpenRouter response.

### Known gaps, deliberately left

- **Skip never retires anything.** A word she genuinely cannot identify will resurface forever.
  Needs a real "I'll never know this one", but the right shape depends on how often it happens.
- **The run screen is dark**, designed when it was assumed to run overnight. In daylight next
  to the paper-coloured app it may read as jarring rather than calm.
- **`compareModels()` has no UI.** Deliberate: it is a tuning tool for him, not something she
  should ever see.

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

1. ✅ **76 automated tests** — `node tapes/test/run-tests.mjs`. No network, no tapes, no key.
1. **Phase 0a contract probes** (any audio) and **0b bake-off** (when tapes arrive).
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
