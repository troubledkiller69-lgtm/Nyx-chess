# Rating methodology and measurement audit

This document describes the relative-strength instrument in `scripts/rating/`.
It is deliberately narrow: it measures one frozen Nyx build against another
frozen build under one time control and one opening set. It does not produce an
absolute human rating.

## Audit of the saved methodology

The existing match code is in `scripts/bench/run-match.js` and
`scripts/bench/lib.js`. Its historical results are useful as history, not as a
current strength claim.

### `pairStats` is not a paired-score interval

`pairStats` applies an Agresti–Coull adjustment to a sum of pair scores:

```js
p = (sum + 2) / (n + 4);
se = sqrt(p * (1 - p) / (n + 4));
```

A pair score is the mean of two colour-swapped games, so it can be `0`, `0.25`,
`0.5`, `0.75`, or `1`. It is not a count of successes out of `n` Bernoulli
trials. The Agresti–Coull formula assumes integer binomial counts. Applying it
to fractional paired scores silently substitutes a smoothed binomial variance
for the actual between-pair variance.

The pair is a reasonable unit of observation, and the code does aggregate the
two colours before this step. The remaining problem is the variance model: a
set of pairs with scores `0, 1, 0, 1` has real between-pair dispersion that a
binomial variance around the pooled mean does not describe. `pairStats` can be
too narrow or too wide, and it has no cluster-bootstrap justification.

### `sprt` is a stopping rule with a nominal interval attached

`sprt` uses a normal approximation with the same Agresti–Coull variance, a
`minPairs` guard, and a fixed log-likelihood-ratio boundary. `run-match.js`
breaks the game loop as soon as it returns `accept` or `reject`. It then reports
`pairStats` with a 95% interval.

That combination is not valid as a fixed-sample interval. If a run can stop
early based on the data, the reported 95% interval is conditional on having
stopped, and it is not the nominal 95% interval of a predeclared sample. The
`minPairs = 8` guard reduces the worst early behaviour; it does not repair the
optional-stopping problem. A sequential design needs a sequential interval or a
correctly calibrated SPRT, and the code did not provide either. The LLR is also
not a true likelihood-ratio statistic for fractional pair scores under a
normal model with a plug-in variance.

The old code also used the same `engine.js` path for both sides in some runs and
distinguished builds only by an evaluation mask. That is a legitimate ablation
if the mask is applied and hashed, but it is not a version comparison. The
reports identify the hash, which is good; the interval and stopping rule are
what make them unsafe to reuse.

### Historical numbers, with their limits

- `docs/benchmarks/match-mask63-vs-0.json`: 20 openings, 40 games, 150 ms/move.
  16 wins, 14 draws, 10 losses; pair score 57.5%; old Agresti–Coull interval
  36.4–76.1%; SPRT continued. This is an ablation of mask 63 against mask 0 on
  one build, not a version comparison, and its interval is the old method.
  Reanalysing the same 20 pair scores with the cluster BCa method here (seed 1)
  gives 48.75–67.5% and a relative Elo interval of about -9 to +127. The point
  estimate is unchanged; the narrower interval comes from using the observed
  between-pair variance instead of a binomial variance. **This reanalysis is
  descriptive and exploratory only.** The original run was optionally stopped
  and examined, so the 48.75–67.5% range is not a confirmatory 95% interval and
  must not be cited as one. It is a demonstration that the old variance model
  was wrong, not new evidence. It remains an ablation on one build, not evidence
  about 0.6.7.
- `docs/evaluation-development.md`: the 0.6.6 evaluation preview lost 2–6–8 to
  0.6.5 over eight pairs at 100 ms/move, then 1–8–7 on the eight held-out
  starts at 450 ms/move. Those are historical results for the 0.6.6 preview.
- The current tree is labelled 0.6.8, a version-only re-label of the 0.6.7
  release. Its released engine hash is
  `9025cad4033fc70648f0951e8ef10b735e2c30f57e544787f751ec4655498830`.
  The pre-repair snapshot was
  `b4c9bbd413adc63f8f9d4447b5830a43fe31632670a315e2aa1670c3684e9118`.
  There is no completed fixed-sample match in this directory that establishes a
  0.6.7 or 0.6.8 gain, and no match has been run on the released `9025cad4…`
  engine. The saved intervals belong to the tested candidate `85f79c39…`. Do
  not cite the 0.6.6 losses as proof that 0.6.8 is better, and do not cite the
  old intervals as current evidence.

## The replacement design

### Unit and pairing

- One opening is played twice: once with the candidate as White and once as
  Black. The pair score is `(candidate score as White + candidate score as
  Black) / 2`, in `[0, 1]`.
