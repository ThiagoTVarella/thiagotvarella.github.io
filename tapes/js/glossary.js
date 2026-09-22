// Glossary corrections.
//
// The question this module answers: when she fixes a name after tapes are already
// translated, what actually has to be redone?
//
// Almost nothing, and NEVER the transcription. The Greek came off the tape correctly or
// it did not; deciding how to spell it in English changes no Greek character on disk.
// Transcription is the expensive, irreversible pass -- it must never re-run for this.
//
// Three tiers, cheapest first:
//   0  NOTHING          the English already reads the way she confirmed
//   1  SUBSTITUTE       swap the old rendering for the new one, on disk, free, instant
//   2  RE-TRANSLATE     only where the meaning genuinely shifts, and only those segments
//
// Tier 1 covers the overwhelming majority. Tier 2 touches a handful of segments, never a
// whole tape and never a whole batch.

export const TIER = { NONE: 0, SUBSTITUTE: 1, RETRANSLATE: 2 };

// --- Greek matching -------------------------------------------------------

// Strip accents and normalize final sigma so Κώστας, ΚΩΣΤΑΣ and κωστας compare equal.
export function normalizeGreek(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')          // final sigma -> sigma
    .trim();
}

// Greek declines names on the ending: Κώστας / Κώστα / Κώστᾳ / Κώστᾰν. Removing a known
// ending and comparing what is left catches that. Two words are the same only when what is
// left is identical: Μαρία (μαρι) and Μάρκος (μαρκ) are not, and neither are Νίκος and
// Νικολέτα. It does NOT catch ASR manglings (Γκόστα vs Κώστας) -- those differ at the
// front, which is exactly why entries carry observed_forms recorded when the flag was raised.
// Written with σ, because normalizeGreek has already turned every final ς into σ.
const ENDINGS = ['ουσ', 'εισ', 'ασ', 'ησ', 'οσ', 'ου', 'ων', 'εσ', 'αν', 'ην', 'ον',
                 'α', 'η', 'ο', 'ε', 'ι', 'υ', 'ω'];
export function stem(s) {
  const n = normalizeGreek(s);
  for (const e of ENDINGS) {
    if (n.length - e.length >= 3 && n.endsWith(e)) return n.slice(0, -e.length);
  }
  return n;
}

export function sameWord(a, b) {
  const A = normalizeGreek(a), B = normalizeGreek(b);
  // Two spans that boil down to nothing (whitespace, stray punctuation) are not the same
  // word; they are two different bits of noise from two different tapes.
  if (!A || !B) return false;
  if (A === B) return true;
  const sa = stem(A), sb = stem(B);
  return sa.length >= 3 && sa === sb;
}

// The looser test that used to decide merges: one word's beginning contains the other's.
// It is what makes Κωστάκης look like Κώστας, and also what made Μαρία look like Μάρκος,
// so it is never allowed to merge anything on its own. It only raises the question.
export function resembles(a, b) {
  const A = normalizeGreek(a), B = normalizeGreek(b);
  if (!A || !B || sameWord(A, B)) return false;
  const cut = n => (n.length > 4 ? n.slice(0, Math.max(3, n.length - 2)) : n);
  const sa = cut(A), sb = cut(B);
  return sa.length >= 3 && sb.length >= 3 && (sa.startsWith(sb) || sb.startsWith(sa));
}

// Every Greek form this entry is known by: canonical, inflections, and recorded manglings.
export function formsOf(entry) {
  return [...new Set([entry.canonical_greek || entry.greek, ...(entry.observed_forms || [])]
    .filter(Boolean))];
}

