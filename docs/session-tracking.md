# Session tracking

`src/session.js` (`globalThis.NyxSession`) turns board observations into a
session record. It is pure bookkeeping: it never reads Chess.com, chooses a
move, or changes controller behaviour by itself. The controller
(`src/content.js`) decides when to observe, record and stop.

## 1. What counts as a game

A game is recorded once, when the board reports a terminal result
(`state.result !== '*'`), using two identities:

- `game:<id>:<serial>` when the URL or bridge exposes a numeric game id.
  `serial` distinguishes a rematch that reuses the same URL.
- `ctx:<url>|<fen>|<result>|<history length>` for computer/analysis boards with
  no game id. The tuple is stable across clock ticks and orientation flips.

Repeated terminal observations with the same identity are duplicates. The
tracker keeps the last 60 identities and ignores anything older or missing.

Results are attributed only when the player's side is known:

| Board result (`state.result`) | Side known | Counted as |
|---|---|---|
| `1-0` | `w` / `b` | `win` / `loss` |
| `0-1` | `b` / `w` | `win` / `loss` |
| draw forms (`1/2-1/2`, `draw`, `stalemate`, ...) | either | `draw` |
| anything else | either | `unknown` |

Unknown results stay `unknown`; they are never guessed into a win or loss.

Modes are bucketed as `coach`, `human` or `ruthless`. Any other mode value is
recorded as `human`.

## 2. Time control

Chess.com does not expose a formal time-control field on the board object.
The tracker classifies the clock seen when the game starts:

| Opening clock | Bucket |
|---|---|
| <= 3 minutes | `bullet` |
| <= 10 minutes | `blitz` |
| <= 30 minutes | `rapid` |
| more | `classical` |
| missing / zero | `unknown` |

The clock is observed once; later clock ticks do not change the bucket.

## 3. Statistics

`summary(now, limitOverrides)` returns:

- `games`, `counts` (`win`/`draw`/`loss`/`unknown`)
- `byMode.<coach|human|ruthless>` with counts and estimated game time
- `byTime.<bullet|blitz|rapid|classical|unknown>`
- `timeMs` (sum of recorded game durations), `activeMs`, `elapsedMs`
- `streak.current` and `streak.best` for wins/losses
- `recentGames` and `limit`

Draws and unknown results reset the current streak. Active play time only
accrues while the controller is running or in one-move mode on a real board;
setup/preview pages do not count.

## 4. Session limits

Settings:

- `stopAfterGames` - 0 disables, otherwise 1..500.
- `stopAfterMinutes` - 0 disables, otherwise 1..1440 of active play.

The record, the two limits, **Reset stats**, the rematch queue and **Review last
game** live on the panel's **Session** tab. Start/Stop stays in the persistent
footer, so a limit stop is still one click away on any tab.

`limits()` reports `reached`, `reasons`, `remainingGames` and `remainingMs`.
A reached limit stops the controller (`stop('Session limit reached: ...')`) but
does not clear statistics, the queue or the current board. The limit is also
checked from `tick()` so it cannot be bypassed by a queued game. Stats remain
until **Reset stats**.

## 5. Persistence

The tracker is created with `chrome.storage.local` and stored under the
`sessionStats` key. It writes on record, on reset, and at most every 15 seconds
of active play, so closing a tab loses at most the last few seconds. The stored
shape is versioned (`v: 1`); mismatched or malformed records are ignored and a
fresh session starts. **Reset stats** is the only way to clear it explicitly.

## 6. Queue observability

Auto-rematch reports bounded state in `status().queue`:

- `armed`, `attempts`, `failures`
- at most 30 queue attempts and 5 rejected queue responses per arm
- a refused queue stops with `Queue could not start a game after 5 tries.`
- move confirmation and board changes still stop the controller as before

## 7. Coach integration

Coach mode is advisory and never moves a piece. The controller keeps the
current `NyxCoach` DTO, owns the staged reveal level
(`concept` -> `piece` -> `move`), and sends it to `src/bridge.js`, which draws
arrows/marks in a separate SVG layer. The move arrow is withheld until the
`move` level; threat marks respect `coachThreats`, and the second candidate
respects `coachSecond` and the coach module's own comparability rules.

When the FEN changes, stale guidance is cleared immediately. The previous
analysis is retained only to grade the played move through
`NyxCoach.buildGuidance(..., { previous })`; grading stays `unrated` when the
before/after searches are not comparable or the move cannot be resolved.
`docs/coach-mode.md` remains the contract for the coach module itself.

## 8. Limits of this implementation

- Game duration and time control are estimates from board observations, not
  server metadata.
- The session is per browser profile, not per Chess.com account.
- Long sessions can lose a few seconds of active time if the tab closes
  between the 15-second checkpoints.
- `recent` holds 60 identities; a game re-reported after 60 newer games could
  be counted again.
