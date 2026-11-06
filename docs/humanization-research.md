# Humanization research

**Status:** research only. No production code, tests, or configuration were changed to produce this document.
**Audience:** maintainers of the Human layer (`src/human.js`).
**Access date for all citations:** 2026-11-02.

Evidence labels used throughout:

| Label | Meaning |
| --- | --- |
| **Observed** | Reported in a primary source, with the figure as stated there. |
| **Inferred** | A conclusion I draw from observed results; could be wrong. |
| **Hypothesis** | Testable but currently untested by anyone I could find. |
| **Proposal** | A design suggestion for Nyx. Not a finding. |

## Revision note (post-review)

This version corrects four overclaims in the first draft.

1. **The error budget was described as producing "measurable negative autocorrelation" and humans as not doing "that."** A finite per-game cap does not mathematically force negative autocorrelation; it can induce dependence, conditionally on position difficulty, game length, and how many eligible moves have passed. The magnitude is untested here, so it is now labelled a hypothesis (E7). The Anderson et al. result supports a position-dominant model; it does not establish the absence of any within-game dependence in humans, and the draft wrongly used it that way.
2. **"Budget must go" / "dead on evidence alone"** is removed. Autocorrelation alone cannot justify deletion, because the confounders (phase, rating, clock, difficulty, game length) and the end-of-game selection effect all need adjustment, and because intentional error counts are a product requirement. The budget is now framed as a deliberate control with a documented realism tradeoff, and the hazard ships alongside it.
3. **Policy/clock/profile were described as three layers that must not share state.** That was wrong: style and difficulty legitimately couple them. The revised design prescribes separate *responsibilities* with an explicit shared latent state.
4. **Win-probability loss was presented as a clean improvement.** It requires a human calibration fitted per rating band and time control; engine WDL is not human win probability. The calibration limits are now stated in §5.1a.

Also corrected on re-verification: Russek et al. describe their effect as "quite large" — the draft's "modest" was my judgement, not theirs, and the fitted slope varies about 20× across time controls. Sunde et al.'s association is explicitly associational, and their "more pronounced under time pressure" is conditional on high time pressure rather than a blanket rapid/blitz claim. Their population is 2500+ over-the-board professionals, which bounds transfer. The stylometry preprint is arXiv:2208.01366.

---

## 1. Executive recommendation

Humanization is best organised as **three areas of responsibility** — policy, clock, profile — but they are *not* supposed to be independent. A player's perceived difficulty, their remaining time, and their habits legitimately interact, and a design that forbids that coupling would be less realistic, not more. What the current implementation lacks is not separation but **an explicit shared state**: a small set of named latents that the three responsibilities read and write, instead of each computing its own ad hoc proxy for the same thing.

1. **Policy** — which move is chosen, given target skill and position.
2. **Clock** — how long it takes, given position value and clock state.
3. **Profile** — the stable, slowly-changing habits that make an account recognisable across games.

Shared latents worth naming explicitly: *perceived difficulty* of the position, *effective thinking budget*, and *form* (a slow session-level offset). Policy and clock both need difficulty — that is the coupling, and it should be one variable, not two.

The most consequential issues, stated as hypotheses where the evidence does not yet settle them:

1. **The per-game hard-error budget is a modelling choice with an untested side effect.** A finite cap on errors per game does **not** mathematically force negative autocorrelation. It *can* induce dependence, because whether an error is still available depends on how many eligible moves have already passed and how many errors were already spent — so the induced correlation is conditional on position difficulty, game length, and the path taken to the current position. Whether this is large enough to be measurable in Nyx's output is a **hypothesis to test (E7)**, not an established property of the design. What the evidence does support is weaker and narrower: one large study finds error probability is dominated by position difficulty rather than by history **[4]**, which makes a position-conditioned model a *better-motivated alternative*, not a proof that the budget is wrong for every purpose.
2. **The budget is also a deliberate product control.** Configurable error counts are an explicit requirement — for practice partners, for a weaker persona, for a coach that deliberately models mistakes. That is a legitimate simulation requirement, and it is not the same objective as distributional realism. The recommendation is therefore to **offer the hazard as an alternative mode**, with the tradeoff documented, and to keep the explicit count controls. It is not a recommendation to delete them.
3. **Opening memory works against repertoire identity.** `weightedPick` multiplies recently-played lines by 0.2 for 8–12 games. Human evidence points the other way: players repeat a small repertoire, and specialisation increases with skill **[7]**. The effect size for Nyx is unmeasured. **Candidate replacement: a stable repertoire sampled from a persistent distribution.**
4. **`thinkTime` is additive and position-blind.** It computes `search + humanPause`, with pause driven by `complexity` and two "mood" quantiles. Evidence supports a positive association between think time and a value-of-computation estimate, which the authors describe as quite large and which varies with time control and skill **[5]**. **Candidate replacement: a sampled duration model whose mean includes a value-of-computation term, clipped by the clock plan.**
5. **Error magnitude is expressed in centipawns, which have no stable meaning across positions or rating bands.** A 60 cp error at +0.0 is nearly irrelevant; a 60 cp error at +6.0 can be the difference between winning and drawing. Win-probability loss is the better *unit*. It is **not** a drop-in substitute: converting engine scores to a human win probability requires fitting a calibration on human games from the relevant rating band and time control, and the result is a model, not a ground truth. **Proposal, with calibration limits named in §5.1.**

