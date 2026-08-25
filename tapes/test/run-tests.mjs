// Test suite for the tape digitizer. Runs with plain node, no framework, no network,
// no tapes, no API spend:  node tapes/test/run-tests.mjs
//
// The repo has no test tooling, so this is deliberately dependency-free.

import * as audio from '../js/audio.js';
import * as asr from '../js/asr.js';
import * as store from '../js/store.js';

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push('  ok   ' + name); }
  catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + e.message); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg || 'not equal') + `\n         got:      ${A}\n         expected: ${B}`);
}
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy'); }
function close(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps ?? 1e-6)) throw new Error(`${msg || 'not close'}: ${a} vs ${b}`);
}

// ---------------------------------------------------------------- audio.js

const LOG = `
[silencedetect @ 0x1] silence_start: 10.0
[silencedetect @ 0x1] silence_end: 12.0 | silence_duration: 2.0
[silencedetect @ 0x1] silence_start: 80.5
[silencedetect @ 0x1] silence_end: 82.5 | silence_duration: 2.0
[silencedetect @ 0x1] silence_start: 155.0
`;

t('parseSilenceLog reads start/end pairs', () => {
  const s = audio.parseSilenceLog(LOG, 160);
  eq(s.length, 3);
  eq(s[0], { start: 10, end: 12 });
});

t('parseSilenceLog closes a trailing silence at end-of-file', () => {
  const s = audio.parseSilenceLog(LOG, 160);
  eq(s[2], { start: 155, end: 160 }, 'unterminated silence should run to EOF');
});

t('parseSilenceLog ignores a trailing silence with unknown duration', () => {
  eq(audio.parseSilenceLog(LOG, null).length, 2);
});

t('parseSilenceLog tolerates empty input', () => eq(audio.parseSilenceLog('', 10), []));

// The invariant that matters most: chunks must tile the recording with no gaps and no
// overlaps. A gap is silently lost diary content.
function assertContiguous(chunks, total) {
  ok(chunks.length > 0, 'expected chunks');
  close(chunks[0].start, 0, 1e-6, 'must start at 0');
  for (let i = 1; i < chunks.length; i++) {
    close(chunks[i].start, chunks[i - 1].start + chunks[i - 1].duration, 1e-3,
          `gap or overlap at chunk ${i}`);
  }
  const last = chunks[chunks.length - 1];
  close(last.start + last.duration, total, 1e-3, 'must cover the full recording');
  for (const c of chunks) ok(c.duration > 0, 'zero-length chunk');
}

t('planChunks tiles the recording with no gaps (with silences)', () => {
  const sil = [];
  for (let x = 70; x < 3600; x += 70) sil.push({ start: x, end: x + 1.2 });
  const c = audio.planChunks(sil, 3600);
  assertContiguous(c, 3600);
});

t('planChunks tiles the recording with no gaps (no silences at all)', () => {
  const c = audio.planChunks([], 3600);
  assertContiguous(c, 3600);
  ok(c.every(x => x.duration <= audio.DEFAULTS.maxSec + 1e-3), 'must respect maxSec');
});

t('planChunks prefers cutting inside a pause', () => {
  const sil = [];
  for (let x = 74; x < 600; x += 74) sil.push({ start: x, end: x + 2 });
  const c = audio.planChunks(sil, 600);
  const cut = c.slice(0, -1);
  ok(cut.length > 0 && cut.every(x => x.endsAtSilence), 'every interior cut should land in a pause');
});

t('planChunks respects minSec (no runt chunks before the tail)', () => {
  // Pauses every 5s would tempt a naive planner into tiny chunks.
  const sil = [];
  for (let x = 5; x < 600; x += 5) sil.push({ start: x, end: x + 0.8 });
  const c = audio.planChunks(sil, 600);
  ok(c.slice(0, -1).every(x => x.duration >= audio.DEFAULTS.minSec - 1e-3),
     'interior chunk shorter than minSec: ' + JSON.stringify(c.map(x => x.duration)));
});

t('planChunks handles a recording shorter than one chunk', () => {
  const c = audio.planChunks([], 30);
  eq(c.length, 1);
  assertContiguous(c, 30);
});

t('planChunks handles a 3-hour recording', () => {
  const total = 3 * 3600;
  const sil = [];
  for (let x = 72; x < total; x += 72) sil.push({ start: x, end: x + 1 });
  const c = audio.planChunks(sil, total);
  assertContiguous(c, total);
  ok(c.length > 100, 'expected many chunks, got ' + c.length);
});

t('planChunks returns nothing for empty or invalid input', () => {
  eq(audio.planChunks([], 0), []);
  eq(audio.planChunks([], -5), []);
});

