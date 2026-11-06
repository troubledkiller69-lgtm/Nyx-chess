'use strict';

// Grading for external Stockfish review.
//
// Method: for the position before each recorded move, ask Stockfish for its
// best move at a fixed depth, then ask it for the score of a search restricted
// to the move that was actually played, at the same fixed depth. Both scores
// are UCI scores from the same root side to move, so no sign flip is needed.
//
// A cp loss is only produced when both searches reached the requested depth,
// both scores are exact cp scores, and the played move is the one that was
// searched. Mate scores are handled as mate distances, never converted to
// centipawns.

const C = require('../../../src/engine.js');

const CUTOFF = Object.freeze({ dubious: 25, inaccuracy: 60, mistake: 150, blunder: 300 });

function scoreText(score) {
  if (!score) return 'n/a';
  if (score.type === 'cp') {
    const sign = score.value > 0 ? '+' : '';
    return `${sign}${score.value} cp${score.bound ? ` ${score.bound}` : ''}`;
  }
  if (score.type === 'mate') {
    const value = score.value;
    return value >= 0 ? `M${value}` : `-M${Math.abs(value)}`;
  }
  return 'n/a';
}

function labelForLoss(loss) {
  if (!Number.isFinite(loss)) return 'ungraded';
  if (loss >= CUTOFF.blunder) return 'blunder';
  if (loss >= CUTOFF.mistake) return 'mistake';
  if (loss >= CUTOFF.inaccuracy) return 'inaccuracy';
  if (loss > CUTOFF.dubious) return 'dubious';
  return 'good';
}

function mateValue(score) {
  return score && score.type === 'mate' && Number.isFinite(score.value) && score.value !== 0
    ? score.value
    : null;
}

function terminalAfter(fen) {
  const position = new C.Position(fen);
  if (position.legalMoves().length) return null;
  const checkmated = position.inCheck(position.side);
  return checkmated
    ? { type: 'checkmate', sideToMove: position.side === C.WHITE ? 'w' : 'b' }
    : { type: 'stalemate', sideToMove: position.side === C.WHITE ? 'w' : 'b' };
}

function scoreRecord(result) {
  if (!result) return null;
  return {
    type: result.score ? result.score.type : null,
    value: result.score ? result.score.value : null,
    bound: result.score ? result.score.bound : null,
    text: scoreText(result.score),
    depth: Number.isFinite(result.depth) ? result.depth : null,
    seldepth: Number.isFinite(result.seldepth) ? result.seldepth : null,
    nodes: Number.isFinite(result.nodes) ? result.nodes : null,
    nps: Number.isFinite(result.nps) ? result.nps : null,
    timeMs: Number.isFinite(result.timeMs) ? result.timeMs : null,
    bestmove: result.bestmove || null,
    pv: Array.isArray(result.pv) ? result.pv.slice(0, 12) : []
  };
}

function ungraded(reason, extra = {}) {
  return {
    graded: false,
    label: 'ungraded',
    lossCp: null,
    reason,
    missedMate: false,
    allowedMate: false,
    severity: 0,
    ...extra
  };
}