What should be kept:

- The deliberately imperfect Coach suggestions and the existing disclosure at `docs/coach-mode.md:335-337` ("practice suggestion for the configured difficulty, not Nyx's strongest or guaranteed move"). The imperfection is a *feature* of a coaching tool for a specific difficulty; the disclosure is what makes it honest. Keep both.
- Endgame drift, resignation behaviour, and session-level pacing as *optional* texture, gated behind evidence, not as core model.

What should **not** be built: anything aimed at evading fair-play detection. That is out of scope here, and the "Next vectors" list in `docs/humanization.md:108-138` should be read as an inventory of observed signals, not a roadmap. Modelling human behaviour and defeating detection are different projects; only the first is in scope.

---

## 2. Scope

**In scope:** producing believable, rating-appropriate play for offline bots, training partners, simulation, and coaching. The unit of correctness is "does this distribution of moves, times, and results resemble the corresponding human distribution at this rating and time control?"

Also in scope, and distinct from the above: **deliberate imperfection as a product feature.** Configurable error counts, a coach that models a specific weakness, and a weaker persona are explicit requirements. They optimise for *pedagogy and controllability*, not for distributional realism, and this report treats them as legitimate rather than as defects to be fixed.

**Out of scope, explicitly:**

- Reducing the probability of being flagged by a platform.
- Thresholds, camouflage for streaks, or latency recipes designed to defeat a specific detector.
- Any claim that humanization makes automated play permissible under a platform's terms.

If a proposed behaviour only makes sense as detection evasion, it does not belong in the Human layer.

**Not in scope for this report:** importing, training, or vendoring a neural model. Everything below is implementable in the existing dependency-free JS layer.

---

## 3. Verified findings

### 3.1 Human move prediction is possible, and separate from playing strength

**Observed.** Maia (McIlroy-Young, Sen, Kleinberg, Anderson, KDD 2020) fine-tunes an AlphaZero-style network on human games and predicts human moves at **46–52.9%** top-1 accuracy across rating bins, versus roughly **33–41%** for depth-limited Stockfish across the same bins; a depth-limited Leela variant reaches at most about **46%**. The same paper's blunder-prediction network reaches **71.7%** balanced accuracy with board plus metadata, and **67.7%** with the board alone. [1]

**Inferred.** Playing strength and move-prediction accuracy are not the same axis. A strong engine is a *worse* model of a weak human than a weak human model is — the paper states directly that if the goal is to predict a weak player's moves, the strongest Stockfish still performs best among Stockfish variants, which is exactly the mismatch being corrected. Handicapping a strong engine by adding noise is therefore not equivalent to modelling a weaker player; it is a different generative process that happens to land near the same Elo.

**Observed.** Maia-2 (Tang et al., NeurIPS 2024) unifies rating levels in one model with skill-aware attention: average top-1 **53.25%** vs **51.39%** for Maia-1, perplexity **4.07** vs **4.67** bits, monotonic improvement across **27%** of Elo pairs versus **1%** for per-rating Maia models, trained on **169M** games (**9.1B** positions), **23.3M** parameters. [2]

**Inferred.** Coherence across adjacent rating levels is a distinct quality from peak accuracy, and it is the quality that matters when a bot must behave plausibly at *several* ratings rather than one. A per-rating discrete behaviour table will show discontinuities at bucket boundaries.

**Observed.** Per-player fine-tuning (McIlroy-Young et al., KDD 2022) improves move prediction by **4–5 percentage points**, but **requires roughly 5,000+ games**; at 1,000 games fine-tuning is *worse* than the untuned baseline (**0.497** vs **0.527** accuracy). [3]

**Inferred.** Personalization from a small sample is a real risk, not a free win. Any Nyx profile layer must shrink toward population defaults until it has enough observations.

### 3.2 Difficulty, not elapsed time, dominates error

**Observed.** Anderson, Kleinberg & Mullainathan (KDD 2016) analyse 24.6M FICS games plus ~880k grandmaster tablebase positions. Using "blunder potential" — the probability of blundering if a move is chosen uniformly at random — the paper reports balanced accuracy in the mid-70s from difficulty versus the mid-50s from skill and the low-50s from remaining time; the authors' KDD slides give **73%**, **54%** and **52%** respectively. Skill and time together reach about **63%** even when the position is held fixed. Blunder rate is roughly flat once more than ~10 seconds remain on the clock. [4]

**Inferred.** This is the most directly useful result for Nyx. It says three things:

1. **Errors are mostly a property of the position**, so a per-position hazard is the right *shape* of model.
2. **Remaining time has almost no effect in the normal range** — the current `errorScale` of 1.35 below 40 s and 1.7 below 15 s may be too aggressive relative to the evidence, and should be fitted, not asserted.
3. **Skill shifts the whole curve**, which is what a rating-conditioned model needs.

