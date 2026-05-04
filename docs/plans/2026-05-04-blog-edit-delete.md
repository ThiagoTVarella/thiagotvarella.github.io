# Blog Publisher PWA — Edit & Delete Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Edit and Delete post tabs to `admin/index.html`. No new files — all changes are in one file.

**Architecture:** Add a three-tab nav (New · Edit · Delete) to the `#app` card. Edit tab loads a post list from `footerblog.html`, fetches the selected post, parses it, and pre-fills a form. Delete tab loads the same list and removes the file + archive entry on confirm.

**Tech Stack:** Same as existing — Vanilla HTML/CSS/JS, GitHub REST API v3.

---

### Task 1: Rewrite admin/index.html with tabs, Edit, and Delete

**Files:**
- Modify: `admin/index.html` (complete rewrite)

**Step 1: Write the complete new file**

Replace `/home/thiag/ThiagoTVarella.github.io/admin/index.html` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog Publisher</title>
  <link rel="manifest" href="/admin/manifest.json">
  <meta name="theme-color" content="#2c2c2c">
  <link href="https://fonts.googleapis.com/css?family=Comfortaa&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Comfortaa', sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
    }
    .subtitle { font-size: 0.85rem; color: #999; margin-bottom: 20px; }
    label { display: block; font-size: 0.85rem; color: #666; margin-bottom: 4px; }
    input, textarea, select {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 1rem;
      font-family: inherit;
      margin-bottom: 16px;
      outline: none;
      background: white;
    }
    input:focus, textarea:focus, select:focus { border-color: #2c2c2c; }
    textarea { height: 220px; resize: vertical; }
    button {
      width: 100%;
      padding: 14px;
      background: #2c2c2c;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #444; }
    button:disabled { background: #aaa; cursor: default; }
    .btn-danger { background: #c0392b; }
    .btn-danger:hover { background: #a93226; }
    .status { margin-top: 12px; font-size: 0.9rem; text-align: center; min-height: 20px; }
    .status.error { color: #c0392b; }
    .status.success { color: #27ae60; }
    .reset-link {
      display: block;
      text-align: center;
      margin-top: 20px;
      font-size: 0.8rem;
      color: #bbb;
      cursor: pointer;
      text-decoration: underline;
    }
    /* Tab bar */
    .tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 20px;
    }
    .tab {
      flex: 1;
      padding: 9px 4px;
      background: #f0f0f0;
      color: #666;
      border-radius: 8px;
      font-size: 0.9rem;
      font-family: inherit;
      border: none;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
    }
    .tab.active { background: #2c2c2c; color: white; }
    .confirm-msg { font-size: 0.9rem; color: #666; margin-bottom: 12px; text-align: center; }
    #setup, #app { display: none; }
  </style>
</head>
<body>

<!-- Setup screen -->
<div class="card" id="setup">
  <h1 style="font-size:1.4rem;margin-bottom:8px;color:#2c2c2c;">Blog Publisher</h1>
  <p class="subtitle">One-time setup — paste your GitHub token below.</p>
  <label for="token-input">GitHub Personal Access Token</label>
  <input type="password" id="token-input" placeholder="github_pat_...">
  <button id="save-token-btn">Save & Continue</button>
  <div class="status" id="setup-status"></div>
</div>

<!-- Main app -->
<div class="card" id="app">
  <nav class="tabs">
    <button class="tab active" data-tab="new">New</button>
    <button class="tab" data-tab="edit">Edit</button>
    <button class="tab" data-tab="delete">Delete</button>
  </nav>

  <!-- New Post tab -->
  <div id="tab-new" class="tab-panel">
    <p class="subtitle">Write and publish directly to your blog.</p>
    <label for="title-input">Title</label>
    <input type="text" id="title-input" placeholder="Post title">
    <label for="body-input">Body</label>
    <textarea id="body-input" placeholder="Write your post here...&#10;&#10;Separate paragraphs with a blank line."></textarea>
    <button id="publish-btn">Publish</button>
    <div class="status" id="new-status"></div>
  </div>

  <!-- Edit tab -->
  <div id="tab-edit" class="tab-panel" style="display:none">
    <p class="subtitle">Select a post to edit.</p>
    <label for="edit-select">Post</label>
    <select id="edit-select"><option value="">Select a post…</option></select>
    <div id="edit-form" style="display:none">
      <label for="edit-title">Title</label>
      <input type="text" id="edit-title">
      <label for="edit-body">Body</label>
      <textarea id="edit-body"></textarea>
      <button id="save-btn">Save Changes</button>
    </div>
    <div class="status" id="edit-status"></div>
  </div>

  <!-- Delete tab -->
  <div id="tab-delete" class="tab-panel" style="display:none">
    <p class="subtitle">Select a post to delete.</p>
    <label for="delete-select">Post</label>
    <select id="delete-select"><option value="">Select a post…</option></select>
    <div id="delete-confirm" style="display:none">
      <p class="confirm-msg">This cannot be undone.</p>
      <button id="confirm-delete-btn" class="btn-danger">Delete Post</button>
    </div>
    <div class="status" id="delete-status"></div>
  </div>

  <span class="reset-link" id="reset-link">Reset token</span>
</div>

<script>
const REPO = 'ThiagoTVarella/ThiagoTVarella.github.io';
const API  = 'https://api.github.com';

// --- Storage ---
const getToken   = () => localStorage.getItem('gh_token');
const saveToken  = t  => localStorage.setItem('gh_token', t);
const clearToken = ()  => localStorage.removeItem('gh_token');

// --- Screen switching ---
function showSetup() {
  document.getElementById('setup').style.display = 'block';
  document.getElementById('app').style.display   = 'none';
}
function showApp() {
  document.getElementById('setup').style.display = 'none';
  document.getElementById('app').style.display   = 'block';
}

// --- Tab switching ---
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.style.display = (p.id === 'tab-' + name) ? 'block' : 'none'
  );
  if (name === 'edit')   loadPostList('edit-select',   'edit-status');
  if (name === 'delete') loadPostList('delete-select', 'delete-status');
}

// --- Status helpers ---
function setStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status ' + (type || '');
}

// --- GitHub API ---
async function apiGet(path) {
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json'
    }
  });
  if (!res.ok) throw new Error(`Failed to read ${path} (${res.status})`);
  return res.json();
}

async function apiPut(path, content, sha, message) {
  const b64  = btoa(unescape(encodeURIComponent(content)));
  const body = { message, content: b64 };
  if (sha) body.sha = sha;
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Failed to write ${path} (${res.status})`);
  }
  return res.json();
}

async function apiDelete(path, sha, message) {
  const res = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, sha })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Failed to delete ${path} (${res.status})`);
  }
  return res.json();
}

// --- Blog helpers ---

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeContent(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

function getNextPostNum(footerHtml) {
  const matches = [...footerHtml.matchAll(/href="\/blog\/(\d+)\.html"/g)];
  if (matches.length === 0) return 1;
  return Math.max(...matches.map(m => parseInt(m[1]))) + 1;
}

function buildNewFooter(footerHtml, postNum, title) {
  const newLi = `\n            <li><a href="/blog/${postNum}.html">${title}</a></li>`;
  return footerHtml.replace('</ul>', newLi + '\n        </ul>');
}

function updateFooterTitle(footerHtml, postNum, newTitle) {
  return footerHtml.replace(
    new RegExp(`(href="/blog/${postNum}\\.html">)[^<]*(</a>)`),
    `$1${newTitle}$2`
  );
}

function removeFromFooter(footerHtml, postNum) {
  return footerHtml.replace(
    new RegExp(`\\s*<li><a href="/blog/${postNum}\\.html">[^<]*</a></li>`),
    ''
  );
}

// Parse an existing post's HTML to extract title and body text
function parsePostHtml(html) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(html, 'text/html');
  const h3     = doc.querySelector('section h3');
  const ps     = doc.querySelectorAll('section p');
  return {
    title: h3 ? h3.textContent.trim() : '',
    body:  [...ps].map(p => p.textContent.trim()).filter(Boolean).join('\n\n')
  };
}

// Load post list into a <select> from footerblog.html; returns { footerData, footerHtml }
async function loadPostList(selectId, statusId) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">Loading…</option>';
  select.disabled  = true;
  try {
    const footerData = await apiGet('blog/footerblog.html');
    const footerHtml = decodeContent(footerData.content);
    const matches    = [...footerHtml.matchAll(/href="\/blog\/(\d+)\.html">([^<]+)<\/a>/g)];
    select.innerHTML = '<option value="">Select a post…</option>' +
      matches.map(m => `<option value="${m[1]}">${m[2]}</option>`).join('');
    select.disabled = false;
    return { footerData, footerHtml };
  } catch (err) {
    setStatus(statusId, 'Error loading posts: ' + err.message, 'error');
    select.disabled = false;
  }
}

function buildPostHtml(title, body) {
  const paras = body.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const pTags = paras.map(p => `\t\t\t<p>${escapeHtml(p)}</p>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en" class="no-js">
<head>
\t<!-- Global site tag (gtag.js) - Google Analytics -->
\t<script async src="https://www.googletagmanager.com/gtag/js?id=UA-139921552-1"><\/script>
\t<script>
\t\twindow.dataLayer = window.dataLayer || [];
\t\tfunction gtag(){dataLayer.push(arguments);}
\t\tgtag('js', new Date());
\t\tgtag('config', 'UA-139921552-1');
\t<\/script>
\t<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
\t<link rel="shortcut icon" href="../img/icone.ico">
\t<meta name="author" content="ThiagoTVarella">
\t<meta name="description" content="Personal webpage for Thiago Tarraf Varella">
\t<meta name="keywords" content="Thiago Tarraf Varella, thiagotvarella, tvarella, Tarraf Varella, Computational, Neuroscience, Theoretic, Cognitive, Psychology, Animal, Behavior, Behaviour">
\t<meta charset="UTF-8">
\t<title>Thiago Tarraf Varella</title>
\t<link href="https://fonts.googleapis.com/css?family=Comfortaa&display=swap" rel="stylesheet">
\t<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.4.0/jquery.min.js"><\/script>
\t<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.0/css/bootstrap.min.css">
\t<script src="https://maxcdn.bootstrapcdn.com/bootstrap/3.4.0/js/bootstrap.min.js"><\/script>
\t<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
\t<link rel="stylesheet" href="../css/main.css">
\t<script src="../js/main.js"><\/script>
</head>
<body>
\t<div class="container">
\t\t<div id="header"></div>
\t\t<section>
\t\t\t<h3>${escapeHtml(title)}</h3>
${pTags}
\t\t</section>
\t\t<div id="footerblog"></div>
\t\t<div id="footer"></div>
\t</div>
</body>
</html>`;
}

// --- New Post ---
async function publish() {
  const title = document.getElementById('title-input').value.trim();
  const body  = document.getElementById('body-input').value.trim();
  if (!title) { setStatus('new-status', 'Title is required.', 'error'); return; }
  if (!body)  { setStatus('new-status', 'Body is required.',  'error'); return; }

  const btn = document.getElementById('publish-btn');
  btn.disabled = true;
  setStatus('new-status', 'Reading archive…');
  try {
    const footerData    = await apiGet('blog/footerblog.html');
    const footerContent = decodeContent(footerData.content);
    const postNum       = getNextPostNum(footerContent);

    setStatus('new-status', `Creating post ${postNum}…`);
    await apiPut(`blog/${postNum}.html`, buildPostHtml(title, body), null, `Add blog post: ${title}`);

    setStatus('new-status', 'Updating archive…');
    await apiPut('blog/footerblog.html', buildNewFooter(footerContent, postNum, title),
      footerData.sha, `Update blog archive: add post ${postNum}`);

    setStatus('new-status', `Done! Post ${postNum} is live in ~30s.`, 'success');
    document.getElementById('title-input').value = '';
    document.getElementById('body-input').value  = '';
  } catch (err) {
    setStatus('new-status', 'Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Edit ---
async function onEditSelect() {
  const postNum = document.getElementById('edit-select').value;
  const form    = document.getElementById('edit-form');
  setStatus('edit-status', '', '');
  form.style.display = 'none';
  if (!postNum) return;

  setStatus('edit-status', 'Loading post…');
  try {
    const postData = await apiGet(`blog/${postNum}.html`);
    const postHtml = decodeContent(postData.content);
    const { title, body } = parsePostHtml(postHtml);
    document.getElementById('edit-title').value = title;
    document.getElementById('edit-body').value  = body;
    document.getElementById('save-btn').dataset.postNum = postNum;
    document.getElementById('save-btn').dataset.sha     = postData.sha;
    form.style.display = 'block';
    setStatus('edit-status', '', '');
  } catch (err) {
    setStatus('edit-status', 'Error loading post: ' + err.message, 'error');
  }
}

async function saveEdit() {
  const title   = document.getElementById('edit-title').value.trim();
  const body    = document.getElementById('edit-body').value.trim();
  const btn     = document.getElementById('save-btn');
  const postNum = btn.dataset.postNum;
  const sha     = btn.dataset.sha;

  if (!title) { setStatus('edit-status', 'Title is required.', 'error'); return; }
  if (!body)  { setStatus('edit-status', 'Body is required.',  'error'); return; }

  btn.disabled = true;
  setStatus('edit-status', 'Saving post…');
  try {
    // Update the post file
    const result = await apiPut(`blog/${postNum}.html`, buildPostHtml(title, body),
      sha, `Edit blog post ${postNum}: ${title}`);
    btn.dataset.sha = result.content.sha;

    // Update archive title if it changed
    setStatus('edit-status', 'Updating archive…');
    const footerData = await apiGet('blog/footerblog.html');
    const footerHtml = decodeContent(footerData.content);
    const newFooter  = updateFooterTitle(footerHtml, postNum, title);
    await apiPut('blog/footerblog.html', newFooter, footerData.sha,
      `Update archive title for post ${postNum}`);

    setStatus('edit-status', 'Saved! Changes live in ~30s.', 'success');
  } catch (err) {
    setStatus('edit-status', 'Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Delete ---
function onDeleteSelect() {
  const postNum = document.getElementById('delete-select').value;
  const confirm = document.getElementById('delete-confirm');
  setStatus('delete-status', '', '');
  confirm.style.display = postNum ? 'block' : 'none';
}

async function executeDelete() {
  const postNum = document.getElementById('delete-select').value;
  if (!postNum) return;

  const btn = document.getElementById('confirm-delete-btn');
  btn.disabled = true;
  setStatus('delete-status', 'Deleting post…');
  try {
    // Get SHA of the post file
    const postData = await apiGet(`blog/${postNum}.html`);
    await apiDelete(`blog/${postNum}.html`, postData.sha, `Delete blog post ${postNum}`);

    // Remove from archive
    setStatus('delete-status', 'Updating archive…');
    const footerData = await apiGet('blog/footerblog.html');
    const footerHtml = decodeContent(footerData.content);
    const newFooter  = removeFromFooter(footerHtml, postNum);
    await apiPut('blog/footerblog.html', newFooter, footerData.sha,
      `Remove post ${postNum} from archive`);

    setStatus('delete-status', 'Deleted! Changes live in ~30s.', 'success');
    document.getElementById('delete-confirm').style.display = 'none';
    // Reload the post list
    await loadPostList('delete-select', 'delete-status');
  } catch (err) {
    setStatus('delete-status', 'Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Wire up events ---
document.getElementById('save-token-btn').addEventListener('click', () => {
  const t = document.getElementById('token-input').value.trim();
  if (!t) { setStatus('setup-status', 'Paste your token first.', 'error'); return; }
  saveToken(t);
  showApp();
});

document.getElementById('token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('save-token-btn').click();
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

document.getElementById('publish-btn').addEventListener('click', publish);
document.getElementById('edit-select').addEventListener('change', onEditSelect);
document.getElementById('save-btn').addEventListener('click', saveEdit);
document.getElementById('delete-select').addEventListener('change', onDeleteSelect);
document.getElementById('confirm-delete-btn').addEventListener('click', executeDelete);

document.getElementById('reset-link').addEventListener('click', () => {
  clearToken();
  document.getElementById('token-input').value = '';
  showSetup();
});

// --- Init ---
getToken() ? showApp() : showSetup();
</script>

</body>
</html>
```

**Step 2: Validate HTML**

```bash
cd /home/thiag/ThiagoTVarella.github.io
python3 -c "from html.parser import HTMLParser; p=HTMLParser(); p.feed(open('admin/index.html').read()); print('HTML OK')"
```

Expected: `HTML OK`

**Step 3: Commit**

```bash
git add admin/index.html
git commit -m "feat: add Edit and Delete tabs to blog publisher PWA"
```

---

### Task 2: Push to GitHub

**Step 1: Push**

```bash
git -C /home/thiag/ThiagoTVarella.github.io push origin master
```

Report: push succeeded and commit SHA.
