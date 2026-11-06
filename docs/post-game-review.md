# Post-game review

Review answers a narrow question: for the moves this side actually played, what
did the engine prefer at a small fixed budget, and how large was the estimated
score gap? It is not a Chess.com Game Review grade and it is not ground truth.

## Availability

The **Review last game** button appears in the Play tab after a game has ended.
It is disabled while autoplay, one-move mode, or the rematch queue is running,
and while a live engine search is in flight or a review is already running. This
prevents review from taking a core away from a game. Once started, review has
its own **Cancel review** button; cancelling terminates the dedicated review
worker.

A new game cancels any review still running and discards its report. A late
`review-result` from the old game is ignored rather than attached to the new
board. Reviews and game searches never share the dedicated review worker.

The review uses the history the content script already received from
Chess.com. Moves are recovered exactly by matching consecutive positions, not
by guessing from the board difference. Clock counters and an irrelevant en
passant target are ignored when matching, because they do not identify a move.

## Scoring

Both the position before the move and the position after it are searched with
the same depth, time and node limits. The reported loss is:

```
bestScore   = score(before, mover)
playedScore = -score(after, opponent)
loss        = clamp(0, 2000, bestScore - playedScore)
```

The result is only graded when one of these is true:

- the played move is the engine's own top move (loss 0);
- the after-position is terminal (checkmate, stalemate or no legal move);
- the after-search found a proven mate;
- both searches completed the same depth.

Otherwise the move is **Unrated**. This is the important guard against the
early implementation's bug: comparing a shallow "before" search with a deeper
"after" search could label the engine's best move as bad. Unrated moves are
excluded from the average loss and the clean percentage; they are not silently
counted as clean.

Mate scores are converted to a large finite value so they sort against ordinary
centipawn scores. This is a comparison device, not a claim that a mate is worth
90,000 centipawns.

## Limits

- A search score is not a tablebase result. The review does not prove a
  theoretical win, draw or loss.
- The review is deliberately single-sided. With the side set to **Both**, the
  button asks the user to choose White or Black rather than guessing.
- It spends CPU after the game. On a slow machine, the built-in 1.2 s per
  position budget can still take tens of seconds for a long game. Cancel is the
  supported escape hatch.
- Opening-book data is absent in this build. The review does not use a book.
- The production evaluation mask remains `0`; review does not enable the
  experimental evaluation terms.