**What this does *not* establish.** It does not show that humans have no within-game dependence in error timing. The paper models error probability as a function of position, skill, and time; it does not test lagged autocorrelation of errors, and a position-dominant model is compatible with whatever residual correlation exists. It also does not license "humans don't do that" about any specific design. Citing it against a per-game budget is an argument by analogy, and should be labelled one.

**Hypothesis.** Anderson's flat-rate-above-10 s result is for FICS blitz, where 10 s is a meaningful fraction of the clock. The flat region may be narrower in rapid/classical, where a player with 20 minutes left genuinely has more room to calculate. This is worth testing, not assuming.

### 3.3 Time allocation follows value of computation

**Observed.** Russek, Acosta-Kane, van Opheusden, Mattar & Griffiths (Cognitive Science 2025, 49(10):e70119) analyse **12.49M** games / **519M** moves from Lichess 2019, restricted to plies 15–75. Move time increases with the estimated benefit of deeper search ΔUC, with regression estimates between **1.76 and 38.7 s per 1 ΔUC** across the 11 default time controls (all p < 1e-50); for a 60 s game, mean move time changes by about **0.67 s** as ΔUC goes 0→0.4, and for a 600 s game about **6.7 s**. The relationship is **concave** (√ΔUC fits better than ΔUC, ΔAIC ≈ 3.6e8), grows with initial time and increment, and is stronger for stronger players. [5]

**Inferred.** The authors call the effect "quite large," and their own numbers support that for short time controls — 0.67 s is a substantial share of a bullet move. The fitted slope spans a factor of about 20 across time controls, so no single characterisation holds uniformly. The defensible summary is narrow: **ΔUC shifts the mean of a heavy-tailed distribution; it is not the whole of it.** The internal restriction to plies 15–75 also means the result says nothing about opening or late-endgame move times, which is exactly where Nyx would most want to apply it.

**Observed.** Sunde, Zegners & Strittmatter (PNAS 2026, 123(20):e2531472123) analyse **>215,000** moves from ~3,600 over-the-board games between players rated **≥2500** (classical ~80k moves / ~1,500 games from 2014–2017; rapid >62k / >1,000; blitz ~74k / ~1,200). After controlling for computational complexity, distinctiveness of alternatives, and remaining time, **faster decisions are associated with higher decision quality**. Greater complexity and lower distinctiveness lengthen decisions; greater time pressure shortens them; all three factors are associated with lower quality. The negative time–quality association is described as more pronounced when time pressure is high. [6]

**Inferred.** The result is **observational and associational**. The paper's own language is "associated with" throughout, and its interpretation is that decision time reflects *subjectively perceived* difficulty — a common cause — rather than that deliberation causes error. Two things that are easy to conflate and must not be:

- **"Having time" helps.** More remaining clock → better moves.
- **"Spending time" is a signal of difficulty**, not a demonstrated cause of error. A player who takes 40 s on a move is usually stuck.

Therefore: **do not build a model where long deliberation causes an error.** Build one where hard positions drive both long deliberation and elevated error rate, so the correlation emerges from a shared cause. The current `thinkTime` has no such coupling, and adding "if you thought long, blunder more" would encode the opposite of the paper's interpretation.

**Limit on transfer.** Sunde's population is 2500+ professionals in classical/rapid/blitz over the board. The direction of the association may not extend to a 1200 player in 10+0 online, and nothing in the paper bounds that extrapolation.

### 3.4 Openings are a stable identity, not a rotation

**Observed.** Chowdhary, Iacopini & Battiston (Scientific Reports 2023) analyse **123M** Lichess blitz games from **0.98M** players (2013–2016). Players show hot streaks, longer for beginners; cold streaks are longer still. Skilled players specialize and repeat the same openings while beginners diversify; opening diversity **decreases over a career**. Players are frequently unable to identify their own most successful openings. [7]

**Inferred.** A repertoire is an identity that consolidates. `weightedPick`'s 8–12 game 0.2 penalty models the opposite behaviour: it enforces variety, which is the beginner pattern, applied uniformly at every rating.

**Observed.** Rosenthal (Harvard Data Science Review 2025) examines **57,421** Hikaru games and finds autocorrelation of excess score at non-zero lags "extremely close to zero" — **no overall hot-hand effect**; long streaks are consistent with independent games at the observed rating gaps. [8]

**Inferred.** Chowdhary's hot/cold streaks and Rosenthal's null result are not necessarily in conflict: Chowdhary measures streak *lengths within a career*, Rosenthal measures *lagged autocorrelation of excess score* in one player's record. Both are descriptive of different quantities. The practical implication is a caution, not a prohibition: **a hard-coded escalating tilt term is not supported by the cited evidence at the population level.** Streaks are adequately explained by variance plus opponent selection.

**Proposal.** If any within-session form factor is retained, it must be (a) small, (b) shared across a session rather than escalating after each error, and (c) justified by a measured effect in Nyx's own data, not by intuition.

### 3.5 Individual style is highly identifiable — and that is a warning

