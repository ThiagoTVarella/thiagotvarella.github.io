// Listening on her own computer: NVIDIA's Parakeet TDT 0.6B v3, run in the page through
// ONNX Runtime Web. Nothing recorded leaves the machine; the Greek text still goes out
// to be put into English, which is a separate choice.
//
// The model is the one Desert Ant ship as "Voz" with the weights unchanged, but their
// runtime is Core ML on Apple silicon only, so it cannot run here. The same weights exist
// as ONNX, and that runs in any desktop browser with WebAssembly -- a slower path, but the
// one that needs nothing installed. Vendor's own numbers on Greek are poor (20.7% of words
// wrong on clean read speech; worse on noisy long-form), which is why the setting says so
// in plain words rather than promising anything.
//
// This module holds everything that does not need a browser: parsing the vocabulary, the
// TDT greedy decode loop, turning tokens into timed words, and the weights manifest. The
// worker in local-worker.js supplies ONNX Runtime sessions; the client in local-client.js
// supplies decoded audio. Both are thin on purpose so the logic here is testable in node.

export const LOCAL = {
  id: 'nvidia/parakeet-tdt-0.6b-v3',
  // The ONNX export with the NeMo mel frontend included as its own tiny model, so the
  // features are computed by the same graph NeMo uses rather than a hand-ported filterbank.
  repo: 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/',
  dir: 'models/parakeet-tdt-0.6b-v3',
  files: [
    { role: 'vocab',    name: 'vocab.txt',                    bytes: 93939 },
    { role: 'features', name: 'nemo128.onnx',                 bytes: 139764 },
    { role: 'decoder',  name: 'decoder_joint-model.int8.onnx', bytes: 18202004 },
    { role: 'encoder',  name: 'encoder-model.int8.onnx',       bytes: 652183999 }
  ]
};
export const LOCAL_BYTES = LOCAL.files.reduce((n, f) => n + f.bytes, 0);

// 10ms hop in the mel frontend, 8x subsampling in the encoder: one encoder frame is 80ms.
export const FRAME_SEC = 0.08;
export const SAMPLE_RATE = 16000;
// TDT predicts how many frames to jump after each symbol; the export has five choices.
export const DURATIONS = [0, 1, 2, 3, 4];

// ------------------------------------------------------------------ vocabulary

// vocab.txt is one "piece id" per line, SentencePiece style: a piece beginning with ▁
// starts a new word. The blank symbol is the last id and is never part of the text.
export function parseVocab(text) {
  const pieces = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const sp = line.lastIndexOf(' ');
    const piece = sp < 0 ? line : line.slice(0, sp);
    const id = sp < 0 ? pieces.length : parseInt(line.slice(sp + 1), 10);
    if (Number.isFinite(id)) pieces[id] = piece;
  }
  const blank = pieces.indexOf('<blk>');
  return { pieces, blank: blank >= 0 ? blank : pieces.length - 1 };
}

const isSpecial = piece => /^<.*>$/.test(piece);

// The vocabulary cannot spell final sigma: not one of its 8192 pieces contains ς, so the
// model emits <unk> wherever a Greek word ends in one, and dropping it would turn Κώστας
// into Κώστα, which is a different grammatical case. ς never appears anywhere but the end
// of a word, so an unknown piece continuing a Greek word is rendered as ς. This repairs the
// tokenizer, not the model's hearing: it never adds a letter the model did not signal.
// The vocabulary also lacks a few accented capitals and dialytika forms (Ί Ύ Ώ ΐ ΰ ϋ), which
// are rarer and fall elsewhere in a word, so the repair only applies to an unknown piece
// that closes the word: the next piece starts a new word, is punctuation, or does not exist.
const GREEK_LETTER = /[\u0370-\u03ff\u1f00-\u1fff]$/;
const closesWord = next => next == null || next.startsWith('▁') || !/\p{L}/u.test(next);
const repairUnknown = (cur, next) => (cur && GREEK_LETTER.test(cur.word) && closesWord(next)) ? 'ς' : '';

// ------------------------------------------------------------------ decoding

function argmax(arr, from, to) {
  let best = from, v = arr[from];
  for (let i = from + 1; i < to; i++) if (arr[i] > v) { v = arr[i]; best = i; }
  return best;
}