- The pair, not the game, is the observation. The interval resamples whole
  pairs, so the two colour-swapped games stay together.
- Opening order is shuffled once with the run seed before the first game. That
  prevents the order of the suite from interacting with machine drift.
- Games are serial. A lock file (`docs/benchmarks/rating/.active-run.json`)
  prevents two rating runs from starting at once. Engine builds are not shared
  with the browser worker. If a run crashes, remove the lock only after checking
  that no rating process is alive; `--force-lock` overrides it explicitly.

### Fixed sample, one look

The runner plays every predeclared pair and analyses once at completion. It does
not implement SPRT or any other early-stop rule. This is the simplest design
whose nominal interval is defensible.

A partial or interrupted run writes `games.jsonl` and `partial.json`, but it
does **not** write `summary.json` and does not report a confidence interval.
`assertFixedSampleComplete` enforces the planned pair count.

If a sequential design is wanted later, it needs its own predeclared stopping
boundary and a sequential interval. It must not be labelled with the fixed-
sample interval used here.

Time-budgeted games are not bit-for-bit reproducible: the wall clock decides
where the search stops. The seed fixes opening order and any stochastic move
selection, and the saved moves make every played game replayable, but a rerun on
a different machine can choose different moves. Use `--node-limit` when exact
reproduction matters; use the time budget when measuring the product's actual
playing conditions. Do not mix the two in one campaign.

### Ply caps are unresolved games, not draws

A game that reaches `--max-plies` is stopped by the harness, not by the rules of
chess. It is recorded with `adjudicated: true`, `resolved: false`,
`outcomeType: 'unresolved-ply-cap'`, and scored 0.5 by convention so it can enter
the pair score.

That convention is a choice, not a result. The consequences:

- The primary score partly measures the ply cap. If many games are cut off, the
  reported score is a mix of chess strength and the harness's stopping rule.
- The run reports `adjudication.unresolvedPlyCaps`, the fraction of games
  affected, the number of pairs affected, and the score over non-capped games
  only. The non-capped score is descriptive and unpaired; it is not a
  replacement interval, because dropping games is not random.
- A high cap rate means the run should be treated as weak evidence. Prefer a
  larger ply cap, or a node-limited run with a cap high enough that it is not
  binding.
- `summary.json` and `report.md` never call these draws. Real draws (stalemate,
  fifty-move, threefold, insufficient material) keep `resolved: true`.

### Interval

For a completed fixed sample with at least six pairs and non-degenerate scores:

- BCa cluster bootstrap over pair scores;
- 20,000 resamples by default;
- fixed PRNG seed from the run configuration, so the reported interval is
  reproducible.

The bootstrap resamples the pairs in the chosen suite. It therefore describes
variation under that fixed, nonrandom opening sample. It is **not** an interval
over all openings, and it is not a universal Elo statement. The scope is
"these openings, this baseline, these settings". Repeated openings would make
pairs correlated, so the runner refuses a plan that repeats an opening; each
pair is a distinct cluster.

For a small sample (`n < 6`) or a degenerate sample (every pair has the same
score), a two-sided Hoeffding bound is used instead. It is distribution-free for
independent bounded observations in `[0, 1]`; the unit of independence assumed
here is the opening pair, not the individual game (the two colour-swapped games
in a pair are deliberately dependent). It is deliberately conservative. This
matters:

- An all-draw run does not return a zero-width interval around 0.5. It returns
  a wide interval and says the data contain no evidence of a non-zero
  difference.
- An all-win or all-loss run has an infinite point Elo. The JSON stores `null`
  for the infinite endpoint and a finite bound on the other side. A null is
  "undefined", not "zero".

The `scoreCI` object always reports the method, n, level, seed, resamples,
`design`, `inferential`, and a `label`. The default design is
`descriptive`: the numeric interval is the same, but a historical, optionally
stopped, or already examined sample is never labelled as a confirmatory 95%
interval just because its scores were fed through this function. Only a caller
that predeclared the sample and passed `design: 'fixed-sample'` (plus a completed
`plannedPairs`) gets the confirmatory label. The `elo` object reports `point`,
`lower`, `upper`, `intervalDefined`, `pointInfinite`, and the endpoint-infinite
flags. JSON cannot represent Infinity, so infinite endpoints are `null` with
explicit flags.

### Inputs are frozen and hashed

Before the first move, the runner:

1. reads the candidate and baseline bytes and hashes them;
2. copies each to `frozen/` in the run directory and re-hashes the copy;
3. copies the opening suite and hashes it;
4. loads the frozen copies, not the source paths;
5. records the source path, source hash, frozen path, frozen hash, byte sizes,
   opening names, settings, game counts, seed, Node version, platform, CPU, and
   a `designHash` over the four input hashes plus the settings hash.

