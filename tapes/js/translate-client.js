// Main-thread side of translating on this computer: weights into her folder the first
// time, then a worker that turns one Greek sentence into English at a time. Mirrors
// local-client.js; the queue talks to it through translateAll().
import { ensureWeights, loadWeights } from './local.js';
import { TRANSLATOR, translateSegments } from './translate-local.js';

export class LocalTranslator {
  constructor(store, { workerUrl } = {}) {
    this.store = store;
    this.workerUrl = workerUrl || new URL('./translate-worker.js', import.meta.url);
    this.worker = null;
    this.seq = 0;
    this.waiting = new Map();
  }

  async prepare({ onProgress, signal } = {}) {
    const { files, repo, dir } = TRANSLATOR;
    await ensureWeights(this.store, {
      files, repo, dir, signal,
      onProgress: p => onProgress?.({ phase: 'download', done: p.overallDone, total: p.overallTotal })
    });
    onProgress?.({ phase: 'load' });
    const loaded = await loadWeights(this.store, files, dir);
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
      for (const w of this.waiting.values()) w.reject(Object.assign(new Error(e.message || 'The translating model stopped working.'), { retryable: false }));
      this.waiting.clear();
    };
    return this.#call({ type: 'load', files: loaded });
  }

  // One sentence. Exposed for tests and for the smoke harness; the queue uses translateAll.
  async translate(text) {
    const r = await this.#call({ type: 'translate', text });
    return r.en;
  }

  // The same contract as translate.js's translateAll: segments in, the four outputs out.
  translateAll(segments, opts = {}) {
    return translateSegments(segments, this, { onProgress: opts.onProgress, signal: opts.signal });
  }

  #call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
    this.waiting.clear();
  }
}