**Observed.** Behavioural stylometry (McIlroy-Young et al., NeurIPS 2021) identifies a player among thousands with **98%** accuracy from **100** games. The companion KDD 2022 paper reports **98.3%** stylometry accuracy from personalized models, and **98.9%** using only blunder patterns. [3][9]

**Inferred.** Make no claim that a profile layer makes play "less identifiable." Behavioural identity is strong and cheap to extract. The purpose of the profile layer is *consistency and plausibility*, not concealment.

### 3.6 Data and licensing

| Resource | Content | License / terms |
| --- | --- | --- |
| Lichess standard database | Monthly PGN dumps, CC0 | [10] |
| Lichess puzzle database | **6,193,530** puzzles, **417,862,375** evaluated positions, with themes | [10] |
| Maia-1 code and weights | Reference implementation | **GPL-3.0** [11] |
| `maia-individual` | Fine-tuning pipeline | GPL/AGPL-3.0 family per repo metadata and README — ambiguous, verify before reuse [12] |
| Maia-2 code | Reference implementation | **MIT** [13] |
| Chess.com game data | Not covered by an open license | Do not assume permissive use |

**Inferred.** Building on Lichess is licence-clean; building on Chess.com data is not, absent explicit permission. Maia-1 and `maia-individual` are copyleft — reading their papers is fine, importing their code into Nyx is not, unless Nyx adopts a compatible license.

---

## 4. What this means for the current implementation

| Current behaviour | Location | Concern (hypothesis unless stated) | Direction |
| --- | --- | --- | --- |
| Per-game hard-error budget (~10%/eligible move until spent) | `docs/humanization.md:48-51` | **Hypothesis:** a finite cap can induce dependence on how many errors were already spent and how many eligible moves passed; magnitude unmeasured. **Also a deliberate product control.** | Add hazard mode as an alternative; keep explicit count controls |
| Soft errors at 25–180 cp, ~16% of eligible moves | same | Centipawn bands have unstable meaning across positions | Win-prob-loss buckets, after calibration (§5.1) |
| Hard errors 300–900 cp (Major) / 80–450 (Mixed) | same | Same, plus "major" is not rating-conditioned | Win-prob-loss threshold per rating bucket |
| Near-best sandbag 24–38 cp at max Elo | `docs/humanization.md:44-47` | Fixed cp allowance regardless of phase or eval | Small win-prob-loss sample; 0 in forced/trivial positions |
| `errorScale` 1.35 / 1.7 under 40 s / 15 s | `src/human.js:392` | Asserted thresholds; evidence suggests the position effect is larger | Fit from Nyx's own logged games or Lichess subsets |
| `thinkTime` additive pause + mood quantiles | `src/human.js:364-380` | Position-blind; "mood" is an unexplained mixture | Sampled duration, mean includes a ΔUC term and clock |
| `clockPlan` horizon 40/30/22, 0.4/0.6 split | `src/human.js:382-394` | Horizon is a constant, not an expected-moves estimate; pause is *added to* search rather than being the total | Expected-moves model per time control; search is a subset of total think time |
| `endgamePlan` drift 10–45 cp when winning | `src/human.js:320-345` | **Hypothesis:** drift may throw won positions more often than comparable humans do; unmeasured | Gate drift by win probability; zero in tablebase-won positions |
| `createOpeningMemory` 0.2 recency penalty | `src/human.js:237-256` | Enforces variety, which is the beginner pattern; effect on realism unmeasured | Stable repertoire distribution with slow drift |
| Session/time-of-day pacing, rematch declines | `src/human.js:108-147` | No cited evidence; harmless invented texture | Keep as optional, label as invented |
| Coach shares the error roll; imperfect advice disclosed | `docs/coach-mode.md:335-337` | Correct as designed, and matches an explicit product requirement | **Preserve unchanged** |

Two structural notes:

**Search time and think time are not the same quantity.** In the current design, wall time is `engineSearchTime + humanPause`. A human's wall time *is* their think time; the engine's search is an implementation detail that must fit inside it. Inverted, the pause becomes a function of how long the engine happened to run, which is neither human nor stable across hardware. Fixing this is prerequisite to any credible timing model.

**The error budget and the clock plan are coupled but modelled independently.** A player short on time plays worse; the current code expresses this twice — once as `errorScale`, once via the pause being truncated. These should read one shared `effective_thinking_budget` latent rather than two independent proxies.

---

## 5. Proposed architecture

The three responsibilities below are deliberately **coupled through named latents** rather than isolated. Isolation would make the layers testable but unrealistic; the goal is that any coupling is visible and adjustable, not that coupling is absent.

```
latents (per move, computed once)
  difficulty        share of legal moves losing > τ win-prob
  delta_uc          win-prob gap between shallow and deep best move
  budget            remaining clock / expected moves left
  form              slow session offset, shrunk toward 0

policy  = f(difficulty, form, rating)
clock   = g(delta_uc, budget, difficulty, time_control)
profile = h(historical counts)   // slow, persisted
```

### 5.1 Policy layer: position-conditioned hazard

**Proposal.** Offer a per-move hazard alongside the existing count-based budget, rather than replacing it outright.

