# Execution plan — benchmark suite, search fixes, eval pruning, features

Status: 0.6.8 re-labels the 0.6.7 evaluation repair; same engine and source, strength claim remains limited
Started: 2026-11-01
Updated: 2026-11-01 (version-only re-label from 0.6.7 to 0.6.8; validation-36 consumed)

## Phase 1 — Reliable benchmark suite

- [x] 1.1 Shared bench library: engine loading + SHA-256, seeded RNG, adjudication, stats
- [x] 1.2 `run-correctness.js` gate wrapping the unit tests
- [x] 1.3 `tactics.json` + `run-tactics.js` (node-budgeted, failure list)
- [x] 1.4 `positional.json` + `run-positional.js` (agreement vs deep self-search)
- [x] 1.5 `openings.json` (development tuning; not sealed) + `validation.json` (release validation)
- [x] 1.6 `run-match.js` — paired, colour-swapped, seeded, hashed, SPRT, serial
- [x] 1.7 `report.js` — aggregate JSON to markdown
- [x] 1.8 Prove the gate works: run correctness + tactics + a short SPRT smoke test
- [x] 1.9 Freeze 0.6.7 as the reference candidate; record baseline hashes
- [x] 1.10 Widen `openings.json` to 72 distinct lines. This can narrow an interval, but it does **not** guarantee ±7pp; the file has also been edited during development, so it is tuning evidence, not sealed validation.

### Measured so far

- Tactics, 0.6.7, 60k nodes/position: **74/80 (92.5%)**
  — mate-in-1 30/30, mate-in-2 28/30, mate-in-3 16/20.
- Tactics after Phase 2 fixes: **78/80 (97.5%)**, mate-in-2 30/30.
- Positional reference: built from the frozen oracle at 400k nodes / depth 14.

## Phase 2 — Search consistency fixes

- [x] 2.1 Map search differences between current engine and saved 0.6.5
- [x] 2.2 Fix root scoring / PVS / aspiration inconsistencies
- [x] 2.3 Verify nodes-per-second and depth parity with baseline
- [x] 2.4 Prove any change with the Phase 1 suite before keeping it

### Findings

See `docs/benchmarks/phase2-search-audit.md`. Summary:

- The search was already identical to 0.6.5. No PVS or aspiration bug existed.
- Feature masks were inert: the search never called the configured evaluator,
  and `think()` overwrote the configuration anyway.
- The production evaluator did full mobility/attack ray-walking on every leaf
  and discarded every result, because all consumers were mask-gated off.
- The check detector used Manhattan distance, so **no knight or slider check
  was ever detected**. Check extensions never fired.
- Fixing the dead work and the check detector gave **+22.7% / +14.4% nodes per
  second** (the second figure is after paying for correct check detection).
- Result: tactics 74/80 → 78/80; positional 56.3% → 62.5% agreement, 0 blunders.
- Match vs the pre-fix build: 57.5%, CI 36.4–76.1%, SPRT inconclusive. The
  fixes are correct by construction and cheaper, so they stay; the match alone
  does not prove strength.

## Phase 3 — Prune unproven evaluation terms

- [x] 3.1 Ablate each feature bit with `run-ablation.js`
- [x] 3.2 Keep only terms that survive the tactics + positional gates
- [x] 3.3 Confirm survivors with an SPRT match
- [x] 3.4 Record results in docs/benchmarks/

### Verdict

See `docs/benchmarks/phase3-eval-pruning.md`. Production stays at mask **0**.
This verdict is superseded for 0.6.7 release by Phase 5: mask 0 now returns the
tested 0.6.5 evaluation, while explicit ablation masks remain available.

- The observed wall time at a 30k-node cap was 40-85% higher with the optional
  terms on. That is not a clean throughput measurement: different trees can
  stop before the cap, so the same cap is not necessarily the same work.
- No term moves tactics outside the noise band; the two that "gain" a tactic
  record a positional blunder in the same run.
- Mask 63 vs mask 0 match: 57.5%, CI 36.4-76.1%, SPRT inconclusive. That
  time-budgeted match also recorded fewer nodes per second for mask 63. No
  demonstrated gain, so the cheaper build stays the production default.

### Known starting point

Production mask is `0`: passed pawns, pawn-race endgame terms, mobility, pins,
king danger and hanging pieces are all **off**. That was the first thing tested,
because a missing passed-pawn term is a concrete weakness, not a hunch. It did
not survive.

## Phase 4 — Practical features

- [ ] 4.1 Opening book from own games. The generator and picker exist, but no
  book data ships. The 0.6.7 build is deliberately left without a book until a
  tested proposal is accepted.
- [x] 4.2 Development endgame play-out suite with objective results
  (`scripts/bench/endgames.json`). It is **not sealed**: the file was edited
  after the first baseline.
