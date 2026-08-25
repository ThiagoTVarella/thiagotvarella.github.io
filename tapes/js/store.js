// Storage. The website is the app; her folder is the database.
//
// Two backends behind one interface so the whole pipeline is testable headlessly:
//   FsaStore     -- File System Access, a real folder on her disk (Chrome/Edge desktop)
//   MemoryStore  -- in-memory, for tests
//
// Resume authority is the DIRECTORY LISTING, never a counter in tape.json. A crash
// between "chunk written" and "counter updated" would otherwise either double-bill or,
// far worse, silently skip a chunk of her grandfather's diary.

const DB = 'tape-digitizer', STORE = 'handles', KEY = 'projectDir';

export class MemoryStore {
  constructor() { this.files = new Map(); }
  async write(path, data) { this.files.set(path, data); }
  async writeJSON(path, obj) { await this.write(path, JSON.stringify(obj, null, 2)); }
  async read(path) { if (!this.files.has(path)) throw new Error('ENOENT ' + path); return this.files.get(path); }
  // Streaming writer, for recordings that must never be held in memory in full.
  async writableStream(path) {
    const parts = [];
    const self = this;
    return {
      async write(cmd) { parts.push(cmd.data); },
      async close() { 
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        self.files.set(path, out);
      }
    };
  }
  async readJSON(path) { return JSON.parse(await this.read(path)); }
  async exists(path) { return this.files.has(path); }
  async remove(path) { this.files.delete(path); }
  async list(dir) {
    const p = dir.endsWith('/') ? dir : dir + '/';
    const out = new Set();
    for (const k of this.files.keys()) {
      if (!k.startsWith(p)) continue;
      out.add(k.slice(p.length).split('/')[0]);
    }
    return [...out].sort();
  }
}

export class FsaStore {
  constructor(root) { this.root = root; }

  async #dir(parts, create) {
    let h = this.root;
    for (const p of parts) h = await h.getDirectoryHandle(p, { create });
    return h;
  }
  async #split(path, create) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    return [await this.#dir(parts, create), name];
  }

  // createWritable() stages to a temp file and commits on close(), so a crash mid-write
  // leaves the previous version intact. Always close(); never truncate-then-write.
  async write(path, data) {
    const [dir, name] = await this.#split(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try { await w.write(data); } finally { await w.close(); }
  }
  async writeJSON(path, obj) { await this.write(path, JSON.stringify(obj, null, 2)); }

  // A writable left OPEN so a long recording can be appended to as it arrives rather than
  // buffered whole. The caller must close() it; until then nothing is committed, which is
  // the same temp-file-and-commit behaviour every other write here relies on.
  async writableStream(path) {
    const [dir, name] = await this.#split(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    return await fh.createWritable();
  }

  async read(path) {
    const [dir, name] = await this.#split(path, false);
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  }
  async readBlob(path) {
    const [dir, name] = await this.#split(path, false);
    return await (await dir.getFileHandle(name)).getFile();
  }
  async readJSON(path) { return JSON.parse(await this.read(path)); }

  async exists(path) {
    try { await this.#split(path, false).then(([d, n]) => d.getFileHandle(n)); return true; }
    catch (e) { return false; }
  }
  async remove(path) {
    const [dir, name] = await this.#split(path, false);
    await dir.removeEntry(name);
  }
  async list(dir) {
    let h;
    try { h = await this.#dir(dir.split('/').filter(Boolean), false); }
    catch (e) { return []; }
    const out = [];
    for await (const name of h.keys()) out.push(name);
    return out.sort();
  }
}

// --- folder handle persistence -------------------------------------------

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = async (mode, fn) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
};

export const supportsFolders = () =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function pickProject() {
  const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tapes' });
  await tx('readwrite', s => s.put(h, KEY));
  return new FsaStore(h);
}

