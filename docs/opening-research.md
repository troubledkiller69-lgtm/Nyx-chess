# Opening selection: evidence summary and proposal

Research note. No production changes, no benchmarks, no strength claims. Facts are attributed;
inference is **Inference**; recommendations are **Proposal**.

**Access note.** `/masters` and `/lichess` on `explorer.lichess.org` returned `401` here on
2026-11-01. The published OpenAPI spec lists `OAuth2` for both endpoints, and lila commit
`cc9d8d9` (2026-03-02) gates the explorer UI on login. No official statement covering every
anonymous use was found, so this is an observed constraint, not a policy claim. Counts must come
from a token or the CC0 dumps (§7); none were invented.

## 1. Evidence

**1.1 First-move advantage, as score.** Chessgames.com 2015 (via Wikipedia), master/OTB,
n = 739,769: W 37.50 / D 34.90 / L 27.60 → 54.95%. Sonas 2002, equal-rating intercept,
n = 266,000: 54.18%. Milvang, FIDE 2020, equal-rated ±5, ~4M games (per a citing paper):
34.42 / 36.19 / 29.39 → ≈52.6%. Wilson 2014, both >2199, n = 685,184: ≈54% before confound
control. Different populations and estimators — do not pool. The FIDE split is the cleanest
anchor: about a third drawn, White winning ~5 points more often than Black.

**1.2 Frequency, and why "d4 beats e4" is a selection effect.** Chess.com blog, 5,025,077 games,
provenance unpublished — secondary, illustrative: 1.e4 50.3% / 53.3% / 29% draws, 1.d4 31.8 /
54.8 / 32, 1.Nf3 7.8 / 55.2 / 35, 1.c4 7.0 / 54.5 / 33, 1.h3 0.008% (399 games) / 45.2 / 24.
Frequency is heavy-tailed: Blasius & Tönjes (*PRL* 103, 218701, 2009) fit a Zipf law, exponent
≈ −2, over 1.5M ScidBase games (1.e4 45%, 1.d4 35%); a Lichess sample reports 1.e4 65%, 1.d4
24%, 1.c4 3% (*Sci Rep* 13:5577).

Wilson found d4 scoring 52.7–56.3% and e4 52.3–54.7% in all eight of his databases, then showed
why: in 1.e4 games Black averaged **6.32 Elo higher**; in 1.d4 games White averaged **6.78
higher**. Binning 685,184 games (>2199) by rating gap in 1-point steps and testing within bins,
the null of equal scores was not rejected: **p = 0.9633**. **Inference:** every raw opening score
carries the strength of the players who choose the line, so comparisons must condition on rating
gap or band.

**1.3 Rating and clock.** Opening complexity correlates with rating (ρ = 0.64); low-rated players
concentrate on low-complexity openings; theory matters least in bullet, most in blitz (*Sci Rep*
13:5577). In 76,562 games from 2008 the weaker player deviated from theory first (χ² = 345.89,
p < .01); masters were estimated at ~100,000 opening moves (*PLOS ONE* 6(11): e26692). Cook
(*ICGA Journal*, DOI 10.1177/13896911251315903) covers amateur rating bands; abstract only, so no
numbers are quoted here.

Draw rates: OTB classical 1500+, 23.6% (2015–2020) → 27.7% (2021–2023), White −1.7pp, Black
−2.5pp (arXiv:2606.12893, 3.92M games); CEGT 30.9% at 40/4 → 41.3% at 40/120, CCRL 31.0% →
37.2% (chessprogramming.org); across 2,122,944 CCRL games ~22% at 2000 Elo rising to ~88.5% at
3650 (beuke.org). **Inference:** at short clocks and modest strength decisive games dominate —
background, not a licence to prefer risky lines.

## 2. What the evidence does not support

A universal best opener (chess is unsolved; e4 and d4 are not separable at p = 0.9633; eight
databases disagree by up to 2.2 points for the same move and do not agree on marginal rankings).
Opening score as position quality (it is a joint statistic of position and pool, §1.2). Transfer
of human opening data to Nyx (different populations, clocks, bands, dates — and Nyx is not a
human). Supported claim form: *within a stated population, band, clock and date window, with
stated controls, system A scores differently from B by a stated margin and interval.*

## 3. Bias checklist

