const { test } = require('node:test');
const assert = require('node:assert/strict');
global.NyxChess = require('../src/engine.js');
const Profile = require('../src/profile.js');
const C = global.NyxChess;

function replay(moves, ourSide = null) {
  const position = new C.Position();
  const fens = [position.fen()];
  for (const name of moves) {
    const move = position.legalMoves().find((candidate) => C.uci(candidate) === name);
    if (!move) throw new Error(`illegal test move ${name}`);
    position.make(move);
    fens.push(position.fen());
  }
  return Profile.create({ ourSide }).observe(fens, ourSide);
}

test('inferMove recovers a push, a capture, and castling', () => {
  const p = new C.Position();
  const step = (move) => {
    const before = p.fen();
    p.make(p.legalMoves().find((candidate) => C.uci(candidate) === move));
    return [before, p.fen()];
  };
  let [before, after] = step('e2e4');
  const push = Profile.inferMove(before, after);
  assert.equal(push.piece, 'P');
  assert.equal(push.from, 52);
  assert.equal(push.to, 36);
  [before, after] = step('d7d5');
  assert.equal(Profile.inferMove(before, after).piece, 'p');
  [before, after] = step('e4d5');
  assert.equal(Profile.inferMove(before, after).captured, 'p');
  for (const move of ['d8d5', 'b1c3', 'd5a5', 'g1f3', 'b8c6', 'f1c4', 'c8g4']) step(move);
  [before, after] = step('e1g1');
  const castle = Profile.inferMove(before, after);
  assert.equal(castle.castle, 'w');
});

test('observation counts only the opponent moves and reads castling', () => {
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1'];
  const asBlack = replay(moves, 'b');
  assert.equal(asBlack.moves, 4);
  assert.equal(asBlack.castleRate, 0.25);
  const asWhite = replay(moves, 'w');
  assert.equal(asWhite.moves, 3);
  assert.equal(asWhite.castleRate, 0);
});

test('profile returns bounded rates and a known style bucket', () => {
  const profile = replay(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1', 'f8c5'], 'w');
  assert.ok(['balanced', 'aggressive', 'solid', 'tricky'].includes(profile.style));
  for (const key of ['captureRate', 'checkRate', 'pawnRate', 'castleRate', 'tradeRate']) {
    assert.ok(profile[key] >= 0 && profile[key] <= 1, key);
  }
  assert.ok(profile.strength >= 0 && profile.strength <= 1);
  assert.equal(typeof profile.endgame, 'boolean');
});

test('adaptation keeps user settings as the floor and returns a usable style', () => {
  const model = Profile.create({ ourSide: 'w' });
  const adapted = model.adapt({ style: 'tactical', variety: 30, elo: 1800, timeMs: 1400 });
  assert.equal(adapted.style, 'tactical');
  assert.equal(adapted.variety, 30);
  assert.ok(adapted.timeScale >= 0.8 && adapted.timeScale <= 1);
  assert.equal(adapted.errorScale, 1);
  assert.ok(adapted.profile);
  assert.equal(adapted.timeMs, 1400);
});

test('an observed aggressive opponent is answered positionally', () => {
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'd8f6', 'd2d3', 'f6g6',
    'b1c3', 'g6g2', 'c4f7', 'e8f7', 'f3g5', 'f7e8', 'g5f7', 'g2h1', 'e1e2', 'h1f1'];
  const position = new C.Position();
  const fens = [position.fen()];
  for (const name of moves) {
    const move = position.legalMoves().find((candidate) => C.uci(candidate) === name);
    if (!move) throw new Error(`illegal test move ${name}`);
    position.make(move);
    fens.push(position.fen());
  }
  const model = Profile.create({ ourSide: 'w' });
  model.observe(fens, 'w');
  assert.equal(model.profile().style, 'aggressive');
  const adapted = model.adapt({ style: 'tactical', variety: 60, elo: 1800, timeMs: 1400 });
  assert.equal(adapted.style, 'positional');
  assert.ok(adapted.variety <= 12);
  assert.ok(adapted.errorScale <= 1);
});

test('a new side resets counters instead of blending games', () => {
  const model = Profile.create({ ourSide: 'w' });
  const position = new C.Position();
  const fens = [position.fen()];
  for (const name of ['e2e4', 'e7e5']) {
    position.make(position.legalMoves().find((candidate) => C.uci(candidate) === name));
    fens.push(position.fen());
  }
  assert.equal(model.observe(fens, 'w').moves, 1);
  model.reset('b');
  assert.equal(model.profile().moves, 0);
});

test('opponent memory notes results and trims old entries', async () => {
  let saved = null;
  const memory = Profile.createMemory({
    get: async () => saved,
    set: async (value) => { saved = value; }
  });
  await memory.load();
  memory.note('Rival', { style: 'solid', moves: 30 }, 'win');
  memory.note('Rival', { style: 'solid', moves: 40 }, 'loss');
  const entry = memory.get('Rival');
  assert.equal(entry.games, 2);
  assert.equal(entry.wins, 1);
  assert.equal(entry.losses, 1);
  assert.equal(entry.moves, 70);
  await memory.save();
  assert.equal(saved.v, 1);
  assert.equal(saved.opponents.Rival.games, 2);
  const loaded = Profile.createMemory({ get: async () => saved });
  await loaded.load();
  assert.equal(loaded.get('Rival').wins, 1);
});

test('corrupt opponent memory is ignored instead of throwing', async () => {
  const memory = Profile.createMemory({ get: async () => '{not json', set: async () => {} });
  await memory.load();
  assert.deepEqual(memory.data.opponents, {});
  assert.equal(memory.get('nobody'), null);
});
