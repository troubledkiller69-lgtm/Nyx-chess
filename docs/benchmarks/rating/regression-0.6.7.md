# 0.6.7 vs 0.6.5 — regression investigation

**Date:** 2026-11-01  
**Primary run:** `docs/benchmarks/rating/runs/2026-11-01T10-35-48-816Z-b4c9bbd4-vs-c80ebd6c`  
**Question:** Is the measured 0.6.7 loss a harness artifact, or a real engine regression? If real, where is it?

**Measured result:** 72 pairs / 144 games. Candidate 27 wins, 42 draws, 75 losses (33.3%). Pair record 9-22-41. Score CI 27.8–39.6%. Relative Elo -120.4 (CI -166.0 to -73.5). Three unresolved ply caps. Mean depth 8.4 vs 9.1; 476k vs 491k nodes/s.

## Release status (2026-11-01)

The regressed production evaluation has been replaced for the 0.6.7 release
with the tested eval-repair candidate. This fixes the shipped regression; it
does **not** prove a strength gain over 0.6.5.

| Item | SHA-256 / result |
|---|---|
| Original shipped `src/engine.js` (preserved snapshot) | `b4c9bbd413adc63f8f9d4447b5830a43fe31632670a315e2aa1670c3684e9118` |
| Tested candidate `docs/benchmarks/rating/experiments/candidate-evalfix-0.6.7.js` | `85f79c3992b0422907252b870ae26511089aac4b5b334c16c5ffd8a333a1536f` |
| Released `src/engine.js` | `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830` |
| Development sample (`tuning-72`, seed 1, 72 pairs) | 53.5% (53-48-43 games; CI 47.6–59.4; relative +24.2, −16.9…+65.9; 1 cap) |
| Validation sample (`validation-36`, seed 2, 36 pairs) | 56.9% (27-28-17 games; CI 47.9–66.0; relative +48.6, −14.5…+115.0; 2 caps) |

Both intervals include 50%. The two samples are separate predeclared
observations and **were not pooled**; no combined significance, proven Elo
gain, or absolute rating is claimed.

`validation-36` was opened for the second run and is now **consumed**
(SHA-256 `7e9d453a5f918b7f6983100c3885576e2f73b9ecca066b2b4759993d975b041d`).
It must not be reused as if it were still sealed.

### What was integrated

The tested candidate is the 0.6.7 search/infrastructure with the entire 0.6.5
evaluation block and piece-square tables substituted. Copying it byte-for-byte
would have shipped two client-visible defects: `configureEvaluation()` throws
because the tested copy removed `evaluateUncached`, and the 0.6.5 evaluator does
not zero K+N/K+B versus K dead material. The release engine therefore:

- keeps the tested candidate's default `evaluate()` and its 0.6.5 PSTs;
- restores a real `evaluateUncached()` for explicit feature-mask/ablation calls,
  with mask 0 delegated to the default evaluator;
- retains the production dead-material guard;
- leaves search, move selection, worker, review, and browser code unchanged.

The default search evaluator matched the tested candidate on 4,704 of 4,705
sampled positions from the two runs; the single difference was a dead-material
ending. Twelve of twelve deterministic depth-6 search positions chose the same
move. This is a default-path match, not a byte-identical source claim.

### Release verification

- Unit suite: **135/135 pass**, run serially (`--test-concurrency=1`).
- Syntax/manifest: `npm run check` passes.
- Chromium harness: **40/40** unpacked checks and **40/40** packaged checks.
- Firefox: packaged ZIP installs and uninstalls as a temporary add-on.
- Packages: `C:\Users\howar\nyx-chess-v0.6.7-chromium.zip`
  (`4d22dfc2…`) and `C:\Users\howar\nyx-chess-v0.6.7-firefox.zip`
  (`8713a0a6…`); both embed engine `9025cad4…` and report version 0.6.7.
- The browser harness exposed a stale-worker race in `src/host.js`: a worker
  terminated during `importScripts` could report its load error to the next
  search. The fix ignores errors from workers outside the current pool. It does
  not change engine semantics and reproduces on the untouched original build.

Concise evidence is also in `docs/release-0.6.7.md`.

## TL;DR

The loss is real for the measured build. The harness is not the cause.