- **Player selection** — a line inherits the strength of its adopters (±6–7 Elo); stratify by
  rating gap or compare within one band.
- **Bucket ≠ range** — Lichess `ratings` are lower-bounded buckets (`0` = 0–999, … `2500` =
  2500+); multiple picks are a union. Select exact buckets, never "1600+".
- **Time control, database, nesting** — filter `speeds`; never pool Lichess online games with the
  curated OTB masters set; count games at the root, since a game appears once per tracked position.
- **Win% vs score, comparisons, recency** — report W/D/L with score = W + D/2; 20 first moves at
  α = .05 gives FWER 64%, so pre-register and use Bonferroni α = .0025; date-window, since OTB
  draws moved +4pp after 2020.

## 4. What the evaluator does (corrected)

`EVAL_FEATURE_MASK = 0` disables the *optional* terms — passed pawns, pawn-race endgame logic,
mobility, pins, king danger, hanging pieces. It is **not** a material-only evaluator. Always
active: tapered material and PSQT, bishop pair (+28 mg / +42 eg), doubled and isolated pawn terms,
dead-position draw detection.

**Inference, not established:** at ply 1 the bishop-pair, pawn-structure and dead-material terms
are identical across all twenty moves, so the discriminating signal is the search score, dominated
at that depth by PSQT plus shallow tactics. A near-tie among first moves is plausible; that is not
proven, and it does not prove that sampler tie-breaking produced the observed distribution.

**Proposal, do first:** from the start position, call `think()` for each of the twenty legal first
moves at fixed depth with `variety: 0`, over several seeds, logging root score and PV. What
follows narrowly: the opening is a phase where this evaluator has little to say, so a book is a
reasonable place to hold opening knowledge (**Proposal**). Whether early material concessions score
badly is a hypothesis, not a finding (§6.2).

## 5. The 80-game result

**Observed:** across 80 varied short-time self-play games, 1.h3 was the most frequent first move.
Nothing else was measured. **Not supported:** any explanation of why — the games were varied and
time-limited, so sampler and search noise both contribute; "tie-break artefact" is speculation
until root scores are logged.

**Dependence.** Self-play games share one evaluator, one start position and often the same lines,
so they are not independent draws from a population of games; effective sample size is below 80 by
an unknown amount, and intervals computed as if n = 80 are optimistic. **Arithmetic** — two-sided
two-proportion test, α = 0.05, power 0.80, independent games, equal arms, 50% baseline: 55% vs 50%
needs ~1,565 games per arm, 52% vs 50% ~9,807, 51% vs 50% ~39,240; for one proportion at n = 80,
p = 0.5, the 95% normal-approximation half-width is ±11.0pp. Dependence makes these lower bounds.

**Practical reading:** 80 self-play games can catch crashes, illegal book moves and handoff
blunders. They cannot rank openings.

## 6. Proposals

**6.1 Repertoire as a conditional tree.** Shares are within their own branch. **Status: style and
fit, not measured superiority** — published differences between mainstream systems sit inside the
confound of §1.2. The 60/25/15 and 70/30 splits are conservative defaults, not estimates.

*White, first move:* 60% 1.e4 · 25% 1.d4 · 15% 1.Nf3 or 1.c4 (transpose into the other two).
*After 1.e4:* 1...e5 → Italian Pianissimo (`Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6`); 1...c5 → Alapin
(`c3 Nf6 e5 Nd5 d4`); 1...e6 → Exchange French (`d4 d5 exd5`); 1...c6 → Exchange Caro
(`d4 d5 exd5`); 1...d5 → Exchange (`exd5 Qxd5 Nc3`); 1...Nf6 → `e5 Nd5 d4`. *After 1.d4:*
1...d5 → London (`Bf4 Nf6 e3 e6 Nf3 c5 c3`) or QGD Exchange (`c4 e6 Nc3 Nf6 cxd5 exd5`);
1...Nf6 → London.

*Black:* vs 1.e4 — 70% 1...e5 (Italian mirror, or Petrov `Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5`),
30% 1...c6 Caro–Kann (`d4 d5 e5 Bf5 Nf3 e6 Be2 c5`). vs 1.d4 — 70% 1...d5 (QGD/Slav), 30%
1...Nf6 → Nimzo/QID (`c4 e6 Nc3 Bb4 e3 O-O Bd3 d5`). vs 1.c4 or 1.Nf3 — 1...e5 or 1...d5.

