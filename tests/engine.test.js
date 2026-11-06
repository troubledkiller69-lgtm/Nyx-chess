const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine.js');
const Book = require('../src/openings.js');
const Settings = require('../src/settings.js');

test('move generation matches reference perft counts, preserving the position', () => {
  const cases = [
    [C.START_FEN, 4, 197281],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4, 43238],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 3, 9467]
  ];
  for (const [fen, depth, nodes] of cases) {
    const position = new C.Position(fen);
    assert.equal(C.perft(position, depth), nodes);
    assert.equal(position.fen(), fen);
    assert.equal(position.undoStack.length, 0);
  }
});

test('finds mate and a genuinely hanging queen', async () => {
  const engine = new C.Engine();
  const mate = await engine.think('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', { depth: 3, timeMs: 500 });
  assert.equal(mate.move, 'a1a8');
  assert.equal(mate.mate, 1);
  const capture = await engine.think('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1', { depth: 3, timeMs: 500 });
  assert.equal(capture.move, 'e4d5');
});

test('repetition history marks claimable drawing moves and preserves a winning alternative', async () => {
  const position = new C.Position();
  const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  const historyFens = [];
  for (const uci of cycle) {
    const move = position.legalMoves().find((candidate) => C.uci(candidate) === uci);
    position.make(move);
    historyFens.push(position.fen());
  }
  // Current start position occurred three times; every legal move can be searched normally,
  // but the search must know all prior positions for future repetition adjudication.
  assert.equal(historyFens.filter((fen) => C.positionKey(fen) === C.positionKey(position.fen())).length, 2);
  const engine = new C.Engine();
  const result = await engine.think(position.fen(), { depth: 3, timeMs: 300, historyFens });
  assert.ok(result.move);
  assert.equal(result.depth > 0, true);

  const winningFen = '4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1';
  const repeatedDrawFen = '4k3/8/8/3q4/4P3/8/8/4K3 b - - 1 1';
  const winning = await engine.think(winningFen, { depth: 2, timeMs: 300, variety: 100, skill: 0, random: () => 0.99,
    historyFens: [repeatedDrawFen, repeatedDrawFen] });
  // Black-to-move FEN is not a legal previous position for White's immediate move, so this
  // also ensures histories are keyed by side-to-move and not just piece placement.
  assert.equal(winning.move, 'e4d5');
});

test('zobrist hash is incremental and matches a fresh position', () => {
  const position = new C.Position();
  const start = `${position.hashA}:${position.hashB}`;
  for (let i = 0; i < 40; i++) {
    const legal = position.legalMoves();
    if (!legal.length) break;
    const move = legal[(i * 5 + 1) % legal.length];
    const before = `${position.hashA}:${position.hashB}`;
    position.make(move);
    const fresh = new C.Position(position.fen());
    assert.equal(position.hashA, fresh.hashA, `hashA after ${C.uci(move)}`);
    assert.equal(position.hashB, fresh.hashB, `hashB after ${C.uci(move)}`);
    position.unmake();
    assert.equal(`${position.hashA}:${position.hashB}`, before);
  }
  assert.equal(`${position.hashA}:${position.hashB}`, start);
});

test('threefold occurrences include the node being evaluated', () => {
  const engine = new C.Engine();
  const repeated = C.hashKey(new C.Position(C.START_FEN));
  engine.path.set(repeated, 1);
  engine.rootOccurrences = new Map([[repeated, 1]]);
  const result = engine.negamax(new C.Position(C.START_FEN), 1, -C.MATE, C.MATE, 0);
  assert.equal(result, 0);
  assert.equal(engine.path.get(repeated), 1);
});

test('recognizes terminal positions, stalemate at the horizon, and malformed FEN', async () => {
  const engine = new C.Engine();
  const fen = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
  const result = await engine.think(fen);
  assert.equal(result.move, null);
  assert.equal(result.score, 0);
  assert.equal(engine.qsearch(new C.Position(fen), -C.MATE, C.MATE, 1), 0);
  assert.throws(() => new C.Position('8/8/8/8/8/8/8/8 w - - 0 1'), /Invalid/);
});

test('static fallback ranks moves from the mover perspective and only completed search results are sampled', async () => {
  const engine = new C.Engine();
  const fallback = await engine.think('4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1', {
    depth: 6, timeMs: 50, nodeLimit: 1, skill: 0, variety: 100, random: () => 0.99
  });
  assert.equal(fallback.depth, 0);
  assert.equal(fallback.scoreSource, 'static');
  assert.equal(fallback.best, fallback.bestMove);
  assert.ok(new C.Position('4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1').legalMoves().includes(fallback.best));
});

