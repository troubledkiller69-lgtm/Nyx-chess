const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/session.js');

function memory() {
  let value = null;
  return {
    get: async () => value,
    set: async (next) => { value = next; },
    peek: () => value
  };
}

test('results are attributed only when the side is known', () => {
  assert.equal(S.normalizeResult('1-0', 'w'), 'win');
  assert.equal(S.normalizeResult('1-0', 'b'), 'loss');
  assert.equal(S.normalizeResult('0-1', 'b'), 'win');
  assert.equal(S.normalizeResult('1/2-1/2', 'w'), 'draw');
  assert.equal(S.normalizeResult('1-0', null), 'unknown');
  assert.equal(S.normalizeResult('weird', 'w'), 'unknown');
  assert.equal(S.normalizeResult('win', 'b'), 'win');
  assert.equal(S.isTerminal('*'), false);
  assert.equal(S.isTerminal(''), false);
  assert.equal(S.isTerminal('1-0'), true);
});

test('time control is classified from the opening clock, never guessed', () => {
  assert.equal(S.classifyTime(60_000), 'bullet');
  assert.equal(S.classifyTime(300_000), 'blitz');
  assert.equal(S.classifyTime(600_000), 'blitz');
  assert.equal(S.classifyTime(900_000), 'rapid');
  assert.equal(S.classifyTime(3_600_000), 'classical');
  assert.equal(S.classifyTime(null), 'unknown');
});

test('game ids are taken from Chess.com URLs only when numeric', () => {
  assert.equal(S.gameIdFromUrl('https://www.chess.com/game/live/123456789'), '123456789');
  assert.equal(S.gameIdFromUrl('https://www.chess.com/game/computer/987654321'), '987654321');
  assert.equal(S.gameIdFromUrl('https://www.chess.com/play/computer'), null);
  assert.equal(S.gameIdFromUrl('not a url'), null);
});

test('one game is counted once even when it is recorded again', async () => {
  const backend = memory();
  let clock = 1_000_000;
  const tracker = S.createTracker({ storage: backend, now: () => clock });
  await tracker.ready;
  const game = { id: 'game:1', result: '1-0', side: 'w', mode: 'human', initialMs: 300_000,
    startedAt: clock - 120_000, endedAt: clock };

  assert.equal(tracker.recordGame(game).recorded, true);
  assert.equal(tracker.recordGame(game).recorded, false, 'the same game cannot count twice');
  assert.equal(tracker.summary().games, 1);
  assert.deepEqual(tracker.summary().counts, { win: 1, draw: 0, loss: 0, unknown: 0 });
  await tracker.save();

  // A fresh tracker reads the same storage: the dedup list survives a reload.
  const reopened = S.createTracker({ storage: backend, now: () => clock });
  await reopened.ready;
  assert.equal(reopened.summary().games, 1);
  assert.equal(reopened.recordGame(game).recorded, false);
  assert.equal(reopened.recordGame({ ...game, id: 'game:2', result: '0-1', side: 'w' }).recorded, true);
  assert.equal(reopened.summary().games, 2);
  assert.deepEqual(reopened.summary().counts, { win: 1, draw: 0, loss: 1, unknown: 0 });
});

test('wins, draws, losses, unknown and streaks are mode and time separated', async () => {
  let clock = 2_000_000;
  const tracker = S.createTracker({ now: () => clock });
  await tracker.ready;
  const record = (id, result, mode, initialMs, side = 'w') => tracker.recordGame({
    id, result, side, mode, initialMs, startedAt: clock - 60_000, endedAt: clock
  });

  record('g1', '1-0', 'human', 300_000);
  record('g2', '0-1', 'human', 300_000);
  record('g3', '1/2-1/2', 'human', 300_000);
  record('g4', 'not-a-result', 'human', 900_000);
  record('g5', '1-0', 'ruthless', 60_000);
  record('g6', '1-0', 'coach', 3_600_000);

  const summary = tracker.summary();
  assert.equal(summary.games, 6);
  assert.deepEqual(summary.counts, { win: 3, draw: 1, loss: 1, unknown: 1 });
  assert.equal(summary.byMode.human.games, 4);
  assert.equal(summary.byMode.human.loss, 1);
  assert.equal(summary.byMode.ruthless.games, 1);
  assert.equal(summary.byMode.coach.games, 1);
  assert.equal(summary.byTime.bullet, 1);
  assert.equal(summary.byTime.blitz, 3);
  assert.equal(summary.byTime.rapid, 1);
  assert.equal(summary.byTime.classical, 1);
  assert.equal(summary.byTime.unknown, 0);
  assert.deepEqual(summary.streak.current, { result: 'win', count: 2 });
  assert.equal(summary.streak.best.win, 2, 'the streak follows every recorded result');
  assert.equal(summary.timeMs, 6 * 60_000);
});

test('unknown results never become a win or a loss', async () => {
  const tracker = S.createTracker();
  await tracker.ready;
  tracker.recordGame({ id: 'x', result: '1-0', side: 'both', mode: 'human', startedAt: 0, endedAt: 1 });
  const summary = tracker.summary();
  assert.deepEqual(summary.counts, { win: 0, draw: 0, loss: 0, unknown: 1 });
  assert.deepEqual(summary.streak.current, { result: null, count: 0 });
});

test('game and minute limits report remaining time and reset explicitly', async () => {
  let clock = 10_000_000;
  const tracker = S.createTracker({ now: () => clock, stopAfterGames: 2, stopAfterMinutes: 1 });
  await tracker.ready;
  const record = (id) => tracker.recordGame({ id, result: 'win', mode: 'human', startedAt: clock - 1000, endedAt: clock });

  record('a');
  let summary = tracker.summary(clock, { stopAfterGames: 2, stopAfterMinutes: 1 });
  assert.equal(summary.limit.reached, false);
  assert.equal(summary.limit.remainingGames, 1);

  record('b');
  summary = tracker.summary(clock, { stopAfterGames: 2, stopAfterMinutes: 1 });
  assert.equal(summary.limit.reached, true);
  assert.ok(summary.limit.reasons.includes('2 games'));

  tracker.observeActive(true, clock);
  clock += 61_000;
  summary = tracker.summary(clock, { stopAfterGames: 2, stopAfterMinutes: 1 });
  assert.equal(summary.limit.remainingMs, 0);
  assert.match(summary.limit.reasons.join(','), /minute/);

  const reset = tracker.reset(clock);
  assert.equal(reset.games, 0);
  assert.equal(reset.limit.reached, false);
  assert.equal(tracker.recordGame({ id: 'a', result: 'win', mode: 'human', startedAt: clock, endedAt: clock }).recorded, true,
    'reset clears the dedup history too');
});

test('active play time accumulates only while observed active', async () => {
  let clock = 20_000_000;
  const tracker = S.createTracker({ now: () => clock });
  await tracker.ready;
  tracker.observeActive(true, clock);
  clock += 30_000;
  tracker.observeActive(false, clock);
  clock += 60_000;
  assert.equal(tracker.summary(clock).activeMs, 30_000);
});