**Gambits:** no blanket removal. `openings.js` is rich in them (King's Gambit, Evans, Danish,
Smith–Morra, Halloween, Traxler, Benko, Budapest, Albin, Englund, Latvian). Fit for this evaluator
is unknown until tested.

**6.2 Tests before removing or keeping a line.** (1) *Root-score diagnostic* (§4). (2) *Handoff
audit* — play each line, then search the exit; record eval, material balance and first non-book
move; flag exits beyond ±80 cp or where the engine's own move swings eval >100 cp (conventions,
not measurements). (3) *Gambit A/B* — paired colour-swapped games, gambit vs material-balanced
alternative, same build, seeded, sized per §5; if the effect is under ~2 points the test cannot
resolve it, so decide on style grounds and say so. (4) *Distributional check* — first-8-ply
distribution vs the target band's Lichess distribution by total-variation distance; monitoring
only, since TV < 0.1 on 20 categories needs thousands of games.

## 7. Sampling method

**Data.** Lichess monthly dumps (CC0): standard, rated, blitz/rapid, both players in band, last
12 months, ≥10 plies. Accumulate `count[move]` and per-move W/D/L over the first 12 plies, keyed
by position so transpositions collapse. **Weights:** frequency first, because it is the least
confounded statistic — `w(m) = count[m]^gamma` with gamma 0.6–1.0 (1.0 reproduces the human mix),
optionally multiplied by `exp(lambda*(score_hat - 0.5))` where
`score_hat = (wins + 0.5*draws + a)/(n + 2a)`, `a = 4`, and `lambda = 0` by default because the
score term reintroduces §1.2 bias. **Structure:** sample one system per game
(`p ∝ exp(beta·log freq)`, beta = 1) and follow its tree; on deviation jump to the nearest book
position by FEN, else exit — per-move resampling across systems produces incoherent games and is
itself a pattern. **Anti-repeat:** decay penalty on recently seen first-8-ply
sequences; cap any first move at ~60% of a session; deterministic `bookSeed`. **Depth:** 8–12
plies for a 1200–1800 pool, since weaker players deviate early (*PLOS ONE* 2011).

## 8. Imported knowledge vs original code

Lichess dumps and `lichess-org/chess-openings` are imported data and labels, both CC0 (the dumps
explicitly permit commercial use and redistribution); counts and W/D/L derived from them are
imported facts with original computation. The Lichess **masters** database is curated OTB,
OAuth-gated and not redistributable — reference only, do not ship. Lines in `src/openings.js` are
authored opening knowledge; the book builder, sampler, guards, evaluator and tests are original.

Record dump months, filters, row counts and a SHA-256 of inputs and generator in the generated
file. Do not build against the OAuth-gated API, and state in the README which lines came from
humans and which from the engine. `scripts/build-book.js` is original by construction; it records
the engine's preferences, not opening quality, and how closely its distribution resembles human
play is an empirical question — measure it (§6.2.4), do not assume it.

## Sources

Wilson 2014 <https://en.chessbase.com/post/1-e4-best-by-test-part-1> · Milvang 2020, FIDE
<https://spp.fide.com/wp-content/uploads/2020/11/2016-probability-of-the-outcome.pdf> · Sonas
<http://chessmetrics.com/cm/> (figures via Wikipedia, "First-move advantage in chess", which also
carries the Chessgames.com table) · Blasius & Tönjes 2009 <https://physics.aps.org/articles/v2/97>
· De Marzo & Servedio 2023 <https://www.nature.com/articles/s41598-023-31658-w> · Chassy & Gobet
2011 <https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0026692> · Cook, *ICGA
Journal* DOI 10.1177/13896911251315903 (abstract only) · arXiv:2606.12893 ·
chessprogramming.org <https://www.chessprogramming.org/Match_Statistics> · beuke.org
<https://beuke.org/chess-engine-draws/> · Lichess dumps <https://database.lichess.org/>; API spec
<https://github.com/lichess-org/api/tree/master/doc/specs/tags/openingexplorer> · Project:
`docs/execution-plan.md`, `docs/humanization.md`, `src/engine.js`, `src/openings.js`,
`scripts/build-book.js`
