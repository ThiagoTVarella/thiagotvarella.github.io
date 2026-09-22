// The worker that runs the translation model, so the page stays responsive while a tape's
// sentences go through one at a time. Owns the sessions and the tokenizer; the logic is
// in translate-local.js.
import * as ort from '../vendor/ort/ort.wasm.bundle.min.mjs';
import { Tokenizer } from '../vendor/tokenizers/tokenizers.min.mjs';
import { Translator } from './translate-local.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let translator = null;
const bytes = async b => new Uint8Array(await b.arrayBuffer());
const session = async b =>
  ort.InferenceSession.create(await bytes(b), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      const t0 = performance.now();
      const sessions = {
        encoder: await session(m.files.encoder),
        decoder: await session(m.files.decoder),
        decoderPast: await session(m.files.decoderPast)
      };
      const tokenizer = new Tokenizer(JSON.parse(m.files.tokenizer), JSON.parse(m.files.config));
      translator = new Translator({ ort, sessions, tokenizer });
      self.postMessage({ type: 'loaded', id: m.id, ms: performance.now() - t0 });
    } else if (m.type === 'translate') {
      if (!translator) throw new Error('The translating model has not been loaded yet.');
      const t0 = performance.now();
      const en = await translator.translate(m.text);
      self.postMessage({ type: 'result', id: m.id, en, ms: performance.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
