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

// Greek declines names on the ending: Κώστας / Κώστα / Κώστᾳ / Κώστᾰν. Comparing stems
// catches that. It does NOT catch ASR manglings (Γκόστα vs Κώστας) -- those differ at the
// front, which is exactly why entries carry observed_forms recorded when the flag was raised.
export function stem(s) {
  const n = normalizeGreek(s);
  return n.length > 4 ? n.slice(0, Math.max(3, n.length - 2)) : n;
}

export function sameWord(a, b) {
  const A = normalizeGreek(a), B = normalizeGreek(b);
  if (A === B) return true;
  const sa = stem(A), sb = stem(B);
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
  return {
    segments: edited,
    audit: { entry: entry.id, greek: entry.canonical_greek || entry.greek,
             from: plan.substitute[0]?.from ?? null, to: plan.substitute[0]?.to ?? null,
             segments: plan.substitute.map(s => s.id),
             retranslated: plan.retranslate.map(s => s.id) }
  };
}

export function undo(segments, audit) {
  const ids = new Set([...(audit.segments || []), ...(audit.retranslated || [])]);
  return segments.map(seg => (ids.has(seg.id) && seg.enOriginal != null)
    ? { ...seg, en: seg.enOriginal, enOriginal: undefined } : seg);
}

// --- what to tell her -----------------------------------------------------

// Plain language, no jargon, and honest about cost. Re-transcription is never on the table.
export function describePlan(plan) {
  const s = plan.substitute.length, r = plan.retranslate.length;
  if (!s && !r) return 'Nothing else needs changing — it already reads that way.';
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