t('markSilentChunks flags all-silence chunks and spares speech', () => {
  const chunks = [{ start: 0, duration: 60 }, { start: 60, duration: 60 }];
  const sil = [{ start: 60, end: 120 }];              // second chunk is pure silence
  const m = audio.markSilentChunks(chunks, sil);
  eq(m[0].isSilent, false);
  eq(m[1].isSilent, true, 'leader tape / dead air must be skipped, not sent to a model');
});

t('chunkArgs builds a correct ffmpeg invocation', () => {
  const a = audio.chunkArgs('/in/x.wav', { start: 12.5, duration: 70 }, 'c1.mp3');
  ok(a.includes('-ss') && a[a.indexOf('-ss') + 1] === '12.500', 'seek position');
  ok(a.includes('16000') && a.includes('32k'), 'mono 16k 32kbps for a small upload');
  ok(a.join(' ').includes('highpass=f=80'), 'rumble filter');
});

// ------------------------------------------------------------------ asr.js

t('splitGreekSentences handles Greek punctuation', () => {
  // ';' is the Greek question mark; '·' is the ano teleia.
  const s = asr.splitGreekSentences('Καλημέρα. Τι κάνεις; Καλά· ευχαριστώ.');
  eq(s.length, 4);
  eq(s[1], 'Τι κάνεις;');
});

t('splitGreekSentences never loses trailing text', () => {
  const s = asr.splitGreekSentences('Πρώτη. Δεύτερη χωρίς τελεία');
  eq(s[1], 'Δεύτερη χωρίς τελεία');
});

t('splitGreekSentences returns [] for empty input', () => eq(asr.splitGreekSentences('  '), []));

t('agreement scores identical text as 1 and disjoint as 0', () => {
  eq(asr.agreement('ένα δύο τρία', 'ένα δύο τρία'), 1);
  eq(asr.agreement('ένα δύο', 'χχχ ψψψ'), 0);
});

t('agreement ignores accents and punctuation', () => {
  eq(asr.agreement('Καλημέρα, Κώστα.', 'καλημερα Κωστα'), 1);
});

t('agreement detects partial drift', () => {
  const a = asr.agreement('ένα δύο τρία τέσσερα', 'ένα δύο τρία πέντε');
  ok(a > 0.6 && a < 1, 'expected partial similarity, got ' + a);
});

const CHUNK = { index: 3, start: 187.4, duration: 74.2 };
const MAI_RES = { text: 'Σήμερα είναι Τρίτη. Πήγα στην Αθήνα.', usage: { cost: 0.0074 } };
const WHISPER_RES = {
  text: 'Σήμερα είναι Τρίτη. Πήγα στην Αθήνα.',
  segments: [
    { start: 0.0, end: 3.8, text: 'Σήμερα είναι Τρίτη.', avg_logprob: -0.31, no_speech_prob: 0.01 },
    { start: 3.8, end: 9.2, text: 'Πήγα στην Αθήνα.',   avg_logprob: -1.4,  no_speech_prob: 0.9 }
  ],
  usage: { cost: 0.0006 }
};

t('normalizeMai yields null timestamps and confidence', () => {
  const n = asr.normalizeMai(MAI_RES, CHUNK);
  eq(n.hasTimestamps, false);
  eq(n.hasConfidence, false);
  eq(n.segments.length, 2);
  eq(n.segments.map(s => [s.start, s.end, s.confidence]), [[null,null,null],[null,null,null]]);
});

t('normalizeWhisper shifts times onto the absolute tape timeline', () => {
  const n = asr.normalizeWhisper(WHISPER_RES, CHUNK);
  close(n.segments[0].start, 187.4, 1e-6, 'chunk-relative times must be offset by chunk start');
  close(n.segments[1].end, 187.4 + 9.2, 1e-6);
});

t('normalizeWhisper flags hallucination-suspect segments', () => {
  const n = asr.normalizeWhisper(WHISPER_RES, CHUNK);
  eq(n.segments[0].suspect, false);
  eq(n.segments[1].suspect, true, 'no_speech_prob 0.9 / avg_logprob -1.4 must be flagged');
});

t('normalizeWhisper degrades gracefully when segments are missing', () => {
  const n = asr.normalizeWhisper({ text: 'κάτι' }, CHUNK);
  eq(n.hasTimestamps, false);
  ok(n.segments.length >= 1);
});

t('crossCheck keeps MAI words but gains Whisper timing', () => {
  const c = asr.crossCheck(asr.normalizeMai(MAI_RES, CHUNK),
                           asr.normalizeWhisper(WHISPER_RES, CHUNK), CHUNK);
  eq(c.text, MAI_RES.text, 'MAI text must be authoritative');
  eq(c.hasTimestamps, true);
  eq(c.hasConfidence, true);
  ok(c.segments.every(s => s.start != null && s.end != null), 'all segments must be seekable');
  close(c.agreement, 1, 1e-6, 'identical transcripts should agree fully');
});

