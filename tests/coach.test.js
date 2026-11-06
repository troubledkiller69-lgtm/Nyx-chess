const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine.js');
const review = require('../src/review.js');
const coach = require('../src/coach.js');

const START = C.START_FEN;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';
const CASTLE_FEN = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
const HANGING_QUEEN = '4k3/8/8/4p3/3Q4/8/8/4K3 w - - 0 1';
const CONTESTED_ROOK = '3rk3/8/8/8/3R4/2P5/8/4K3 w - - 0 1';
const CHECK_THREAT = 'r6k/8/8/8/8/8/8/4K3 w - - 0 1';

function result(overrides = {}) {
  return {
    move: 'e2e4',
    score: 28,
    mate: null,
    depth: 8,
    nodes: 42000,
    time: 180,
    scoreSource: 'search',
    exactScores: true,
    legalMoves: 20,
    lines: [
      { move: 'e2e4', score: 28 },
      { move: 'd2d4', score: 20 }
    ],
    ...overrides
  };
}

test('builds an advisory DTO with a visible suggestion arrow by default', () => {
  const g = coach.buildGuidance(START, result(), { revision: 7 });
  assert.equal(g.status, 'ready');
  assert.equal(g.advisory, true);
  assert.equal(g.executesMoves, false);
  assert.equal(g.suggestion.uci, 'e2e4');
  assert.equal(g.suggestion.san, 'e4');
  assert.equal(g.second.san, 'd4');
  assert.equal(g.analysis.depth, 8);
  assert.equal(g.analysis.searchCompleteness, 'searched');
  assert.equal(g.analysis.pv, null, 'no PV is invented');
  assert.equal(g.analysis.score.text, 'Nyx score +0.28 for White.');

  assert.equal(g.hint.level, 'move', 'the suggestion arrow is the default view');
  assert.equal(g.hint.move.san, 'e4');
  assert.ok(g.hint.text.includes('e4'));

  const concept = coach.buildGuidance(START, result(), { hintLevel: 'concept' });
  assert.equal(concept.hint.level, 'concept');
  assert.equal(concept.hint.move, null, 'the optional staged flow does not reveal the move');
  assert.ok(concept.hint.text.length > 0);
  assert.ok(!concept.hint.text.includes('e4'), 'concept hint does not name the move');

  const pieceHint = coach.buildGuidance(START, result(), { hintLevel: 'piece' });
  assert.equal(pieceHint.hint.piece.name, 'pawn');
  assert.equal(pieceHint.hint.move, null);

  const moveHint = coach.buildGuidance(START, result(), { hintLevel: 'move' });
  assert.equal(moveHint.hint.move.san, 'e4');
  assert.ok(moveHint.hint.text.includes('e4'));

  assert.ok(g.highlights.arrows.some((a) => a.kind === 'suggestion' && a.from === 'e2' && a.to === 'e4'));
  assert.ok(g.highlights.arrows.some((a) => a.kind === 'candidate' && a.from === 'd2' && a.to === 'd4'));
});

test('staged hint-first uses king safety for a castling suggestion', () => {
  const g = coach.buildGuidance(CASTLE_FEN, result({
    move: 'e1g1',
    lines: [{ move: 'e1g1', score: 15 }]
  }), { hintLevel: 'concept' });
  assert.equal(g.status, 'ready');
  assert.equal(g.suggestion.san, 'O-O');
  assert.equal(g.suggestion.castle, 'k');
  assert.equal(g.hint.conceptKey, 'king-safety');
  assert.ok(g.hint.text.toLowerCase().includes('king safety'));
  assert.equal(g.hint.move, null);
  assert.equal(g.explanation.category, 'castle');
});

test('second candidate is gated on exact comparable root scores', () => {
  assert.equal(coach.buildGuidance(START, result({ exactScores: false })).second, null);
  assert.equal(coach.buildGuidance(START, result(), { includeSecond: false }).second, null);

  const illegalLine = result({ lines: [{ move: 'e2e4', score: 28 }, { move: 'e2e5', score: 20 }] });
  assert.equal(coach.buildGuidance(START, illegalLine).second, null);

  const blunder = result({ blundered: true, blunderLoss: 300 });
  assert.equal(coach.buildGuidance(START, blunder).second, null);
});

