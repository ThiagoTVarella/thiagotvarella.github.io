// Test suite for the tape digitizer. Runs with plain node, no framework, no network,
// no tapes, no API spend:  node tapes/test/run-tests.mjs
//
// The repo has no test tooling, so this is deliberately dependency-free.

import * as audio from '../js/audio.js';
import * as asr from '../js/asr.js';
import * as store from '../js/store.js';
import * as tr from '../js/translate.js';
import * as gl from '../js/glossary.js';
import * as ff from '../js/ffmpeg.js';
import * as q from '../js/queue.js';
import * as entry from '../js/entry.js';
import * as lib from '../js/library.js';
import * as rec from '../js/record.js';

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

// The next four come from real API responses, not from the documented thresholds.
t('pure hiss is flagged even though its avg_logprob looks fine', () => {
  // Observed on 20s of tape hiss: no_speech 1.000, avg_logprob 0.000.
  ok(asr.isSuspect({ no_speech_prob: 1.0, avg_logprob: 0.0, text: '' }),
     'requiring BOTH conditions would miss the one case that matters');
});

t('a correct short segment is NOT flagged despite a low avg_logprob', () => {
  // Observed: the segment "1978." transcribed perfectly at avg_logprob -1.134.
  ok(!asr.isSuspect({ no_speech_prob: 0.0, avg_logprob: -1.134, text: '1978.' }),
     'short segments are naturally less confident; flagging them teaches distrust of correct text');
});

t('a long low-confidence segment is still flagged', () => {
  ok(asr.isSuspect({ no_speech_prob: 0.0, avg_logprob: -1.4,
                     text: 'ένα δύο τρία τέσσερα πέντε έξι' }));
});

