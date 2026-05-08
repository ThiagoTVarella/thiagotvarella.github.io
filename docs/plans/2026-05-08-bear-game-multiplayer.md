# Bear Game Online Multiplayer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Firebase Firestore-backed online multiplayer to `bear.html`, gated behind a `?room=...` URL param so the existing local pass-the-phone mode is untouched.

**Architecture:** Single-file change to `bear.html`. Firebase Web SDK loaded via ESM `<script type="module">` from gstatic CDN — no build step. State sync via `setDoc` + `onSnapshot` on a single Firestore document per room (`rooms/{ABCD}`). Whole-state-blob writes per move; no diffing. Trust-the-clients model — no server validation.

**Tech Stack:** Vanilla JS, Firebase JS SDK 12.13.0 (modular, ESM from `gstatic`), Firestore.

**Reference design:** `docs/plans/2026-05-07-bear-game-multiplayer-design.md`

**Project config (already done):**
- Firebase project: `bear-game-28539`
- Firestore (default), Standard edition, region picked
- Open security rules published
- `firebaseConfig` available (see Task 2)

---

## Testing approach

This codebase has **no automated test framework** — `bear.html` is a single static HTML file. So instead of TDD, each task ends with a **manual browser verification step** with a precise expected result. The verification step is non-negotiable: do not move to the next task until the current one's verification passes.

For tasks that need two players, open the page in **two browser windows** (one regular, one incognito to avoid shared state). The host window will be `bear.html?room=ABCD&host=1`; the guest window will be `bear.html?room=ABCD`.

Use `python3 -m http.server 8000` from the repo root to serve locally; navigate to `http://localhost:8000/bear.html`.

---

### Task 1: Refactor board generation to be deterministic from state

Currently `createBoard()` mutates the DOM AND randomly generates honeypot counts inline. We need to split: (a) generate a state object, (b) render the DOM from a state object. This is the foundation for sync.

**Files:**
- Modify: `bear.html` (script block, around lines 105-147)

**Step 1: Add `generateInitialState()` helper**

Add this function near the top of the script block (right after the `let bridgesBuilt = 0;` line):

```js
function generateInitialState() {
    const cells = [];
    const totalRows = 9;
    const hexPerRow = 8;
    for (let row = 0; row < totalRows; row++) {
        for (let col = 0; col < hexPerRow; col++) {
            const honeypot = Math.floor(Math.random() * 6) + 1;
            let content;
            if (honeypot > 5)      content = '🍯🍯🍯';
            else if (honeypot > 2) content = '🍯🍯';
            else                   content = '🍯';
            cells.push({ row, col, content, removed: false, rebuilt: false });
        }
    }
    return {
        currentPlayer: 1,
        placementPhase: true,
        scores: [0, 0],
        bridgeCost: 3,
        bridgesBuilt: 0,
        cells,
    };
}
```

**Step 2: Add `renderBoard(state)` that builds DOM from state**

Add right after `generateInitialState`:

```js
function renderBoard(state) {
    const boardEl = document.getElementById('game-board');
    boardEl.innerHTML = '';
    const totalRows = 9;
    const hexPerRow = 8;
    for (let row = 0; row < totalRows; row++) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'row';
        if (row % 2 !== 0) rowDiv.classList.add('row-even');
        if (row % 2 !== 1) rowDiv.classList.add('row-odd');
        for (let col = 0; col < hexPerRow; col++) {
            const cell = state.cells.find(c => c.row === row && c.col === col);
            const hex = document.createElement('div');
            hex.className = 'hex';
            hex.dataset.index1 = row;
            hex.dataset.index2 = col;
            hex.textContent = cell.content;
            if (cell.removed) hex.classList.add('removed');
            if (cell.rebuilt) hex.classList.add('rebuilt');
            hex.addEventListener('click', handleHexClick);
            rowDiv.appendChild(hex);
        }
        boardEl.appendChild(rowDiv);
    }
}
```

**Step 3: Replace `createBoard()` with a thin wrapper**

Find the existing `function createBoard() { ... }` (lines ~105-147) and replace its body with:

```js
function createBoard() {
    renderBoard(generateInitialState());
}
```

(Keep the function name so the existing call at the bottom of the script still works.)

