const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine.js');
const { dead } = require('../scripts/engine-match.js');

function flip(fen) {
  const [board, side, , , half, full] = fen.split(' ');
  return `${board.split('/').reverse().join('/').replace(/[a-z]/gi, (p) => p === p.toLowerCase() ? p.toUpperCase() : p.toLowerCase())} ${side === 'w' ? 'b' : 'w'} - - ${half} ${full}`;
}

test('evaluation is color symmetric and leaves positions intact', () => {
  const pos = new C.Position();
  for (let ply = 0; ply < 60; ply++) {
    const legal = pos.legalMoves();
    if (!legal.length) break;
    pos.make(legal[(ply * 11 + 5) % legal.length]);
    const fen = pos.fen();
    for (const style of ['balanced', 'tactical', 'positional']) {
      assert.equal(C.evaluate(pos, style), C.evaluate(new C.Position(flip(fen)), style), fen);
    }
    assert.equal(pos.fen(), fen);
  }
});

test('a clear passed pawn outranks a king-blockaded passer', () => {
  const clear = new C.Position('8/7k/3P4/8/8/8/8/K7 w - - 0 1');
  const blocked = new C.Position('8/3k4/3P4/8/8/8/8/K7 w - - 0 1');
  assert.ok(C.evaluateUncached(clear, 'balanced', 1) > C.evaluateUncached(blocked, 'balanced', 1) + 90);
});

test('evaluation prefers an active bishop over the same bishop trapped by its pawns', () => {
  const active = new C.Position('6k1/8/8/1P3P2/3B4/1P3P2/8/6K1 w - - 0 1');
  const trapped = new C.Position('6k1/8/8/2P1P3/3B4/2P1P3/8/6K1 w - - 0 1');
  assert.ok(C.evaluate(active) > C.evaluate(trapped), `${C.evaluate(active)} <= ${C.evaluate(trapped)}`);
});

test('a distant pawn challenge removes a supported knight outpost bonus', () => {
  // Compare the knight's marginal value with/without a pawn on the c-file.
  const marginal = (pawn) => {
    const withKnight = new C.Position(`6k1/${pawn}/8/8/3N4/4P3/7R/6K1 w - - 0 1`);
    const without = new C.Position(`6k1/${pawn}/8/8/8/4P3/7R/6K1 w - - 0 1`);
    return C.evaluateUncached(withKnight, 'balanced', 4) - C.evaluateUncached(without, 'balanced', 4);
  };
  assert.ok(marginal('p7') > marginal('2p5'));
});

test('a pinned knight is less useful than the same unpinned knight', () => {
  const pinned = new C.Position('4r1k1/8/8/8/8/4N3/8/4K3 w - - 0 1');
  const free = new C.Position('4r1k1/8/8/8/8/4N3/8/3K4 w - - 0 1');
  assert.ok(C.evaluateUncached(free, 'balanced', 4) > C.evaluateUncached(pinned, 'balanced', 4) + 15);
});

test('a bishop contributes more when it joins a queen attacking the king ring', () => {
  const contribution = (queen) => C.evaluate(new C.Position(`6k1/5ppp/${queen}/8/2B5/8/5PPP/6K1 w - - 0 1`))
    - C.evaluate(new C.Position(`6k1/5ppp/${queen}/8/8/8/5PPP/6K1 w - - 0 1`));
  assert.ok(contribution('7Q') > contribution('Q7'));
});

test('pawn-race evaluation accounts for the move and king interception', () => {
  const fen = '8/8/8/k3P3/8/8/8/7K w - - 0 1';
  const white = C.evaluateUncached(new C.Position(fen), 'balanced', 2) - 10;
  const black = -C.evaluateUncached(new C.Position(fen.replace(' w ', ' b ')), 'balanced', 2) + 10;
  assert.ok(white > black + 80, `${white} versus ${black}`);
});

test('endgame search promotes, preserves pawn support, and avoids stalemate', async () => {
  const cases = [
    ['7k/P7/6K1/8/8/8/8/8 w - - 0 1', ['a7a8q', 'a7a8r']],
    ['8/4k3/8/4K3/4P3/8/8/8 w - - 0 1', ['e5d5', 'e5f5', 'e5d4', 'e5f4']],
    ['7k/8/5KQ1/8/8/8/8/8 w - - 0 1', null]
  ];
  for (const [fen, accepted] of cases) {
    const result = await new C.Engine().think(fen, { mode: 'ruthless', depth: 6, timeMs: 1000 });
    const pos = new C.Position(fen), move = pos.legalMoves().find((m) => C.uci(m) === result.move);
    assert.ok(move, result.move);
    if (accepted) assert.ok(accepted.includes(result.move), result.move);
    pos.make(move);
    assert.ok(pos.legalMoves().length || pos.inCheck(pos.side), `stalemate: ${result.move}`);
  }
});

