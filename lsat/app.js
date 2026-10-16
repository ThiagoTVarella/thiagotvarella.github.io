'use strict';
/* LSAT Cards: a single-user, Quizlet-style study app. Everything lives in localStorage.
   Views are routed by the URL hash:
     #/                     library
     #/new                  new set
     #/set/:id              set overview
     #/set/:id/edit         edit set
     #/set/:id/flashcards | learn | test | match                                   */
(() => {
const KEY = 'lsat-cards.v1';
const app = document.getElementById('app');

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fsClass = s => { const n = String(s).length; return n < 40 ? 'fs-1' : n < 120 ? 'fs-2' : n < 300 ? 'fs-3' : 'fs-4'; };
const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
/* A shower of petals for the big moments. */
function celebrate(n = 28) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const kinds = ['🌸', '🌼', '🌻', '🌷', '☀️', '🌺'];
  for (let k = 0; k < n; k++) {
    const p = document.createElement('span');
    p.className = 'petal'; p.textContent = kinds[k % kinds.length];
    p.style.left = Math.random() * 100 + 'vw';
    p.style.fontSize = 18 + Math.random() * 18 + 'px';
    p.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
    p.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
    p.style.animationDuration = 2.4 + Math.random() * 2.2 + 's';
    p.style.animationDelay = Math.random() * .7 + 's';
    document.body.append(p);
    setTimeout(() => p.remove(), 5600);
  }
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late? The sun is on its way 🌙' : h < 12 ? 'Good morning, sunshine ☀️'
    : h < 17 ? 'Good afternoon 🌻' : h < 21 ? 'Good evening 🌷' : 'One more set before bed? 🌙';
}
function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- storage ---------------- */
const DEFAULT_PREFS = {
  fc:    { shuffle: false, track: true, starred: false, front: 'term' },
  learn: { answerWith: 'term', written: true, starred: false },
  test:  { count: 20, answerWith: 'term', starred: false, types: { tf: true, mc: true, match: true, written: true } },
  match: { starred: false },
};
let db;
function newSet(o = {}) {
  const now = Date.now();
  return { id: uid(), title: o.title || 'Untitled set', description: o.description || '', created: now, updated: now,
    studied: 0, cards: (o.cards || []).map(c => ({ id: uid(), term: c.term || '', definition: c.definition || '', starred: false })),
    progress: {}, matchBest: null, tests: [], seed: o.seed || null };
}
function load() {
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db || !Array.isArray(db.sets)) db = { sets: [], seeded: false };
  db.prefs = Object.assign({}, structuredClone(DEFAULT_PREFS), db.prefs || {});
  for (const k in DEFAULT_PREFS) db.prefs[k] = Object.assign({}, DEFAULT_PREFS[k], db.prefs[k]);
  db.sets.forEach(normalizeSet);
  if (!db.seeded && Array.isArray(window.SEED_DECKS)) {
    window.SEED_DECKS.forEach(d => db.sets.push(newSet({ ...d, seed: d.title })));
    db.seeded = true; save();
  }
}
function normalizeSet(s) {
  s.id ||= uid(); s.title ||= 'Untitled set'; s.description ||= ''; s.cards ||= [];
  s.progress ||= {}; s.tests ||= []; s.matchBest ??= null; s.studied ||= 0; s.updated ||= Date.now();
  s.cards.forEach(c => { c.id ||= uid(); c.term ??= ''; c.definition ??= ''; c.starred = !!c.starred; });
  return s;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Could not save: ' + e.message); }
}
const getSet = id => db.sets.find(s => s.id === id);

/* progress: undefined = not studied, 0 = still learning, 1 = familiar, 2 = mastered */
const lvl = (set, c) => set.progress[c.id];
function counts(set) {
  const r = { fresh: 0, learning: 0, mastered: 0, total: set.cards.length };
  set.cards.forEach(c => { const l = lvl(set, c); if (l === undefined) r.fresh++; else if (l >= 2) r.mastered++; else r.learning++; });
  return r;
}
function bar(set) {
  const p = counts(set), t = p.total || 1;
  return `<div class="bar" title="${p.mastered} mastered, ${p.learning} learning, ${p.fresh} not studied">
    <span class="m" style="width:${p.mastered / t * 100}%"></span><span class="l" style="width:${p.learning / t * 100}%"></span></div>`;
}
/* Cards for a mode, honouring "starred only" (falls back to all if nothing is starred). */
function pick(set, starredOnly) {
  const starred = set.cards.filter(c => c.starred);
  if (starredOnly && starred.length) return { cards: starred, note: '' };
  if (starredOnly) return { cards: set.cards, note: 'No starred terms yet, so you are studying all of them.' };
  return { cards: set.cards, note: '' };
}
const sides = (c, answerWith) => answerWith === 'definition'
  ? { prompt: c.term, answer: c.definition, promptLabel: 'Term', answerLabel: 'definition' }
  : { prompt: c.definition, answer: c.term, promptLabel: 'Definition', answerLabel: 'term' };

