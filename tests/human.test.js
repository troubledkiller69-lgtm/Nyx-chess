const { test } = require('node:test');
const assert = require('node:assert/strict');
const Human = require('../src/human.js');

const constant = (value) => () => value;
const noon = new Date(2026, 0, 15, 14, 0, 0).getTime();
const night = new Date(2026, 0, 15, 2, 0, 0).getTime();

test('clock allocation preserves a reserve and increases time-pressure errors', () => {
  const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const rapid = Human.clockPlan({ remaining: 600000, fen });
  const panic = Human.clockPlan({ remaining: 10000, fen });
  assert.ok(rapid.pauseMax >= 8000);
  assert.ok(panic.searchMax + panic.pauseMax < 1000);
  assert.ok(panic.errorScale > rapid.errorScale);
  assert.equal(Human.clockPlan({ remaining: 500, fen, elapsed: 400 }).pauseMax, 0);
  assert.equal(Human.clockPlan({ fen }).pauseMax, Infinity);
});

test('tempo uses complete opponent turns and ignores clock polls', () => {
  const tempo = Human.createTempo();
  const state = { available: true, boardId: 1, url: 'board' };
  const observe = (fen, turn, now) => tempo.observe({ ...state, fen, turn }, 'w', now);
  observe('a', 'b', 0); observe('b', 'w', 500);
  assert.equal(tempo.scale(), 1, 'partial first turn is ignored');
  observe('c', 'b', 1000); observe('c', 'b', 1200); observe('d', 'w', 1800);
  observe('e', 'b', 2000); observe('f', 'w', 2800);
  assert.equal(tempo.scale(), 0.8);
  tempo.reset(); assert.equal(tempo.scale(), 1);
});

test('session keeps normal waits short and schedules full breaks', () => {
  const session = Human.createSession({ rng: constant(0.1), startedAt: noon });
  const first = session.nextGameDelay(noon);
  assert.ok(first >= 6000 && first <= 25000, `normal delay ${first}`);
  for (let i = 0; i < 9; i++) session.recordGame({ result: 'win', moves: 30 });
  const rest = session.nextGameDelay(noon);
  assert.ok(rest >= 240000 && rest <= 720000, `break delay ${rest}`);
});

test('losing streaks and late hours stretch waits', () => {
  const tilt = Human.createSession({ rng: constant(0) });
  tilt.recordGame({ result: 'loss' });
  tilt.recordGame({ result: 'loss' });
  const long = tilt.nextGameDelay(noon);
  assert.ok(long >= 90000 && long <= 240000, `tilt delay ${long}`);

  const day = Human.createSession({ rng: constant(0.9) });
  const late = Human.createSession({ rng: constant(0.9) });
  for (let i = 0; i < 3; i++) {
    day.recordGame({ result: 'loss' });
    late.recordGame({ result: 'loss' });
  }
  const dayDelay = day.nextGameDelay(noon);
  const nightDelay = late.nextGameDelay(night);
  assert.ok(nightDelay > dayDelay, `night ${nightDelay} should exceed day ${dayDelay}`);
});

test('rematch declines never happen twice in a row', () => {
  const session = Human.createSession({ rng: constant(0) });
  assert.equal(session.shouldDeclineRematch(constant(0)), true);
  assert.equal(session.shouldDeclineRematch(constant(0)), false);
});

test('recent opening lines lose weight without becoming impossible', () => {
  const memory = Human.createOpeningMemory(null, { rng: constant(0) });
  const candidates = [
    { id: 'italian', line: 'e2e4 e7e5 g1f3 b8c6 f1c4' },
    { id: 'london', line: 'd2d4 d7d5 c1f4 g8f6 e2e3' }
  ];
  assert.equal(memory.weightedPick(candidates, 'w', constant(0.2)).id, 'italian');
  memory.noteLine('w', candidates[0].line);
  assert.equal(memory.weightedPick(candidates, 'w', constant(0.2)).id, 'london');
  for (let i = 0; i < 13; i++) memory.noteLine('w', `c2c4 g8f6 b1c3 ${i}`);
  assert.deepEqual([
    memory.weightedPick([candidates[0]], 'w', constant(0)).id,
    memory.weightedPick(candidates, 'w', constant(0.2)).id
  ], ['italian', 'italian']);
});

test('opening memory ignores corrupt storage and persists a versioned snapshot', async () => {
  const storage = {
    value: '{not-json',
    async get() { return this.value; },
    async set(value) { this.value = value; }
  };
  const memory = Human.createOpeningMemory(storage, { rng: constant(0) });
  await memory.ready;
  const candidates = [
    { id: 'italian', line: 'e2e4 e7e5' },
    { id: 'london', line: 'd2d4 d7d5' }
  ];
  assert.equal(memory.weightedPick(candidates, 'w', constant(0.2)).id, 'italian');
  await memory.noteLine('w', candidates[0].line);
  const reloaded = Human.createOpeningMemory(storage, { rng: constant(0) });
  await reloaded.ready;
  assert.deepEqual([
    storage.value.v,
    Array.isArray(storage.value.e),
    reloaded.weightedPick(candidates, 'w', constant(0.2)).id
  ], [1, true, 'london']);
});

test('endgame plans protect wins and trade down when lost', () => {
  const winningFen = '7k/8/8/8/8/8/4Q3/4K3 w - - 0 1';
  const losingFen = '4k3/8/8/8/8/8/4q3/4K3 w - - 0 1';
  const winning = Human.endgamePlan(winningFen, { score: 900, rng: constant(0.5) });
  assert.deepEqual([
    Human.isEndgame(winningFen),
    Human.isEndgame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
  ], [true, false]);
  assert.ok(winning.drift >= 0 && winning.drift <= 40 &&
    winning.repeatChance > 0 && winning.repeatChance <= 0.08 && winning.avoidStalemate,
  `winning plan ${JSON.stringify(winning)}`);
  const losing = Human.endgamePlan(losingFen, { score: -900, rng: constant(0.5) });
  assert.ok(losing.drift > winning.drift && losing.drift <= 60 && losing.tradeDown && !losing.avoidStalemate,
    `losing plan ${JSON.stringify(losing)}`);
});

test('resignation is gated by score, move count, and a roll', () => {
  const fen = '8/8/8/8/8/8/4q3/4K3 w - - 0 1';
  assert.equal(Human.shouldResign(fen, { score: -1200, movesPlayed: 40, rng: constant(0) }), true);
  assert.deepEqual([
    Human.shouldResign(fen, { score: -1200, movesPlayed: 20, rng: constant(0) }),
    Human.shouldResign(fen, { score: -300, movesPlayed: 40, rng: constant(0) }),
    Human.shouldResign(fen, { score: 0, movesPlayed: 40, rng: constant(0) }),
    Human.shouldResign(fen, { score: -1200, movesPlayed: 40, rng: constant(0.99) })
  ], [false, false, false, false]);
});

test('think time always leaves an additive human pause', () => {
  const totals = [constant(0), constant(0.99)].map((rng) =>
    Human.thinkTime({ base: 400, elapsed: 3000, complexity: 0.6, rng }));
  assert.ok(totals.every((total) => total >= 3120 && total <= 60000), `think times ${totals}`);
});

test('mouse pauses stay inside physical bounds', () => {
  const pauses = [constant(0), constant(0.999)].map((rng) => Human.mousePause(rng));
  assert.ok(pauses.every((pause) => pause.hover >= 120 && pause.hover <= 450 &&
    pause.settle >= 40 && pause.settle <= 160), `mouse pauses ${JSON.stringify(pauses)}`);
});
