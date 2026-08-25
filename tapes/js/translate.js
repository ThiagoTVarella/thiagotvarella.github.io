// Translation, flagging, and date extraction -- one model call, three outputs.
//
// She does not read Greek, so she can never proofread this. That shapes everything here:
// the model must tell us what it was unsure of (flags), and it must surface the spoken
// dates, because a diary that cannot be ordered chronologically is just a pile of text.

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
// Model choice is evidence-based, not habit. On GreekMMLU (ACL 2026 Findings, 21,805
// native-Greek questions, 80+ models) Gemini 3 Flash scores 93.16%, ahead of GPT-5.2 at
// 87.75% and GPT-4o at 86.81% -- a Flash-tier model beating every flagship on Greek.
// GreekBarBench agrees independently: Gemini-2.5-Flash 8.4 > GPT-4.1 8.32 >
// Claude-3.7-Sonnet 7.71 (human expert 7.78). Claude was absent from GreekMMLU entirely,
// so it is unevidenced here rather than proven worse -- either way there is no reason to
// default to it.
//
// Caveat: those benchmarks measure Greek COMPREHENSION on CLEAN text. This task is
// generation into English from ASR-garbled Greek, which no public benchmark covers. The
// tool therefore ships an A/B so the real comparison happens on real content: the Greek
// transcripts are stored, so re-translating one tape with another model costs cents and
// the verdict is one she can make herself, since she is judging English prose.
//
// Prices per million tokens, verified Aug 2026.
export const TRANSLATION_MODELS = [
  { id: 'google/gemini-3.7-flash',   label: 'Gemini 3.7 Flash (default)', in: 0.375, out: 1.875,
    note: 'Best-evidenced on Greek and the cheapest. ~$13 per full pass.' },
  { id: 'openai/gpt-5.6-sol',        label: 'GPT-5.6',                    in: 2.00,  out: 10.00,
    note: 'GPT family ranks second on GreekMMLU. ~$70 per full pass.' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5',            in: 2.00,  out: 10.00,
    note: 'Unevidenced on Greek; strong at preserving voice and register.' },
  { id: 'moonshotai/kimi-k3',        label: 'Kimi K3 (open weights)',     in: 2.80,  out: 14.00,
    note: 'Most expensive of these, no Greek evidence. Included for comparison.' }
];
export const DEFAULT_MODEL = 'google/gemini-3.7-flash';

// Deliberately smaller than the 100 the first draft assumed: id-mapped JSON at that size
// reliably drops entries, merges adjacent ones, and invents ids.
export const BATCH = 40;
export const CONTEXT_TAIL = 3;

export function batchSegments(segments, size = BATCH) {
  const out = [];
  for (let i = 0; i < segments.length; i += size) out.push(segments.slice(i, i + size));
  return out;
}

// The glossary is the only mechanism keeping names stable across 300 tapes. Because ASR
// biasing does not reach MAI at all, this prompt is also where mangled forms get repaired.
export function glossaryBlock(entries) {
  if (!entries || !entries.length) return '';
  const lines = entries.map(e => {
    const forms = [e.canonical_greek || e.greek, ...(e.observed_forms || [])].filter(Boolean);
    // `note` is what SHE wrote. Accept the legacy plural spelling too, because reading the
    // wrong key silently drops her knowledge rather than failing loudly.
    const note = (e.note ?? e.notes ?? '').trim();
    // Deliberately no `kind`: it records only whether the tape blurred a word or a phrase,
    // which tells the translator nothing and previously leaked a person/place ontology.
    return `- ${[...new Set(forms)].join(' / ')} => ${e.english}` +
           (note ? `\n    she says: ${note}` : '');
  });
  return `
KNOWN WORDS. Match these across ANY inflected form (Greek declines names:
Κώστας/Κώστα/Κώστᾳ) and across phonetically-close recognition errors
(Γκόστα -> Κώστας). Always render the English exactly as given.

Lines marked "she says" are facts the family told us directly. Treat them as true and
use them to resolve ambiguity — but do not repeat them in the translation, and do not
extend them: if she says someone is his brother, that does not license you to describe
anyone else's relationships.

${lines.join('\n')}
`;
}

