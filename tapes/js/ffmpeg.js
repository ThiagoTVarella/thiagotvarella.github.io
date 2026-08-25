// ffmpeg.wasm wrapper: the only part of the pipeline that touches real audio bytes.
//
// Two constraints shape everything here.
//
// 1. SINGLE-THREADED CORE. The multithreaded build needs SharedArrayBuffer, which needs
//    COOP/COEP response headers, which GitHub Pages cannot set. @ffmpeg/core (not core-mt).
//
// 2. THE INPUT MUST NOT ENTER THE WASM HEAP. writeFile() copies the whole file in: a
//    90-minute WAV is ~0.9 GB and a 3-hour tape ~1.9 GB, at or past the wasm32 2 GB ceiling
//    before ffmpeg's own working memory. WORKERFS reads lazily from the File on disk
//    instead. Outputs are deleted from MEMFS the moment they are read out.

import { planChunks, markSilentChunks, parseSilenceLog, silenceScanArgs, chunkArgs, DEFAULTS }
  from './audio.js';

// The ESM core, deliberately -- NOT the umd one the docs lead you to.
//
// @ffmpeg/ffmpeg spawns its worker with `type: "module"`, where `importScripts` does not
// exist. Its worker catches that failure and falls back to a dynamic import, first
// rewriting '/umd/' to '/esm/' in the URL. So pointing at the umd build means the umd build
// is never what loads: it fails, gets string-replaced, and the esm build loads instead.
// Naming the esm path directly removes a guaranteed-to-fail step and, more importantly,
// stops the whole thing breaking for anyone who vendors the files to a path with no
// '/umd/' in it to rewrite -- which is exactly how this was found.
const CDN = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
const MOUNT = '/tape';

// "Duration: 00:45:12.34, start: ..." -- ffmpeg.wasm ships no ffprobe, so the log is the
// only source. Take the LAST match: a stream line can repeat it.
export function parseDuration(log) {
  const re = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/g;
  let m, last = null;
  while ((m = re.exec(String(log || ''))) !== null) last = m;
  if (!last) return null;
  return (+last[1]) * 3600 + (+last[2]) * 60 + (+last[3]) +
         (last[4] ? parseFloat('0.' + last[4]) : 0);
}

// A stream recorded live in the browser has NO duration in its container -- MediaRecorder
// writes timeslices as they arrive and never goes back to fill in the header. ffmpeg reports
// `Duration: N/A` for these, which is the same underlying defect that made the <audio>
// element report Infinity for the test playback.
//
// The length is still recoverable: any pass that actually decodes the stream prints its
// running position as `time=HH:MM:SS.ms`, and the last one it prints is where the audio
// ended. Since silence detection already decodes the whole file, the real duration is
// available from a pass we are running anyway -- no extra work.
export function parseProgressDuration(log) {
  const re = /time=\s*(-?\d+):(\d{2}):(\d{2})(?:\.(\d+))?/g;
  let m, last = null;
  while ((m = re.exec(String(log || ''))) !== null) last = m;
  if (!last) return null;
  const secs = (+last[1]) * 3600 + (+last[2]) * 60 + (+last[3]) +
               (last[4] ? parseFloat('0.' + last[4]) : 0);
  return secs > 0 ? secs : null;
}

export class TapeAudio {
  // `factory` exists so tests can drive the whole orchestration with a fake engine --
  // no wasm, no network, no audio.
  constructor({ factory, baseURL = CDN, onLog } = {}) {
    this.factory = factory;
    this.baseURL = baseURL;
    this.onLog = onLog;
    this.ff = null;
    this.log = [];
    this.mounted = null;
  }

  async load(onProgress) {
    if (this.ff) return this.ff;
    const make = this.factory || (async () => {
      // Imported from OUR origin, not a CDN. classes.js starts its worker with
      // `new Worker(new URL("./worker.js", import.meta.url))`, and worker scripts must be
      // same-origin -- a browser rule CORS cannot relax. Importing this package from unpkg
      // makes that URL cross-origin and the browser refuses to construct the worker:
      // "Script at 'https://unpkg.com/.../worker.js' cannot be accessed from origin ...".
      // See ../vendor/ffmpeg/README.md.
      const { FFmpeg } = await import('../vendor/ffmpeg/index.js');
      const ff = new FFmpeg();
      // The 31MB core stays on the CDN: the worker pulls it with a dynamic import(), and
      // cross-origin *module* imports are allowed where worker construction is not.
      await ff.load({
        coreURL: `${this.baseURL}/ffmpeg-core.js`,
        wasmURL: `${this.baseURL}/ffmpeg-core.wasm`
      });
      return ff;
    });
    this.ff = await make(onProgress);
    this.ff.on?.('log', ({ message }) => {
      this.log.push(message);
      this.onLog?.(message);
    });
    return this.ff;
  }