**Step 4: Manual verification**

1. Run `python3 -m http.server 8000` from repo root.
2. Open `http://localhost:8000/bear.html` in a browser.
3. Verify: 9×8 hex board appears with random 1–3 honeypots per cell.
4. Click a few cells in placement phase — bears appear, switching between 🐻1 and 🐻2.
5. Place all 6 bears, then move one — verify movement still works exactly as before.
6. Build a bridge — verify bridge logic still works.

If anything is broken, this is a regression — fix before continuing.

**Step 5: Commit**

```bash
git add bear.html
git commit -m "refactor(bear): split board generation into state + render"
```

---

### Task 2: Add Firebase init and mode detection (online mode disabled, no behavior change yet)

Wire up Firebase imports and read URL params. Don't subscribe or write yet — just confirm the SDK loads without breaking the page.

**Files:**
- Modify: `bear.html` (the existing `<script>` tag — change to `<script type="module">`, add imports)

**Step 1: Convert the script tag to a module and add imports**

Find the line `<script>` (line 90) and replace it with:

```html
<script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
    import {
        getFirestore, doc, setDoc, onSnapshot, Timestamp
    } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

    const firebaseConfig = {
        apiKey: "AIzaSyBhBsAT0IVyI0ME2Uy7-LpDI5OBfgC6TPI",
        authDomain: "bear-game-28539.firebaseapp.com",
        projectId: "bear-game-28539",
        storageBucket: "bear-game-28539.firebasestorage.app",
        messagingSenderId: "859169043790",
        appId: "1:859169043790:web:377569c1793fc88303da1f"
    };

    const params   = new URLSearchParams(location.search);
    const roomId   = params.get('room');
    const isHost   = params.get('host') === '1';
    const isOnline = !!roomId;
    const myPlayer = isHost ? 1 : 2;

    let app, db;
    if (isOnline) {
        app = initializeApp(firebaseConfig);
        db  = getFirestore(app);
    }
```

**Step 2: Move `onclick` handlers from inline HTML to `window.*` assignments**

Module scripts don't expose top-level functions to inline `onclick=`. We need to attach `buildBridge` and `skipTurn` to `window`. Find these lines at the very bottom of the script (right before `</script>`):

```js
createBoard();
updateStatus();
```

Replace with:

```js
window.buildBridge = buildBridge;
window.skipTurn    = skipTurn;
createBoard();
updateStatus();
```

**Step 3: Manual verification**

1. Hard-reload `http://localhost:8000/bear.html` (Ctrl+Shift+R) — no `?room=` param.
2. Open DevTools console. Verify there are no errors about Firebase, imports, or undefined functions.
3. Verify the local game still works end-to-end (place bears, move, build bridge, skip turn).
4. Visit `http://localhost:8000/bear.html?room=TEST` — page should still render the local board (no online logic wired yet) and console should show no errors. Confirm in DevTools that `app` and `db` got initialized (you can `console.log(db)` temporarily if you want; remove before committing).

**Step 4: Commit**

```bash
git add bear.html
git commit -m "feat(bear): import Firebase SDK and detect online mode"
```

---

### Task 3: Add "Create online game" button and host-side room creation

Adds the entry point. When clicked: generate a 4-letter code, write the initial state to Firestore, redirect to host URL.

**Files:**
- Modify: `bear.html` (HTML body and script)

**Step 1: Add the button to the HTML**

Find the line:

```html
<button id="skip-turn" onclick="skipTurn()">Skip Turn</button>
```

After it, add (still inside `#game-container`, before the `<p>` tag):

```html
<div id="online-create" style="margin-top: 12px;">
    <button id="create-online-btn">Create online game</button>
</div>
<div id="online-share" style="margin-top: 12px; display: none;">
    Share this link with your opponent:<br>
    <a id="share-link" href="#"></a>
</div>
```

**Step 2: Add the create-room logic in the script**

Add this block right after the `let app, db;` block from Task 2 (still at the top of the module):