The dominant regression is in **evaluation**, not in the claimed check-detector or mate-pruning search fixes:

- 281 of 768 piece-square table entries in `src/engine.js` differ from 0.6.5, even though the source comment says they were "restored from 0.6.5". All packaged versions 0.6.0 through 0.6.5 share the same tables.
- Production `EVAL_FEATURE_MASK = 0` switches off passed-pawn scoring that 0.6.5 always applied.
- Because `prepareAttacks()` is only called when mask bits 4/8/16/32 are set, the production mask also leaves the knight-outpost test reading a stale `PAWN_ATTACKS` array. That term is effectively dead in 0.6.7.
- On 605 positions sampled from the match, 0.6.7's static evaluation differs from 0.6.5 by 62 cp mean absolute, flips sign on 80 positions, and differs by at least 100 cp on 130 positions.
- The search fixes are genuinely good for tactics: at 30,000 nodes the tactics suite scores 0.6.5 = 74/80, 0.6.7 = 77/80, and an experimental build with the 0.6.5 evaluation plus the 0.6.7 search = 79/80.
- In a 16-pair exploratory match, the 0.6.7 search with the exact 0.6.5 evaluation scored 54.7% against 0.6.5 (95% CI 40.6–68.8). The current evaluation scored 39.1% against a minimally corrected evaluation (95% CI 25.0–53.1).

No corrected build has yet demonstrated a strength gain over 0.6.5. The safe fallback remains the frozen 0.6.5 engine.

## 1. Measurement audit

### 1.1 Inputs are genuine

| Input | SHA-256 | Verification |
|---|---|---|
| Candidate `src/engine.js` | `b4c9bbd413adc63f8f9d4447b5830a43fe31632670a315e2aa1670c3684e9118` | Matches `src/engine.js` in both packaged 0.6.7 zips (Chromium and Firefox) |
| Baseline `nyx-0.6.5-engine.js` | `c80ebd6c755a8e31bfb023a700874e2b9eb7b9b60874d5e710f7855f3e2211b8` | Matches `src/engine.js` inside `nyx-chess-v0.6.5.zip` (`fc9cad2b…`), the archived original |
| Openings `tuning-72.json` | `b34d9c5138da20828f22ebb240855f2c25bb20d392794a4ec84e6fe531418541` | Matches the run's frozen copy |

The baseline was extracted from the original archive without execution. It is not a reconstructed or modified build.

### 1.2 Runner isolation

The runner (`scripts/rating/run-fixed-match.js`) does the following correctly:

- Copies both engine files and the opening suite into the run directory and hashes the copies.
- Loads the frozen copies, not the source paths.
- Requires each engine as a separate CommonJS module. Each module is an IIFE with its own closure, so the candidate and baseline do not share `PAWN_FILES`, `ATTACKS`, `TT`, `history`, or other module state.
- Creates a fresh `Engine` per side per game.
- Gives both sides the same `mode`, `skill`, `variety`, `depth`, `timeMs`, `historyFens`, and seeded RNG stream.
- Uses a fixed 150 ms deadline in both engines (`deadline = t0 + timeMs`) and no node limit.
- Computes the score from the candidate's colour and the referee result correctly.
- Runs games serially. No concurrent searches and no async interleaving inside a search.

The candidate's evaluation cache is module-global and persists across games. It is keyed by `hashA`, `hashB`, side, and style. It can only affect candidate speed, not baseline state, and it is not a rules or scoring asymmetry. It does not explain a loss in the candidate's favour.

### 1.3 Referee and replay

The referee uses the candidate's `Position` implementation for both sides. That is symmetric for the players, but it could hide a candidate-only movegen bug. To test it independently, all 144 games were replayed under the frozen **0.6.5** referee:

```
node docs/benchmarks/rating/experiments/replay-referee.js \
  docs/benchmarks/rating/runs/2026-11-01T10-35-48-816Z-b4c9bbd4-vs-c80ebd6c \
  docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js
```

Result:

```json
{
  "referee": "nyx-0.6.5-engine.js",
  "games": 144,
  "illegal": 0,
  "adjudicationMismatches": 0
}
```

