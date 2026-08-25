// UI. Everything here is written for someone who does not read Greek, is not technical,
// and cares about her grandfather. No jargon reaches the screen: no chunks, no models,
// no tokens, no API. Errors are sentences, not status codes.

import * as demoData from './demo.js';
import * as store from './store.js';
import { Queue, STATE, stepIndex, humanError } from './queue.js';
import { miniSteps, libraryBannerState, tapeClickMessage } from './library.js';
import { loadEntry, applyCorrectionAcross, makeAudioSource } from './entry.js';
import { translateAll } from './translate.js';
import { Recorder, listInputs, makeFileSink, levelToBar, levelAdvice, formatElapsed,
         makeLevelSmoother, fixStreamedDuration } from './record.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const DEMO = new URLSearchParams(location.search).has('demo');

// Every internal stage gets a sentence. She never sees a state name or a status code.
const SAYING = {
  loading:    'Getting ready…',
  reading:    'Opening the recording…',
  listening:  'Finding where he pauses…',
  splitting:  'Splitting it into pieces…',
  [STATE.READING]:     'Listening to it…',
  [STATE.TRANSLATING]: 'Putting it into English…',
  [STATE.PREPARING]:   'Getting the recording ready…'
};

const state = {
  view: 'library',
  tapes: [],
  pendingWords: [],
  glossary: [],
  folder: null,
  key: localStorage.getItem('or_key') || '',
  quality: localStorage.getItem('tapes_quality') || 'cross',
  model: localStorage.getItem('tapes_model') || undefined,
  // Backstop only, against a runaway loop. The real limit is the one set on the API key
  // itself, which is managed outside this tool.
  cap: '100',
  reading: null,
  store: null,
  queue: null,
  spent: 0,
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
  if (view === 'glossary') renderReview();
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

  const banner = libraryBannerState(state.tapes, !!(state.queue && state.queue.running));
  if (banner.kind === 'running') {
    $('#libBanner').innerHTML = `<div class="banner">Still reading <b>${banner.tape.label}</b>. You
       can read the finished entries below while it works. <button class="tab" id="toNight"
       style="padding:0 4px;color:var(--accent)">Show progress</button></div>`;
    $('#toNight').onclick = () => openRunScreen(banner.tape);
  } else if (banner.kind === 'stalled') {
    $('#libBanner').innerHTML = `<div class="banner warn">${banner.tapes.length} recording${
      banner.tapes.length > 1 ? 's' : ''} didn't finish being read -- probably the window closed
      partway through. Nothing is lost. <button class="tab" id="continueStalled"
      style="padding:0 4px;color:var(--accent)">Continue</button></div>`;
    $('#continueStalled').onclick = () => continueStalled(banner.tapes);
  } else {
    $('#libBanner').innerHTML = '';
  }

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
        ? `<div class="bar"><i style="width:${(t.progress * 100).toFixed(0)}%"></i></div>${miniSteps(t)}`
        : ''}`;
    card.onclick = () => t.status === 'done' ? openRead(t) : toast(tapeClickMessage(t));
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------- reading

async function openRead(tape) {
  state.reading = tape;
  go('read');
  const box = $('#entry');
  box.innerHTML = `<div class="entry-date">${tape.label}</div>
    <h2>${tape.heading || 'Undated entry'}</h2>`;

  // Demo data carries its own segments; a real tape has to be assembled from her folder.
  let entry = tape;
  if (!DEMO) {
    box.innerHTML += '<p class="muted">Opening…</p>';
    try { entry = await loadEntry(state.store, tape.id); }
    catch (e) { box.innerHTML += '<p class="muted">Couldn\'t open this one.</p>'; return; }
    state.reading = entry;
    box.innerHTML = `<div class="entry-date">${entry.label}</div>
      <h2>${entry.heading || 'Undated entry'}</h2>`;
  }

  if (!entry.segments.length) {
    box.innerHTML += '<p class="muted">Nothing has been read from this recording yet.</p>';
    $('#entryFoot').innerHTML = '';
    return;
  }

  for (const s of entry.segments) {
    const p = el('button', 'para');
    const ROUGH = 0.7;

    // An id the translator dropped shows the Greek rather than a blank line -- an empty
    // paragraph would read as though he said nothing at all.
    let html = s.untranslated
      ? `<span class="untranslated" title="This line couldn't be put into English.">${s.gr}</span>`
      : (s.en || '');

    if (!s.untranslated && s.unsure && html.includes(s.unsure)) {
      html = html.replace(s.unsure,
        `<span class="unsure" title="The tape was rough here — this part is a best guess.">${s.unsure}</span>`);
    } else if (!s.untranslated && s.confidence != null && s.confidence < ROUGH) {
      p.classList.add('rough');
      p.title = 'The tape was rough here — this line is less certain than the rest.';
    }
    p.innerHTML = `<svg class="play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>${html}`;
    p.onclick = () => playFrom(entry, s, p);
    box.appendChild(p);
  }

  const low = entry.segments.filter(s => s.unsure || s.untranslated ||
                                    (s.confidence != null && s.confidence < 0.7)).length;
  $('#entryFoot').innerHTML =
    `Click any line to hear him say it.` +
    (low ? ` &nbsp;·&nbsp; ${low} passage${low > 1 ? 's were' : ' was'} hard to make out —
       they're shaded, and you can help sort them out under <b>Glossary</b>.` : '');
}

