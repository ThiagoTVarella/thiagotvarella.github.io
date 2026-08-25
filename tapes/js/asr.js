// ASR adapter.
//
// Two backends with very different capabilities are normalized to one transcript shape,
// so nothing downstream branches on which model ran:
//
//   MAI-Transcribe (Azure)  best Greek accuracy; plain text ONLY -- OpenRouter rejects
//                           verbose_json for non-OpenAI-compatible providers, and its
//                           `prompt` param is "accepted but ignored".
//   Whisper (Groq)          segment timestamps, per-segment confidence, and working
//                           vocabulary biasing; noticeably weaker on Greek.
//
// Because both transcribe the SAME silence-aware chunk, running both costs no alignment
// machinery -- and their disagreement per chunk becomes the confidence signal MAI lacks.

export const MODES = {
  TEXT:  'text',   // MAI only        -- best words, chunk-level seeking, no confidence
  NAV:   'nav',    // Whisper only    -- sentence seeking + confidence + biasing, rougher words
  CROSS: 'cross'   // both            -- MAI words, Whisper timing, disagreement as confidence
};

export const MODELS = {
  mai:     'microsoft/mai-transcribe-1.5',
  whisper: 'openai/whisper-large-v3'
};

const API = 'https://openrouter.ai/api/v1/audio/transcriptions';

// Whisper's own hallucination thresholds, from the reference implementation.
export const HALLUCINATION = { noSpeechProb: 0.6, avgLogprob: -1.0 };

// Greek sentence terminators. Note ';' is the Greek question mark and '·' the ano teleia.
const SENTENCE_END = /([.;!?·…]+)(\s+|$)/g;

export function splitGreekSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const out = [];
  let last = 0, m;
  SENTENCE_END.lastIndex = 0;
  while ((m = SENTENCE_END.exec(t)) !== null) {
    const piece = t.slice(last, m.index + m[1].length).trim();
    if (piece) out.push(piece);
    last = SENTENCE_END.lastIndex;
  }
  const tail = t.slice(last).trim();
  if (tail) out.push(tail);
  return out.length ? out : [t];
}

