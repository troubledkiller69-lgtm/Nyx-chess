const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { START_FEN } = require('../src/engine.js');

function bridge({ firefox = false, mouseOnly = false } = {}) {
  const posts = [], inputs = [], timers = new Map();
  let listener, poll, now = 0, serial = 0, fen = START_FEN;
  const rect = { left: 0, top: 100, width: 400, height: 400 };
  const clock = (top) => ({ textContent: '5:00', childElementCount: 0,
    getBoundingClientRect: () => ({ top, width: 50, height: 20 }) });
  const clocks = [clock(50), clock(510)];
  let layer;
  const board = {
    isConnected: true, getBoundingClientRect: () => rect, scrollIntoView() {},
    classList: { contains: () => false }, hasAttribute: () => false,
    querySelectorAll: () => [], querySelector: () => layer,
    append: (value) => { layer = value; },
    game: { getFEN: () => fen, getLegalMoves: () => [{ from: 'e2', to: 'e4' }],
      getPlayingAs: () => 'w', getLastMove: () => ({ from: 'e2', to: 'e4' }) },
    dispatchEvent(event) {
      inputs.push(event);
      if (event.type === (mouseOnly ? 'mouseup' : 'pointerup')) fen = START_FEN.replace(' w ', ' b ');
      return true;
    }
  };
  const window = { postMessage: (data) => posts.push(data), addEventListener: (_, fn) => { listener = fn; } };
  const context = vm.createContext({ window,
    location: { origin: 'https://www.chess.com', href: 'https://www.chess.com/play/computer' },
    document: {
      querySelectorAll: (selector) => selector === 'wc-chess-board, chess-board' ? [board] : selector.includes('clock') ? clocks : [],
      elementFromPoint: () => board,
      createElementNS: () => ({ isConnected: true, style: {}, setAttribute() {}, firstElementChild: { style: {} } })
    }, getComputedStyle: () => ({ visibility: 'visible' }),
    innerWidth: 1280, innerHeight: 800,
    PointerEvent: class { constructor(type, options) { Object.assign(this, options, { type }); } },
    MouseEvent: class { constructor(type, options) { Object.assign(this, options, { type }); } },
    navigator: { userAgent: firefox ? 'Mozilla/5.0 Firefox/159.0' : 'Chrome/140.0' },
    Date: { now: () => now },
    setInterval: (fn) => { poll = fn; },
    setTimeout: (fn, ms) => { timers.set(++serial, { fn, at: now + ms }); return serial; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bridge.js'), 'utf8'), context);
  return { posts, inputs, clocks, board, poll: () => poll(),
    send(data) { listener({ source: window, origin: 'https://www.chess.com', data: {
      channel: 'nyx-chess-v1', direction: 'extension', ...data } }); },
    drain() {
      for (let count = 0; timers.size && count < 100; count++) {
        const [id, item] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(id); now = item.at; item.fn();
      }
    }
  };
}

test('clock ticks preserve the revision and delayed autoplay completes', () => {
  const h = bridge();
  const initial = h.posts.at(-1).state;
  h.clocks[1].textContent = '4:59.5'; h.poll();
  const next = h.posts.at(-1).state;
  assert.equal(next.revision, initial.revision);
  assert.equal(next.clocks.w, 299500);
  h.send({ type: 'move', id: 1, move: 'e2e4', fen: initial.fen, revision: initial.revision });
  h.clocks[1].textContent = '4:58'; h.poll(); h.drain();
  assert.ok(h.inputs.some((event) => event.type === 'pointerup'));
  assert.equal(h.posts.find((data) => data.type === 'played').error, null);
  assert.ok(h.posts.at(-1).state.revision > initial.revision);
});

test('stop cancels the delayed drag before release', () => {
  const h = bridge(), state = h.posts.at(-1).state;
  h.send({ type: 'move', id: 1, move: 'e2e4', fen: state.fen, revision: state.revision });
  h.send({ type: 'cancel' }); h.drain();
  assert.equal(h.inputs.filter((event) => event.type === 'pointerup').length, 0);
});

test('Firefox supplies mouse events to a mouse-only board', () => {
  const h = bridge({ firefox: true, mouseOnly: true });
  const state = h.posts.at(-1).state;
  h.send({ type: 'move', id: 1, move: 'e2e4', fen: state.fen, revision: state.revision });
  h.drain();
  assert.ok(h.inputs.some((event) => event.type === 'mousedown'));
  assert.ok(h.inputs.some((event) => event.type === 'mouseup'));
  assert.equal(h.posts.find((data) => data.type === 'played').error, null);
});

test('board rotation invalidates queued move coordinates', () => {
  const h = bridge();
  const initial = h.posts.at(-1).state;
  h.board.classList.contains = () => true;
  h.poll();
  assert.equal(h.posts.at(-1).state.orientation, 'b');
  assert.ok(h.posts.at(-1).state.revision > initial.revision);
  h.send({ type: 'move', id: 1, move: 'e2e4', fen: initial.fen, revision: initial.revision });
  assert.equal(h.inputs.length, 0);
  assert.match(h.posts.find((data) => data.type === 'played').error, /position changed/i);
});

test('orientation ignores an animated first piece and uses stationary pieces', () => {
  const h = bridge();
  const piece = (className, left, top) => ({ className,
    getBoundingClientRect: () => ({ left, top, width: 50, height: 50 }) });
  h.board.querySelectorAll = () => [
    piece('piece br square-88', 350, 100),
    piece('piece wr square-11', 350, 100),
    piece('piece wn square-21', 300, 100)
  ];
  h.poll();
  assert.equal(h.posts.at(-1).state.orientation, 'b');
});
