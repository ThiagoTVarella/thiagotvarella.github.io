# Tape digitizer: status against the code review

**Date:** 2026-09-22. Companion to `2026-08-27-tapes-code-review.md`.

## Fixed since the review

- MAI-Transcribe-2 replaced 1.5: word timestamps from the text model itself, so "accurate
  words, less precise playback" is no longer a trade-off. 1.5 stays as an automatic fallback.
- The cross-check disagreement mark now reaches the diary. It was written to disk and dropped
  on the way to the reading view.
- The glossary is read live during a run, so a name confirmed mid-run reaches the next tape.
- "Hear this bit" on a review card plays the line the flag came from.
- "I'll never know this one" sets a word aside: never asked again, never sent to the
  translator, and can be brought back from the list.
- `undo()` reverses only its own correction; corrections made since survive.
- Two flagged spans that both boil down to nothing are no longer merged.
- Name matching is strict (identical after removing a known Greek ending); resemblance is
  allowed only to ask "Is this the same as Kostas?", never to merge on its own.
- The settings menu is three plain choices, one of them fully local (listening and
  translating on her own computer, no access key needed).

## Still open

The five items under "Fix before she runs real tapes": resume after a pause mid-split, the
recording sink's poisoned promise chain, truncated-but-200 responses, cross-check double
billing, and escaping in `ui.js`. Also the translation stage's missing retry and per-batch
checkpoint, the spend cap across a reload, the per-tape ffmpeg engine, and the stale-render
guard in `openRead`.