let playTimer = null;
const audioSource = makeAudioSource();

// The audio lives in her folder, which has no URL. It must be read as a blob and handed to
// the player as an object URL -- and the previous one revoked, or clicking through an entry
// leaks a megabyte and a half per line until reload.
export async function playChunk(tapeId, chunkIndex, offsetSec = 0) {
  const a = $('#player');
  a.pause();
  const blob = await state.store.readBlob(store.paths.chunkAudio(tapeId, chunkIndex));
  a.src = audioSource.use(blob);   // releases the previous URL before making a new one
  await new Promise((res, rej) => {
    a.onloadedmetadata = res;          // currentTime is ignored before metadata arrives
    a.onerror = () => rej(new Error('audio'));
  });
  a.currentTime = Math.max(0, offsetSec);
  await a.play();
}

function playFrom(entry, s, node) {
  $$('.para.playing').forEach(n => n.classList.remove('playing'));
  clearTimeout(playTimer);
  node.classList.add('playing');
  if (DEMO) {
    toast(`Playing from ${fmtTime(s.start)} — audio isn't loaded in the demo`);
    playTimer = setTimeout(() => node.classList.remove('playing'), 2200);
    return;
  }
  // In MAI-only mode there are no intra-chunk timestamps, so fall back to the chunk start.
  const offset = (s.start != null ? s.start : s.chunkStart) - (s.chunkStart || 0);
  playChunk(entry.id, s.chunk || 0, offset)
    .catch(() => toast("Couldn't play that bit — the recording may have moved."));
}
const fmtTime = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------- glossary

// The only distinction the interface needs is whether she can hear a discrete word and
// spell it back, or whether the tape blurred a whole stretch. Deliberately NOT an
// ontology: the app never claims something is a person, a place, or anything else --
// Κώστας may be a man or a boat, and nothing in the audio settles it.
const KIND = {
  word:   { chip: 'Unclear word',   ask: 'name' },
  phrase: { chip: 'Unclear phrase', ask: 'sense' }
};
const kindOf = k => KIND[k] || KIND.word;