t('crossCheck surfaces disagreement as the confidence signal MAI lacks', () => {
  const bad = { text: 'εντελώς διαφορετικό κείμενο εδώ', segments: [
    { start: 0, end: 5, text: 'εντελώς διαφορετικό κείμενο εδώ', avg_logprob: -0.4, no_speech_prob: 0.02 }] };
  const c = asr.crossCheck(asr.normalizeMai(MAI_RES, CHUNK),
                           asr.normalizeWhisper(bad, CHUNK), CHUNK);
  ok(c.agreement < 0.5, 'expected low agreement, got ' + c.agreement);
  eq(c.lowAgreement, true);
  ok(c.segments.every(s => s.suspect), 'a divergent chunk must mark its segments suspect');
});

t('biasPrompt respects the 224-token cap by truncating', () => {
  const many = Array.from({ length: 500 }, (_, i) => 'Όνομα' + i);
  const p = asr.biasPrompt(many, 200);
  ok(p.length <= 220, 'prompt too long: ' + p.length);
  ok(p.startsWith('Ονόματα:'));
});

t('biasPrompt returns null with an empty glossary', () => eq(asr.biasPrompt([]), null));

// --- transcribeChunk against a mock backend (no network) ---

function mockBackend(log) {
  return async (payload, model) => {
    log.push(model);
    return model === asr.MODELS.mai ? MAI_RES : WHISPER_RES;
  };
}
const chunkArg = { index: 3, start: 187.4, duration: 74.2 };

const asyncTests = [];
function at(name, fn) { asyncTests.push([name, fn]); }

at('TEXT mode calls only MAI and returns null timing', async () => {
  const log = [];
  const r = await asr.transcribeChunk(chunkArg, { mode: asr.MODES.TEXT, backend: mockBackend(log) });
  eq(log, [asr.MODELS.mai]);
  eq(r.hasTimestamps, false);
  close(r.cost, 0.0074, 1e-9);
});

at('NAV mode calls only Whisper and returns timing', async () => {
  const log = [];
  const r = await asr.transcribeChunk(chunkArg, { mode: asr.MODES.NAV, backend: mockBackend(log) });
  eq(log, [asr.MODELS.whisper]);
  eq(r.hasTimestamps, true);
});

at('CROSS mode calls both models', async () => {
  const log = [];
  const r = await asr.transcribeChunk(chunkArg, { mode: asr.MODES.CROSS, backend: mockBackend(log) });
  eq(log.sort(), [asr.MODELS.mai, asr.MODELS.whisper].sort());
  eq(r.models.length, 2);
  close(r.cost, 0.008, 1e-9, 'cost must sum across both models');
});

at('a silent chunk is never sent to any model', async () => {
  const log = [];
  const r = await asr.transcribeChunk({ ...chunkArg, isSilent: true },
                                      { mode: asr.MODES.CROSS, backend: mockBackend(log) });
  eq(log, [], 'silent chunks must not reach a model -- this is the hallucination guard');
  eq(r.skipped, 'silent');
  eq(r.cost, 0);
});

// The single most important invariant: every mode must produce a shape the UI can render,
// including when timestamps and confidence are entirely absent.
at('all three modes produce a renderable transcript', async () => {
  for (const mode of [asr.MODES.TEXT, asr.MODES.NAV, asr.MODES.CROSS]) {
    const r = await asr.transcribeChunk(chunkArg, { mode, backend: mockBackend([]) });
    ok(typeof r.text === 'string', mode + ': text must be a string');
    ok(Array.isArray(r.segments), mode + ': segments must be an array');
    for (const s of r.segments) {
      ok(typeof s.id === 'string' && s.text, mode + ': every segment needs an id and text');
      ok('start' in s && 'end' in s && 'confidence' in s,
         mode + ': optional fields must exist even when null');
      // What the UI will actually do -- must never produce NaN or undefined.
      const seek = s.start ?? r.start;
      ok(Number.isFinite(seek), mode + ': seek target must resolve even with null timestamps');
    }
  }
});

at('retryable errors are marked so the queue can back off', async () => {
  const backend = async () => { const e = new Error('rate limited'); e.status = 429; e.retryable = true; throw e; };
  let caught = null;
  try { await asr.transcribeChunk(chunkArg, { mode: asr.MODES.TEXT, backend }); }
  catch (e) { caught = e; }
  ok(caught && caught.retryable, 'a 429 must be retryable');
});

