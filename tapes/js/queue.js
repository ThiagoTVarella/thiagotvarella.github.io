// The queue: what actually drives a recording from an audio file to a readable entry.
//
// It has to survive being left alone for hours, so the design is shaped by four browser
// facts rather than by taste:
//
//  * setTimeout is clamped to ~1/min in a background tab, so the loop must NEVER advance
//    on a timer. It advances on the completion of real work -- an ffmpeg cut, a fetch --
//    which is not throttled. The only deliberate wait is retry backoff, where being
//    stretched is harmless and arguably correct.
//  * A page cannot stop the machine sleeping except via a Screen Wake Lock, which needs
//    the page visible and is dropped when the tab hides. It must be re-taken on return.
//  * Two tabs on one folder would interleave writes and double-bill. Web Locks makes the
//    second one read-only.
//  * Every stage writes to disk before the next begins, and progress is re-derived from
//    the directory listing, so a crash costs at most one chunk and can never skip one.

import { transcribeChunk, MODES } from './asr.js';
import { translateAll, DEFAULT_MODEL } from './translate.js';
import { prepareTape } from './ffmpeg.js';
import * as store from './store.js';

export const STATE = {
  QUEUED: 'queued', PREPARING: 'preparing', READING: 'reading',
  TRANSLATING: 'translating', DONE: 'done', PAUSED: 'paused', FAILED: 'failed'
};

const LOCK = 'tapes-queue';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retryable failures get four attempts over ~30s. A tab throttled mid-backoff simply waits
// longer, which is fine -- unlike the main loop, nothing is starved by that.
async function withRetry(fn, { tries = 4, base = 2000, onRetry } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!e.retryable || i === tries - 1) throw e;
      onRetry?.(e, i + 1);
      await sleep(base * Math.pow(2, i));
    }
  }
  throw last;
}

export class Queue {
  constructor(opts = {}) {
    this.store = opts.store;
    this.key = opts.key;
    this.mode = opts.mode || MODES.CROSS;
    this.model = opts.model || DEFAULT_MODEL;
    this.spendCap = opts.spendCap ?? Infinity;
    this.glossary = opts.glossary || [];
    this.on = opts.on || {};
    // Injectable so the whole queue is testable with no wasm, no network, no key.
    this.deps = {
      prepare: prepareTape, transcribe: transcribeChunk, translate: translateAll,
      ...(opts.deps || {})
    };
    this.tapes = [];
    this.spent = opts.spent || 0;
    this.running = false;
    this.paused = false;
    this.readOnly = false;
    this._wakeLock = null;
    this._lockRelease = null;
    this._abort = { aborted: false };
  }

  add(tape) {
    this.tapes.push({ ...tape, state: tape.state || STATE.QUEUED, cost: tape.cost || 0 });
    this.on.change?.(this.tapes);
  }

  emit(name, ...a) { this.on[name]?.(...a); }

  // --- keeping the machine awake -----------------------------------------

