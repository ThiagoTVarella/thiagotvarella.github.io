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

// What the banner above the recordings list should say, given the tapes on hand and
// whether a queue is actively running right now in this tab.
//
//   'running' -- a queue in THIS session is working on something; show its live progress.
//   'stalled' -- nothing is running, but some tape is not done. Almost always the tab was
//                closed or reloaded mid-run. The engine can pick up exactly where it left
//                off; she just needs a way to ask it to.
//   'none'    -- nothing to say.
export function libraryBannerState(tapes, activelyRunning) {
  if (activelyRunning) {
    const working = tapes.find(t => t.status === 'working');
    if (working) return { kind: 'running', tape: working };
  } else {
    const stalled = tapes.filter(t => t.status === 'working' || t.status === 'queued');
    if (stalled.length) return { kind: 'stalled', tapes: stalled };
  }
  return { kind: 'none' };
}

// What clicking a tape that is not ready to read should say. Reflects its actual current
// step rather than a flat "not ready" -- that flatness is what made the original bug
// (a recording stuck at "Waiting" with zero information) feel like a dead end.
export function tapeClickMessage(tape) {
  if (tape.status === 'error') {
    return `"${tape.label}" ran into a problem: ${tape.error || 'something went wrong'}.`;
  }
  if (tape.status === 'working') {
    const step = STEPS[tape.stepIdx];
    const pct = Math.round((tape.progress || 0) * 100);
    return `Still ${(step?.label || 'working on it').toLowerCase()} -- ${pct}% so far.`;
  }
  return `"${tape.label}" hasn't started yet.`;
}