export function systemPrompt(glossary, opts = {}) {
  return `You translate a Greek personal audio diary, recorded daily by an elderly man from
the 1970s onward, into English. The audio is degraded cassette tape, so the Greek
transcript you receive contains recognition errors.

Translate faithfully and plainly. Keep his voice; do not smooth it into an essay, do not
summarize, and do not omit anything. Where the Greek is garbled, infer the most plausible
reading from context and flag it rather than silently inventing content.
${glossaryBlock(glossary)}
Return ONLY JSON of this shape:
{
  "translations": [{"id": "<segment id, exactly as given>", "en": "<English>"}],
  "flags": [{"id": "<segment id>", "type": "word"|"phrase",
             "greek": "<the exact Greek span in question>", "guess": "<your best reading>"}],
  "dates": [{"id": "<segment id>", "spoken": "<the date as spoken, in Greek>",
             "iso": "<YYYY-MM-DD, or YYYY-MM, or YYYY if only partly stated>"}]
}

Rules:
- Emit exactly one translation per input id. Never merge, split, drop, or invent ids.
- Flag every proper name the FIRST time it appears in this batch, even if you are
  confident: she does not speak Greek and is relying on these to build a glossary.
- "type" describes only the SHAPE of the problem, never what the thing is: use "word" for a
  single unclear term she could hear and spell back, and "phrase" for a longer stretch the
  tape blurred. Do NOT categorise anything as a person, a place, an organisation, or
  anything else. Κώστας may be a man, a boat, or a name day; Καλαμάτα may be a city or the
  olives. You cannot tell from the audio and neither can we, so do not guess.
- "dates" is for dates he SPEAKS as the date of the entry, not dates merely mentioned.
- Never add explanatory notes about who a person is or how they are related to anyone.
  Translate what he says and nothing more. If he calls someone his wife, that is his
  words and belongs in the translation; do not infer relationships he does not state.
${opts.extra || ''}`;
}

export function userPrompt(batch, tail) {
  const ctx = (tail && tail.length)
    ? `Preceding context (already translated, do NOT re-translate):\n` +
      tail.map(s => `${s.id}: ${s.text}`).join('\n') + '\n\n'
    : '';
  return ctx + 'Translate these segments:\n' +
    batch.map(s => `${s.id}: ${s.text}`).join('\n');
}

// Models wrap JSON in prose or fences often enough that this is not optional.
export function parseJson(content) {
  const s = String(content || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  try { return JSON.parse(body); } catch (e) {}
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(body.slice(a, b + 1)); } catch (e) {} }
  throw new Error('model did not return parseable JSON');
}

// Which ids came back wrong. The repair loop re-requests only these, never the whole batch.
export function validate(batch, parsed) {
  const want = batch.map(s => s.id);
  const got = new Map();
  for (const t of (parsed.translations || [])) {
    if (t && typeof t.id === 'string' && typeof t.en === 'string' && t.en.trim()) {
      if (!got.has(t.id)) got.set(t.id, t.en.trim());
    }
  }
  return {
    missing: want.filter(id => !got.has(id)),
    extra: [...got.keys()].filter(id => !want.includes(id)),
    got
  };
}

async function chat(key, model, messages, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(CHAT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.2,
                           response_format: { type: 'json_object' } })
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