```js
function generateRoomCode() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * 26)];
    return code;
}

async function createOnlineGame() {
    const code = generateRoomCode();
    const tempApp = initializeApp(firebaseConfig, 'creator');
    const tempDb  = getFirestore(tempApp);
    const initialState = generateInitialState();
    const expiresAt = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
    await setDoc(doc(tempDb, 'rooms', code), {
        createdAt: expiresAt,
        hostJoined: true,
        guestJoined: false,
        state: initialState,
    });
    location.href = `bear.html?room=${code}&host=1`;
}
```

**Step 3: Wire up the button and show/hide UI based on mode**

Add at the bottom of the module, just before the `createBoard(); updateStatus();` lines:

```js
document.getElementById('create-online-btn').addEventListener('click', createOnlineGame);

if (isOnline) {
    document.getElementById('online-create').style.display = 'none';
    if (isHost) {
        const shareUrl = `${location.origin}${location.pathname}?room=${roomId}`;
        const shareEl = document.getElementById('online-share');
        const linkEl  = document.getElementById('share-link');
        linkEl.href = shareUrl;
        linkEl.textContent = shareUrl;
        shareEl.style.display = 'block';
    }
}
```

Note: `generateInitialState` and `Timestamp` are referenced before the `function generateInitialState()` declaration in the file. Function declarations are hoisted in module scope, so the order in source doesn't matter — but `Timestamp` is an import, also fine.

**Step 4: Manual verification**

