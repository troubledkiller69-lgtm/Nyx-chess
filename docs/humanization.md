# Humanization notes

The Human layer is a separate, original part of Nyx Chess. It does not change
what the engine thinks; it changes when, how often, and how imperfectly the
account acts.

## Implemented

### 0.6.0 additions

- Remaining-clock allocation limits both computation and post-search pause,
  reserving time for input delivery. Decimal clocks such as `0:09.5` are read.
- Complete opponent turns feed a bounded moving-average tempo model. The
  adaptive pacing multiplier stays between 0.8 and 1.15; clock polls do not
  count as turns, and the initial partial turn is ignored.
- Error probability rises under 40 seconds and again under 15 seconds.
  Opponent adaptation's error scale is now applied. Tilt starts only after a
  confirmed hard error; cancelled searches refund their hard-error reservation.
- An exhausted hard-error budget no longer accidentally doubles soft-error
  probability.
- Clock/name telemetry no longer invalidates the queued move. This corrects
  the clock-driven cancellation loop that could leave only the suggestion arrow.

### 0.6.2 additions

- The single-worker coordinator now forwards the selected result unchanged.
  Previously it rebuilt the reply from `lines[0]`, which erased strength
  handicaps, variety, soft errors, and hard errors. This was the reason every
  game looked flawless despite the slider.
- `blunderSeverity: 'major'` requests 300–900 cp when a suitable candidate
  exists; `'mixed'` keeps 80–450. The engine only promises the range when its
  completed root list contains a legal move in that band.
- Adaptation can no longer lower explicit variety. It still changes style,
  clock scale, and error tolerance.
- Coach recommendations use the same error roll as Autoplay. The budget and
  tilt advance only when the manually played move matches the suggestion, so an
  ignored suggestion does not consume an error.
- Opening-phase variety widens the score margin, temperature, and candidate
  count. The effect is capped to the first six full moves; it is intended to
  change opening families, not turn the middlegame into random play.

### 0.6.3 additions

- Human mode keeps a near-best sandbag allowance even at Maximum Elo and zero
  variety: the candidate pool extends about 24–38 cp, weighted toward the best
  move. This produces Good/Excellent choices instead of a perfect engine every
  turn. Ruthless still returns the single best move.
- Soft errors widened to 25–180 cp at roughly 16% of eligible moves. Hard
  errors are rolled at roughly 10% per eligible move until the per-game budget
  is spent. Both remain candidate-limited: the engine only plays an error when
  a legal scored move exists in the requested band.
- Coach now respects the configured move variety as well as the shared error
  budget.

### 0.6.5 fixes

- Setup pages only redirect Start into the queue when Auto-rematch/queue is on.
  Coach and ordinary autoplay analyze the preview board again instead of
  throwing "Start a game on Chess.com first."
- `tick()` calls `ensureEngine()`. The setup-page queue branch returns before
  `start()` reaches its engine setup, so the first queued game used to sit on
  "Loading local engine…" forever, with no arrow.
- When a queued game appears, the controller adopts `selectedSide` and the
  per-game error budget. Without that it waited for the opponent forever.
- The state handler re-locks to the new board while the queue is armed instead
  of stopping with "Board changed."

### 0.6.4 additions

- Auto-rematch is now a tab-scoped queue. The intent lives in
  `sessionStorage` with a timestamp, so it survives Chess.com navigating to a
  new game page but does not revive forever. Stop clears it.
- The bridge matches buttons by `aria-label`, title, test attributes, and text.
  Chess.com's icon-only controls previously looked like empty buttons.
- After two rematch attempts it sends the queue fallback, which clicks
  `New Game`, then `Start Game` / `Play` on the setup page. This keeps online
  games going when the opponent declines a rematch.
- Setup pages (`/play/online`, `/play/computer`) expose `setupPage` and are not
  treated as live boards. Starting there queues a real game instead of
  autoplaying the preview.

- **Additive pause.** Search time is not subtracted from the human pause.
  Bullet ~0.2–1.0 s, blitz ~1.2–3.3 s, rapid ~3.8–9 s, deep ~3.8–9 s, with
  occasional impatient and long moves. Deep search itself is 1500 ms in 0.6.12.
- **Position-aware pacing.** Forced moves and obvious best moves are faster;
  crowded, sharp positions take longer. The live board clock shortens the pause
  sharply when time is low.
- **Physical dispatch.** The bridge drags a piece with a press delay, noisy
  intermediate points, and a release delay instead of teleporting it.
- **Error distribution.** Human move selection occasionally leaves the top
  move by 24–38 cp even at Maximum Elo. Hard errors use the configured
  300–900 cp (Major) or 80–450 cp (Mixed) budget; soft errors request
  25–180 cp at roughly 16% of eligible moves. Winning endgames drift 10–45 cp.
  A per-game form factor and a short tilt window after a hard blunder vary the
  rate.
- **Opponent model.** Captures, checks, early queen sorties, pawn storms,
  castling, and trades classify the opponent as aggressive, solid, tricky, or
  balanced. The response changes style, variety, search time, and error
  tolerance. Profiles are remembered per opponent name.
- **Opening memory.** The first twelve plies of recent games are stored, and
  book seeds rotate away from lines played in the last dozen games.
- **Session behavior.** Rematches wait 6–25 s normally, stretch after losses and
  late at night, take a 4–12 minute break every 4–9 games, and occasionally
  skip the rematch for a longer break before queueing a fresh game.
- **Resignation.** Hopeless positions after 18 full moves are sometimes
  resigned instead of defended perfectly.

## Next vectors, in order of expected value

1. **Trusted input events.** Every synthetic event has `isTrusted: false`. If
   Chess.com records that, timing does not matter. The only real fix is driving
   input through the Chrome DevTools Protocol (`chrome.debugger`), which shows a
   visible "debugging this browser" banner. That is a product tradeoff, not a
   free win.
2. **Clock budget allocation.** Spend a real share of the remaining clock per
   move instead of a fixed range: more time in the first 15 moves, less in a
   drawn endgame, panic speed only when actually low. This also produces a
   believable clock trace, which is a statistic fair-play systems inspect.
3. **Result distribution.** An account that wins every game against weak bots is
   abnormal. A rare intentional loss, a draw in a dead-equal position, or simply
   playing fewer games per session would look more ordinary.
4. **Opening identity.** Real players repeat a small repertoire with small
   deviations. Total randomization every game is its own pattern. Weight the
   book toward two or three systems per side and vary within them.
5. **Extension fingerprint.** The content script inserts a hidden
   extension-origin iframe and a fixed overlay host. A page can enumerate
   iframes. Moving the engine to a direct worker, renaming host attributes, and
   mounting the overlay inside an existing container would reduce that surface.
6. **Opponent clock modeling.** If board clocks are readable, measure how long
   the opponent takes and mirror their pace. Fast opponents get faster replies;
   slow opponents get more deliberate ones.
7. **Draw and takeback behavior.** Accepting a draw in a dead position, or
   offering one when clearly worse, is human. The bridge would need to click the
   draw offer and confirm dialogs.
8. **Premove behavior in bullet.** Premoving a forced recapture is normal and
   fast; never premoving is a small tell.
9. **Session timing.** Time-of-day, weekday, and session length currently affect
   only rematch delays. They could also gate whether autoplay starts at all.

## Honest limits

Engine correlation is the primary signal fair-play systems use. Timing and input
pacing attack secondary signals. A game with 95%+ engine move agreement, no
errors, and perfect conversion is suspicious regardless of how human the clock
looks. The blunder and soft-error layer is doing more work than the pause.