Every recorded move is legal under the older engine's rules, and every mate/stalemate/threefold/insufficient-material adjudication agrees. There is no movegen or scoring exploit.

**Conclusion:** the harness result is valid. The -120.4 Elo estimate is a real relative result for this build, settings, and opening suite. The loss should be accepted, not invalidated.

## 2. Source diff

`src/engine.js` is 0.6.5 plus search and evaluation work. The search changes are the check-detector fix, mate-distance pruning, reverse-futility and null-move mate-bound guards, and related infrastructure.

The evaluation changes are different from what the comments claim.

### 2.1 Piece-square tables

All packaged builds 0.6.0, 0.6.1, 0.6.2, 0.6.3, 0.6.4, and 0.6.5 have identical tables. The 0.6.7 source has 281 different entries:

| Table | Entries changed vs 0.6.5 |
|---|---:|
| `MG_PAWN` | 0 |
| `EG_PAWN` | 12 |
| `MG_KNIGHT` | 0 |
| `EG_KNIGHT` | 12 |
| `MG_BISHOP` | 53 |
| `EG_BISHOP` | 24 |
| `MG_ROOK` | 19 |
| `EG_ROOK` | 52 |
| `MG_QUEEN` | 20 |
| `EG_QUEEN` | 53 |
| `MG_KING` | 5 |
| `EG_KING` | 31 |
| **Total** | **281 / 768** |

The comment in `src/engine.js` says:

> `// (Restored from 0.6.5 baseline to recover lost positional strength.)`

The values do not match the 0.6.5 baseline. This is the most likely accidental regression: a table replacement was described as a restoration but inserted a different set.

### 2.2 Production evaluation mask

`src/engine.js` has `EVAL_FEATURE_MASK = 0`. In `evaluateUncached()`:

- Passed-pawn scoring is gated by `(featureMask & 1) || (featureMask & 2)`. With mask 0 it never runs. 0.6.5 always applied `PASSED_MG`, `PASSED_EG`, and the king-escort term.
- `prepareAttacks()` is called only when `featureMask & (4 | 8 | 16 | 32)`. With mask 0 it never runs.
- The knight-outpost test then checks `PAWN_ATTACKS[...][sq]`. That array is module-level and is not repopulated for the production mask, so the condition is false and the outpost bonus is effectively dead. 0.6.5 applied the outpost bonus unconditionally.

So 0.6.7's production evaluation is not "0.6.5 evaluation with optional extras off". It is a different evaluation with some 0.6.5 terms removed.

### 2.3 Search fixes are real

The check-detector fix and mate-bound guards are not the regression. They improve the fixed tactical suite.

At 30,000 nodes per position:

| Build | Tactics |
|---|---:|
| 0.6.5 | 74/80 (92.5%) |
| 0.6.7 current | 77/80 (96.3%) |
| Search fixes + exact 0.6.5 eval (e7) | 79/80 (98.8%) |
| Minimal eval fix (e8) | 79/80 (98.8%) |

The search fixes buy tactics. They do not buy enough to offset the evaluation regression in games.

### 2.4 Unrelated defect noted

`Engine.think()` contains a duplicated blunder-selection block. In ruthless mode `opts.blunder` is false, so it does not affect the rating match, but in human/blunder mode it consumes an extra random number and reselects the forced move. This should be cleaned up separately. It is not part of the strength regression.

## 3. Static evaluation evidence

Method: take every 25th position from all 144 games (605 positions), evaluate with 0.6.5's `evaluate`, then with each experimental build's `evaluate`. Positive differences mean the candidate sees the side to move as better.

| Build | Mean abs diff | >100 cp | Sign flips | Exactly equal |
|---|---:|---:|---:|---:|
| 0.6.7 current (e0) | 62.05 cp | 130 | 80 | 13 / 605 |
| 0.6.5 tables only (e1) | 36.69 cp | 72 | 20 | 181 / 605 |
| Tables + outpost + mask 1 (e5) | 7.32 cp | 4 | 3 | 371 / 605 |
| Exact 0.6.5 eval + search fixes (e7) | 0.00 cp | 0 | 0 | 605 / 605 |
| Tables + outpost + mask 3 (e8) | 7.78 cp | 9 | 2 | 345 / 605 |