t('confidence does NOT catch confident misrecognition — only cross-check does', () => {
  // Observed on degraded audio: Whisper wrote "Η ημερά είναι τρίτη" for "Σήμερα είναι Τρίτη"
  // at no_speech 0.000, avg_logprob -0.527 -- entirely unflagged.
  const wrong = { no_speech_prob: 0.0, avg_logprob: -0.527, text: 'Η ημερά είναι τρίτη.' };
  ok(!asr.isSuspect(wrong), 'the acoustic signal cannot see this class of error');
  ok(asr.agreement('Σήμερα είναι Τρίτη.', 'Η ημερά είναι τρίτη.') < 0.7,
     'cross-check is the signal that catches misrecognition');
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

// ------------------------------------------------------------ translate.js

const segs = n => Array.from({ length: n }, (_, i) => ({ id: 's' + i, text: 'πρόταση ' + i }));
// A backend that answers correctly, except for ids listed in `drop`.
const mockChat = (drop = [], extra = {}) => {
  const calls = [];
  const fn = async messages => {
    calls.push(messages);
    // A real model reads the whole conversation, so the segment list is found wherever it
    // appears -- in the repair round it sits in an earlier message, not the last one.
    // Only the part after the instruction line counts; the context block is not to translate.
    const ids = [];
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const i = m.content.indexOf('Translate these segments:');
      if (i < 0) continue;
      for (const g of m.content.slice(i).matchAll(/^(s\d+):/gm)) {
        if (!ids.includes(g[1])) ids.push(g[1]);
      }
    }
    const answer = ids.filter(id => !drop.includes(id));
    drop = drop.filter(id => !ids.includes(id));   // the repair round gets them right
    return { choices: [{ message: { content: JSON.stringify({
        translations: answer.map(id => ({ id, en: 'sentence ' + id.slice(1) })),
        flags: extra.flags || [], dates: extra.dates || [] }) } }],
      usage: { cost: 0.001 } };
  };
  fn.calls = calls;
  return fn;
};

at('batchSegments splits to 40 by default', async () => {
  eq(tr.batchSegments(segs(95)).map(b => b.length), [40, 40, 15]);
  eq(tr.batchSegments(segs(0)).length, 0);
});

at('glossaryBlock teaches inflection and ASR-mangling matching', async () => {
  const b = tr.glossaryBlock([{ canonical_greek: 'Κώστας', observed_forms: ['Κώστα', 'Γκόστα'],
                                english: 'Kostas', kind: 'word' }]);
  ok(b.includes('Κώστας / Κώστα / Γκόστα => Kostas'), 'all observed forms must be listed');
  ok(b.includes('inflected'), 'must instruct on Greek declension');
});

// This is the bug the field existed to avoid: she writes a note and it goes nowhere.
at("her note reaches the model", async () => {
  const b = tr.glossaryBlock([{ greek: 'Κώστας', english: 'Kostas',
                                note: "my grandfather's brother, lived in Athens" }]);
  ok(b.includes("my grandfather's brother"), 'the note she wrote must reach the prompt');
  ok(b.includes('she says:'), 'and be marked as coming from her, not inferred');
});

at('glossaryBlock accepts the legacy plural key rather than silently dropping it', async () => {
  ok(tr.glossaryBlock([{ greek: 'Ελένη', english: 'Eleni', notes: 'his wife' }])
       .includes('his wife'), 'reading the wrong key must not lose her knowledge');
});

at('glossaryBlock never leaks the word/phrase kind into the prompt', async () => {
  const b = tr.glossaryBlock([{ greek: 'Κώστας', english: 'Kostas', kind: 'word' }]);
  ok(!/\(word\)|\(phrase\)|\(person\)|\(place\)/.test(b),
     'kind describes the audio problem and tells the translator nothing: ' + b);
});

at('glossaryBlock omits the note line entirely when she has not written one', async () => {
  const b = tr.glossaryBlock([{ greek: 'Κώστας', english: 'Kostas', note: '   ' }]);
  ok(!b.includes('she says:'), 'an empty note must not produce a dangling label');
});

at('the prompt forbids extending what she said to other people', async () => {
  const b = tr.glossaryBlock([{ greek: 'Κώστας', english: 'Kostas', note: 'his brother' }]);
  ok(/do not\s+extend them/.test(b), 'one stated relationship must not license inventing others');
});

at('glossaryBlock is empty when there is no glossary yet', async () => eq(tr.glossaryBlock([]), ''));

at('parseJson survives fenced and prose-wrapped output', async () => {
  eq(tr.parseJson('```json\n{"a":1}\n```').a, 1);
  eq(tr.parseJson('Sure! {"a":2} hope that helps').a, 2);
  eq(tr.parseJson('{"a":3}').a, 3);
});

at('parseJson throws rather than returning junk', async () => {
  let threw = false;
  try { tr.parseJson('no json here'); } catch (e) { threw = true; }
  ok(threw, 'unparseable output must raise, not silently yield nothing');
});

at('validate detects dropped and invented ids', async () => {
  const batch = segs(3);
  const v = tr.validate(batch, { translations: [
    { id: 's0', en: 'a' }, { id: 's9', en: 'ghost' }] });
  eq(v.missing, ['s1', 's2']);
  eq(v.extra, ['s9']);
});

at('validate rejects empty translations', async () => {
  eq(tr.validate(segs(1), { translations: [{ id: 's0', en: '   ' }] }).missing, ['s0']);
});

at('translateBatch returns one translation per input id', async () => {
  const batch = segs(5);
  const r = await tr.translateBatch(batch, { backend: mockChat() });
  eq(r.translations.map(t => t.id), batch.map(s => s.id));
  eq(r.unresolved, []);
});

at('translateBatch repairs dropped ids by re-asking for only those', async () => {
  const backend = mockChat(['s2', 's4']);
  const r = await tr.translateBatch(segs(6), { backend });
  eq(r.unresolved, [], 'the repair loop must recover dropped ids');
  ok(r.translations.every(t => t.en), 'every id must end up translated');
  eq(backend.calls.length, 2, 'exactly one repair round should have been needed');
  const repair = backend.calls[1][1].content;
  ok(repair.includes('s2') && repair.includes('s4'), 'repair must target the dropped ids');
  ok(!repair.includes('s0:'), 'repair must NOT re-send ids that already came back');
});

at('translateBatch reports ids it could not recover instead of hiding them', async () => {
  // A backend that stubbornly never returns s1.
  const backend = async messages => {
    const ids = [...messages[messages.length - 1].content.matchAll(/^(s\d+):/gm)].map(m => m[1]);
    return { choices: [{ message: { content: JSON.stringify({
      translations: ids.filter(i => i !== 's1').map(id => ({ id, en: 'x' })) }) } }], usage: {} };
  };
  const r = await tr.translateBatch(segs(3), { backend, maxRepairs: 2 });
  eq(r.unresolved, ['s1'], 'an unrecoverable id must be surfaced, never silently dropped');
  eq(r.translations.find(t => t.id === 's1').en, null);
});

at('translateBatch discards flags for ids outside the batch', async () => {
  const backend = mockChat([], { flags: [{ id: 's0', type: 'name', greek: 'Κώστα' },
                                          { id: 'sZZ', type: 'name', greek: 'ghost' }] });
  const r = await tr.translateBatch(segs(2), { backend });
  eq(r.flags.length, 1);
  eq(r.flags[0].id, 's0');
});

at('translateAll carries context across batches and accumulates cost', async () => {
  const backend = mockChat();
  const r = await tr.translateAll(segs(90), { backend, batchSize: 40 });
  eq(r.translations.length, 90);
  eq(backend.calls.length, 3);
  // Batch 2 must have seen the tail of batch 1 as context.
  const second = backend.calls[1][1].content;
  ok(second.includes('Preceding context'), 'later batches need narrative continuity');
  ok(second.includes('s39'), 'the tail of the previous batch should be the context');
  close(r.cost, 0.003, 1e-9);
});

at('translateAll reports progress', async () => {
  const seen = [];
  await tr.translateAll(segs(85), { backend: mockChat(), batchSize: 40,
                                    onProgress: (a, b) => seen.push([a, b]) });
  eq(seen, [[40, 85], [80, 85], [85, 85]]);
});

at('dateRange picks the earliest and latest spoken dates', async () => {
  eq(tr.dateRange([{ iso: '1978-03-14' }, { iso: '1978-03-02' }, { iso: null }]),
     ['1978-03-02', '1978-03-14']);
  eq(tr.dateRange([]), null);
});

at('systemPrompt insists on flagging names for a non-Greek-speaker', async () => {
  const p = tr.systemPrompt([]);
  ok(p.includes('FIRST time it appears'), 'names must be flagged even when confident');
  ok(p.includes('does not speak Greek'));
  ok(p.includes('"dates"'), 'date extraction rides along in the same call');
});

at('compareModels lines up the same sentence across models', async () => {
  const r = await tr.compareModels(segs(3), ['m1', 'm2'], { backend: mockChat(), sampleSize: 3 });
  eq(r.rows.length, 3);
  eq(r.rows[0].versions.map(v => v.model), ['m1', 'm2']);
  ok(r.rows.every(row => row.versions.every(v => v.en)), 'every model should answer every row');
  ok(r.totalCost > 0);
});

at('compareModels survives one model failing outright', async () => {
  const good = mockChat();
  const backend = async (messages, model) => {
    if (model === 'bad') throw new Error('model unavailable');
    return good(messages);
  };
  const r = await tr.compareModels(segs(2), ['good', 'bad'], { backend, sampleSize: 2 });
  eq(r.runs.length, 2);
  eq(r.runs[1].error, 'model unavailable', 'a failing model must be reported, not thrown');
  ok(r.rows.every(row => row.versions[0].en), 'the working model still produces output');
  ok(r.rows.every(row => row.versions[1].en === null), 'the failed model yields nulls');
});

// ------------------------------------------------------------- glossary.js

const ENTRY = { id: 'kostas', greek: 'Κώστας', canonical_greek: 'Κώστας',
                observed_forms: ['Κώστα', 'Γκόστα'], english: 'Kostas' };

at('normalizeGreek folds accents, case, and final sigma', async () => {
  eq(gl.normalizeGreek('Κώστας'), gl.normalizeGreek('ΚΩΣΤΑΣ'));
  eq(gl.normalizeGreek('Κώστας'), 'κωστασ');
});

at('sameWord matches across Greek inflection', async () => {
  ok(gl.sameWord('Κώστας', 'Κώστα'), 'nominative and genitive are the same name');
  ok(gl.sameWord('Ελένη', 'Ελένης'));
  ok(!gl.sameWord('Κώστας', 'Ελένη'), 'different names must not collide');
});

at('sameWord does not collide short unrelated words', async () => {
  ok(!gl.sameWord('και', 'με'));
});

at('greekMentions finds a declined form inside a sentence', async () => {
  ok(gl.greekMentions('Ήρθε ο Κώστας το μεσημέρι.', ENTRY));
  ok(gl.greekMentions('Πήγα στου Κώστα το σπίτι.', ENTRY), 'genitive inside a phrase');
  ok(gl.greekMentions('Ήρθε ο Γκόστα σήμερα.', ENTRY), 'a recorded ASR mangling still matches');
  ok(!gl.greekMentions('Η Ελένη μαγείρεψε φασόλια.', ENTRY));
});

at('confirming the existing guess costs nothing anywhere', async () => {
  const segs = [{ id: 's0', tape: 't1', gr: 'Ήρθε ο Κώστας.', en: 'Kostas came.' }];
  const plan = gl.planCorrection(segs, ENTRY, 'Kostas', 'Kostas');
  eq(plan.tier, gl.TIER.NONE);
  eq(plan.substitute.length, 0);
  eq(plan.retranslate.length, 0);
  eq(gl.estimateCost(plan), 0);
  eq(gl.describePlan(plan), 'Nothing else needs changing — it already reads that way.');
});

at('a renaming is a free substitution, not a re-translation', async () => {
  const segs = [
    { id: 's0', tape: 't1', gr: 'Ήρθε ο Κώστας το μεσημέρι.', en: 'Costas came at midday.' },
    { id: 's1', tape: 't1', gr: 'Πήγα στου Κώστα το σπίτι.',  en: "I went to Costas' house." },
    { id: 's2', tape: 't1', gr: 'Η Ελένη μαγείρεψε.',          en: 'Eleni cooked.' }
  ];
  const plan = gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas');
  eq(plan.tier, gl.TIER.SUBSTITUTE);
  eq(plan.substitute.map(s => s.id), ['s0', 's1']);
  eq(plan.untouched, 1, 'a sentence that never mentions him is not touched');
  eq(plan.retranslate.length, 0, 'no model call needed for a pure renaming');
  eq(gl.estimateCost(plan), 0);
  eq(plan.substitute[0].preview, 'Kostas came at midday.');
  eq(plan.substitute[1].preview, "I went to Kostas' house.");
});

at('substitution is whole-word, so it cannot corrupt other words', async () => {
  eq(gl.substitute('Ann and Anna went', 'Ann', 'Anne'), 'Anne and Anna went');
  eq(gl.substitute("Costas' house, Costas.", 'Costas', 'Kostas'), "Kostas' house, Kostas.");
  eq(gl.findRendering('Anna went', 'Ann'), false, 'must not match inside a longer word');
});

at('a segment whose English lost the name is re-translated, not blindly swapped', async () => {
  // The model read the mangled name as an ordinary word, so no swap could fix the sentence.
  const segs = [{ id: 's0', tape: 't1', gr: 'Ήρθε ο Γκόστα σήμερα.', en: 'The cost came today.' }];
  const plan = gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas');
  eq(plan.tier, gl.TIER.RETRANSLATE);
  eq(plan.substitute.length, 0, 'a blind swap here would leave a broken sentence');
  eq(plan.retranslate.map(s => s.id), ['s0']);
  ok(gl.estimateCost(plan) > 0 && gl.estimateCost(plan) < 0.01, 'per-sentence, not per-tape');
});

at('applying a correction keeps the original so it can be undone', async () => {
  const segs = [{ id: 's0', tape: 't1', gr: 'Ήρθε ο Κώστας.', en: 'Costas came.' }];
  const plan = gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas');
  const { segments, audit } = gl.applySubstitutions(segs, plan, ENTRY);
  eq(segments[0].en, 'Kostas came.');
  eq(segments[0].enOriginal, 'Costas came.', 'the machine original must be preserved');
  eq(audit.segments, ['s0']);
  eq(gl.undo(segments, audit)[0].en, 'Costas came.', 'a bad correction must be reversible');
});

at('repeated corrections do not lose the true original', async () => {
  let segs = [{ id: 's0', tape: 't1', gr: 'Ήρθε ο Κώστας.', en: 'Costas came.' }];
  segs = gl.applySubstitutions(segs, gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas'), ENTRY).segments;
  segs = gl.applySubstitutions(segs, gl.planCorrection(segs, ENTRY, 'Kostas', 'Konstantinos'), ENTRY).segments;
  eq(segs[0].en, 'Konstantinos came.');
  eq(segs[0].enOriginal, 'Costas came.', 'still the machine original, not the intermediate');
});

at('answering several names is one sweep, deduped', async () => {
  const segs = [
    { id: 's0', tape: 't1', gr: 'Ήρθε ο Κώστας.',   en: 'Costas came.' },
    { id: 's1', tape: 't1', gr: 'Ήρθε ο Γκόστα.',   en: 'The cost arrived.' }
  ];
  const merged = gl.mergePlans([
    gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas'),
    gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas')
  ]);
  ok(!merged.substitute.some(x => merged.retranslate.some(r => r.id === x.id)),
     'a segment queued for re-translation must not also be substituted');
});

at('describePlan speaks plainly and never mentions re-transcribing', async () => {
  const segs = [
    { id: 's0', tape: 't1', gr: 'Ήρθε ο Κώστας.', en: 'Costas came.' },
    { id: 's1', tape: 't1', gr: 'Ήρθε ο Γκόστα.', en: 'The cost arrived.' }
  ];
  const d = gl.describePlan(gl.planCorrection(segs, ENTRY, 'Costas', 'Kostas'));
  ok(/updated in 1 place/.test(d), d);
  ok(/1 sentence re-read/.test(d), d);
  ok(!/transcri/i.test(d), 'a glossary fix must never imply re-transcription');
});

// --------------------------------------------------------------- ffmpeg.js

// A fake engine that records every call, so the orchestration and -- crucially -- the
// memory discipline can be verified with no wasm, no network, and no audio.
// `duration: null` reproduces a browser recording, whose header carries no duration at all
// (`Duration: N/A`). `progressTime` is what a decode pass reports as its final position --
// the only remaining way to learn the length of such a file.
function fakeFfmpeg({ duration = '00:10:00.00', silences = [], progressTime, failScan = false } = {}) {
  const calls = { exec: [], mount: [], unmount: 0, writeFile: 0, readFile: [], deleteFile: [] };
  let logSink = null;
  const ff = {
    calls,
    on: (ev, fn) => { if (ev === 'log') logSink = fn; },
    createDir: async () => {},
    mount: async (type, cfg, path) => { calls.mount.push({ type, files: cfg.files, path }); },
    unmount: async () => { calls.unmount++; },
    writeFile: async () => { calls.writeFile++; },      // must never be called on the input
    readFile: async n => { calls.readFile.push(n); return new Uint8Array([1, 2, 3]); },
    deleteFile: async n => { calls.deleteFile.push(n); },
    terminate: async () => {},
    exec: async args => {
      calls.exec.push(args);
      const emit = m => logSink?.({ message: m });
      if (args.length === 2 && args[0] === '-i') {
        emit(duration
          ? `  Duration: ${duration}, start: 0.000000, bitrate: 256 kb/s`
          : `  Duration: N/A, start: 0.000000, bitrate: N/A`);
        throw new Error('at least one output file must be specified');   // real ffmpeg does this
      }
      if (args.join(' ').includes('silencedetect')) {
        emit(duration
          ? `  Duration: ${duration}, start: 0.000000, bitrate: 256 kb/s`
          : `  Duration: N/A, start: 0.000000, bitrate: N/A`);
        for (const s of silences) {
          emit(`[silencedetect @ 0x1] silence_start: ${s.start}`);
          emit(`[silencedetect @ 0x1] silence_end: ${s.end} | silence_duration: ${s.end - s.start}`);
        }
        // A decoding pass prints its running position; the last one is where audio ended.
        // Only emitted for a real timestamp -- ffmpeg would never print a malformed one,
        // and pretending it might made this fake lie about what is recoverable.
        const finalTime = progressTime ?? duration;
        if (finalTime && /^\d+:\d{2}:\d{2}/.test(finalTime)) {
          emit(`size=N/A time=00:00:00.06 bitrate=N/A speed=N/A    `);
          emit(`size=N/A time=${finalTime} bitrate=N/A speed= 123x`);
        }
        if (failScan) throw new Error('decode aborted');
      }
    }
  };
  return async () => ff;
}
const fakeFile = (name = 'tape.wav') => ({ name, size: 900e6 });

at('the ffmpeg core URL points at the esm build, not umd', async () => {
  // The worker runs as type:"module", so importScripts is unavailable and the library
  // dynamic-imports instead, rewriting '/umd/' to '/esm/' on the way. Naming umd means umd
  // never loads, and breaks outright once the files are vendored somewhere without '/umd/'
  // in the path. Verified against a real browser run.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../js/ffmpeg.js', import.meta.url), 'utf8'));
  const m = src.match(/const CDN = '([^']+)'/);
  ok(m, 'CDN constant should exist');
  ok(m[1].endsWith('/esm'), 'must name the esm core directly, got: ' + m[1]);
});

at('parseDuration reads the ffmpeg header, taking the last match', async () => {
  eq(ff.parseDuration('Duration: 00:45:12.34, start: 0'), 45 * 60 + 12.34);
  eq(ff.parseDuration('Duration: 01:00:00.00\nDuration: 03:00:00.00'), 10800);
  eq(ff.parseDuration('no duration here'), null);
});

// A browser recording carries no duration in its header, which is the same defect that
// made the <audio> element report Infinity. These log samples are copied verbatim from a
// real MediaRecorder webm run through ffmpeg.wasm.
at('parseProgressDuration recovers the length a decode pass observed', async () => {
  const realLog = [
    '  Duration: N/A, start: 0.000000, bitrate: N/A',
    'size=N/A time=00:00:00.06 bitrate=N/A speed=N/A    ',
    'size=N/A time=00:00:04.99 bitrate=N/A speed= 123x'
  ].join('\n');
  eq(ff.parseDuration(realLog), null, 'the header genuinely has nothing to read');
  close(ff.parseProgressDuration(realLog), 4.99, 1e-9, 'but the decode pass knows');
});

at('parseProgressDuration takes the LAST position, not the first', async () => {
  const log = 'time=00:00:01.00\ntime=00:00:20.50\ntime=00:01:05.25';
  close(ff.parseProgressDuration(log), 65.25, 1e-9);
});

at('parseProgressDuration returns null when there is nothing to go on', async () => {
  eq(ff.parseProgressDuration(''), null);
  eq(ff.parseProgressDuration('no timing here'), null);
  eq(ff.parseProgressDuration('time=00:00:00.00'), null, 'a zero-length read is not a duration');
});

at('a recording with no duration in its header is still prepared', async () => {
  // duration: null reproduces `Duration: N/A`; the fake emits progress lines the way a
  // real decode pass does, which is the only remaining source of the length.
  const factory = fakeFfmpeg({ duration: null, progressTime: '00:00:04.99' });
  const engine = new ff.TapeAudio({ factory });
  const chunks = [];
  const r = await ff.prepareTape(fakeFile('source.webm'), {
    engine, targetSec: 2, minSec: 1, maxSec: 3, searchSec: 1,
    onChunk: (c, b) => chunks.push(c)
  });
  close(r.duration, 4.99, 1e-9, 'the measured duration must be used, not a thrown error');
  ok(chunks.length > 0, 'and the recording must actually get chunked');
});

at('a header duration still wins when there is one', async () => {
  const factory = fakeFfmpeg({ duration: '00:00:30.00', progressTime: '00:00:29.90' });
  const engine = new ff.TapeAudio({ factory });
  const r = await ff.prepareTape(fakeFile(), { engine, targetSec: 10, minSec: 5, maxSec: 15 });
  close(r.duration, 30, 1e-9, 'the container header is authoritative when present');
});

at('a decode that dies partway is not believed about the length', async () => {
  // The dangerous case: a pass that aborts after a fraction of a second has still printed
  // a position. Trusting it would treat a 45-minute side as a few seconds and quietly
  // discard almost all of it -- far worse than failing outright.
  const factory = fakeFfmpeg({ duration: null, progressTime: '00:00:00.06', failScan: true });
  const engine = new ff.TapeAudio({ factory });
  let msg = null;
  try { await ff.prepareTape(fakeFile('source.webm'), { engine }); } catch (e) { msg = e.message; }
  ok(msg && /how long/.test(msg), 'must refuse rather than accept a bogus 0.06s: ' + msg);
});

at('a recording whose length cannot be found at all still fails clearly', async () => {
  const factory = fakeFfmpeg({ duration: null, progressTime: null });
  const engine = new ff.TapeAudio({ factory });
  let msg = null;
  try { await ff.prepareTape(fakeFile(), { engine }); } catch (e) { msg = e.message; }
  ok(msg && /how long/.test(msg), 'got: ' + msg);
});

at('probeDuration survives ffmpeg exiting non-zero with no output file', async () => {
  const a = new ff.TapeAudio({ factory: fakeFfmpeg({ duration: '00:45:00.00' }) });
  await a.load();
  const input = await a.mount(fakeFile());
  eq(await a.probeDuration(input), 2700, 'the header still parses from a failed run');
});

at('the input is mounted with WORKERFS and never written into the wasm heap', async () => {
  const factory = fakeFfmpeg({ duration: '00:03:00.00' });
  const engine = new ff.TapeAudio({ factory });
  const file = fakeFile('big.wav');
  const r = await ff.prepareTape(file, { engine });
  const c = (await factory()).calls;
  eq(c.writeFile, 0, 'writeFile would copy a 0.9GB file into a 2GB heap');
  eq(c.mount.length, 1);
  eq(c.mount[0].type, 'WORKERFS', 'must mount, not copy');
  eq(c.mount[0].files[0], file, 'mounts the File object itself, read lazily off disk');
  ok(r.chunks.length > 0);
});

at('every chunk output is deleted from MEMFS as soon as it is read', async () => {
  const factory = fakeFfmpeg({ duration: '00:05:00.00' });
  const engine = new ff.TapeAudio({ factory });
  await ff.prepareTape(fakeFile(), { engine });
  const c = (await factory()).calls;
  ok(c.readFile.length > 0, 'expected chunks');
  eq(c.deleteFile, c.readFile, 'outputs must not accumulate in MEMFS');
});

at('chunks are handed over one at a time, not accumulated', async () => {
  const factory = fakeFfmpeg({ duration: '00:05:00.00' });
  const engine = new ff.TapeAudio({ factory });
  const seen = [];
  await ff.prepareTape(fakeFile(), {
    engine,
    onChunk: async (chunk, bytes) => { seen.push([chunk.index, bytes.length]); }
  });
  ok(seen.length > 1);
  eq(seen.map(s => s[0]), seen.map((_, i) => i), 'delivered in order');
  ok(seen.every(s => s[1] === 3), 'each chunk arrives with its bytes');
});

at('a silent chunk is never cut and never handed over', async () => {
  // 5 minutes where the middle 200s is dead air.
  const factory = fakeFfmpeg({ duration: '00:05:00.00', silences: [{ start: 90, end: 300 }] });
  const engine = new ff.TapeAudio({ factory });
  const handed = [];
  const r = await ff.prepareTape(fakeFile(), { engine, onChunk: c => handed.push(c.index) });
  const skipped = r.chunks.filter(c => c.skipped === 'silent');
  ok(skipped.length > 0, 'dead air should have been detected');
  eq(r.skipped, skipped.length);
  ok(skipped.every(c => !handed.includes(c.index)),
     'leader tape and dead ends must never reach a model');
  ok(skipped.every(c => c.bytes === 0), 'and must never be encoded either');
});

at('the ffmpeg argv actually cuts at the planned offsets', async () => {
  const factory = fakeFfmpeg({ duration: '00:04:00.00' });
  const engine = new ff.TapeAudio({ factory });
  const r = await ff.prepareTape(fakeFile(), { engine });
  const cuts = (await factory()).calls.exec.filter(a => a.includes('-ss'));
  eq(cuts.length, r.chunks.filter(c => !c.skipped).length);
  eq(cuts[0][cuts[0].indexOf('-ss') + 1], '0.000', 'first chunk starts at zero');
  ok(cuts[0].includes('16000') && cuts[0].includes('32k'), 'mono 16k 32kbps keeps uploads small');
});

at('progress is reported over the whole plan, including skipped chunks', async () => {
  const factory = fakeFfmpeg({ duration: '00:05:00.00', silences: [{ start: 90, end: 300 }] });
  const engine = new ff.TapeAudio({ factory });
  const seen = [];
  const r = await ff.prepareTape(fakeFile(), { engine, onProgress: (a, b) => seen.push([a, b]) });
  eq(seen.length, r.chunks.length, 'skipped chunks still advance the bar');
  eq(seen[seen.length - 1][0], seen[seen.length - 1][1], 'ends at 100%');
});

at('stages are announced in order so the UI can say what is happening', async () => {
  const engine = new ff.TapeAudio({ factory: fakeFfmpeg({ duration: '00:02:00.00' }) });
  const stages = [];
  await ff.prepareTape(fakeFile(), { engine, onStage: s => stages.push(s) });
  eq(stages, ['loading', 'reading', 'listening', 'splitting']);
});

at('an abort stops cutting partway and still unmounts', async () => {
  const factory = fakeFfmpeg({ duration: '00:10:00.00' });
  const engine = new ff.TapeAudio({ factory });
  const ctrl = { aborted: false };
  let n = 0;
  const r = await ff.prepareTape(fakeFile(), {
    engine, signal: ctrl,
    onChunk: () => { if (++n === 2) ctrl.aborted = true; }
  });
  ok(r.chunks.length < 8, 'should have stopped early, got ' + r.chunks.length);
  ok((await factory()).calls.unmount >= 1, 'the file must be released even on abort');
});

at('a recording of unknown length fails with something a person can read', async () => {
  const engine = new ff.TapeAudio({ factory: fakeFfmpeg({ duration: 'garbage' }) });
  let msg = null;
  try { await ff.prepareTape(fakeFile(), { engine }); } catch (e) { msg = e.message; }
  ok(msg && /how long/.test(msg), 'got: ' + msg);
  ok(!/undefined|null|NaN/.test(msg), 'no internals in a message she might see');
});

// ---------------------------------------------------------------- queue.js

// Minimal browser globals so the queue can run under node. Absent APIs must degrade,
// not crash -- Web Locks and Wake Lock are exactly the things that vary by browser.
// Node exposes `navigator` as a read-only getter, so it has to be redefined outright.
const navStub = {};
Object.defineProperty(globalThis, 'navigator', { value: navStub, writable: true, configurable: true });
Object.defineProperty(globalThis, 'document', { configurable: true, writable: true,
  value: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
if (!globalThis.btoa) globalThis.btoa = x => Buffer.from(x, 'binary').toString('base64');

function qDeps({ failFirst = 0, translateCost = 0.01, chunkCost = 0.02 } = {}) {
  let fails = failFirst;
  const seen = { prepared: 0, transcribed: [], translated: 0 };
  return {
    seen,
    prepare: async (file, o) => {
      seen.prepared++;
      const chunks = [
        { start: 0, duration: 70, index: 0 },
        { start: 70, duration: 70, index: 1 },
        { start: 140, duration: 60, index: 2, isSilent: true }
      ];
      for (const c of chunks) if (!c.isSilent) await o.onChunk?.(c, new Uint8Array([1]));
      return { duration: 200, silences: [], chunks, skipped: 1 };
    },
    transcribe: async (chunk) => {
      if (fails-- > 0) { const e = new Error('busy'); e.status = 429; e.retryable = true; throw e; }
      seen.transcribed.push(chunk.index);
      return { chunk: chunk.index, start: chunk.start, duration: chunk.duration,
               segments: [{ id: `c${chunk.index}s0`, text: 'κείμενο', start: chunk.start,
                            confidence: 0.9 }], cost: chunkCost };
    },
    translate: async (segs) => {
      seen.translated++;
      return { translations: segs.map(s => ({ id: s.id, en: 'text' })),
               flags: [], dates: [{ id: segs[0]?.id, iso: '1978-03-14' }],
               unresolved: [], cost: translateCost };
    }
  };
}
const newQueue = (extra = {}) => {
  const st = new store.MemoryStore();
  const deps = qDeps(extra.depOpts);
  const events = [];
  const Q = new q.Queue({ store: st, key: 'k', deps,
    on: new Proxy({}, { get: (_t, name) => (...a) => events.push([name, ...a]) }),
    ...extra });
  return { Q, st, deps, events };
};

at('a tape runs end to end and lands on disk', async () => {
  const { Q, st, deps } = newQueue();
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  eq(Q.tapes[0].state, q.STATE.DONE);
  eq(deps.seen.transcribed, [0, 1], 'the silent chunk is never transcribed');
  eq(deps.seen.translated, 1);
  ok(await st.exists(store.paths.translation('t1')), 'translation written');
  ok(await st.exists(store.paths.flags('t1')), 'flags written');
});

at('cost accumulates across both stages and per tape', async () => {
  const { Q } = newQueue();
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  close(Q.spent, 0.05, 1e-9, 'two chunks at 0.02 plus 0.01 translation');
  close(Q.tapes[0].cost, 0.05, 1e-9);
});

at('the spend ceiling pauses the run instead of quietly overspending', async () => {
  const { Q, events } = newQueue({ spendCap: 0.03 });
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  Q.add({ id: 't2', file: { name: 'b.wav' } });
  await Q.start();
  ok(events.some(e => e[0] === 'capped'), 'must announce hitting the ceiling');
  ok(Q.paused, 'and stop');
  ok(Q.tapes[1].state !== q.STATE.DONE, 'the second tape must not have run');
});

at('a retryable failure is retried and then succeeds', async () => {
  const { Q, events } = newQueue({ depOpts: { failFirst: 2 } });
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  eq(Q.tapes[0].state, q.STATE.DONE, 'a 429 must not fail the tape');
  ok(events.some(e => e[0] === 'retry'), 'and should say it is retrying');
});

at('resuming re-does nothing that is already on disk', async () => {
  const { Q, st, deps } = newQueue();
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  const firstPass = deps.seen.transcribed.length;

  // Same folder, fresh queue -- as if the browser had been restarted.
  const deps2 = qDeps();
  const Q2 = new q.Queue({ store: st, key: 'k', deps: deps2, on: {} });
  Q2.add({ id: 't1', file: { name: 'a.wav' } });
  await Q2.start();
  eq(deps2.seen.transcribed.length, 0, 'nothing already transcribed may be paid for twice');
  eq(deps2.seen.prepared, 0, 'and the audio must not be re-split');
  eq(firstPass, 2);
});

at('a crash mid-tape resumes at the missing chunk, not from the start', async () => {
  const st = new store.MemoryStore();
  // Chunk 0 committed, chunk 1 never written.
  await st.write(store.paths.chunkAudio('t1', 0), new Uint8Array([1]));
  await st.write(store.paths.chunkAudio('t1', 1), new Uint8Array([1]));
  await store.saveChunkText(st, 't1', { chunk: 0, segments: [{ id: 'c0s0', text: 'x' }], cost: 0 });
  await st.writeJSON(store.paths.tape('t1'), { id: 't1', duration: 200,
    plan: [{ start: 0, duration: 70 }, { start: 70, duration: 70 }] });

  const deps = qDeps();
  const Q = new q.Queue({ store: st, key: 'k', deps, on: {} });
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  eq(deps.seen.transcribed, [1], 'only the missing chunk is redone');
});

at('a second tab becomes read-only instead of double-billing', async () => {
  const { Q, events } = newQueue();
  // Simulate the lock already being held elsewhere.
  navStub.locks = { request: (_n, _o, cb) => Promise.resolve(cb(null)) };
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  delete navStub.locks;
  ok(Q.readOnly, 'the second tab must not write');
  ok(events.some(e => e[0] === 'readOnly'));
  eq(Q.tapes[0].state, q.STATE.QUEUED, 'and must not process anything');
});

at('pausing stops before the next tape', async () => {
  const { Q } = newQueue();
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  Q.add({ id: 't2', file: { name: 'b.wav' } });
  Q.on = { done: () => Q.pause() };
  await Q.start();
  eq(Q.tapes[0].state, q.STATE.DONE);
  ok(Q.tapes[1].state !== q.STATE.DONE, 'the queue must honour a pause between tapes');
});

at('a failing tape is recorded and the queue carries on', async () => {
  const { Q, st } = newQueue();
  const bad = new q.Queue({ store: st, key: 'k', on: {},
    deps: { ...qDeps(), prepare: async () => { throw new Error('boom'); } } });
  bad.add({ id: 't1', file: { name: 'a.wav' } });
  bad.add({ id: 't2', file: { name: 'b.wav' } });
  bad.deps.prepare = async (f) => {
    if (f.name === 'a.wav') throw new Error('boom');
    return { duration: 10, silences: [], chunks: [], skipped: 0 };
  };
  await bad.start();
  eq(bad.tapes[0].state, q.STATE.FAILED);
  ok(bad.tapes[0].error && !/boom/.test(bad.tapes[0].error), 'raw errors must not surface');
  ok(bad.tapes[1].state !== q.STATE.QUEUED, 'one bad tape must not stop the rest');
});

// ---------------------------------------------- checklist + progress persistence
//
// The bug this section guards against: a recording sat forever at "Waiting" with no
// indication anything was happening, because progress lived only in memory and was never
// written to disk -- so a reload (or just leaving the run screen) made it look stalled
// with no way to tell what stage it was on or continue it.

at('stepIndex orders the checklist and knows before/after', async () => {
  eq(q.STEPS.map(s => s.key), [q.STATE.PREPARING, q.STATE.READING, q.STATE.TRANSLATING]);
  eq(q.stepIndex(q.STATE.QUEUED), -1, 'nothing has started yet');
  eq(q.stepIndex(q.STATE.PREPARING), 0);
  eq(q.stepIndex(q.STATE.READING), 1);
  eq(q.stepIndex(q.STATE.TRANSLATING), 2);
  eq(q.stepIndex(q.STATE.DONE), q.STEPS.length, 'past every step');
});

at('a stage transition persists to disk immediately, not just in memory', async () => {
  const st = new store.MemoryStore();
  const deps = qDeps();
  const Q = new q.Queue({ store: st, key: 'k', deps, on: {} });
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  const onDisk = await st.readJSON(store.paths.tape('t1'));
  eq(onDisk.state, q.STATE.DONE, 'the final state must be on disk, not only in the Queue object');
  eq(onDisk.progress, 1);
});

at('progress reaches disk mid-run, not only at the very end', async () => {
  const st = new store.MemoryStore();
  const seenProgress = [];
  const deps = {
    ...qDeps(),
    prepare: async (file, o) => {
      // Simulate ffmpeg reporting progress chunk by chunk, exactly like the real module.
      const chunks = [{ start: 0, duration: 70, index: 0 }, { start: 70, duration: 70, index: 1 }];
      for (let i = 0; i < chunks.length; i++) {
        await o.onChunk?.(chunks[i], new Uint8Array([1]));
        o.onProgress?.(i + 1, chunks.length);
      }
      return { duration: 140, silences: [], chunks, skipped: 0 };
    }
  };
  // persistIntervalMs: 0 so every tick is written -- isolates "does it reach disk at all"
  // from the separate throttle test below.
  const Q = new q.Queue({ store: st, key: 'k', deps, persistIntervalMs: 0,
    on: { progress: (t, p) => seenProgress.push(p) } });
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  ok(seenProgress.some(p => p > 0 && p < 1), 'expected an intermediate progress value');
  // Read the disk state that would have been visible mid-run by re-deriving what a Queue
  // sees fresh from disk after a "reload" -- reconcile must already show partial work,
  // independent of anything the finished run wrote afterwards.
  const { done } = await store.reconcile(st, 't1');
  eq(done.length, 2, 'chunk-level progress must be visible on disk too, not just the number');
});

at('the progress-only write is throttled, but a stage change is not', async () => {
  const st = new store.MemoryStore();
  let clock = 0;
  const writes = [];
  const realUpdate = store.updateTape;
  const deps = {
    ...qDeps(),
    prepare: async (file, o) => {
      const chunks = [{ start: 0, duration: 10, index: 0 }];
      await o.onChunk?.(chunks[0], new Uint8Array([1]));
      // Many rapid ticks -- as a busy chunking stage might actually produce.
      for (let i = 0; i < 10; i++) { o.onProgress?.(i + 1, 10); clock += 10; }
      return { duration: 10, silences: [], chunks, skipped: 0 };
    }
  };
  const Q = new q.Queue({ store: st, key: 'k', deps, now: () => clock,
    persistIntervalMs: 1200, on: {} });
  const origWrite = st.writeJSON.bind(st);
  st.writeJSON = async (path, obj) => { if (path.endsWith('tape.json')) writes.push(obj.progress); return origWrite(path, obj); };
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  // 10 ticks at +10ms apart (100ms total) must not each hit disk under a 1200ms throttle;
  // stage transitions (PREPARING entry, READING entry, TRANSLATING entry, DONE) still must.
  ok(writes.length < 10, `throttle should have suppressed most of 10 rapid ticks, got ${writes.length}`);
  ok(writes.length >= 3, `stage transitions must still always persist, got ${writes.length}`);
});

at('a failed tape is marked on disk, not left looking like it is still working', async () => {
  const st = new store.MemoryStore();
  const deps = { ...qDeps(), prepare: async () => { throw new Error('boom'); } };
  const Q = new q.Queue({ store: st, key: 'k', deps, on: {} });
  Q.add({ id: 't1', file: { name: 'a.wav' } });
  await Q.start();
  const onDisk = await st.readJSON(store.paths.tape('t1'));
  eq(onDisk.state, q.STATE.FAILED);
  ok(onDisk.error, 'the reason must be readable after a reload, not just in the dead Queue object');
});

at('a fresh Queue against the same folder continues exactly where an abandoned one stopped', async () => {
  // Simulates closing the tab (or the run screen) mid-processing: the old Queue object is
  // simply gone, nothing calls stop() on it. A second Queue is then built against the same
  // store, as "Continue" would do, and must not redo or lose anything.
  const st = new store.MemoryStore();
  const deps1 = qDeps();
  const Q1 = new q.Queue({ store: st, key: 'k', deps: deps1,
    on: { progress: (t, p) => { if (p > 0.25 && p < 0.9) Q1._abort.aborted = true; } } });
  Q1.add({ id: 't1', file: { name: 'a.wav' } });
  await Q1.start();

  const mid = await st.readJSON(store.paths.tape('t1'));
  ok(mid.state === q.STATE.READING || mid.state === q.STATE.PREPARING,
     'must have stopped partway through, got ' + mid.state);

  const deps2 = qDeps();
  const Q2 = new q.Queue({ store: st, key: 'k', deps: deps2, on: {} });
  Q2.add({ id: 't1', file: { name: 'a.wav' } });
  await Q2.start();

  eq(deps2.seen.prepared, 0, 'audio already on disk must not be re-split');
  const final = await st.readJSON(store.paths.tape('t1'));
  eq(final.state, q.STATE.DONE);
});

// ---------------------------------------------------------------- library.js
//
// These are the decisions behind the checklist and the "why is it stuck at Waiting" fix:
// what the banner says, and what clicking an unfinished tape tells her.

const workingTape = (over = {}) => ({ id: 't1', label: 'Side A', status: 'working',
  stepIdx: 1, progress: 0.4, ...over });

at('miniSteps marks done, current, and pending steps distinctly', async () => {
  const html = lib.miniSteps(workingTape({ stepIdx: 1 }));
  ok(html.includes('done">✓ Splitting into pieces'), html);
  ok(html.includes('current">● Listening to it'), html);
  ok(html.includes('">○ Putting it into English'), html);
});

at('miniSteps at the very first step has nothing marked done yet', async () => {
  const html = lib.miniSteps(workingTape({ stepIdx: 0 }));
  ok(!html.includes('done'), 'nothing should be checked off before the first step finishes');
  ok(html.includes('current">● Splitting into pieces'));
});

at('the banner shows live progress only when a queue is actually running', async () => {
  const tapes = [workingTape()];
  eq(lib.libraryBannerState(tapes, true).kind, 'running');
  eq(lib.libraryBannerState(tapes, true).tape.id, 't1');
});

at('the banner offers to continue when nothing is running but work remains', async () => {
  // This is the exact bug: closing the tab (or reloading) mid-run leaves a tape looking
  // identical to one that is actively being processed, unless "is anything running right
  // now" is asked separately from "is this tape done".
  const tapes = [workingTape(), { id: 't2', status: 'queued', label: 'Side B' }];
  const banner = lib.libraryBannerState(tapes, false);
  eq(banner.kind, 'stalled');
  eq(banner.tapes.map(t => t.id), ['t1', 't2']);
});

at('the banner says nothing when everything is done or nothing is running and nothing waits', async () => {
  eq(lib.libraryBannerState([{ id: 't1', status: 'done' }], false).kind, 'none');
  eq(lib.libraryBannerState([], true).kind, 'none');
});

at('a finished tape is never swept back into the resume banner', async () => {
  eq(lib.libraryBannerState([{ id: 't1', status: 'done' }], false).kind, 'none');
  // An errored one, by contrast, SHOULD be offered -- retrying is nearly free and the
  // alternative is a dead end with no way forward but re-recording.
  const b = lib.libraryBannerState([{ id: 't1', status: 'done' }, { id: 't2', status: 'error' }], false);
  eq(b.kind, 'stalled');
  eq(b.tapes.map(t => t.id), ['t2'], 'only the errored one, never the finished one');
});

at('clicking a working tape names the actual current step, not a flat "not ready"', async () => {
  const msg = lib.tapeClickMessage(workingTape({ stepIdx: 1, progress: 0.4 }));
  ok(/listening to it/i.test(msg), msg);
  ok(/40%/.test(msg), msg);
});

at('the failure reason stays visible on the card, not only in a toast', async () => {
  // Clicking a failed tape now retries it, so the reason cannot live in the click message
  // alone -- it has to remain readable afterwards.
  const note = lib.tapeErrorNote({ status: 'error', label: 'Side A', error: 'NO CREDIT' });
  eq(note.reason, 'NO CREDIT');
  ok(/try again/i.test(note.action), note.action);
  eq(lib.tapeErrorNote({ status: 'working' }), null, 'nothing to say when it has not failed');
});

at('a failure with no recorded reason still says something', async () => {
  const note = lib.tapeErrorNote({ status: 'error', label: 'Side A' });
  ok(note.reason && !/undefined|null/.test(note.reason), note.reason);
});

at('clicking a queued tape that never started says so plainly', async () => {
  const msg = lib.tapeClickMessage({ status: 'queued', label: 'Side A' });
  ok(/hasn't started/i.test(msg), msg);
});

// ------------------------------------------------- retrying after a failure
//
// The question this answers: when something goes wrong, does she have to re-record?
// No -- the audio and every finished chunk stay on disk, so a retry only does the work
// that had not happened yet.

at('a failed tape is resumable, not a dead end', async () => {
  eq(lib.isResumable({ status: 'error' }), true, 'a failure must be retryable');
  eq(lib.isResumable({ status: 'working' }), true);
  eq(lib.isResumable({ status: 'queued' }), true);
  eq(lib.isResumable({ status: 'done' }), false, 'finished work is not "outstanding"');
});

at('the banner offers to retry when something failed', async () => {
  const b = lib.libraryBannerState([{ id: 't1', status: 'error', label: 'A' }], false);
  eq(b.kind, 'stalled');
  eq(b.failed, 1);
  eq(b.unfinished, 0);
  ok(/ran into a problem/i.test(lib.stalledMessage(b)), lib.stalledMessage(b));
  ok(/nothing is lost/i.test(lib.stalledMessage(b)), 'must say the audio is still there');
});

at('the banner distinguishes an interruption from a failure', async () => {
  const interrupted = lib.libraryBannerState([{ id: 't1', status: 'queued' }], false);
  ok(/didn't finish/i.test(lib.stalledMessage(interrupted)));
  ok(!/problem/i.test(lib.stalledMessage(interrupted)), 'an interruption is not an error');
});

at('the banner covers a mix of failed and merely interrupted', async () => {
  const b = lib.libraryBannerState(
    [{ id: 't1', status: 'error' }, { id: 't2', status: 'queued' }, { id: 't3', status: 'done' }],
    false);
  eq(b.failed, 1);
  eq(b.unfinished, 1);
  eq(b.tapes.length, 2, 'the finished one is not swept back in');
  const msg = lib.stalledMessage(b);
  ok(/problem/i.test(msg) && /interrupted/i.test(msg), msg);
});

at('clicking a failed tape says it is retrying, not just what broke', async () => {
  const msg = lib.tapeClickMessage({ status: 'error', label: 'Side A', error: 'NO CREDIT' });
  ok(/trying/i.test(msg) && /again/i.test(msg), msg);
});

at('retrying a failed tape redoes only the work that never happened', async () => {
  const st = new store.MemoryStore();

  // First run fails during translation, after every chunk has been transcribed.
  const deps1 = { ...qDeps(), translate: async () => { throw new Error('network died'); } };
  const Q1 = new q.Queue({ store: st, key: 'k', deps: deps1, on: {} });
  Q1.add({ id: 't1', file: { name: 'a.wav' } });
  await Q1.start();

  const failed = await st.readJSON(store.paths.tape('t1'));
  eq(failed.state, q.STATE.FAILED);
  ok(failed.error, 'the reason is recorded');
  const { done } = await store.reconcile(st, 't1');
  eq(done.length, 3, 'all three chunks were transcribed before it broke');

  // Retry with a working translator, exactly as the Try again button does.
  const deps2 = qDeps();
  const Q2 = new q.Queue({ store: st, key: 'k', deps: deps2, on: {} });
  Q2.add({ id: 't1', file: { name: 'a.wav' } });
  await Q2.start();

  eq(deps2.seen.prepared, 0, 'the audio must not be re-split');
  eq(deps2.seen.transcribed, [], 'and nothing already transcribed may be paid for twice');
  eq(deps2.seen.translated, 1, 'only the step that failed is redone');
  eq((await st.readJSON(store.paths.tape('t1'))).state, q.STATE.DONE);
});

at('a retry that fails again is still retryable, not stuck', async () => {
  const st = new store.MemoryStore();
  const broken = { ...qDeps(), prepare: async () => { throw new Error('still broken'); } };
  const Q1 = new q.Queue({ store: st, key: 'k', deps: broken, on: {} });
  Q1.add({ id: 't1', file: { name: 'a.wav' } });
  await Q1.start();
  const Q2 = new q.Queue({ store: st, key: 'k', deps: broken, on: {} });
  Q2.add({ id: 't1', file: { name: 'a.wav' } });
  await Q2.start();
  const t = await st.readJSON(store.paths.tape('t1'));
  eq(t.state, q.STATE.FAILED);
  eq(lib.isResumable({ status: 'error' }), true, 'a repeated failure must not become permanent');
});

at('humanError never shows an HTTP status to her', async () => {
  eq(q.humanError({ status: 401 }), 'That access key was refused. Check Settings.');
  ok(/busy/.test(q.humanError({ status: 429 })));
  ok(/internet/.test(q.humanError(new Error('Failed to fetch'))));
  const generic = q.humanError(new Error('TypeError: undefined is not a function'));
  ok(!/undefined|TypeError|[0-9]{3}/.test(generic), 'got: ' + generic);
});

at('glossary terms are ordered by how often they were heard', async () => {
  eq(q.glossaryTerms([{ greek: 'Α', heard: 3 }, { greek: 'Β', heard: 40 }, { greek: 'Γ', heard: 9 }]),
     ['Β', 'Γ', 'Α'], 'the 224-token bias prompt should carry the most common names');
});

at('collectSegments skips a chunk that never transcribed rather than failing', async () => {
  const st = new store.MemoryStore();
  await store.saveChunkText(st, 't1', { chunk: 0, start: 0, segments: [{ id: 'c0s0', text: 'a' }] });
  const segs = await q.collectSegments(st, 't1', [{}, {}, {}]);
  eq(segs.length, 1, 'missing chunks contribute nothing and do not throw');
});

// ---------------------------------------------------------------- entry.js

async function seedTape(st, { translated = true, dropId = null, flags = [] } = {}) {
  await st.writeJSON(store.paths.tape('t1'), {
    id: 't1', label: 'Μάρτιος 1978', side: 'A',
    plan: [{ start: 0, duration: 70 }, { start: 70, duration: 70 }],
    dates: [{ id: 'c0s0', iso: '1978-03-14' }]
  });
  await store.saveChunkText(st, 't1', { chunk: 0, start: 0, segments: [
    { id: 'c0s0', text: 'Ήρθε ο Κώστας.', start: 3, confidence: 0.9 },
    { id: 'c0s1', text: 'Έβρεχε όλη μέρα.', start: 12, confidence: 0.5 }] });
  await store.saveChunkText(st, 't1', { chunk: 1, start: 70, segments: [
    { id: 'c1s0', text: 'Πήγα στην Αθήνα.', start: 74, confidence: 0.95 }] });
  if (translated) {
    await st.writeJSON(store.paths.translation('t1'), { translations: [
      { id: 'c0s0', en: 'Costas came.' },
      { id: 'c0s1', en: dropId === 'c0s1' ? null : 'It rained all day.' },
      { id: 'c1s0', en: 'I went to Athens.' }], unresolved: dropId ? [dropId] : [] });
  }
  if (flags.length) await st.writeJSON(store.paths.flags('t1'), flags);
  return st;
}

at('formatHeading renders a full date, and degrades for partial ones', async () => {
  eq(entry.formatHeading('1978-03-14'), 'Tuesday, 14 March 1978');
  eq(entry.formatHeading('1978-03'), 'March 1978');
  eq(entry.formatHeading('1978'), '1978');
  eq(entry.formatHeading(null), null);
});

at('loadEntry joins Greek, English and flags by segment id', async () => {
  const st = await seedTape(new store.MemoryStore(),
    { flags: [{ id: 'c0s1', guess: 'all day' }] });
  const e = await entry.loadEntry(st, 't1');
  eq(e.heading, 'Tuesday, 14 March 1978');
  eq(e.segments.length, 3);
  eq(e.segments[0].en, 'Costas came.');
  eq(e.segments[0].gr, 'Ήρθε ο Κώστας.');
  eq(e.segments[2].chunk, 1);
  eq(e.segments[2].chunkStart, 70, 'playback needs the chunk offset, not just the segment time');
  eq(e.segments[1].unsure, 'all day');
});

at('a dropped translation shows the Greek, never an empty line', async () => {
  const st = await seedTape(new store.MemoryStore(), { dropId: 'c0s1' });
  const e = await entry.loadEntry(st, 't1');
  const seg = e.segments.find(s => s.id === 'c0s1');
  eq(seg.untranslated, true);
  eq(seg.en, null);
  ok(seg.gr, 'the Greek must still be there to render -- a blank reads as him saying nothing');
});

at('loadEntry works on a tape transcribed but not yet translated', async () => {
  const st = await seedTape(new store.MemoryStore(), { translated: false });
  const e = await entry.loadEntry(st, 't1');
  eq(e.segments.length, 3);
  ok(e.segments.every(s => s.untranslated), 'all untranslated, none thrown away');
});

at('loadEntry on an unknown tape returns an empty entry rather than throwing', async () => {
  const e = await entry.loadEntry(new store.MemoryStore(), 'nope');
  eq(e.segments, []);
  eq(e.heading, null);
});

at('confirming a rename rewrites the English on disk and logs an audit', async () => {
  const st = await seedTape(new store.MemoryStore());
  const g = { id: 'kostas', greek: 'Κώστας', canonical_greek: 'Κώστας',
              observed_forms: ['Κώστα'], english: 'Kostas' };
  const r = await entry.applyCorrectionAcross(st, ['t1'], g, 'Costas', 'Kostas');
  const t = await st.readJSON(store.paths.translation('t1'));
  eq(t.translations.find(x => x.id === 'c0s0').en, 'Kostas came.');
  eq(t.translations.find(x => x.id === 'c0s0').enOriginal, 'Costas came.',
     'the original must be kept so a bad correction is reversible');
  eq(t.translations.find(x => x.id === 'c1s0').en, 'I went to Athens.', 'untouched lines stay');
  const log = await st.readJSON('corrections.json');
  eq(log.length, 1);
  eq(log[0].tape, 't1');
  ok(/updated in 1 place/.test(r.summary), r.summary);
});

at('a correction that costs nothing says so and writes no audit', async () => {
  const st = await seedTape(new store.MemoryStore());
  const g = { id: 'k', greek: 'Κώστας', canonical_greek: 'Κώστας', english: 'Costas' };
  const r = await entry.applyCorrectionAcross(st, ['t1'], g, 'Costas', 'Costas');
  eq(r.tapes, 0, 'confirming the guess touches no tape');
  eq(await st.exists('corrections.json'), false);
});

at('a tier-2 sentence is re-read, and only that sentence', async () => {
  const st = new store.MemoryStore();
  await st.writeJSON(store.paths.tape('t1'), { id: 't1', label: 'x',
    plan: [{ start: 0, duration: 70 }], dates: [] });
  await store.saveChunkText(st, 't1', { chunk: 0, start: 0, segments: [
    { id: 'c0s0', text: 'Ήρθε ο Γκόστα σήμερα.', start: 1, confidence: 0.4 },
    { id: 'c0s1', text: 'Έβρεχε.', start: 9, confidence: 0.9 }] });
  await st.writeJSON(store.paths.translation('t1'), { translations: [
    { id: 'c0s0', en: 'The cost came today.' },      // the name was read as a common word
    { id: 'c0s1', en: 'It rained.' }], unresolved: [] });

  const asked = [];
  const g = { id: 'kostas', greek: 'Κώστας', canonical_greek: 'Κώστας',
              observed_forms: ['Γκόστα'], english: 'Kostas' };
  const r = await entry.applyCorrectionAcross(st, ['t1'], g, 'Costas', 'Kostas', {
    translate: async segs => {
      asked.push(...segs.map(s => s.id));
      return { translations: segs.map(s => ({ id: s.id, en: 'Kostas came today.' })), cost: 0.0002 };
    }
  });
  eq(asked, ['c0s0'], 'only the broken sentence is re-read, never the batch or the tape');
  const t = await st.readJSON(store.paths.translation('t1'));
  eq(t.translations.find(x => x.id === 'c0s0').en, 'Kostas came today.');
  eq(t.translations.find(x => x.id === 'c0s1').en, 'It rained.', 'the other line is untouched');
  ok(/re-read/.test(r.summary), r.summary);
});

at('a failed re-read leaves the original text alone rather than blanking it', async () => {
  const st = new store.MemoryStore();
  await st.writeJSON(store.paths.tape('t1'), { id: 't1', plan: [{ start: 0, duration: 70 }] });
  await store.saveChunkText(st, 't1', { chunk: 0, start: 0,
    segments: [{ id: 'c0s0', text: 'Ήρθε ο Γκόστα.', start: 1 }] });
  await st.writeJSON(store.paths.translation('t1'),
    { translations: [{ id: 'c0s0', en: 'The cost came.' }], unresolved: [] });

  const g = { id: 'k', greek: 'Κώστας', canonical_greek: 'Κώστας',
              observed_forms: ['Γκόστα'], english: 'Kostas' };
  const r = await entry.applyCorrectionAcross(st, ['t1'], g, 'Costas', 'Kostas',
    { translate: async () => { throw new Error('offline'); } });
  eq(r.failed, 1);
  const t = await st.readJSON(store.paths.translation('t1'));
  eq(t.translations[0].en, 'The cost came.', 'a failed re-read must not destroy what was there');
});

at('answering several names is one merged sweep across tapes', async () => {
  const st = await seedTape(new store.MemoryStore());
  await st.writeJSON(store.paths.tape('t2'), { id: 't2', label: 'b',
    plan: [{ start: 0, duration: 70 }], dates: [] });
  await store.saveChunkText(st, 't2', { chunk: 0, start: 0,
    segments: [{ id: 'd0s0', text: 'Ο Κώστας ήρθε.', start: 2 }] });
  await st.writeJSON(store.paths.translation('t2'),
    { translations: [{ id: 'd0s0', en: 'Costas arrived.' }], unresolved: [] });

  const g = { id: 'k', greek: 'Κώστας', canonical_greek: 'Κώστας', english: 'Kostas' };
  const r = await entry.applyCorrectionAcross(st, ['t1', 't2'], g, 'Costas', 'Kostas');
  eq(r.tapes, 2, 'both tapes mentioning him are swept in one pass');
  eq((await st.readJSON(store.paths.translation('t2'))).translations[0].en, 'Kostas arrived.');
  eq((await st.readJSON('corrections.json')).length, 2);
});

at('playback releases the previous blob URL before making a new one', async () => {
  const made = [], freed = [];
  let n = 0;
  const src = entry.makeAudioSource({
    createURL: () => { const u = 'blob:' + (++n); made.push(u); return u; },
    revokeURL: u => freed.push(u)
  });
  src.use({}); src.use({}); src.use({});
  eq(made, ['blob:1', 'blob:2', 'blob:3']);
  eq(freed, ['blob:1', 'blob:2'], 'each URL is freed when the next is made');
  src.release();
  eq(freed, ['blob:1', 'blob:2', 'blob:3'], 'and the last on release');
  eq(src.current, null);
});

at('releasing twice is harmless', async () => {
  const freed = [];
  const src = entry.makeAudioSource({ createURL: () => 'blob:x', revokeURL: u => freed.push(u) });
  src.use({}); src.release(); src.release();
  eq(freed, ['blob:x']);
});

// --------------------------------------------------------------- record.js

// This is the single most important assertion in this file. getUserMedia defaults all
// three of these ON, tuned for phone calls, and each one actively damages a recording of
// a cassette player: noise suppression eats steady tape hiss along with the quiet speech
// buried in it, gain control pumps between pauses and speech and confuses the silence
// detection the chunker relies on, and echo cancellation can attenuate the very sound we
// are trying to capture, since it is coming from a speaker in the same room.
at('microphone processing is switched OFF — hiss is signal here, not noise', async () => {
  const c = rec.audioConstraints().audio;
  eq(c.noiseSuppression, false, 'noise suppression would eat tape hiss and quiet speech with it');
  eq(c.autoGainControl, false, 'gain control would pump between pauses and speech');
  eq(c.echoCancellation, false, 'echo cancellation would fight the speaker in the room');
  eq(c.channelCount, 1);
});

at('a chosen input device is requested exactly', async () => {
  const c = rec.audioConstraints('abc123').audio;
  eq(c.deviceId, { exact: 'abc123' });
  eq(c.noiseSuppression, false, 'the processing flags must survive device selection');
});

at('mime selection prefers opus and falls back', async () => {
  eq(rec.pickMimeType(t => t === 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus');
  eq(rec.pickMimeType(t => t === 'audio/mp4'), 'audio/mp4');
  eq(rec.pickMimeType(() => false), '', 'with nothing supported, let the browser decide');
  eq(rec.extensionFor('audio/webm;codecs=opus'), 'webm');
  eq(rec.extensionFor('audio/mp4'), 'm4a');
});

at('analyseLevel reports silence, normal speech and clipping', async () => {
  const tone = (amp, n = 2048) =>
    Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * 440 * i / 48000));
  const quiet = rec.analyseLevel(new Float32Array(2048));
  eq(quiet.silent, true);
  eq(quiet.clipping, false);

  const normal = rec.analyseLevel(tone(0.2));
  eq(normal.silent, false);
  eq(normal.clipping, false);
  ok(normal.db > -30 && normal.db < -6, 'got ' + normal.db);

  const loud = rec.analyseLevel(tone(1.0));
  eq(loud.clipping, true, 'a full-scale signal must be reported as clipping');
});

at('levelToBar maps decibels onto a 0..1 meter', async () => {
  eq(rec.levelToBar(-Infinity), 0);
  eq(rec.levelToBar(-60), 0);
  eq(rec.levelToBar(0), 1);
  close(rec.levelToBar(-30), 0.5, 1e-9);
  eq(rec.levelToBar(20), 1, 'must clamp rather than overflow the bar');
});

// A whole side recorded silently or clipped is 45 minutes she does not get back, so the
// advice has to be plain and act before she walks away.
at('level advice is plain language, and warns before a side is wasted', async () => {
  eq(rec.levelAdvice({ clipping: true, silent: false, db: -3 }).tone, 'bad');
  ok(/turn the player down/i.test(rec.levelAdvice({ clipping: true, db: -3 }).text));
  eq(rec.levelAdvice({ silent: true, clipping: false, db: -80 }).tone, 'bad');
  eq(rec.levelAdvice({ silent: false, clipping: false, db: -50 }).tone, 'warn');
  eq(rec.levelAdvice({ silent: false, clipping: false, db: -20 }, 5).tone, 'ok');
  ok(!/dB|decibel|rms/i.test(rec.levelAdvice({ silent: false, clipping: false, db: -20 }, 5).text),
     'she should never be reading decibels');
});

// Found by feeding real speech through the meter: the advice flipped to "not hearing
// anything yet" on every natural pause, which reads as a fault mid-recording.
at('a pause for breath does not read as silence', async () => {
  let t = 0;
  const sm = rec.makeLevelSmoother({ holdMs: 1500, now: () => t });
  const speech = { db: -18, rms: 0.1, peak: 0.3, clipping: false, silent: false };
  const pause  = { db: -Infinity, rms: 0, peak: 0, clipping: false, silent: true };
  eq(sm(speech).silent, false);
  t += 400;
  eq(sm(pause).silent, false, 'a short gap must not be reported as no sound at all');
  t += 300;
  eq(sm(pause).silent, false);
  t += 2000;
  eq(sm(pause).silent, true, 'but a genuinely quiet room eventually is');
});

at('a brief overload stays flagged long enough to be seen', async () => {
  let t = 0;
  const sm = rec.makeLevelSmoother({ holdMs: 1500, now: () => t });
  eq(sm({ db: -2, clipping: true }).clipping, true);
  t += 300;
  eq(sm({ db: -20, clipping: false }).clipping, true, 'one clean frame must not clear it');
  t += 2000;
  eq(sm({ db: -20, clipping: false }).clipping, false);
});

at('the meter follows the loudest recent moment, not the latest frame', async () => {
  let t = 0;
  const sm = rec.makeLevelSmoother({ holdMs: 1000, now: () => t });
  sm({ db: -10, clipping: false });
  t += 200;
  eq(sm({ db: -50, clipping: false }).db, -10, 'holds the peak');
  t += 1500;
  eq(sm({ db: -50, clipping: false }).db, -50, 'and lets go once the hold expires');
});

at('formatElapsed counts up in minutes and seconds', async () => {
  eq(rec.formatElapsed(0), '0:00');
  eq(rec.formatElapsed(65), '1:05');
  eq(rec.formatElapsed(45 * 60 + 7), '45:07');
});

// --- the recorder itself, against fakes ---

function fakeMedia() {
  const tracks = [{ stop() { tracks.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  return {
    tracks,
    mediaDevices: {
      lastConstraints: null,
      async getUserMedia(c) { this.lastConstraints = c; return stream; },
      async enumerateDevices() {
        return [{ kind: 'audioinput', deviceId: 'a', label: 'Built-in' },
                { kind: 'videoinput', deviceId: 'v', label: 'Camera' },
                { kind: 'audioinput', deviceId: 'b', label: '' }];
      }
    }
  };
}
function FakeMediaRecorder(stream, opts) {
  this.state = 'inactive'; this.mimeType = opts?.mimeType;
  this.start = () => { this.state = 'recording'; FakeMediaRecorder.live = this; };
  this.stop = () => { this.state = 'inactive'; this.onstop?.(); };
  this.emit = data => this.ondataavailable?.({ data });
}
FakeMediaRecorder.isTypeSupported = t => t === 'audio/webm;codecs=opus';

at('listInputs returns only microphones, with a fallback label', async () => {
  const m = fakeMedia();
  const list = await rec.listInputs(m.mediaDevices);
  eq(list.length, 2, 'the camera must not appear');
  eq(list[0].label, 'Built-in');
  ok(list[1].label.length, 'an unlabelled device still needs something to show');
});

at('recording streams each slice out and never accumulates it', async () => {
  const m = fakeMedia();
  const r = new rec.Recorder({ mediaDevices: m.mediaDevices, MediaRecorder: FakeMediaRecorder });
  const written = [];
  const info = await r.start({ onData: async b => written.push(b.size) });
  eq(info.mime, 'audio/webm;codecs=opus');
  eq(info.extension, 'webm');
  eq(m.mediaDevices.lastConstraints.audio.noiseSuppression, false,
     'the real constraints must reach getUserMedia');

  FakeMediaRecorder.live.emit({ size: 1000 });
  FakeMediaRecorder.live.emit({ size: 1200 });
  await new Promise(r2 => setTimeout(r2, 0));
  eq(written, [1000, 1200], 'each slice is handed over as it arrives');

  const out = await r.stop();
  eq(out.bytes, 2200);
  eq(m.tracks.stopped, true, 'the microphone must be released, or the tab keeps listening');
});

at('an empty slice is ignored rather than written', async () => {
  const m = fakeMedia();
  const r = new rec.Recorder({ mediaDevices: m.mediaDevices, MediaRecorder: FakeMediaRecorder });
  const written = [];
  await r.start({ onData: async b => written.push(b.size) });
  FakeMediaRecorder.live.emit({ size: 0 });
  FakeMediaRecorder.live.emit(null);
  await new Promise(r2 => setTimeout(r2, 0));
  eq(written, []);
  await r.stop();
});

at('a failing sink is reported without killing the recording', async () => {
  const m = fakeMedia();
  const r = new rec.Recorder({ mediaDevices: m.mediaDevices, MediaRecorder: FakeMediaRecorder });
  const errs = [];
  await r.start({ onData: async () => { throw new Error('disk full'); },
                  onError: e => errs.push(e.message) });
  FakeMediaRecorder.live.emit({ size: 10 });
  await new Promise(r2 => setTimeout(r2, 0));
  eq(errs, ['disk full']);
  ok(r.recording, 'the tape is still playing; do not silently stop capturing');
  await r.stop();
});

at('the file sink appends at the right offsets and commits on close', async () => {
  const st = new store.MemoryStore();
  const sink = await rec.makeFileSink(st, 'tapes/t1/source.webm');
  await sink.write({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  await sink.write({ arrayBuffer: async () => new Uint8Array([4, 5]).buffer });
  eq(sink.bytes, 5);
  const total = await sink.close();
  eq(total, 5);
  eq((await st.read('tapes/t1/source.webm')).length, 5, 'committed only on close');
});

// A minimal fake <audio> element: enough surface to drive fixStreamedDuration without a
// real DOM. Simulates the Chrome behaviour being worked around -- duration is Infinity
// until currentTime is pushed past the real end, at which point the browser discovers it
// and fires 'timeupdate'.
function fakeAudioEl({ realDuration = 12.4, fireTimeUpdate = true } = {}) {
  const listeners = {};
  return {
    duration: Infinity,
    _currentTime: 0,
    get currentTime() { return this._currentTime; },
    set currentTime(v) {
      this._currentTime = v;
      if (v > 1000) {
        // The browser has scanned to the real end and now knows the duration.
        this.duration = realDuration;
        if (fireTimeUpdate) (listeners['timeupdate'] || []).forEach(fn => fn());
      }
    },
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(f => f !== fn);
    }
  };
}

at('fixStreamedDuration resolves immediately when duration is already finite', async () => {
  const el = fakeAudioEl();
  el.duration = 7.5;
  const d = await rec.fixStreamedDuration(el, { timeoutMs: 50 });
  eq(d, 7.5);
  eq(el.currentTime, 0, 'must not seek at all when nothing was broken');
});

at('fixStreamedDuration recovers the real duration from an Infinity blob', async () => {
  const el = fakeAudioEl({ realDuration: 5.2 });
  const d = await rec.fixStreamedDuration(el, { probeTime: 1e9, timeoutMs: 500 });
  eq(d, 5.2, 'the browser-reported duration after the scan settles');
  eq(el.currentTime, 0, 'playback position must be reset to the start once fixed');
});

at('fixStreamedDuration seeks to the probe offset to trigger the browser scan', async () => {
  const el = fakeAudioEl({ realDuration: 20 });
  await rec.fixStreamedDuration(el, { probeTime: 1e9, timeoutMs: 500 });
  ok(el._currentTime === 0, 'ends at 0, but only after having been pushed past 1e9 to force it');
});

at('fixStreamedDuration falls back on a timeout rather than hanging forever', async () => {
  // A player that never fires timeupdate for the trick -- must not leave the caller stuck.
  const el = fakeAudioEl({ fireTimeUpdate: false });
  const t0 = Date.now();
  await rec.fixStreamedDuration(el, { probeTime: 1e9, timeoutMs: 40 });
  ok(Date.now() - t0 < 500, 'must resolve via the timeout, not wait indefinitely');
});

at('fixStreamedDuration cleans up its listener so it cannot fire twice', async () => {
  const el = fakeAudioEl({ realDuration: 8 });
  await rec.fixStreamedDuration(el, { probeTime: 1e9, timeoutMs: 500 });
  eq(el._currentTime, 0);
  // A second, unrelated seek must not retrigger the removed listener into resetting time.
  el.currentTime = 1e9;
  eq(el._currentTime, 1e9, 'no leftover listener resetting this behind our back');
});

// --- the recordings screen -------------------------------------------------

t('a saved copy is named after the tape, not "source.webm"', () => {
  eq(lib.downloadName({ label: 'Grandpa 1978', side: 'A' }, 'source.webm'),
     'Grandpa 1978 - side A.webm');
  // The extension follows the real file, so a dropped mp3 does not get saved as .webm.
  eq(lib.downloadName({ label: 'Grandpa 1978', side: 'B' }, 'source.mp3'),
     'Grandpa 1978 - side B.mp3');
});

t('a saved copy never carries characters the filesystem will reject', () => {
  const name = lib.downloadName({ label: 'tape 3/4: "the good one" <A>', side: 'A' }, 'source.webm');
  eq(/[\\/:*?"<>|]/.test(name), false, 'no illegal characters survive: ' + name);
  eq(name, 'tape 3 4 the good one A - side A.webm');
});

t('an unlabelled tape still gets a usable filename', () => {
  eq(lib.downloadName({ id: 'tape-004', side: 'A' }, 'source.webm'), 'tape-004 - side A.webm');
  // A label of nothing but punctuation falls back to the id rather than collapsing every
  // such tape onto one name.
  eq(lib.downloadName({ label: '///', id: 'tape-005', side: 'A' }, 'source.webm'),
     'tape-005 - side A.webm');
});

t('a Greek tape label survives as a filename a browser can actually write', () => {
  // Chromium discards the ENTIRE download name if it cannot encode it, saving the file as
  // "download" -- so a folder of Greek-labelled tapes would come out download, download (1),
  // download (2). Transliterating is also simply more useful: she does not read Greek.
  const name = lib.downloadName({ label: 'Μάρτιος 1978 — Α', side: 'A' }, 'source.wav');
  eq(name, 'Martios 1978 - A - side A.wav');
  eq(/^[\x20-\x7e]+$/.test(name), true, 'nothing outside plain ASCII survives: ' + name);
});

t('transliteration keeps case, strips accents, and normalises the dash family', () => {
  eq(lib.toLatin('Θεσσαλονίκη'), 'Thessaloniki');
  eq(lib.toLatin('Ελένη'), 'Eleni');
  eq(lib.toLatin('Κώστας'), 'Kostas');
  eq(lib.toLatin('a – b — c'), 'a - b - c');
  eq(lib.toLatin('already latin'), 'already latin');
});

t('two Greek tapes never transliterate onto the same filename', () => {
  const a = lib.downloadName({ label: 'Μάρτιος 1978 — Α', side: 'A' }, 'source.wav');
  const b = lib.downloadName({ label: 'Απρίλιος 1978 — Α', side: 'A' }, 'source.wav');
  eq(a === b, false, `both tapes would be saved as ${a}`);
});

t('a failed recording is described by what survived, not by the error', () => {
  // The reason to open this screen after a failure is to check the audio is still there,
  // so it says so. The error itself is on the diary card, where the retry lives.
  const note = lib.mediaNote({ status: 'error', error: 'Couldn\'t work out how long this is.' });
  eq(/audio itself is fine/.test(note), true, note);
  eq(note.includes("Couldn't work out"), false, 'the error is not repeated here');
  eq(lib.mediaNote({ status: 'done' }), 'Read and put into English');
  eq(lib.mediaNote({ status: 'queued' }), 'Waiting to be read');
});

t('mediaSummary counts what is readable without hiding what is not', () => {
  eq(lib.mediaSummary([]), '');
  eq(lib.mediaSummary([{ status: 'done' }]), '1 recording.');
  eq(lib.mediaSummary([{ status: 'done' }, { status: 'error' }, { status: 'queued' }]),
     '3 recordings, 1 of them read through so far.');
});

at('the source file is found from the directory listing, not from tape.json', async () => {
  const st = new store.MemoryStore();
  await st.write('tapes/t1/source.mp3', new Uint8Array([1, 2, 3]));
  await st.writeJSON('tapes/t1/tape.json', { id: 't1' });   // crashed before recording the name
  // Trusting the default would look for source.webm and report the audio as missing when
  // it is sitting right there.
  eq(await store.sourceName(st, 't1', 'source.webm'), 'source.mp3');
  eq(await store.sourceName(st, 't1', 'source.mp3'), 'source.mp3');
});

at('a tape whose audio really is gone reports nothing rather than a wrong name', async () => {
  const st = new store.MemoryStore();
  await st.writeJSON('tapes/t2/tape.json', { id: 't2' });
  eq(await store.sourceName(st, 't2', null), null);
});

at('the store can hand back the original recording as a blob to play and save', async () => {
  const st = new store.MemoryStore();
  await st.write('tapes/t1/source.webm', new Uint8Array(2048));
  const f = await st.readBlob(store.paths.source('t1', 'source.webm'));
  eq(f.size, 2048);
  eq(lib.formatSize(f.size), '2 KB');
});

t('file sizes are readable at every scale a tape side reaches', () => {
  eq(lib.formatSize(0), '');
  eq(lib.formatSize(900), '1 KB');
  eq(lib.formatSize(1024 * 1024 * 3.25), '3.3 MB');
  eq(lib.formatSize(1024 * 1024 * 412), '412 MB');
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
