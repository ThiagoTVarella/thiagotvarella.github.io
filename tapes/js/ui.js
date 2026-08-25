// UI. Everything here is written for someone who does not read Greek, is not technical,
// and cares about her grandfather. No jargon reaches the screen: no chunks, no models,
// no tokens, no API. Errors are sentences, not status codes.

import * as demoData from './demo.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const money = n => '$' + (n || 0).toFixed(2);

const DEMO = new URLSearchParams(location.search).has('demo');

const state = {
  view: 'library',
  tapes: [],
  names: [],
  glossary: [],
  folder: null,
  key: localStorage.getItem('or_key') || '',
  quality: localStorage.getItem('tapes_quality') || 'cross',
  cap: localStorage.getItem('tapes_cap') || '50',
  reading: null,
  nameIdx: 0,
  pending: []
};

function toast(msg, ms = 2600) {
  $$('.toast').forEach(t => t.remove());
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------------------------------------------------------------- routing

function go(view) {
  state.view = view;
  $$('.view').forEach(v => v.hidden = true);
  $('#v-' + view).hidden = false;
  $$('#tabs .tab').forEach(b => b.setAttribute('aria-current', String(b.dataset.go === view)));
  window.scrollTo(0, 0);
  if (view === 'library') renderLibrary();
  if (view === 'names') renderName();
  if (view === 'add') renderPending();
  if (view === 'settings') renderSettings();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) { e.preventDefault(); go(b.dataset.go); }
});

// ---------------------------------------------------------------- library

const STATUS = {
  done:    t => `Ready to read`,
  working: t => `Reading… ${Math.round((t.progress || 0) * 100)}%`,
  queued:  t => `Waiting`,
  error:   t => `Needs attention`
};

