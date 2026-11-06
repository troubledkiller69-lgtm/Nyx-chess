# Original evaluation development

> **0.6.7 release note:** this document describes the experimental evaluation
> terms. The measured 0.6.7 regression (33.3% over 144 games) led the release
> back to the 0.6.5 evaluation with the 0.6.7 search/infrastructure. The
> experimental terms below are not the current default evaluator. The same
> repaired build is now packaged as 0.6.8 with engine bytes unchanged. See
> `docs/benchmarks/rating/regression-0.6.7.md`, `docs/release-0.6.7.md`, and
> `docs/release-0.6.8.md`.

## Implemented

- Replaced the previously bundled PeSTO arrays and material weights with
  original, color-symmetric geometric formulas. No imported engine, weight
  file, service, or endgame database is used by the new evaluation.
- Pawn-safe mobility, absolute-pin restrictions, trapped-bishop penalties,
  unsupported-piece threats, and coordinated king-ring attacks.
- Supported knight outposts now check enemy pawns farther up adjacent files.
- Blockaded passer discounts, Chebyshev king distances, conservative promotion
  races with side-to-move and initial double pushes, non-rook-pawn key squares,
  opposition guidance, and rook-pawn corner discounts.
- Lone-king conversion guidance and exact dead-material evaluation for bare
  kings, lone minors, and two same-color bishops.

These are evaluation heuristics, not an endgame solver. Search still handles
legal moves, checkmate, and stalemate. Pawn-race bonuses do not prove a win:
other pawns can promote first, and the conservative interception test can miss
winning races. Pawn-safe mobility does not mean every counted square is safe
from every enemy piece.

## Reproducible measurement

Save the old `src/engine.js` outside the extension before editing. Then run:

```powershell
node scripts/engine-match.js C:\path\old-engine.js C:\path\match.json 8 100 200
node scripts/evaluation-bench.js C:\path\old-engine.js
```

The match uses eight handcrafted starting positions (six opening structures,
a pawn ending, and a rook ending), each with colors swapped. Games run
sequentially at equal per-move budgets in Ruthless mode. It checks move legality,
threefold repetition, fifty-move draws, conservative dead-material cases,
checkmate, and stalemate. A ply cap counts as a draw and is reported separately.
It never adjudicates a win using either contestant's evaluation.

The JSON stores engine hashes, hardware/Node details, all moves, terminal
positions, nodes, completed depths, elapsed time, and budget overruns. Three
basic tactical sanity positions are also compared. Approximate uncertainty is
computed over paired scores, not by pretending the two colors are independent.
Repeating the same eight starts does not create independent evidence; expand
the held-out starts before making a strong rating claim.
An optional final argument supplies a JSON array of `{name, fen}` or
`{name, moves}` records for a separate held-out starting-position suite.

To isolate the new evaluation terms from replacing the borrowed square tables:

```powershell
node scripts/evaluation-baseline.js C:\path\old-engine.js C:\path\weights-only.js
node scripts/engine-match.js C:\path\weights-only.js C:\path\ablation.json 8 100 200
```

The ablation generator is specific to the saved 0.6.5 layout and removes its
borrowed arrays. This generated engine is a measurement fixture, not an
extension resource. Keep benchmark JSON and baseline engines outside the ZIP.

## Initial result

The first candidate lost against 0.6.5: **2 wins, 6 draws, 8 losses** at
100 ms per move, eight color pairs, 200-ply cap (one capped draw). Score: 31.25%;
approximate paired 95% score interval: 15.9–46.6%. The corresponding point
estimate is -137 relative Elo, with substantial uncertainty and no absolute
rating interpretation.

That candidate averaged 9.12 completed plies versus 9.83 for 0.6.5, and roughly
378k versus 679k nodes/second across the match. Both had zero reported overruns.
It passed the three basic tactical sanity cases. This is evidence of a
regression, not evidence that more evaluation terms automatically mean strength.
Ray/king/knight targets were subsequently precomputed to reduce evaluation cost.

The precomputed-ray candidate versus the original-weights-only ablation scored
**3 wins, 7 draws, 6 losses** (40.625%; approximate paired interval 24.8–56.5%).
That does not establish an improvement from the extra terms. A subsequent
32,768-entry static-evaluation cache verifies both Zobrist halves plus side and
style; it never caches history-dependent search results. Exact dead-material
evaluation was also added after that match.

The final cached candidate scored **2 wins, 3 draws, 11 losses** against 0.6.5
at the same limits, with no capped games. Score: 21.875%; approximate paired
95% interval: 7.4–36.3%; relative Elo point estimate: -221. It passed all three
basic tactical checks, which clearly does not establish overall playing strength.
**The strength gate failed. This build is an evaluation preview, not an upgrade.**
The 0.6.5 ZIP is retained. No gain is claimed for the new heuristics or original
square formulas. Next experiments should isolate each term against the
original-weights-only fixture, then tune on training starts and verify on
separate held-out starts at both 100 and 450 ms.

Tests include color symmetry over legal sequences, unchanged position state,
blocked passers, bishop activity, distant outpost challenges, tempo-dependent
pawn races, promotion, avoiding stalemate, and dead-material distinctions.

## Held-out test at 450 ms per move

The same preview was tested on eight fresh positions from
`scripts/heldout-starts.json`, each with colors swapped, with a 240-ply cap.
Result: **1 win, 8 draws, 7 losses**; no capped games. Score: 31.25%;
approximate paired 95% score interval: 15.9–46.6%. The -137 relative Elo point
estimate is preliminary, not an absolute rating or a precise strength gap.

| Metric | Preview | 0.6.5 |
| --- | ---: | ---: |
| Average completed search depth | 11.39 | 11.75 |
| Average measured move-search time | 389.6 ms | 394.6 ms |
| Aggregate nodes/second | 459,428 | 656,450 |
| Reported budget overruns | 0 | 0 |
| Basic tactical sanity cases passed | 3/3 | 3/3 |

All 1,523 played moves passed the runner's legality check. Overruns mean
elapsed time greater than the budget plus the larger of 25 ms or 20%; zero
reported overruns does not establish that every search finished within 450 ms.
The held-out result supports the earlier regression finding. More thinking
time did not establish an improvement. Raw games, hashes, and timings are in
`docs/benchmarks/match-heldout-450ms.json`.
