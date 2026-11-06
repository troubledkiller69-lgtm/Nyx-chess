const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/engine.js');
const { START_FEN } = C;

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const HANGING_QUEEN = '4k3/8/8/4p3/3Q4/8/8/4K3 w - - 0 1';

async function harness(settings = {}, fen = START_FEN) {
  const listeners = {}, posts = [], engine = [], timers = new Map();
  let message, timerId = 0, port;
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, postMessage: (data) => posts.push(data) };
  const store = {};
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
      storage: { local: { get: async (keys) => typeof keys === 'string' ? { [keys]: store[keys] } : { ...store }, set: async (value) => Object.assign(store, value) } } },
    NyxChess: C
  });
  for (const file of ['settings.js', 'profile.js', 'human.js', 'review.js', 'session.js', 'coach.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  }
  await Promise.resolve();
  let current = { available: true, fen, turn: fen.split(' ')[1], orientation: 'w', result: '*', boardId: 1,
    revision: 1, url: 'https://www.chess.com/game/live/77777', gameId: '77777',
    clocks: { w: 300000, b: 300000 }, historyFens: [fen] };
  const emit = (data) => {
    if (data.type === 'state' && data.state) current = { ...current, ...data.state };
    return listeners.message({ source: window, origin: 'https://www.chess.com',
      data: { channel: 'nyx-chess-v1', direction: 'page', ...data } });
  };
  emit({ type: 'state', state: current });
  const request = (type, extra = {}) => new Promise((resolve) => message({ channel: 'nyx-chess-v1', type, ...extra }, {}, resolve));
  await request('configure', { settings: { control: 'coach', side: 'w', autoRematch: 'no', ...settings } });
  await request('start');
  return {
    emit, request, posts, engine, timers, context,
    get state() { return current; },
    ready: () => port.onmessage({ data: { type: 'ready' } }),
    response: (data) => port.onmessage({ data }),
    search: () => engine.filter((data) => data.type === 'think').at(-1),
    analyse: (search, result) => port.onmessage({ data: { type: 'result', id: search.id, fen: search.fen, result } }),
    coachPosts: () => posts.filter((data) => data.type === 'coach')
  };
}

function result(overrides = {}) {
  return {
    move: 'e2e4', score: 20, mate: null, depth: 8, nodes: 42000, time: 180,
    scoreSource: 'search', exactScores: true, legalMoves: 20,
    lines: [{ move: 'e2e4', score: 20 }, { move: 'd2d4', score: 10 }],
    ...overrides
  };
}

test('coach shows the move arrow by default and staged hints remain optional', async () => {
  const h = await harness();
  h.ready();
  h.analyse(h.search(), result());

  let status = await h.request('status');
  assert.equal(status.coach.active, true);
  assert.equal(status.coach.hintLevel, 'move', 'arrow mode is the default');
  assert.equal(status.coach.suggestion.san, 'e4');
  assert.equal(status.coach.second.san, 'd4');
  assert.equal(status.coach.arrowVisible, true);
  assert.equal(h.posts.some((data) => data.type === 'hint'), false, 'no autoplay arrow in coach mode');
  const initial = h.coachPosts().at(-1);
  assert.equal(initial.reveal, 'move');
  assert.equal(initial.mode, 'arrow');
  assert.equal(initial.guidance.hint.move.san, 'e4');
  assert.equal(initial.guidance.analysis.pv, null, 'no PV is invented');
  assert.ok(initial.guidance.highlights.arrows.some((arrow) => arrow.kind === 'suggestion' && arrow.from === 'e2' && arrow.to === 'e4'));

  // Hiding the arrow is a single toggle in arrow mode, not a hidden piece step.
  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'concept');
  assert.equal(status.coach.suggestion, null);
  assert.equal(status.coach.arrowVisible, false);
  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'move');
  assert.equal(status.coach.suggestion.san, 'e4');

  // Opting into staged hints rebuilds at concept and advances piece -> move.
  await h.request('configure', { settings: { control: 'coach', coachHints: 'staged' } });
  status = await h.request('status');
  assert.equal(status.coach.hintMode, 'staged');
  assert.equal(status.coach.hintLevel, 'concept');
  assert.equal(status.coach.suggestion, null);
  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'piece');
  assert.equal(status.coach.hint.piece.name, 'pawn');
  assert.equal(status.coach.suggestion, null);
  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'move');
  assert.equal(status.coach.suggestion.san, 'e4');
  const stagedMove = h.coachPosts().at(-1);
  assert.equal(stagedMove.mode, 'staged');
  assert.ok(stagedMove.guidance.highlights.arrows.some((arrow) => arrow.kind === 'suggestion' && arrow.from === 'e2' && arrow.to === 'e4'));

  await h.request('coach-reveal');
  status = await h.request('status');
  assert.equal(status.coach.hintLevel, 'concept', 'hiding returns to the concept level');
  assert.equal(h.posts.some((data) => data.type === 'move'), false);
});

