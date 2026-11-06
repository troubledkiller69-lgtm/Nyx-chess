const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine.js');
const review = require('../src/review.js');

function historyOf(moves, fen = C.START_FEN) {
  const position = new C.Position(fen);
  const history = [position.fen()];
  for (const token of moves.split(/\s+/).filter(Boolean)) {
    const move = position.legalMoves().find((candidate) => C.uci(candidate) === token);
    assert.ok(move, `legal setup move ${token}`);
    position.make(move);
    history.push(position.fen());
  }
  return history;
}

test('moves are recovered exactly from consecutive positions', () => {
  const history = historyOf('e2e4 e7e5 g1f3 b8c6 f1c4 g8f6');
  for (let i = 0; i + 1 < history.length; i++) {
    assert.ok(review.moveBetween(C, history[i], history[i + 1]), `move ${i} recovered`);
  }
  assert.equal(review.moveBetween(C, history[0], history[1]), 'e2e4');
  assert.equal(review.moveBetween(C, history[5], history[6]), 'g8f6');
  // Clock counters do not identify a move; a reader that normalizes them must
  // not make every move unrecoverable.
  const differentClocks = history[1].replace(/ \d+ \d+$/, ' 3 9');
  assert.equal(review.moveBetween(C, history[0], differentClocks), 'e2e4');
});

test('castling and promotion are recovered, not guessed', () => {
  const castle = historyOf('e1g1', 'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  assert.equal(review.moveBetween(C, castle[0], castle[1]), 'e1g1');
  const promotion = historyOf('a7a8q', '8/P7/8/8/8/8/8/K6k w - - 0 1');
  assert.equal(review.moveBetween(C, promotion[0], promotion[1]), 'a7a8q');
});

test('mate scores compare against ordinary scores', () => {
  assert.ok(review.normalizeScore({ mate: 2, score: 99999 }) > 10000);
  assert.ok(review.normalizeScore({ mate: -2, score: -99999 }) < -10000);
  assert.ok(review.normalizeScore({ mate: 1 }) > review.normalizeScore({ mate: 5 }));
  assert.equal(review.normalizeScore({ score: 42 }), 42);
});

test('verdicts follow the loss bands', () => {
  assert.equal(review.verdictFor(0), 'good');
  assert.equal(review.verdictFor(40), 'dubious');
  assert.equal(review.verdictFor(90), 'inaccuracy');
  assert.equal(review.verdictFor(200), 'mistake');
  assert.equal(review.verdictFor(700), 'blunder');
});

test('a game-losing move is reported as a blunder', async () => {
  // 1. f3 e5 2. g4?? Qh4# — White's second move walks into mate.
  const history = historyOf('f2f3 e7e5 g2g4 d8h4');
  const engine = new C.Engine();
  const report = await review.reviewGame(engine, { historyFens: history, side: 'w', nodeLimit: 4000, depth: 10 });

  assert.equal(report.side, 'w');
  assert.equal(report.reviewed, 2, 'white made two moves');
  const g4 = report.moves.find((move) => move.played === 'g2g4');
  assert.ok(g4, 'g2g4 was reviewed');
  assert.equal(g4.verdict, 'blunder');
  assert.ok(g4.loss >= review.CUTOFF.blunder, `loss ${g4.loss} is at least a blunder`);
  assert.equal(g4.comparable, true, 'a proven mate after the move is exact at any depth');
  assert.equal(report.worst[0].played, 'g2g4', 'the worst move is the mate blunder');
  assert.ok(report.clean < 100);
});

test('the engine top move stays good when the after-search goes deeper', async () => {
  const history = historyOf('e2e4 e7e5');
  const engine = {
    async think(fen) {
      return fen === history[0]
        ? { move: 'e2e4', score: 20, depth: 6, mate: null }
        : { move: 'c7c5', score: -900, depth: 12, mate: null };
    }
  };
  const report = await review.reviewGame(engine, { historyFens: history, side: 'w' });
  assert.equal(report.moves.length, 1);
  assert.equal(report.moves[0].matched, true);
  assert.equal(report.moves[0].loss, 0);
  assert.equal(report.moves[0].verdict, 'good');
  assert.equal(report.moves[0].comparable, true);
});

test('unequal completed depths are unrated instead of a fabricated loss', async () => {
  const history = historyOf('e2e4 e7e5');
  const engine = {
    async think(fen) {
      return fen === history[0]
        ? { move: 'd2d4', score: 50, depth: 6, mate: null }
        : { move: 'c7c5', score: -900, depth: 9, mate: null };
    }
  };
  const report = await review.reviewGame(engine, { historyFens: history, side: 'w' });
  const move = report.moves[0];
  assert.equal(move.matched, false);
  assert.equal(move.comparable, false);
  assert.equal(move.loss, null);
  assert.equal(move.verdict, 'unrated');
  assert.equal(report.rated, 0);
  assert.equal(report.unrated, 1);
  assert.equal(report.averageLoss, 0);
  assert.equal(report.clean, null);
});

test('progress is reported and a stop request ends the review between moves', async () => {
  const history = historyOf('e2e4 e7e5 g1f3 b8c6');
  const engine = {
    async think() { return { move: 'e2e4', score: 0, depth: 3, mate: null }; }
  };
  const seen = [];
  const report = await review.reviewGame(engine, {
    historyFens: history,
    side: 'w',
    onProgress: ({ done, total }) => seen.push([done, total]),
    shouldStop: () => seen.length >= 1
  });
  assert.deepEqual(seen, [[1, 2]]);
  assert.equal(report.stopped, true);
  assert.equal(report.reviewed, 1);
});

test('a clean game does not invent blunders for the side that did not err', async () => {
  // White delivers mate; Black never moves a piece into a loss.
  const history = historyOf('f2f3 e7e5 g2g4 d8h4');
  const engine = new C.Engine();
  const report = await review.reviewGame(engine, { historyFens: history, side: 'b', nodeLimit: 4000, depth: 10 });
  assert.equal(report.reviewed, 2);
  assert.equal(report.counts.blunder, 0);
});

test('reviewing an empty or one-position history is a no-op', async () => {
  const engine = new C.Engine();
  const empty = await review.reviewGame(engine, { historyFens: [], side: 'w' });
  assert.equal(empty.reviewed, 0);
  assert.equal(empty.averageLoss, 0);
  const single = await review.reviewGame(engine, { historyFens: [C.START_FEN], side: 'w' });
  assert.equal(single.reviewed, 0);
});