function renderLibrary() {
  const list = $('#tapeList');
  list.innerHTML = '';
  const has = state.tapes.length > 0;
  $('#libEmpty').hidden = has;
  list.hidden = !has;

  const done = state.tapes.filter(t => t.status === 'done');
  const hours = state.tapes.reduce((n, t) => n + (t.minutes || 0), 0) / 60;
  $('#libLede').textContent = has
    ? `${done.length} of ${state.tapes.length} recordings ready · about ${hours.toFixed(1)} hours of tape so far`
    : '';

  const working = state.tapes.find(t => t.status === 'working');
  $('#libBanner').innerHTML = working
    ? `<div class="banner">Still reading <b>${working.label}</b>. You can read the finished
       entries below while it works. <button class="tab" id="toNight"
       style="padding:0 4px;color:var(--accent)">Show progress</button></div>` : '';
  if (working) $('#toNight').onclick = () => openNight(working);

  // Chronological where he told us the date, otherwise by the order they came in.
  const sorted = [...state.tapes].sort((a, b) => (a.date || 'zzz').localeCompare(b.date || 'zzz'));
  for (const t of sorted) {
    const card = el('button', 'tape');
    card.innerHTML = `
      <div class="title">${t.heading || t.label}</div>
      <div class="meta">${t.label} · side ${t.side} · ${t.minutes} min${
        t.date ? '' : ' · <span style="color:var(--accent-2)">date not found yet</span>'}</div>
      <div class="state">${STATUS[t.status](t)}</div>
      ${t.status === 'working'
        ? `<div class="bar"><i style="width:${(t.progress * 100).toFixed(0)}%"></i></div>` : ''}`;
    card.onclick = () => {
      if (t.status !== 'done') return toast(`"${t.label}" isn't ready yet.`);
      openRead(t);
    };
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------- reading

function openRead(tape) {
  state.reading = tape;
  go('read');
  const box = $('#entry');
  box.innerHTML = `
    <div class="entry-date">${tape.label}</div>
    <h2>${tape.heading || 'Undated entry'}</h2>`;

  for (const s of tape.segments) {
    const p = el('button', 'para');
    let html = s.en;
    const ROUGH = 0.7;
    if (s.unsure) {
      html = html.replace(s.unsure,
        `<span class="unsure" title="The tape was rough here — this part is a best guess.">${s.unsure}</span>`);
    } else if (s.confidence < ROUGH) {
      // No single span to blame, so mark the whole line rather than claim a mark she can't find.
      p.classList.add('rough');
      p.title = 'The tape was rough here — this line is less certain than the rest.';
    }
    p.innerHTML = `<svg class="play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>${html}`;
    p.onclick = () => playFrom(tape, s, p);
    box.appendChild(p);
  }

  const low = tape.segments.filter(s => s.unsure || s.confidence < 0.7).length;
  $('#entryFoot').innerHTML =
    `Click any line to hear him say it.` +
    (low ? ` &nbsp;·&nbsp; ${low} passage${low > 1 ? 's were' : ' was'} hard to make out —
       they're shaded, and you can help fix them under <b>Names</b>.` : '');
}

let playTimer = null;
function playFrom(tape, s, node) {
  $$('.para.playing').forEach(n => n.classList.remove('playing'));
  clearTimeout(playTimer);
  node.classList.add('playing');
  if (DEMO) {
    toast(`Playing from ${fmtTime(s.start)} — audio isn't loaded in the demo`);
    playTimer = setTimeout(() => node.classList.remove('playing'), 2200);
    return;
  }
  const a = $('#player');
  a.src = `./tapes/${tape.id}/chunks/${String(s.chunk || 0).padStart(3, '0')}.mp3`;
  a.currentTime = Math.max(0, s.start - (s.chunkStart || 0));
  a.play().catch(() => toast("Couldn't play that bit — the audio file may have moved."));
}
const fmtTime = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- names

function renderName() {
  const left = state.names.length - state.nameIdx;
  $('#nameBadge').hidden = left <= 0;
  $('#nameBadge').textContent = left;
  $('#namesEmpty').hidden = left > 0;
  const box = $('#nameCard');
  box.innerHTML = '';
  if (left <= 0) return;

  const n = state.names[state.nameIdx];
  const card = el('div', 'name-card');
  card.innerHTML = `
    <div class="muted" style="font-size:.8rem">${left} left</div>
    <div class="name-greek">${n.greek}</div>
    <div class="name-count">heard ${n.heard} times${n.kind === 'place' ? ' · sounds like a place' : ''}</div>
    <div class="clip">
      <button class="btn btn-ghost btn-sm" id="hear">▶ Hear him say it</button>
      <p class="ctx" style="margin-top:13px">${n.context[0]}<b>${n.guess}</b>${n.context[1]}</p>
    </div>
    ${n.hint ? `<p class="note-inline" style="margin-bottom:10px">${n.hint}</p>` : ''}
    <input type="text" id="nameIn" value="${n.guess}" autocomplete="off" spellcheck="false">
    <p class="note-inline">Write it however you'd spell it in English.</p>
    <div class="name-actions">
      <button class="btn btn-ghost" id="skip">Not sure</button>
      <button class="btn" id="save">That's it</button>
    </div>`;
  box.appendChild(card);

  const input = $('#nameIn');
  input.focus(); input.select();
  $('#hear').onclick = () => toast(DEMO ? 'Audio isn\'t loaded in the demo' : 'Playing…');
  $('#skip').onclick = () => { state.nameIdx++; renderName(); };
  $('#save').onclick = commit;
  input.onkeydown = e => { if (e.key === 'Enter') commit(); };

  function commit() {
    const v = input.value.trim();
    if (!v) return input.focus();
    state.glossary.push({ id: n.id, english: v, greek: n.greek, kind: n.kind, heard: n.heard });
    state.nameIdx++;
    toast(`Thanks — "${v}" is now fixed across every tape.`);
    renderName();
  }
}

// ---------------------------------------------------------------- add

function renderPending() {
  const box = $('#pending');
  box.innerHTML = '';
  $('#addActions').hidden = state.pending.length === 0;
  state.pending.forEach((f, i) => {
    const c = el('div', 'card');
    c.innerHTML = `
      <div class="spread" style="margin-bottom:10px">
        <b style="word-break:break-all">${f.name}</b>
        <button class="tab btn-sm" data-rm="${i}" style="color:var(--accent-2)">Remove</button>
      </div>
      <div class="field" style="margin-bottom:10px">
        <label>What's written on the tape?</label>
        <input type="text" data-label="${i}" value="${f.label || ''}" placeholder="e.g. Μάρτιος 1978, or 'box 3, no label'">
        <p class="note-inline">A photo of the label is worth taking before you file it away.</p>
      </div>
      <div class="field" style="margin:0">
        <label>Side</label>
        <select data-side="${i}">
          <option ${f.side === 'A' ? 'selected' : ''}>A</option>
          <option ${f.side === 'B' ? 'selected' : ''}>B</option>
        </select>
      </div>`;
    box.appendChild(c);
  });

  const mins = state.pending.length * 45;
  $('#estimate').innerHTML =
    `<b>${state.pending.length} recording${state.pending.length > 1 ? 's' : ''}</b> —
     roughly ${(mins / 60).toFixed(1)} hours of listening, costing about
     <b>${money(mins / 60 * 0.55)}</b>. Best started in the evening.`;

  box.oninput = e => {
    const i = e.target.dataset.label ?? e.target.dataset.side;
    if (e.target.dataset.label != null) state.pending[i].label = e.target.value;
    if (e.target.dataset.side != null) state.pending[i].side = e.target.value;
  };
  box.onclick = e => {
    const rm = e.target.dataset.rm;
    if (rm != null) { state.pending.splice(+rm, 1); renderPending(); }
  };
}

function addFiles(files) {
  for (const f of files) state.pending.push({ name: f.name, file: f, label: '', side: 'A' });
  renderPending();
}

// ---------------------------------------------------------------- night mode

let nightTimer = null;
function openNight(tape) {
  $('#night').hidden = false;
  const total = tape.minutes;
  let p = tape.progress || 0;
  const paint = () => {
    const C = 2 * Math.PI * 52;
    $('#ring').setAttribute('stroke-dashoffset', String(C * (1 - p)));
    $('#nightPct').textContent = Math.round(p * 100) + '%';
    $('#nightWhat').textContent = `Reading ${tape.label}`;
    const left = Math.max(1, Math.round(total * (1 - p)));
    $('#nightLeft').textContent = `about ${left} minute${left > 1 ? 's' : ''} left on this one`;
  };
  paint();
  if (DEMO) {
    clearInterval(nightTimer);
    nightTimer = setInterval(() => { p = Math.min(1, p + 0.01); paint(); if (p >= 1) clearInterval(nightTimer); }, 700);
  }
}
$('#nightExit').onclick = () => { $('#night').hidden = true; clearInterval(nightTimer); };

// ---------------------------------------------------------------- settings

function renderSettings() {
  $('#folderName').textContent = state.folder || (DEMO ? 'Grandpa Tapes (demo)' : 'Not chosen yet');
  $('#keyInput2').value = state.key;
  $('#keyState').textContent = state.key ? 'Saved on this computer.' : 'Not set — nothing can be read without it.';
  $('#quality').value = state.quality;
  $('#cap').value = state.cap;
  $('#spent').textContent = money(state.tapes.reduce((n, t) => n + (t.cost || 0), 0));
}
$('#keyInput2').oninput = e => { state.key = e.target.value.trim(); localStorage.setItem('or_key', state.key); renderSettings(); };
$('#quality').onchange = e => { state.quality = e.target.value; localStorage.setItem('tapes_quality', state.quality); };
$('#cap').oninput = e => { state.cap = e.target.value; localStorage.setItem('tapes_cap', state.cap); };

// ---------------------------------------------------------------- setup

function refreshSetup() {
  $('#step-folder').classList.toggle('done', !!state.folder);
  $('#step-key').classList.toggle('done', !!state.key);
  $('#finishSetup').disabled = !(state.folder && state.key);
}
$('#pickFolder').onclick = async () => {
  if (!('showDirectoryPicker' in window)) {
    return toast('This browser can\'t open folders — please use Chrome or Edge on a computer.');
  }
  try {
    const { pickProject } = await import('./store.js');
    await pickProject();
    state.folder = 'chosen';
    refreshSetup();
  } catch (e) { /* she cancelled */ }
};
$('#keyInput').oninput = e => {
  state.key = e.target.value.trim();
  localStorage.setItem('or_key', state.key);
  refreshSetup();
};
$('#finishSetup').onclick = () => go('add');

// ---------------------------------------------------------------- drop zone

const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
$('#fileInput').onchange = e => addFiles(e.target.files);

$('#startRun').onclick = () => {
  if (!state.key && !DEMO) { toast('The access key is missing — check Settings.'); return go('settings'); }
  const t = { id: 'tape-' + Date.now(), label: state.pending[0].label || state.pending[0].name,
              side: state.pending[0].side, minutes: 45, status: 'working', progress: 0,
              cost: 0, date: null, heading: null, segments: [] };
  state.tapes.push(t);
  state.pending = [];
  openNight(t);
  renderLibrary();
};

// ---------------------------------------------------------------- boot

function boot() {
  if (DEMO) {
    state.tapes = demoData.TAPES;
    state.names = demoData.NAMES;
    state.glossary = demoData.GLOSSARY;
    state.folder = 'Grandpa Tapes (demo)';
    state.key = state.key || 'demo';
  }
  const ready = (state.folder || DEMO) && state.key;
  $('#nameBadge').hidden = state.names.length === 0;
  $('#nameBadge').textContent = state.names.length;
  refreshSetup();
  go(ready ? 'library' : 'welcome');
}
boot();
