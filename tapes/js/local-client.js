// Main-thread side of listening on this computer: fetches the weights into her folder
// the first time, hands them to the worker, and turns each chunk's audio into the 16 kHz
// samples the model wants. Audio decoding has to happen here because the browser's
// decoder is not available inside a worker.
import { ensureWeights, loadWeights, SAMPLE_RATE } from './local.js';

export async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  // An offline context decodes without needing a user gesture, and resamples to its own
  // rate on the way, so whatever ffmpeg wrote comes out as 16 kHz mono.
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SAMPLE_RATE });
  const audio = await ctx.decodeAudioData(buf);
  if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / audio.numberOfChannels;
  }
  return out;
}

export class LocalEngine {
  constructor(store, { workerUrl } = {}) {
    this.store = store;
    this.workerUrl = workerUrl || new URL('./local-worker.js', import.meta.url);
    this.worker = null;
    this.seq = 0;
    this.waiting = new Map();
  }

  // Download whatever is missing, then load the model in the worker. `onProgress` is
  // called with { phase: 'download', done, total } while fetching and { phase: 'load' }
  // while the runtime is initialising.
  async prepare({ onProgress, signal } = {}) {
    await ensureWeights(this.store, {
      signal,
      onProgress: p => onProgress?.({ phase: 'download', done: p.overallDone, total: p.overallTotal })
    });
    onProgress?.({ phase: 'load' });
    const files = await loadWeights(this.store);
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = e => {
      const m = e.data || {};
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === 'error') w.reject(Object.assign(new Error(m.message), { retryable: false }));
      else w.resolve(m);
    };
    this.worker.onerror = e => {
      for (const w of this.waiting.values()) w.reject(Object.assign(new Error(e.message || 'The listening model stopped working.'), { retryable: false }));
      this.waiting.clear();
    };
    return this.#call({ type: 'load', files });
  }

  async transcribeBlob(blob) {
    const pcm = await decodeTo16k(blob);
    return this.transcribePcm(pcm);
  }

  transcribePcm(pcm) {
    return this.#call({ type: 'transcribe', pcm }, [pcm.buffer]);
  }

  #call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    this.waiting.clear();
  }
}
