# Tape digitizer: code review findings

**Date:** 2026-08-27. **Reviewed:** `tapes/` at commit `857c1ce`, with the 206-test suite green
and the working tree clean. **Nothing was changed** — this is a to-do list, not a changelog.

Four independent read-only passes: core pipeline (`audio`/`ffmpeg`/`queue`/`record`/`store`/`entry`),
API and language layer (`asr`/`translate`/`glossary`/`library`), UI and security
(`ui.js`/`index.html`/`app.css`/`demo.js`), plus an adversarial pass that wrote *failing* tests
against each module's own documented intent. Every headline claim below was verified against the
real code, and most were reproduced by running it. Suspicions that did not survive checking were
dropped rather than listed.

Two of these can silently lose irreplaceable audio, which this codebase's own comments name as the
worst available failure. Those come first.

---

## Fix before she runs real tapes

### 1. CRITICAL — pausing during splitting silently discards most of the tape, then marks it DONE

`tapes/js/queue.js:240`. Whether splitting already happened is inferred from
`haveAudio = already.filter(n => n.endsWith('.mp3')).length` — the mere presence of *any* chunk
audio. But an interrupted `prepareTape` legitimately leaves partial `.mp3` files behind
(`ffmpeg.js:223` breaks on abort, by design and pinned by a test). On resume, `haveAudio > 0` sends
control to the `else if (!tape.plan)` branch (`queue.js:266`), which loads a `plan` that was never
written, or was written truncated. The queue then transcribes only that truncated plan, finds
nothing pending, and sets `STATE.DONE`.

**Reproduced:** a 600s tape, `pause()` called after ~1 of 8 chunks were cut, then a fresh `Queue`
simulating "Continue after reload" → **450 of 600 seconds silently gone, state DONE**, no error, no
"needs attention", nothing on disk but an orphaned `000.mp3`. Pause is an ordinary button.

This contradicts the module's own stated invariant (`queue.js:14`): "a crash costs at most one chunk
and can never skip one."

*Fix direction:* make split-completion an explicit durable fact — trust `tape.plan` only when
`refreshTapeSummary` wrote it after the loop completed — instead of inferring completion from file
counts.

**Same heuristic, second symptom:** silent chunks never get an `.mp3` (`ffmpeg.js:227`), so a tape
that begins with enough leader tape can show `haveAudio === 0` despite splitting having fully
finished, and re-runs the whole slow single-threaded decode on every resume. Not data-losing, just
wasteful — but it is the same fragile signal.

### 2. CRITICAL — one transient write failure loses the entire recording, not just that slice

`tapes/js/record.js:243-261` (`makeFileSink`). The serialization we added is correct, but the chain
has no rejection recovery: `chain = chain.then(fn)` on an already-rejected promise never runs `fn`
and re-propagates the original error. So after a single failed slice write, **every later slice is
silently never written**, and `close()` (`await chain; await handle.close()`) throws *before*
`handle.close()` — so the File System Access temp file is never committed and **everything recorded
before the failure is lost too**.

`Recorder.ondataavailable` catches each slice error individually (`record.js:187`), so the app keeps
showing levels and elapsed time for the rest of the side while capturing nothing.

**Reproduced:** slice 1 writes 3 bytes, slice 2 fails once, slices 3 and 4 (good data) both throw the
same stale error and never write; `bytes` frozen at 3; `close()` throws and the destination file does
not exist on disk at all.

Directly inverts the stated goal (`record.js:236`): "A crash mid-recording therefore leaves
everything captured up to that moment on disk."

*Fix direction:* contain the failure per slice — keep the chain healthy, record that a slice was
lost, and let `close()` still commit what did land.

### 3. CRITICAL — a truncated-but-200 response marks a chunk done, empty, forever

`tapes/js/asr.js:197-206`. When `res.ok` is true but the body fails to parse, the `catch` is empty,
`json` stays `null`, and `call()` returns `null` with no error. `normalizeMai`/`normalizeWhisper`
turn that into `{ text: '', segments: [] }`, and `store.js:213-223` (`reconcile`) treats any chunk
file with an array `segments` — empty included — as done, so it is never retried.

**Reproduced:** a 200 response with a body truncated mid-JSON resolves to
`{ text: "", segments: [], cost: 0 }`. One network wobble = one slice of the diary permanently blank,
with nothing on disk or in the UI saying so.

*Fix direction:* throw (retryably) on an unparseable 200 body; consider having `reconcile` treat an
empty transcript as suspect rather than finished.

### 4. CRITICAL — cross-check mode can drop a transcript and double-bill off the books

