# Engine strength plan — all original code

This roadmap assumes no third-party engine, no WASM Stockfish, and no external
service. Items below are proposals, not a claim that everything is implemented.
The historical target ratings in the headings are speculative, not measured gains.
See [evaluation development](evaluation-development.md) for actual changes and
old-versus-new results, including regressions.

## Baseline

Nyx Chess searches with numeric move encoding, original geometric tapered
evaluation, incremental Zobrist hashing, a transposition table, PVS, null-move
pruning, futility/LMP, check extensions, delta pruning, and iterative deepening
up to depth 16. Ruthless splits root moves across workers; Human uses one exact
root list so blunder selection stays honest.

The evaluation development work replaces the PeSTO arrays bundled in 0.6.5;
the saved 0.6.5 engine remains only an external measurement baseline.

## Phase 1 — search speed (target +150–300 Elo)

1. **Bitboard position representation.** Replace the 64-entry board scan and
   per-move make/unmake bookkeeping with piece bitboards plus occupancy. This is
   the largest single change and unlocks everything below.
2. **Magic bitboards** (or kindergarten bitboards if magic tables are too large)
   for sliding attacks. Move generation should stop in a few hundred
   nanoseconds per position instead of filtering pseudo-legal moves.
3. **Incremental evaluation.** Maintain material, piece-square, pawn-structure,
   and king-safety terms in `make`/`unmake`. A full 64-square scan per node is
   the current hot spot.
4. **Static exchange evaluation (SEE).** Use it for capture ordering, losing
   capture pruning in quiescence, and delta pruning with a real exchange value.
5. **Transposition table buckets.** Two entries per bucket, depth-preferred with
   an always-replace slot. Keep the current size cap and clear-on-overflow
   behavior unless a measured replacement scheme beats it.

## Phase 2 — search selectivity (target +100–200 Elo)

1. **Aspiration windows** around the previous iteration score, widened on
   fail-high/fail-low, with a safe full-window fallback.
2. **Counter-move and follow-up history** for quiet moves; keep the existing
   butterfly history but add gravity and bonus/malus updates.
3. **Late-move reductions with verification.** Reduce late quiet moves more
   aggressively, re-search at full depth when a reduced move beats alpha.
4. **Singular extensions** for TT moves that look forced, guarded by a cheap
   verification search.
5. **Internal iterative deepening** at PV nodes without a TT move.
6. **Mate-distance pruning** and repetition-aware score adjustment so winning
   positions are not traded into a draw.
7. **Time management:** soft limit based on score stability and node trend,
   hard limit at the configured budget; never lose an iteration that is almost
   complete.

## Phase 3 — evaluation depth (target +80–150 Elo)

1. **King safety:** pawn shield, open-file storm, attacker count near the king,
   and a tapered danger term instead of the current small bonus.
2. **Mobility and space:** count safe squares per piece, especially bishops,
   rooks, and knights; scale by pawn structure.
3. **Threats:** hanging pieces, pawn attacks on pieces, and king-zone attacks.
4. **Pawn structure:** isolated, doubled, backward, candidate passers, and
   connected passers by rank.
5. **Rook activity:** open and semi-open files, seventh rank, behind passed
   pawns.
6. **Bishop pair and bad bishop:** already present as a small term; make it
   scale with the pawn chain.
7. **Endgame king activity and pawn races:** king proximity to passed pawns and
   queening squares.
8. **Tempo/contempt:** a tiny side-to-move bonus and a small draw contempt that
   is disabled in Ruthless.

Every term must be tunable and measured in isolation. No term ships because it
"feels right".

## Phase 4 — parallelism (target +50–100 Elo at 1.4 s and above)

1. Move from root-split only to **lazy SMP** with a shared transposition table.
   Workers search the same root at different depths and help each other through
   the shared table; results are merged by depth and score.
2. Keep a deterministic single-worker mode for Human when exact root scores are
   required for blunder and variety selection.
3. Bound memory and worker count by `navigator.hardwareConcurrency`, with a
   fallback to one worker.

## Phase 5 — book and endgames (target +30–80 Elo)

1. Generate an original opening book from our own self-play at long time
   controls, filtered for soundness. Store positions as compact hashes.
2. Add three- and four-piece endgame tablebases generated locally (or compact
   distance-to-mate tables) for exact conversion. Five-piece is optional and
   large.
3. Keep the existing human opening memory: book choice rotates away from lines
   played in the last games.

## Phase 6 — tuning (target +50–100 Elo)

1. Build a fixed suite of tactical and positional positions with known best
   moves; track nodes-to-depth, solve rate, and move agreement.
2. Run SPSA or a simple coordinate descent over evaluation weights using
   self-play at short time controls.
3. Keep a held-out set to catch overfitting; reject changes that only help the
   tuning set.

## Phase 7 — small neural evaluation (target +150–300 Elo, large project)

A tiny quantized network (for example 768 inputs → 32 hidden → 1 output) trained
on our own self-play games and evaluated with typed-array inference could add
more than any hand-tuned term. This stays original code and original weights; it
is a separate project with its own data pipeline and latency budget. It should
not be started until Phases 1–3 are complete and measured.

## Measurement protocol

- Fixed tactical suite (mates in 1–4, hanging pieces, promotion races).
- Fixed positional suite with move agreement against long searches of our own
  engine at depth 14+.
- Time-sliced benchmarks at 160/450/1400/5000 ms, three runs, median, on an idle
  machine.
- Self-play matches between old and new builds at equal time, colors swapped,
  at least 100 games before claiming an Elo gain.
- Log depth, nodes, nodes/second, TT hit rate, and beta-cutoff rate for every
  build so regressions are visible.