export async function translateBatch(batch, opts = {}) {
  const { key, model = DEFAULT_MODEL, glossary = [], tail = [], fetchImpl,
          backend, maxRepairs = 2 } = opts;
  const send = backend ? (msgs => backend(msgs, model))
                       : (msgs => chat(key, model, msgs, fetchImpl));

  const sys = systemPrompt(glossary, opts);
  let res = await send([{ role: 'system', content: sys },
                        { role: 'user', content: userPrompt(batch, tail) }]);
  let cost = (res && res.usage && res.usage.cost) || 0;
  let parsed = parseJson(res.choices[0].message.content);
  let { missing, got } = validate(batch, parsed);

  const flags = [...(parsed.flags || [])];
  const dates = [...(parsed.dates || [])];

  // Targeted repair: re-ask only for the ids that came back missing.
  for (let attempt = 0; attempt < maxRepairs && missing.length; attempt++) {
    const retry = batch.filter(s => missing.includes(s.id));
    const r = await send([
      { role: 'system', content: sys },
      { role: 'user', content: userPrompt(retry, tail) },
      { role: 'assistant', content: 'I will return exactly one translation per id.' },
      { role: 'user', content: `You omitted these ids: ${missing.join(', ')}. ` +
          `Return JSON with exactly one translation for each, and nothing else.` }
    ]);
    cost += (r && r.usage && r.usage.cost) || 0;
    let p2;
    try { p2 = parseJson(r.choices[0].message.content); } catch (e) { break; }
    for (const [id, en] of validate(retry, p2).got) if (!got.has(id)) got.set(id, en);
    flags.push(...(p2.flags || []));
    dates.push(...(p2.dates || []));
    missing = batch.map(s => s.id).filter(id => !got.has(id));
  }

  return {
    translations: batch.map(s => ({ id: s.id, en: got.get(s.id) ?? null })),
    // Never silently drop a segment: an untranslated id is reported, not hidden.
    unresolved: missing,
    flags: flags.filter(f => f && f.id && batch.some(s => s.id === f.id)),
    dates: dates.filter(d => d && d.id && batch.some(s => s.id === d.id)),
    cost
  };
}

export async function translateAll(segments, opts = {}) {
  const batches = batchSegments(segments, opts.batchSize || BATCH);
  const all = { translations: [], flags: [], dates: [], unresolved: [], cost: 0 };
  let tail = [];
  for (const b of batches) {
    const r = await translateBatch(b, { ...opts, tail });
    all.translations.push(...r.translations);
    all.flags.push(...r.flags);
    all.dates.push(...r.dates);
    all.unresolved.push(...r.unresolved);
    all.cost += r.cost;
    tail = b.slice(-CONTEXT_TAIL);
    if (opts.onProgress) opts.onProgress(all.translations.length, segments.length);
  }
  return all;
}

// Earliest confident date wins as the entry date; a diary tape usually states it up front.
export function dateRange(dates) {
  const iso = (dates || []).map(d => d && d.iso).filter(Boolean).sort();
  return iso.length ? [iso[0], iso[iso.length - 1]] : null;
}

// Translate the same segments with several models so the choice is settled on real
// content instead of benchmarks. Cheap by design: one tape's worth of Greek is already
// on disk, so a 3-model comparison costs cents. She judges the English, which is a
// verdict she is actually qualified to give.
export async function compareModels(segments, models, opts = {}) {
  const sample = segments.slice(0, opts.sampleSize || BATCH);
  const runs = [];
  for (const model of models) {
    try {
      const r = await translateBatch(sample, { ...opts, model });
      runs.push({ model, cost: r.cost, unresolved: r.unresolved.length,
                  translations: r.translations, flags: r.flags.length });
    } catch (e) {
      runs.push({ model, error: e.message, translations: [] });
    }
  }
  // Rows aligned by segment id so the same sentence can be read across models.
  const rows = sample.map(seg => ({
    id: seg.id, greek: seg.text,
    versions: runs.map(r => ({
      model: r.model,
      en: (r.translations.find(t => t.id === seg.id) || {}).en ?? null
    }))
  }));
  return { rows, runs, totalCost: runs.reduce((n, r) => n + (r.cost || 0), 0) };
}