The current build's evaluation is not a small perturbation. It disagrees with 0.6.5 by more than a pawn on more than a fifth of the sampled positions and flips the sign on 13% of them.

Reproduce with:

```
node docs/benchmarks/rating/experiments/eval-compare.js \
  docs/benchmarks/rating/experiments/e0-current.js \
  docs/benchmarks/rating/runs/2026-11-01T10-35-48-816Z-b4c9bbd4-vs-c80ebd6c 25
```

## 4. Position-level Stockfish check

Six positions were predeclared from the earliest graded errors in six selected losses. Each engine searched each position at a fixed 30,000 nodes. The chosen moves were graded by Stockfish 19 at depth 14.

| Build | Total SF loss over 6 positions | Stockfish-best moves |
|---|---:|---:|
| 0.6.5 | 1,070 cp | 2 / 6 |
| 0.6.7 current | 1,901 cp | 2 / 6 |
| Tables only (e1) | 1,619 cp | 1 / 6 |
| Tables + outpost + mask 1 (e5) | 1,281 cp | 2 / 6 |
| Exact 0.6.5 eval + search fixes (e7) | 1,274 cp | 2 / 6 |

Per-case losses (lower is better):

| Case | 0.6.5 | 0.6.7 | e5 | e7 |
|---|---:|---:|---:|---:|
| Vienna 40, ply 7 | 56 | 636 | 56 | 56 |
| Smith-Morra 122, ply 23 | 161 | 0 | 161 | 161 |
| Scotch four knights 25, ply 4 | 85 | 118 | 289 | 289 |
| Gruenfeld 22, ply 18 | 0 | 379 | 0 | 0 |
| Trompowsky 56, ply 17 | 0 | 0 | 0 | 0 |
| Sicilian accelerated 133, ply 41 | 768 | 768 | 775 | 768 |

The per-case results are mixed. Two cases strongly favor the 0.6.5 evaluation, two favor 0.6.7 at this budget, one is not reproduced at 30,000 nodes, and one is bad for every build. The aggregate ordering is suggestive, not decisive, and this set is deliberately selected from losses. The stronger evidence is the static evaluation divergence and the direct matches in section 5.

Full output: `docs/benchmarks/rating/experiments/results/position-compare.log` and `position-compare.json`.

## 5. Exploratory matches

All matches used 16 pairs (32 games), 150 ms/move, 200-ply cap, seed 1, and the same first 16 openings from the shuffled tuning suite. These are exploratory, not confirmatory. CIs are wide and overlapping.

| Match | Score for first-named build | 95% CI | Pair W-D-L | Mean depth | NPS |
|---|---:|---:|---:|---:|---:|
| 0.6.7 current vs e5 (tables + outpost + mask 1) | 39.1% | 25.0–53.1 | 5-2-9 | 8.29 vs 8.27 | 443k vs 432k |
| e7 (search + exact 0.6.5 eval) vs 0.6.5 | 54.7% | 40.6–68.8 | 7-4-5 | 8.46 vs 8.99 | 390k vs 390k |
| e8 (tables + outpost + mask 3) vs 0.6.5 | 45.3% | 32.8–57.8 | 4-6-6 | 8.50 vs 9.11 | 402k vs 414k |
| e7 vs e8 | 51.6% | 39.1–64.1 | 6-5-5 | 8.54 vs 8.42 | 412k vs 394k |

What this supports:

- The corrected evaluation (e5) beats the current evaluation in the direct comparison.
- The 0.6.7 search with the exact 0.6.5 evaluation is not worse than 0.6.5 in this sample.
- The two corrected variants are not distinguishable over 16 pairs.

What this does not support:

- A claim that any corrected build is stronger than 0.6.5.
- A claim that mask 3 is better than mask 1 or vice versa.
- A new Elo estimate.

Run directories:

- `docs/benchmarks/rating/experiments/runs/e0-vs-e5-16p`
- `docs/benchmarks/rating/experiments/runs/e7-vs-0565-16p`
- `docs/benchmarks/rating/experiments/runs/e8-vs-0565-16p`
- `docs/benchmarks/rating/experiments/runs/e7-vs-e8-16p`

## 6. Corrected experimental candidates

