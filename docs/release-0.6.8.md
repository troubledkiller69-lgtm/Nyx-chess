# Nyx Chess 0.6.8 release note

Date: 2026-11-01  
Version: **0.6.8**  
Version name: `0.6.8 evaluation repair + game review`  
Type: version-only re-label of the 0.6.7 evaluation-repair release.

## Scope

This release changes only the display/build version and the package names. The
source tree, browser fixes, review feature, evaluation content and engine bytes
are the same as the 0.6.7 release.

- Previous display label: `0.6.7 side detection fixes`.
- New display label: `0.6.8 evaluation repair + game review`.
- `src/engine.js` SHA-256 is unchanged:
  `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830`.
- No engine source was edited, rebuilt or re-minified for this release.

The label change exists because the 0.6.7 name no longer described the shipped
content and made the repaired build hard to identify next to earlier packages.
The 0.6.7 evidence documents remain valid for the engine and match history.

## Packages

| Package | SHA-256 | Embedded engine |
|---|---|---|
| `C:\Users\howar\nyx-chess-v0.6.8-chromium.zip` | `63ef011bb8bd0d976214c2fdbd7d216ea29657b604f59f8938763a23bb30fc3b` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| `C:\Users\howar\nyx-chess-v0.6.8-firefox.zip` | `327bb324df8dae59036e0166bc0771648c017bad4d004b9a110a54c72829a016` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |

Both packages report `version: "0.6.8"`, `version_name: "0.6.8 evaluation repair + game review"`, contain 18 entries, and include the same required manifest resources as 0.6.7.

The previous packages remain in place and were not overwritten:

| Previous package | SHA-256 |
|---|---|
| `C:\Users\howar\nyx-chess-v0.6.7-chromium.zip` | `4d22dfc2af9a129de50e27f205da2c2fa99faf8ba54aa6d9f3d57e2dc23ff83e` |
| `C:\Users\howar\nyx-chess-v0.6.7-firefox.zip` | `8713a0a6553ede63fb5a3a50e603ec41abddc87d192c7b0824feffab985b9ce0` |

## Verification

| Check | Result |
|---|---|
| `npm run check` (syntax + manifest resources) | pass |
| Serial unit suite (`node --test --test-concurrency=1 tests/*.test.js`) | **135/135 pass** |
| Chromium package manifest/version/resources | pass |
| Firefox package manifest/version/resources | pass |
| Firefox temporary add-on install (`npm run test:firefox`) | pass (Mozilla Firefox 159.0) |
| Embedded engine hash in both packages | matches `9025cad4…` |

No engine match, benchmark run or strength test was performed for this
version-only change.

## Claims and limits

The measured results in `docs/release-0.6.7.md` and
`docs/benchmarks/rating/regression-0.6.7.md` still belong to the builds named
there. In particular, the 53.5% and 56.9% samples belong to the tested candidate
`85f79c39…`, not to `9025cad4…`. Re-labelling the package as 0.6.8 does not
create a new match result and does not establish that the released engine is
stronger than 0.6.5. Validation-36 remains consumed.
