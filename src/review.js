(function (global) {
  'use strict';
  // Post-game review.
  //
  // The extension already sees every position of the game it played. Review
  // replays that game at a small, fixed search budget and, for each of our own
  // moves, asks two questions: what did the engine want here, and what was the
  // played move actually worth? The gap between the two is an estimate of the
  // cost of the move.
  //
  // This is a comparison between two independent searches, not ground truth.
  // In particular, the result is only graded when both searches completed the
  // same depth (or the played move is the engine's own top move, or the
  // resulting position is terminal). A deeper search of the position after the
  // move can otherwise make a perfectly good move look like a loss.
  const MATE_THRESHOLD = 90000;
  const CUTOFF = { blunder: 300, mistake: 150, inaccuracy: 60, slack: 25 };
  const MAX_LOSS = 2000;

  // Score from the mover's point of view, with mate converted to a number that
  // compares sensibly against ordinary scores.
  function normalizeScore(result) {
    if (!result) return 0;
    const mate = result.mate;
    if (typeof mate === 'number' && mate !== 0) {
      return mate > 0 ? MATE_THRESHOLD - mate * 2 : -MATE_THRESHOLD - mate * 2;
    }
    const score = Number(result.score);
    return Number.isFinite(score) ? score : 0;
  }

  function sameKey(C, a, b) {
    if (typeof C.positionKey === 'function') {
      try { return C.positionKey(a) === C.positionKey(b); } catch { /* fall through */ }
    }
    return a === b;
  }

  // Exact move recovery: the only legal move whose resulting position matches
  // the next recorded position. This handles castling, promotion and en passant
  // without guessing from the board difference. Clock counters are ignored:
  // they do not identify a move, and some board readers omit or normalize them.
  function moveBetween(C, fenBefore, fenAfter) {
    const position = new C.Position(fenBefore);
    /** @type {string|null} */
    let found = null;
    for (const move of position.legalMoves()) {
      const copy = new C.Position(fenBefore);
      copy.make(move);
      if (sameKey(C, copy.fen(), fenAfter)) {
        if (found) return null; // ambiguous history; refuse rather than guess
        found = C.uci(move);
      }
    }
    return found;
  }

  function verdictFor(loss) {
    if (!Number.isFinite(loss)) return 'unrated';
    if (loss >= CUTOFF.blunder) return 'blunder';
    if (loss >= CUTOFF.mistake) return 'mistake';
    if (loss >= CUTOFF.inaccuracy) return 'inaccuracy';
    if (loss > CUTOFF.slack) return 'dubious';
    return 'good';
  }

  function sideOf(fen) {
    return String(fen).split(' ')[1] === 'b' ? 'b' : 'w';
  }

  function summarize(moves, side) {
    const counts = { blunder: 0, mistake: 0, inaccuracy: 0, dubious: 0, good: 0, unrated: 0 };
    let totalLoss = 0, rated = 0;
    for (const move of moves) {
      counts[move.verdict]++;
      if (move.comparable && Number.isFinite(move.loss)) {
        totalLoss += move.loss;
        rated++;
      }
    }
    const worst = moves
      .filter((move) => move.comparable && Number.isFinite(move.loss))
      .slice()
      .sort((a, b) => b.loss - a.loss)
      .slice(0, 3);
    return {
      side,
      reviewed: moves.length,
      rated,
      unrated: moves.length - rated,
      counts,
      averageLoss: rated ? Math.round(totalLoss / rated) : 0,
      worst,
      // Percentage of *graded* moves that were not blunders or mistakes. An
      // unrated move is excluded rather than silently counted as clean.
      clean: rated ? Math.round((1000 * (rated - counts.blunder - counts.mistake)) / rated) / 10 : null
    };
  }

  // engine: a NyxChess.Engine instance.
  // options.historyFens: every position of the game, oldest first.
  // options.side: 'w' or 'b' — the side we played.
  // options.onProgress: optional callback after each reviewed move.
  // options.shouldStop: optional synchronous cancellation check between moves.
  async function reviewGame(engine, options = {}) {
    const C = global.NyxChess;
    const history = Array.isArray(options.historyFens) ? options.historyFens : [];
    const side = options.side === 'b' ? 'b' : 'w';
    const nodeLimit = Number(options.nodeLimit) > 0 ? Number(options.nodeLimit) : 30000;
    const depth = Number(options.depth) > 0 ? Number(options.depth) : 8;
    const timeMs = Number(options.timeMs) > 0 ? Number(options.timeMs) : 1200;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;

    const targets = [];
    for (let ply = 0; ply + 1 < history.length; ply++) {
      if (sideOf(history[ply]) !== side) continue;
      const played = moveBetween(C, history[ply], history[ply + 1]);
      if (played) targets.push({ ply, played });
    }

    const moves = [];
    let stopped = false;
    for (let index = 0; index < targets.length; index++) {
      if (shouldStop && shouldStop()) { stopped = true; break; }
      const { ply, played } = targets[index];
      const before = await engine.think(history[ply], {
        nodeLimit,
        depth,
        timeMs,
        historyFens: history.slice(0, ply + 1)
      });
      if (shouldStop && shouldStop()) { stopped = true; break; }
      const after = await engine.think(history[ply + 1], {
        nodeLimit,
        depth,
        timeMs,
        historyFens: history.slice(0, ply + 2)
      });

      const matched = before?.move === played;
      const beforeDepth = Number(before?.depth) || 0;
      const afterDepth = Number(after?.depth) || 0;
      // A terminal position or a proven mate has an exact result even when the
      // search stopped at a shallower depth. Otherwise the two searches must
      // reach the same completed depth before their scores can be subtracted.
      const afterTerminal = Boolean(after && after.move === null);
      const afterMate = Number.isFinite(after?.mate) && after.mate !== 0;
      const comparable = matched || afterTerminal || afterMate ||
        (beforeDepth > 0 && beforeDepth === afterDepth);
      const bestScore = normalizeScore(before);
      const playedScore = -normalizeScore(after);
      let loss = null;
      let verdict = 'unrated';
      let reason = null;
      if (matched) {
        // The engine chose the move that was actually played. No after-search
        // horizon can turn that into a loss.
        loss = 0;
        verdict = 'good';
      } else if (comparable) {
        loss = Math.max(0, Math.min(MAX_LOSS, Math.round(bestScore - playedScore)));
        verdict = verdictFor(loss);
      } else {
        reason = 'Searches completed at different depths; no fair score gap.';
      }

      moves.push({
        ply,
        number: Number(history[ply].split(' ')[5]) || Math.floor(ply / 2) + 1,
        played,
        best: before?.move ?? null,
        matched,
        beforeDepth,
        afterDepth,
        comparable,
        loss,
        before: bestScore,
        after: playedScore,
        verdict,
        reason
      });
      if (onProgress) onProgress({ done: index + 1, total: targets.length, move: moves[moves.length - 1] });
    }

    const report = summarize(moves, side);
    return {
      version: 1,
      ...report,
      stopped,
      // Kept separate from the summary so a caller can render the full list
      // without the summary losing its compact shape.
      moves
    };
  }

  const api = { reviewGame, moveBetween, normalizeScore, verdictFor, summarize, CUTOFF };
  global.NyxReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
