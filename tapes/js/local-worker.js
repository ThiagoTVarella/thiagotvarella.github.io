// The worker that actually runs the model, so that a minute of listening does not freeze
// the page. It owns the ONNX Runtime sessions; local.js owns the logic.
import * as ort from '../vendor/ort/ort.wasm.bundle.min.mjs';
import { Listener, parseVocab } from './local.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
// Threads need SharedArrayBuffer, which needs response headers GitHub Pages cannot send.
// One thread everywhere is slower but works on every machine the page can open on.
ort.env.wasm.numThreads = 1;

let listener = null;

const bytes = async b => new Uint8Array(await b.arrayBuffer());
const session = async b =>
  ort.InferenceSession.create(await bytes(b), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      const t0 = performance.now();
      const sessions = {
        features: await session(m.files.features),
        decoder: await session(m.files.decoder),
        encoder: await session(m.files.encoder)
      };
      listener = new Listener({ ort, sessions, vocab: parseVocab(m.files.vocab) });
      self.postMessage({ type: 'loaded', id: m.id, ms: performance.now() - t0 });
    } else if (m.type === 'transcribe') {
      if (!listener) throw new Error('The listening model has not been loaded yet.');
      const r = await listener.transcribe(m.pcm);
      self.postMessage({ type: 'result', id: m.id, ...r });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
