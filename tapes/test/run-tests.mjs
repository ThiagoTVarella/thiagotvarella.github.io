// Test suite for the tape digitizer. Runs with plain node, no framework, no network,
// no tapes, no API spend:  node tapes/test/run-tests.mjs
//
// The repo has no test tooling, so this is deliberately dependency-free.

import * as audio from '../js/audio.js';
import * as asr from '../js/asr.js';
import * as store from '../js/store.js';
import * as tr from '../js/translate.js';
import * as gl from '../js/glossary.js';

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
