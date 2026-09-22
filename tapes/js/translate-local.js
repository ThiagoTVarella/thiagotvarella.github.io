// Translating on her own computer: Helsinki-NLP's opus-mt-tc-big-el-en, a model built for
// exactly one job, Greek into English, run in the page through ONNX Runtime. About 575 MB
// once, no graphics card needed. It is a translator and nothing more: it cannot flag names
// for the Glossary, cannot take her Glossary answers or notes into account, and does not
// reason about a garbled word from context. The setting says all of that in plain words.
//
// What the cloud translator also did, this module replaces mechanically where it can:
// dates are found by pattern, because both listeners write spoken dates as digits with the
// month's name ("14 Μαρτίου 1978"). Nothing else is inferred.
//
// Everything that does not need a browser lives here: the manifest, the generation loop
// against injected sessions, date finding, and the output shaping. The worker in
// translate-worker.js supplies the sessions and the tokenizer.

export const TRANSLATOR = {
  id: 'Helsinki-NLP/opus-mt-tc-big-el-en',
  repo: 'https://huggingface.co/R4kSo1997/opus-mt-el-en-onnx-int8/resolve/main/',
  dir: 'models/opus-mt-tc-big-el-en',
  files: [
    { role: 'tokenizer',  name: 'tokenizer.json',                          bytes: 1753894 },
    { role: 'config',     name: 'tokenizer_config.json',                   bytes: 894 },
    { role: 'encoder',    name: 'encoder_model_quantized.onnx',            bytes: 137541566 },
    { role: 'decoder',    name: 'decoder_model_quantized.onnx',            bytes: 223980417 },
    { role: 'decoderPast', name: 'decoder_with_past_model_quantized.onnx', bytes: 211245550 }
  ],
  // From the export's generation_config.json.
  eos: 25697, pad: 58828, start: 58828, maxTokens: 512
};
export const TRANSLATOR_BYTES = TRANSLATOR.files.reduce((n, f) => n + f.bytes, 0);

// ------------------------------------------------------------------ generation

// Greedy decoding with the split decoder: the first step runs the full decoder and yields
// the encoder's key/values for every layer; later steps run the with-past graph, which
// re-emits only the decoder's own key/values, so the encoder ones are carried across.
// `ids` are the source token ids WITH the end token already appended.
export async function generate(ids, { ort, sessions, eos = TRANSLATOR.eos, pad = TRANSLATOR.pad,
                                      start = TRANSLATOR.start, maxTokens = TRANSLATOR.maxTokens }) {
  const int64 = arr => new ort.Tensor('int64', BigInt64Array.from(arr, BigInt), [1, arr.length]);
  const mask = int64(ids.map(() => 1));
  const enc = await sessions.encoder.run({ input_ids: int64(ids), attention_mask: mask });
  const hidden = enc.last_hidden_state;

  const out = [];
  let r = await sessions.decoder.run({
    encoder_attention_mask: mask, input_ids: int64([start]), encoder_hidden_states: hidden
  });
  const past = {};
  for (const [name, t] of Object.entries(r)) if (name.startsWith('present.')) past[name.replace('present.', 'past_key_values.')] = t;

  for (let step = 0; step < maxTokens; step++) {
    const next = pickNext(r.logits, pad);
    if (next === eos) break;
    out.push(next);
    r = await sessions.decoderPast.run({ encoder_attention_mask: mask, input_ids: int64([next]), ...past });
    for (const [name, t] of Object.entries(r)) if (name.startsWith('present.')) past[name.replace('present.', 'past_key_values.')] = t;
  }
  return out;
}

// The last position's logits, with the padding symbol forbidden as the export's own
// generation config demands (bad_words_ids).
export function pickNext(logits, pad) {
  const V = logits.dims[logits.dims.length - 1];
  const data = logits.data;
  const off = data.length - V;
  let best = -1, bestV = -Infinity;
  for (let i = 0; i < V; i++) {
    if (i === pad) continue;
    const v = data[off + i];
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

// ------------------------------------------------------------------ the translator

export class Translator {
  constructor({ ort, sessions, tokenizer }) {
    this.ort = ort;
    this.sessions = sessions;
    this.tokenizer = tokenizer;
  }
  async translate(greek) {
    const text = String(greek || '').trim();
    if (!text) return '';
    const ids = this.tokenizer.encode(text).ids.slice(0, TRANSLATOR.maxTokens - 1);
    ids.push(TRANSLATOR.eos);
    const out = await generate(ids, { ort: this.ort, sessions: this.sessions });
    return this.tokenizer.decode(out, true).trim();
  }
}

// ------------------------------------------------------------------ dates by pattern

// Genitive month names, the form a spoken date takes ("14 Μαρτίου"), plus the nominative
// for "Μάρτιος 1978". Accents are folded so a listener's spelling slip still matches.
const MONTHS = [
  ['ιανουαρ', 1], ['φεβρουαρ', 2], ['μαρτ', 3], ['απριλ', 4], ['μαι', 5], ['μαϊ', 5],
  ['ιουν', 6], ['ιουλ', 7], ['αυγουστ', 8], ['σεπτεμβρ', 9], ['οκτωβρ', 10],
  ['νοεμβρ', 11], ['δεκεμβρ', 12]
];
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const monthNumber = word => {
  const w = fold(word);
  const hit = MONTHS.find(([stem]) => w.startsWith(stem));
  return hit ? hit[1] : null;
};
const pad2 = n => String(n).padStart(2, '0');

// Finds "14 Μαρτίου 1978", "Μάρτιος 1978" and "14 Μαρτίου" (no year) in one segment's text.
// Only what is written; a day without a year gives a partial date, never a guessed year.
export function findDates(text) {
  const out = [];
  // A day or a year is a whole number: "19708" is a listener's slip, not March 1970.
  const re = /(?:(?<!\d)(\d{1,2})\s+)?([\u0370-\u03ff\u1f00-\u1fff]{3,})(?:\s+(\d{4})(?!\d))?/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const month = monthNumber(m[2]);
    if (!month) continue;
    const day = m[1] ? +m[1] : null, year = m[3] ? +m[3] : null;
    if (day != null && (day < 1 || day > 31)) continue;
    if (day == null && year == null) continue;
    const iso = year != null
      ? (day != null ? `${year}-${pad2(month)}-${pad2(day)}` : `${year}-${pad2(month)}`)
      : null;
    if (!iso) continue;   // "14 Μαρτίου" alone cannot be placed in the calendar
    out.push({ spoken: m[0].trim(), iso });
  }
  return out;
}

// ------------------------------------------------------------------ the stage

// Same shape as translateAll() in translate.js, so the queue cannot tell them apart:
// translations by id, flags (always empty here), dates found by pattern, unresolved ids,
// and a cost of nothing.
export async function translateSegments(segments, translator, { onProgress, signal } = {}) {
  const out = { translations: [], flags: [], dates: [], unresolved: [], cost: 0 };
  let done = 0;
  for (const seg of segments) {
    if (signal?.aborted) break;
    try {
      const en = await translator.translate(seg.text);
      out.translations.push({ id: seg.id, en });
    } catch (e) {
      out.unresolved.push(seg.id);
    }
    for (const d of findDates(seg.text)) out.dates.push({ id: seg.id, ...d });
    done++;
    onProgress?.(done, segments.length);
  }
  return out;
}

export function describeTranslatorDownload(bytes = TRANSLATOR_BYTES) {
  return `about ${Math.round(bytes / 1e6 / 10) * 10} MB`;
}