test('resolves UCI and SAN through the legal move list', () => {
  assert.equal(coach.resolveMove(START, 'Nf3').san, 'Nf3');
  assert.equal(coach.resolveMove(START, 'e2e4').san, 'e4');
  assert.equal(coach.resolveMove(START, '0-0'), null, 'castling that is not legal here is rejected');
  assert.equal(coach.resolveMove(CASTLE_FEN, '0-0').san, 'O-O');
  assert.equal(coach.resolveMove(CASTLE_FEN, 'O-O-O').san, 'O-O-O');
  assert.equal(coach.resolveMove('8/P7/8/8/8/8/8/K6k w - - 0 1', 'a8=Q+').san, 'a8=Q+');
  assert.equal(coach.resolveMove(START, 'Qh5'), null, 'illegal SAN is rejected, not guessed');
  assert.equal(coach.resolveMove(START, 'e2e5'), null, 'illegal UCI is rejected');

  const ambiguous = '4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1';
  assert.equal(coach.resolveMove(ambiguous, 'Nd2'), null, 'ambiguous SAN is refused');
  assert.equal(coach.resolveMove(ambiguous, 'Nbd2').san, 'Nbd2');
  assert.equal(coach.resolveMove(ambiguous, 'Nfd2').san, 'Nfd2');
});

test('classifies hanging, attacked, defended, and quiet pieces distinctly', () => {
  const hanging = coach.buildGuidance(HANGING_QUEEN, result({ move: 'e1d1' }));
  const queen = hanging.safety.own.find((entry) => entry.square === 'd4');
  assert.equal(queen.attacked, true);
  assert.equal(queen.defended, false);
  assert.equal(queen.hanging, true);
  assert.equal(queen.status, 'hanging');
  assert.deepEqual(queen.attackers, ['e5']);

  const capture = hanging.threats.immediate.find((threat) => threat.kind === 'capture');
  assert.ok(capture, 'the legal capture is listed');
  assert.equal(capture.from, 'e5');
  assert.equal(capture.to, 'd4');
  assert.equal(capture.target.value, 9);
  assert.equal(capture.target.hanging, true);
  assert.match(capture.text, /^If Black had the turn, its pawn on e5 could capture the queen on d4 \(exd4\)\.$/);
  assert.ok(hanging.highlights.arrows.some((a) => a.kind === 'threat' && a.from === 'e5' && a.to === 'd4'));
  assert.ok(hanging.highlights.squares.some((s) => s.square === 'd4' && s.kind === 'hanging'));
  assert.ok(hanging.highlights.arrows.filter((a) => a.kind === 'threat').length <= 3,
    'threat arrows are restrained to the three strongest options');

  const contested = coach.buildGuidance(CONTESTED_ROOK, result({ move: 'e1d1' }));
  const rook = contested.safety.own.find((entry) => entry.square === 'd4');
  assert.equal(rook.attacked, true);
  assert.equal(rook.defended, true);
  assert.equal(rook.hanging, false);
  assert.equal(rook.status, 'attacked');
  const threat = contested.threats.immediate.find((item) => item.kind === 'capture');
  assert.equal(threat.target.defended, true);
  assert.equal(threat.target.hanging, false);

  const start = coach.buildGuidance(START, result());
  const a1 = start.safety.own.find((entry) => entry.square === 'a1');
  assert.equal(a1.status, 'quiet');
  assert.equal(a1.attacked, false);
  assert.equal(a1.defended, false);
});

test('lists immediate legal opponent checks as threats, not predicted replies', () => {
  const g = coach.buildGuidance(CHECK_THREAT, result({ move: 'e1d1', lines: [] }));
  const check = g.threats.immediate.find((threat) => threat.kind === 'check');
  assert.ok(check, 'a legal checking move exists if the turn passed');
  assert.equal(check.from, 'a8');
  assert.equal(check.to, 'e8');
  assert.equal(check.san, 'Re8+');
  assert.ok(g.evidence.basis.some((line) => line.includes('not a predicted reply')));
});

test('handles invalid positions, illegal result moves, and terminals without throwing', () => {
  const invalid = coach.buildGuidance('not a fen', result());
  assert.equal(invalid.status, 'invalid-position');
  assert.equal(invalid.suggestion, null);
  assert.ok(invalid.warnings.length > 0);

  const stale = coach.buildGuidance(START, result({ move: 'e2e5' }));
  assert.equal(stale.status, 'invalid-result');
  assert.equal(stale.suggestion, null);
  assert.ok(stale.warnings.some((warning) => warning.includes('not legal')));

  const mate = coach.buildGuidance('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', null);
  assert.equal(mate.status, 'terminal');
  assert.equal(mate.suggestion, null);
  assert.equal(mate.hint.conceptKey, 'game-over');
  assert.equal(mate.explanation.category, 'game-over');
  assert.ok(mate.explanation.headline.toLowerCase().includes('checkmate'));
});

test('keeps threats without inventing a suggestion when no result exists', () => {
  const g = coach.buildGuidance(HANGING_QUEEN, null);
  assert.equal(g.status, 'no-suggestion');
  assert.equal(g.suggestion, null);
  assert.equal(g.hint.conceptKey, 'activity');
  assert.ok(!g.hint.text.includes('game is over'));
  assert.ok(g.threats.immediate.length > 0);
  assert.ok(g.highlights.arrows.some((a) => a.kind === 'threat'));
});