If the source file changes during a long run, the frozen copy is unaffected.
The manifest points at the bytes that actually played. The source paths are
provenance, not the identity of the match.

### Tuning and validation are separate files

- `scripts/rating/openings/tuning-72.json` is the 72-line tuning set. It is a
  copy of `scripts/bench/openings.json`, which has already informed development.
  It may be used repeatedly. SHA-256
  `b34d9c5138da20828f22ebb240855f2c25bb20d392794a4ec84e6fe531418541`.
- `scripts/rating/openings/validation-36.json` is the validation set: 36 lines
  written as a fresh suite for this measurement work from standard opening
  theory, with no engine games or search output used to select or edit a line.
  Run it once for a release candidate, after tuning is finished. Do not edit it
  to make a result look better. SHA-256
  `7e9d453a5f918b7f6983100c3885576e2f73b9ecca066b2b4759993d975b041d`.

The runner hashes whichever suite is passed. A validation result is only
genuinely untouched if no one used that file for tuning between the freeze and
the validation run. The hash in the manifest is how that is checked.

### Validation provenance is checked, not assumed

"Untouched" is a claim about use, and a new filename does not establish it. The
repository records the check as static move application in
`scripts/rating/check-openings.js`, which never calls the search:

```powershell
node scripts/rating/check-openings.js
```

It writes `docs/benchmarks/rating/openings/provenance.json` with, for each suite,
its SHA-256, duplicate lines within the suite, and duplicate final positions
within the suite; and across suites, identical final positions, validation lines
whose final position the other suite reaches mid-line (a genuine transposition),
and the number of validation lines sharing any non-start position.

The current result:

- validation: 36 lines, 0 duplicate lines, 0 duplicate final positions;
- validation vs tuning: 0 identical final positions, 0 final positions reachable
  in a tuning line;
- validation vs the earlier held-out starts: 0 identical final positions, 0
  reachable;
- shared opening prefixes are universal: 36/36 validation lines share at least
  one non-start position with the tuning set (median 6, max 10, the Najdorf
  English attack). That is expected — lines like `1.e4 e5 2.Nf3 Nc6` are the
  same chess — but it means the suites are not statistically independent
  samples of opening space. The bootstrap scope statement covers this: the
  interval is conditional on the suite, not on a random draw of openings.

`scripts/heldout-starts.json` is the old held-out set from
`docs/evaluation-development.md`. It was already used in a past 0.6.6 run, so it
is **not** untouched for this purpose and is listed in the report only to check
for overlap.

### Elo conversion and its limits

The reported Elo is a logistic conversion of the observed pair score against
the frozen baseline:

```text
score = 1 / (1 + 10^(-Elo / 400))
Elo   = 400 * log10(score / (1 - score))
```

At a 0.5 score the relative Elo is 0. At 0.571 it is about +50. At 0.64 it is
about +100.

This number is not:

- a FIDE or Chess.com rating;
- an absolute strength label for Nyx;
- a calibrated Stockfish skill level or UCI `Skill Level` setting;
- transferable to another opponent pool, time control, or opening set;
- evidence that a change helped a different build.

It is a conversion under a model. The interval is the measurement; the Elo point
is a convenience for readers. Report the score and interval first.

## Power and initial budget

The historical 20-pair mask63 match had a pair-score standard deviation of about
0.216. Using that as a planning value and a two-sided 95% interval with 80%
power:

| Target difference | Approximate pairs |
| ---: | ---: |
| +100 Elo | 19 |
| +50 Elo | 72 |
| +30 Elo | 198 |

**These are illustrative planning numbers, not a promise.** The calculation is a
normal approximation that assumes the supplied pair-score SD is the relevant
variance for the planned contrast, independent pairs, a fixed suite, and no
early stopping. Every one of those can be wrong: the SD is itself estimated from
20 pairs, the mask63 ablation had a particular draw rate, and Nyx-vs-Nyx draw
rates are usually higher than engine-vs-engine rates with a large strength gap.
A higher draw rate or a more heterogeneous opening set makes the required sample
larger, sometimes much larger. Treat the table as "roughly the right order of
magnitude", not as a power guarantee.

Observed runtime in the old 150 ms/move 40-game match was about 11 minutes, or
roughly 16–17 seconds per game on that machine. A 72-pair run is 144 games, so
plan on roughly 40–55 minutes plus startup and PGN/JSON writes. A 36-pair
validation run is about half that.

Recommended initial campaign, when the orchestrator allows a sustained run:

