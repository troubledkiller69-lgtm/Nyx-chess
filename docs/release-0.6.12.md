# Nyx Chess 0.6.12 release note

Date: 2026-11-02
Version: **0.6.12**
Version name: `0.6.12 faster Deep suggestions`
Type: Latency tuning for the Deep pace, with the engine unchanged.

## Scope

Deep was the only pace whose search budget was still 5000 ms. Coach deliberately
uses the configured budget without the Autoplay Human jitter, so every Deep Coach
recommendation spent the full five seconds before presentation. This release
lowers the Deep preset to **1500 ms**, keeps Rapid at 1400 ms, and leaves the
maximum-depth setting as the cap. Autoplay Human keeps its existing search-time
jitter and additive post-search pause. Deliberate errors, move variety, Coach
error handling, and the engine are unchanged.

## Cause and measurements

The delay was the configured budget, not a second hidden search or a Coach pause:

- `0.6.11` Deep preset: `timeMs: 5000`, `delayMs: 0`.
- Coach path: `thinkOptions()` returns the configured `timeMs` unchanged. It
  does not apply the Autoplay `0.7–1.25` search jitter and schedules no pause.
- Engine path: one `think()` call, iterative deepening with a wall-clock deadline.

Controlled local engine measurements on three positions (`start`, a quiet
middlegame, and a tactical middlegame), same machine and depth cap 12:

| Budget | Wall time | Engine-reported time | Completed depth |
|---|---|---|---|
| 5000 ms | 5001–5026 ms | 5001–5002 ms | 10–11 |
| 1500 ms | 1502–1505 ms | 1502 ms | 8–10 |

The overshoot in this smoke is a few milliseconds. The label therefore calls
Deep a **search budget** and says a small overrun is possible, rather than
promising an exact finish. These numbers are local smoke measurements, not a
guarantee for every position or machine.

## Migration and Custom settings

A saved Deep session from 0.6.11 is normally stored as
`pace: 'deep', timeMs: 5000, delayMs: 0`. That exact pair is the old preset and
migrates to the new Deep values on load. It is not possible to keep that pair as
an explicit Custom choice while also using the old Deep preset id, because the
0.6.11 form converted any non-preset values to `pace: 'custom'` before saving.

- `pace: 'deep', timeMs: 5000, delayMs: 0` -> Deep, 1500 ms.
- `pace: 'custom', timeMs: 5000, delayMs: 0` -> Custom, 5000 ms preserved.
- `pace: 'deep', timeMs: 4200, delayMs: 0` -> Custom, 4200 ms preserved.
- `pace: 'deep', timeMs: 5000, delayMs: 250` -> Custom, both values preserved.

Partial settings that name only `pace: 'deep'` now resolve to the preset budget
instead of inheriting the Blitz numbers. Rapid, Blitz, and Bullet are untouched.

## Behaviour contract

| Path | Search | Post-search pause | Deliberate errors |
|---|---|---|---|
| Coach + Deep + Human | 1500 ms exact budget, no jitter | none | unchanged |
| Autoplay Deep + Human | 0.7–1.25 x 1500 ms jitter | unchanged additive pause | unchanged |
| Coach + Custom 5000 ms | 5000 ms exact budget | none | unchanged |
| Ruthless | full configured budget | none | disabled |

The existing Human pause bands are unchanged. With a 1500 ms budget, Deep lands
in the 3.8–9 s band, while its search is shorter; Autoplay Deep's total remains
broadly similar rather than becoming an instant move. Coach never waits for that
pause. The maximum-depth field remains a cap, not a depth promise.

## Verification

| Check | Result |
|---|---|
| `npm test` | **171/171 pass** |
| `npm run check` | pass |
| Source-tree Chromium harness (`npm run test:browser`) | **96/96 pass** |
| Packaged Chromium harness (`NYX_EXTENSION_ROOT` = extracted 0.6.12 package) | **96/96 pass** |
| Firefox temporary add-on install (`npm run test:firefox`) | pass (Mozilla Firefox 159.0, `nyx-chess@local`) |
| `src/engine.js` SHA-256 | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` (unchanged) |

The Chromium harness's Deep Coach smoke measured 948 ms wall / 764 ms engine in
the source tree and 808 ms wall / 763 ms engine from the packaged extension, at
the configured depth cap 12 on a warm worker table. It stayed inside the 1500 ms
budget. A deeper or time-bound position uses more of the budget; the direct
engine runs above show 1502–1505 ms when the cap does not finish first.

The new tests cover the 1500 ms default Deep options, the legacy Deep migration,
explicit Custom preservation, Deep above Rapid, the UI budget label, controller
propagation to the worker, the exact Coach budget without jitter, unchanged
Autoplay jitter, and the existing Coach deliberate-error path.

## Packages

| Package | SHA-256 | Embedded engine |
|---|---|---|
| `C:\Users\howar\nyx-chess-v0.6.12-chromium.zip` | `7df92ca8fffeedcd2a82dc352bc37e15890f1792bccc74aa82bdaa0f1d8f59d0` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| `C:\Users\howar\nyx-chess-v0.6.12-firefox.zip` | `520e7a624c13b2d8e4c0298527bc058077ec917cff692ca341a97988d6322a18` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |

Both packages report `version: "0.6.12"` and
`version_name: "0.6.12 faster Deep suggestions"`, contain 20 files, and preserve
the older packages.

Raw results: `docs/integration/0.6.12-browser-results.json` and
`docs/integration/0.6.12-packaged-browser-results.json`. Screenshots:
`docs/integration/0.6.12-review-panel.png`,
`docs/integration/0.6.12-coach-arrow.png`,
`docs/integration/0.6.12-coach-threats.png`, and the packaged equivalents.

## Claims and limits

- No engine match, evaluation benchmark, or strength benchmark was run. This
  release makes **no strength claim** and does not claim the 1500 ms search is
  as strong as the old 5000 ms search. It reaches a lower completed depth in the
  smoke positions above.
- Coach latency is the budget plus a small overrun while the current iteration
  finishes. A very slow machine or a loaded browser can exceed the smoke values.
- Custom still allows the old 5000 ms budget; only the Deep preset changed.