test('match adjudication does not mistake two knights or opposite bishops for dead material', () => {
  assert.equal(dead(new C.Position('7k/8/8/8/8/8/8/K7 w - - 0 1')), true);
  assert.equal(dead(new C.Position('7k/8/8/8/8/8/8/KN6 w - - 0 1')), true);
  assert.equal(dead(new C.Position('7k/8/8/8/8/8/8/KNN5 w - - 0 1')), false);
  assert.equal(dead(new C.Position('7k/8/8/8/8/8/8/KBb5 w - - 0 1')), false);
});

test('evaluation recognizes bare kings and a lone minor as dead material', () => {
  for (const fen of ['7k/8/8/8/8/8/8/K7 w - - 0 1', '7k/8/8/8/8/8/8/KN6 w - - 0 1',
    '7k/8/8/8/8/8/8/KB6 w - - 0 1']) assert.equal(C.evaluate(new C.Position(fen)), 0);
});

test('cached evaluation separates style, side and make/unmake states', () => {
  const pos = new C.Position('6k1/5ppp/8/3N4/4P3/8/5PPP/3Q2K1 w - - 0 1');
  const values = ['balanced', 'tactical', 'positional'].map((style) => C.evaluate(pos, style));
  assert.notEqual(values[0], values[1]);
  const move = pos.legalMoves()[0];
  pos.make(move);
  assert.equal(C.evaluate(pos), C.evaluate(new C.Position(pos.fen())));
  pos.unmake();
  assert.deepEqual(['balanced', 'tactical', 'positional'].map((style) => C.evaluate(pos, style)), values);
  const opposite = new C.Position(pos.fen().replace(' w ', ' b '));
  assert.equal(C.evaluate(pos) + C.evaluate(opposite), 20);
});

test('ablation evaluation rebuilds tapered piece scores without stale incremental totals', () => {
  const pos = new C.Position();
  for (const name of ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4']) {
    pos.make(pos.legalMoves().find((move) => C.uci(move) === name));
    assert.equal(C.evaluateUncached(pos, 'balanced', 0), C.evaluate(pos));
  }
});

test('feature-masked evaluation is deterministic and cache-independent', () => {
  const pos = new C.Position('6k1/5ppp/7Q/8/2B5/8/5PPP/6K1 w - - 0 1');
  assert.equal(C.evaluateUncached(pos, 'balanced', 0), C.evaluateUncached(pos, 'balanced', 0));
  assert.equal(C.evaluateUncached(pos, 'balanced', 4), C.evaluateUncached(pos, 'balanced', 4));
});

test('a configured feature mask reaches the search and survives later searches', async () => {
  // Regression: configureEvaluation used to set fields the search never read,
  // and think() reset them anyway, so every ablation measured the same build.
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6';
  const options = { mode: 'ruthless', skill: 100, variety: 0, depth: 8, timeMs: 30000 };
  const plain = await new C.Engine().think(fen, options);
  const masked = new C.Engine();
  masked.configureEvaluation(4);
  const first = await masked.think(fen, options);
  const second = await masked.think(fen, options);
  assert.notEqual(plain.score, first.score, 'mask 4 changed nothing in the search');
  assert.equal(first.score, second.score, 'the mask did not persist across searches');
});

test('staticEvaluation reports the configured evaluation, not the production one', () => {
  const pos = new C.Position('8/8/8/k3P3/8/8/8/7K w - - 0 1');
  const engine = new C.Engine();
  assert.equal(engine.staticEvaluation(pos), C.evaluate(pos));
  engine.configureEvaluation(2);
  assert.equal(engine.staticEvaluation(pos), C.evaluateUncached(pos, 'balanced', 2));
  assert.notEqual(engine.staticEvaluation(pos), C.evaluate(pos));
});

test('a custom evaluator supplied to think is used by the search', async () => {
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6';
  const options = { mode: 'ruthless', skill: 100, variety: 0, depth: 8, timeMs: 30000 };
  const plain = await new C.Engine().think(fen, options);
  const inverted = await new C.Engine().think(fen, {
    ...options, evaluate: (pos) => -C.evaluate(pos)
  });
  assert.notEqual(plain.score, inverted.score, 'the custom evaluator never reached the search');
});
