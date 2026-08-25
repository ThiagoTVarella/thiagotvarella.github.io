// Audio preparation: turn one long recording into chunks cut at natural pauses.
//
// The pure functions here (parseSilenceLog, planChunks) are where silent data loss
// would hide, so they are kept free of ffmpeg and DOM so they can be tested directly.

export const DEFAULTS = {
  targetSec: 75,    // aim for ~75s chunks: long enough for ASR context, short enough to seek
  minSec: 45,       // never emit a chunk shorter than this except the final remainder
  maxSec: 150,      // hard ceiling when no pause is found (a monologue with no breath)
  searchSec: 30,    // how far either side of a target to hunt for a pause
  noiseDb: -35,     // silencedetect threshold; calibrate against real tape hiss
  minSilenceSec: 0.6
};

// Parse ffmpeg's `silencedetect` output. It emits lines like:
//   [silencedetect @ 0x..] silence_start: 12.345
//   [silencedetect @ 0x..] silence_end: 14.567 | silence_duration: 2.222
// A trailing silence_start with no matching end means silence ran to the end of file.
export function parseSilenceLog(log, totalDuration) {
  const silences = [];
  let open = null;
  for (const line of String(log).split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { open = parseFloat(m[1]); continue; }
    m = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (m && open !== null) {
      const end = parseFloat(m[1]);
      if (end > open) silences.push({ start: open, end });
      open = null;
    }
  }
  if (open !== null && totalDuration != null && totalDuration > open) {
    silences.push({ start: open, end: totalDuration });
  }
  return silences.sort((a, b) => a.start - b.start);
}

// Choose cut points inside pauses so no chunk boundary lands mid-word.
//
// Walks forward from 0. For each chunk, looks for the pause whose midpoint is closest
// to `targetSec` ahead, within +/- searchSec, subject to min/max length. Falls back to
// a hard cut at maxSec when the speaker simply doesn't pause.
//
// Returns [{ start, duration, endsAtSilence }], contiguous and gap-free by construction:
// each chunk starts exactly where the previous ended, so no audio can be dropped.
export function planChunks(silences, totalDuration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!(totalDuration > 0)) return [];

  const mids = (silences || [])
    .filter(s => s.end > s.start)
    .map(s => ({ mid: (s.start + s.end) / 2, start: s.start, end: s.end }));

  const chunks = [];
  let cursor = 0;

  while (cursor < totalDuration - 0.01) {
    const remaining = totalDuration - cursor;

    // Short tail: emit it whole rather than making a runt chunk.
    if (remaining <= o.maxSec) {
      chunks.push({ start: cursor, duration: +remaining.toFixed(3), endsAtSilence: false });
      break;
    }

    const target = cursor + o.targetSec;
    const lo = cursor + o.minSec;
    const hi = Math.min(cursor + o.maxSec, totalDuration);

    let best = null, bestDist = Infinity;
    for (const s of mids) {
      if (s.mid < lo || s.mid > hi) continue;
      if (s.mid > target + o.searchSec) break;      // mids are sorted; nothing closer ahead
      const d = Math.abs(s.mid - target);
      if (d < bestDist) { bestDist = d; best = s; }
    }

    const cut = best ? best.mid : hi;
    const duration = +(cut - cursor).toFixed(3);
    chunks.push({ start: cursor, duration, endsAtSilence: !!best });
    cursor = +(cursor + duration).toFixed(3);
  }

  return chunks;
}

// The longest unbroken stretch of NON-silence inside a chunk. This is what decides whether
// a chunk holds speech, rather than the silent fraction alone.
export function longestSpeechRun(chunk, silences) {
  const cEnd = chunk.start + chunk.duration;
  const inside = (silences || [])
    .map(s => ({ start: Math.max(s.start, chunk.start), end: Math.min(s.end, cEnd) }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let longest = 0, cursor = chunk.start;
  for (const s of inside) {
    longest = Math.max(longest, s.start - cursor);
    cursor = Math.max(cursor, s.end);
  }
  return Math.max(longest, cEnd - cursor);
}

// Mark chunks that are entirely silence so they are never sent to a model.
// This is the cheapest hallucination guard available: leader tape and dead ends of
// sides are exactly the input that makes ASR models invent speech.
//
// But the fraction alone is not safe at the end of a side. A chunk holding his last two
// words followed by two minutes of blank tape is 99% silence, and skipping it would throw
// those words away entirely -- the worst possible outcome, and an invisible one. So a chunk
// containing an unbroken stretch of sound longer than a word is never skipped, however much
// silence surrounds it.
export function markSilentChunks(chunks, silences, opts = {}) {
  const minSpeechSec = opts.minSpeechSec ?? 0.35;
  return chunks.map(c => {
    const cEnd = c.start + c.duration;
    const covered = (silences || []).reduce((acc, s) => {
      const overlap = Math.min(cEnd, s.end) - Math.max(c.start, s.start);
      return acc + Math.max(0, overlap);
    }, 0);
    const fraction = c.duration > 0 ? covered / c.duration : 1;
    const speech = longestSpeechRun(c, silences);
    return { ...c, silentFraction: fraction, longestSpeech: +speech.toFixed(3),
             isSilent: c.duration > 0 && fraction > 0.98 && speech < minSpeechSec };
  });
}

// A duration recovered by watching a decode is a LOWER BOUND: ffmpeg's last progress line
// is printed slightly before the stream truly ends, so a browser recording (which carries
// no duration in its header at all) measures a little short. Being short by even a fraction
// of a second clips the final word. Let the last chunk run past the measured end: ffmpeg
// stops at EOF, so asking for more than exists costs nothing and cannot lose anything.
export function padFinalChunk(chunks, seconds = 2) {
  if (!chunks.length || !(seconds > 0)) return chunks;
  const out = chunks.slice();
  const last = out[out.length - 1];
  out[out.length - 1] = { ...last, duration: +(last.duration + seconds).toFixed(3), padded: true };
  return out;
}

// ffmpeg argv builders. Kept as data so they can be asserted in tests without running ffmpeg.
export function silenceScanArgs(input, o = DEFAULTS) {
  return ['-i', input, '-af', `silencedetect=noise=${o.noiseDb}dB:d=${o.minSilenceSec}`, '-f', 'null', '-'];
}

// Preprocessing is deliberately conservative: high-pass removes rumble/hum, dynaudnorm
// rescues quiet passages that decades-old tape buries under hiss. Denoising (afftdn) is
// left off by default -- it sometimes hurts modern ASR and needs A/B on real tape.
export function chunkArgs(input, chunk, output, o = {}) {
  const filters = ['highpass=f=80'];
  if (o.normalize !== false) filters.push('dynaudnorm');
  if (o.denoise) filters.push('afftdn');
  return [
    '-ss', chunk.start.toFixed(3), '-t', chunk.duration.toFixed(3),
    '-i', input,
    '-af', filters.join(','),
    '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
    output
  ];
}
