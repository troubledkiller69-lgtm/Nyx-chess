# External Stockfish analysis

This tool reviews **recorded Nyx games** with an external Stockfish process. It
is deliberately separate from the Nyx engine:

- Nyx's move generator, search and evaluation remain untouched.
- Stockfish is never bundled with the extension and never imported into it.
- Stockfish scores are not copied into Nyx weights and are not training data.
- The output is a diagnostic review, not an Elo rating, not a match-strength
  test and not proof that a position is theoretically won or drawn.

## What it analyzes

Input is a Nyx match report such as
`docs/benchmarks/match-selfplay.json`, or a single game object. Supported
recorded fields:

- `games[]` in a match report, selected with `--game N` (0-based);
- a UCI move list in `moves` (array or space-separated string);
- a starting position from `initialFen` / `startFen` / `fen`;
- an opening name in `opening` (resolved against `scripts/bench/openings.json`);
- optional `openingMoves`, `start.moves`, `start.fen`, `finalFen` and `plies`.

Every opening move and every recorded move is replayed through Nyx's own legal
move generator. An illegal move, an unresolvable opening, a mismatched final
FEN or a mismatched ply count is an error. Final-FEN comparison uses the
position fields (board, side, castling, en passant); halfmove/fullmove clocks
are ignored because they do not identify a position. The tool does not parse
SAN and does not infer a move from a board difference.

`game.startFen` is the position after the recorded opening. Stockfish receives
`position fen <startFen> moves <moves before this ply>`, so repetition history
inside the recorded game is preserved. History before `startFen` is not
available in the match report and is not guessed.

PGN is not supported because this repository has no reliable PGN parser. Use a
report with validated UCI moves.

Some older reports have opening names whose suite entry changed after the game
was recorded. Replaying such a report fails at the first illegal move. If the
real history is known, pass `--start-fen` or `--opening-moves`; otherwise the
game is rejected. The tool never guesses an opening or a move to make a report
fit.

## Method

For each selected move, two searches are run sequentially on the same root
position:

1. unrestricted search at `--depth D` (the "root best");
2. search restricted with `searchmoves <played>` at the same `--depth D`.

Both UCI scores are from the root side to move. The tool does **not** flip the
sign. A cp loss is reported only when:

- both searches reached exactly the requested depth;
- both scores are exact `cp` scores (no `lowerbound` / `upperbound`);
- the restricted search really returned the played move.

If the played move is already the root best, it is graded `good` with loss 0 and
the second search is skipped.

Mate scores remain mate distances. They are never converted to centipawns:

- root mate + played non-mate → **missed mate**;
- played line allows a forced mate → **allowed mate**;
- both mate, played is slower → **slower mate**;
- checkmate and stalemate are terminal categories, not cp losses.

Depth is the controlled budget. Threads, Hash, depth, movetime and search
method are recorded in the report, as are each search's depth, seldepth, nodes,
nps, time, bound, score and PV. Nodes can differ between the two searches; they
are evidence, not an equal-work guarantee. A search that is cut short by the
movetime cap is ungraded, not silently compared.

Phase labels are deliberately simple heuristics:

- **endgame** when total non-pawn material (Q=9, R=5, B/N=3, both sides) is
  at or below 20 points;
- **opening** before the resolved opening plus eight development plies (or the
  first ten plies when no opening was resolved);
- **middlegame** otherwise.

These are labels for grouping evidence, not chess judgements.

Loss labels use the same broad thresholds as Nyx's own review: `good` up to 25
cp, `dubious` above 25, `inaccuracy` ≥ 60, `mistake` ≥ 150, `blunder` ≥ 300.
A "turning point" is a move at or above the inaccuracy threshold (or a mate
category), ranked by loss/mate severity; if every move is cleaner than that, the
largest nonzero losses are shown instead. It is a review heuristic, not a claim
about where the game was decided.

## Usage

No package script was added. Run Node directly:

```powershell
node scripts/analysis/analyze-game.js docs/benchmarks/match-selfplay.json --game 0
```

Choose an installed Stockfish explicitly:

```powershell
node scripts/analysis/analyze-game.js docs/benchmarks/match-selfplay.json `
  --game 0 --stockfish "C:\Program Files\Stockfish\stockfish.exe" `
  --depth 12 --threads 1 --hash 128
```

If no binary is found, download the official pinned release into
`tools/stockfish/` (outside the extension source):

