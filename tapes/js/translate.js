// Translation, flagging, and date extraction -- one model call, three outputs.
//
// She does not read Greek, so she can never proofread this. That shapes everything here:
// the model must tell us what it was unsure of (flags), and it must surface the spoken
// dates, because a diary that cannot be ordered chronologically is just a pile of text.

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
// Greek->English is well served by cheap models, and the Greek transcripts are kept on
// disk, so translation is re-runnable at any time for the price of one pass. That makes
// defaulting cheap the right risk: if the English reads badly, re-run with a better model.
// Spend the money on transcription instead -- that one cannot be redone without the tape.
// Prices verified Aug 2026, per million tokens.
export const TRANSLATION_MODELS = [
  { id: 'google/gemini-3.7-flash',   label: 'Gemini 3.7 Flash (default)', in: 0.375, out: 1.875 },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (best)',     in: 2.00,  out: 10.00 },
  { id: 'openai/gpt-5.6-sol',        label: 'GPT-5.6',                    in: 2.00,  out: 10.00 }
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
    const forms = [e.canonical_greek, ...(e.observed_forms || [])].filter(Boolean);
    return `- ${[...new Set(forms)].join(' / ')} => ${e.english}` +
           (e.kind ? ` (${e.kind})` : '') + (e.notes ? ` -- ${e.notes}` : '');
  });
  return `\nKNOWN NAMES. Match these across ANY inflected form (Greek declines names:
Κώστας/Κώστα/Κώστᾳ) and across phonetically-close ASR errors (Γκόστα -> Κώστας).
Always render the English exactly as given:\n${lines.join('\n')}\n`;
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
  "flags": [{"id": "<segment id>", "type": "name"|"place"|"garbled"|"uncertain",
             "greek": "<the exact Greek span in question>", "guess": "<your best reading>"}],
  "dates": [{"id": "<segment id>", "spoken": "<the date as spoken, in Greek>",
             "iso": "<YYYY-MM-DD, or YYYY-MM, or YYYY if only partly stated>"}]
}

Rules:
- Emit exactly one translation per input id. Never merge, split, drop, or invent ids.
- Flag every personal name and place name the FIRST time it appears in this batch, even
  if you are confident: she does not speak Greek and is relying on these to build a glossary.
- "dates" is for dates he SPEAKS as the date of the entry, not dates merely mentioned.
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
  const send = backend || (msgs => chat(key, model, msgs, fetchImpl));

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
