// Reading and amending one diary entry.
//
// What is on disk is deliberately split -- Greek per chunk, English per tape, flags
// separately -- because each is written by a different stage and must survive a crash in
// the others. This module is the join, and it is the only place that knows the shape.

import { collectSegments } from './queue.js';
import { dateRange } from './translate.js';
import * as store from './store.js';
import { planCorrection, applySubstitutions, mergePlans, describePlan } from './glossary.js';

// "1978-03-14" -> "Tuesday, 14 March 1978". Partial dates degrade rather than inventing
// precision he never spoke: "1978-03" -> "March 1978", "1978" -> "1978".
export function formatHeading(iso) {
  if (!iso) return null;
  const parts = String(iso).split('-');
  const [y, m, d] = parts;
  if (!y) return null;
  if (!m) return y;
  const date = new Date(Date.UTC(+y, +m - 1, +(d || 1)));
  if (isNaN(date)) return iso;
  const opts = d
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { month: 'long', year: 'numeric' };
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(date); }
  catch (e) { return iso; }
}

// Assemble everything needed to render one entry. Tolerates every partial state the
// pipeline can leave behind: transcribed but not translated, some chunks missing, a
// translation that dropped an id.
export async function loadEntry(S, tapeId) {
  let tape = {};
  try { tape = await S.readJSON(store.paths.tape(tapeId)); } catch (e) {}

  const greek = await collectSegments(S, tapeId, tape.plan || []);

  let english = new Map(), unresolved = new Set();
  try {
    const t = await S.readJSON(store.paths.translation(tapeId));
    for (const row of (t.translations || [])) {
      if (row.en) english.set(row.id, row.en); else unresolved.add(row.id);
    }
    for (const id of (t.unresolved || [])) unresolved.add(id);
  } catch (e) { /* not translated yet */ }

  let flags = new Map();
  try {
    for (const f of (await S.readJSON(store.paths.flags(tapeId))) || []) {
      if (f && f.id && f.guess) flags.set(f.id, f.guess);
    }
  } catch (e) {}

  const range = dateRange(tape.dates || []);
  const segments = greek.map(g => {
    const en = english.get(g.id) ?? null;
    return {
      id: g.id,
      gr: g.text,
      // An id the translator dropped must show the Greek, never an empty paragraph:
      // a blank line would read as though he said nothing.
      en,
      untranslated: en === null,
      chunk: g.chunk,
      start: g.start ?? null,
      chunkStart: (tape.plan?.[g.chunk]?.start) ?? 0,
      confidence: g.confidence ?? null,
      unsure: flags.get(g.id) || null
    };
  });

  return {
    id: tapeId,
    label: tape.label || tapeId,
    side: tape.side || 'A',
    date: range ? range[0] : null,
    heading: range ? formatHeading(range[0]) : null,
    plan: tape.plan || [],
    segments
  };
}

export async function saveTranslation(S, tapeId, segments) {
  await S.writeJSON(store.paths.translation(tapeId), {
    translations: segments.map(s => ({ id: s.id, en: s.en,
      ...(s.enOriginal != null ? { enOriginal: s.enOriginal } : {}) })),
    unresolved: segments.filter(s => s.en == null).map(s => s.id)
  });
}

// Sweep a confirmed glossary term across every tape.
//
// Batched on purpose: answering ten names must be one pass over the files, not ten. Tier 1
// is a free on-disk substitution; only tier 2 -- where the English lost the word entirely --
// costs a model call, and then only for those sentences.
export async function applyCorrectionAcross(S, tapeIds, entry, oldEnglish, newEnglish, opts = {}) {
  const plans = [];
  const perTape = new Map();

  for (const id of tapeIds) {
    const loaded = await loadEntry(S, id);
    const plan = planCorrection(loaded.segments, entry, oldEnglish, newEnglish);
    if (!plan.substitute.length && !plan.retranslate.length) continue;
    plans.push(plan);
    perTape.set(id, { loaded, plan });
  }

  const merged = mergePlans(plans);
  const audits = [];

  for (const [id, { loaded, plan }] of perTape) {
    let segments = loaded.segments;
    if (plan.substitute.length) {
      const applied = applySubstitutions(segments, plan, entry);
      segments = applied.segments;
      audits.push({ tape: id, ...applied.audit });
    }

    // Tier 2: the Greek mentions it but the English lost it, so a swap would leave a broken
    // sentence. Re-read only those sentences -- never the batch, never the tape.
    if (plan.retranslate.length && opts.translate) {
      const ids = new Set(plan.retranslate.map(s => s.id));
      const toRedo = segments.filter(s => ids.has(s.id)).map(s => ({ id: s.id, text: s.gr }));
      try {
        const out = await opts.translate(toRedo, opts.translateOpts || {});
        const fresh = new Map((out.translations || []).map(t => [t.id, t.en]));
        segments = segments.map(s => fresh.get(s.id)
          ? { ...s, en: fresh.get(s.id), enOriginal: s.enOriginal ?? s.en, untranslated: false }
          : s);
        merged.cost = (merged.cost || 0) + (out.cost || 0);
      } catch (e) {
        // A failed re-read must leave the original text alone, not blank it.
        merged.failed = (merged.failed || 0) + toRedo.length;
      }
    }

    await saveTranslation(S, id, segments);
  }

  if (audits.length) {
    let log = [];
    try { log = await S.readJSON('corrections.json'); } catch (e) {}
    await S.writeJSON('corrections.json', [...(Array.isArray(log) ? log : []), ...audits]);
  }

  return { ...merged, audits, tapes: perTape.size, summary: describePlan(merged) };
}

// Blob URLs for playback. Chunks are ~1.5 MB and she may click through dozens of lines in
// one sitting, so the previous URL must be released before a new one is made -- otherwise
// the page quietly accumulates megabytes until reload. Extracted so that is testable.
export function makeAudioSource(deps = {}) {
  const createURL = deps.createURL || (b => URL.createObjectURL(b));
  const revokeURL = deps.revokeURL || (u => URL.revokeObjectURL(u));
  let current = null;
  return {
    get current() { return current; },
    use(blob) {
      if (current) revokeURL(current);
      current = createURL(blob);
      return current;
    },
    release() { if (current) { revokeURL(current); current = null; } }
  };
}