function gradeMove(input) {
  const {
    played,
    best,
    playedSearch,
    terminal,
    requestedDepth,
    sameAsBest = false
  } = input;

  const bestScore = best ? best.score : null;
  const playedScore = playedSearch ? playedSearch.score : null;
  const evidence = {
    bestResult: scoreRecord(best),
    playedResult: scoreRecord(playedSearch),
    bestScore: scoreRecord(best),
    playedScore: scoreRecord(playedSearch),
    requestedDepth,
    sameDepth: Boolean(best && playedSearch && best.depth === requestedDepth && playedSearch.depth === requestedDepth)
  };

  if (!terminal && sameAsBest) {
    return {
      graded: true,
      label: 'good',
      lossCp: 0,
      reason: 'played the same move as the unrestricted root search at this budget',
      missedMate: false,
      allowedMate: false,
      severity: 0,
      ...evidence
    };
  }

  if (terminal && terminal.type === 'checkmate') {
    return {
      graded: true,
      label: 'checkmate',
      lossCp: 0,
      reason: 'the played move checkmates the opponent',
      missedMate: false,
      allowedMate: false,
      severity: 0,
      ...evidence
    };
  }

  if (terminal && terminal.type === 'stalemate') {
    const bestMate = mateValue(bestScore);
    if (bestMate !== null && bestMate > 0) {
      return {
        graded: true,
        label: 'missed mate',
        lossCp: null,
        reason: 'the played move stalemates a position where the root search had a mate',
        missedMate: true,
        allowedMate: false,
        severity: 10000 + Math.min(999, bestMate),
        ...evidence
      };
    }
    if (bestScore && bestScore.type === 'cp' && !bestScore.bound && bestScore.value > 0) {
      const loss = bestScore.value;
      return {
        graded: true,
        label: labelForLoss(loss),
        lossCp: loss,
        reason: 'the played move stalemates; the root search evaluated the position as winning',
        missedMate: false,
        allowedMate: false,
        severity: loss,
        ...evidence
      };
    }
    return {
      graded: true,
      label: 'good',
      lossCp: 0,
      reason: 'stalemate from a position the root search did not score as winning',
      missedMate: false,
      allowedMate: false,
      severity: 0,
      ...evidence
    };
  }

  if (!best || !playedSearch) {
    return ungraded('the played move was not searched', evidence);
  }
  if (playedSearch.bestmove && playedSearch.bestmove !== played) {
    return ungraded(
      `searchmoves returned ${playedSearch.bestmove} instead of ${played}`,
      evidence
    );
  }
  if (!bestScore || !playedScore) {
    return ungraded('one of the searches returned no score', evidence);
  }
  if (bestScore.bound || playedScore.bound) {
    return ungraded('a bound score cannot be compared as an exact score', evidence);
  }

  const bestMate = mateValue(bestScore);
  const playedMate = mateValue(playedScore);

  if (bestMate !== null && playedMate === null) {
    if (bestMate > 0) {
      return {
        graded: true,
        label: 'missed mate',
        lossCp: null,
        reason: `the root search found mate in ${bestMate}; the played move has no mate score`,
        missedMate: true,
        allowedMate: false,
        severity: 10000 + Math.min(999, bestMate),
        ...evidence
      };
    }
    return ungraded('the root search reports a forced mate against the mover but the played line is a cp score', evidence);
  }

  if (bestMate === null && playedMate !== null) {
    if (playedMate > 0) {
      return {
        graded: true,
        label: 'good',
        lossCp: 0,
        reason: `the played line proves mate in ${playedMate}; the unrestricted root search had only a cp score`,
        missedMate: false,
        allowedMate: false,
        severity: 0,
        ...evidence
      };
    }
    return {
      graded: true,
      label: 'allowed mate',
      lossCp: null,
      reason: `the played move allows a forced mate (${scoreText(playedScore)})`,
      missedMate: false,
      allowedMate: true,
      severity: 20000 + Math.min(999, Math.abs(playedMate)),
      ...evidence
    };
  }

  if (bestMate !== null && playedMate !== null) {
    if (bestMate > 0 && playedMate > 0) {
      if (playedMate > bestMate) {
        return {
          graded: true,
          label: 'slower mate',
          lossCp: null,
          reason: `both moves mate, but the played move is slower (best M${bestMate}, played M${playedMate})`,
          missedMate: false,
          allowedMate: false,
          severity: 500 + Math.min(499, playedMate - bestMate),
          ...evidence
        };
      }
      return {
        graded: true,
        label: 'good',
        lossCp: 0,
        reason: `the played move mates at least as fast as the root choice (best M${bestMate}, played M${playedMate})`,
        missedMate: false,
        allowedMate: false,
        severity: 0,
        ...evidence
      };
    }
    if (bestMate < 0 && playedMate < 0) {
      if (playedMate < bestMate) {
        return {
          graded: true,
          label: 'worse mate',
          lossCp: null,
          reason: `the mover is mated either way, but the played move is mated sooner (best ${scoreText(bestScore)}, played ${scoreText(playedScore)})`,
          missedMate: false,
          allowedMate: false,
          severity: 1500 + Math.min(499, Math.abs(playedMate - bestMate)),
          ...evidence
        };
      }
      return {
        graded: true,
        label: 'good',
        lossCp: 0,
        reason: 'the played move delays the forced mate at least as long as the root choice',
        missedMate: false,
        allowedMate: false,
        severity: 0,
        ...evidence
      };
    }
    return ungraded('the two searches disagree on the sign of the forced mate', evidence);
  }

  if (bestScore.type !== 'cp' || playedScore.type !== 'cp') {
    return ungraded('unsupported score type', evidence);
  }

  const bestDepth = Number(best.depth) || 0;
  const playedDepth = Number(playedSearch.depth) || 0;
  if (bestDepth !== requestedDepth || playedDepth !== requestedDepth) {
    return ungraded(
      `searches did not both reach exactly depth ${requestedDepth} (best ${bestDepth}, played ${playedDepth}); no fair score gap`,
      evidence
    );
  }

  const loss = Math.max(0, bestScore.value - playedScore.value);
  return {
    graded: true,
    label: labelForLoss(loss),
    lossCp: loss,
    reason: loss === 0
      ? 'the played line scored at least as well as the root choice at this depth'
      : `the played line scored ${loss} cp below the root choice at the same depth`,
    missedMate: false,
    allowedMate: false,
    severity: loss,
    ...evidence
  };
}