// Greedy TDT decoding over `frames` encoder frames. `step(t, prevToken, state)` runs the
// prediction network + joint for one frame and resolves to `{ logits, state }`, where
// logits holds `vocabSize` symbol scores followed by one score per duration choice.
//
// The time-advance rule is the whole point of TDT and is easy to get subtly wrong, so it
// is written out rather than folded into arithmetic:
//   - a predicted duration d > 0 always moves d frames on, blank or not;
//   - a symbol with duration 0 stays on the frame so more symbols can be emitted, up to
//     maxSymbols, after which the frame is forced onward;
//   - a blank with duration 0 moves one frame on, or the loop would never end.
// The prediction network only advances on a real symbol -- blanks leave its state alone.
export async function greedyTdt(frames, step, { blank, vocabSize, maxSymbols = 10 } = {}) {
  const out = [];
  let t = 0, prev = blank, state = null, emitted = 0;
  while (t < frames) {
    const { logits, state: next } = await step(t, prev, state);
    const k = argmax(logits, 0, vocabSize);
    const d = logits.length > vocabSize ? DURATIONS[argmax(logits, vocabSize, logits.length) - vocabSize] || 0 : 0;
    if (k !== blank) { out.push({ id: k, t }); prev = k; state = next; emitted++; }
    if (d > 0) { t += d; emitted = 0; }
    else if (k === blank || emitted >= maxSymbols) { t += 1; emitted = 0; }
  }
  return out;
}

// Tokens carry the frame they were emitted on. A word starts at its first piece's frame
// and ends one frame after its last piece's. The model places pieces near where they are
// heard rather than exactly at their onset, so these are for finding a line on the tape,
// not for cutting audio.
export function tokensToWords(tokens, vocab, frameSec = FRAME_SEC) {
  const words = [];
  let cur = null;
  const finish = () => { if (cur && cur.word) words.push(cur); cur = null; };
  const pieceAt = i => (i < tokens.length ? vocab.pieces[tokens[i].id] : null);
  for (let i = 0; i < tokens.length; i++) {
    const { id, t } = tokens[i];
    const piece = pieceAt(i);
    if (piece == null || id === vocab.blank) continue;
    let starts = false, text;
    if (piece === '<unk>') { text = repairUnknown(cur, pieceAt(i + 1)); if (!text) continue; }
    else if (isSpecial(piece)) continue;
    else { starts = piece.startsWith('▁'); text = starts ? piece.slice(1) : piece; }
    if (starts || !cur) { finish(); cur = { word: '', start: +(t * frameSec).toFixed(3), end: 0 }; }
    cur.word += text;
    cur.end = +((t + 1) * frameSec).toFixed(3);
  }
  finish();
  return words;
}

export const wordsToText = words => words.map(w => w.word).join(' ').trim();

// ------------------------------------------------------------------ the listener

// Wraps three ONNX Runtime sessions (mel frontend, encoder, prediction+joint network) into
// one call: 16 kHz mono float samples in, timed words out. `ort` is injected so the class
// is constructible in tests with fakes.
export class Listener {
  constructor({ ort, sessions, vocab, maxSymbols = 10 }) {
    this.ort = ort;
    this.s = sessions;
    this.vocab = vocab;
    this.maxSymbols = maxSymbols;
    this.meta = describeDecoder(sessions.decoder);
  }

  async transcribe(pcm) {
    const { ort } = this;
    const ms = {};
    let t0 = now();
    const feats = await this.s.features.run({
      waveforms: new ort.Tensor('float32', pcm, [1, pcm.length]),
      waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(pcm.length)]), [1])
    });
    ms.features = now() - t0; t0 = now();

    const nFrames = Number(feats.features_lens.data[0]);
    const enc = await this.s.encoder.run({
      audio_signal: feats.features,
      length: new ort.Tensor('int64', BigInt64Array.from([BigInt(nFrames)]), [1])
    });
    ms.encoder = now() - t0; t0 = now();

    const E = enc.outputs;                       // [1, D, T]
    const D = E.dims[1], T = E.dims[2];
    const frames = Math.min(T, Number(enc.encoded_lengths.data[0]));
    const data = E.data;
    const frame = new Float32Array(D);
    const { targets: tType, states } = this.meta;
    const Ints = tType === 'int64' ? BigInt64Array : Int32Array;
    const int = v => tType === 'int64' ? BigInt(v) : v;
    const zero = i => new ort.Tensor('float32', new Float32Array(states[i].reduce((a, b) => a * b, 1)), states[i]);
    const zeros = [zero(0), zero(1)];

    const step = async (t, prev, state) => {
      for (let d = 0; d < D; d++) frame[d] = data[d * T + t];
      const r = await this.s.decoder.run({
        encoder_outputs: new ort.Tensor('float32', frame, [1, D, 1]),
        targets: new ort.Tensor(tType, Ints.from([int(prev)]), [1, 1]),
        target_length: new ort.Tensor(tType, Ints.from([int(1)]), [1]),
        input_states_1: state ? state[0] : zeros[0],
        input_states_2: state ? state[1] : zeros[1]
      });
      return { logits: r.outputs.data, state: [r.output_states_1, r.output_states_2] };
    };
    const tokens = await greedyTdt(frames, step,
      { blank: this.vocab.blank, vocabSize: this.vocab.pieces.length, maxSymbols: this.maxSymbols });
    ms.decoder = now() - t0;

    const words = tokensToWords(tokens, this.vocab);
    return { text: wordsToText(words), words, frames, seconds: pcm.length / SAMPLE_RATE, ms };
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// What the prediction network wants: integer type of `targets`, and the shapes of its two
// state tensors. Read from the session's metadata when the runtime exposes it; the
// fallback is what this export uses.
export function describeDecoder(session) {
  const out = { targets: 'int32', states: [[2, 1, 640], [2, 1, 640]] };
  const meta = session && session.inputMetadata;
  if (!Array.isArray(meta)) return out;
  for (const m of meta) {
    if (!m || !m.name) continue;
    if (m.name === 'targets' && (m.type === 'int64' || m.type === 'int32')) out.targets = m.type;
    const si = m.name === 'input_states_1' ? 0 : m.name === 'input_states_2' ? 1 : -1;
    if (si >= 0 && Array.isArray(m.shape) && m.shape.length === 3) {
      out.states[si] = m.shape.map(d => (typeof d === 'number' && d > 0) ? d : 1);
    }
  }
  return out;
}