test('quiescence prioritizes checkmate over the fifty-move draw', () => {
  const mate = new C.Position('7k/6Q1/6K1/8/8/8/8/8 b - - 100 1');
  const engine = new C.Engine();
  engine.deadline = Infinity;
  assert.equal(engine.qsearch(mate, -C.MATE, C.MATE, 3), -C.MATE + 3);
});

test('quiescence includes en passant and all quiet underpromotions', () => {
  const ep = new C.Position('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const moves = new Int32Array(256);
  let count = ep.generateMoves(moves, true);
  assert.ok([...moves.slice(0, count)].map(C.uci).includes('e5d6'));
  const engine = new C.Engine();
  engine.deadline = Infinity;
  const seen = [];
  const make = ep.make.bind(ep);
  ep.make = (move) => { seen.push(C.uci(move)); make(move); };
  engine.qsearch(ep, -C.MATE, C.MATE, 1);
  assert.ok(seen.includes('e5d6'));
  const promotion = new C.Position('7k/P7/8/8/8/8/8/7K w - - 0 1');
  count = promotion.generateMoves(moves, true);
  assert.deepEqual([...moves.slice(0, count)].map(C.uci).sort(), ['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
});

test('all opening lines are legal, deviations fall back, and custom lines validate', () => {
  for (const opening of Book.repertoire) for (const line of opening.lines) assert.ok(Book.compile(line).length);
  assert.equal(Book.pick(C.START_FEN, { openingWhite: 'kings-gambit' }).move, 'e2e4');
  const position = new C.Position();
  for (const move of ['e2e4', 'e7e5']) position.make(position.legalMoves().find((m) => C.uci(m) === move));
  assert.equal(Book.pick(position.fen(), { openingWhite: 'kings-gambit' }).move, 'f2f4');
  const deviation = new C.Position();
  for (const move of ['e2e4', 'c7c5']) deviation.make(deviation.legalMoves().find((m) => C.uci(m) === move));
  assert.equal(Book.pick(deviation.fen(), { openingWhite: 'kings-gambit' }), null);
  assert.equal(Book.pick(deviation.fen(), { openingWhite: 'smith-morra' }).move, 'd2d4');
  assert.equal(Book.validate('e2e4 e7e5 e1e3').ok, false);
  assert.equal(Book.pick(C.START_FEN, { openingWhite: 'custom', customLine: 'g1f3 d7d5' }).move, 'g1f3');
  assert.equal(Book.pick(C.START_FEN, { openingWhite: 'custom', customLineWhite: 'e2e4 e7e5' }).move, 'e2e4');
  const afterE4 = new C.Position();
  afterE4.make(afterE4.legalMoves().find((move) => C.uci(move) === 'e2e4'));
  assert.equal(Book.pick(afterE4.fen(), { openingBlack: 'custom', customLineBlack: 'e2e4 c7c5' }).move, 'c7c5');
  assert.equal(Book.pick(afterE4.fen(), { openingBlack: 'custom', customLineBlack: '' }), null);
  assert.ok(Book.repertoire.length >= 60);
});

test('strength, styles and variety always return legal moves with matching scores', async () => {
  const legal = new C.Position().legalMoves();
  for (const style of ['balanced', 'tactical', 'positional']) {
    const result = await new C.Engine().think(C.START_FEN, { depth: 4, timeMs: 100, skill: 40, variety: 80, style });
    assert.ok(legal.includes(result.best));
    assert.ok(result.depth <= 3);
    assert.equal(result.move, C.uci(result.best));
    const line = result.lines.find((item) => item.move === result.move);
    if (line) assert.equal(line.score, result.score);
  }
  assert.equal(Settings.normalize({ timeMs: Infinity }).timeMs, 450);
});

test('a deliberate blunder drops material without becoming a random move', async () => {
  const engine = new C.Engine();
  const result = await engine.think(C.START_FEN, {
    depth: 4, timeMs: 1500, blunder: true, random: () => 0.5
  });
  assert.equal(result.blundered, true);
  assert.notEqual(result.move, C.uci(result.bestMove));
  assert.ok(result.blunderLoss >= 80 && result.blunderLoss <= 450);
  const legal = new C.Position().legalMoves().map((move) => C.uci(move));
  assert.ok(legal.includes(result.move));
  assert.ok(Number.isFinite(result.gap));
  assert.ok(result.legalMoves >= 20);
  // The same mechanism produces the small, frequent inaccuracies.
  const soft = await engine.think(C.START_FEN, {
    depth: 4, timeMs: 1500, blunder: true, blunderMin: 30, blunderMax: 120, random: () => 0.5
  });
  assert.ok(soft.blundered === false || (soft.blunderLoss >= 30 && soft.blunderLoss <= 120));
  // Forced mate is never thrown away.
  const mate = await engine.think('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', {
    depth: 3, timeMs: 500, blunder: true
  });
  assert.equal(mate.blundered, false);
  assert.equal(mate.move, 'a1a8');
});

test('static exchange evaluation separates free, equal and losing captures', () => {
  const free = new C.Position('4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1');
  assert.equal(C.see(free, free.legalMoves().find((m) => C.uci(m) === 'e4d5')), 900);

  const defended = new C.Position('4k3/8/5n2/3p4/4Q3/8/8/4K3 w - - 0 1');
  assert.equal(C.see(defended, defended.legalMoves().find((m) => C.uci(m) === 'e4d5')), -800);

  const winning = new C.Position('4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1');
  assert.equal(C.see(winning, winning.legalMoves().find((m) => C.uci(m) === 'e4d5')), 320);

  const enPassant = new C.Position('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  assert.equal(C.see(enPassant, enPassant.legalMoves().find((m) => C.uci(m) === 'e5d6')), 100);
});

test('major severity selects a 300–900 cp error when available', async () => {
  const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6';
  const result = await new C.Engine().think(fen, { depth: 3, timeMs: 2000,
    blunder: true, blunderMin: 300, blunderMax: 900, random: () => 0.5 });
  assert.equal(result.blundered, true);
  assert.ok(result.blunderLoss >= 300 && result.blunderLoss <= 900);
  assert.equal(Settings.moveQuality(result).label, 'Blunder');
});

test('maximum opening variety reaches pawn openings while zero variety keeps the best', () => {
  const pos = new C.Position();
  const legal = pos.legalMoves();
  const candidates = ['g1f3', 'b1c3', 'e2e4', 'd2d4', 'c2c4', 'g2g3'].map((name, i) => ({
    move: legal.find((m) => C.uci(m) === name), score: 100 - i * 15
  }));
  const picks = new Set();
  for (let i = 0; i < 100; i++) {
    picks.add(C.uci(C.selectCandidate(pos, candidates, { skill: 100, variety: 100 }, () => i / 100).move));
  }
  for (const name of ['g1f3', 'e2e4', 'd2d4', 'c2c4']) assert.ok(picks.has(name), name);
  assert.equal(C.uci(C.selectCandidate(pos, candidates, { skill: 100, variety: 0 }, () => 0.99).move), 'g1f3');
  assert.equal(C.uci(C.selectCandidate(pos, candidates, { mode: 'ruthless', variety: 100 }, () => 0.99).move), 'g1f3');
});

test('human mode sandbags near-best moves even at maximum Elo with zero variety', () => {
  const pos = new C.Position();
  const legal = pos.legalMoves();
  const names = ['g1f3', 'b1c3', 'e2e4', 'd2d4', 'c2c4'];
  const candidates = names.map((name, i) => ({
    move: legal.find((m) => C.uci(m) === name), score: 100 - i * 10
  }));
  const picks = new Set();
  for (let i = 0; i < 100; i++) {
    picks.add(C.uci(C.selectCandidate(pos, candidates,
      { mode: 'human', skill: 100, variety: 0 }, () => i / 100).move));
  }
  assert.ok(picks.size > 1, 'human mode must not return only the top move');
  assert.ok(!picks.has('c2c4'), 'sandbag allowance stays near-best, not random');
  assert.equal(C.uci(C.selectCandidate(pos, candidates,
    { mode: 'ruthless', skill: 100, variety: 100 }, () => 0.99).move), 'g1f3');
});

test('incremental evaluation state survives make, unmake and cloning', () => {
  const position = new C.Position();
  const before = { mg: position.mg, eg: position.eg, phase: position.phase, bishopW: position.bishopW, bishopB: position.bishopB };
  const moves = [];
  for (let ply = 0; ply < 40; ply++) {
    const legal = position.legalMoves();
    if (!legal.length) break;
    const move = legal[(ply * 7 + 3) % legal.length];
    position.make(move);
    moves.push(move);
    const fresh = new C.Position(position.fen());
    assert.equal(position.mg, fresh.mg, `mg after ply ${ply}`);
    assert.equal(position.eg, fresh.eg, `eg after ply ${ply}`);
    assert.equal(position.phase, fresh.phase, `phase after ply ${ply}`);
    assert.equal(position.bishopW, fresh.bishopW);
    assert.equal(position.bishopB, fresh.bishopB);
    assert.equal(C.evaluate(position), C.evaluate(fresh));
    const clone = position.clone();
    assert.equal(clone.mg, position.mg);
    assert.equal(clone.eg, position.eg);
  }
  while (moves.length) { position.unmake(); moves.pop(); }
  assert.equal(position.fen(), C.START_FEN);
  assert.deepEqual(
    { mg: position.mg, eg: position.eg, phase: position.phase, bishopW: position.bishopW, bishopB: position.bishopB },
    before
  );
});

test('incremental evaluation handles castling, promotions, captures and en passant', () => {
  const cases = [
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1', 'e1c1']],
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n']],
    ['1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7b8q', 'a7b8n']],
    ['4k3/8/2b5/3B4/8/8/8/4K3 w - - 0 1', ['d5c6']],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', ['e5d6']]
  ];
  for (const [fen, moves] of cases) {
    for (const name of moves) {
      const position = new C.Position(fen);
      const move = position.legalMoves().find((candidate) => C.uci(candidate) === name);
      assert.ok(move, `${name} should be legal in ${fen}`);
      position.make(move);
      const fresh = new C.Position(position.fen());
      assert.equal(position.mg, fresh.mg, `mg after ${name}`);
      assert.equal(position.eg, fresh.eg, `eg after ${name}`);
      assert.equal(position.phase, fresh.phase, `phase after ${name}`);
      assert.equal(position.bishopW, fresh.bishopW, `white bishops after ${name}`);
      assert.equal(position.bishopB, fresh.bishopB, `black bishops after ${name}`);
      assert.equal(C.evaluate(position), C.evaluate(fresh), `evaluate after ${name}`);
      position.unmake();
      assert.equal(position.fen(), fen);
    }
  }
});

test('Elo settings migrate, clamp and scale the actual engine options', () => {
  assert.equal(Settings.normalize({ skill: 100 }).elo, 2200);
  assert.equal(Settings.normalize({ skill: 0 }).elo, 600);
  assert.equal(Settings.normalize({ elo: 1300, skill: 100 }).elo, 1300);
  assert.equal(Settings.normalize({ elo: 5000 }).elo, 2200);
  assert.equal(Settings.normalize({ elo: 10 }).elo, 600);
  assert.equal(Settings.normalize({ elo: 500 }).elo, 600);
  assert.equal(Settings.normalize({ elo: 600 }).elo, 600);
  assert.equal(Settings.normalize({ elo: 2200 }).elo, 2200);
  assert.equal(Settings.normalize({ elo: 2250 }).elo, 2200);
  assert.equal(Settings.normalize({ elo: NaN }).elo, 1600);
  assert.equal(Settings.engineOptions({ elo: 600 }).skill, 0);
  assert.equal(Settings.engineOptions({ elo: 1400 }).skill, 50);
  assert.equal(Settings.engineOptions({ elo: 2200 }).skill, 100);
  assert.equal(Settings.normalize({ elo: 'max' }).elo, 'max');
  assert.equal(Settings.engineOptions({ elo: 'max', depth: 6 }).skill, 100);
  assert.equal(Settings.engineOptions({ elo: 'max', depth: 6 }).depth, 6);
  const migrated = Settings.normalize({ customLine: 'e2e4 e7e5' });
  assert.equal(migrated.customLineWhite, 'e2e4 e7e5');
  assert.equal(migrated.customLineBlack, 'e2e4 e7e5');
  const split = Settings.normalize({ customLine: 'e2e4', customLineWhite: 'd2d4', customLineBlack: '' });
  assert.equal(split.customLineWhite, 'd2d4');
  assert.equal(split.customLineBlack, '');
  assert.equal(Settings.normalize({}).mode, 'human');
  assert.equal(Settings.normalize({ mode: 'nonsense' }).mode, 'human');
  const ruthless = Settings.engineOptions({ mode: 'ruthless', elo: 600, variety: 90, blunders: 3 });
  assert.equal(ruthless.skill, 100);
  assert.equal(ruthless.variety, 0);
  assert.equal(ruthless.blunders, 0);
  assert.equal(ruthless.ruthless, true);
  assert.equal(Settings.normalize({ blunders: 9 }).blunders, 3);
  assert.equal(Settings.normalize({ blunders: -4 }).blunders, 0);
  assert.equal(Settings.normalize({}).blunders, 2);
  assert.equal(Settings.normalize({ autoRematch: 'yes' }).autoRematch, true);
  assert.equal(Settings.normalize({ autoRematch: true }).autoRematch, true);
  assert.equal(Settings.normalize({ autoRematch: 'no' }).autoRematch, false);
  assert.deepEqual(Settings.paces.bullet, { timeMs: 160, delayMs: 25 });
  const profile = C.playProfile({ mode: 'ruthless', depth: 6, skill: 5, variety: 100 });
  assert.equal(profile.varied, false);
  assert.equal(profile.maxLoss, 0);
  assert.equal(profile.maxDepth, 6);
  assert.equal(C.playProfile({ elo: 'max' }).varied, false);
  assert.equal(C.playProfile({ elo: 'max', variety: 40 }).varied, true);
});

test('Deep is faster, stays above Rapid, and does not overwrite Custom budgets', () => {
  assert.deepEqual(Settings.paces.deep, { timeMs: 1500, delayMs: 0 });
  assert.ok(Settings.paces.deep.timeMs > Settings.paces.rapid.timeMs);

  const selected = Settings.normalize({ pace: 'deep' });
  assert.equal(selected.pace, 'deep');
  assert.equal(selected.timeMs, 1500);
  assert.equal(selected.delayMs, 0);
  assert.equal(selected.depth, 12, 'a bare Deep choice keeps the default depth cap');

  // Exactly the old shipped Deep pair follows the new preset.
  const legacyDeep = Settings.normalize({ pace: 'deep', timeMs: 5000, delayMs: 0 });
  assert.equal(legacyDeep.pace, 'deep');
  assert.equal(legacyDeep.timeMs, 1500);
  assert.equal(legacyDeep.delayMs, 0);

  // A user's explicit Custom 5 s budget and a non-default Deep value survive.
  const custom = Settings.normalize({ pace: 'custom', timeMs: 5000, delayMs: 0 });
  assert.equal(custom.pace, 'custom');
  assert.equal(custom.timeMs, 5000);
  const deepCustom = Settings.normalize({ pace: 'deep', timeMs: 4200, delayMs: 0 });
  assert.equal(deepCustom.pace, 'custom');
  assert.equal(deepCustom.timeMs, 4200);
  const deepDelay = Settings.normalize({ pace: 'deep', timeMs: 5000, delayMs: 250 });
  assert.equal(deepDelay.pace, 'custom');
  assert.equal(deepDelay.timeMs, 5000);
  assert.equal(deepDelay.delayMs, 250);

  assert.equal(Settings.searchBudgetLabel('deep', 1500, 0),
    '1.5 s search budget (small overrun possible)');
  assert.equal(Settings.searchBudgetLabel('rapid', 1400, 350), '1400 ms search');
  assert.equal(Settings.searchBudgetLabel('custom', 5000, 0), '5000 ms search');
});

test('forced mates survive a root alpha that is already a mate score', async () => {
  // Regression: reverse futility pruning tested only `beta < MATE - 1000`, so
  // a beta near -MATE let any ordinary static score through. The node was
  // deciding "am I being mated?", answered "no", and the engine played a
  // slower mate or missed one entirely.
  const cases = [
    ['8/1K2Q3/8/8/8/7R/8/2k5 w - - 0 1', 'e7e2'],
    ['8/2Q5/8/K3R3/8/8/k7/8 w - - 0 1', 'c7c2']
  ];
  for (const [fen, expected] of cases) {
    const result = await new C.Engine().think(fen, {
      mode: 'ruthless', skill: 100, variety: 0, depth: 5, timeMs: 30000
    });
    assert.equal(result.move, expected, `${fen} played ${result.move}`);
    assert.ok(result.score > C.MATE - 100, `${fen} scored ${result.score}, not a mate`);
  }
});

test('a check from a distant slider is recognised as a check', async () => {
  // Regression: the check test used Manhattan distance <= 2 from the moving
  // piece to the enemy king. That cannot describe a knight move (distance 3)
  // and never describes a sliding attack, so piece checks were invisible and
  // quiet mating moves were pruned as if they were ordinary quiet moves.
  // Mate in 1 here is Rh1-h8, a check from seven squares away.
  const result = await new C.Engine().think('k7/8/K7/8/8/8/8/7R w - - 0 1', {
    mode: 'ruthless', skill: 100, variety: 0, depth: 3, timeMs: 30000
  });
  assert.equal(result.move, 'h1h8');
});