function emptyPhase() {
  return {
    analyzed: 0,
    graded: 0,
    cpGraded: 0,
    ungraded: 0,
    good: 0,
    dubious: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
    missedMate: 0,
    allowedMate: 0,
    checkmate: 0,
    slowerMate: 0,
    worseMate: 0,
    errors: 0,
    totalLossCp: 0,
    averageLossCp: null,
    worst: null
  };
}

function addToPhase(bucket, move) {
  bucket.analyzed++;
  if (move.graded) bucket.graded++;
  else bucket.ungraded++;
  if (move.label === 'missed mate') bucket.missedMate++;
  else if (move.label === 'allowed mate') bucket.allowedMate++;
  else if (move.label === 'checkmate') bucket.checkmate++;
  else if (move.label === 'slower mate') bucket.slowerMate++;
  else if (move.label === 'worse mate') bucket.worseMate++;
  else if (Object.prototype.hasOwnProperty.call(bucket, move.label)) bucket[move.label]++;
  if (move.label === 'blunder' || move.label === 'mistake' ||
      move.label === 'missed mate' || move.label === 'allowed mate' ||
      move.label === 'worse mate' || move.label === 'slower mate') {
    bucket.errors++;
  }
  if (move.graded && Number.isFinite(move.lossCp)) {
    bucket.cpGraded++;
    bucket.totalLossCp += move.lossCp;
    if (!bucket.worst || move.lossCp > bucket.worst.lossCp) {
      bucket.worst = { ply: move.ply, played: move.played, lossCp: move.lossCp, label: move.label };
    }
  }
}

function finalizePhase(bucket) {
  bucket.averageLossCp = bucket.cpGraded > 0
    ? Math.round((bucket.totalLossCp / bucket.cpGraded) * 10) / 10
    : null;
  return bucket;
}