```
p_error = sigmoid( b_rating
                 + b_difficulty * difficulty(position)
                 + b_pressure   * time_pressure(clock, moves_left)
                 + b_phase      * phase_weight )
```

- `difficulty(position)` is the share of legal moves that lose more than τ win probability — Anderson's blunder potential, computed from the engine's own root list. Nyx already has the root list; this is nearly free.
- `time_pressure` should be a smooth function of remaining time relative to expected remaining moves, not an absolute seconds threshold.
- `b_rating` is fitted so that the *aggregate* error rate matches the target rating's observed rate. That aggregate number is the one quantity that must be right; the rest shapes where the errors land.

Then sample the error magnitude from a win-probability-loss distribution, not a cp band:

```
loss_bucket = categorical(p_by_bucket)   # e.g. 0.02-0.05, 0.05-0.10, 0.10-0.20, 0.20+
```

and pick the legal move whose loss falls in that bucket, closest to the bucket centre. If no move exists in the bucket, fall back to the nearest bucket — never to "any move."

### 5.1a Win-probability loss is not free

This proposal has a calibration problem that must be stated plainly:

- **Engine WDL is not human win probability.** Stockfish's win/draw/loss model is fit to engine self-play or to a chosen mapping. Using it as a stand-in for "how bad does this feel to a 1400 player" is an assumption.
- **A human mapping must be fitted, per rating band and per time control**, from games where the outcome is known and the position is evaluated. Russek et al. did exactly this for their own study: they fitted logistic regressions mapping centipawns and mate distance to the probability that the side to move won, using only 300+0 and 600+0 checkmate games with both players over 60 s remaining [5]. That is a reasonable template, and its filters also show the limits — a mapping fitted on 300+0 does not automatically transfer to 60+0.
- **Different mappings give different error sizes.** Illustratively, a 200 cp loss might be 0.15 win probability in a sharp position and 0.04 in a locked one — those numbers are invented for the example, not measured. The point stands regardless: bucket boundaries are mapping-dependent and must be reported with the calibration they came from.
- **Until calibrated, this remains a proposal, not an improvement.** If calibration cannot be done for a given rating band, the honest fallback is to keep centipawn bands and say so.

**Why this is still worth testing:** it makes errors a function of the position, which is where the evidence puts most of the signal; it removes the *mechanism* that could produce artificial dependence across moves; and it scales across phases without special-casing, because win probability already knows whether you are winning.

**What it costs:** a configured "3 hard errors this game" setting is no longer directly expressible. That control is a real product requirement, so the hazard should ship as an additional mode with the count-based budget retained and documented as the deliberate, less realistic option.

**Proposal.** Keep a per-game cap only at the far tail (e.g. suppress the 99.5th percentile), and record when it fires. If it fires often, the hazard is miscalibrated and the cap is hiding a bug.

### 5.2 Clock layer: value-driven duration, clock-clipped

```
think_ms = quantile_sample(
    lognormal_mixture(
        mu    = mu_base + b_value * delta_uc(position)
                     + b_phase * phase
                     - b_clock * log(remaining / expected_moves_left),
        sigma = sigma_base
    ),
    time_control
)
think_ms = min(think_ms, clock_budget(remaining, moves_left, increment))
```

- `delta_uc(position)` is the practical proxy for Russek's ΔUC: the win-probability difference between the engine's best move at shallow and at full depth, or between best and second-best. Nyx can compute both from the root list at negligible cost.
- `expected_moves_left` comes from an empirical distribution per time control, not a constant. `clockPlan`'s 40/30/22 horizons become fitted values.
- The **engine's own search must then be limited to `think_ms` minus a fixed rendering/input margin**, so total wall time is the sampled duration.
- Sample from the distribution rather than adding a "mood" offset. Heavy tails are what produce the occasional 30-second think; they do not need a separate branch.

**Proposal.** Keep the existing bounded tempo mirroring (`createTempo`) only if testing shows it improves realism. It has no direct support in the cited literature, and mirroring an opponent's tempo is a weak prior.

### 5.3 Profile layer: small, shrunk, persistent

A profile should be **5–8 parameters**, not a behavioural fingerprint:

1. Preferred first-move family per colour (1.e4 / 1.d4 / 1.c4 / 1.Nf3).
2. Repertoire concentration (Dirichlet α; low α = narrow repertoire).
3. Base think time multiplier.
4. Error-rate multiplier.
5. Aggression bias (trade propensity / pawn-storm propensity).
6. Endgame technique offset.
7. Resign threshold.
8. Time-scramble tolerance.

Fit by shrinkage:

```
estimate = (n * observed + k * population_default) / (n + k)
```

with `k` large enough that a handful of games moves the profile very little. This directly encodes the KDD 2022 result that ~1,000 games is *not enough* to personalize and ~5,000 is.

**Proposal.** Store the repertoire as counts over opening prefixes, then sample the next game's line from `Dirichlet(counts + α·prior)`. Recent-game recency penalties should be removed. Slow drift — a player gradually narrowing their repertoire — can be added as a decay toward the most-played line, which matches Chowdhary's career-stage finding.

