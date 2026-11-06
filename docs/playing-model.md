# Playing-strength and move-selection model

## What the implementation does

The local engine combines iterative-deepening alpha-beta search with a bounded randomized choice among root moves scored in the **same completed iteration**. `playProfile()` maps the `skill` and `variety` inputs to a maximum search depth, a centipawn loss window (`maxLoss`), a softmax temperature, and a cap on the number of sampled candidates. `selectCandidate()` then samples from that score-ranked set, with restrictions intended to reduce bad outcomes: it narrows choice when the top two scores are far apart or the side is in check, excludes losing-mate scores, constrains quiet king moves in middlegames, and avoids varied selection if the best score is a forced mate. If no iteration completes, it returns a static-evaluation fallback rather than sampling from incomplete search results.

These are **project-specific heuristics**. The values `180`, `0.35`, `65`, `0.24`, the candidate cap, the check/gap adjustment, and the king-move exception are not estimates fitted to human game records. The softmax converts engine score differences to sampling weights; it is not a learned human move probability. The `skill` input is consequently a control for engine search/selection behavior—not a calibrated chess rating. The interface’s Elo-like labels should not be interpreted as measured Elo performance without match testing against a specified opponent pool, time control, and opening conditions.

This is weak-play selection, not a human move-prediction model. The engine searches its own move/evaluation space and sometimes samples a lower-scored candidate. It does not train on actual human decisions, infer a player’s likely move from a position, or learn rating-specific error patterns. It also does not model the human cognitive processes or style that determine which plausible move a particular player chooses.

## What research says

### Human-move prediction is a different objective

McIlroy-Young et al. introduced Maia as a neural chess model trained on human games to predict the move a player would make at a particular skill level. They report that conventional engines, including Stockfish, are weaker at matching recorded human moves than models trained for that objective. Their reported metric is move-matching accuracy on their datasets; it is not a guarantee that any arbitrary stochastic weakening of an engine will resemble human play. Maia uses trained neural-network representations and human-move data, which this project does not contain.

Maia-2 extends that research with a unified skill-aware model for move and outcome prediction across skill levels. Its work emphasizes that player behavior does not vary as a simple linear function of rating, and that modeling skill and position jointly is more expressive than selecting a rating-independent policy or simply lowering search. Maia-2’s results are empirical results of that trained model and evaluation protocol; they do not transfer to this engine’s hand-designed sampling parameters.

### Stockfish strength controls are reference points, not human models

Stockfish documents two distinct weaker-play controls: `Skill Level` and `UCI_LimitStrength`/`UCI_Elo`. Its FAQ describes `Skill Level` as search plus randomized bias over a small set of candidate moves. `UCI_Elo` applies only when `UCI_LimitStrength` is enabled, takes precedence over `Skill Level`, and is converted internally to a skill setting. Stockfish documents a rating calibration anchored to CCRL 40/4 and a specified time control (currently 120s+1s). Such calibration is specific to Stockfish and its testing conditions; it is not a generic mapping from arbitrary engine parameters to Elo.

These controls demonstrate that candidate selection and resource limits can intentionally weaken an engine. They do not establish that candidate sampling reproduces human move choices. Maia’s human-move prediction objective and Stockfish’s strength-limiting objective should therefore not be conflated.

## Assessment and caveats

The current design is a lightweight, transparent compromise for selectable playing strength: it retains legal search, uses comparably scored candidates from a completed iteration, and limits the sampling pool using position-level signals. These safeguards are sensible engineering heuristics, not validated behavioral findings. In particular:

- Candidate scores are approximate outputs of this engine’s own evaluation and shallow search, not objective move-quality labels.
- The loss margin and temperature have no fitted or published mapping to player ratings.
- Simple position features (score gap, check status, material phase, king movement) cannot capture the patterns learned by Maia from millions of human games.
- Search-depth caps affect both strength and move choice, but do not by themselves reproduce human error distributions.
- Robust rating claims require controlled head-to-head match testing, adequate sample size, and explicit time control/opponent conditions. Human-move prediction claims require held-out human games and metrics such as top-1 move accuracy or log loss.

This document covers move selection and strength only. Timing, session behavior, error budgets, and input pacing are implemented separately by the Human layer and documented in the README.

## Sources

- McIlroy-Young, Sen, Kleinberg & Anderson (2020), “Aligning Superhuman AI with Human Behavior: Chess as a Model System,” *Proceedings of the 26th ACM SIGKDD Conference on Knowledge Discovery and Data Mining*. [arXiv abstract](https://arxiv.org/abs/2006.01855) · [paper HTML](https://arxiv.org/html/2006.01855v3) · [Maia project repository](https://github.com/CSSLab/maia-chess)
- Tang, Jiao, McIlroy-Young, Kleinberg, Sen & Anderson (2024), “Maia-2: A Unified Model for Human-AI Alignment in Chess,” *NeurIPS 2024*. [arXiv abstract and paper links](https://arxiv.org/abs/2409.20553) · [official Maia-2 implementation](https://github.com/CSSLab/maia2)
- Official Stockfish documentation, [Frequently Asked Questions: How do Skill Level and UCI_Elo work?](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#how-do-skill-level-and-uci_elo-work)
- Official Stockfish documentation, [UCI Protocol and Stockfish Commands: `UCI_LimitStrength`, `UCI_Elo`, and `Skill Level`](https://official-stockfish.github.io/docs/stockfish-wiki/UCI-Protocol-and-Stockfish-Commands.html#uci-limitstrength)
