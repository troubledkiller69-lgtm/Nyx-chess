# Nyx Chess 0.6.11 release note

Date: 2026-11-02
Version: **0.6.11**
Version name: `0.6.11 coach timing fix`
Type: Coach timing / UI delivery release with the engine unchanged.

## Scope

This release makes a Coach recommendation appear as soon as the engine result
arrives when **Move control = Coach** and **Playing mode = Human**. It does not
shorten the configured search, switch the mode to Ruthless, disable move
variety, or remove deliberate errors. `src/engine.js` is unchanged.

## What was actually delaying the display

The controller already returned from the Coach branch before the Autoplay-only
`humanPause()` call, and Coach already bypassed the Human search-time jitter.
That was true in the shipped 0.6.7, 0.6.8, 0.6.9, and 0.6.10 sources. A new
regression test now pins that invariant so a future edit cannot reintroduce the
pause.

The remaining artificial wait was in delivery: the floating panel refreshed its
status only on a 650 ms interval. A result could therefore sit in controller
memory for up to 650 ms before the recommendation text changed. This release
removes that wait.

## Concrete changes

- **Immediate panel refresh.** The controller posts a `status-changed` message
  after rebuilding Coach guidance from an engine result. An open panel consumes
  it and renders the current status at once. The 650 ms poll remains as the
  fallback for clocks, review progress, and other slow state.
- **Pause state is explicitly cleared on the Coach path.** `nextMoveAt` is set
  to zero and any pending move timer is cleared before returning, so a Coach
  result cannot inherit an Autoplay countdown or queued move delay.
- **Play-tab hint corrected.** It now says the Human post-search pause applies
  to Autoplay and that Coach shows the result at once. It no longer implies a
  timing pause in Coach.
- **No search shortcut.** Coach still sends the configured `timeMs`, keeps
  `mode: 'human'`, keeps the configured Elo/style/variety, and keeps the same
  hard/soft error roll and per-game budget as Autoplay. Engine computation time
  remains necessary.

## Behaviour contract

| Path | Search | Post-search pause | Deliberate errors |
|---|---|---|---|
| Coach + Human | configured budget, no jitter | none | unchanged roll and budget |
| Autoplay + Human | jittered budget | unchanged additive pause | unchanged roll and budget |
| Ruthless | parallel/full budget | none | disabled |

Coach never touches the board. The recommendation is still the move Autoplay
would play for the same settings. A hard-error reservation is spent only when
the player follows the suggestion; ignoring it costs nothing.

## Verification

| Check | Result |
|---|---|
| `npm test` (168 tests) | pass |
| `npm run check` (syntax + manifest resources) | pass |
| Source-tree Chromium harness (`npm run test:browser`) | **94/94 pass** |
| Packaged Chromium harness (`NYX_EXTENSION_ROOT` = extracted 0.6.11 package) | **94/94 pass** |
| Firefox temporary add-on install (`npm run test:firefox`) | pass (Mozilla Firefox 159.0, `nyx-chess@local`) |
| `src/engine.js` SHA-256 | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` (unchanged) |

The new controller test forces a fullmove-6 position with `Math.random = 0.01`,
asserts the Coach search keeps `timeMs: 1400`, `mode: 'human'`, `variety: 40`,
`elo: 'max'`, a hard blunder (`blunderMin: 300`) and its `pendingBlunder`
budget, then checks that the result is in `coaching` immediately, schedules no
timer, emits the panel refresh, and never posts a move. A second harness with
`Math.random = 0.5` proves Autoplay Human still schedules its post-search pause
before posting a move.

The Chromium harness uses a locally served fake Chess.com board; no network
game, account, or live move is touched.

## Packages

| Package | SHA-256 | Embedded engine |
|---|---|---|
| `C:\Users\howar\nyx-chess-v0.6.11-chromium.zip` | `90eff35372ff0e082c874f214cd0101e7b27f0eb2ecaf03bb1ed0460db244439` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| `C:\Users\howar\nyx-chess-v0.6.11-firefox.zip` | `6747e578a6a900b392b4d356dbac09cb136c491b436f8852ba94c7ef3a312d6b` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |

Both packages report `version: "0.6.11"` and
`version_name: "0.6.11 coach timing fix"`, contain 20 files, and preserve the
previous 0.6.10 packages.

Raw results: `docs/integration/0.6.11-browser-results.json` and
`docs/integration/0.6.11-packaged-browser-results.json`. Screenshots:
`docs/integration/0.6.11-coach-arrow.png`,
`docs/integration/0.6.11-coach-threats.png`, and
`docs/integration/0.6.11-review-panel.png`.

## Claims and limits

- No engine match, benchmark, or strength test was performed. This release makes
  no strength claim.
- The immediate refresh applies to an open floating panel. The popup still reads
  status on demand. If the panel is closed, opening it renders the current
  status immediately.
- Coach search time is still user-configured. A Deep budget can take seconds;
  that is computation, not a simulated Human pause.