function renderReview() {
  const left = state.pendingWords.length - state.nameIdx;
  $('#nameBadge').hidden = left <= 0;
  $('#nameBadge').textContent = left;
  $('#reviewWrap').hidden = left <= 0;
  $('#reviewDone').hidden = left > 0;
  $('#reviewLeft').textContent = left > 0 ? `${left} left` : '';
  renderGlossList();
  if (left <= 0) return;

  const n = state.pendingWords[state.nameIdx];
  const kind = kindOf(n.kind);
  const box = $('#nameCard');
  box.innerHTML = '';

  const card = el('div', 'name-card');
  const heard = n.heard > 1 ? `heard ${n.heard} times` : 'heard once';

  // A name she can hear and spell. A blurred phrase she cannot -- but she can say whether
  // our English reads sensibly, so that is what we ask instead.
  const head = kind.ask === 'name'
    ? `<div class="name-greek">${n.greek}</div>`
    : `<div class="phrase-greek">${n.greek}</div>`;

  card.innerHTML = `
    <div class="kind-chip">${kind.chip} · ${heard}</div>
    ${head}
    <div class="clip">
      <button class="btn btn-ghost btn-sm" id="hear">▶ Hear this bit</button>
      <p class="ctx" style="margin-top:13px">${n.context[0]}<b>${n.guess}</b>${n.context[1]}</p>
    </div>
    ${n.hint ? `<p class="note-inline hint">${n.hint}</p>` : ''}

    <div id="askBlock">
      <p class="ask">${kind.ask === 'name'
        ? `We think this is <b>${n.guess}</b>.`
        : `Our best guess is <b>"${n.guess}"</b>. Does that make sense here?`}</p>
      <div class="name-actions">
        <button class="btn" id="yes">${kind.ask === 'name' ? "Yes, that's right" : 'Yes, that reads right'}</button>
        <button class="btn btn-ghost" id="no">${kind.ask === 'name' ? "No, it's something else" : "No, that's not it"}</button>
      </div>
      <div class="link-row">
        <button class="linkish" id="note">Add a note</button>
        <button class="linkish" id="skip">Skip this one for now</button>
      </div>
    </div>

    <div id="noteBlock" hidden>
      <p class="ask">Anything worth remembering about this one?</p>
      <input type="text" id="noteIn" autocomplete="off"
             placeholder="what or who it is — only if you know">
      <p class="note-inline">Entirely optional.</p>
      <div class="name-actions">
        <button class="btn" id="noteSave">Save note</button>
        <button class="btn btn-ghost" id="noteCancel">Back</button>
      </div>
    </div>

    <div id="fixBlock" hidden>
      <p class="ask" id="fixAsk"></p>
      <input type="text" id="nameIn" autocomplete="off" spellcheck="false">
      <p class="note-inline" id="fixHelp"></p>
      <div class="name-actions">
        <button class="btn" id="save">Save it</button>
        <button class="btn btn-ghost" id="cancel">Back</button>
      </div>
    </div>`;
  box.appendChild(card);

  let pendingNote = '';
  $('#hear').onclick = () => toast(DEMO ? "Audio isn't loaded in the demo" : 'Playing…');
  $('#note').onclick = () => {
    $('#askBlock').hidden = true; $('#noteBlock').hidden = false;
    $('#noteIn').value = pendingNote; $('#noteIn').focus();
  };
  $('#noteCancel').onclick = () => { $('#askBlock').hidden = false; $('#noteBlock').hidden = true; };
  $('#noteSave').onclick = () => {
    pendingNote = $('#noteIn').value.trim();
    $('#askBlock').hidden = false; $('#noteBlock').hidden = true;
    $('#note').textContent = pendingNote ? 'Edit note' : 'Add a note';
    if (pendingNote) toast('Noted — saved with this entry.');
  };
  $('#yes').onclick = () => commit(n.guess, true);
  $('#skip').onclick = next;

  $('#no').onclick = () => {
    $('#askBlock').hidden = true;
    $('#fixBlock').hidden = false;
    $('#fixAsk').innerHTML = kind.ask === 'name'
      ? 'What do you hear instead?'
      : 'What do you think he actually says?';
    $('#fixHelp').textContent = kind.ask === 'name'
      ? "However you'd spell it in English."
      : "Even a rough idea helps. Leave it blank if you can't tell.";
    const i = $('#nameIn');
    i.value = '';
    i.placeholder = kind.ask === 'name' ? 'e.g. Panagiotis' : "e.g. in the neighbour's orchard";
    i.focus();
  };
  $('#cancel').onclick = () => { $('#askBlock').hidden = false; $('#fixBlock').hidden = true; };
  $('#save').onclick = () => {
    const v = $('#nameIn').value.trim();
    if (!v) return toast("Type what you think it is, or press Back and skip it.");
    commit(v, false);
  };
  $('#nameIn').onkeydown = e => { if (e.key === 'Enter') $('#save').click(); };

  function next() { state.nameIdx++; renderReview(); }

  async function commit(value, wasGuessRight) {
    const entry = { id: n.id, english: value, greek: n.greek,
                    canonical_greek: n.greek, observed_forms: n.observed_forms || [n.greek],
                    kind: n.kind, heard: n.heard, note: pendingNote, confirmed: true };
    state.glossary.unshift(entry);
    next();

    if (DEMO) {
      toast(wasGuessRight ? `Good — "${value}" is kept for every recording.`
                          : `Changed to "${value}".`);
      return;
    }

    try {
      await state.store.writeJSON(store.paths.glossary(), state.glossary);

      // Confirming the guess changes no English anywhere -- it only teaches future tapes.
      if (wasGuessRight && value === n.guess) {
        return toast(`Kept as "${value}" — every recording from here on will match.`);
      }

      const ids = state.tapes.map(t => t.id);
      const r = await applyCorrectionAcross(state.store, ids, entry, n.guess, value, {
        translate: translateAll,
        translateOpts: { key: state.key, model: state.model, glossary: state.glossary }
      });
      // Say what actually happened, rather than claiming work that was not done.
      toast(`"${value}" — ${r.summary}`);
      if (r.failed) toast(`${r.failed} of them couldn't be re-read just now; they're unchanged.`);
    } catch (e) {
      toast("Saved the name, but couldn't update the recordings just now.");
    }
  }
}