`tapes/js/asr.js:140-181, 253-259`. Two related defects:

- When MAI returns empty for a chunk but Whisper genuinely transcribed speech, the merged result is
  `text: '', segments: []`; Whisper's transcript survives only in `merged.alt.text`, which **nothing
  downstream reads** (no `.alt` references in `entry.js`, `queue.js`, `ui.js`). Combined with #3's
  reconcile behaviour, that content is gone permanently.
- MAI and Whisper run under `Promise.all`. If either rejects, the other's already-billed success is
  discarded and its cost never reaches `cost()`. `queue.js:52` (`withRetry`) then retries the whole
  call, re-billing the model that had already succeeded. Since `this.spent` (`queue.js:221`) only
  counts *returned* results, the spend ceiling never sees any of it.

**Reproduced:** MAI succeeds at `usage.cost 0.01` while Whisper 429s → the call rejects, MAI was
called and billed once, that cost appears nowhere, and the retry calls MAI again.

*Failure scenario:* intermittent Whisper rate-limiting during an overnight run quietly spends past
the cap.

### 5. CRITICAL — unescaped HTML throughout `ui.js`, with the key readable same-origin

There is a correct `escapeText` helper (`ui.js:358`) used in exactly one screen (`renderMedia`,
lines 280-305). Everywhere else, values from untrusted-ish sources go straight into `innerHTML`:

| Site | Unescaped values |
|---|---|
| `ui.js:161-198` `openRead` | `entry.label`, `s.gr`, `s.en`, `s.unsure` — ASR + LLM text off disk |
| `ui.js:397-409` `renderReview` | `n.greek`, `n.guess`, `n.context`, `n.hint` — raw LLM flags |
| `ui.js:524-531` `renderGlossList` | `g.english`, `g.greek`, `g.note` — **persisted**, so stored, re-fires every load |
| `ui.js:544-559`, `580-596` | `value="${...}"` — attribute-context injection |
| `ui.js:117-143` | `t.label`, `t.heading` on cards and banners |
| `ui.js:22-27` `toast`/`el` | itself an `innerHTML` sink, fed labels and corrections raw |
| `ui.js:646-648` | device labels into `<option>` |

**Reproduced live in headless Chromium, two ways:** markup spliced into a segment's `en` (simulating
what a compromised or hallucinating translation model could write to `translation.en.json`) executed
on opening that entry; and typing `" onmouseover="…` into the tape-label field broke out of
`value=""` into a live attribute.

*Honest risk framing:* the realistic "attacker" is a hallucinating model or a stray `<` or `"` in her
own typing, so day to day this mostly means broken rendering. But a payload persisted to
`glossary.json` re-executes on every load, and script on this origin can read
`localStorage.or_key`. There is no CSP.

*Fix direction:* the helper already exists and the author clearly knows the rule — make escaping the
single default path by pulling each `innerHTML` template into a small named render function that can
be unit-tested without a DOM. That closes the whole class and gives `ui.js` its first tests.

---

## Important, next tier

- **Greek stems over-match short prefixes.** `glossary.js:34-44`. Verified: `sameWord('Μαρία','Μάρκος')`,
  `('Μαρία','Μαρίνα')`, `('Μαρία','Μάρθα')`, `('Νίκος','Νικολέτα')` all return `true`; also
  `('καλά','καλαμπόκι')` (good / corn), because a short word is kept whole as its own stem and a
  longer word's truncated stem can start with it. This drives `greekMentions`, `planCorrection`,
  `applySubstitutions` and `buildReviewQueue` clustering: correcting Μαρία can queue a sentence about
  Μάρκος for re-translation with a glossary line asserting the wrong identity — exactly the
  "asserting what it merely inferred" failure the project bans. The suite's one collision test
  (`run-tests.mjs:618`) uses Κώστας vs Ελένη, which share no prefix, so this path is untested.
- **Degenerate spans merge.** `glossary.js:39-44`: the `A === B` branch has no minimum-length guard,
  and `normalizeGreek` can reduce different non-empty inputs (whitespace, punctuation, unrecognised
  script) to `""`, so two unrelated flagged spans from different tapes collapse into one question.
- **Translation has none of transcription's crash discipline.** `queue.js:318-329` has no `withRetry`
  (transcription gets 4 attempts at `queue.js:300`), and `translation.en.json` is written only after
  *all* batches resolve — no per-batch persistence, unlike per-chunk `saveChunkText`. A 429 on batch
  9 of 10 fails the tape, drops the cost of the 8 billed batches from `tape.cost`, and "try again"
  re-bills from batch 1.