```powershell
node scripts/analysis/analyze-game.js docs/benchmarks/match-selfplay.json `
  --game 0 --download --tag sf_19
```

Useful options:

```text
--list                 list games and exit
--game N               0-based game index (default 0)
--side w|b|both        filter by side (default both)
--limit N              analyze only the first N selected moves
--depth N              fixed depth for both searches (default 12)
--movetime MS          per-search time cap; incomplete depth is ungraded
--timeout MS           hard per-search timeout
--threads N            Stockfish Threads (default 1)
--hash MB              Stockfish Hash (default 128)
--stockfish PATH       explicit executable
--download             fetch the official pinned release if absent
--tag TAG              release tag for --download (default sf_19)
--openings PATH        opening suite (default scripts/bench/openings.json)
--starts PATH          optional start-position suite
--start-fen FEN        override the recorded start
--opening-moves MOVES  override opening history (space-separated UCI)
--out PATH             JSON output
--markdown PATH        Markdown summary
--json                 print the full report to stdout
```

Default outputs go to `analysis/<input>-game<N>-stockfish.json` and `.md`.
`analysis/` is outside `src/`, the manifests and the extension package. Nothing
in `analysis/` is loaded by Nyx.

A short smoke run is intentionally cheap and must not be treated as timing or
strength evidence:

```powershell
node scripts/analysis/analyze-game.js docs/benchmarks/match-selfplay.json `
  --game 0 --limit 2 --depth 10 --movetime 2000 --threads 1 --hash 64
```

## Output

The JSON report records:

- schema/version and a diagnostic disclaimer;
- input path, input SHA-256, game index/count and recorded result;
- Stockfish executable, version, author, executable SHA-256, options and
  downloaded-release provenance (if used);
- search method, depth, movetime, timeout, threads, Hash, side, limit and the
  score perspective;
- the validated starting FEN, opening moves, final FEN and every replayed ply;
- every analyzed move with played/best move, scores, depth, seldepth, nodes,
  nps, time, bounds, PV, label, reason and terminal state;
- per-phase counts and averages, turning points and missed mates.

The Markdown file is a concise summary of the same data. A short real smoke
example (Stockfish 19, depth 10, two plies of game 1) is:

```text
[1/2] ply 1 w b5d3 vs b5a4: inaccuracy, 69 cp
[2/2] ply 2 b f8d6 vs f7f5: inaccuracy, 82 cp
Stockfish Stockfish 19 · game 1/4 · depth 10 · 2 moves analyzed
graded 2, ungraded 0, missed mates 0, avg loss 75.5 cp
```

That run only verifies the adapter and report path. It is not a strength or
throughput benchmark.

## Stockfish discovery, download and provenance

Discovery order:

1. explicit `--stockfish PATH` (a file, paths with spaces are supported);
2. `stockfish.exe` / `stockfish` on `PATH`;
3. narrow install locations: `%LOCALAPPDATA%\Programs\Stockfish`,
   `%ProgramFiles%\Stockfish`, `%ProgramFiles(x86)%\Stockfish`;
4. `tools/stockfish` in this repository;
5. only with `--download`, the official GitHub release.

`--download` uses the official `official-stockfish/Stockfish` release, picks
the Windows universal asset for the current architecture, verifies the GitHub
release asset SHA-256 when the API provides one, extracts with `tar` (falling
back to PowerShell `Expand-Archive`), and writes `provenance.json` next to the
binary. The provenance record includes source repository, release tag/API URL,
asset name/URL, asset SHA-256, executable SHA-256, download time, license and a
note that the binary is not bundled with the extension.

Stockfish is GPL-3.0-or-later. It is a separate external program at
`tools/stockfish/...`; it is not copied into `src/`, `popup/`, the manifests or
any extension package. Keep `tools/stockfish/` out of extension packaging and
out of any distribution that does not comply with the GPL. The downloaded
license text is included by the release at
`tools/stockfish/<tag>/extracted/stockfish/Copying.txt`.

## Tests

The tests use a deterministic fake-UCI fixture for protocol behavior, score
signs, mate/bound parsing, depth mismatch, timeout, cancellation, crash handling
and paths with spaces. They also validate a real saved match report through
Nyx's move generator and exercise the analysis orchestration.

```powershell
node --test scripts/analysis/test/stockfish.test.js scripts/analysis/test/game.test.js
```

No existing test, benchmark runner, manifest or `package.json` is modified.
