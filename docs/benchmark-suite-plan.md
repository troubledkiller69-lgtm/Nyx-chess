# Benchmark suite plan

## Purpose

An engine change is a hypothesis: "this version is stronger than that one."
A benchmark suite is the instrument that decides whether the hypothesis is true.

Without an instrument, every change is a guess dressed up as progress. That is
not a strength problem, it is a measurement problem. This document describes the
instrument we need, why the current one is not it, and how to build the
replacement.

## Why this matters now

The engine has been through many evaluation and search changes. Most were
measured with short matches against a saved baseline. Several of those matches
reported a score of exactly 0.5, which was read as "at parity." That reading was
wrong, and the reason is statistical, not technical:

- 8 games, paired by colour, produces a paired-score standard error around
  0.12-0.19.
- A 95% interval around a 0.5 result is therefore roughly 0.15 to 0.85.
- That interval contains "clearly worse" and "clearly better."

A test that cannot distinguish parity from a 150-Elo swing is not evidence. It is
a coin flip with extra steps.

Four other instrument failures were observed in the same period:

1. **Contamination.** The "held-out" opening set was reused for tuning. Once a
   position set informs a decision, it is a training set. It can never be
   validation again.
2. **Configuration not applied.** Feature masks were set on the engine instance,
   but the search entry point reset them from options. Several "ablations"
   compared identical code and reported a difference of zero. The difference was
   real; the experiment was empty.
3. **Concurrent edits.** Matches ran in the background while the engine file was
   being edited. Results were attributed to a build that did not exist.
4. **Correlated samples.** Repeated starting positions were counted as
   independent evidence. Colour pairs are correlated by construction, so the
   normal approximation overstates confidence.

Every one of these is fixable, and all of them are cheap to fix compared to
shipping a regression.

## Design principles

1. **Correctness before strength.** A broken move generator can look strong in a
   short match. Gate every benchmark run behind a fast correctness suite.
2. **Deterministic before statistical.** Anything that can be measured without
   randomness (perft, tactical solve rate at a node budget) should be, because
   it gives the same answer every run and costs seconds.
3. **Node budgets for correctness, time budgets for strength.** Node-budgeted
   results are machine-independent and reproducible. Time-budgeted results
   reflect the real product and must be run on a quiet machine, serially.
4. **Sealed validation.** One position set is touched only at release. If a
   change fails there, it overfit, and the failure is information.
5. **Every claim carries an interval.** No bare percentages. No Elo estimate
   without a confidence interval and a note on what it does and does not mean.

## The four suites

### A. Correctness gate (seconds)

Runs before anything else. Fails loudly and stops the pipeline.

- Perft counts against published reference values at depths 1-6 from several
  positions, including castling, en passant, promotion, and check evasion.
- Make/unmake round-trip: every legal move applied and reverted must restore the
  exact position hash, material totals, and incremental evaluation state.
- Incremental evaluation equals a fresh full evaluation after every move.
- Zobrist hashing is incremental and matches a recomputed hash.
- Static exchange evaluation on hand-verified capture chains.
- Terminal detection: checkmate, stalemate, fifty-move, threefold, insufficient
  material (including the two-knight and opposite-bishop cases).
- FEN parse/serialise round-trip.

This suite already exists in large part (the test directory). It needs to be
promoted from "run when remembered" to "run as step zero of every benchmark."

### B. Tactical suite (seconds to minutes)

Fixed positions with a known correct answer, solved under a fixed node budget so
the result does not depend on the machine.

Categories:

- Mate in 1, 2, 3, 4, 5.
- Winning a hanging piece.
- Promotion races with king interception.
- Underpromotion to avoid stalemate.
- Perpetual-check avoidance and forced-draw recognition.
- Stalemate traps: recognising when a winning position must not be converted.
- Back-rank mate patterns and defensive resources.

Metrics: solve rate per category, average nodes to solve, and a list of failures
with FEN and the move chosen. The failure list is the useful part; it tells you
which search or evaluation assumption broke.

Target size: 150-250 positions. Enough to be stable, small enough to run in under
a minute at a modest node budget.

### C. Positional agreement suite (minutes)

Positions where no single move is provably correct. The reference is our own
engine searching much deeper and longer than the candidate will in a real game
(depth 14+, several seconds per move). This keeps the whole pipeline original
and avoids importing an external engine.

Metrics:

- Move agreement rate with the deep reference.
- Average centipawn loss against the reference score.
- Blunder rate: fraction of moves losing more than 200 centipawns relative to the
  reference.
- Worst single move.

This suite is self-referential, and that is a feature, not a bug: it measures how
well shallow search approximates deep search, which is stable, cheap, and
correlates with playing strength. It is not a substitute for the match suite.

Target size: 50-80 positions spanning opening, middlegame, and endgame, with a
deliberate mix of quiet and sharp.

### D. Match suite (hours)

The only suite that measures relative playing strength directly. Games between
two frozen engine files, from a sealed set of starting positions.

Design:

- **Paired, colour-swapped.** Every starting position is played twice, once with
  each engine as White. The pair produces a score in {0, 0.5, 1}, which removes
  most of the first-move advantage from the variance.
- **Sealed openings.** The design calls for opening lines stored in a file that
  is never edited during development, plus a separate validation set used once
  per release. In the current tree `openings.json` has been edited during
  development (and widened), so it is tuning evidence, not sealed validation.