function renderGlossList() {
  const box = $('#glossList');
  box.innerHTML = '';
  $('#glossEmpty').hidden = state.glossary.length > 0;
  for (const g of state.glossary) {
    const row = el('div', 'gloss-row');
    row.dataset.id = g.id;
    row.innerHTML = `
      <div class="gloss-main">
        <b>${g.english}</b>
        <span class="muted" style="font-size:.82rem"> · ${g.greek}</span>
        <div class="muted" style="font-size:.78rem">heard ${g.heard} times</div>
        ${g.note ? `<div class="gloss-note">${g.note}</div>` : ''}
      </div>
      <button class="linkish" data-edit="${g.id}">Change</button>`;
    box.appendChild(row);
  }
  box.onclick = e => {
    const id = e.target.dataset.edit;
    if (id) return editRow(id);
  };
}

function editRow(id) {
  const g = state.glossary.find(x => x.id === id);
  const row = $(`.gloss-row[data-id="${id}"]`);
  row.classList.add('editing');
  row.innerHTML = `
    <div class="gloss-main">
      <div class="field" style="margin-bottom:10px">
        <label>Called this in English</label>
        <input type="text" id="edEn" value="${g.english}">
      </div>
      <div class="field" style="margin:0">
        <label>Your note <span class="muted">(optional)</span></label>
        <input type="text" id="edNote" value="${g.note || ''}"
               placeholder="only if you know — nothing here is guessed">
      </div>
      <div class="name-actions">
        <button class="btn btn-sm" id="edSave">Save</button>
        <button class="btn btn-ghost btn-sm" id="edCancel">Cancel</button>
      </div>
    </div>`;
  $('#edEn').focus();
  $('#edCancel').onclick = renderGlossList;
  $('#edSave').onclick = () => {
    const v = $('#edEn').value.trim();
    if (!v) return toast('Give it a name, or press Cancel.');
    g.english = v;
    g.note = $('#edNote').value.trim();
    renderGlossList();
    toast('Updated in every recording.');
  };
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

  $('#estimate').innerHTML =
    `<b>${state.pending.length} recording${state.pending.length > 1 ? 's' : ''}</b>`;

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

// ------------------------------------------------------------- recording
//
// Lets her hold a microphone up to the cassette player rather than buying a cable and an
// interface. The level meter and the test recording exist for one reason: a whole side
// captured silently or clipped is 45 minutes she does not get back.

let recorder = null;
let recSink = null;
let recWakeLock = null;

// One smoother per meter, so a pause for breath does not read as a fault.
const smoothers = new WeakMap();
function paintMeter(barEl, adviceEl, raw, seconds) {
  if (!smoothers.has(barEl)) smoothers.set(barEl, makeLevelSmoother());
  const level = smoothers.get(barEl)(raw);
  const a = levelAdvice(level, seconds);
  barEl.style.width = (levelToBar(level.db) * 100).toFixed(1) + '%';
  const meter = barEl.parentElement;
  meter.classList.toggle('warn', a.tone === 'warn');
  meter.classList.toggle('bad', a.tone === 'bad');
  adviceEl.textContent = a.text;
  adviceEl.className = 'meter-advice ' + (a.tone === 'ok' ? '' : a.tone);
}

async function fillDevices() {
  const sel = $('#recDevice');
  const list = await listInputs();
  sel.innerHTML = list.length
    ? list.map(d => `<option value="${d.id}">${d.label}</option>`).join('')
    : '<option value="">No microphone found</option>';
}

// A live meter with nothing being saved, so she can aim and set the volume first.
async function startPreview() {
  await stopPreview();
  recorder = new Recorder();
  try {
    await recorder.start({
      deviceId: $('#recDevice').value || undefined,
      onLevel: (lvl, secs) => paintMeter($('#meterBar'), $('#meterAdvice'), lvl, secs)
    });
  } catch (e) {
    $('#meterAdvice').textContent = e.name === 'NotAllowedError'
      ? 'The browser needs permission to use the microphone.'
      : "Couldn't open that microphone.";
    $('#meterAdvice').className = 'meter-advice bad';
    recorder = null;
  }
}
async function stopPreview() {
  if (recorder && !recSink) { await recorder.stop(); recorder = null; }
}

$('#recOpen').onclick = async () => {
  const panel = $('#recPanel');
  panel.hidden = !panel.hidden;
  $('#recOpen').textContent = panel.hidden ? 'Set up' : 'Close';
  if (panel.hidden) return stopPreview();
  await fillDevices();
  await startPreview();
  await fillDevices();   // device labels only appear once permission is granted
};
$('#recDevice').onchange = () => startPreview();

// A handful of seconds, played straight back. Cheap insurance against a wasted side.
const TEST_SECONDS = 5;
$('#recTest').onclick = async () => {
  const btn = $('#recTest');
  btn.disabled = true; $('#recStart').disabled = true;
  await stopPreview();
  const parts = [];
  const r = new Recorder({ timeslice: 1000 });
  try {
    await r.start({
      deviceId: $('#recDevice').value || undefined,
      onData: async b => parts.push(b),
      onLevel: (lvl, secs) => {
        paintMeter($('#meterBar'), $('#meterAdvice'), lvl, secs);
        btn.textContent = `Testing… ${Math.max(0, TEST_SECONDS - Math.floor(secs))}s`;
      }
    });
  } catch (e) { btn.disabled = false; $('#recStart').disabled = false; return; }

  await new Promise(res => setTimeout(res, TEST_SECONDS * 1000));
  const info = await r.stop();
  const blob = new Blob(parts, { type: info.mime });
  const a = $('#recTestAudio');
  if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
  a.src = URL.createObjectURL(blob);
  $('#recTestOut').hidden = false;
  btn.textContent = 'Test again';
  btn.disabled = false; $('#recStart').disabled = false;
  // A blob built from streamed recorder chunks reports duration as Infinity in Chrome,
  // which makes the seek bar jump to the end instead of tracking playback. Fix it once
  // metadata is in, rather than leaving the player looking broken.
  a.onloadedmetadata = () => fixStreamedDuration(a);
  await startPreview();
};

$('#recStart').onclick = async () => {
  if (!state.store) { toast('Choose where to keep everything first.'); return go('settings'); }
  await stopPreview();

  const id = 'tape-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  recorder = new Recorder();
  try {
    const info = await recorder.start({
      deviceId: $('#recDevice').value || undefined,
      onLevel: (lvl, secs) => {
        paintMeter($('#meterBarLive'), $('#meterAdviceLive'), lvl, secs);
        $('#recTime').textContent = formatElapsed(secs);
      },
      onData: async blob => { await recSink?.write(blob); },
      onError: () => toast('Trouble saving — the recording is still going.')
    });
    // Written straight to her folder as it arrives, so a 45-minute side is never held in
    // memory and a crash still leaves everything captured up to that moment.
    recSink = await makeFileSink(state.store, `tapes/${id}/source.${info.extension}`);
    recorder._tapeId = id;
    recorder._ext = info.extension;
  } catch (e) {
    recorder = null;
    return toast('The browser needs permission to use the microphone.');
  }

  // A side runs 45 minutes; the machine sleeping halfway through would lose it.
  try { recWakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}

  $('#recPanel').hidden = true;
  $('#recLive').hidden = false;
  $('#recOpen').hidden = true;
};

$('#recStop').onclick = async () => {
  const id = recorder?._tapeId;
  const ext = recorder?._ext || 'webm';
  const info = await recorder?.stop();
  const bytes = await recSink?.close();
  recorder = null; recSink = null;
  try { await recWakeLock?.release(); } catch (e) {}
  recWakeLock = null;

  $('#recLive').hidden = true;
  $('#recOpen').hidden = false;
  $('#recOpen').textContent = 'Set up';

  if (!bytes) return toast('Nothing was captured.');
  await state.store.writeJSON(store.paths.tape(id), {
    id, label: '', side: 'A', source: `source.${ext}`,
    recordedSeconds: Math.round(info.seconds)
  });
  state.pending.push({ name: `Recording (${formatElapsed(info.seconds)})`, tapeId: id,
                       label: '', side: 'A', alreadyStored: true });
  renderPending();
  toast(`Saved ${formatElapsed(info.seconds)}. Name it below, then start reading.`);
};

// ------------------------------------------------- the run screen
// Shown while it works. Deliberately says nothing about time of day: she may run this
// overnight, or during a workday in the background. The only real constraint is that the
// window stays open and the machine stays awake.

let runTimer = null;
function openRunScreen(tape) {
  $('#runScreen').hidden = false;
  const total = tape.minutes;
  let p = tape.progress || 0;
  const paint = () => {
    const C = 2 * Math.PI * 52;
    $('#ring').setAttribute('stroke-dashoffset', String(C * (1 - p)));
    $('#runPct').textContent = Math.round(p * 100) + '%';
    $('#runWhat').textContent = `Reading ${tape.label}`;
    const left = Math.max(1, Math.round(total * (1 - p)));
    $('#runLeft').textContent = `about ${left} minute${left > 1 ? 's' : ''} left on this one`;
  };
  paint();
  if (DEMO) {
    clearInterval(runTimer);
    runTimer = setInterval(() => { p = Math.min(1, p + 0.01); paint(); if (p >= 1) clearInterval(runTimer); }, 700);
  }
}
$('#runExit').onclick = () => closeRunScreen();
function closeRunScreen() { $('#runScreen').hidden = true; clearInterval(runTimer); }
function setRunSaying(text) { $('#runWhat').textContent = text; }
function setRunProgress(tape, p) {
  const C = 2 * Math.PI * 52;
  $('#ring').setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, Math.min(1, p)))));
  $('#runPct').textContent = Math.round(p * 100) + '%';
  if (tape?.label) $('#runLeft').textContent = tape.label;
}