### 5.4 Endgames

**Proposal.** In positions with ≤7 pieces where a tablebase is available:

- If the position is won, do not inject win-probability loss beyond a small threshold. **Hypothesis:** a 1500 player winning KQ vs K rarely throws the result, though they may take 20 extra moves — a *time* error, not a *result* error. E9 tests this rather than assuming it.
- If the position is drawn, model the draw-preservation rate as a function of rating rather than injecting random drift.
- If the position is lost, resignation and "play on and hope" are both realistic; the current `shouldResign` shape (score threshold + move count + a rating term) is reasonable. Validate the threshold against Lichess data rather than asserting −900 cp.

### 5.5 Keeping the coach imperfect

`docs/coach-mode.md:335-337` already discloses that a suggestion may be a practice suggestion when the controller requested a human-style error. That is the correct design and should not be removed. Two small improvements, both optional:

- Make the disclosure *specific*: name the configured difficulty band rather than "the configured difficulty."
- When the coach's suggestion is an intentional error, report the expected win-probability loss so a learner can see the size of the mistake.

Neither changes the DTO contract.

---

## 6. Prioritized experiments

Each experiment has a decision attached. If the result is negative, the corresponding change should not be made.

**E1 — Error rate vs. position difficulty at fixed rating.**
Take held-out Lichess games in one rating band and one time control. Compute blunder potential per move from Stockfish root lists; regress actual blunder rate on it, with remaining time and move number as controls.
*Decision:* if the hazard shape holds (monotone, difficulty-dominated), adopt §5.1. If not, keep the current model and document why.

**E2 — Is the flat-above-10s result true for rapid?**
Same data, split by time control. Test whether blunder rate is flat above a threshold, and where that threshold sits per time control.
*Decision:* replaces `errorScale`'s hard-coded 40 s / 15 s.

**E3 — Motif-conditioned error rates.**
Join Lichess games to the puzzle database's theme tags (fork, pin, discovered attack, back-rank, etc.) by matching tactical patterns at the blunder point. Estimate per-motif error rates by rating band.
*Decision:* if motifs separate cleanly, add a motif term to the hazard. If they do not, do not build a motif taxonomy — this is currently an **evidence gap**, and the puzzle DB is the best large tagged resource for closing it.
*Caveat:* puzzle themes describe *puzzle* positions, which are selected for having a tactic. Transfer to ordinary game positions is an assumption, not a given.

**E4 — Time allocation model fit.**
Fit the lognormal mixture in §5.2 on Lichess move times, per time control and rating band. Report held-out negative log-likelihood and a QQ plot against human move times.
*Decision:* adopt only if it beats the current `thinkTime` on held-out likelihood.

**E5 — Coupling test: does the fitted duration model reproduce the observed time–quality correlation?**
Simulate with the model, then measure the correlation between generated think time and generated move quality. It should be negative and of similar magnitude to Sunde's, arising purely from the shared difficulty term.
*Decision:* this is the falsification test for §5.2. If the simulation shows no correlation, the duration model is not picking up difficulty and needs a better ΔUC proxy.

**E6 — Repertoire stability.**
Measure, in Lichess data at several ratings: the frequency of a player's modal first move, and the entropy of their opening set over a rolling window. Compare against a Dirichlet-sampled repertoire model.
*Decision:* sets the α parameter. Confirms whether recency penalties should be softened or kept.

**E7 — Dependence of error timing within a game.**
The claim to test is not "is lag-1 autocorrelation non-zero" but "is there a dependence that survives the obvious confounders." Design it as:

1. Compute per-move engine loss for both human and Nyx games.
2. Regress `error_t` on `error_{t-1}` with controls for **phase, move number, remaining clock, position difficulty, rating band, and game length**; note that conditioning on game length is itself a selection effect, because games truncate.
3. Handle selection explicitly: games that end early are not missing at random. Fit on games surviving to a common ply, and report how the estimate moves as the survival threshold changes.
4. Compare the *residual* autocorrelation in human data to the residual in Nyx output under the current budget.

*Decision:* three possible outcomes. (a) Human residual autocorrelation ≈ 0 and Nyx's is clearly negative → the budget's side effect is real and the hazard becomes the default. (b) Human residual autocorrelation is small but non-zero, or Nyx's is small → the side effect is not worth the cost of rebuilding, and the count budget stays. (c) The estimate is unstable across survival thresholds → the experiment is inconclusive and no change follows.

**Note on what E7 cannot decide.** Even a clear negative result does not make the count budget "wrong." It makes it a *less realistic* option than the hazard. The count budget remains the correct implementation for a deliberate-error control, which is a stated product requirement. E7 informs the default, not the menu.

**E8 — Personalization sample size.**
Reproduce the KDD 2022 sample-size curve on Lichess data with a *simple* model (no fine-tuning): how many games before a shrunk profile beats the population default on held-out move-matching?
*Decision:* sets the shrinkage constant `k`.

**E9 — Endgame conversion by rating.**
Measure win/draw conversion rates in won and drawn ≤7-piece endgames by rating band, plus moves-to-convert.
*Decision:* sets the endgame error thresholds, replacing the current drift constants.