- **Fixed time per move**, with overruns counted and reported.
- **Serial execution only.** Parallel matches contend for CPU and change the
  effective time per move, which invalidates the comparison.
- **Frozen inputs.** Both engine files are copied to a versioned location and
  hashed before the run. The hash is recorded in the report.
- **Seeded randomness.** Any stochastic element (move variety, deliberate-error
  rolls) is driven by a per-game seed derived from the game index, so a run can
  be reproduced exactly.

Adjudication:

- Checkmate and stalemate are natural results.
- Fifty-move, threefold repetition, and insufficient material are draws.
- A ply cap is a draw, but capped games are counted and reported separately. A
  high cap rate is a finding: it means the engine cannot convert won positions,
  which is a real weakness worth its own investigation.

### Statistics

The match suite reports a mean pair score with a standard error and a 95%
interval. That is the minimum honest output.

For decision-making, use a sequential test (SPRT) rather than a fixed game count:

- H0: the change is worth 0 Elo.
- H1: the change is worth +X Elo, where X is the smallest gain worth shipping
  (10-15 is a reasonable starting point).
- alpha = 0.05, beta = 0.05.
- Stop when the log-likelihood ratio crosses an acceptance or rejection
  boundary.

SPRT typically saves 40-50% of the games compared to a fixed-length design at the
same confidence, and it gives an explicit "accept," "reject," or "keep playing"
answer.

Effect sizes, for calibration:

| Elo difference | Expected score |
|---|---|
| 5 | 0.507 |
| 10 | 0.514 |
| 20 | 0.529 |
| 50 | 0.571 |
| 100 | 0.640 |

A 10-Elo change is a 1.4 percentage-point score change. Detecting that reliably
takes hundreds of games, more if the draw rate is high. This is why "we gained
50 Elo" claims from 8-game samples are not credible, and why the suite should
never be used to chase 5-Elo deltas.

The Elo number itself is a conversion, not a measurement. It assumes a logistic
model and a specific opponent pool. Report it, label it as an estimate, and never
present it as an absolute rating.

## Metrics beyond win/loss

Win rate says whether a change helped. These say why:

- **Depth reached** at fixed time: search efficiency.
- **Nodes per second**: raw speed, and the first place to look when a change
  slows everything down.
- **Effective branching factor**: depth gained per doubling of nodes.
- **Transposition table hit rate** and **beta-cutoff rate**: move ordering
  quality.
- **Average centipawn loss** per move against the deep reference.
- **Blunder rate**: moves losing more than 200 centipawns.
- **Conversion rate** from +2.0 or better, and **save rate** from -2.0 or worse.
- **Endgame conversion**: wins actually converted in theoretically won endings.
- **Time-to-mate** in forced wins.

A change that improves the score while halving nodes per second is suspicious and
should be re-tested at a longer time control.

## Operational protocol

1. Copy the candidate engine to a versioned file. Hash it.
2. Confirm the baseline file is untouched. Hash it.
3. Run the correctness gate. Stop on any failure.
4. Run the tactical and positional suites. These are fast and catch most
   regressions before a match is worth running.
5. Run the match suite against the baseline with SPRT.
6. If accepted, run the sealed validation set once. A failure here means the
   change overfit the tuning set.
7. Record everything in a versioned report under `docs/benchmarks/`.
8. Only then bump the version.

## Cost

- Correctness gate: seconds.
- Tactical suite: under a minute.
- Positional suite: a few minutes.
- Match suite: hours, depending on effect size and draw rate.

A full cycle per candidate is a few hours of unattended machine time. That is the
price of being able to say "this is stronger" and have it mean something.

## What it buys

- The ability to reject bad ideas in minutes instead of shipping them.
- Attribution: when the score moves, the report says which suite moved and why.
- Protection against the specific failures listed at the top: contamination,
  misconfiguration, concurrent edits, and correlated samples all become
  structurally impossible rather than things to remember.
- A shared language with colleagues: "it passed SPRT at +15 Elo on the tuning
  set and held on validation" is a claim someone else can check.

## Implementation plan for this repository

```
scripts/bench/
  tactics.json          # positions with expected move or mate distance
  positional.json       # positions for agreement testing
  openings.json         # development tuning openings (currently 72 lines)
  validation.json       # release validation openings
  run-correctness.js    # wraps the existing test suite as a gate
  run-tactics.js        # node-budgeted solver, prints solve rate and failures
  run-positional.js     # agreement and centipawn loss vs deep reference
  run-match.js          # seeded, paired, SPRT, hashed, serial
  report.js             # aggregates JSON results into a markdown table
docs/benchmarks/        # one versioned report per release candidate
```

The existing `scripts/engine-match.js` is the starting point for `run-match.js`.
It already does paired colour-swapped games and dead-material adjudication; it
needs seeded randomness, SPRT, hash recording, and the removal of the
"repeated starts counted as independent evidence" pattern.

The existing test suite becomes the correctness gate with no changes, only a
runner that makes it mandatory.

## Open questions

- Draw rate at the target time control is unknown. It determines the required
  game count and should be measured on the first real run.
- Whether the positional agreement suite correlates with match results strongly
  enough to be a useful early filter is an empirical question. Measure it on the
  first few candidates.
- The right effect size for H1 depends on how often we expect to ship. Start at
  10 Elo and revisit.
