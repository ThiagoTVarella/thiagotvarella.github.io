// Pure view-logic for the recordings list: what a working tape's checklist should show,
// and what (if anything) the library banner should say. Kept separate from ui.js, which
// touches the DOM at module load and so cannot be imported into the plain-node test suite --
// these decisions are exactly the part with real branching, so they are what needs testing.

import { STEPS } from './queue.js';

// The checklist under a working tape's progress bar: which steps are done, which is
// current, which are still ahead. Pure HTML string, no DOM dependency.
export function miniSteps(tape) {
  return `<div class="mini-steps">${STEPS.map((step, i) => {
    const cls = i < tape.stepIdx ? 'done' : i === tape.stepIdx ? 'current' : '';
    const mark = i < tape.stepIdx ? '✓' : i === tape.stepIdx ? '●' : '○';
    return `<span class="${cls}">${mark} ${step.label}</span>`;
  }).join('')}</div>`;
}

// A tape is resumable if it is anything other than finished. That deliberately includes
// FAILED ones: retrying is nearly free, because every chunk already transcribed and any
// translation already written stay on disk and are skipped. Nothing is ever re-recorded,
// and nothing already paid for is paid for twice.
export const isResumable = t =>
  t.status === 'working' || t.status === 'queued' || t.status === 'error';

// What the banner above the recordings list should say, given the tapes on hand and
// whether a queue is actively running right now in this tab.
//
//   'running' -- a queue in THIS session is working on something; show its live progress.
//   'stalled' -- nothing is running, but work remains: either interrupted partway (the tab
//                was closed mid-run) or stopped by an error. Both are picked up the same
//                way, so they share one action; only the wording differs.
//   'none'    -- nothing to say.
export function libraryBannerState(tapes, activelyRunning) {
  if (activelyRunning) {
    const working = tapes.find(t => t.status === 'working');
    if (working) return { kind: 'running', tape: working };
  } else {
    const stalled = tapes.filter(isResumable);
    if (stalled.length) {
      const failed = stalled.filter(t => t.status === 'error').length;
      return { kind: 'stalled', tapes: stalled, failed, unfinished: stalled.length - failed };
    }
  }
  return { kind: 'none' };
}

// One sentence covering both reasons work is outstanding, without pretending an error was
// merely an interruption.
export function stalledMessage({ failed = 0, unfinished = 0 }) {
  const n = failed + unfinished;
  const plural = n === 1 ? 'recording' : 'recordings';
  if (failed && unfinished) {
    return `${n} ${plural} still need reading — some ran into a problem, some were interrupted. Nothing is lost.`;
  }
  if (failed) {
    return `${failed} ${failed === 1 ? 'recording' : 'recordings'} ran into a problem. Nothing is lost — the audio is still here.`;
  }
  return `${unfinished} ${plural} didn't finish being read — probably the window closed partway through. Nothing is lost.`;
}

// The failure reason, shown persistently on the card itself rather than in a toast that
// disappears. Clicking a failed tape now retries it, so the reason has to live somewhere
// she can still read after the click.
export function tapeErrorNote(tape) {
  if (tape.status !== 'error') return null;
  return { reason: tape.error || 'something went wrong', action: 'tap to try again' };
}

// What clicking a tape that is not ready to read should say. Reflects its actual current
// step rather than a flat "not ready" -- that flatness is what made the original bug
// (a recording stuck at "Waiting" with zero information) feel like a dead end.
export function tapeClickMessage(tape) {
  if (tape.status === 'error') {
    return `Trying "${tape.label}" again — picking up from where it stopped.`;
  }
  if (tape.status === 'working') {
    const step = STEPS[tape.stepIdx];
    const pct = Math.round((tape.progress || 0) * 100);
    return `Still ${(step?.label || 'working on it').toLowerCase()} -- ${pct}% so far.`;
  }
  return `"${tape.label}" hasn't started yet.`;
}

// --- the recordings screen ------------------------------------------------
//
// Her folder is the archive, so the audio is already ordinary files she owns. But she has
// no reason to know that, and no way from in here to play a whole recording back, check one
// that went wrong, or take a copy somewhere else. These are the decisions that screen makes.

const GREEK = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i',
  θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y',
  φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o'
};

// Greek written in Latin letters. Two reasons, and the second is the important one:
// a browser handed a filename it cannot encode discards the WHOLE name and saves the file
// as "download" -- so every Greek-labelled tape would land in her Downloads as download,
// download (1), download (2), which is worse than the "source.webm" problem this is meant
// to solve. And she does not read Greek: "Martios 1978" tells her which tape this is and
// the original does not. Letter-by-letter on purpose -- digraph rules (ου, μπ, ντ) are more
// faithful and less predictable, and a filename only has to be recognisable.
export function toLatin(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')     // accents off, so ά matches α
    .replace(/[\u2010-\u2015]/g, '-')                     // the dash family, all to a hyphen
    .split('')
    .map(c => {
      const lower = GREEK[c.toLowerCase()];
      if (!lower) return c;
      return c === c.toLowerCase() ? lower : lower.replace(/^./, m => m.toUpperCase());
    })
    .join('')
    .replace(/[^\x20-\x7e]/g, '');                        // anything still unencodable
}

// What a saved copy should be called. Every tape stores its audio as "source.webm", which
// is correct on disk (the folder gives it context) and useless in a Downloads folder, where
// the third one would land as "source (2).webm". Name it after the tape instead.
export function downloadName(tape, fileName = '') {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName) || [, 'webm'])[1].toLowerCase();
  const clean = t => toLatin(t)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')   // illegal on Windows, awkward everywhere else
    .replace(/\(\s*\)/g, '')                  // "Summer 1979 (?)" should not keep bare brackets
    .replace(/\s+/g, ' ')
    .trim();
  // A label that transliterates to nothing at all (punctuation, or a script this table does
  // not cover) must not collapse every tape to the same name; the id is always distinct.
  const base = /[a-z0-9]/i.test(clean(tape.label)) ? clean(tape.label)
             : clean(tape.id) || 'recording';
  const side = tape.side ? ` - side ${clean(tape.side) || 'A'}` : '';
  return `${base}${side}.${ext}`;
}

export function formatSize(bytes) {
  if (!(bytes > 0)) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

// Where each recording stands, said plainly. The failed case is the one that matters most
// here: the whole reason to reach for this screen after an error is to reassure yourself
// the audio survived, so say so rather than repeating the error.
export function mediaNote(tape) {
  if (tape.status === 'done')    return 'Read and put into English';
  if (tape.status === 'working') return 'Being read right now';
  if (tape.status === 'error')   return 'Ran into a problem being read — the audio itself is fine';
  return 'Waiting to be read';
}

export function mediaSummary(tapes) {
  if (!tapes.length) return '';
  const ready = tapes.filter(t => t.status === 'done').length;
  const n = tapes.length;
  return `${n} recording${n === 1 ? '' : 's'}` +
    (ready === n ? '.' : `, ${ready} of them read through so far.`);
}