function summarizeMoves(moves) {
  const summary = {
    analyzed: moves.length,
    graded: 0,
    cpGraded: 0,
    ungraded: 0,
    counts: {
      good: 0,
      dubious: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
      missedMate: 0,
      allowedMate: 0,
      checkmate: 0,
      slowerMate: 0,
      worseMate: 0,
      ungraded: 0
    },
    totalLossCp: 0,
    averageLossCp: null,
    phases: { opening: emptyPhase(), middlegame: emptyPhase(), endgame: emptyPhase() },
    turningPoints: [],
    missedMates: []
  };

  for (const move of moves) {
    if (move.graded) summary.graded++;
    else summary.ungraded++;
    switch (move.label) {
      case 'missed mate': summary.counts.missedMate++; break;
      case 'allowed mate': summary.counts.allowedMate++; break;
      case 'checkmate': summary.counts.checkmate++; break;
      case 'slower mate': summary.counts.slowerMate++; break;
      case 'worse mate': summary.counts.worseMate++; break;
      case 'ungraded': summary.counts.ungraded++; break;
      default:
        if (Object.prototype.hasOwnProperty.call(summary.counts, move.label)) summary.counts[move.label]++;
        break;
    }
    if (move.graded && Number.isFinite(move.lossCp)) {
      summary.cpGraded++;
      summary.totalLossCp += move.lossCp;
    }
    addToPhase(summary.phases[move.phase] || summary.phases.middlegame, move);
    if (move.label === 'missed mate') {
      summary.missedMates.push({
        ply: move.ply,
        moveNumber: move.moveNumber,
        side: move.side,
        played: move.played,
        best: move.best || (move.bestScore && move.bestScore.bestmove) || null,
        bestScore: move.bestScore ? move.bestScore.text : null,
        playedScore: move.playedScore ? move.playedScore.text : null,
        reason: move.reason
      });
    }
  }

  for (const phase of Object.values(summary.phases)) finalizePhase(phase);
  summary.averageLossCp = summary.cpGraded > 0
    ? Math.round((summary.totalLossCp / summary.cpGraded) * 10) / 10
    : null;

  const significant = moves.filter((move) => move.severity >= CUTOFF.inaccuracy);
  const turningPointPool = significant.length
    ? significant
    : moves.filter((move) => move.severity > 0);
  summary.turningPoints = turningPointPool
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 5)
    .map((move) => ({
      ply: move.ply,
      moveNumber: move.moveNumber,
      side: move.side,
      phase: move.phase,
      played: move.played,
      best: move.best || (move.bestScore && move.bestScore.bestmove) || null,
      label: move.label,
      lossCp: move.lossCp,
      bestScore: move.bestScore ? move.bestScore.text : null,
      playedScore: move.playedScore ? move.playedScore.text : null,
      depth: move.bestScore ? move.bestScore.depth : null,
      nodes: move.playedScore ? move.playedScore.nodes : (move.bestScore ? move.bestScore.nodes : null),
      reason: move.reason
    }));

  return summary;
}

async function analyzeGame(options) {
  const {
    engine,
    game,
    depth = 12,
    movetimeMs = null,
    timeoutMs = null,
    side = 'both',
    limit = null,
    clearHash = true,
    signal = null,
    onProgress = null
  } = options;

  const sideFilter = side === 'w' || side === 'b' ? side : null;
  let targets = game.moves.filter((move) => !sideFilter || move.side === sideFilter);
  if (Number(limit) > 0) targets = targets.slice(0, Number(limit));
  if (!targets.length) throw new Error('No moves selected for analysis');

  const moves = [];
  for (let index = 0; index < targets.length; index++) {
    if (signal && signal.aborted) throw new Error('Analysis cancelled');
    const target = targets[index];
    const label = `ply ${target.ply} (${target.played})`;
    // Send the game's starting position plus the moves before this target, not
    // the already-updated before-FEN plus those same moves. The latter would
    // replay the history twice and is illegal. Using the start FEN keeps the
    // in-game repetition history available to Stockfish.
    const best = await engine.analyze({
      fen: game.startFen,
      moves: target.historyMoves,
      depth,
      movetimeMs,
      timeoutMs,
      clearHash,
      signal,
      label: `${label} best`
    });

    let playedSearch = null;
    const sameAsBest = Boolean(best.bestmove && best.bestmove === target.played);
    if (!sameAsBest) {
      playedSearch = await engine.analyze({
        fen: game.startFen,
        moves: target.historyMoves,
        depth,
        movetimeMs,
        timeoutMs,
        searchmoves: [target.played],
        clearHash,
        signal,
        label: `${label} played`
      });
    }

    const terminal = terminalAfter(target.afterFen);
    const graded = gradeMove({
      played: target.played,
      best,
      playedSearch,
      terminal,
      requestedDepth: depth,
      sameAsBest
    });

    const record = {
      ply: target.ply,
      moveNumber: target.moveNumber,
      side: target.side,
      phase: target.phase,
      beforeFen: target.beforeFen,
      afterFen: target.afterFen,
      played: target.played,
      best: best.bestmove || null,
      sameAsBest,
      terminal: terminal ? terminal.type : null,
      ...graded,
      bestScore: scoreRecord(best),
      playedScore: scoreRecord(playedSearch)
    };
    moves.push(record);
    if (onProgress) onProgress({ done: index + 1, total: targets.length, move: record });
  }

  return {
    method: 'fixed-depth root best vs fixed-depth searchmoves(played), same position and mover perspective',
    moves,
    summary: summarizeMoves(moves)
  };
}

module.exports = {
  CUTOFF,
  scoreText,
  labelForLoss,
  terminalAfter,
  gradeMove,
  summarizeMoves,
  analyzeGame,
  scoreRecord
};