  async #run(args) {
    this.log = [];
    await this.ff.exec(args);
    return this.log.join('\n');
  }

  // Mount the File itself. Nothing is copied; ffmpeg reads it lazily off disk.
  async mount(file) {
    await this.unmount();
    try { await this.ff.createDir(MOUNT); } catch (e) { /* already there */ }
    await this.ff.mount('WORKERFS', { files: [file] }, MOUNT);
    this.mounted = `${MOUNT}/${file.name}`;
    return this.mounted;
  }

  async unmount() {
    if (!this.mounted) return;
    try { await this.ff.unmount(MOUNT); } catch (e) {}
    this.mounted = null;
  }

  async probeDuration(input) {
    // ffmpeg with no output exits non-zero after printing the header; that is expected.
    let log = '';
    try { log = await this.#run(['-i', input]); }
    catch (e) { log = this.log.join('\n'); }
    return parseDuration(log);
  }

  // Returns { silences, duration }. The duration is what this decode pass actually observed,
  // which is the only way to learn the length of a stream whose header does not carry one.
  async scanSilences(input, total, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    let log = '', ok = true;
    try { log = await this.#run(silenceScanArgs(input, o)); }
    catch (e) { log = this.log.join('\n'); ok = false; }
    // Only trust a measured length from a pass that actually ran to the end. A decode that
    // died early still printed a position, and believing it would silently treat a
    // 45-minute side as a few seconds -- losing almost the whole recording without an error.
    const measured = ok ? parseProgressDuration(log) : null;
    const duration = total ?? measured;
    // parseSilenceLog needs the total to close a silence that runs to the end of the file,
    // so it must be given the measured value when the header had none.
    return { silences: parseSilenceLog(log, duration), duration, measured, ok };
  }

  // One chunk, read out and immediately freed. Never accumulate outputs in MEMFS.
  async cutChunk(input, chunk, index, opts = {}) {
    const name = `c${String(index).padStart(3, '0')}.mp3`;
    try {
      await this.#run(chunkArgs(input, chunk, name, opts));
      const data = await this.ff.readFile(name);
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } finally {
      try { await this.ff.deleteFile(name); } catch (e) {}
    }
  }

  async terminate() {
    await this.unmount();
    try { await this.ff?.terminate?.(); } catch (e) {}
    this.ff = null;
  }
}

// Full preparation of one recording. Emits chunks one at a time via `onChunk` so the caller
// can write each to disk and drop it -- a whole tape's chunks are never held in memory.
//
// `onChunk(chunk, bytes)` may be async; it is awaited before the next chunk is cut.
export async function prepareTape(file, {
  engine, onChunk, onProgress, onStage, signal, ...opts
} = {}) {
  const audio = engine || new TapeAudio();
  const stage = s => onStage?.(s);

  stage('loading');
  await audio.load();

  stage('reading');
  const input = await audio.mount(file);

  // May be null: a stream recorded in the browser carries no duration in its header.
  // That is not a failure -- the silence scan below decodes the whole file anyway and
  // reports the length it actually observed.
  const headerDuration = await audio.probeDuration(input);

  stage('listening');
  const scan = await audio.scanSilences(input, headerDuration, opts);
  const silences = scan.silences;
  const duration = headerDuration ?? scan.duration;

  if (!duration) throw new Error("Couldn't work out how long this recording is.");

  const planned = markSilentChunks(planChunks(silences, duration, opts), silences);

  stage('splitting');
  const made = [];
  for (let i = 0; i < planned.length; i++) {
    if (signal?.aborted) break;
    const chunk = { ...planned[i], index: i };

    // Pure silence -- leader tape, dead ends of sides. Never cut it, never send it.
    if (chunk.isSilent) {
      made.push({ ...chunk, skipped: 'silent', bytes: 0 });
      onProgress?.(i + 1, planned.length);
      continue;
    }

    const bytes = await audio.cutChunk(input, chunk, i, opts);
    await onChunk?.(chunk, bytes);
    made.push({ ...chunk, bytes: bytes.length });
    onProgress?.(i + 1, planned.length);
  }

  await audio.unmount();
  return { duration, silences, chunks: made,
           skipped: made.filter(c => c.skipped).length };
}