const words = s => String(s || '').toLowerCase()
  .replace(/[.,;!?·…"'()\[\]]/g, ' ')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip Greek accents before comparing
  .split(/\s+/).filter(Boolean);

// Word-level Levenshtein, returned as a 0..1 similarity. Used to score how far the two
// models drifted apart on the same audio -- a low score means "one of these is inventing".
export function agreement(a, b) {
  const A = words(a), B = words(b);
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.max(0, 1 - prev[B.length] / Math.max(A.length, B.length));
}

// avg_logprob is roughly -1.5 (garbage) to -0.1 (confident). Keep the raw value and also
// expose a 0..1 form so the UI never has to know Whisper's internals.
const toConfidence = lp => lp == null ? null : Math.max(0, Math.min(1, (lp + 1.2) / 1.1));

export function normalizeMai(res, chunk) {
  const sentences = splitGreekSentences(res && res.text);
  return {
    chunk: chunk.index, start: chunk.start, duration: chunk.duration,
    hasTimestamps: false, hasConfidence: false, agreement: null,
    text: (res && res.text) || '',
    segments: sentences.map((text, i) => ({
      id: `c${chunk.index}s${i}`, text,
      start: null, end: null, confidence: null, logprob: null, suspect: false
    }))
  };
}

export function normalizeWhisper(res, chunk) {
  const segs = (res && res.segments) || [];
  if (!segs.length) {
    const n = normalizeMai(res, chunk);
    n.text = (res && res.text) || '';
    return n;
  }
  return {
    chunk: chunk.index, start: chunk.start, duration: chunk.duration,
    hasTimestamps: true, hasConfidence: true, agreement: null,
    text: (res && res.text) || segs.map(s => s.text).join(' ').trim(),
    segments: segs.map((s, i) => ({
      id: `c${chunk.index}s${i}`,
      text: String(s.text || '').trim(),
      // Chunk-relative times from the model, shifted onto the tape's absolute timeline.
      start: chunk.start + (s.start || 0),
      end: chunk.start + (s.end || 0),
      logprob: s.avg_logprob != null ? s.avg_logprob : null,
      confidence: toConfidence(s.avg_logprob),
      noSpeechProb: s.no_speech_prob != null ? s.no_speech_prob : null,
      suspect: (s.no_speech_prob > HALLUCINATION.noSpeechProb) ||
               (s.avg_logprob != null && s.avg_logprob < HALLUCINATION.avgLogprob)
    }))
  };
}

// Cross-check: MAI supplies the words, Whisper supplies the clock.
//
// The two segment lists don't correspond 1:1, so each MAI sentence is placed by its
// proportional position in the chunk's text and then snapped to the nearest Whisper
// segment boundary. This is an approximation -- accurate to a sentence or so, which is
// all that "click to hear this line" needs. Chunk-level `agreement` is the honest signal.
export function crossCheck(mai, whisper, chunk) {
  const score = agreement(mai.text, whisper.text);
  const wsegs = whisper.segments.filter(s => s.start != null);

  if (!wsegs.length) return { ...mai, agreement: score, lowAgreement: score < 0.5 };

  const total = mai.segments.reduce((n, s) => n + s.text.length, 0) || 1;
  let acc = 0;

  const segments = mai.segments.map(seg => {
    const frac = acc / total;
    acc += seg.text.length;
    const fracEnd = acc / total;
    const wantStart = chunk.start + frac * chunk.duration;
    const wantEnd = chunk.start + fracEnd * chunk.duration;

    const near = (t, key) => wsegs.reduce((best, s) =>
      Math.abs(s[key] - t) < Math.abs(best[key] - t) ? s : best, wsegs[0]);

    // Carry the acoustic verdict from whichever Whisper segment covers this moment:
    // MAI cannot tell us a passage was hiss, but Whisper can.
    const cover = wsegs.find(s => s.start <= wantStart && s.end >= wantStart) || near(wantStart, 'start');
    return {
      ...seg,
      start: near(wantStart, 'start').start,
      end: near(wantEnd, 'end').end,
      confidence: cover.confidence,
      logprob: cover.logprob,
      noSpeechProb: cover.noSpeechProb,
      suspect: cover.suspect || score < 0.5,
      approxTiming: true
    };
  });

  return {
    ...mai, segments,
    hasTimestamps: true, hasConfidence: true,
    agreement: score,
    lowAgreement: score < 0.5,
    alt: { model: MODELS.whisper, text: whisper.text }
  };
}

// --- transport -------------------------------------------------------------

function body(model, b64, format, extra) {
  return JSON.stringify(Object.assign(
    { model, input_audio: { data: b64, format }, language: 'el' }, extra));
}

async function call(key, payload, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: payload
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok) {
    const err = new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return json;
}

// Whisper's prompt is capped at 224 tokens, so the glossary cannot all fit. Send the
// most frequent names for this tape, shortest-first to fit the most in.
export function biasPrompt(glossaryTerms, limitChars = 600) {
  const picked = [];
  let used = 0;
  for (const t of (glossaryTerms || [])) {
    if (used + t.length + 2 > limitChars) break;
    picked.push(t); used += t.length + 2;
  }
  return picked.length ? 'Ονόματα: ' + picked.join(', ') : null;
}

export async function transcribeChunk(chunk, opts = {}) {
  const { mode = MODES.CROSS, key, b64, format = 'mp3', glossary = [], fetchImpl, backend } = opts;

  // Silent chunks never reach a model -- this is the primary hallucination guard.
  if (chunk.isSilent) {
    return { chunk: chunk.index, start: chunk.start, duration: chunk.duration,
             hasTimestamps: false, hasConfidence: false, agreement: null,
             skipped: 'silent', text: '', segments: [], cost: 0 };
  }

  const run = backend || (payload => call(key, payload, fetchImpl));
  const bias = biasPrompt(glossary);
  const whisperExtra = {
    response_format: 'verbose_json',
    provider: Object.assign(
      { order: ['groq'], allow_fallbacks: false },
      bias ? { options: { groq: { prompt: bias } } } : {})
  };
  const maiExtra = { response_format: 'json' };

  const cost = r => (r && r.usage && typeof r.usage.cost === 'number') ? r.usage.cost : 0;

  if (mode === MODES.TEXT) {
    const r = await run(body(MODELS.mai, b64, format, maiExtra), MODELS.mai);
    return { ...normalizeMai(r, chunk), cost: cost(r), models: [MODELS.mai] };
  }

  if (mode === MODES.NAV) {
    const r = await run(body(MODELS.whisper, b64, format, whisperExtra), MODELS.whisper);
    return { ...normalizeWhisper(r, chunk), cost: cost(r), models: [MODELS.whisper] };
  }

  // CROSS: both models, same chunk, in parallel.
  const [m, w] = await Promise.all([
    run(body(MODELS.mai, b64, format, maiExtra), MODELS.mai),
    run(body(MODELS.whisper, b64, format, whisperExtra), MODELS.whisper)
  ]);
  const merged = crossCheck(normalizeMai(m, chunk), normalizeWhisper(w, chunk), chunk);
  return { ...merged, cost: cost(m) + cost(w), models: [MODELS.mai, MODELS.whisper] };
}