// ------------------------------------------------------------------ weights on disk

// Her folder is the archive, so the model lives there too: browsers evict their caches,
// a folder does not, and a copy of the folder carries everything needed to run without
// the network. A file counts as present only at its exact expected size -- an aborted
// download is worse than none, because it would fail in a way that looks like the model
// being wrong rather than incomplete.
export const weightPath = f => `${LOCAL.dir}/${f.name}`;

export async function weightsPresent(store, files = LOCAL.files) {
  for (const f of files) {
    if (!(await store.exists(weightPath(f)))) return false;
    const blob = await store.readBlob(weightPath(f));
    if (!blob || blob.size !== f.bytes) return false;
  }
  return true;
}

export async function ensureWeights(store, { fetchImpl, onProgress, signal, files = LOCAL.files } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const overallTotal = files.reduce((n, x) => n + x.bytes, 0);
  // The queue's stop flag is a plain object, not an AbortSignal; fetch only accepts the real thing.
  const realSignal = (typeof AbortSignal !== 'undefined' && signal instanceof AbortSignal) ? signal : undefined;
  let overall = 0;
  const report = (file, done) =>
    onProgress?.({ file: file.name, done, total: file.bytes, overallDone: overall + done, overallTotal });
  for (const file of files) {
    const path = weightPath(file);
    const have = (await store.exists(path)) ? (await store.readBlob(path))?.size : -1;
    if (have === file.bytes) { overall += file.bytes; report(file, file.bytes); continue; }
    if (signal?.aborted) throw abortError();
    const res = await f(LOCAL.repo + file.name, realSignal ? { signal: realSignal } : {});
    if (!res.ok) throw new Error(`Couldn't fetch part of the listening model (HTTP ${res.status}). It can be tried again.`);
    const out = await store.writableStream(path);
    let done = 0;
    try {
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (signal?.aborted) throw abortError();
          await out.write({ type: 'write', data: value });
          done += value.byteLength;
          report(file, done);
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        await out.write({ type: 'write', data: buf });
        done = buf.byteLength;
        report(file, done);
      }
    } catch (e) {
      // Never commit a partial file: closing would make it look present at the wrong size.
      await out.abort?.().catch(() => {});
      throw e;
    }
    if (done !== file.bytes) {
      await out.abort?.().catch(() => {});
      throw new Error('Part of the listening model came down incomplete. It can be tried again.');
    }
    await out.close();
    overall += file.bytes;
  }
  return true;
}

export async function loadWeights(store) {
  const out = {};
  for (const f of LOCAL.files) {
    const blob = await store.readBlob(weightPath(f));
    out[f.role] = f.role === 'vocab' ? await blob.text() : blob;
  }
  return out;
}

function abortError() {
  const e = new Error('Stopped');
  e.name = 'AbortError';
  return e;
}

// Rough, honest sizing for the interface: "about 670 MB".
export function describeDownload(bytes = LOCAL_BYTES) {
  const mb = bytes / 1e6;
  return mb >= 1000 ? `about ${(mb / 1000).toFixed(1)} GB` : `about ${Math.round(mb / 10) * 10} MB`;
}