/* ---------------- written-answer grading ---------------- */
function norm(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
}
function lev(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/* Accepted forms of an answer: the whole thing, the thing without (parentheticals) or quoted
   stems, and the pieces either side of "/", ";" or a " - " label separator. So the card
   "Strengthen - 'Which ... strengthens the argument?'" accepts "strengthen". */
function accepted(answer) {
  const out = new Set();
  const add = s => { const n = norm(s); if (n) out.add(n); };
  const base = String(answer);
  const stripped = base.replace(/\([^)]*\)/g, ' ').replace(/["“][^"”]*["”]/g, ' ').replace(/(^|\s)'[^']*'(?=\s|$|[.,;:?!])/g, ' ');
  [base, stripped].forEach(s => {
    add(s);
    s.split(/\s+[-–—:]\s+|:\s/)[0] && add(s.split(/\s+[-–—:]\s+|:\s/)[0]);
    s.split(/\s*[\/;]\s*/).forEach(add);
  });
  return [...out];
}
function isCorrect(given, answer) {
  const g = norm(given);
  if (!g) return false;
  return accepted(answer).some(a => g === a || (a.length >= 4 && lev(g, a) <= Math.max(1, Math.floor(a.length / 7))));
}

/* ---------------- router ---------------- */
let teardown = null;
let keyHandler = null;
document.addEventListener('keydown', e => { if (keyHandler) keyHandler(e); });
function route() {
  if (teardown) { try { teardown(); } catch {} }
  teardown = null; keyHandler = null; app.onchange = null;
  const [a, id, mode] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (a === 'new') return viewEdit(null);
  if (a === 'set') {
    const set = getSet(id);
    if (!set) { location.hash = '#/'; return; }
    if (!mode) return viewSet(set);
    if (mode === 'edit') return viewEdit(set);
    const fn = { flashcards: viewFlashcards, learn: viewLearn, test: viewTest, match: viewMatch }[mode];
    if (fn) { set.studied = Date.now(); save(); return fn(set); }
  }
  viewLibrary();
}
window.addEventListener('hashchange', route);
const title = t => { document.title = t ? `${t} · LSAT Cards` : 'LSAT Cards'; };
/* Esc leaves a study mode for the set page. */
const escBack = set => e => { if (e.key === 'Escape' && !$('details.opts[open]')) location.hash = `#/set/${set.id}`; };

function studyHead(set, label, optsHtml = '') {
  return `<div class="study-head">
    <a class="btn ghost" href="#/set/${set.id}" title="Back to set (Esc)">← Back</a>
    <div class="title"><b>${label}</b><small>${esc(set.title)}</small></div>
    ${optsHtml ? `<details class="opts"><summary class="btn">Options</summary><div class="opts-body">${optsHtml}</div></details>` : '<span style="width:80px"></span>'}
  </div>`;
}
/* Close an open options popover when clicking elsewhere. */
document.addEventListener('click', e => {
  $$('details.opts[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
});
const toggleOpt = (key, label, on) => `<label class="toggle">${label}<input type="checkbox" data-opt="${key}" ${on ? 'checked' : ''}></label>`;
const selectOpt = (key, label, val, options) => `<div><div class="opt-label">${label}</div>
  <select class="input" data-opt="${key}">${options.map(([v, t]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
function bindOpts(root, prefs, onChange) {
  $$('[data-opt]', root).forEach(el => el.addEventListener('change', () => {
    prefs[el.dataset.opt] = el.type === 'checkbox' ? el.checked : el.value;
    save(); onChange(el.dataset.opt);
  }));
}

/* ================= library ================= */
function viewLibrary() {
  title('');
  const sets = [...db.sets].sort((a, b) => Math.max(b.studied, b.updated) - Math.max(a.studied, a.updated));
  app.innerHTML = `<div class="page">
    <div class="page-head"><div><p class="greet">${greeting()}</p><h1>Your study sets</h1><p class="muted">${plural(sets.length, 'set')} · ${plural(sets.reduce((n, s) => n + s.cards.length, 0), 'term')}</p></div>
      <a class="btn primary" href="#/new">+ New set</a></div>
    ${sets.length ? `<div class="grid">${sets.map(s => {
      const p = counts(s);
      return `<a class="set-tile" href="#/set/${s.id}"><h3>${esc(s.title)}</h3>
        <p class="muted small">${plural(s.cards.length, 'term')}</p>${bar(s)}
        <p class="small faint">${p.mastered} of ${p.total} mastered</p></a>`;
    }).join('')}</div>` : `<div class="empty"><h2>No sets yet</h2><p class="muted" style="margin:6px 0 16px">Make one, or bring back the starter LSAT decks below.</p><a class="btn primary" href="#/new">Create a set</a></div>`}
    <section class="tools">
      <h2>Backup &amp; devices</h2>
      <p class="muted small">Your sets are saved in this browser on this device. Download a backup now and then. You can also use it to move everything to another device: restore it there.</p>
      <div class="row">
        <button class="btn" id="exportAll">Download backup</button>
        <label class="btn">Restore from backup<input type="file" accept=".json,application/json" id="importAll" hidden></label>
        <button class="btn ghost" id="reseed">Re-add missing starter decks</button>
      </div>
    </section></div>`;
  $('#exportAll').onclick = () => {
    download(`lsat-cards-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db, null, 1), 'application/json');
  };
  $('#importAll').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = Array.isArray(data) ? data : data.sets;
      if (!Array.isArray(incoming)) throw new Error('no sets in that file');
      let added = 0, replaced = 0;
      incoming.forEach(s => {
        normalizeSet(s);
        const i = db.sets.findIndex(x => x.id === s.id);
        if (i >= 0) { db.sets[i] = s; replaced++; } else { db.sets.push(s); added++; }
      });
      save(); toast(`Restored: ${added} added, ${replaced} updated.`); viewLibrary();
    } catch (err) { toast('That file could not be read: ' + err.message); }
  };
  $('#reseed').onclick = () => {
    const have = new Set(db.sets.map(s => s.seed || s.title));
    const missing = (window.SEED_DECKS || []).filter(d => !have.has(d.title));
    missing.forEach(d => db.sets.push(newSet({ ...d, seed: d.title })));
    save(); toast(missing.length ? `Added ${plural(missing.length, 'deck')}.` : 'All starter decks are already here.');
    viewLibrary();
  };
}