// ---------------------------------------------------------------- settings

function renderSettings() {
  $('#folderName').textContent = state.folder || (DEMO ? 'Grandpa Tapes (demo)' : 'Not chosen yet');
  $('#keyInput2').value = state.key;
  $('#keyState').textContent = state.key ? 'Saved on this computer.' : 'Not set — nothing can be read without it.';
  $('#quality').value = state.quality;
}
$('#keyInput2').oninput = e => { state.key = e.target.value.trim(); localStorage.setItem('or_key', state.key); renderSettings(); };
$('#quality').onchange = e => { state.quality = e.target.value; localStorage.setItem('tapes_quality', state.quality); };

// ---------------------------------------------------------------- setup

function refreshSetup() {
  // Say this up front rather than only when she taps. Android Chrome has no
  // showDirectoryPicker at all, so on a phone the button can never do anything, and a
  // dead button with no explanation is the worst version of that.
  const canPickFolder = 'showDirectoryPicker' in window;
  $('#unsupported').hidden = canPickFolder;
  $('#pickFolder').disabled = !canPickFolder;

  $('#step-folder').classList.toggle('done', !!state.folder);
  $('#step-key').classList.toggle('done', !!state.key);
  $('#finishSetup').disabled = !(state.folder && state.key);
}
$('#pickFolder').onclick = async () => {
  if (!('showDirectoryPicker' in window)) {
    return toast('This browser can\'t open folders — please use Chrome or Edge on a computer.');
  }
  try {
    state.store = await store.pickProject();
    state.folder = 'chosen';
    refreshSetup();
    await refreshLibrary();
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

// Shared by a fresh run and a resumed one: same events, same run screen, same banner
// logic in renderLibrary(). Whether a tape is brand new or picking back up after an
// abandoned run looks identical from here -- the engine already knows what is left to do.
async function runQueue(specs) {
  if (!specs.length) return;
  if (!state.key) { toast('The access key is missing — check Settings.'); return go('settings'); }
  if (!state.store) { toast('Choose where to keep everything first.'); return go('settings'); }

  const queue = new Queue({
    store: state.store,
    key: state.key,
    mode: state.quality,
    glossary: state.glossary,
    spendCap: parseFloat(state.cap) || Infinity,
    spent: state.tapes.reduce((n, t) => n + (t.cost || 0), 0),
    on: {
      change: () => renderLibrary(),
      stage: (tape, st) => setRunSaying(SAYING[st] || 'Working…'),
      progress: (tape, p) => setRunProgress(tape, p),
      retry: (tape, msg) => setRunSaying(msg),
      spend: total => { state.spent = total; },
      capped: () => {
        closeRunScreen();
        toast('LIMIT REACHED');
      },
      readOnly: () => {
        closeRunScreen();
        toast('This is already running in another window, so nothing was changed here.');
      },
      unresolved: (tape, ids) =>
        toast(`${ids.length} line${ids.length > 1 ? 's' : ''} of "${tape.label}" couldn't be put into English.`),
      error: (tape, msg) => toast(msg),
      done: async tape => { await refreshLibrary(); },
      stop: async () => { closeRunScreen(); await refreshLibrary(); }
    }
  });

  for (const spec of specs) queue.add(spec);

  state.queue = queue;
  openRunScreen({ label: queue.tapes[0].label, minutes: 45, progress: 0 });
  await queue.start();
}

$('#startRun').onclick = async () => {
  if (!state.pending.length) return;

  if (DEMO) {
    const t = { id: 'tape-' + state.tapes.length, label: state.pending[0].label || state.pending[0].name,
                side: state.pending[0].side, minutes: 45, status: 'working', progress: 0,
                cost: 0, date: null, heading: null, segments: [] };
    state.tapes.push(t);
    state.pending = [];
    openRunScreen(t);
    return renderLibrary();
  }

  if (!state.key) { toast('The access key is missing — check Settings.'); return go('settings'); }
  if (!state.store) { toast('Choose where to keep everything first.'); return go('settings'); }

  const specs = [];
  for (const f of state.pending) {
    const id = f.tapeId ||
      ('tape-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    let file = f.file;
    let sourceName;
    if (f.alreadyStored) {
      // Already recorded straight into her folder; read it back rather than re-saving it.
      const saved = await state.store.readJSON(store.paths.tape(id)).catch(() => ({}));
      sourceName = saved.source || 'source.webm';
      const blob = await state.store.readBlob(`tapes/${id}/${sourceName}`);
      file = new File([blob], sourceName, { type: blob.type });
    } else {
      // A dropped file lives only in browser memory until now. Save it to her folder
      // immediately, the same way a recording already is, so an interruption before
      // chunking even starts still leaves something a later "Continue" can pick up.
      const ext = (f.file.name.match(/\.(\w+)$/) || [])[1] || 'audio';
      sourceName = `source.${ext}`;
      await state.store.write(`tapes/${id}/${sourceName}`, new Uint8Array(await f.file.arrayBuffer()));
    }
    const prior = f.alreadyStored
      ? await state.store.readJSON(store.paths.tape(id)).catch(() => ({})) : {};
    await state.store.writeJSON(store.paths.tape(id),
      { ...prior, id, label: f.label || f.name, side: f.side, state: STATE.QUEUED, source: sourceName });
    specs.push({ id, file, label: f.label || f.name, side: f.side });
  }
  state.pending = [];
  renderPending();
  await runQueue(specs);
};

// The library's "Continue" banner: rebuild a File for each stalled tape from what is
// already on disk and hand it back to the same run path. Nothing is redone that the
// engine can already see is finished -- that is the whole point of resuming by folder
// contents rather than by memory.
async function continueStalled(tapes) {
  const specs = [];
  const missing = [];
  for (const t of tapes) {
    try {
      const saved = await state.store.readJSON(store.paths.tape(t.id));
      const sourceName = saved.source || 'source.webm';
      const blob = await state.store.readBlob(`tapes/${t.id}/${sourceName}`);
      specs.push({ id: t.id, file: new File([blob], sourceName, { type: blob.type }),
                   label: t.label, side: t.side });
    } catch (e) { missing.push(t.label); }
  }
  if (missing.length) {
    toast(`Couldn't find the recording for ${missing.join(', ')} -- it may need to be added again.`);
  }
  await runQueue(specs);
}

// Load what is actually in her folder, so the library survives a reload.
async function refreshLibrary() {
  if (DEMO || !state.store) return;
  const ids = await state.store.list('tapes');
  const tapes = [];
  for (const id of ids) {
    try {
      const t = await state.store.readJSON(store.paths.tape(id));
      const stepIdx = stepIndex(t.state);
      // A tape mid-processing (PREPARING/READING/TRANSLATING) is 'working' with a real
      // percentage, not the same flat "Waiting" as one that has not started at all.
      const status = t.state === STATE.DONE ? 'done'
                   : t.state === STATE.FAILED ? 'error'
                   : stepIdx >= 0 ? 'working' : 'queued';
      tapes.push({
        id, label: t.label || id, side: t.side || 'A',
        minutes: Math.round((t.duration || 0) / 60) || 0,
        status, stepIdx, error: t.error || null,
        progress: t.progress || 0, cost: t.cost || 0,
        date: (t.dates && t.dates[0] && t.dates[0].iso) || null,
        heading: null, segments: []
      });
    } catch (e) { /* a folder mid-write */ }
  }
  state.tapes = tapes;
  renderLibrary();
}

// ---------------------------------------------------------------- boot

function boot() {
  if (DEMO) {
    state.tapes = demoData.TAPES;
    state.pendingWords = demoData.PENDING;
    state.glossary = demoData.GLOSSARY;
    state.folder = 'Grandpa Tapes (demo)';
    state.key = state.key || 'demo';
  }
  if (!DEMO) {
    // File System Access re-permission needs a gesture, so this can only succeed silently
    // when the grant survived. Otherwise she gets the folder button and one click.
    store.restoreProject().then(async st => {
      if (!st) return;
      state.store = st;
      state.folder = 'chosen';
      refreshSetup();
      await refreshLibrary();
    }).catch(() => {});
  }
  const ready = (state.folder || DEMO) && state.key;
  $('#nameBadge').hidden = state.pendingWords.length === 0;
  $('#nameBadge').textContent = state.pendingWords.length;
  refreshSetup();
  go(ready ? 'library' : 'welcome');
}
boot();