Ordering: **E7 and E1 first** (they test the core claims), then E4/E5, then E3 (highest cost), then the rest. If E7 is inconclusive, the count budget stays as the default and the hazard ships as an opt-in mode.

---

## 7. Evaluation metrics

Two families, kept strictly separate.

**Human-likeness (does it resemble the population?)**

- Top-1 move-matching accuracy against held-out human moves, per rating band and time control.
- Negative log-likelihood / perplexity of human moves under the model's distribution — a sharper measure than top-1, because it penalizes overconfidence.
- Distributional distance between generated and human think times (KS or Wasserstein), per time control.
- Error-rate calibration: predicted vs. actual blunder rate by difficulty decile.
- Repertoire entropy and modal-opening frequency vs. human distributions.
- Win-probability-loss distribution per game, compared to human games at the same rating.

**Playing strength (is it rated correctly?)**

- Elo from games against a fixed engine ladder, per configuration.
- Result distribution vs. rating-matched opponents.
- Conversion rate in won positions; drawing rate in drawn positions.

**A caution.** These are different claims. A model can match human move distributions while being 300 Elo stronger, because move-matching rewards plausibility and strength rewards correctness. **Report both, never one as evidence for the other.** This is the single most common mistake in this literature's popular summaries.

**Held-out design.** Per rating band and per time control, hold out whole players, not whole games. Holding out games from a player who also appears in training leaks repertoire and style. Report per-band results, not a pooled average — a model that is excellent at 1500 and bad at 2200 should not be reported as "good."

---

## 8. Licensing and provenance

- **Lichess database:** CC0. Safe to use for research and for derived statistics. Attribute anyway.
- **Lichess puzzle database:** CC0, themes included. The best available tagged corpus for E3.
- **Maia-1:** GPL-3.0. Papers are citable; code and weights are not importable into a non-GPL project.
- **`maia-individual`:** GPL/AGPL-3.0 family — the repo's metadata and README are inconsistent. Treat as copyleft and verify before any reuse.
- **Maia-2:** MIT. Code is importable in principle, but this report recommends against importing a model at all; the value is in the *findings*, not the weights.
- **Chess.com data:** no open license. Do not assume permission.
- **Engine evaluations:** Stockfish is GPL-3.0; using its evaluations as labels for research is normal practice, but redistributing modified engine code would carry the license.

**Provenance discipline for E1–E9:** record the exact database dump month, the filter (rating band, time control, minimum moves), the engine version and depth, and the random seed. Lichess dumps are monthly and mutable across releases; an unreproducible filter is not a result.

---

## 9. Limits and uncertainties

**Rating labels are not portable.** Lichess and Chess.com ratings are explicitly not comparable, and each platform's rating is time-control-specific. Maia-1 was trained on Lichess 1100–1900; Maia-2 covers roughly 0–2000+ on Lichess rapid. **Any Nyx behaviour tuned to a Lichess band is not thereby correct for a Chess.com band of the same number.** Calibrate per platform, or present the rating as a Nyx-internal difficulty level and say so.

**Human diversity is large.** Every aggregate in §3 is a population average. Two 1500 players can have very different error profiles. A single "1500 model" is a centroid, and will be wrong about individuals in both directions.

**Sampling bias.** Lichess users are not all chess players; online blitz is not classical; games that reach move 40 are not a random sample of games. Anderson's FICS data is from an earlier era with different time-control norms. Sunde's data is professional over-the-board, which is the opposite end of the population from a typical bot's opponents. **Each source informs a different part of the curve; none of them alone covers the range Nyx needs.**

**The time–quality result is correlational.** Sunde's design controls for complexity and remaining time, but a within-player regression cannot rule out an unobserved "this player is having a bad day" factor. The paper is careful about this; a reimplementation should be equally careful about causal language.

**Motif-conditioned error rates are an evidence gap.** I found no primary source that estimates human blunder rates *by tactical motif* at scale. E3 is therefore original research, not replication, and its result could be null.

**No guarantees.** Nothing here makes automated play appropriate on a platform whose rules forbid it, and nothing here should be described as doing so.

**Calibration is the weakest link in the win-probability proposal.** Any human win-probability mapping is fitted on a particular population, time control, and engine version. Reusing one across rating bands or formats is an assumption that will be wrong somewhere, and the error is silent — the model still produces plausible-looking numbers.

**What would change the recommendation.** If E7 shows humans exhibit meaningful residual error dependence within a game even after controlling for position, phase, clock, and survival, the count budget's side effect is less of a discrepancy and the rebuild is not justified on realism grounds. If E1 shows remaining time dominates difficulty at Nyx's operating range, the hazard should be clock-first rather than position-first. If calibration for a rating band is not feasible, the win-probability unit should be dropped for that band rather than estimated loosely. All three are plausible; none is what the currently cited evidence suggests.

**Two things this report deliberately does not conclude.** That the count budget should be deleted. That the current clock coupling is wrong in direction — only that it is expressed twice without a shared variable.

---

## 10. Sources