/* ================= set overview ================= */
function viewSet(set) {
  title(set.title);
  let filter = 'all';
  const render = () => {
    const p = counts(set);
    const starredN = set.cards.filter(c => c.starred).length;
    const list = filter === 'starred' ? set.cards.filter(c => c.starred) : set.cards;
    const lvlTag = c => { const l = lvl(set, c);
      return l === undefined ? '' : l >= 2 ? '<div class="lvl ok">Mastered</div>' : `<div class="lvl" style="color:var(--warn)">${l === 1 ? 'Familiar' : 'Still learning'}</div>`; };
    app.innerHTML = `<div class="page">
      <a class="crumb" href="#/">← All sets</a>
      <div class="page-head"><div><h1>${esc(set.title)}</h1>${set.description ? `<p class="muted prewrap" style="margin-top:4px">${esc(set.description)}</p>` : ''}</div>
        <div class="row"><a class="btn" href="#/set/${set.id}/edit">Edit</a>
        <details class="opts"><summary class="btn" aria-label="More">⋯</summary><div class="opts-body">
          <button class="btn" id="exportTxt">Export as text</button>
          <button class="btn" id="resetProg">Reset progress</button>
          <button class="btn danger" id="delSet">Delete set</button></div></details></div></div>
      <div class="modes">
        <a class="mode" href="#/set/${set.id}/flashcards"><span class="ico">▤</span>Flashcards</a>
        <a class="mode" href="#/set/${set.id}/learn"><span class="ico">◎</span>Learn</a>
        <a class="mode" href="#/set/${set.id}/test"><span class="ico">✎</span>Test</a>
        <a class="mode" href="#/set/${set.id}/match"><span class="ico">⧉</span>Match</a>
      </div>
      <h2>Your progress</h2>
      <div class="stats">
        <span><span class="dot" style="background:var(--surface-2);border:1px solid var(--rule)"></span>Not studied <b>${p.fresh}</b></span>
        <span><span class="dot" style="background:var(--warn)"></span>Still learning <b>${p.learning}</b></span>
        <span><span class="dot" style="background:var(--good)"></span>Mastered <b>${p.mastered}</b></span>
      </div>
      <div style="margin:10px 0 30px">${bar(set)}</div>
      <div class="list-head"><h2 style="flex:1">Terms in this set (${set.cards.length})</h2>
        <div class="seg"><button data-f="all" aria-pressed="${filter === 'all'}">All</button><button data-f="starred" aria-pressed="${filter === 'starred'}">Starred (${starredN})</button></div></div>
      <div class="term-list">${list.length ? list.map(c => `
        <div class="term-row"><div class="t prewrap">${esc(c.term)}${lvlTag(c)}</div><div class="d prewrap">${esc(c.definition)}</div>
          <button class="icon-btn star ${c.starred ? 'on' : ''}" data-star="${c.id}" title="${c.starred ? 'Unstar' : 'Star'}" aria-pressed="${c.starred}">${c.starred ? '★' : '☆'}</button></div>`).join('')
        : `<p class="muted">${filter === 'starred' ? 'Star terms (☆) to study just those.' : 'No terms yet.'}</p>`}</div>
      <div style="margin-top:22px"><a class="btn" href="#/set/${set.id}/edit">Add or remove terms</a></div>
    </div>`;
    $$('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; render(); });
    $$('[data-star]').forEach(b => b.onclick = () => {
      const c = set.cards.find(x => x.id === b.dataset.star); c.starred = !c.starred; save(); render();
    });
    $('#exportTxt').onclick = () => download(`${set.title.replace(/[^\w -]+/g, '').trim() || 'set'}.txt`,
      set.cards.map(c => `${c.term.replace(/[\t\n]+/g, ' ')}\t${c.definition.replace(/[\t\n]+/g, ' ')}`).join('\n'));
    $('#resetProg').onclick = () => { if (confirm('Reset all progress for this set? Cards and stars are kept.')) { set.progress = {}; save(); render(); } };
    $('#delSet').onclick = () => {
      if (confirm(`Delete "${set.title}" and its ${plural(set.cards.length, 'term')}? This cannot be undone.`)) {
        db.sets = db.sets.filter(s => s !== set); save(); location.hash = '#/';
      }
    };
  };
  render();
}

/* ================= editor ================= */
function parseImport(text, colSep, rowSep) {
  const rows = rowSep === '\n' ? text.split(/\r?\n/) : text.split(rowSep);
  return rows.map(r => {
    if (!r.trim()) return null;
    const i = r.indexOf(colSep);
    if (i < 0) return { term: r.trim(), definition: '' };
    return { term: r.slice(0, i).trim(), definition: r.slice(i + colSep.length).trim() };
  }).filter(Boolean);
}
function viewEdit(set) {
  const isNew = !set;
  title(isNew ? 'New set' : `Edit ${set.title}`);
  const draft = isNew ? { title: '', description: '', cards: [{}, {}, {}] }
    : { title: set.title, description: set.description, cards: set.cards.map(c => ({ ...c })) };
  const rowHtml = (c, i) => `<div class="erow" data-id="${esc(c.id || '')}">
    <div class="erow-head"><span class="num">${i + 1}</span><button class="icon-btn del" type="button" title="Delete card" aria-label="Delete card">✕</button></div>
    <div class="erow-fields">
      <label><textarea class="t" rows="1" placeholder="Enter term">${esc(c.term)}</textarea><span>TERM</span></label>
      <label><textarea class="d" rows="1" placeholder="Enter definition">${esc(c.definition)}</textarea><span>DEFINITION</span></label>
    </div></div>`;
  app.innerHTML = `<div class="page">
    <a class="crumb" href="${isNew ? '#/' : `#/set/${set.id}`}">← ${isNew ? 'All sets' : 'Back to set'}</a>
    <div class="page-head"><div><h1>${isNew ? 'Create a new study set' : 'Edit set'}</h1></div>
      <button class="btn" id="toggleImport" type="button">⇪ Import</button>
      <button class="btn" id="swap" type="button" title="Swap terms and definitions">⇄ Swap</button></div>
    <label class="field"><span>Title</span><input class="input" id="title" placeholder='e.g. "LR flaw types"' value="${esc(draft.title)}"></label>
    <label class="field"><span>Description</span><textarea class="input" id="desc" rows="2" placeholder="Optional">${esc(draft.description)}</textarea></label>
    <div class="panel" id="importPanel" hidden>
      <h2>Import</h2>
      <p class="muted small">Paste from Word, Google Docs, Excel, Quizlet's export, etc. One card per row.</p>
      <textarea class="input" id="importText" rows="7" style="margin-top:10px" placeholder="Word 1&#9;Definition 1&#10;Word 2&#9;Definition 2"></textarea>
      <div class="radios"><b class="small">Between term and definition</b>
        <label><input type="radio" name="col" value="\t" checked> Tab</label>
        <label><input type="radio" name="col" value=","> Comma</label>
        <label><input type="radio" name="col" value=" - "> Dash</label>
        <label><input type="radio" name="col" value="custom"> <input class="input" id="colCustom" placeholder="Custom"></label></div>
      <div class="radios"><b class="small">Between rows</b>
        <label><input type="radio" name="row" value="\n" checked> New line</label>
        <label><input type="radio" name="row" value=";"> Semicolon</label>
        <label><input type="radio" name="row" value="custom"> <input class="input" id="rowCustom" placeholder="Custom"></label></div>
      <div class="row" style="margin-top:8px"><span class="muted small" id="importPreview">Nothing to import yet.</span><span class="spacer"></span>
        <button class="btn" id="cancelImport" type="button">Cancel</button><button class="btn primary" id="doImport" type="button">Import</button></div>
    </div>
    <div id="rows">${draft.cards.map(rowHtml).join('')}</div>
    <button class="add-row" id="addRow" type="button">+ ADD CARD</button>
    <div class="sticky-save"><a class="btn ghost" href="${isNew ? '#/' : `#/set/${set.id}`}">Cancel</a><button class="btn primary big" id="save">${isNew ? 'Create' : 'Save'}</button></div>
  </div>`;
  const rows = $('#rows');
  const grow = t => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
  const renumber = () => $$('.erow .num', rows).forEach((n, i) => n.textContent = i + 1);
  const growAll = () => $$('textarea', rows).forEach(grow);
  requestAnimationFrame(growAll);
  rows.addEventListener('input', e => { if (e.target.tagName === 'TEXTAREA') grow(e.target); });
  rows.addEventListener('click', e => {
    const d = e.target.closest('.del'); if (!d) return;
    const r = d.closest('.erow');
    if ($$('.erow', rows).length <= 1) { $$('textarea', r).forEach(t => { t.value = ''; grow(t); }); return; }
    r.remove(); renumber();
  });
  const addRow = (c = {}, focus = true) => {
    rows.insertAdjacentHTML('beforeend', rowHtml(c, $$('.erow', rows).length));
    const r = rows.lastElementChild; $$('textarea', r).forEach(grow);
    if (focus) $('.t', r).focus();
    return r;
  };
  $('#addRow').onclick = () => addRow();
  // Tab out of the last definition adds a card, as on Quizlet.
  rows.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.shiftKey && e.target.classList.contains('d') && e.target.closest('.erow') === rows.lastElementChild) {
      e.preventDefault(); addRow();
    }
  });
  $('#swap').onclick = () => $$('.erow', rows).forEach(r => {
    const t = $('.t', r), d = $('.d', r); [t.value, d.value] = [d.value, t.value]; grow(t); grow(d);
  });
  // import
  const panel = $('#importPanel');
  $('#toggleImport').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) $('#importText').focus(); };
  $('#cancelImport').onclick = () => { panel.hidden = true; };
  const seps = () => {
    let col = $('input[name=col]:checked').value, row = $('input[name=row]:checked').value;
    if (col === 'custom') col = $('#colCustom').value || '\t';
    if (row === 'custom') row = $('#rowCustom').value || '\n';
    return [col, row];
  };
  const parsed = () => parseImport($('#importText').value, ...seps());
  const preview = () => {
    const p = parsed(), missing = p.filter(c => !c.definition).length;
    $('#importPreview').textContent = p.length ? `${plural(p.length, 'card')} found${missing ? ` · ${missing} without a definition (check the separator)` : ''}.` : 'Nothing to import yet.';
  };
  panel.addEventListener('input', preview); panel.addEventListener('change', preview);
  $('#colCustom').onfocus = () => { $('input[name=col][value=custom]').checked = true; };
  $('#rowCustom').onfocus = () => { $('input[name=row][value=custom]').checked = true; };
  $('#doImport').onclick = () => {
    const p = parsed(); if (!p.length) return toast('Paste some cards first.');
    $$('.erow', rows).forEach(r => { if (!$('.t', r).value.trim() && !$('.d', r).value.trim()) r.remove(); });
    p.forEach(c => addRow(c, false)); renumber();
    $('#importText').value = ''; preview(); panel.hidden = true;
    toast(`Imported ${plural(p.length, 'card')}. Remember to save.`);
  };
  $('#save').onclick = () => {
    const cards = $$('.erow', rows).map(r => ({ id: r.dataset.id, term: $('.t', r).value.trim(), definition: $('.d', r).value.trim() }))
      .filter(c => c.term || c.definition);
    if (!cards.length) return toast('Add at least one card.');
    const t = $('#title').value.trim() || 'Untitled set', d = $('#desc').value.trim();
    let target = set;
    if (isNew) { target = newSet({ title: t, description: d }); db.sets.push(target); }
    const old = new Map(target.cards.map(c => [c.id, c]));
    target.cards = cards.map(c => {
      const prev = c.id && old.get(c.id);
      return { id: prev ? prev.id : uid(), term: c.term, definition: c.definition, starred: prev ? prev.starred : false };
    });
    const keep = new Set(target.cards.map(c => c.id));
    Object.keys(target.progress).forEach(k => { if (!keep.has(k)) delete target.progress[k]; });
    target.title = t; target.description = d; target.updated = Date.now();
    save(); toast('Saved.'); location.hash = `#/set/${target.id}`;
  };
  if (isNew) $('#title').focus();
}