// ---------------------------------------------------------------- store.js

const mk = () => new store.MemoryStore();
const fakeResult = (i, cost = 0.01) => ({
  chunk: i, start: i * 70, duration: 70, segments: [{ id: `c${i}s0`, text: 'κείμενο' }], cost
});

at('MemoryStore round-trips JSON and lists a directory', async () => {
  const s = mk();
  await s.writeJSON('tapes/t1/tape.json', { id: 't1' });
  eq((await s.readJSON('tapes/t1/tape.json')).id, 't1');
  eq(await s.list('tapes'), ['t1']);
  eq(await s.exists('tapes/t1/nope.json'), false);
});

at('reconcile derives progress from files on disk', async () => {
  const s = mk();
  for (const i of [0, 1, 2]) await store.saveChunkText(s, 't1', fakeResult(i));
  const r = await store.reconcile(s, 't1');
  eq(r.done, [0, 1, 2]);
  eq(r.corrupt, []);
});

at('reconcile treats a half-written file as NOT done', async () => {
  const s = mk();
  await store.saveChunkText(s, 't1', fakeResult(0));
  await s.write(store.paths.chunkText('t1', 1), '{"chunk":1,"segm');   // killed mid-write
  const r = await store.reconcile(s, 't1');
  eq(r.done, [0], 'a truncated chunk must not count as complete');
  eq(r.corrupt, [1]);
});

at('reconcile rejects a well-formed file that is missing segments', async () => {
  const s = mk();
  await s.writeJSON(store.paths.chunkText('t1', 0), { chunk: 0 });     // valid JSON, wrong shape
  eq((await store.reconcile(s, 't1')).done, []);
});

at('pendingChunks resumes exactly where the disk left off', async () => {
  const s = mk();
  const planned = audio.planChunks([], 700);            // 700s -> several chunks
  for (const i of [0, 1, 2]) await store.saveChunkText(s, 't1', fakeResult(i));
  const pending = await store.pendingChunks(s, 't1', planned);
  eq(pending.map(c => c.index), planned.map((_, i) => i).slice(3),
     'must redo nothing that is already on disk, and skip nothing that is not');
});

at('a crash mid-chunk redoes at most one chunk and skips none', async () => {
  const s = mk();
  const planned = audio.planChunks([], 700);
  // Simulate: chunks 0-2 committed, chunk 3 died halfway through its write.
  for (const i of [0, 1, 2]) await store.saveChunkText(s, 't1', fakeResult(i));
  await s.write(store.paths.chunkText('t1', 3), '{"chunk":3,"seg');
  const pending = await store.pendingChunks(s, 't1', planned);
  ok(pending[0].index === 3, 'must resume at the interrupted chunk, not after it');
  const idx = pending.map(c => c.index);
  eq(idx, planned.map((_, i) => i).slice(3), 'no chunk may be skipped');
});

at('refreshTapeSummary sums cost from disk, ignoring a stale counter', async () => {
  const s = mk();
  // A lying summary from before a crash: claims everything is done and free.
  await s.writeJSON(store.paths.tape('t1'), { id: 't1', chunksDone: 999, cost: 0 });
  for (const i of [0, 1]) await store.saveChunkText(s, 't1', fakeResult(i, 0.02));
  const sum = await store.refreshTapeSummary(s, 't1');
  eq(sum.chunksDone, 2, 'summary must be rebuilt from disk, not trusted');
  close(sum.cost, 0.04, 1e-9, 'cost must be re-derived from the chunk files');
});

at('refreshTapeSummary preserves metadata it does not own', async () => {
  const s = mk();
  await s.writeJSON(store.paths.tape('t1'), { id: 't1', label: 'Side A, Mar 1978', side: 'A' });
  await store.saveChunkText(s, 't1', fakeResult(0));
  const sum = await store.refreshTapeSummary(s, 't1', { dateRange: ['1978-03-01', '1978-03-14'] });
  eq(sum.label, 'Side A, Mar 1978', 'user-supplied metadata must survive a refresh');
  eq(sum.dateRange[1], '1978-03-14');
});

at('paths keep chunks zero-padded so they sort correctly', async () => {
  eq(store.paths.chunkText('t1', 7),  'tapes/t1/chunks/007.gr.json');
  eq(store.paths.chunkText('t1', 42), 'tapes/t1/chunks/042.gr.json');
  const s = mk();
  for (const i of [2, 10, 1]) await store.saveChunkText(s, 't1', fakeResult(i));
  eq(await s.list(store.paths.chunkDir('t1')), ['001.gr.json', '002.gr.json', '010.gr.json']);
});

const run = async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); pass++; results.push('  ok   ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n         ' + e.message); }
  }
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
run();
