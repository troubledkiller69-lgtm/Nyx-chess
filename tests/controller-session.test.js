const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/engine.js');
const { START_FEN } = C;

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

async function harness(extraSettings = {}, initial = {}) {
  const listeners = {}, posts = [], engine = [], timers = new Map(), store = {};
  let message, timerId = 0, port;
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, postMessage: (data) => posts.push(data) };
  const storage = {
    get: async (keys) => {
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
      return { ...store };
    },
    set: async (value) => { Object.assign(store, value); }
  };
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
      storage: { local: storage } },
    NyxChess: C
  });
  for (const file of ['settings.js', 'profile.js', 'human.js', 'session.js', 'coach.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  await Promise.resolve();
  const emit = (data) => {
    if (data.type === 'state' && data.state) Object.assign(state, data.state);
    return listeners.message({ source: window, origin: 'https://www.chess.com', data: { channel: 'nyx-chess-v1', direction: 'page', ...data } });
  };
  const state = { available: true, fen: START_FEN, turn: 'w', orientation: 'w', result: '*', boardId: 1,
    revision: 1, url: 'https://www.chess.com/game/live/55555', gameId: '55555',
    clocks: { w: 300000, b: 300000 }, historyFens: [START_FEN], ...initial };
  emit({ type: 'state', state });
  const request = (type, extra = {}) => new Promise((resolve) => message({ channel: 'nyx-chess-v1', type, ...extra }, {}, resolve));
  await request('configure', { settings: { side: 'w', autoRematch: 'no', ...extraSettings } });
  return { emit, state, request, posts, engine, timers, store, context,
    ready: () => port.onmessage({ data: { type: 'ready' } }),
    response: (data) => port.onmessage({ data }),
    result: (search) => port.onmessage({ data: { type: 'result', id: search.id, fen: search.fen, result: { move: 'e2e4', score: 10 } } }) };
}

const terminal = (h, result, overrides = {}) => ({ ...h.state, result, revision: 2, ...overrides });

test('a terminal board is counted once even when revisions and orientation move', async () => {
  const h = await harness();
  await h.request('start');
  const finished = terminal(h, '1-0');
  h.emit({ type: 'state', state: finished });
  let status = await h.request('status');
  assert.equal(status.session.games, 1);
  const counts = { ...status.session.counts };
  assert.deepEqual(counts, { win: 1, draw: 0, loss: 0, unknown: 0 });
  assert.equal(status.session.byMode.human.games, 1);
  assert.equal(status.session.byMode.human.win, 1);

  h.emit({ type: 'state', state: { ...finished, revision: 3, clocks: { w: 10, b: 20 } } });
  h.emit({ type: 'state', state: { ...finished, revision: 4, orientation: 'b' } });
  status = await h.request('status');
  assert.equal(status.session.games, 1, 'clock ticks and orientation flips are not new games');
  assert.equal(status.selectedSide, 'w', 'the side lock survives an orientation flip');
});

test('a new board or a fresh game on the same URL gets a new identity', async () => {
  const h = await harness();
  await h.request('start');
  h.emit({ type: 'state', state: terminal(h, '1-0') });

  // Same URL and same game id, but Chess.com replaced the board element.
  h.emit({ type: 'state', state: { ...h.state, boardId: 2, result: '*', fen: START_FEN,
    revision: 10, clocks: { w: 300000, b: 300000 }, historyFens: [START_FEN] } });
  h.emit({ type: 'state', state: { ...h.state, boardId: 2, result: '0-1', fen: AFTER_E4,
    revision: 11, historyFens: [START_FEN, AFTER_E4] } });
  let status = await h.request('status');
  assert.equal(status.session.games, 2);
  assert.deepEqual({ ...status.session.counts }, { win: 1, draw: 0, loss: 1, unknown: 0 });

  // Same board element reused for a rematch: result resets and the move
  // counter drops back to the start, which is a new game.
  h.emit({ type: 'state', state: { ...h.state, boardId: 2, result: '*', fen: START_FEN,
    revision: 12, clocks: { w: 300000, b: 300000 }, historyFens: [START_FEN] } });
  h.emit({ type: 'state', state: { ...h.state, boardId: 2, result: '1/2-1/2', fen: START_FEN,
    revision: 13, historyFens: [START_FEN] } });
  status = await h.request('status');
  assert.equal(status.session.games, 3);
  assert.equal(status.session.byMode.human.draw, 1);
});

test('unrecognised terminal results stay unknown', async () => {
  const h = await harness();
  await h.request('start');
  h.emit({ type: 'state', state: terminal(h, 'server said something') });
  const status = await h.request('status');
  const counts = { ...status.session.counts };
  assert.deepEqual(counts, { win: 0, draw: 0, loss: 0, unknown: 1 });
  assert.deepEqual({ ...status.session.streak.current }, { result: null, count: 0 });
});

test('coach, human and ruthless games are counted in separate buckets', async () => {
  for (const [settings, mode] of [[{ control: 'coach' }, 'coach'], [{ mode: 'human' }, 'human'], [{ mode: 'ruthless' }, 'ruthless']]) {
    const h = await harness(settings);
    await h.request('start');
    h.emit({ type: 'state', state: terminal(h, '1-0', { fen: AFTER_E4, turn: 'b' }) });
    const status = await h.request('status');
    assert.equal(status.session.byMode[mode].games, 1, `${mode} game should be separated`);
    assert.equal(status.session.byMode[mode].win, 1);
    assert.equal(status.session.games, 1);
  }
});

test('the opening clock separates time controls', async () => {
  const h = await harness({}, { clocks: { w: 60000, b: 60000 } });
  await h.request('start');
  h.emit({ type: 'state', state: terminal(h, '1-0', { clocks: { w: 60000, b: 60000 } }) });
  const status = await h.request('status');
  assert.equal(status.session.byTime.bullet, 1);
  assert.equal(status.session.byTime.blitz, 0);
});

test('stop-after-games stops the controller and leaves stats until reset', async () => {
  const h = await harness({ stopAfterGames: 1 });
  await h.request('start');
  h.emit({ type: 'state', state: terminal(h, '1-0') });
  let status = await h.request('status');
  assert.equal(status.running, false);
  assert.match(status.message, /Session limit reached: 1 game/);
  assert.equal(status.session.limit.reached, true);

  await h.request('session-reset');
  status = await h.request('status');
  assert.equal(status.session.games, 0);
  assert.equal(status.session.limit.reached, false);
});

test('repeated queue clicks are bounded and a refused queue stops cleanly', async () => {
  const h = await harness({ autoRematch: 'yes' });
  await h.request('start');
  for (let i = 0; i < 5; i++) h.emit({ type: 'queue', ok: false });
  const status = await h.request('status');
  assert.equal(status.running, false);
  assert.equal(status.queue.failures, 5);
  assert.match(status.message, /Queue could not start a game after 5 tries/);
});
