const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/engine.js');
const { START_FEN } = C;

async function harness() {
  const listeners = {}, posts = [], engine = [], timers = new Map();
  let message, timerId = 0, port;
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, postMessage: (data) => posts.push(data) };
  const context = vm.createContext({
    window, location: { origin: 'https://www.chess.com' }, URL,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    MessageChannel: class { constructor() { this.port1 = port = { postMessage: (data) => engine.push(data), close() {} }; this.port2 = {}; } },
    document: {
      createElement: () => ({ setAttribute() {}, addEventListener(name, fn) { this[name] = fn; }, contentWindow: { postMessage() {} }, remove() {} }),
      documentElement: { append: (frame) => queueMicrotask(() => frame.load()) }
    },
    chrome: { runtime: { getURL: (name) => 'chrome-extension://test/' + name, onMessage: { addListener: (fn) => { message = fn; } } },
      storage: { local: { get: async () => ({}), set: async () => {} } } },
    NyxChess: C
  });
  for (const file of ['settings.js', 'profile.js', 'human.js', 'session.js', 'coach.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  await Promise.resolve();
  const emit = (data) => listeners.message({ source: window, origin: 'https://www.chess.com', data: { channel: 'nyx-chess-v1', direction: 'page', ...data } });
  const state = { available: true, fen: START_FEN, turn: 'w', orientation: 'w', result: '*', boardId: 1, revision: 1, url: 'https://www.chess.com/analysis' };
  emit({ type: 'state', state });
  const request = (type, extra = {}) => new Promise((resolve) => message({ channel: 'nyx-chess-v1', type, ...extra }, {}, resolve));
  return { emit, state, request, posts, engine, timers, context,
    ready: () => port.onmessage({ data: { type: 'ready' } }),
    response: (data) => port.onmessage({ data }),
    result: (search) => port.onmessage({ data: { type: 'result', id: search.id, fen: search.fen, result: { move: 'e2e4', score: 10 } } }) };
}

test('stop cancels delayed moves and stale search results', async () => {
  const h = await harness();
  await h.request('start');
  h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  h.result(search);
  assert.equal((await h.request('status')).phase, 'waiting');
  await h.request('stop');
  h.result(search);
  for (const { fn } of h.timers.values()) fn();
  assert.equal(h.posts.filter((data) => data.type === 'move').length, 0);
  assert.equal((await h.request('status')).running, false);
});

test('clock telemetry does not cancel a queued autoplay move', async () => {
  const h = await harness();
  await h.request('start'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  h.result(search);
  const scheduled = [...h.timers.values()][0];
  h.emit({ type: 'state', state: { ...h.state, clocks: { w: 299000, b: 300000 } } });
  assert.equal(h.engine.filter((data) => data.type === 'think').length, 1);
  scheduled.fn();
  assert.equal(h.posts.find((data) => data.type === 'move').move, 'e2e4');
});

test('late live-game color assignment cancels the wrong-side suggestion', async () => {
  const h = await harness();
  await h.request('configure', { settings: { control: 'coach', side: 'auto' } });
  await h.request('start'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  h.result(search);
  h.emit({ type: 'state', state: { ...h.state, playingAs: 'b', revision: 2 } });
  const status = await h.request('status');
  assert.equal(status.selectedSide, 'b');
  assert.equal(status.result, undefined);
  assert.equal(status.phase, 'waiting');
  assert.equal(h.engine.filter((data) => data.type === 'think').length, 1);
  const p = new C.Position(); p.make(p.legalMoves().find((m) => C.uci(m) === 'e2e4'));
  h.emit({ type: 'state', state: { ...h.state, playingAs: 'b', fen: p.fen(), turn: 'b', revision: 3 } });
  assert.equal(h.engine.filter((data) => data.type === 'think').length, 2);
});

test('position changes clear the displayed suggestion even while stopped', async () => {
  const h = await harness();
  await h.request('configure', { settings: { control: 'coach' } });
  await h.request('start'); h.ready();
  h.result(h.engine.find((data) => data.type === 'think'));
  assert.equal((await h.request('status')).result.move, 'e2e4');
  await h.request('stop');
  const p = new C.Position(); p.make(p.legalMoves().find((m) => C.uci(m) === 'e2e4'));
  h.emit({ type: 'state', state: { ...h.state, fen: p.fen(), turn: 'b', revision: 2 } });
  assert.equal((await h.request('status')).result, undefined);
});

test('coach suggests without moving and follows manual board changes', async () => {
  const h = await harness();
  await h.request('configure', { settings: { control: 'coach', side: 'both', autoRematch: true } });
  await h.request('start'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  assert.equal(search.options.elo, 'max');
  assert.equal(search.blunder, false);
  h.result(search);
  let status = await h.request('status');
  assert.equal(status.phase, 'coaching');
  assert.equal(status.coach.active, true);
  assert.equal(status.coach.hintLevel, 'move', 'the suggestion arrow is the default');
  assert.equal(status.coach.suggestion.uci, 'e2e4');
  assert.equal(h.posts.some((data) => data.type === 'hint'), false, 'coach must not draw the autoplay arrow');
  const shown = h.posts.filter((data) => data.type === 'coach').at(-1);
  assert.equal(shown.reveal, 'move');
  assert.equal(shown.guidance.hint.move.uci, 'e2e4');
  assert.equal(shown.guidance.suggestion.uci, 'e2e4');
  assert.equal(h.timers.size, 0);

  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'concept', 'arrow mode toggles visibility in one step');
  assert.equal(status.coach.suggestion, null);
  const hidden = h.posts.filter((data) => data.type === 'coach').at(-1);
  assert.equal(hidden.reveal, 'concept');
  assert.equal(hidden.guidance.hint.move, null);

  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'move');
  assert.equal(status.coach.suggestion.uci, 'e2e4');
  const revealed = h.posts.filter((data) => data.type === 'coach').at(-1);
  assert.equal(revealed.reveal, 'move');
  assert.ok(revealed.guidance.highlights.arrows.some((arrow) => arrow.kind === 'suggestion' && arrow.from === 'e2' && arrow.to === 'e4'));

  // Staged hinting stays available as an explicit option.
  await h.request('configure', { settings: { control: 'coach', coachHints: 'staged' } });
  status = await h.request('status');
  assert.equal(status.coach.hintMode, 'staged');
  assert.equal(status.coach.hintLevel, 'concept');
  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'piece');
  assert.equal(status.coach.suggestion, null);

  const p = new C.Position(); p.make(p.legalMoves().find((m) => C.uci(m) === 'e2e4'));
  h.emit({ type: 'state', state: { ...h.state, fen: p.fen(), turn: 'b', revision: 2 } });
  assert.equal(h.engine.filter((data) => data.type === 'think').length, 2);
  const cleared = h.posts.filter((data) => data.type === 'coach').at(-1);
  assert.equal(cleared.guidance, null, 'a new position clears stale coach guidance');
  h.emit({ type: 'state', state: { ...h.state, result: '1-0', revision: 3 } });
  assert.equal(h.posts.filter((data) => ['move', 'resign', 'rematch'].includes(data.type)).length, 0);
});

test('coach recommends configured errors and counts only accepted suggestions', async () => {
  const h = await harness();
  await h.request('configure', { settings: { control: 'coach', blunders: 3, blunderSeverity: 'major', adaptive: false } });
  vm.runInContext('Math.random = () => 0.01', h.context);
  const mid = { ...h.state, fen: START_FEN.replace(' 0 1', ' 0 6'), revision: 2 };
  h.emit({ type: 'state', state: mid });
  await h.request('start'); h.ready();
  const search = h.engine.filter((data) => data.type === 'think').at(-1);
  assert.equal(search.blunder, true);
  assert.equal(search.blunderMin, 300);
  assert.equal(search.options.elo, 'max');
  h.response({ type: 'result', id: search.id, fen: search.fen,
    result: { move: 'f2f3', score: -250, blundered: true, blunderLoss: 380, depth: 8,
      exactScores: true, lines: [{ move: 'e2e4', score: 130 }] } });
  let status = await h.request('status');
  assert.equal(status.phase, 'coaching');
  assert.equal(status.pendingBlunder, true);
  assert.equal(status.blundersPlayed, 0);
  const p = new C.Position(mid.fen); p.make(p.legalMoves().find((m) => C.uci(m) === 'f2f3'));
  h.emit({ type: 'state', state: { ...mid, fen: p.fen(), turn: 'b', revision: 3 } });
  status = await h.request('status');
  assert.equal(status.blundersPlayed, 1);
  assert.equal(status.pendingBlunder, false);
  assert.equal(h.posts.filter((data) => data.type === 'move').length, 0);
});

test('coach+human shows the result immediately while keeping errors and autoplay pauses', async () => {
  const coach = await harness();
  await coach.request('configure', { settings: { control: 'coach', mode: 'human', blunders: 3,
    blunderSeverity: 'major', adaptive: false, timeMs: 1400, variety: 40 } });
  vm.runInContext('Math.random = () => 0.01', coach.context);
  const mid = { ...coach.state, fen: START_FEN.replace(' 0 1', ' 0 6'), revision: 2 };
  coach.emit({ type: 'state', state: mid });
  await coach.request('start'); coach.ready();
  const search = coach.engine.filter((data) => data.type === 'think').at(-1);
  assert.equal(coach.timers.size, 0, 'coach starts the search without a pre-search pause');
  assert.equal(search.options.timeMs, 1400, 'coach uses the configured search budget without human jitter');
  assert.equal(search.options.elo, 'max');
  assert.equal(search.options.mode, 'human');
  assert.equal(search.options.variety, 40);
  assert.equal(search.blunder, true, 'coach keeps the configured deliberate-error roll');
  assert.equal(search.blunderMin, 300);
  coach.response({ type: 'result', id: search.id, fen: search.fen,
    result: { move: 'f2f3', score: -250, blundered: true, blunderLoss: 380, depth: 8,
      exactScores: true, lines: [{ move: 'e2e4', score: 130 }] } });
  const status = await coach.request('status');
  assert.equal(status.phase, 'coaching');
  assert.equal(status.result.move, 'f2f3');
  assert.equal(status.coach.suggestion.uci, 'f2f3');
  assert.equal(status.pendingBlunder, true);
  assert.equal(coach.timers.size, 0, 'a coach result schedules no human pause');
  assert.ok(coach.posts.some((data) => data.type === 'status-changed'),
    'an open panel is refreshed when the coach result lands');
  assert.equal(coach.posts.some((data) => data.type === 'move'), false);

  const auto = await harness();
  await auto.request('configure', { settings: { control: 'autoplay', mode: 'human', blunders: 3,
    adaptive: false, timeMs: 1400 } });
  vm.runInContext('Math.random = () => 0.5', auto.context);
  auto.emit({ type: 'state', state: { ...mid } });
  await auto.request('start'); auto.ready();
  const autoSearch = auto.engine.filter((data) => data.type === 'think').at(-1);
  auto.response({ type: 'result', id: autoSearch.id, fen: autoSearch.fen,
    result: { move: 'e2e4', score: 10 } });
  const paused = await auto.request('status');
  assert.equal(paused.phase, 'waiting');
  const pause = [...auto.timers.values()].find((value) => value.ms > 0 && value.ms < 20000);
  assert.ok(pause, 'autoplay human still schedules its post-search pause');
  assert.equal(auto.posts.some((data) => data.type === 'move'), false, 'autoplay waits out the pause');
  pause.fn();
  assert.equal(auto.posts.find((data) => data.type === 'move').move, 'e2e4');
});

test('coach uses the Deep preset budget without jitter while autoplay keeps Human jitter', async () => {
  const coach = await harness();
  await coach.request('configure', { settings: { control: 'coach', mode: 'human', adaptive: false, pace: 'deep' } });
  vm.runInContext('Math.random = () => 0.5', coach.context);
  await coach.request('start'); coach.ready();
  const search = coach.engine.filter((data) => data.type === 'think').at(-1);
  assert.equal(search.options.pace, 'deep');
  assert.equal(search.options.timeMs, 1500, 'coach takes the Deep budget exactly');
  assert.equal(search.options.depth, 12, 'Deep keeps the configured maximum-depth cap');
  assert.equal(coach.timers.size, 0, 'coach still schedules no human pause');

  const auto = await harness();
  await auto.request('configure', { settings: { control: 'autoplay', mode: 'human', adaptive: false, pace: 'deep' } });
  vm.runInContext('Math.random = () => 0.5', auto.context);
  await auto.request('start'); auto.ready();
  const autoplay = auto.engine.filter((data) => data.type === 'think').at(-1);
  assert.ok(autoplay.options.timeMs >= 1050 && autoplay.options.timeMs <= 1875,
    `autoplay jitters around Deep, got ${autoplay.options.timeMs}`);
  assert.notEqual(autoplay.options.timeMs, 1500, 'Human autoplay keeps its search-time jitter');
});

test('starting on a play setup page queues instead of playing the preview', async () => {
  const h = await harness();
  await h.request('configure', { settings: { autoRematch: 'yes' } });
  h.emit({ type: 'state', state: { ...h.state, url: 'https://www.chess.com/play/online', setupPage: true, revision: 2 } });
  const status = await h.request('start');
  assert.equal(status.phase, 'queueing');
  assert.equal(status.running, true);
  assert.equal(status.queueArmed, true);
  assert.ok(h.posts.some((data) => data.type === 'queue'));
  assert.equal(h.engine.filter((data) => data.type === 'think').length, 0);
});

test('coach and plain autoplay analyze a setup preview instead of refusing', async () => {
  const coach = await harness();
  await coach.request('configure', { settings: { control: 'coach', autoRematch: 'no' } });
  coach.emit({ type: 'state', state: { ...coach.state, url: 'https://www.chess.com/play/computer', setupPage: true, revision: 2 } });
  await coach.request('start');
  coach.ready();
  assert.equal((await coach.request('status')).phase, 'thinking');
  assert.ok(coach.engine.some((data) => data.type === 'think'), 'coach should search the preview board');

  const auto = await harness();
  await auto.request('configure', { settings: { autoRematch: 'no' } });
  auto.emit({ type: 'state', state: { ...auto.state, url: 'https://www.chess.com/play/computer', setupPage: true, revision: 2 } });
  await auto.request('start');
  auto.ready();
  assert.equal((await auto.request('status')).phase, 'thinking');
  assert.ok(auto.engine.some((data) => data.type === 'think'), 'autoplay should search the preview board');
  assert.equal(auto.posts.some((data) => data.type === 'queue'), false);
});

test('auto-queue falls back to starting a new game after failed rematches', async () => {
  const h = await harness();
  await h.request('configure', { settings: { autoRematch: 'yes' } });
  await h.request('start'); h.ready();
  h.emit({ type: 'state', state: { ...h.state, result: '1-0', revision: 2 } });
  assert.equal((await h.request('status')).queueArmed, true);
  const fire = () => {
    const timer = [...h.timers.entries()].find(([, value]) => value.ms >= 5000 && value.ms <= 900000);
    assert.ok(timer, 'a rematch timer should be pending');
    h.timers.delete(timer[0]);
    timer[1].fn();
  };
  fire();
  h.emit({ type: 'state', state: { ...h.state, result: '1-0', revision: 2 } });
  fire();
  h.emit({ type: 'state', state: { ...h.state, result: '1-0', revision: 2 } });
  fire();
  assert.equal(h.posts.filter((data) => data.type === 'rematch').length, 2);
  assert.ok(h.posts.some((data) => data.type === 'queue'), 'third attempt should open the next game');
});

test('switching to coach cancels a previously queued automatic move', async () => {
  const h = await harness();
  await h.request('start'); h.ready();
  h.result(h.engine.find((data) => data.type === 'think'));
  const oldTimer = [...h.timers.values()][0];
  await h.request('configure', { settings: { control: 'coach' } });
  oldTimer.fn();
  h.result(h.engine.filter((data) => data.type === 'think').at(-1));
  assert.equal(h.posts.filter((data) => data.type === 'move').length, 0);
  assert.equal((await h.request('status')).phase, 'coaching');
});

test('board changes invalidate pending results and navigation stops autoplay', async () => {
  const h = await harness();
  await h.request('start'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  h.emit({ type: 'state', state: { ...h.state, revision: 2, fen: START_FEN.replace(' w ', ' b '), turn: 'b' } });
  h.result(search);
  assert.equal(h.posts.filter((data) => data.type === 'move').length, 0);
  assert.equal((await h.request('status')).message, 'Waiting for the other side.');
  h.emit({ type: 'state', state: { ...h.state, boardId: 2 } });
  assert.equal((await h.request('status')).running, false);
});

test('settings changes during autoplay restart active search with new options', async () => {
  const h = await harness();
  await h.request('start'); h.ready();
  const oldSearch = h.engine.find((data) => data.type === 'think');
  await h.request('configure', { settings: { side: 'both', depth: 2, delayMs: 0 } });
  const nextSearch = h.engine.filter((data) => data.type === 'think').at(-1);
  assert.notEqual(nextSearch.id, oldSearch.id);
  assert.equal(nextSearch.options.depth, 2);
  h.result(oldSearch);
  assert.equal(h.posts.filter((data) => data.type === 'move').length, 0);
  h.result(nextSearch);
  assert.equal((await h.request('status')).phase, 'waiting');
});

test('repeated identical board errors stop autoplay instead of retrying forever', async () => {
  const h = await harness();
  await h.request('start'); h.ready();
  const error = { available: false, error: 'Board API unavailable', boardId: 1, revision: 2, url: h.state.url };
  h.emit({ type: 'state', state: error });
  h.emit({ type: 'state', state: error });
  h.emit({ type: 'state', state: error });
  assert.equal((await h.request('status')).running, false);
  assert.equal((await h.request('status')).message, 'Board API unavailable');
});

test('one-move mode ignores side selection and waits for confirmation', async () => {
  const h = await harness();
  await h.request('configure', { settings: { side: 'b', delayMs: 0 } });
  await h.request('once'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  h.result(search);
  const [timer, { fn }] = [...h.timers].find(([, value]) => value.ms === 0);
  h.timers.delete(timer); fn();
  const move = h.posts.find((data) => data.type === 'move');
  assert.equal(move.move, 'e2e4');
  h.emit({ type: 'played', id: move.id, error: null });
  assert.equal((await h.request('status')).once, false);
  assert.equal((await h.request('status')).message, 'Move played.');
});

test('ruthless plays on arrival and sends the full budget', async () => {
  const h = await harness();
  await h.request('configure', { settings: { mode: 'ruthless', delayMs: 5000, timeMs: 900 } });
  await h.request('once'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  assert.equal(search.options.mode, 'ruthless');
  assert.equal(search.options.timeMs, 900);
  h.result(search);
  const timer = [...h.timers.values()].find((value) => value.ms === 0);
  assert.ok(timer, 'ruthless must not wait');
});

test('human mode jitters the search budget and waits like a person', async () => {
  const h = await harness();
  await h.request('configure', { settings: { mode: 'human', adaptive: 'no', delayMs: 1000, timeMs: 800 } });
  await h.request('start'); h.ready();
  const search = h.engine.find((data) => data.type === 'think');
  assert.ok(search.options.timeMs >= 560 && search.options.timeMs <= 1000, `budget ${search.options.timeMs}`);
  assert.equal(search.options.mode, 'human');
  h.result(search);
  const [timer, { ms }] = [...h.timers].find(([, value]) => value.ms > 0) || [];
  assert.ok(timer, 'human should schedule a delayed move');
  assert.ok(ms >= 250 && ms <= 8000, `pause ${ms}`);
});

test('human autoplay spends its blunder budget outside the opening', async () => {
  const h = await harness();
  await h.request('configure', { settings: { blunders: 3, delayMs: 50, timeMs: 800 } });
  // Force the blunder roll to fire; book moves are not in play here.
  vm.runInContext('Math.random = () => 0.01', h.context);
  h.emit({ type: 'state', state: { ...h.state, fen: START_FEN.replace(' 0 1', ' 0 6'), revision: 2 } });
  await h.request('start'); h.ready();
  const search = h.engine.filter((data) => data.type === 'think').at(-1);
  assert.equal(search.blunder, true);
  assert.equal(search.options.blunders, 3);
  assert.equal(search.blunderMin, 300);
  assert.equal(search.blunderMax, 900);
});

test('confirmed blunders are counted, retained across Stop/Start, and reset on rematch', async () => {
  const h = await harness();
  await h.request('configure', { settings: { blunders: 1, adaptive: false } });
  vm.runInContext('Math.random = () => 0.01', h.context);
  const mid = { ...h.state, fen: START_FEN.replace(' 0 1', ' 0 6'), revision: 2 };
  h.emit({ type: 'state', state: mid });
  await h.request('start'); h.ready();
  const search = h.engine.filter((data) => data.type === 'think').at(-1);
  h.response({ type: 'result', id: search.id, fen: search.fen,
    result: { move: 'f2f3', score: -100, blundered: true, blunderLoss: 150 } });
  assert.equal((await h.request('status')).blundersPlayed, 0);
  assert.equal((await h.request('status')).pendingBlunder, true);
  [...h.timers.values()][0].fn();
  const move = h.posts.find((data) => data.type === 'move');
  h.emit({ type: 'played', id: move.id, error: null });
  assert.equal((await h.request('status')).blundersPlayed, 1);
  const p = new C.Position(mid.fen); p.make(p.legalMoves().find((m) => C.uci(m) === 'f2f3'));
  h.emit({ type: 'state', state: { ...mid, fen: p.fen(), turn: 'b', revision: 3 } });
  await h.request('stop'); await h.request('start');
  assert.equal((await h.request('status')).blundersPlayed, 1);
  h.emit({ type: 'state', state: { ...mid, fen: p.fen(), turn: 'b', result: '0-1', revision: 4 } });
  h.emit({ type: 'state', state: { ...h.state, revision: 5 } });
  assert.equal((await h.request('status')).blundersPlayed, 0);
  h.emit({ type: 'state', state: { ...mid, revision: 6 } });
  await h.request('start');
  assert.equal(h.engine.filter((data) => data.type === 'think').at(-1).hardBlunder, true);
});

test('raising the blunder limit during play enables it immediately', async () => {
  const h = await harness();
  vm.runInContext('Math.random = () => 0.01', h.context);
  h.emit({ type: 'state', state: { ...h.state, fen: START_FEN.replace(' 0 1', ' 0 6'), revision: 2 } });
  await h.request('configure', { settings: { blunders: 0 } });
  await h.request('start'); h.ready();
  assert.equal(h.engine.filter((data) => data.type === 'think').at(-1).hardBlunder, false);
  await h.request('configure', { settings: { blunders: 2 } });
  assert.equal(h.engine.filter((data) => data.type === 'think').at(-1).hardBlunder, true);
});

test('adaptive layer answers an aggressive opponent with positional play', async () => {
  const h = await harness();
  await h.request('configure', { settings: { side: 'w', adaptive: 'yes', blunders: 0, variety: 100 } });
  await h.request('start'); h.ready();
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'd8f6', 'd2d3', 'f6g6',
    'b1c3', 'g6g2', 'c4f7', 'e8f7', 'f3g5', 'f7e8', 'g5f7', 'g2h1', 'e1e2', 'h1f1'];
  const position = new C.Position();
  const fens = [position.fen()];
  for (const name of moves) {
    position.make(position.legalMoves().find((candidate) => C.uci(candidate) === name));
    fens.push(position.fen());
  }
  h.emit({ type: 'state', state: { ...h.state, fen: fens.at(-1), turn: 'w', revision: 5, historyFens: fens } });
  const search = h.engine.filter((data) => data.type === 'think').at(-1);
  assert.equal(search.options.style, 'positional');
  assert.equal(search.options.variety, 100, 'adaptation must not override explicit maximum variety');
  assert.equal((await h.request('status')).profile.style, 'aggressive');
});

test('adaptive resigns a dead position instead of defending forever', async () => {
  const h = await harness();
  await h.request('configure', { settings: { adaptive: 'yes', blunders: 0 } });
  vm.runInContext('Math.random = () => 0.01', h.context);
  h.emit({ type: 'state', state: { ...h.state, fen: START_FEN.replace(' 0 1', ' 0 20'), revision: 2 } });
  await h.request('start'); h.ready();
  const search = h.engine.filter((data) => data.type === 'think').at(-1);
  h.response({ type: 'result', id: search.id, fen: search.fen,
    result: { move: 'e2e4', score: -1400, depth: 8, nodes: 1000, time: 200, source: 'search' } });
  assert.ok(h.posts.some((data) => data.type === 'resign'));
  const status = await h.request('status');
  assert.equal(status.running, false);
  assert.match(status.message, /Resigned/);
});

test('review is available after a stopped game, never during one, and can be cancelled', async () => {
  const h = await harness();
  const position = new C.Position(START_FEN);
  position.make(position.legalMoves().find((move) => C.uci(move) === 'e2e4'));
  const history = [START_FEN, position.fen()];
  await h.request('configure', { settings: { side: 'w', autoRematch: 'no' } });
  h.emit({ type: 'state', state: { ...h.state, historyFens: history } });
  await h.request('start'); h.ready();
  assert.equal((await h.request('status')).review.canStart, false, 'a live game blocks review');

  const search = h.engine.find((data) => data.type === 'think');
  h.result(search);
  h.emit({ type: 'state', state: { ...h.state, fen: position.fen(), turn: 'b', revision: 2,
    historyFens: history, result: '1-0' } });
  const stopped = await h.request('status');
  assert.equal(stopped.running, false);
  assert.equal(stopped.review.canStart, true);

  await h.request('review');
  const reviewRequest = h.engine.find((data) => data.type === 'review');
  assert.ok(reviewRequest, 'the review request reaches the engine port');
  h.response({ type: 'review-progress', id: reviewRequest.id, done: 1, total: 1 });
  h.response({ type: 'review-result', id: reviewRequest.id, review: {
    version: 1, side: 'w', reviewed: 1, rated: 1, unrated: 0,
    counts: { blunder: 0, mistake: 0, inaccuracy: 0, dubious: 0, good: 1, unrated: 0 },
    averageLoss: 0, clean: 100, stopped: false,
    worst: [{ ply: 0, number: 1, played: 'e2e4', best: 'e2e4', loss: 0, verdict: 'good', matched: true, comparable: true }]
  } });
  const reviewed = await h.request('status');
  assert.equal(reviewed.review.active, false);
  assert.equal(reviewed.review.report.reviewed, 1);
  assert.match(reviewed.review.summary, /Review:/);

  await h.request('review');
  const second = h.engine.filter((data) => data.type === 'review').at(-1);
  assert.notEqual(second.id, reviewRequest.id);
  await h.request('review-cancel');
  const cancelled = await h.request('status');
  assert.equal(cancelled.review.active, false);
  assert.match(cancelled.review.summary, /cancelled/i);
});

test('a new game cancels review and ignores its late result', async () => {
  const h = await harness();
  await h.request('configure', { settings: { side: 'w', autoRematch: 'no' } });
  await h.request('start');
  h.ready();
  await h.request('stop');
  const position = new C.Position(START_FEN);
  position.make(position.legalMoves().find((move) => C.uci(move) === 'e2e4'));
  const history = [START_FEN, position.fen()];
  h.emit({ type: 'state', state: { ...h.state, fen: position.fen(), turn: 'b', revision: 2,
    historyFens: history, result: '1-0' } });

  const report = {
    version: 1, side: 'w', reviewed: 1, rated: 1, unrated: 0,
    counts: { blunder: 0, mistake: 0, inaccuracy: 0, dubious: 0, good: 1, unrated: 0 },
    averageLoss: 0, clean: 100, stopped: false, worst: []
  };
  await h.request('review');
  const first = h.engine.find((data) => data.type === 'review');
  h.response({ type: 'review-progress', id: first.id, done: 1, total: 1 });
  h.response({ type: 'review-result', id: first.id, review: report });
  assert.equal((await h.request('status')).review.report.reviewed, 1);

  await h.request('review');
  const second = h.engine.filter((data) => data.type === 'review').at(-1);
  assert.notEqual(second.id, first.id);

  h.emit({ type: 'state', state: { ...h.state, fen: START_FEN, turn: 'w', revision: 3,
    historyFens: [START_FEN], result: '*' } });
  let status = await h.request('status');
  assert.equal(status.review.active, false);
  assert.equal(status.review.report, null, 'the previous game report is cleared');
  assert.ok(h.engine.some((data) => data.type === 'review-cancel' && data.id === second.id),
    'the host is told to terminate the review worker');

  h.response({ type: 'review-result', id: second.id, review: report });
  status = await h.request('status');
  assert.equal(status.review.report, null, 'a late result cannot attach to the new game');
});

test('auto-rematch keeps autoplay armed and clicks rematch after a pause', async () => {
  const h = await harness();
  await h.request('configure', { settings: { autoRematch: 'yes' } });
  await h.request('start'); h.ready();
  h.emit({ type: 'state', state: { ...h.state, result: '1-0', revision: 2 } });
  const status = await h.request('status');
  assert.equal(status.running, true);
  assert.equal(status.phase, 'finished');
  const timer = [...h.timers.values()].find((value) => value.ms >= 5000 && value.ms <= 900000);
  assert.ok(timer, 'rematch should be delayed like a human');
  timer.fn();
  assert.ok(h.posts.some((data) => data.type === 'rematch'));
});
