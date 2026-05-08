# Bear Game — Online Multiplayer Design

**Date:** 2026-05-07
**File affected:** `bear.html`
**Backend:** Firebase Firestore (Spark / free tier)

## Goal

Let two phones play `bear.html` against each other over the internet, while keeping the page hosted on GitHub Pages and preserving the existing local pass-the-phone mode.

## Decisions

| Topic | Decision |
| --- | --- |
| Pairing | Shareable URL: `bear.html?room=ABCD` |
| Player assignment | Host (creator) is 🐻1, joiner is 🐻2 |
| Trust model | Trust the clients — each browser validates and writes state. No server-side validation. (YAGNI; casual game between friends.) |
| Disconnect handling | Reload the URL to rejoin current state. No presence indicators. Rooms auto-expire after 24h via Firestore TTL. |
| Mode split | URL-driven. No `?room=` → existing local 2-player mode, untouched. With `?room=` → online mode. One new "Create online game" button on the local screen. |
| Cheat resistance | Not a goal. Open Firestore rules; security comes from random 4-letter room codes (456,976 combos) plus 24h TTL. |

## Architecture

### Firestore schema

Single collection, `rooms`. One document per game, keyed by 4-letter code:

```
rooms/{ABCD}
  createdAt:    timestamp   // used by TTL
  hostJoined:   bool
  guestJoined:  bool
  state: {
    currentPlayer:  1 | 2
    placementPhase: bool
    scores:         [number, number]
    bridgeCost:     number
    bridgesBuilt:   number
    board: [
      { row, col, content, removed, rebuilt }, ...
    ]
  }
```

The whole `state` object is overwritten on every move. The doc is small (~72 cells × tiny fields), well under Firestore's 1 MiB limit, and overwriting avoids diff/merge complexity.

### Hosting

- Firebase Web SDK loaded as ESM module from `gstatic` CDN — no build step, no `npm`.
- `firebaseConfig` pasted directly into `bear.html`. Safe to commit publicly (it identifies the project, not the user; Firestore rules govern access).
- The HTML continues to be served by GitHub Pages with no other changes.

### TTL

- Firestore TTL policy on `rooms` collection, field `createdAt`.
- Client writes `createdAt = Timestamp.fromDate(now + 24h)` so TTL deletes the doc ~24h after creation.
- (TTL tab may be created later; not required for first run.)

## Code changes (high level)

All new code lives at the top and bottom of the existing `<script>` block in `bear.html`. No existing function is rewritten — only minimally wrapped.

1. **Mode detection** (top of script):
   ```js
   const params  = new URLSearchParams(location.search);
   const roomId  = params.get('room');
   const isHost  = params.get('host') === '1';
   const isOnline = !!roomId;
   const myPlayer = isHost ? 1 : 2;
   ```

2. **Firebase init** (only when `isOnline`):
   - `import { initializeApp }` from `firebase-app.js`
   - `import { getFirestore, doc, setDoc, onSnapshot, serverTimestamp, Timestamp }` from `firebase-firestore.js`

3. **"Create online game" button** (visible only when `!isOnline`):
   - Generate a 4-letter A–Z code.
   - Generate the random board state (same logic currently in `createBoard`).
   - Write initial doc: `{ createdAt: now+24h, hostJoined: true, guestJoined: false, state: <initial> }`.
   - `location.href = "bear.html?room=ABCD&host=1"`.
   - On the host page, show "Share this link with your opponent: `bear.html?room=ABCD`".

4. **Sync layer** (~40 lines):
   - `subscribeToRoom()` — `onSnapshot(doc(db, 'rooms', roomId), snap => { ... })`. On each snapshot, if `state.currentPlayer !== myPlayer`, call `renderState(snap.data().state)`.
   - `pushState()` — serialize the current DOM/board into the state shape and `setDoc(..., { merge: true })`.
   - `renderState(state)` — rebuild board cells from the state object: clear all hexes, then walk `state.board` and apply text/removed/rebuilt classes; restore scores, currentPlayer, placementPhase, bridgeCost.

5. **Turn guard** at the top of `handleHexClick`:
   ```js
   if (isOnline && currentPlayer !== myPlayer) return;
   ```
   Cleanest single-line gate; prevents the offline player from interacting on their opponent's turn.

6. **Push hooks** — call `pushState()` at the end of:
   - `placebear` (after `switchPlayer`)
   - `movebear` (after `switchPlayer` / `checkGameOver`)
   - `restoreHex` (after `switchPlayer`)
   - `skipTurn` (after `switchPlayer`)

7. **Initial load for guest:** when `isOnline && !isHost`, do *not* call `createBoard()` with random honeypots. Instead, render an empty placeholder, then let the first `onSnapshot` from Firestore populate the board via `renderState`. This guarantees both phones see the same initial honeypot layout.

## Data flow per move

1. Local player clicks a hex.
2. `handleHexClick` passes the turn-guard, calls existing logic (`placebear` / `movebear` / etc.).
3. Local DOM and JS state mutate as today.
4. After `switchPlayer()`, `pushState()` writes the new `state` to Firestore.
5. Remote phone's `onSnapshot` fires, `renderState` rebuilds the board from incoming state.
6. Remote player's turn-guard now allows clicks; loop continues.

## Error handling

- **Lost connection mid-move:** the `setDoc` promise rejects → log and show a small "Reconnecting…" status; Firestore SDK auto-retries. No custom retry logic.
- **Room not found** (typo'd code): `onSnapshot` fires with `!snap.exists()` → show "Game not found" and offer a "Create a new game" link.
- **Reload during game:** page re-subscribes to the same `roomId`, first snapshot rehydrates state. No special code needed.
- **Both clients writing simultaneously:** can't happen in normal play (turn-guard prevents it). If it ever does, last-write-wins is acceptable.

## Testing

Manual only — no automated tests for this game today.

1. Two browser windows on the same machine: create a room in one, join via URL in the other, play through placement + a few moves + a bridge build + skip turn.
2. Two physical phones on different networks (cellular vs wifi): same flow.
3. Reload mid-game on both host and guest, verify state restores.
4. Verify local mode (open `bear.html` with no `?room=`) still works exactly as before.

## Out of scope (intentionally deferred)

- Anonymous Firebase Auth / per-room authorization.
- Server-authoritative move validation (Cloud Functions).
- Presence / "opponent disconnected" indicators.
- Spectator mode, chat, rematch button.
- Move history / replay.

These are easy to add later if the game gets real use.

## Project config (already done by user)

- Firebase project created: `bear-game-28539`.
- Firestore database created in Standard edition, `(default)` ID.
- Open security rules published:
  ```
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /rooms/{roomId} {
        allow read, write: if true;
      }
    }
  }
  ```
- Web app registered, `firebaseConfig` provided to be embedded in `bear.html`.
- TTL policy: to be added after first successful test (not blocking).