test('coach guidance clears when the position goes stale', async () => {
  const h = await harness();
  h.ready();
  h.analyse(h.search(), result());
  await h.request('coach-reveal');
  assert.equal((await h.request('status')).coach.active, true);
  h.emit({ type: 'state', state: { ...h.state, fen: AFTER_E4, turn: 'b', revision: 2, historyFens: [START_FEN, AFTER_E4] } });
  const status = await h.request('status');
  assert.equal(status.coach.active, false);
  assert.equal(h.coachPosts().at(-1).guidance, null);
});

test('threat marks follow the toggle and describe legal opponent moves only', async () => {
  const h = await harness({}, HANGING_QUEEN);
  h.ready();
  h.analyse(h.search(), result({ move: 'd4e5', score: 900, lines: [{ move: 'd4e5', score: 900 }] }));
  let status = await h.request('status');
  assert.ok(status.coach.threats.immediate >= 1, 'the black e5 pawn can legally capture the queen');
  let guidance = h.coachPosts().at(-1).guidance;
  assert.ok(guidance.threats.immediate.some((threat) => threat.kind === 'capture' && threat.to === 'd4'));
  assert.ok(guidance.threats.immediate.every((threat) => threat.legal === true));
  assert.ok((guidance.evidence.limitations || []).some((line) => /defender/i.test(line)), 'geometric defender limitation is disclosed');

  await h.request('configure', { settings: { control: 'coach', side: 'w', autoRematch: 'no', coachThreats: 'no' } });
  status = await h.request('status');
  guidance = h.coachPosts().at(-1).guidance;
  assert.equal(status.coach.threats.immediate, 0);
  assert.deepEqual([...guidance.threats.immediate], []);
});

test('coach feedback is attached only from a matching before/after pair', async () => {
  const h = await harness({ side: 'both' });
  h.ready();
  h.analyse(h.search(), result({ move: 'e2e4', score: 20, depth: 8, exactScores: true }));
  h.emit({ type: 'state', state: { ...h.state, fen: AFTER_E4, turn: 'b', revision: 2, historyFens: [START_FEN, AFTER_E4] } });
  const after = h.search();
  h.analyse(after, { move: 'e7e5', score: 5, depth: 8, exactScores: true, scoreSource: 'search',
    lines: [{ move: 'e7e5', score: 5 }] });
  const status = await h.request('status');
  assert.equal(status.coach.active, true);
  assert.equal(status.coach.feedback.status, 'rated');
  assert.equal(status.coach.feedback.matched, true);
  assert.equal(status.coach.feedback.loss, 0);
  assert.equal(h.coachPosts().at(-1).guidance.analysis.pv, null);

  // A mismatched before/after pair must be unrated, not guessed.
  const mismatch = await harness({ side: 'both' });
  mismatch.ready();
  mismatch.analyse(mismatch.search(), result({ move: 'd2d4', score: 20, depth: 8 }));
  mismatch.emit({ type: 'state', state: { ...mismatch.state, fen: AFTER_E4, turn: 'b', revision: 2, historyFens: [START_FEN, AFTER_E4] } });
  mismatch.analyse(mismatch.search(), { move: 'e7e5', score: 5, depth: 6, exactScores: false, scoreSource: 'search' });
  const unrated = await mismatch.request('status');
  assert.equal(unrated.coach.feedback.status, 'unrated', JSON.stringify(unrated.coach.feedback));
  assert.ok(unrated.coach.feedback.reason);
});