- **The spend cap undercounts across a reload.** `queue.js:105-112` persists only
  `{state, progress, error}`; per-chunk cost lives only in each `.gr.json` until `refreshTapeSummary`
  runs, which never happens during the transcribing stage. `ui.js:893` reseeds `spent` from the stale
  `tape.json.cost`, so a crash mid-transcription lets the cap permit more than intended. (Actual
  double-billing of finished chunks is correctly prevented by `pendingChunks` — this is about the
  cap's accuracy only.)
- **A fresh 31MB ffmpeg engine per tape, never terminated.** `ffmpeg.js:185` does
  `engine || new TapeAudio()`, and neither `queue.js:246` nor `ui.js` ever passes one;
  `TapeAudio.terminate()` (`ffmpeg.js:171`) is called only in tests. Each tape spawns a new Worker and
  a new WASM instance, and stale ones accumulate — squarely against the memory budgeting documented
  at the top of that file, at exactly the "hundreds of tapes" scale this is for. One engine per run,
  terminated at the end.
- **`openRead` has no stale-render guard.** `ui.js:157-209`: `state.reading` is set synchronously but
  never checked after `await loadEntry(...)`, which then unconditionally overwrites the box. Open tape
  A, quickly open tape B, and A can land over B — a misattributed diary entry. (`state.reading` is
  written twice and read nowhere; it is the natural token for the check.)
- **`planChunks` silently requires sorted silences.** `audio.js:46-85`: the `break` at line 73 assumes
  ascending midpoints, but only `parseSilenceLog` happens to sort, and the parameter is undocumented.
  Verified: feeding the same pauses reversed makes every chunk miss every pause and fall back to hard
  `maxSec` cuts (`endsAtSilence` 7 → 0) — the mid-sentence cut this module exists to prevent, with no
  error raised.
- **`markSilentChunks` sums overlapping silences instead of unioning them.** `audio.js:112-125`:
  `covered` double-counts when intervals overlap (unlike `longestSpeechRun`, which correctly walks a
  cursor). Verified: duplicating a silence list for identical audio flips `isSilent` false → true
  (fraction 0.96 → 1.92), so real speech is skipped and never sent to a model.
- **Impossible dates roll instead of degrading.** `entry.js:14-27`: `"1978-02-30"` is a valid `Date`
  (rolls to 2 March), so `isNaN` never fires and it renders "Thursday, 2 March 1978" — a wrong real
  date, worse than the raw-iso fallback the function already has for unparseable input. Verified for
  day and month overflow. Related: `translate.js:227` `dateRange()` sorts ISO strings
  lexicographically with no format validation, so an unpadded `"2023-9-01"` sorts after `"2023-10-01"`.
- **`validate()` rejects numeric ids.** `translate.js:129-141` requires `typeof t.id === 'string'`, so
  a model answering `{"id": 1}` is treated as having omitted it: the real translation is discarded, a
  repair round is spent, and a consistent model habit ends as `unresolved` despite being translated
  twice.
- **`undo()` reverts past other corrections.** `glossary.js:135-139`: `enOriginal` is a single
  snapshot (correctly pinned to the true original across repeated corrections — that part is right),
  so undoing correction B on a segment also silently erases unrelated correction A. Latent: nothing
  calls `undo` yet, but it will misbehave the day it is wired up.
- **UI honesty bugs.** `ui.js:443` — "Hear this bit" in the real Glossary toasts "Playing…" and plays
  nothing (only demo mode is honest). `index.html:203` — the Settings "Change folder" button has no
  handler anywhere. `ui.js:902` / `queue.js:390` — `LIMIT REACHED` and `NO CREDIT` violate the file's
  own "errors are sentences, not status codes" rule, and the latter is shown persistently on a card.
  `index.html:131` — "taking roughly as long as the tapes themselves" contradicts the measured
  estimate work and sets the wrong expectation.

---

## Minor, and things to decide

- **The 31MB ffmpeg core loads from unpkg.com at runtime** (`ffmpeg.js:26`); only the wrapper is
  vendored same-origin. Version-pinned, but no integrity check and a live third-party dependency for
  an app meant to run unattended for weeks. Self-hosting the core on Pages is possible — worth a
  conscious decision either way.
- **Key input is `type="text"` on first setup** (`index.html:48`) but `type="password"` in Settings
  (`index.html:211`).
- **The demo never produces the null-field shape.** `demo.js:4-10` always sets `start` and a
  `confidence` of 0.86, but MAI-only mode yields all three null. Today's consumers guard correctly, so
  nothing is broken — but `?demo=1` cannot catch a regression in the invariant the design doc calls
  the most important one.
- `toLatin` collisions (`library.js:104-134`): labels differing only by accent, or only by a stripped
  character like `/` vs `:`, produce identical download names. Probably masked by the browser's `(1)`
  suffixing.
- `formatSize` has no GB tier ("5120 MB"); `formatLength` shows "60 sec" at 59.5-59.99s;
  `translate.js:129` computes an `extra` (hallucinated-id) list nothing reads, so a model inventing
  ids is invisible; `state.spent` (`ui.js:899`) is computed and never displayed; `ffmpeg.js:125`
  `unmount()` clears `mounted` even when the underlying unmount threw.

---

## Verified safe (checked, not assumed)

- The key is only ever sent as an `Authorization` header to hardcoded `openrouter.ai` URLs
  (`asr.js:194`, `translate.js:148`), never logged, never included in thrown errors, and never
  committed — `git log -S "sk-or-"` across all history returns only placeholder UI text.
- The app reaches exactly three hosts: `openrouter.ai`, `fonts.googleapis.com`, `unpkg.com`.
- The id-repair loop (`translate.js:181-197`) terminates (bounded by `maxRepairs`), never loops, and
  never silently drops a segment. Duplicate and hallucinated ids cannot leak into output, because
  final translations are built by mapping over the known batch.
- Null `start`/`end`/`confidence` flow correctly through today's entry and playback paths;
  `collectSegments` substituting `chunk.start` is the documented contract, not an accident.
- `enOriginal` stays pinned to the true original across repeated corrections.
- The no-inference prompt language (`translate.js:74-106`) holds up under adversarial reading:
  explicit "do not extend", "do NOT categorise… person, place", no relationship annotations.
- `planChunks` is float-drift-free and contiguous over ~600 chunks; whole-file silence is handled;
  `padFinalChunk([])` is a safe no-op; `parseSilenceLog` discards `end <= start`; `agreement()`
  handles empty-vs-empty and empty-vs-nonempty sensibly; `greekMentions` matches an observed form
  differing only in case and accent.

---

## Where deeper, focused reviews would pay

1. **The resume seam as its own topic.** Enumerate every stage boundary and ask: if we die *here*,
   what does disk look like, and what does resume conclude? Findings 1, 3 and the spend-cap gap all
   fell out of that single question.
2. **A `ui.js` refactor review.** Split rendering into escaped, testable render functions; move the
   recording flow (`ui.js:619-774`) and the run screen (`776-1000`) into their own modules. That is
   the structural fix behind #5 and the stale-render bug, and it would end `ui.js` being the only
   untested file.
3. **A "money path" review.** Every place `usage.cost` is born, moved, persisted, or reseeded, traced
   against the cap.
4. **The thing no review can do from here:** a live end-to-end pass on a real tape. Still the largest
   untested surface, and Phase 0b (accuracy bake-off, silencedetect calibration against real hiss) is
   still waiting on tapes.

### Test-suite observation

The 206 tests are good and all pass, but they lean toward the *happy differentiator* for each rule —
one correctly-rejected pair, one correctly-accepted pair. Nearly every finding above lives in the
gap: near-miss same-prefix names, a truncated body behind a 200, a second correction on the same
segment, an interrupted stage. Adversarial cases are where the remaining bugs are.

Seven failing tests pinning findings above were written during this review under
`scratchpad/probe/bugs.test.mjs` (ephemeral — they will need re-writing, but each is a few lines and
the assertions are described above).

---

## Appendix: Gemini 3.5 Transcribe (checked 2026-08-27, re-check later)

Google announced it the same day. Relevant on paper: word-level timestamps, speaker attribution,
custom vocabulary (biasing, which MAI does not expose through OpenRouter), 5.04% FLEURS WER
non-streaming, ~$0.005/min ≈ $0.30/hr, and roughly an hour of audio per request. No published Greek
figure.

**Not usable today:** it is not routed by OpenRouter. Verified empirically against the live
transcription endpoint — both `google/gemini-3.5-transcribe` and `google/gemini-3-5-transcribe`
return `400 "Model … does not exist"`, while `microsoft/mai-transcribe-1.5` returns 200 on the same
call. Access is Gemini API / AI Studio / Vertex only, which would mean a second key and a second
provider — against the single-key constraint.

Worth re-probing periodically: if OpenRouter adds it, it would be the first option that gives
timestamps *and* biasing *and* competitive accuracy in one model, which would simplify the
three-mode ASR adapter considerably.