test('marks analysis as static-only instead of implying search confidence', () => {
  const g = coach.buildGuidance(START, result({
    depth: 0,
    nodes: 0,
    time: 0,
    scoreSource: 'static',
    exactScores: false,
    lines: []
  }));
  assert.equal(g.analysis.searchCompleteness, 'static-only');
  assert.equal(g.analysis.pv, null);
  assert.equal(g.second, null);
  assert.ok(g.evidence.limitations.some((line) => line.includes('static fallback')));
  assert.ok(g.evidence.limitations.some((line) => line.includes('deeper or longer') ) === false);
});

test('invalidates on FEN or revision changes but not clock-only changes', () => {
  const g = coach.buildGuidance(START, result(), { revision: 4 });
  assert.equal(coach.isStale(g, START, 4), false);
  assert.equal(coach.isStale(g, START, 5), true);
  assert.equal(coach.isStale(g, AFTER_E4, 4), true);
  const clockOnly = START.replace(/ 0 1$/, ' 0 9');
  assert.equal(coach.isStale(g, clockOnly, 4), false);
});

test('rates a matched move as good and refuses non-comparable feedback', () => {
  const before = result();
  const after = result({ move: 'e7e5', score: 0, depth: 8, lines: [] });

  const matched = coach.buildFeedback({
    beforeFen: START,
    afterFen: AFTER_E4,
    before,
    after,
    played: 'e2e4'
  });
  assert.equal(matched.status, 'rated');
  assert.equal(matched.source, 'NyxReview');
  assert.equal(matched.matched, true);
  assert.equal(matched.loss, 0);
  assert.equal(matched.verdict, 'good');

  const playedOther = coach.buildFeedback({
    beforeFen: START,
    afterFen: AFTER_D4,
    before,
    after: { move: 'e7e5', score: 0, depth: 8, lines: [] },
    played: 'd2d4'
  });
  assert.equal(playedOther.status, 'rated');
  assert.equal(playedOther.matched, false);
  assert.equal(playedOther.loss, 28);
  assert.equal(playedOther.verdict, 'dubious');

  const nonComparable = coach.buildFeedback({
    beforeFen: START,
    afterFen: AFTER_D4,
    before,
    after: { ...after, depth: 7 },
    played: 'd2d4'
  });
  assert.equal(nonComparable.status, 'unrated');
  assert.equal(nonComparable.verdict, 'unrated');
  assert.ok(nonComparable.reason);

  const illegalPlayed = coach.buildFeedback({
    beforeFen: START,
    afterFen: AFTER_E4,
    before,
    after,
    played: 'e2e5'
  });
  assert.equal(illegalPlayed.status, 'unrated');

  const mismatchedFen = coach.buildFeedback({
    beforeFen: START,
    afterFen: AFTER_E4,
    before,
    after,
    played: 'd2d4'
  });
  assert.equal(mismatchedFen.status, 'unrated');
  assert.ok(mismatchedFen.reason.includes('does not match'));

  const noScores = coach.buildFeedback({
    beforeFen: START,
    afterFen: AFTER_D4,
    before: { move: 'e2e4', depth: 8 },
    after: { move: 'e7e5', depth: 8 },
    played: 'd2d4'
  });
  assert.equal(noScores.status, 'unrated');
  assert.ok(noScores.reason.includes('comparable score'));

  const saved = globalThis.NyxReview;
  try {
    globalThis.NyxReview = null;
    const noReview = coach.buildFeedback({
      beforeFen: START,
      afterFen: AFTER_E4,
      before,
      after,
      played: 'e2e4'
    });
    assert.equal(noReview.status, 'unrated');
    assert.ok(noReview.reason.includes('NyxReview'));
  } finally {
    globalThis.NyxReview = saved;
  }
});

test('attaches post-move feedback only when previous evidence is supplied', () => {
  const before = result();
  const after = result({ move: 'e7e5', score: 0, depth: 8, lines: [] });
  const g = coach.buildGuidance(AFTER_E4, after, {
    previous: { fen: START, result: before, played: 'e2e4' }
  });
  assert.equal(g.status, 'ready');
  assert.equal(g.feedback.status, 'rated');
  assert.equal(g.feedback.played.san, 'e4');
  assert.equal(g.feedback.loss, 0);

  const noPlayed = coach.buildGuidance(AFTER_E4, after, {
    previous: { fen: START, result: before }
  });
  assert.equal(noPlayed.feedback, null);
  assert.ok(noPlayed.warnings.some((warning) => warning.includes('previous.played')));
});

test('is deterministic for identical inputs and leaves the result untouched', () => {
  const input = result();
  const snapshot = JSON.stringify(input);
  const a = coach.buildGuidance(START, input, { revision: 2, includeThreats: true });
  const b = coach.buildGuidance(START, input, { revision: 2, includeThreats: true });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), snapshot, 'result object is not mutated');
});