1. Reload `http://localhost:8000/bear.html` — the "Create online game" button is visible.
2. Click it. The URL changes to `bear.html?room=XXXX&host=1` and the page reloads.
3. On the new page: the "Create online game" button is gone, and a "Share this link" panel shows a URL like `http://localhost:8000/bear.html?room=XXXX`.
4. Open Firebase console → Firestore Database → Data tab → `rooms` collection. Verify a doc with the 4-letter code exists, with `createdAt`, `hostJoined: true`, `guestJoined: false`, and a `state` object containing 72 cells.
5. Open the share URL in an incognito window — page renders the local board (sync not wired yet, that's Task 4). No console errors.

**Step 5: Commit**

```bash
git add bear.html
git commit -m "feat(bear): add create online game button and room creation"
```

---

### Task 4: Subscribe to room state and render incoming snapshots

The host already wrote initial state in Task 3. The guest currently calls `createBoard()` which generates a *new* random board — wrong. Both clients need to render from Firestore snapshots.

**Files:**
- Modify: `bear.html` (script)

**Step 1: Add `applyState(state)` that overwrites local globals + re-renders**

Add near the other helpers (right after `renderBoard`):

```js
function applyState(state) {
    currentPlayer  = state.currentPlayer;
    placementPhase = state.placementPhase;
    scores         = state.scores.slice();
    bridgeCost     = state.bridgeCost;
    bridgesBuilt   = state.bridgesBuilt;
    bears1 = [];
    bears2 = [];
    for (const cell of state.cells) {
        if (cell.content.includes('🐻')) {
            bears1.push(String(cell.row));
            bears2.push(String(cell.col));
        }
    }
    renderBoard(state);
    bridgeCostSpan.textContent = bridgeCost;
    updateStatus();
}
```

**Step 2: Add `subscribeToRoom()` that listens for changes**

Add right after `applyState`:

```js
function subscribeToRoom() {
    onSnapshot(doc(db, 'rooms', roomId), (snap) => {
        if (!snap.exists()) {
            status.textContent = 'Game not found. The link may be expired.';
            return;
        }
        const data = snap.data();
        applyState(data.state);
    });
}
```

**Step 3: Replace the bottom of the module to branch on online vs local**

Find the existing tail:

```js
document.getElementById('create-online-btn').addEventListener('click', createOnlineGame);

if (isOnline) {
    // ...show/hide UI...
}

window.buildBridge = buildBridge;
window.skipTurn    = skipTurn;
createBoard();
updateStatus();
```

Replace with:

```js
document.getElementById('create-online-btn').addEventListener('click', createOnlineGame);

window.buildBridge = buildBridge;
window.skipTurn    = skipTurn;

if (isOnline) {
    document.getElementById('online-create').style.display = 'none';
    if (isHost) {
        const shareUrl = `${location.origin}${location.pathname}?room=${roomId}`;
        const shareEl = document.getElementById('online-share');
        const linkEl  = document.getElementById('share-link');
        linkEl.href = shareUrl;
        linkEl.textContent = shareUrl;
        shareEl.style.display = 'block';
    }
    if (!isHost) {
        await setDoc(doc(db, 'rooms', roomId), { guestJoined: true }, { merge: true });
    }
    subscribeToRoom();
} else {
    createBoard();
    updateStatus();
}
```

Note: top-level `await` works in module scripts.

**Step 4: Manual verification**

1. Reload `http://localhost:8000/bear.html` (no `?room=`) — local mode still works as before.
2. Click "Create online game" → host page loads with share link.
3. Copy the share link, paste into an incognito window.
4. Verify: **both windows show the SAME random honeypot layout** (this is the key test — proves the guest is rendering from Firestore, not generating its own).
5. Open Firebase console → confirm `guestJoined: true` flipped to true on the room doc.
6. In the host window, place a bear (Player 1's first placement). Wait 1 second. Verify the **guest window updates automatically** to show the bear and that it's now Player 2's turn.
7. Console shows no errors in either window.

**Step 5: Commit**

```bash
git add bear.html
git commit -m "feat(bear): subscribe to room state and render snapshots"
```

---

### Task 5: Push state on every move + add turn guard

Right now only the host can drive state forward (because we only push on creation). Hook `pushState()` into all four mutation points and prevent the offline player from clicking.

**Files:**
- Modify: `bear.html` (script)

**Step 1: Add `pushState()` helper**

Add right after `subscribeToRoom`:

```js
function pushState() {
    if (!isOnline) return;
    const cells = [];
    const hexes = document.querySelectorAll('#game-board .hex');
    hexes.forEach(hex => {
        cells.push({
            row: Number(hex.dataset.index1),
            col: Number(hex.dataset.index2),
            content: hex.textContent,
            removed: hex.classList.contains('removed'),
            rebuilt: hex.classList.contains('rebuilt'),
        });
    });
    const state = {
        currentPlayer, placementPhase,
        scores: scores.slice(),
        bridgeCost, bridgesBuilt,
        cells,
    };
    setDoc(doc(db, 'rooms', roomId), { state }, { merge: true });
}
```

**Step 2: Add turn guard at the top of `handleHexClick`**

Find `function handleHexClick(event) {` (around line 149). Right after the opening brace, before `const hex = event.target;`, add:

```js
if (isOnline && currentPlayer !== myPlayer) return;
```

**Step 3: Call `pushState()` after each mutation**

Four call sites. Add `pushState();` as the **last line** of each function body:

- `placebear` — after the `if (bears1.length === 6) { ... }` block.
- `movebear` — after `checkGameOver();`.
- `restoreHex` — after `updateStatus();`.
- `skipTurn` — after the `status.textContent = ...` line at the end.

Example for `movebear`:

```js
function movebear(from, to) {
    // ... existing body ...
    if (isPathValid(from,to) && !to.textContent.includes('🐻')) {
        // ... existing logic ...
        switchPlayer();
        checkGameOver();
        pushState();   // <-- ADD THIS
    } else {
        // ... existing else branch unchanged ...
    }
}
```

(Only add `pushState()` on the success path inside `movebear`. The else branch doesn't change state.)

**Step 4: Guard `applyState` from clobbering an in-progress move**

Currently, when YOU make a move, you write to Firestore, then your own `onSnapshot` fires and `applyState` rebuilds your DOM from the same state you just wrote — harmless but it would clear `selectedHex`. To prevent flicker, change `applyState` to also reset `selectedHex`:

In `applyState`, add at the very end:

```js
selectedHex = null;
```

**Step 5: Manual verification — full two-player flow**

1. Hard-reload to clear caches. Run from a fresh state.
2. Window A (regular): open `bear.html`, click "Create online game" → becomes the host.
3. Window B (incognito): paste the share URL.
4. Both windows show the same board. Window A status says "Player 1, place your bear". Window B too (same state).
5. **Window B clicks a hex** — nothing happens (turn guard works; not Player 1's window... wait: B is Player 2, current is 1, so B's clicks should be blocked). ✓
6. **Window A clicks a hex** — bear 🐻1 appears. Within ~1s, Window B updates to show the same bear. Now turn is Player 2.
7. **Window A clicks another hex** — nothing (turn guard, A is Player 1, current is 2). ✓
8. **Window B clicks a hex** — bear 🐻2 appears, both windows update.
9. Place all 6 bears alternating. Move a bear. Build a bridge (need 3 honeypots first). Skip a turn. Verify each action propagates within ~1s to the other window.
10. Reload Window A mid-game. Verify: window re-subscribes, board state is restored from Firestore exactly as it was.
11. Reload Window B. Same — state restored.
12. Open `bear.html` with NO `?room=` — local mode still works exactly as before (this is the regression check).

**Step 6: Commit**

```bash
git add bear.html
git commit -m "feat(bear): sync moves to Firestore with turn guard"
```

---

### Task 6: Configure Firestore TTL for room cleanup

Now that the doc is being written with an `expiresAt`-style timestamp in the `createdAt` field (Task 3 already does this), set up the actual TTL policy in the Firebase console.

**Files:** none (console-only)

**Step 1: Open Firestore TTL settings**

In Firebase console → Databases & Storage → Firestore → the `(default)` database. Look for a **Time-to-live (TTL)** tab in the top tab bar. If it's missing in the UI:
- Try Google Cloud console: https://console.cloud.google.com/firestore/databases/-default-/ttl?project=bear-game-28539

**Step 2: Create the TTL policy**

- Collection group: `rooms`
- Timestamp field: `createdAt`
- Click **Create**.

It may take up to 24h to fully activate. Documents are deleted when their `createdAt` value is in the past — since we wrote `Timestamp.fromMillis(Date.now() + 24h)`, docs auto-delete ~24h after creation.

**Step 3: Verification**

- TTL policy shows up as **Active** (or **Building** initially) in the console.
- Existing room docs are not deleted immediately (their `createdAt` is in the future).
- No code change needed.

**Step 4: Commit**

Nothing to commit (console config only). Optionally add a one-line note to the design doc if you want a paper trail.

---

### Task 7: Final polish and edge cases

**Files:**
- Modify: `bear.html`

**Step 1: Add a "copy link" affordance**

Replace the share-link rendering in the `if (isHost)` block with a copy button:

```js
const shareUrl = `${location.origin}${location.pathname}?room=${roomId}`;
const shareEl  = document.getElementById('online-share');
const linkEl   = document.getElementById('share-link');
linkEl.href = shareUrl;
linkEl.textContent = shareUrl;
linkEl.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        await navigator.clipboard.writeText(shareUrl);
        linkEl.textContent = 'Copied! Now paste it to your opponent.';
        setTimeout(() => { linkEl.textContent = shareUrl; }, 2500);
    } catch {
        // fall back to default link behavior
        window.open(shareUrl, '_blank');
    }
});
shareEl.style.display = 'block';
```

**Step 2: Show "waiting for opponent" hint to the host until guest joins**

In `subscribeToRoom`, change the snapshot handler:

```js
onSnapshot(doc(db, 'rooms', roomId), (snap) => {
    if (!snap.exists()) {
        status.textContent = 'Game not found. The link may be expired.';
        return;
    }
    const data = snap.data();
    applyState(data.state);
    if (isHost && !data.guestJoined) {
        status.textContent = 'Waiting for opponent to join…';
    }
});
```

**Step 3: Manual verification**

1. Create an online game. Status shows "Waiting for opponent to join…".
2. Click the share-link → it copies to clipboard and shows "Copied!" briefly.
3. Open the URL in another window. Within 1s, host status updates to normal "Player 1, place your bear".
4. Play a full game start to finish — no regressions vs Task 5.

**Step 4: Commit**

```bash
git add bear.html
git commit -m "feat(bear): copy-to-clipboard share link and waiting state"
```

---

## After all tasks

- Push to `master`. GitHub Pages will redeploy in ~1 minute.
- Test on real phones over the public URL. If anything misbehaves on cellular networks (the trickiest case), check DevTools → Network for blocked requests to `firestore.googleapis.com` or `gstatic.com`.

## Out of scope (do NOT implement in this plan)

- Firebase Anonymous Auth.
- Cloud Functions / server-side validation.
- Rematch button, spectator mode, chat, presence indicators.
- Move history or replay.

If you find yourself adding any of the above, stop and ask first.