1. McIlroy-Young, R., Sen, S., Kleinberg, J., Anderson, A. *Aligning Superhuman AI with Human Behavior: Chess as a Model System.* KDD 2020, pp. 1677–1687. DOI [10.1145/3394486.3403219](https://doi.org/10.1145/3394486.3403219). Preprint: [arXiv:2006.01855](https://arxiv.org/abs/2006.01855). PDF: [cs.toronto.edu/~ashton/pubs/maia-kdd2020.pdf](https://www.cs.toronto.edu/~ashton/pubs/maia-kdd2020.pdf).
2. Tang, Z., Jiao, D., McIlroy-Young, R., Kleinberg, J., Sen, S., Anderson, A. *Maia-2: A Unified Model for Human-AI Alignment in Chess.* NeurIPS 2024. DOI [10.52202/079017-0659](https://doi.org/10.52202/079017-0659). Preprint: [arXiv:2409.20553](https://arxiv.org/abs/2409.20553). Proceedings PDF: [proceedings.neurips.cc](https://proceedings.neurips.cc/paper_files/paper/2024/file/250190819ff1dda47cd23cecc0c5a69b-Paper-Conference.pdf).
3. McIlroy-Young, R., Wang, R., Sen, S., Kleinberg, J., Anderson, A. *Learning Models of Individual Behavior in Chess.* KDD 2022, pp. 1253–1263. DOI [10.1145/3534678.3539367](https://doi.org/10.1145/3534678.3539367). Preprint: [arXiv:2008.10086](https://arxiv.org/abs/2008.10086).
4. Anderson, A., Kleinberg, J., Mullainathan, S. *Assessing Human Error Against a Benchmark of Perfection.* KDD 2016, pp. 705–714. DOI [10.1145/2939672.2939803](https://doi.org/10.1145/2939672.2939803). Preprint: [arXiv:1606.04956](https://arxiv.org/abs/1606.04956). Slides: [cs.toronto.edu/~ashton/slides/chesserrors-kdd2016-slides.pdf](https://www.cs.toronto.edu/~ashton/slides/chesserrors-kdd2016-slides.pdf).
5. Russek, E. M., Acosta-Kane, D., van Opheusden, B., Mattar, M. G., Griffiths, T. L. *Time Spent Thinking in Online Chess Reflects the Value of Computation.* Cognitive Science 49(10):e70119, 2025. DOI [10.1111/cogs.70119](https://doi.org/10.1111/cogs.70119). Open access: [PMC12553403](https://pmc.ncbi.nlm.nih.gov/articles/PMC12553403).
6. Sunde, U., Zegners, D., Strittmatter, A. *Speed and quality of complex strategic decisions.* PNAS 123(20):e2531472123, 2026. DOI [10.1073/pnas.2531472123](https://doi.org/10.1073/pnas.2531472123). PubMed: [42127104](https://pubmed.ncbi.nlm.nih.gov/42127104).
7. Chowdhary, S., Iacopini, I., Battiston, F. *Quantifying human performance in chess.* Scientific Reports 13:2113, 2023. DOI [10.1038/s41598-023-27735-9](https://doi.org/10.1038/s41598-023-27735-9). Open access: [PMC9902564](https://pmc.ncbi.nlm.nih.gov/articles/PMC9902564).
8. Rosenthal, J. S. *An Investigation Into Probabilities of Streaks in Online Chess.* Harvard Data Science Review 7.2, 2025. DOI [10.1162/99608f92.6939122d](https://doi.org/10.1162/99608f92.6939122d). [hdsr.mitpress.mit.edu/pub/ex6vbavk](https://hdsr.mitpress.mit.edu/pub/ex6vbavk).
9. McIlroy-Young, R., Wang, Y., Sen, S., Kleinberg, J., Anderson, A. *Detecting Individual Decision-Making Style: Exploring Behavioral Stylometry in Chess.* NeurIPS 2021. [proceedings.neurips.cc](https://proceedings.neurips.cc/paper/2021/hash/ccf8111910291ba472b385e9c5f59099-Abstract.html). Preprint: [arXiv:2208.01366](https://arxiv.org/abs/2208.01366).
10. Lichess. *Database* (standard games, CC0) and *Puzzle database.* [database.lichess.org](https://database.lichess.org/).
11. CSSLab. `maia-chess` — GPL-3.0. [github.com/CSSLab/maia-chess](https://github.com/CSSLab/maia-chess).
12. CSSLab. `maia-individual` — GPL/AGPL-3.0 family per repo metadata and README. [github.com/CSSLab/maia-individual](https://github.com/CSSLab/maia-individual).
13. CSSLab. `maia2` — MIT. [github.com/CSSLab/maia2](https://github.com/CSSLab/maia2).

**Internal references:** `docs/humanization.md` (current behaviour, and the out-of-scope detection-surface list at 108–138); `src/human.js` (`thinkTime` 364–380, `clockPlan` 382–394, `endgamePlan` 308–345, `shouldResign` 347–362, `createOpeningMemory` 160–259, `createTempo` 398–421); `docs/coach-mode.md:335-337` (practice-suggestion disclosure to preserve).