1. **Tuning:** 72 pairs (144 games) at 150 ms/move, 200-ply cap, seed 1.
   This is sized to detect roughly a 50-Elo change if the historical variance
   holds. It is not sized to prove a 10-Elo change.
2. **Decision:** if the interval is compatible with a meaningful gain, freeze
   the candidate and run the sealed validation suite once. Do not tune on the
   validation result.
3. **Validation:** 36 pairs (72 games) on `validation-36.json`, seed 2. This is
   confirmatory and less precise; a wide interval is still a result.
4. **Report:** keep the run directory with `manifest.json`, `summary.json`,
   `report.md`, `games.json`, and `games.jsonl`.

Do not run a 200-pair campaign merely to make a small number look decisive. A
change worth shipping should be large enough that a practical sample can see it.

## Commands

Provision the saved 0.6.5 baseline from the ZIP outside the extension. The script
checks the known ZIP hash and extracts only `src/engine.js`. It does not execute
the extracted file.

```powershell
node scripts/rating/prepare-baseline.js --zip C:\Users\howar\nyx-chess-v0.6.5.zip
```

Dry-run: validate inputs, freeze copies, write the manifest, play nothing.

```powershell
node scripts/rating/run-fixed-match.js `
  --candidate src/engine.js `
  --baseline docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js `
  --openings scripts/rating/openings/tuning-72.json `
  --pairs 72 --time-ms 150 --max-plies 200 --seed 1 `
  --out docs/benchmarks/rating/runs/0.6.7-vs-0.6.5-tuning `
  --dry-run
```

Lightweight smoke. This is a pipeline check, not evidence. It uses one opening,
two games, a low node cap, and a 12-ply cap.

```powershell
node scripts/rating/run-fixed-match.js `
  --candidate src/engine.js `
  --baseline docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js `
  --openings scripts/rating/openings/tuning-72.json `
  --pairs 1 --time-ms 50 --node-limit 2000 --max-plies 20 --seed 99 `
  --out docs/benchmarks/rating/runs/smoke
```

Tuning campaign (ready to run; reserve the sustained run for coordination):

```powershell
node scripts/rating/run-fixed-match.js `
  --candidate src/engine.js `
  --baseline docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js `
  --openings scripts/rating/openings/tuning-72.json `
  --pairs 72 --time-ms 150 --max-plies 200 --seed 1
```

Sealed validation, once, after the candidate is frozen:

```powershell
node scripts/rating/run-fixed-match.js `
  --candidate src/engine.js `
  --baseline docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js `
  --openings scripts/rating/openings/validation-36.json `
  --pairs 36 --time-ms 150 --max-plies 200 --seed 2
```

Replay saved games. This checks every UCI move against the frozen referee module
and prints the final FEN.

```powershell
node scripts/rating/replay.js docs/benchmarks/rating/runs/<run-directory>
```

Tests:

```powershell
node --test tests/rating-stats.test.js tests/rating-runner.test.js tests/rating-uci.test.js
```

## Optional UCI runner path

No cutechess-cli or fastchess executable was found on `PATH` or in the usual
user tool directories inspected during this work. The native paired runner is
therefore primary: it already freezes inputs, preserves games, and owns the
statistics. `scripts/rating/nyx-uci.js` is a minimal UCI adapter for a mature
runner if one is installed later:

```powershell
node scripts/rating/nyx-uci.js <frozen-engine.js>
```

The adapter speaks `uci`, `isready`, `ucinewgame`, `position`, `go
movetime|nodes|depth`, and `quit`, and advertises `EvalFeatureMask` and `Hash`
options. It is not a tournament manager.

If a mature runner is used, it must produce a PGN plus the exact engine hashes
and opening hash. Convert its PGN into pair scores and feed those pairs to
`scripts/rating/stats.js` after the predeclared number of pairs finishes. Do not
use the runner's own Elo output as evidence: it is a different estimator, and a
runner that stops early has the same optional-stopping problem described above.
The opening suites in this repository are JSON, so a mature runner also needs an
EPD or PGN opening file exported from that JSON; that export is not included
here because the native runner is the supported path.

## What this does not establish

- It does not establish an absolute human rating.
- It does not establish that the current 0.6.7 build is stronger than 0.6.5.
- It does not establish that Stockfish at some setting corresponds to some Nyx
  Elo.
- It does not make a 10-Elo claim from 72 pairs credible.
- It does not turn a tuning-set result into validation evidence.
- It does not report uncertainty over all openings. The interval is conditional
  on the frozen suite that was played.
- It does not treat ply-capped games as draws; it scores them 0.5 by convention
  and reports how many there were.
- It does not re-validate an old, already examined run. Reanalysis of old data is
  descriptive and exploratory.
