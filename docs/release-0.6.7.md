# Nyx Chess 0.6.7 release evidence

> **Later packaging note:** this evidence describes the engine and packages
> originally labelled 0.6.7. The same engine bytes and source were re-labelled
> 0.6.8 for display/package identification; see `docs/release-0.6.8.md`. The
> hashes, match results and limits below remain accurate for the 0.6.7 packages.

Date: 2026-11-01  
Version: **0.6.7** (unchanged by request)  
Type: evaluation-regression repair and release verification, not a proven
strength upgrade.

## Decision

The shipped 0.6.7 engine lost 33.3% over 144 games against saved 0.6.5. The
release replaces that evaluation with the tested repair candidate. This is
supported as a recovery from a measured regression. It is **not** evidence that
the build is stronger than 0.6.5, and it is not an absolute rating claim.

## Engine evidence

| Artifact | SHA-256 |
|---|---|
| Original shipped engine snapshot (`docs/benchmarks/rating/baselines/nyx-0.6.7-b4c9bbd4-engine.js`) | `b4c9bbd413adc63f8f9d4447b5830a43fe31632670a315e2aa1670c3684e9118` |
| Tested candidate (`docs/benchmarks/rating/experiments/candidate-evalfix-0.6.7.js`) | `85f79c3992b0422907252b870ae26511089aac4b5b334c16c5ffd8a333a1536f` |
| Released `src/engine.js` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| Saved 0.6.5 baseline | `c80ebd6c755a8e31bfb023a700874e2b9eb7b9b60874d5e710f7855f3e2211b8` |

The tested candidate is the 0.6.7 search/infrastructure with the entire 0.6.5
evaluation block and PSTs. The released source is not byte-identical to the
tested file. It keeps the tested default `evaluate()` but additionally:

- restores `evaluateUncached()` for explicit feature-mask/ablation calls; mask 0
  delegates to the default evaluator. The tested copy had removed the internal
  function, so `configureEvaluation()` threw `ReferenceError`.
- retains the production dead-material guard for K+N/K+B versus K.

Default-path parity: 4,704 of 4,705 sampled positions from both rating runs had
identical static evaluation; the single difference was a dead-material ending.
Twelve of twelve deterministic depth-6 positions chose the same move. The exact
candidate-to-release delta is saved as
`docs/benchmarks/rating/experiments/0.6.7-release-evalfix.patch`.

No Stockfish workload, new engine match, or new opening feature was added.

## Measured samples

Both were predeclared fixed samples against saved 0.6.5 at 150 ms/move and a
200-ply cap. They are separate observations and were not pooled.

| Sample | Run | Result |
|---|---|---|
| Development, 72 pairs / 144 games, seed 1 | `docs/benchmarks/rating/runs/2026-11-01T12-16-56-900Z-85f79c39-vs-c80ebd6c` | 53.5% (53-48-43); CI 47.6–59.4; relative +24.2 (−16.9…+65.9); 1 cap |
| Validation, 36 pairs / 72 games, seed 2 | `docs/benchmarks/rating/runs/2026-11-01T12-54-14-690Z-85f79c39-vs-c80ebd6c` | 56.9% (27-28-17); CI 47.9–66.0; relative +48.6 (−14.5…+115.0); 2 caps |

Validation set: `scripts/rating/openings/validation-36.json`, SHA-256
`7e9d453a5f918b7f6983100c3885576e2f73b9ecca066b2b4759993d975b041d`. It is now
**consumed** and must not be described as sealed or untouched again.

## Verification

| Check | Result |
|---|---|
| Serial unit suite (`node --test --test-concurrency=1 tests/*.test.js`) | **135/135 pass** |
| `npm run check` (syntax + manifest resources) | pass |
| Chromium unpacked harness (`npm run test:browser`) | **40/40 pass** |
| Packaged Chromium harness | **40/40 pass** |
| Firefox temporary add-on install | pass (Mozilla Firefox 159.0) |

The browser harness exposed a pre-existing `src/host.js` race: a worker
terminated during `importScripts` could report its load error to a later search.
The fix detaches and ignores workers outside the current pool. It does not
change engine semantics; the failure reproduced with the untouched original
engine.

## Packages

| Package | SHA-256 | Embedded engine |
|---|---|---|
| `C:\Users\howar\nyx-chess-v0.6.7-chromium.zip` | `4d22dfc2af9a129de50e27f205da2c2fa99faf8ba54aa6d9f3d57e2dc23ff83e` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| `C:\Users\howar\nyx-chess-v0.6.7-firefox.zip` | `8713a0a6553ede63fb5a3a50e603ec41abddc87d192c7b0824feffab985b9ce0` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |

Both report version 0.6.7 and contain 18 entries.

## Limits and remaining work

- No proof of superiority over 0.6.5; both confidence intervals include 50%.
- No pooled analysis and no combined significance claim.
- No absolute Elo or universal rating claim.
- The opening book is still withheld; no book data ships.
- Firefox runtime play still needs a manual Chess.com smoke test.
- Any future evaluation change needs a new predeclared sample because the
  0.6.7 validation set has been consumed.