/* ================= flashcards ================= */
function viewFlashcards(set) {
  title('Flashcards');
  const P = db.prefs.fc;
  let deck, i, flipped, known, learning, history, done, note, swiped = false, celebrated = false;
  const start = cards => {
    deck = P.shuffle ? shuffle(cards) : [...cards];
    i = 0; flipped = false; known = []; learning = []; history = []; done = !deck.length; celebrated = false; render();
  };
  const fresh = () => { const p = pick(set, P.starred); note = p.note; start(p.cards); };
  const opts = () => toggleOpt('track', 'Track progress', P.track) + toggleOpt('shuffle', 'Shuffle', P.shuffle)
    + toggleOpt('starred', 'Study starred terms only', P.starred)
    + selectOpt('front', 'Front of card', P.front, [['term', 'Term'], ['definition', 'Definition']]);
  function render() {
    const total = deck.length;
    let body;
    if (!total) body = `<div class="done-card"><h2>No cards</h2><p class="muted">Add some terms to this set first.</p><div class="actions"><a class="btn primary" href="#/set/${set.id}/edit">Edit set</a></div></div>`;
    else if (done) body = P.track ? `<div class="done-card">
        <h2>${learning.length ? 'Nice work! Keep going.' : 'You know all of these! 🎉'}</h2>
        <div class="done-stats"><div class="ok"><b>${known.length}</b>Know</div><div style="color:var(--warn)"><b>${learning.length}</b>Still learning</div></div>
        <div class="actions">
          ${learning.length ? `<button class="btn primary big" id="again">Keep reviewing ${plural(learning.length, 'term')}</button>` : ''}
          <button class="btn ${learning.length ? '' : 'primary big'}" id="restart">Restart flashcards</button>
          <a class="btn" href="#/set/${set.id}/learn">Practice with Learn</a>
          <button class="btn ghost" id="undo">← Back to last card</button></div></div>`
      : `<div class="done-card"><h2>You reviewed all ${plural(total, 'card')}</h2><div class="actions">
          <button class="btn primary big" id="restart">Restart flashcards</button>
          <a class="btn" href="#/set/${set.id}/learn">Practice with Learn</a></div></div>`;
    else {
      const c = deck[i];
      const front = P.front === 'definition' ? c.definition : c.term, back = P.front === 'definition' ? c.term : c.definition;
      const fl = P.front === 'definition' ? ['Definition', 'Term'] : ['Term', 'Definition'];
      const star = `<button class="icon-btn star ${c.starred ? 'on' : ''}" data-star title="Star (S)">${c.starred ? '★' : '☆'}</button>`;
      body = `<div class="counter">${i + 1} / ${total}</div>
        <div class="progress-line"><span style="width:${i / total * 100}%"></span></div>
        <div class="flip ${flipped ? 'flipped' : ''}" id="card" role="button" tabindex="0" aria-label="Flashcard, click to flip">
          <div class="flip-inner">
            <div class="face front"><span class="side-tag">${fl[0]}</span>${star}<div class="content ${fsClass(front)}">${esc(front) || '<span class="faint">(blank)</span>'}</div></div>
            <div class="face back"><span class="side-tag">${fl[1]}</span>${star}<div class="content ${fsClass(back)}">${esc(back) || '<span class="faint">(blank)</span>'}</div></div>
          </div></div>
        <div class="fc-controls">${P.track ? `
          <button class="round-btn" id="undo" title="Undo (Ctrl+Z)" ${history.length ? '' : 'disabled'}>↶</button>
          <button class="track-btn learning" id="learning">✕ Still learning<span class="cnt">${learning.length}</span></button>
          <button class="track-btn know" id="know">✓ Know<span class="cnt">${known.length}</span></button>
          <span style="width:56px"></span>` : `
          <button class="round-btn" id="prev" title="Previous (←)" ${i ? '' : 'disabled'}>←</button>
          <button class="btn" id="flipBtn">Flip</button>
          <button class="round-btn" id="next" title="Next (→)">→</button>`}</div>
        <p class="kbd-hint"><kbd>Space</kbd> flip · ${P.track ? '<kbd>←</kbd> still learning · <kbd>→</kbd> know' : '<kbd>←</kbd><kbd>→</kbd> navigate'} · <kbd>S</kbd> star${P.track ? ' · swipe on phones' : ''}</p>`;
    }
    app.innerHTML = `<div class="page">${studyHead(set, 'Flashcards', opts())}${note ? `<div class="note">${note}</div>` : ''}${body}</div>`;
    if (done && P.track && total && !learning.length && !celebrated) { celebrated = true; celebrate(); }
    bindOpts(app, P, k => { if (k === 'front') { flipped = false; render(); } else fresh(); });
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('again', () => start(learning.slice()));
    on('restart', fresh);
    on('undo', undo); on('know', () => mark(true)); on('learning', () => mark(false));
    on('prev', () => go(-1)); on('next', () => go(1)); on('flipBtn', flip);
    $$('[data-star]').forEach(b => b.onclick = e => { e.stopPropagation(); star(); });
    const card = $('#card');
    if (card) {
      card.onclick = () => { if (swiped) { swiped = false; return; } flip(); };
      let x0 = null, y0 = 0;
      card.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      card.addEventListener('touchmove', e => {
        if (x0 === null) return;
        const dx = e.touches[0].clientX - x0;
        card.classList.toggle('swipe-right', dx > 60); card.classList.toggle('swipe-left', dx < -60);
        card.style.transform = `translateX(${dx * .4}px) rotate(${dx * .02}deg)`;
      }, { passive: true });
      card.addEventListener('touchend', e => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
        card.style.transform = ''; card.classList.remove('swipe-right', 'swipe-left');
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
          swiped = true; setTimeout(() => { swiped = false; }, 400);
          if (P.track) mark(dx > 0); else go(dx > 0 ? -1 : 1);
        }
      });
    }
  }
  function flip() { flipped = !flipped; const c = $('#card'); if (c) c.classList.toggle('flipped', flipped); }
  function star() { const c = deck[i]; if (!c) return; c.starred = !c.starred; save(); render(); }
  function go(d) { if (done) return; const n = i + d; if (n < 0) return; flipped = false; if (n >= deck.length) { done = true; } else i = n; render(); }
  function mark(knew) {
    if (done) return;
    const c = deck[i];
    history.push({ i, knew, prev: set.progress[c.id] });
    (knew ? known : learning).push(c);
    // Flashcards feed progress: "know" lifts a card to at least familiar; "still learning" marks it as learning.
    set.progress[c.id] = knew ? Math.max(1, set.progress[c.id] ?? 0) : 0;
    save();
    flipped = false; i++; if (i >= deck.length) done = true; render();
  }
  function undo() {
    const h = history.pop(); if (!h) return;
    (h.knew ? known : learning).pop();
    const c = deck[h.i];
    if (h.prev === undefined) delete set.progress[c.id]; else set.progress[c.id] = h.prev;
    save(); i = h.i; done = false; flipped = false; render();
  }
  keyHandler = e => {
    if (typing(e) || e.altKey || e.metaKey && e.key !== 'z') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { if (P.track) { e.preventDefault(); undo(); } return; }
    if (e.ctrlKey) return;
    if (e.key === 'Escape') return escBack(set)(e);
    if (done) return;
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); flip(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); P.track ? mark(true) : go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); P.track ? mark(false) : go(-1); }
    else if (e.key === 's' || e.key === 'S') star();
  };
  fresh();
}