- [x] 4.3 Post-game review mode. Manual, cancellable, and refused while a game
  is running or the rematch queue is armed.

### Results

See `docs/benchmarks/phase4-endgames.md`. The historical endgame report was
**13/14** under the old rule that treated every non-mate as a held draw. The
current runner only passes a drawn position when a rule proves the draw;
reaching the ply cap is UNKNOWN. Old reports also lack mask and position-hash
metadata, so do not compare them to new runs as if they were the same test. A
mate-driving term was built, measured, and **rejected**: it did not improve the
endgame pass count and lost two forced mates in the tactics suite.

The opening book was built and then withheld. A self-play sample showed
**1.h3** appearing from the start position. The cause is not established; the
sample does not prove an evaluation defect, and self-play can produce
human-looking moves. Without a tested benefit, shipping a book full of that
move would be worse than shipping no book. The picker therefore remains gated
behind the presence of data, and no book data is included.

### Notes

- `positional.json` sampled from self-play contains 28 middlegame, 19 late
  middlegame and only **1 endgame** position. That is too thin to judge
  endgame conversion, so 4.2 has its own development set (KQ/KR/KBB/KBN/KP
  wins, KP draws, rook-pawn and wrong-bishop draws, minor-piece draws). It is
  scored by the actual result rather than by engine opinion, but self-play is
  evidence about this engine, not proof of the theoretical outcome.
- The opening book, if built, is a record of this engine's own self-play, not
  an imported line file. It would save clock time in the opening; it is not a
  measured strength change.
- `mode: 'ruthless'` pins variety to 0 and makes self-play deterministic, so
  anything that samples engine play (book, review, profiles) must not use it.
- Mask 0 is **not** a material-only evaluation. Base positional terms and the
  search remain active; mask 0 only switches off the optional experimental
  terms. Do not describe production as "no evaluation".
- Self-play contains no proven opening repertoire. A move appearing often in
  self-play is a sample, not a recommendation, and no blanket gambit removal is
  justified by it.

## Phase 5 — 0.6.7 evaluation regression repair and release

- [x] 5.1 Measure the shipped 0.6.7 regression against saved 0.6.5:
  **33.3%**, 144 games, no harness or replay defect found.
- [x] 5.2 Isolate the cause: 281/768 piece-square entries differed from 0.6.5,
  the production mask disabled passed pawns, and the knight outpost test was
  dead under mask 0. Search fixes were not the regression.
- [x] 5.3 Build and test `candidate-evalfix-0.6.7.js`
  (`85f79c39…`): 0.6.7 search/infrastructure with the exact 0.6.5 evaluation.
- [x] 5.4 Run a predeclared 72-pair development sample (`tuning-72`, seed 1):
  53.5% (CI 47.6–59.4, relative +24.2, interval −16.9…+65.9, 1 cap).
- [x] 5.5 Run the untouched 36-pair validation sample (`validation-36`,
  seed 2; SHA-256 `7e9d453a…`): 56.9% (CI 47.9–66.0, relative +48.6,
  interval −14.5…+115.0, 2 caps). **Validation-36 is now consumed** and must
  not be described as sealed or untouched again.
- [x] 5.6 Do not pool the two samples and do not claim a proven Elo gain.
  Both intervals include 50%; the result supports choosing the repair over the
  badly regressed production build, not superiority over 0.6.5.
- [x] 5.7 Integrate the tested evaluation into `src/engine.js` while retaining
  the review/browser surface. Original production snapshot:
  `docs/benchmarks/rating/baselines/nyx-0.6.7-b4c9bbd4-engine.js`
  (`b4c9bbd4…`). The released engine keeps the tested default evaluator,
  restores the `evaluateUncached` API that the tested copy dropped, and keeps
  the dead-material guard. Default search matched the tested candidate on
  4,704 of 4,705 sampled match positions; the only difference was one
  dead-material ending. See `docs/release-0.6.7.md`.
- [x] 5.8 Verify serially: 135/135 unit tests, JavaScript/manifest check,
  40/40 Chromium unpacked checks, 40/40 packaged-Chromium checks, Firefox
  temporary-add-on install, and both packages embed the same engine SHA-256.
- [ ] 5.9 Remaining, not claimed as done:
  - the opening book is still withheld (no data ships);
  - Firefox runtime play still needs a manual Chess.com smoke test;
  - no confirmatory superiority match against 0.6.5 has been run;
  - any future evaluation change needs a new predeclared sample, because the
    0.6.7 validation set has been consumed.

## Rules

- No strength claim without a suite result and an interval.
- Freeze + hash both engines before any match.
- Serial runs only.
- A sealed validation set is opened once per release; record when it is consumed.
