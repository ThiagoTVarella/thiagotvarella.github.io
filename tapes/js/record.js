// Recording a tape by holding a microphone up to the cassette player's speaker.
//
// This removes the hardware from the critical path: no line-out cable, no USB interface,
// nothing to buy. Quality is worse than a direct line, but the transcription has margin --
// the models read simulated cassette audio word-perfectly in testing, names included.
//
// THE THING THAT MAKES OR BREAKS THIS: getUserMedia defaults to phone-call processing --
// echo cancellation, noise suppression and automatic gain control, all ON. Every one of
// them is actively harmful here:
//
//   * noiseSuppression treats steady tape hiss as noise to remove, and takes quiet speech
//     with it -- exactly the passages that are already hardest to make out.
//   * autoGainControl pumps the level up during pauses and ducks it when he speaks, which
//     is audible as breathing and confuses the silence detection the chunker depends on.
//   * echoCancellation assumes it is in a call and can attenuate the very sound we want,
//     since that sound is coming out of a speaker in the same room.
//
// So all three are switched off, deliberately, and that is not a detail to "simplify" later.

export const CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,          // one speaker, one channel; halves the file for nothing lost
  sampleRate: 48000
};

export function audioConstraints(deviceId) {
  return { audio: deviceId ? { deviceId: { exact: deviceId }, ...CONSTRAINTS } : { ...CONSTRAINTS },
           video: false };
}

// Opus in WebM is well supported and compact; ffmpeg.wasm decodes it happily. Ordered by
// preference, falling back to whatever the browser will actually give us.
export const MIME_PREFERENCE = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4'
];

export function pickMimeType(supported = t => MediaRecorder.isTypeSupported(t)) {
  for (const t of MIME_PREFERENCE) if (supported(t)) return t;
  return '';   // let the browser choose
}

export const extensionFor = mime =>
  /ogg/.test(mime) ? 'ogg' : /mp4/.test(mime) ? 'm4a' : 'webm';

// --- level metering -------------------------------------------------------

// RMS in dBFS plus a peak, from a float time-domain buffer. She needs to see that sound is
// arriving at all, and that it is not slamming into the ceiling -- a whole side recorded
// silently or clipped is 45 minutes she does not get back.
export function analyseLevel(samples) {
  let sum = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / (samples.length || 1));
  return {
    rms,
    peak,
    db: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    clipping: peak >= 0.99,
    // Below this it is indistinguishable from a room with nothing playing.
    silent: rms < 0.001
  };
}

// A 0..1 bar position from dBFS, over the range that actually matters for speech.
export function levelToBar(db, floor = -60, ceil = 0) {
  if (!isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - floor) / (ceil - floor)));
}

// Plain-language verdict for the meter, so she is not reading decibels.
export function levelAdvice(level, secondsSeen = 0) {
  if (level.clipping) return { tone: 'bad', text: 'Too loud — turn the player down a little.' };
  if (level.silent) return { tone: 'bad', text: "Not hearing anything yet." };
  if (level.db < -45) return { tone: 'warn', text: 'Very quiet — move closer or turn it up.' };
  if (level.db > -6) return { tone: 'warn', text: 'Quite loud — easing off a bit would be safer.' };
  if (secondsSeen < 2) return { tone: 'ok', text: 'Picking it up.' };
  return { tone: 'ok', text: 'Sounds good.' };
}

// Speech has pauses in it. Judging the meter on a single frame makes the advice flip to
// "not hearing anything" every time he stops for breath, which reads as a fault and would
// have her adjusting the volume mid-side. Hold the recent peak instead, and only report
// silence once it has genuinely been quiet for a while.
export function makeLevelSmoother({ holdMs = 1500, now = () => Date.now() } = {}) {
  let peakDb = -Infinity, peakAt = 0, clippedAt = 0;
  return level => {
    const t = now();
    if (level.db > peakDb || t - peakAt > holdMs) { peakDb = level.db; peakAt = t; }
    if (level.clipping) clippedAt = t;
    return {
      ...level,
      db: peakDb,
      // Clipping is sticky for the hold window: a brief overload matters even if the very
      // next frame is fine.
      clipping: t - clippedAt < holdMs,
      silent: !isFinite(peakDb) || peakDb < -60
    };
  };
}

export const formatElapsed = s => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

// --- the recorder ---------------------------------------------------------

export async function listInputs(md = navigator.mediaDevices) {
  try {
    const all = await md.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput')
              .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch (e) { return []; }
}

export class Recorder {
  constructor(deps = {}) {
    this.md = deps.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
    this.RecorderImpl = deps.MediaRecorder ||
      (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    this.AudioCtx = deps.AudioContext ||
      (typeof AudioContext !== 'undefined' ? AudioContext : null);
    this.timeslice = deps.timeslice || 5000;
    this.stream = null; this.rec = null; this.ctx = null;
    this.startedAt = null; this.bytes = 0; this.mime = '';
  }

  get recording() { return !!this.rec && this.rec.state === 'recording'; }
  get elapsed() { return this.startedAt == null ? 0 : (Date.now() - this.startedAt) / 1000; }

  // `onData` receives each timeslice blob. Passing a sink that appends straight to disk is
  // what keeps a 45-minute side from ever being held in memory.
  async start({ deviceId, onData, onLevel, onError } = {}) {
    this.stream = await this.md.getUserMedia(audioConstraints(deviceId));
    this.mime = pickMimeType(t => this.RecorderImpl.isTypeSupported(t));

    if (onLevel && this.AudioCtx) this.#meter(onLevel);

    this.rec = new this.RecorderImpl(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.rec.ondataavailable = async e => {
      if (!e.data || !e.data.size) return;
      this.bytes += e.data.size;
      try { await onData?.(e.data); }
      catch (err) { onError?.(err); }
    };
    this.rec.onerror = e => onError?.(e.error || e);
    this.rec.start(this.timeslice);
    this.startedAt = Date.now();
    return { mime: this.mime, extension: extensionFor(this.mime) };
  }

  #meter(onLevel) {
    this.ctx = new this.AudioCtx();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = this.ctx.createAnalyser();
    node.fftSize = 2048;
    src.connect(node);
    const buf = new Float32Array(node.fftSize);
    const tick = () => {
      if (!this.stream) return;
      node.getFloatTimeDomainData(buf);
      onLevel(analyseLevel(buf), this.elapsed);
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async stop() {
    if (!this.rec) return { seconds: 0, bytes: 0 };
    const seconds = this.elapsed;
    await new Promise(res => {
      this.rec.onstop = res;
      try { this.rec.stop(); } catch (e) { res(); }
    });
    if (this._raf) cancelAnimationFrame(this._raf);
    this.stream?.getTracks().forEach(t => t.stop());
    try { await this.ctx?.close(); } catch (e) {}
    this.stream = null; this.rec = null; this.ctx = null; this.startedAt = null;
    return { seconds, bytes: this.bytes, mime: this.mime, extension: extensionFor(this.mime) };
  }
}

// Appends each timeslice straight into her folder, so nothing accumulates in memory.
// A crash mid-recording therefore leaves everything captured up to that moment on disk.
export async function makeFileSink(store, path) {
  const handle = await store.writableStream(path);
  let position = 0;
  return {
    write: async blob => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      await handle.write({ type: 'write', position, data: buf });
      position += buf.length;
    },
    close: async () => { await handle.close(); return position; },
    get bytes() { return position; }
  };
}