/* ================= distractors ================= */
function distractors(card, all, answerWith, k) {
  const right = norm(sides(card, answerWith).answer);
  const seen = new Set([right]), out = [];
  for (const c of shuffle(all)) {
    const a = sides(c, answerWith).answer, n = norm(a);
    if (c === card || seen.has(n) || !n) continue;
    seen.add(n); out.push(a);
    if (out.length >= k) break;
  }
  return out;
}

/* ================= learn ================= */
function viewLearn(set) {
  title('Learn');
  const P = db.prefs.learn;
  const ROUND = 7;
  let round = 0, queue = [], results = [], requeued = new Set(), cur = null, state = 'q', qtype = 'mc', options = [], chosen = null, typed = '', note = '', autoTimer = null, qLevel;
  const pool = () => { const p = pick(set, P.starred); note = p.note; return p.cards; };
  const level = c => set.progress[c.id];
  const opts = () => selectOpt('answerWith', 'Answer with', P.answerWith, [['term', 'Term (shown the definition)'], ['definition', 'Definition (shown the term)']])
    + toggleOpt('written', 'Written questions', P.written) + toggleOpt('starred', 'Study starred terms only', P.starred)
    + `<button class="btn danger" id="resetLearn">Reset progress</button>`;
  function startRound() {
    const cards = pool();
    const rest = cards.filter(c => (level(c) ?? -1) < 2);
    if (!rest.length) return renderDone(cards);
    const learning = shuffle(rest.filter(c => level(c) !== undefined));
    const fresh = shuffle(rest.filter(c => level(c) === undefined));
    // Mix: up to 4 cards already in progress, topped up with new ones.
    let picked = learning.slice(0, 4);
    picked = picked.concat(fresh.slice(0, ROUND - picked.length));
    picked = picked.concat(learning.slice(4, 4 + ROUND - picked.length));
    queue = shuffle(picked); results = []; requeued = new Set(); round++;
    next();
  }
  function next() {
    clearTimeout(autoTimer);
    if (!queue.length) return renderCheckpoint();
    cur = queue.shift(); state = 'q'; chosen = null; typed = ''; qLevel = level(cur);
    const all = set.cards;
    const canMC = distractors(cur, all, P.answerWith, 1).length > 0;
    const l = level(cur) ?? 0;
    qtype = !canMC ? 'written' : (l >= 1 && P.written) ? 'written' : 'mc';
    if (qtype === 'mc') {
      const ans = sides(cur, P.answerWith).answer;
      options = shuffle([ans, ...distractors(cur, all, P.answerWith, 3)]);
    }
    renderQ();
  }
  function grade(correct) {
    const l = level(cur) ?? 0;
    if (correct) {
      set.progress[cur.id] = qtype === 'written' ? 2 : Math.min(2, l + 1);
    } else {
      set.progress[cur.id] = 0;
      if (!requeued.has(cur.id)) { requeued.add(cur.id); queue.push(cur); }
    }
    const prev = results.find(r => r.card === cur);
    if (prev) prev.correct = prev.correct && correct; else results.push({ card: cur, correct });
    save();
  }
  function progressHtml() {
    const cards = pool(), t = cards.length || 1;
    const m = cards.filter(c => level(c) >= 2).length, l = cards.filter(c => level(c) !== undefined && level(c) < 2).length;
    return `<div class="learn-progress"><span class="ok">${m}</span>
      <div class="bar"><span class="m" style="width:${m / t * 100}%"></span><span class="l" style="width:${l / t * 100}%"></span></div>
      <span>${cards.length}</span></div>`;
  }
  function shell(inner) {
    app.innerHTML = `<div class="page" style="max-width:760px">${studyHead(set, `Learn${round ? ` · Round ${round}` : ''}`, opts())}${note ? `<div class="note">${note}</div>` : ''}${progressHtml()}${inner}</div>`;
    bindOpts(app, P, () => { queue = []; round = 0; startRound(); });
    $('#resetLearn').onclick = () => {
      if (!confirm('Reset Learn progress for this set?')) return;
      set.progress = {}; save(); round = 0; startRound();
    };
  }
  function renderQ() {
    const s = sides(cur, P.answerWith);
    const l = qLevel;
    const tag = l === undefined ? 'New term' : l === 0 ? 'Still learning' : 'Familiar';
    const star = `<button class="icon-btn star ${cur.starred ? 'on' : ''}" id="qstar" title="Star">${cur.starred ? '★' : '☆'}</button>`;
    let body;
    if (qtype === 'mc') {
      body = `<div class="sub">${state === 'q' ? `Choose the matching ${s.answerLabel}` : chosen === options.indexOf(s.answer) ? '<span class="ok">Correct! 🎉</span>' : '<span class="no">Not quite. You\'re still learning this one.</span>'}</div>
        <div class="choices">${options.map((o, k) => {
          let cls = '';
          if (state !== 'q') { if (o === s.answer) cls = 'right'; else if (k === chosen) cls = 'wrong'; }
          return `<button class="choice ${cls}" data-k="${k}" ${state !== 'q' ? 'disabled' : ''}><span class="k">${k + 1}</span><span>${esc(o)}</span></button>`;
        }).join('')}</div>`;
    } else if (state === 'q') {
      body = `<div class="sub">Type the ${s.answerLabel}</div>
        <form class="written-row" id="wform" autocomplete="off"><input class="input" id="wans" placeholder="Type the answer" autocapitalize="off" spellcheck="false"><button class="btn primary">Answer</button></form>
        <div style="margin-top:10px"><button class="linkish" id="dunno" type="button">Don't know?</button></div>`;
    } else if (state === 'right') {
      body = `<div class="feedback good">Correct! ${norm(typed) !== norm(s.answer) ? `<div class="muted" style="font-weight:400;margin-top:6px">Full answer: <span class="prewrap">${esc(s.answer)}</span></div>` : ''}</div>`;
    } else {
      body = `<div class="feedback bad">
        ${typed ? `<div class="lbl w">Your answer</div><div class="ans">${esc(typed)}</div>` : `<div class="lbl w">Skipped</div><div class="ans faint">Let's try this one again later.</div>`}
        <div class="lbl r">Correct answer</div><div class="ans">${esc(s.answer)}</div></div>`;
    }
    const cont = state === 'q' ? '' : `<div class="continue-bar"><span class="hint">Press <kbd>Enter</kbd> to continue</span>
      ${state === 'wrong' && qtype === 'written' && typed ? '<button class="btn" id="override">Override: I was right</button>' : ''}
      <button class="btn primary" id="cont">Continue</button></div>`;
    shell(`<div class="qcard"><div class="q-tag">${s.promptLabel} <span class="faint">· ${tag}</span>${star}</div>
      <div class="prompt ${fsClass(s.prompt)}" style="text-align:left">${esc(s.prompt)}</div>${body}${cont}</div>`);
    $('#qstar').onclick = () => { cur.starred = !cur.starred; save(); const b = $('#qstar'); b.classList.toggle('on', cur.starred); b.textContent = cur.starred ? '★' : '☆'; };
    $$('.choice[data-k]').forEach(b => b.onclick = () => answerMC(+b.dataset.k));
    const f = $('#wform');
    if (f) { const inp = $('#wans'); inp.focus(); f.onsubmit = e => { e.preventDefault(); answerWritten(inp.value); }; $('#dunno').onclick = () => answerWritten(''); }
    if ($('#cont')) { $('#cont').onclick = next; $('#cont').focus({ preventScroll: true }); }
    if ($('#override')) $('#override').onclick = () => {
      // Undo the miss: take the card out of the re-ask queue and credit it.
      const k = queue.lastIndexOf(cur); if (k >= 0 && requeued.has(cur.id)) { queue.splice(k, 1); requeued.delete(cur.id); }
      const r = results.find(x => x.card === cur); if (r) r.correct = true;
      set.progress[cur.id] = 2; save(); next();
    };
  }
  function answerMC(k) {
    if (state !== 'q') return;
    chosen = k;
    const ok = options[k] === sides(cur, P.answerWith).answer;
    grade(ok); state = ok ? 'right' : 'wrong'; renderQ();
    if (ok) autoTimer = setTimeout(next, 900);
  }
  function answerWritten(v) {
    if (state !== 'q') return;
    typed = v.trim();
    const ok = isCorrect(typed, sides(cur, P.answerWith).answer);
    grade(ok); state = ok ? 'right' : 'wrong'; renderQ();
    if (ok) autoTimer = setTimeout(next, 1400);
  }
  function renderCheckpoint() {
    state = 'checkpoint';
    const cards = pool();
    const left = cards.filter(c => (level(c) ?? -1) < 2).length;
    if (!left) return renderDone(cards);
    const correct = results.filter(r => r.correct).length;
    shell(`<div class="done-card"><h2>Round ${round} done</h2>
      <p class="muted">${correct} of ${results.length} right the first time · ${plural(left, 'term')} left to master</p>
      <div class="round-list">${results.map(r => `<div class="ri"><span class="mk ${r.correct ? 'ok' : 'no'}">${r.correct ? '✓' : '✕'}</span>
        <span><b>${esc(r.card.term)}</b></span></div>`).join('')}</div>
      <div class="actions"><button class="btn primary big" id="cont">Continue to round ${round + 1}</button></div>
      <p class="kbd-hint">Press <kbd>Enter</kbd> to continue</p></div>`);
    $('#cont').onclick = startRound; $('#cont').focus({ preventScroll: true });
  }
  function renderDone(cards) {
    state = 'done';
    shell(`<div class="done-card"><h2>You've mastered all ${plural(cards.length, 'term')}! 🎉</h2>
      <p class="muted">Test yourself to lock it in, or start Learn again from scratch.</p>
      <div class="actions"><a class="btn primary big" href="#/set/${set.id}/test">Take a practice test</a>
        <button class="btn" id="restartLearn">Restart Learn</button><a class="btn ghost" href="#/set/${set.id}">Back to set</a></div></div>`);
    celebrate(40);
    $('#restartLearn').onclick = () => { cards.forEach(c => delete set.progress[c.id]); save(); round = 0; startRound(); };
  }
  keyHandler = e => {
    if (e.key === 'Escape') return escBack(set)(e);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state === 'q' && qtype === 'mc' && /^[1-4]$/.test(e.key) && !typing(e)) { const k = +e.key - 1; if (k < options.length) answerMC(k); return; }
    if ((state === 'right' || state === 'wrong' || state === 'checkpoint') && e.key === 'Enter') {
      e.preventDefault(); state === 'checkpoint' ? startRound() : next();
    }
  };
  teardown = () => clearTimeout(autoTimer);
  startRound();
}

/* ================= test ================= */
function viewTest(set) {
  title('Test');
  const P = db.prefs.test;
  let qs = [], submitted = false, note = '', started = 0, elapsed = 0;
  function setup() {
    submitted = false;
    const p = pick(set, P.starred); note = p.note;
    const max = p.cards.length;
    const last = set.tests.slice(-5).reverse();
    app.innerHTML = `<div class="page" style="max-width:640px">${studyHead(set, 'Test')}
      <div class="panel"><h2>Set up your test</h2>
        <div style="display:grid;gap:16px;margin-top:14px">
          <label class="toggle">Questions (max ${max})<input class="input" type="number" id="tcount" min="1" max="${max}" value="${Math.min(P.count, max) || 1}" style="width:90px"></label>
          <label class="toggle">Answer with<select class="input" id="tans" style="width:auto">
            <option value="term" ${P.answerWith === 'term' ? 'selected' : ''}>Term</option><option value="definition" ${P.answerWith === 'definition' ? 'selected' : ''}>Definition</option></select></label>
          <label class="toggle">Starred terms only<input type="checkbox" id="tstar" ${P.starred ? 'checked' : ''}></label>
          <div><div class="opt-label">Question types</div><div class="check-grid">
            ${[['tf', 'True / False'], ['mc', 'Multiple choice'], ['match', 'Matching'], ['written', 'Written']].map(([k, l]) =>
              `<label class="toggle" style="justify-content:flex-start"><input type="checkbox" data-type="${k}" ${P.types[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
        </div>
        <div class="row" style="margin-top:20px"><span class="spacer"></span><button class="btn primary big" id="go" ${max ? '' : 'disabled'}>Create test</button></div>
      </div>
      ${last.length ? `<div class="history"><b>Recent scores:</b> ${last.map(t => `${t.score}% <span class="faint">(${new Date(t.at).toLocaleDateString()})</span>`).join(' · ')}</div>` : ''}
    </div>`;
    $('#tstar').onchange = e => { P.starred = e.target.checked; save(); setup(); };
    $('#go').onclick = () => {
      P.count = Math.max(1, Math.min(max, parseInt($('#tcount').value, 10) || 1));
      P.answerWith = $('#tans').value;
      $$('[data-type]').forEach(b => { P.types[b.dataset.type] = b.checked; });
      if (!Object.values(P.types).some(Boolean)) P.types.mc = true;
      save(); build(p.cards); render();
    };
  }
  function build(cards) {
    const all = set.cards;
    const chosen = shuffle(cards).slice(0, P.count);
    let types = ['tf', 'mc', 'match', 'written'].filter(t => P.types[t]);
    const multi = new Set(all.map(c => norm(sides(c, P.answerWith).answer))).size >= 2;
    if (!multi) types = ['written'];
    const buckets = Object.fromEntries(types.map(t => [t, []]));
    chosen.forEach((c, k) => buckets[types[k % types.length]].push(c));
    // A single matching item is not a matching question; fold it into another type.
    if (buckets.match && buckets.match.length === 1) {
      const to = types.find(t => t !== 'match') || 'mc';
      (buckets[to] ||= []).push(...buckets.match.splice(0));
    }
    qs = [];
    (buckets.tf || []).forEach(c => {
      const truth = Math.random() < .5;
      const wrong = distractors(c, all, P.answerWith, 1)[0];
      qs.push({ type: 'tf', card: c, truth: truth || !wrong, shown: truth || !wrong ? sides(c, P.answerWith).answer : wrong, resp: null });
    });
    (buckets.mc || []).forEach(c => {
      const ans = sides(c, P.answerWith).answer;
      const options = shuffle([ans, ...distractors(c, all, P.answerWith, 3)]);
      qs.push({ type: 'mc', card: c, options, correct: options.indexOf(ans), resp: null });
    });
    const m = buckets.match || [];
    for (let k = 0; k < m.length; k += 5) {
      let group = m.slice(k, k + 5);
      if (group.length === 1) { qs[qs.length - 1].items.push(group[0]); continue; }
      qs.push({ type: 'match', items: group, resp: {} });
    }
    qs.filter(q => q.type === 'match').forEach(q => { q.options = shuffle(q.items.map(c => ({ id: c.id, text: sides(c, P.answerWith).answer }))); });
    (buckets.written || []).forEach(c => qs.push({ type: 'written', card: c, resp: '', override: false }));
    started = Date.now();
  }
  const L = 'ABCDEFGH';
  function itemCorrect(q, c) {
    if (q.type === 'tf') return q.resp === q.truth;
    if (q.type === 'mc') return q.resp === q.correct;
    if (q.type === 'written') return q.override || isCorrect(q.resp, sides(q.card, P.answerWith).answer);
    if (q.type === 'match') return q.resp[c.id] !== undefined && q.options[q.resp[c.id]].id === c.id;
  }
  function score() {
    let right = 0, total = 0;
    qs.forEach(q => { if (q.type === 'match') q.items.forEach(c => { total++; if (itemCorrect(q, c)) right++; }); else { total++; if (itemCorrect(q)) right++; } });
    return { right, total, pct: total ? Math.round(right / total * 100) : 0 };
  }
  function collect() {
    qs.forEach((q, n) => {
      if (q.type === 'tf') { const v = $(`input[name=q${n}]:checked`); q.resp = v ? v.value === 'true' : null; }
      if (q.type === 'mc') { const v = $(`input[name=q${n}]:checked`); q.resp = v ? +v.value : null; }
      if (q.type === 'written') q.resp = $(`#q${n}`).value.trim();
      if (q.type === 'match') q.items.forEach(c => { const v = $(`select[data-q="${n}"][data-c="${c.id}"]`).value; if (v !== '') q.resp[c.id] = +v; else delete q.resp[c.id]; });
    });
  }
  function unanswered() {
    return qs.reduce((n, q) => n + (q.type === 'match' ? q.items.filter(c => q.resp[c.id] === undefined).length : (q.resp === null || q.resp === '') ? 1 : 0), 0);
  }
  function render() {
    const s = submitted ? score() : null;
    const labels = { tf: ['True or false', ''], mc: ['Multiple choice', ''], match: ['Matching', 'Pick the letter that matches each one'], written: ['Written', `Type the ${P.answerWith}`] };
    let lastType = null, num = 0;
    const totalItems = qs.reduce((n, q) => n + (q.type === 'match' ? q.items.length : 1), 0);
    const html = qs.map((q, n) => {
      let head = '';
      if (q.type !== lastType) { lastType = q.type; head = `<h2 class="section-h">${labels[q.type][0]}${labels[q.type][1] ? ` <small>${labels[q.type][1]}</small>` : ''}</h2>`; }
      const dis = submitted ? 'disabled' : '';
      if (q.type === 'match') {
        const first = num + 1; num += q.items.length;
        const ok = submitted && q.items.every(c => itemCorrect(q, c));
        return head + `<div class="test-q ${submitted ? ok ? 'correct' : 'incorrect' : ''}"><div class="qn">${first}–${num} of ${totalItems}</div>
          <div class="match-items">${q.items.map(c => {
            const r = q.resp[c.id], good = submitted && itemCorrect(q, c);
            const right = q.options.findIndex(o => o.id === c.id);
            return `<div class="match-item ${submitted ? good ? 'ok' : 'no' : ''}"><select class="input" data-q="${n}" data-c="${c.id}" ${dis} aria-label="Answer">
              <option value="">–</option>${q.options.map((o, k) => `<option value="${k}" ${r === k ? 'selected' : ''}>${L[k]}</option>`).join('')}</select>
              <div class="prewrap">${esc(sides(c, P.answerWith).prompt)}${submitted && !good ? `<div class="correction no small">Answer: <b>${L[right]}</b></div>` : ''}</div></div>`;
          }).join('')}</div>
          <div class="match-opts">${q.options.map((o, k) => `<div><b>${L[k]}</b><span>${esc(o.text)}</span></div>`).join('')}</div></div>`;
      }
      num++;
      const c = q.card, sd = sides(c, P.answerWith), ok = submitted && itemCorrect(q);
      const cls = submitted ? ok ? 'correct' : 'incorrect' : '';
      const qn = `<div class="qn"><span>${num} of ${totalItems}</span>${submitted ? `<span class="${ok ? 'ok' : 'no'}" style="margin-left:auto">${ok ? '✓ Correct' : '✕ Incorrect'}</span>` : ''}</div>`;
      if (q.type === 'tf') {
        return head + `<div class="test-q ${cls}">${qn}<div class="opt-label">${sd.promptLabel}</div><div class="prompt">${esc(sd.prompt)}</div>
          <div class="opt-label">Matches this ${sd.answerLabel}?</div><div class="tf-shown">${esc(q.shown)}</div>
          <div class="tf-row">${[true, false].map(v => `<label class="choice ${q.resp === v ? 'picked' : ''} ${submitted && v === q.truth ? 'right' : ''} ${submitted && q.resp === v && v !== q.truth ? 'wrong' : ''}">
            <input type="radio" name="q${n}" value="${v}" ${q.resp === v ? 'checked' : ''} ${dis} hidden>${v ? 'True' : 'False'}</label>`).join('')}</div>
          ${submitted && !q.truth ? `<div class="correction"><span class="lbl ok">Correct ${sd.answerLabel}</span><div class="prewrap">${esc(sd.answer)}</div></div>` : ''}</div>`;
      }
      if (q.type === 'mc') {
        return head + `<div class="test-q ${cls}">${qn}<div class="prompt">${esc(sd.prompt)}</div><div class="choices">${q.options.map((o, k) => `
          <label class="choice ${q.resp === k ? 'picked' : ''} ${submitted && k === q.correct ? 'right' : ''} ${submitted && q.resp === k && k !== q.correct ? 'wrong' : ''}">
            <input type="radio" name="q${n}" value="${k}" ${q.resp === k ? 'checked' : ''} ${dis} hidden><span class="k">${L[k]}</span><span>${esc(o)}</span></label>`).join('')}</div></div>`;
      }
      return head + `<div class="test-q ${cls}">${qn}<div class="prompt">${esc(sd.prompt)}</div>
        <input class="input" id="q${n}" value="${esc(q.resp)}" placeholder="Type the answer" autocomplete="off" autocapitalize="off" spellcheck="false" ${dis}>
        ${submitted && !ok ? `<div class="correction"><span class="lbl ok">Correct answer</span><div class="prewrap">${esc(sd.answer)}</div>
          ${q.resp ? `<button class="btn" style="margin-top:10px" data-override="${n}">Override: I was right</button>` : ''}</div>` : ''}
        ${submitted && q.override ? '<div class="correction faint small">Marked correct by you.</div>' : ''}</div>`;
    }).join('');
    const missed = submitted ? [...new Set(qs.flatMap(q => q.type === 'match' ? q.items.filter(c => !itemCorrect(q, c)) : itemCorrect(q) ? [] : [q.card]))] : [];
    app.innerHTML = `<div class="page" style="max-width:760px">${studyHead(set, 'Test')}${note ? `<div class="note">${note}</div>` : ''}
      ${submitted ? `<div class="panel score-card"><div class="ring" style="--p:${s.pct}"><span>${s.pct}%</span></div>
        <div style="flex:1;min-width:200px"><h2>${s.pct >= 90 ? 'Excellent! 🎉' : s.pct >= 70 ? 'Good work, keep it up' : 'Keep practicing, you\'ll get there'}</h2>
          <p class="muted"><span class="ok">${s.right} correct</span> · <span class="no">${s.total - s.right} incorrect</span> · ${Math.max(1, Math.round(elapsed / 60000))} min</p>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="newTest">New test</button>
          ${missed.length ? `<button class="btn" id="starMissed">Star the ${plural(missed.length, 'missed term')}</button>` : ''}</div></div></div>`
        : `<p class="muted">${plural(totalItems, 'question')}</p>`}
      ${html}
      ${submitted ? `<div class="row" style="margin-top:20px"><button class="btn primary big" id="newTest2">New test</button><a class="btn" href="#/set/${set.id}">Back to set</a></div>`
        : `<div class="done-card" style="margin-top:20px"><h2>All done?</h2><div class="actions"><button class="btn primary big" id="submit">Submit test</button></div></div>`}
    </div>`;
    if (!submitted) {
      // Picking a radio highlights its label straight away.
      app.onchange = e => {
        if (e.target.type !== 'radio') return;
        $$(`input[name="${e.target.name}"]`).forEach(r => r.closest('.choice').classList.toggle('picked', r.checked));
      };
      $('#submit').onclick = () => {
        collect();
        const u = unanswered();
        if (u && !confirm(`${plural(u, 'question')} unanswered. Submit anyway?`)) return;
        submitted = true; elapsed = Date.now() - started;
        set.tests.push({ at: Date.now(), score: score().pct }); set.tests = set.tests.slice(-30); save();
        render(); window.scrollTo(0, 0);
        if (score().pct >= 90) celebrate();
      };
    } else {
      $$('#newTest, #newTest2').forEach(b => b.onclick = setup);
      $$('[data-override]').forEach(b => b.onclick = () => {
        qs[+b.dataset.override].override = true;
        const t = set.tests[set.tests.length - 1]; if (t) t.score = score().pct; save();
        const y = window.scrollY; render(); window.scrollTo(0, y);
      });
      const sm = $('#starMissed');
      if (sm) sm.onclick = () => { missed.forEach(c => { c.starred = true; }); save(); toast(`Starred ${plural(missed.length, 'term')}. Use "starred only" to drill them.`); };
    }
  }
  keyHandler = e => { if (e.key === 'Escape') escBack(set)(e); };
  setup();
}

/* ================= match ================= */
function viewMatch(set) {
  title('Match');
  const P = db.prefs.match;
  const PAIRS = 6;
  let tiles = [], sel = null, t0 = 0, penalty = 0, timer = null, left = 0, busy = false, note = '';
  const now = () => (performance.now() - t0) / 1000 + penalty;
  function intro() {
    clearInterval(timer);
    const p = pick(set, P.starred); note = p.note;
    const enough = p.cards.length >= 2;
    app.innerHTML = `<div class="page">${studyHead(set, 'Match', toggleOpt('starred', 'Study starred terms only', P.starred))}${note ? `<div class="note">${note}</div>` : ''}
      <div class="done-card"><h2>Ready to play?</h2>
        <p class="muted">Match each term with its definition as fast as you can. Wrong matches add 1 second.</p>
        ${set.matchBest ? `<p style="margin-top:10px">Your best: <b>${set.matchBest.toFixed(1)}s</b></p>` : ''}
        <div class="actions">${enough ? '<button class="btn primary big" id="start">Start game</button>' : '<p class="muted">You need at least 2 terms to play.</p>'}</div></div></div>`;
    bindOpts(app, P, intro);
    if (enough) $('#start').onclick = () => play(p.cards);
  }
  function play(cards) {
    // Prefer distinct answers so two tiles never read the same.
    const chosen = [], seenT = new Set(), seenD = new Set();
    for (const c of shuffle(cards)) {
      const t = norm(c.term), d = norm(c.definition);
      if (seenT.has(t) || seenD.has(d)) continue;
      seenT.add(t); seenD.add(d); chosen.push(c);
      if (chosen.length >= PAIRS) break;
    }
    tiles = shuffle(chosen.flatMap(c => [{ id: c.id, kind: 'term', text: c.term }, { id: c.id, kind: 'def', text: c.definition }]));
    left = chosen.length; sel = null; penalty = 0; busy = false;
    app.innerHTML = `<div class="page">${studyHead(set, 'Match')}
      <div class="match-top"><span class="timer" id="timer">0.0</span><span class="penalty" id="pen"></span></div>
      <div class="match-grid" id="grid">${tiles.map((t, k) => `<button class="tile ${t.kind === 'term' ? 'term' : ''}" data-k="${k}"><span>${esc(t.text)}</span></button>`).join('')}</div></div>`;
    t0 = performance.now();
    timer = setInterval(() => { const el = $('#timer'); if (el) el.textContent = now().toFixed(1); }, 100);
    $('#grid').onclick = e => {
      const b = e.target.closest('.tile'); if (!b || busy) return;
      const k = +b.dataset.k, t = tiles[k];
      if (sel === null) { sel = k; b.classList.add('sel'); return; }
      if (sel === k) { sel = null; b.classList.remove('sel'); return; }
      const a = $(`.tile[data-k="${sel}"]`), s = tiles[sel];
      if (s.kind === t.kind) { a.classList.remove('sel'); sel = k; b.classList.add('sel'); return; }
      sel = null;
      if (s.id === t.id) {
        a.classList.remove('sel'); a.classList.add('good'); b.classList.add('good');
        setTimeout(() => { a.classList.add('gone'); b.classList.add('gone'); }, 180);
        if (--left === 0) finish();
      } else {
        busy = true; penalty += 1;
        a.classList.remove('sel'); a.classList.add('bad'); b.classList.add('bad');
        const pen = $('#pen'); pen.textContent = '+1s';
        setTimeout(() => { a.classList.remove('bad'); b.classList.remove('bad'); pen.textContent = ''; busy = false; }, 450);
      }
    };
  }
  function finish() {
    clearInterval(timer);
    const time = now();
    const record = !set.matchBest || time < set.matchBest;
    const prevBest = set.matchBest;
    if (record) { set.matchBest = time; save(); }
    setTimeout(() => {
      app.innerHTML = `<div class="page">${studyHead(set, 'Match')}<div class="done-card">
        <h2>${record ? 'New record! 🏆' : 'Nice matching!'}</h2>
        <div class="done-stats"><div><b>${time.toFixed(1)}s</b>Your time</div>${prevBest ? `<div class="faint"><b>${Math.min(prevBest, time).toFixed(1)}s</b>Best</div>` : ''}</div>
        ${penalty ? `<p class="muted" style="margin-top:8px">Includes ${penalty}s of penalties</p>` : ''}
        <div class="actions"><button class="btn primary big" id="again">Play again</button><a class="btn" href="#/set/${set.id}">Back to set</a></div></div></div>`;
      $('#again').onclick = intro; $('#again').focus({ preventScroll: true });
      if (record) celebrate(prevBest ? 30 : 16);
    }, 400);
  }
  keyHandler = e => { if (e.key === 'Escape') escBack(set)(e); };
  teardown = () => clearInterval(timer);
  intro();
}

/* ---------------- boot ---------------- */
load();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
route();
})();
