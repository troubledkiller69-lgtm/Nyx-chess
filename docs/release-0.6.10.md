# Nyx Chess 0.6.10 release note

Date: 2026-11-02  
Version: **0.6.10**  
Version name: `0.6.10 coach arrows and tabs`  
Type: UI / integration release with the engine unchanged.

## Scope

This release fixes the missing Coach move arrow, makes the default advice
visible, and reduces overlay clutter. It does not change `src/engine.js`,
evaluation content, or search strength.

### Coach arrow and hints

- **Root cause of the missing arrow:** the bridge only drew the suggestion
  when `reveal === 'move'`, while the panel started Coach at the concept level.
  A fresh Coach start therefore showed the idea with zero board arrows. The
  default hint level is now `move`, so the main arrow appears immediately.
- **Hint style** is explicit: **Move arrow** (default) or **Reveal in steps**
  (optional concept → piece → move). In arrow mode the coach control is a
  single **Hide arrow** / **Show arrow** toggle.
- **Alternative suggestion** replaces the ambiguous "Second move" label. It is
  enabled only when the search exposes exact, directly comparable root scores;
  otherwise the control is disabled with a short reason. No score, rank, or
  line is invented.
- **Threat marks** are restrained to three, drawn under the recommendation,
  and only mark the threatened target square plus a dashed arrow that points at
  it. When a threat shares the same corridor as the suggested move, it is
  offset sideways so the gold arrow stays dominant. The panel uses plain
  hypothetical wording: "Opponent capture options: If Black had the turn, its
  pawn on e5 could capture the queen on d4 (exd4)." These are legal opponent
  moves if the turn passed, never a predicted reply or a guaranteed profit.
- **Human-style practice errors are preserved.** Coach still uses the same
  recommendation Autoplay would play, including the configured difficulty and
  error budget. When the result reports `blundered`, the panel says the advice
  is a practice suggestion for the configured difficulty, not Nyx's strongest
  or guaranteed move. Mistakes are intentional practice behaviour; they are not
  a claim that a platform will or will not detect automation.

### Overlay structure

The panel is split into five focused tabs while the header, readout, status and
Start/Stop footer stay visible:

| Tab | Contents |
|---|---|
| Play | Move control, playing mode, pace, side, start |
| Coach | Hint style, arrow toggle, threat marks, alternative suggestion |
| Openings | White/Black repertoire and custom lines |
| Session | Record, limits, reset, rematch queue, review |
| Engine | Depth, adaptation, variety, search budget, advanced controls |

Tabs use ARIA `tab`/`tabpanel`, roving tabindex, Left/Right/Home/End, and a
dynamic tab count. The selected tab is stored under `chrome.storage.local` key
`overlayTab` and restored on reload. Switching tabs never resets a run, a
setting, or the session record. The footer button still reads **Stop** while
running; it is not labelled Pause.

### Concrete fixes

- Boolean `select` elements for `coachThreats` and `coachSecond` now initialise
  from saved `yes`/`no` values instead of the wrong type.
- The coach SVG redraws when its layer is removed, when the board element is
  replaced, and on orientation changes and resizes.
- Changing the board clears both the gold suggestion/candidate layer and the
  rust threat layer, including the target rectangles.
- The status line moved below the scrolling section so a longer message cannot
  shift the controls under the pointer.
- Multi-worker results preserve genuine metadata (`best`, `bestMove`,
  `exactScores`, `blundered`, `blunderLoss`, `gap`, `legalMoves`, line scores)
  instead of dropping it in the merge.

`src/engine.js` SHA-256 is unchanged:
`9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830`.
No engine source was edited, rebuilt or re-minified for this release.

The advisory contract is in [the coach contract](coach-mode.md); session
tracking is in [session tracking](session-tracking.md).

## Packages

| Package | SHA-256 | Embedded engine |
|---|---|---|
| `C:\Users\howar\nyx-chess-v0.6.10-chromium.zip` | `54d2635b2d1a56666bafde5d2432090c18d6e36b76da67f00a8f52da7b10b08f` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| `C:\Users\howar\nyx-chess-v0.6.10-firefox.zip` | `27ba8ac02fe8b6feef51f934dc4dfb572d16280f211f00b0ea17a93ba8264662` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |

Both packages report `version: "0.6.10"`,
`version_name: "0.6.10 coach arrows and tabs"`, contain 20 files, and include
`src/session.js` and `src/coach.js`.

The previous packages remain in place and were not overwritten:

| Previous package | SHA-256 |
|---|---|
| `C:\Users\howar\nyx-chess-v0.6.9-chromium.zip` | `f0a8b092f18d9474e952e47a68428b7edcc067ac02c5e7f76e7f67f26134576f` |
| `C:\Users\howar\nyx-chess-v0.6.9-firefox.zip` | `85b3e519c79debe72eb337fb4fb6ffe216056cbad39b144dd1c95b4ac370d737` |

## Verification

| Check | Result |
|---|---|
| `npm run check` (syntax + manifest resources) | pass |
| Serial unit suite (`node --test --test-concurrency=1 tests/*.test.js`) | **167/167 pass** |
| Source-tree Chromium harness (`npm run test:browser`) | **94/94 pass** |
| Packaged Chromium harness (`NYX_EXTENSION_ROOT` = extracted 0.6.10 package) | **94/94 pass** |
| Firefox temporary add-on install (`npm run test:firefox`) | pass (Mozilla Firefox 159.0, `nyx-chess@local`) |
| Embedded engine hash in both packages | matches `9025cad4…` |

The Chromium harness loaded the real unpacked extension against a locally
served fake Chess.com board (no network game, account, or live move). It
covered the default Coach arrow and its optional staged mode, hide/show in one
step, the alternative gating text, restrained threat arrows and target marks,
threat on/off, stale clearing, orientation, resize, SVG self-healing, five-tab
visibility and ARIA relationships, arrow/Home/End navigation, remembered tab,
boolean selector initialisation, live panel refresh, session count/dedup/reset,
the stop-after-games limit, and review availability/start/cancel.

Screenshots:

- `docs/integration/0.6.10-coach-arrow.png` — default gold suggestion, dashed
  candidate, live panel state.
- `docs/integration/0.6.10-coach-threats.png` — offset rust capture-option arrow
  and target square beside the gold suggestion.

Raw results: `docs/integration/0.6.10-browser-results.json` and
`docs/integration/0.6.10-packaged-browser-results.json`.

## Claims and limits

- No engine match, benchmark or strength test was performed. This release makes
  no new strength claim. The measured results in `docs/release-0.6.7.md` and
  `docs/benchmarks/rating/regression-0.6.7.md` still describe the tested
  candidate `85f79c39…`, not the shipped `9025cad4…` engine.
- Coach is advisory presentation over the normal search result. It predicts no
  opponent reply and exposes no principal variation. Defended squares count
  geometric defenders; a pinned defender may be unable to recapture, so
  "hanging" is not an absolute claim.
- The alternative suggestion is only ranked when both root scores are exact and
  comparable. A disabled alternative is not a hidden ranking.
- The panel refreshes on a 650 ms timer, so a just-changed button state can lag
  by one cycle. The controller state itself updates immediately.
- Session time control and game duration are inferred from board observations,
  not server metadata. The session is per browser profile, not per Chess.com
  account.
- The Firefox check proves Firefox accepts the manifest and listed resources; it
  does not run the Chess.com harness in Firefox. Firefox runtime play still
  needs a manual smoke test.
- The test board is a local harness served for `https://www.chess.com/*`. No
  live, rated, or account move was played in this verification.