// Does this Greek segment mention the entry at all?
export function greekMentions(greekText, entry) {
  const words = String(greekText || '').split(/[\s.,;!?·"'()\[\]…]+/).filter(Boolean);
  const forms = formsOf(entry);
  return words.some(w => forms.some(f => sameWord(w, f)));
}

// --- planning a correction ------------------------------------------------

// Work out, without calling any model, exactly what a correction touches.
//
// `segments` are [{ id, gr, en, tape }]. Returns per-segment work plus a tier summary,
// so the UI can tell her the truth about cost before anything is written.
export function planCorrection(segments, entry, oldEnglish, newEnglish) {
  const plan = { substitute: [], retranslate: [], untouched: 0, tier: TIER.NONE };

  if (!newEnglish || oldEnglish === newEnglish) {
    // She confirmed the guess. Nothing to redo anywhere -- the entry just gets recorded
    // so every future tape renders it the same way.
    plan.untouched = segments.length;
    return plan;
  }

  for (const seg of segments) {
    if (!greekMentions(seg.gr, entry)) { plan.untouched++; continue; }

    // The old rendering is present verbatim, so a swap is exact and safe.
    if (oldEnglish && findRendering(seg.en, oldEnglish)) {
      plan.substitute.push({ id: seg.id, tape: seg.tape,
                             from: oldEnglish, to: newEnglish,
                             preview: substitute(seg.en, oldEnglish, newEnglish) });
      continue;
    }
    // The Greek mentions it but the English does not contain the old rendering -- the
    // model rendered it some other way, or read the name as an ordinary word. A blind
    // swap would corrupt the sentence, so this one genuinely needs re-translating.
    plan.retranslate.push({ id: seg.id, tape: seg.tape, gr: seg.gr, en: seg.en });
  }

  plan.tier = plan.retranslate.length ? TIER.RETRANSLATE
            : plan.substitute.length  ? TIER.SUBSTITUTE
            : TIER.NONE;
  return plan;
}

// Whole-word, case-insensitive. Names sit next to punctuation and possessives, so the
// boundary check cannot simply be \b on both sides.
const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const renderingRe = word => new RegExp(`(^|[^\\p{L}])(${escape(word)})(?=$|[^\\p{L}])`, 'giu');

export function findRendering(text, word) {
  if (!word) return false;
  return renderingRe(word).test(String(text || ''));
}
export function substitute(text, from, to) {
  return String(text || '').replace(renderingRe(from), (_m, pre) => pre + to);
}

// --- applying -------------------------------------------------------------

// Apply the free part of a plan. Returns the edited segments plus an audit entry, since
// this is irreplaceable material and a bad correction must be undoable.
export function applySubstitutions(segments, plan, entry) {
  const byId = new Map(plan.substitute.map(s => [s.id, s]));
  const edited = segments.map(seg => {
    const hit = byId.get(seg.id);
    if (!hit) return seg;
    return {
      ...seg,
      en: hit.preview,
      // Keep what the model originally said, so any correction can be walked back.
      enOriginal: seg.enOriginal ?? seg.en
    };
  });
  // What each sentence said just before THIS correction, so undoing it puts back exactly
  // that, and not the model's first draft from before every other correction too.
  const before = {};
  for (const seg of segments) if (byId.has(seg.id)) before[seg.id] = seg.en;
  return {
    segments: edited,
    audit: { entry: entry.id, greek: entry.canonical_greek || entry.greek,
             from: plan.substitute[0]?.from ?? null, to: plan.substitute[0]?.to ?? null,
             segments: plan.substitute.map(s => s.id),
             retranslated: plan.retranslate.map(s => s.id),
             before }
  };
}

// Walks back one correction and leaves every other one in place. A substitution is
// reversed on the text as it is now (the new word back to the old), so corrections made
// since survive; a re-read sentence goes back to what it said just before, since a
// re-reading cannot be reversed any other way. An older audit without that record falls
// back to the model's original wording.
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function undo(segments, audit) {
  const before = audit.before || {};
  const swapped = new Set(audit.segments || []);
  const reread = new Set(audit.retranslated || []);
  const back = audit.from && audit.to ? new RegExp(`(^|[^\\p{L}])${escapeRe(audit.to)}(?![\\p{L}])`, 'gu') : null;
  return segments.map(seg => {
    if (swapped.has(seg.id) && back && back.test(seg.en || '')) {
      back.lastIndex = 0;
      return { ...seg, en: seg.en.replace(back, `$1${audit.from}`) };
    }
    if (!swapped.has(seg.id) && !reread.has(seg.id)) return seg;
    if (before[seg.id] != null) return { ...seg, en: before[seg.id] };
    return seg.enOriginal != null ? { ...seg, en: seg.enOriginal, enOriginal: undefined } : seg;
  });
}

// Segment ids are minted as c<chunk>s<n>, so the chunk a line lives in is in its id.
export function chunkOfSegment(id) {
  const m = /^c(\d+)s\d+$/.exec(String(id || ''));
  return m ? +m[1] : null;
}

// --- what to tell her -----------------------------------------------------

// Plain language, no jargon, and honest about cost. Re-transcription is never on the table.
export function describePlan(plan) {
  const s = plan.substitute.length, r = plan.retranslate.length;
  if (!s && !r) return 'Nothing else needs changing. It already reads that way.';
  const parts = [];
  if (s) parts.push(`updated in ${s} place${s > 1 ? 's' : ''} straight away`);
  if (r) parts.push(`${r} sentence${r > 1 ? 's' : ''} re-read for sense`);
  return parts.join(', ') + '.';
}

// Tier 2 is the only part that costs anything, and it is per-sentence, not per-tape.
export function estimateCost(plan, perSegment = 0.0002) {
  return +(plan.retranslate.length * perSegment).toFixed(5);
}

// Batch corrections so answering ten names is one sweep over the files, not ten.
export function mergePlans(plans) {
  const out = { substitute: [], retranslate: [], untouched: 0, tier: TIER.NONE };
  for (const p of plans) {
    out.substitute.push(...p.substitute);
    out.retranslate.push(...p.retranslate);
    out.untouched += p.untouched;
  }
  // A segment needing re-translation should not also be substituted in the same sweep.
  const redo = new Set(out.retranslate.map(s => s.id));
  out.substitute = out.substitute.filter(s => !redo.has(s.id));
  out.tier = out.retranslate.length ? TIER.RETRANSLATE
           : out.substitute.length  ? TIER.SUBSTITUTE : TIER.NONE;
  return out;
}

// --- building the review queue --------------------------------------------
//
// The translation stage writes flags.json per tape: every span it was unsure of, plus the
// Greek it saw and its best reading. Nothing turned those into questions, so the "Needs your
// ear" queue was populated from demo data alone and was empty forever in the real app --
// while a finished entry told her the shaded passages could be sorted out under Glossary.
//
// Two things have to happen before a flag is a question worth asking. Anything she has
// already answered must drop out, and the rest must be CLUSTERED: the same name flagged in
// forty batches is one question, not forty. Clustering is by Greek stem and recorded form,
// so inflections (Κώστας/Κώστα) and manglings gather together.

const modeOf = xs => {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [x, c] of counts) if (c > n) { best = x; n = c; }
  return best;
};

// The English on either side of the guess, so she reads it in place rather than in isolation.
// When the translator rendered the term some other way the guess is not in the sentence at
// all -- exactly the case a blind substitution would break -- so show no context rather than
// inventing a position for it.
export function contextAround(english, guess) {
  const text = String(english || ''), g = String(guess || '');
  const at = g ? text.indexOf(g) : -1;
  return at < 0 ? ['', ''] : [text.slice(0, at), text.slice(at + g.length)];
}

export function buildReviewQueue(occurrences, glossary = []) {
  const known = (glossary || []).filter(Boolean);
  const fresh = (occurrences || []).filter(o =>
    o && o.greek && normalizeGreek(o.greek) &&
    !known.some(g => formsOf(g).some(f => sameWord(f, o.greek))));

  const clusters = [];
  for (const o of fresh) {
    let c = clusters.find(c => c.forms.some(f => sameWord(f, o.greek)));
    if (!c) { c = { forms: [], items: [] }; clusters.push(c); }
    if (!c.forms.some(f => normalizeGreek(f) === normalizeGreek(o.greek))) c.forms.push(o.greek);
    c.items.push(o);
  }

  // A confirmed name this card merely resembles. The card asks about it before anything
  // else; the answer is hers, never the code's.
  const confirmed = known.filter(g => g && g.english && !g.aside);
  const maybeFor = greek => {
    const g = confirmed.find(g => formsOf(g).some(f => resembles(f, greek)));
    return g ? { id: g.id, english: g.english, greek: g.canonical_greek || g.greek } : null;
  };

  return clusters.map(c => {
    const greek = modeOf(c.items.map(i => i.greek));
    const guess = modeOf(c.items.map(i => i.guess).filter(Boolean)) || '';
    // One blurred stretch in a cluster makes the whole thing a phrase: she cannot spell back
    // what she could not hear as a word, so the question has to change shape.
    const kind = c.items.some(i => i.type === 'phrase') ? 'phrase' : 'word';
    const sample = c.items.find(i => guess && String(i.en || '').includes(guess)) || c.items[0];
    return {
      id: 'g_' + (normalizeGreek(greek).replace(/[^a-zα-ω0-9]+/gi, '') || c.items[0].id),
      greek,
      observed_forms: c.forms,
      heard: c.items.length,
      guess, kind,
      context: contextAround(sample.en, guess),
      maybe: maybeFor(greek),
      tape: sample.tape || null,
      segment: sample.id || null,
      chunk: sample.chunk ?? chunkOfSegment(sample.id),
      at: sample.start ?? null,
      // Mechanical, and deliberately phrased as such: the stems match but the strings differ,
      // so the tape rendered one term more than one way. It says nothing about what it IS.
      hint: c.forms.length > 1
        ? `The tape says this more than one way (${c.forms.join(', ')}). They look like the same word.`
        : null
    };
  }).sort((a, b) => b.heard - a.heard || String(a.greek).localeCompare(String(b.greek)));
}
