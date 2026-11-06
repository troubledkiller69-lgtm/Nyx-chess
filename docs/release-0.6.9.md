# Nyx Chess 0.6.9 release note

Date: 2026-11-02  
Version: **0.6.9**  
Version name: `0.6.9 coach and session tracking`  
Type: UI / integration release with the engine unchanged.

## Scope

This release adds the advisory Coach presentation and per-profile session
tracking, and makes the auto-rematch queue observable. It does not change
`src/engine.js`, evaluation content, or search strength.

- Coach mode stages help as **concept → piece → move**. The concept level draws
  no move arrow; the gold arrow appears only at the move level. Threat marks are
  gated by the **Threat marks** setting, the optional second candidate appears
  only when the coach module's comparability rules allow it, and stale guidance
  clears on the next position. Coach never moves, resigns or rematches.
- Session tracking counts completed games once, with win/draw/loss/unknown,
  per-mode (Coach/Human/Ruthless) and opening-clock buckets (bullet/blitz/
  rapid/classical/unknown), win/loss streaks and active play time. It persists
  under `chrome.storage.local` key `sessionStats` and clears only through
  **Reset stats**.
- **Stop after games/minutes** stops the controller at the configured limit
  while keeping the statistics visible.
- Auto-rematch reports `armed`, `attempts` and `failures`; attempts are bounded
  at 30 and rejected queue responses at 5.
- `src/engine.js` SHA-256 is unchanged:
  `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830`.
  No engine source was edited, rebuilt or re-minified for this release.

Contracts and limits are in [the coach contract](coach-mode.md) and
[session tracking](session-tracking.md).

## Packages

| Package | SHA-256 | Embedded engine |
|---|---|---|
| `C:\Users\howar\nyx-chess-v0.6.9-chromium.zip` | `f0a8b092f18d9474e952e47a68428b7edcc067ac02c5e7f76e7f67f26134576f` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| `C:\Users\howar\nyx-chess-v0.6.9-firefox.zip` | `85b3e519c79debe72eb337fb4fb6ffe216056cbad39b144dd1c95b4ac370d737` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |

Both packages report `version: "0.6.9"`,
`version_name: "0.6.9 coach and session tracking"`, contain 20 entries, and
include `src/session.js` and `src/coach.js`.

The previous packages remain in place and were not overwritten:

| Previous package | SHA-256 |
|---|---|
| `C:\Users\howar\nyx-chess-v0.6.8-chromium.zip` | `63ef011bb8bd0d976214c2fdbd7d216ea29657b604f59f8938763a23bb30fc3b` |
| `C:\Users\howar\nyx-chess-v0.6.8-firefox.zip` | `327bb324df8dae59036e0166bc0771648c017bad4d004b9a110a54c72829a016` |

## Verification

| Check | Result |
|---|---|
| `npm run check` (syntax + manifest resources) | pass |
| Serial unit suite (`node --test --test-concurrency=1 tests/*.test.js`) | **167/167 pass** |
| Source-tree Chromium harness (`npm run test:browser`) | **65/65 pass** |
| Packaged Chromium harness (`NYX_EXTENSION_ROOT` = extracted 0.6.9 package) | **65/65 pass** |
| Firefox temporary add-on install (`npm run test:firefox`) | pass (Mozilla Firefox 159.0, `nyx-chess@local`) |
| Embedded engine hash in both packages | matches `9025cad4…` |

The Chromium harness loaded the real unpacked extension against a locally
served fake Chess.com board (no network game, account, or live move). It
covered the visible Coach concept/piece/move reveal, the board arrow at the
move level, threat marks on/off, stale clearing, session count/dedup/reset, the
stop-after-games limit, queue status and the overlay controls.

## Claims and limits

- No engine match, benchmark or strength test was performed. This release makes
  no new strength claim. The measured results in `docs/release-0.6.7.md` and
  `docs/benchmarks/rating/regression-0.6.7.md` still describe the tested
  candidate `85f79c39…`, not the shipped `9025cad4…` engine.
- Coach is advisory presentation over the normal search result. It predicts no
  opponent reply and exposes no principal variation. Defended squares count
  geometric defenders; a pinned defender may be unable to recapture, so
  "hanging" is not an absolute claim.
- Session time control and game duration are inferred from board observations,
  not server metadata. The session is per browser profile, not per Chess.com
  account.
- The Firefox check proves Firefox accepts the manifest and listed resources;
  it does not run the Chess.com harness in Firefox.