// Reopening after a reload needs a user gesture to re-grant permission, so this must be
// called from a click handler -- the queue cannot silently resume itself.
export async function restoreProject({ prompt = false } = {}) {
  let h;
  try { h = await tx('readonly', s => s.get(KEY)); } catch (e) { return null; }
  if (!h) return null;
  const opts = { mode: 'readwrite' };
  let perm = await h.queryPermission(opts);
  if (perm !== 'granted' && prompt) perm = await h.requestPermission(opts);
  return perm === 'granted' ? new FsaStore(h) : null;
}

export async function forgetProject() { await tx('readwrite', s => s.delete(KEY)); }

// --- tape-level layout ----------------------------------------------------

export const paths = {
  glossary: () => 'glossary.json',
  tapeDir:  id => `tapes/${id}`,
  tape:     id => `tapes/${id}/tape.json`,
  chunkDir: id => `tapes/${id}/chunks`,
  chunkAudio: (id, i) => `tapes/${id}/chunks/${String(i).padStart(3, '0')}.mp3`,
  chunkText:  (id, i) => `tapes/${id}/chunks/${String(i).padStart(3, '0')}.gr.json`,
  translation: id => `tapes/${id}/translation.en.json`,
  flags:       id => `tapes/${id}/flags.json`,
  transcriptTxt: id => `tapes/${id}/transcript.gr.txt`,
  translationTxt: id => `tapes/${id}/translation.en.txt`
};

const chunkIndex = name => {
  const m = /^(\d+)\.gr\.json$/.exec(name);
  return m ? parseInt(m[1], 10) : null;
};

// Rebuild progress from what is actually on disk. This is the resume authority.
// A chunk counts as done only if its transcript file exists AND parses -- a half-written
// file from a hard kill is treated as not-done and simply redone (~$0.01).
export async function reconcile(store, tapeId) {
  const names = await store.list(paths.chunkDir(tapeId));
  const done = [], corrupt = [];
  for (const n of names) {
    const i = chunkIndex(n);
    if (i === null) continue;
    try {
      const j = await store.readJSON(`${paths.chunkDir(tapeId)}/${n}`);
      if (j && Array.isArray(j.segments)) done.push(i); else corrupt.push(i);
    } catch (e) { corrupt.push(i); }
  }
  return { done: done.sort((a, b) => a - b), corrupt: corrupt.sort((a, b) => a - b) };
}

// Chunks still to transcribe: everything planned, minus what disk says is finished.
export async function pendingChunks(store, tapeId, planned) {
  const { done } = await reconcile(store, tapeId);
  const haveIt = new Set(done);
  return planned.map((c, i) => ({ ...c, index: i })).filter(c => !haveIt.has(c.index));
}

// A cheap merge-and-write for fields that change often (live progress, the current stage)
// and must not pay refreshTapeSummary's cost of rescanning every chunk file on disk each
// time. Progress is reported many times a second during a run; refreshTapeSummary is
// reserved for real stage boundaries where recomputing cost/segments actually matters.
export async function updateTape(store, tapeId, patch) {
  let tape = {};
  try { tape = await store.readJSON(paths.tape(tapeId)); } catch (e) {}
  const merged = { ...tape, ...patch, id: tapeId };
  await store.writeJSON(paths.tape(tapeId), merged);
  return merged;
}

export async function saveChunkText(store, tapeId, result) {
  await store.writeJSON(paths.chunkText(tapeId, result.chunk), result);
}

// tape.json is a cache/summary. It is rewritten from disk truth, never trusted over it.
export async function refreshTapeSummary(store, tapeId, extra = {}) {
  let tape = {};
  try { tape = await store.readJSON(paths.tape(tapeId)); } catch (e) {}
  const { done, corrupt } = await reconcile(store, tapeId);
  let cost = 0, segments = 0;
  for (const i of done) {
    try {
      const c = await store.readJSON(paths.chunkText(tapeId, i));
      cost += c.cost || 0;
      segments += (c.segments || []).length;
    } catch (e) {}
  }
  const merged = { ...tape, ...extra, id: tapeId,
    chunksDone: done.length, chunksCorrupt: corrupt.length,
    segments, cost: +cost.toFixed(6) };
  await store.writeJSON(paths.tape(tapeId), merged);
  return merged;
}