  async #takeWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener?.('release', () => { this._wakeLock = null; });
    } catch (e) { /* denied or not visible; the run continues regardless */ }
  }
  #watchVisibility() {
    if (this._visHandler) return;
    // The lock is dropped whenever the tab hides, so it must be re-taken on return or a
    // long run silently loses its only defence against the machine sleeping.
    this._visHandler = () => {
      if (document.visibilityState === 'visible' && this.running && !this._wakeLock) {
        this.#takeWakeLock();
      }
    };
    document.addEventListener('visibilitychange', this._visHandler);
  }
  async #releaseWakeLock() {
    try { await this._wakeLock?.release(); } catch (e) {}
    this._wakeLock = null;
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
  }

  // --- one writer only ----------------------------------------------------

  async #claimWriter() {
    if (!navigator.locks) return true;
    return new Promise(resolve => {
      navigator.locks.request(LOCK, { ifAvailable: true }, lock => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        // Hold it for the lifetime of the run.
        return new Promise(release => { this._lockRelease = release; });
      });
    });
  }

  // --- the run ------------------------------------------------------------

  async start() {
    if (this.running) return;
    if (!(await this.#claimWriter())) {
      this.readOnly = true;
      this.emit('readOnly');
      return;
    }
    this.running = true;
    this.paused = false;
    this._abort = { aborted: false };
    await this.#takeWakeLock();
    this.#watchVisibility();
    this.emit('start');

    try {
      // No timers: the loop advances only when real work finishes.
      for (const tape of this.tapes) {
        if (this._abort.aborted || this.paused) break;
        if (tape.state === STATE.DONE) continue;
        try {
          await this.#runTape(tape);
        } catch (e) {
          tape.state = STATE.FAILED;
          tape.error = humanError(e);
          this.emit('error', tape, tape.error);
          this.emit('change', this.tapes);
        }
      }
    } finally {
      this.running = false;
      await this.#releaseWakeLock();
      this._lockRelease?.();
      this._lockRelease = null;
      this.emit('stop');
    }
  }

  pause() { this.paused = true; this._abort.aborted = true; this.emit('pause'); }
  async resume() { this.paused = false; await this.start(); }

  #checkSpend() {
    if (this.spent >= this.spendCap) {
      this.paused = true;
      this._abort.aborted = true;
      this.emit('capped', this.spent, this.spendCap);
      return false;
    }
    return true;
  }

  #charge(amount, tape) {
    this.spent += amount || 0;
    tape.cost = (tape.cost || 0) + (amount || 0);
    this.emit('spend', this.spent);
  }

  async #runTape(tape) {
    const S = this.store;

    // 1. Split into chunks, unless disk says it is already done.
    const already = await S.list(store.paths.chunkDir(tape.id));
    const haveAudio = already.filter(n => n.endsWith('.mp3')).length;
    if (!haveAudio) {
      tape.state = STATE.PREPARING;
      this.emit('change', this.tapes);
      const res = await this.deps.prepare(tape.file, {
        signal: this._abort,
        onStage: s => this.emit('stage', tape, s),
        onProgress: (a, b) => this.emit('progress', tape, a / b * 0.25),
        onChunk: async (chunk, bytes) => {
          await S.write(store.paths.chunkAudio(tape.id, chunk.index), bytes);
        }
      });
      tape.duration = res.duration;
      tape.plan = res.chunks.map(c => ({ start: c.start, duration: c.duration,
                                         isSilent: !!c.isSilent }));
      await store.refreshTapeSummary(S, tape.id, { duration: res.duration, plan: tape.plan });
    } else if (!tape.plan) {
      const saved = await S.readJSON(store.paths.tape(tape.id)).catch(() => ({}));
      tape.plan = saved.plan || [];
      tape.duration = saved.duration;
    }

    // 2. Transcribe whatever disk says is still missing.
    tape.state = STATE.READING;
    this.emit('change', this.tapes);
    const pending = await store.pendingChunks(S, tape.id, tape.plan || []);
    const total = (tape.plan || []).length || 1;

    for (const chunk of pending) {
      if (this._abort.aborted || this.paused) return;
      if (!this.#checkSpend()) return;

      // Pure silence never reaches a model. asr.transcribeChunk guards this too, but the
      // guarantee must not depend on a collaborator honouring a contract -- this is the
      // single cheapest defence against hallucinated speech, and against paying for it.
      if (chunk.isSilent) {
        await store.saveChunkText(S, tape.id, {
          chunk: chunk.index, start: chunk.start, duration: chunk.duration,
          hasTimestamps: false, hasConfidence: false,
          skipped: 'silent', text: '', segments: [], cost: 0
        });
        this.emit('progress', tape, 0.25 + ((total - pending.length + pending.indexOf(chunk) + 1) / total) * 0.6);
        continue;
      }

      const blob = await S.readBlob?.(store.paths.chunkAudio(tape.id, chunk.index));
      const b64 = blob ? await toBase64(blob)
                       : await S.read(store.paths.chunkAudio(tape.id, chunk.index));
      const result = await withRetry(
        () => this.deps.transcribe(chunk, {
          mode: this.mode, key: this.key, b64, glossary: glossaryTerms(this.glossary)
        }),
        { onRetry: (e, n) => this.emit('retry', tape, humanError(e), n) });

      await store.saveChunkText(S, tape.id, result);
      this.#charge(result.cost, tape);
      const done = total - pending.length + pending.indexOf(chunk) + 1;
      this.emit('progress', tape, 0.25 + (done / total) * 0.6);
    }

    // 3. Translate, unless it is already written.
    if (!(await S.exists(store.paths.translation(tape.id)))) {
      if (!this.#checkSpend()) return;
      tape.state = STATE.TRANSLATING;
      this.emit('change', this.tapes);

      const segments = await collectSegments(S, tape.id, tape.plan || []);
      const out = await this.deps.translate(segments, {
        key: this.key, model: this.model, glossary: this.glossary,
        onProgress: (a, b) => this.emit('progress', tape, 0.85 + (a / b) * 0.15)
      });
      this.#charge(out.cost, tape);

      await S.writeJSON(store.paths.translation(tape.id), {
        translations: out.translations, unresolved: out.unresolved });
      await S.writeJSON(store.paths.flags(tape.id), out.flags);
      tape.dates = out.dates;
      if (out.unresolved.length) this.emit('unresolved', tape, out.unresolved);
    }

    tape.state = STATE.DONE;
    await store.refreshTapeSummary(this.store, tape.id, { state: STATE.DONE, dates: tape.dates });
    this.emit('progress', tape, 1);
    this.emit('done', tape);
    this.emit('change', this.tapes);
  }
}

// --- helpers ---------------------------------------------------------------

export async function collectSegments(S, tapeId, plan) {
  const out = [];
  for (let i = 0; i < plan.length; i++) {
    try {
      const c = await S.readJSON(store.paths.chunkText(tapeId, i));
      for (const seg of (c.segments || [])) {
        out.push({ id: seg.id, text: seg.text, chunk: i,
                   start: seg.start ?? c.start, confidence: seg.confidence ?? null });
      }
    } catch (e) { /* a chunk that never transcribed simply contributes nothing */ }
  }
  return out;
}

// Whisper's bias prompt caps at 224 tokens, so send the most-heard terms first.
export function glossaryTerms(glossary) {
  return [...(glossary || [])]
    .sort((a, b) => (b.heard || 0) - (a.heard || 0))
    .map(g => g.canonical_greek || g.greek)
    .filter(Boolean);
}

async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Nothing she reads should ever be an HTTP status.
export function humanError(e) {
  const m = String(e?.message || e || '');
  if (e?.status === 401 || e?.status === 403) return 'That access key was refused. Check Settings.';
  if (e?.status === 429) return "The service is busy — I'll try again in a moment.";
  if (e?.status >= 500) return "The service had a problem — I'll try again in a moment.";
  if (/NetworkError|Failed to fetch|network/i.test(m)) return "Couldn't reach the internet — I'll retry.";
  if (/how long/i.test(m)) return m;
  if (/quota|insufficient|credit/i.test(m)) return 'The allowance ran out and needs renewing. (NO-CREDIT)';
  return 'Something went wrong reading this recording. It can be tried again.';
}