The experimental copies still live outside the extension package. The 0.6.7
release now uses the recommended candidate's default evaluation; the original
production engine is preserved as
`docs/benchmarks/rating/baselines/nyx-0.6.7-b4c9bbd4-engine.js`. See the release
status section at the top for the integration deltas and hashes.

### Recommended candidate: exact 0.6.5 evaluation + 0.6.7 search

`docs/benchmarks/rating/experiments/candidate-evalfix-0.6.7.js`  
SHA-256: `85f79c3992b0422907252b870ae26511089aac4b5b334c16c5ffd8a333a1536f`

This is the 0.6.7 engine with the entire evaluation block and piece-square tables from 0.6.5 substituted. It keeps the check-detector fix, mate-distance pruning, mate-bound guards, and Position infrastructure. Its static evaluation is exactly 0.6.5 on all 605 sampled positions.

It was the measured release candidate (53.5% development, 56.9% validation).
Its default evaluator is shipped; the release source additionally restores the
`evaluateUncached` API and the dead-material guard described above.

### Minimal source patch candidate

`docs/benchmarks/rating/experiments/candidate-minimal-evalfix.js`  
SHA-256: `edfaa2f509b79520f9e83c473bf246460df906b181571f523fa27720d3ccfd28`

This keeps the 0.6.7 evaluation code and cache, restores the 0.6.5 tables, restores the 0.6.5 knight-outpost test, and sets `EVAL_FEATURE_MASK = 3` (passed pawns plus pawn-race/endgame terms). Static evaluation is within 7.78 cp mean absolute of 0.6.5.

It is not an exact 0.6.5 evaluation: it keeps the 0.6.7 dead-material early return (`np === 0 && phase <= 2` returns 0), the modified blocked-passed-pawn scaling, and the Chebyshev king-distance terms. Those are plausible future improvements but they are unproven, and the KBN-vs-K early return can suppress the mate-driving score. Use e7 when the goal is to isolate the search work; use e8 when the goal is to keep the 0.6.7 evaluation code and repair only the measured regressions.

A unified patch against `src/engine.js` is at:

`docs/benchmarks/rating/experiments/0.6.7-minimal-evalfix.patch`

The patch is documentation for the alternative minimal repair. It was **not**
used for the release; the released engine follows the recommended exact-0.6.5
evaluation candidate, with the compatibility additions noted above.

### Reproduce the variants

```
node docs/benchmarks/rating/experiments/make-variants.js
```

This writes every experimental copy from the frozen 0.6.5 baseline and the current source. It never writes to `src/`.

## 7. Status and next action

1. **Shipped:** 0.6.7 now uses the repaired evaluation. The evidence supports
   replacing the 33.3% production build; it does not establish superiority over
   0.6.5 or an absolute rating. Keep 0.6.5 as the known-strong fallback.
2. **Do not pool** the 72-pair development run and the 36-pair validation run.
   Both intervals cross 50%; neither is a proven gain.
3. **Validation-36 is consumed** (SHA-256 `7e9d453a…`). Any future candidate
   needs a new predeclared sample; do not call this set sealed again.
4. Future evaluation work should change one term at a time on top of the
   repaired baseline and be measured with a new sample. Do not bundle table,
   mask, and search changes into one unmeasured build again.
5. Remaining release features: the opening book is still withheld, Firefox
   runtime play still needs a manual smoke test, and no confirmatory
   superiority match has been run.
6. Clean up the duplicated blunder-selection block separately; it is not part
   of this regression.

## Reproduction index

| Artifact | Path |
|---|---|
| Variant builder | `docs/benchmarks/rating/experiments/make-variants.js` |
| Static eval comparison | `docs/benchmarks/rating/experiments/eval-compare.js` |
| Position comparison | `docs/benchmarks/rating/experiments/compare-at-positions.js` |
| Independent replay | `docs/benchmarks/rating/experiments/replay-referee.js` |
| Tactics reports | `docs/benchmarks/rating/experiments/results/tactics-30k-*.json` |
| Exploratory matches | `docs/benchmarks/rating/experiments/runs/` |
| Minimal patch | `docs/benchmarks/rating/experiments/0.6.7-minimal-evalfix.patch` |
