const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { START_FEN } = require('../src/engine.js');

test('worker routes book moves, searches, and invalid input without losing request IDs', async () => {
  const messages = [];
  const context = vm.createContext({ performance, self: { postMessage: (message) => messages.push(message) } });
  context.importScripts = (...names) => names.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context));
  context.importScripts('worker.js');
  await context.self.onmessage({ data: { id: 1, fen: START_FEN, options: { openingWhite: 'kings-gambit' } } });
  assert.equal(messages[0].result.source, 'book');
  assert.equal(messages[0].result.move, 'e2e4');
  await context.self.onmessage({ data: { id: 2, fen: START_FEN, options: { depth: 2, timeMs: 100 } } });
  assert.equal(messages[1].result.source, 'search');
  assert.equal(messages[1].id, 2);
  await context.self.onmessage({ data: { id: 3, fen: 'not a position', options: {} } });
  assert.equal(messages[2].id, 3);
  assert.match(messages[2].error, /Invalid/);
});

test('worker applies the Deep preset budget before search', async () => {
  const messages = [];
  const context = vm.createContext({ performance, self: { postMessage: (message) => messages.push(message) } });
  context.importScripts = (...names) => names.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context));
  context.importScripts('worker.js');
  let seen;
  context.NyxChess.Engine.prototype.think = async (fen, options) => {
    seen = { fen, options };
    return { move: 'e2e4', score: 0, mate: null, depth: options.depth, nodes: 1, time: options.timeMs, lines: [] };
  };
  await context.self.onmessage({ data: { id: 4,
    fen: 'r1bqk2r/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQK2R w KQkq - 0 8',
    options: { pace: 'deep', openingWhite: 'none', openingBlack: 'none' } } });
  assert.equal(seen.options.timeMs, 1500, 'the Deep preset reaches the engine intact');
  assert.equal(seen.options.delayMs, 0);
  assert.equal(seen.options.depth, 12);
  assert.equal(messages.at(-1).type, 'result');
  assert.equal(messages.at(-1).id, 4);
});

function workerContext() {
  const context = vm.createContext({
    performance,
    self: { postMessage() {} }
  });
  context.importScripts = (...names) => names.forEach((name) =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context));
  context.importScripts('worker.js');
  return context;
}

test('single-worker host preserves a real deliberate error and its metadata', async () => {
  let listener, workerResult;
  const parent = {};
  class FakeWorker {
    constructor() {
      this.context = workerContext();
      this.context.self.postMessage = (message) => {
        workerResult = message.result;
        queueMicrotask(() => this.onmessage?.({ data: message }));
      };
    }
    postMessage(data) { queueMicrotask(() => this.context.self.onmessage({ data })); }
    terminate() {}
  }
  const context = vm.createContext({ parent, navigator: { hardwareConcurrency: 8 },
    window: { addEventListener: (_name, fn) => { listener = fn; } }, Worker: FakeWorker });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/host.js'), 'utf8'), context);
  const port = { postMessage() {} };
  listener({ source: parent, origin: 'https://www.chess.com', data: { type: 'nyx-engine-connect' }, ports: [port] });
  const response = await new Promise((resolve) => {
    port.postMessage = resolve;
    port.onmessage({ data: { type: 'think', id: 80, fen: START_FEN,
      blunder: true, blunderMin: 80, blunderMax: 450,
      options: { mode: 'human', elo: 'max', depth: 3, timeMs: 5000 } } });
  });
  assert.equal(response.result, workerResult, 'forward the full selected result unchanged');
  assert.equal(response.result.blundered, true);
  assert.ok(response.result.blunderLoss >= 80);
  assert.notEqual(response.result.move, response.result.lines[0].move);
  assert.equal(response.result.exactScores, true);
});

test('single-worker host passes terminal results without requiring candidate lines', () => {
  let listener, worker;
  const parent = {}, posts = [];
  const context = vm.createContext({ parent,
    window: { addEventListener: (_name, fn) => { listener = fn; } },
    Worker: class { constructor() { worker = this; } postMessage() {} terminate() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/host.js'), 'utf8'), context);
  const port = { postMessage: (data) => posts.push(data) };
  listener({ source: parent, origin: 'https://www.chess.com', data: { type: 'nyx-engine-connect' }, ports: [port] });
  port.onmessage({ data: { type: 'think', id: 81, fen: START_FEN, options: { mode: 'human' } } });
  const result = { move: null, mate: -1, score: -100000, lines: [] };
  worker.onmessage({ data: { type: 'result', id: 81, result } });
  assert.equal(posts.at(-1).result, result);
});

test('engine host replaces a running worker when cancellation arrives', () => {
  let listener;
  let created = 0, terminated = 0;
  const parent = {};
  const context = vm.createContext({
    parent, window: { addEventListener: (_name, fn) => { listener = fn; } },
    Worker: class { constructor() { created++; } terminate() { terminated++; } postMessage() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/host.js'), 'utf8'), context);
  const port = { postMessage() {} };
  listener({ source: parent, origin: 'https://www.chess.com', data: { type: 'nyx-engine-connect' }, ports: [port] });
  assert.equal(created, 1);
  port.onmessage({ data: { type: 'cancel' } });
  assert.equal(terminated, 1);
  assert.equal(created, 2);
});

test('worker runs a review request and reports progress plus the final report', async () => {
  const messages = [];
  const context = vm.createContext({ performance, self: { postMessage: (message) => messages.push(message) } });
  context.importScripts = (...names) => names.forEach((name) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context));
  context.importScripts('worker.js');
  const position = new (require('../src/engine.js').Position)(START_FEN);
  const history = [position.fen()];
  position.make(position.legalMoves().find((move) => require('../src/engine.js').uci(move) === 'e2e4'));
  history.push(position.fen());
  await context.self.onmessage({ data: {
    type: 'review', id: 7, historyFens: history, side: 'w', depth: 2, timeMs: 100, nodeLimit: 5000
  } });
  const result = messages.find((message) => message.type === 'review-result');
  assert.ok(result, 'review result was posted');
  assert.equal(result.id, 7);
  assert.equal(result.review.reviewed, 1);
  assert.ok(messages.some((message) => message.type === 'review-progress' && message.id === 7));
});

test('host runs a review on a dedicated worker and terminates it on completion', async () => {
  let listener, created = 0, terminated = 0;
  const posts = [];
  class FakeWorker {
    constructor() { created++; }
    postMessage(data) {
      if (data.type !== 'review') return;
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'review-progress', id: data.id, done: 1, total: 1 } });
        this.onmessage?.({ data: { type: 'review-result', id: data.id,
          review: { side: 'w', reviewed: 1, rated: 1, unrated: 0, counts: { good: 1 }, averageLoss: 0, moves: [] } } });
      });
    }
    terminate() { terminated++; }
  }
  const context = vm.createContext({
    parent: {}, navigator: { hardwareConcurrency: 1 },
    window: { addEventListener: (_name, fn) => { listener = fn; } }, Worker: FakeWorker, queueMicrotask
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/host.js'), 'utf8'), context);
  const port = { postMessage: (message) => posts.push(message) };
  listener({ source: context.parent, origin: 'https://www.chess.com', data: { type: 'nyx-engine-connect' }, ports: [port] });
  port.onmessage({ data: { type: 'review', id: 9, historyFens: [START_FEN], side: 'w' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.find((message) => message.type === 'review-progress')?.done, 1);
  assert.equal(posts.find((message) => message.type === 'review-result')?.id, 9);
  assert.equal(created, 2, 'one pooled search worker plus one review worker');
  assert.equal(terminated, 1, 'the review worker is released after the report');
});

test('host refuses a review while a game search is active and cancels a running review', () => {
  let listener, terminated = 0, worker;
  const posts = [];
  class FakeWorker {
    constructor() { worker = this; }
    postMessage() {}
    terminate() { terminated++; }
  }
  const context = vm.createContext({
    parent: {}, navigator: { hardwareConcurrency: 1 },
    window: { addEventListener: (_name, fn) => { listener = fn; } }, Worker: FakeWorker,
    setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/host.js'), 'utf8'), context);
  const port = { postMessage: (message) => posts.push(message) };
  listener({ source: context.parent, origin: 'https://www.chess.com', data: { type: 'nyx-engine-connect' }, ports: [port] });
  port.onmessage({ data: { type: 'think', id: 1, fen: START_FEN, options: { mode: 'human' } } });
  port.onmessage({ data: { type: 'review', id: 2, historyFens: [START_FEN], side: 'w' } });
  assert.match(posts.find((message) => message.type === 'review-result').error, /busy/i);
  // Finish the game search, then start and cancel a review.
  worker.onmessage({ data: { type: 'result', id: 1, result: { move: 'e2e4', lines: [] } } });
  port.onmessage({ data: { type: 'review', id: 3, historyFens: [START_FEN], side: 'w' } });
  port.onmessage({ data: { type: 'review-cancel', id: 3 } });
  assert.equal(posts.find((message) => message.type === 'review-cancelled')?.id, 3);
  assert.ok(terminated >= 1, 'cancelling terminates the review worker');
});

test('ruthless host splits root moves across hardware workers and merges the result', async () => {
  let listener;
  let created = 0;
  const parent = {};
  class FakeWorker {
    constructor() {
      created++;
      this.context = workerContext();
      this.context.self.postMessage = (message) => queueMicrotask(() => this.onmessage?.({ data: message }));
    }
    postMessage(data) {
      queueMicrotask(() => this.context.self.onmessage({ data }));
    }
    terminate() {}
  }
  const context = vm.createContext({
    parent,
    navigator: { hardwareConcurrency: 8 },
    window: { addEventListener: (_name, fn) => { listener = fn; } },
    Worker: FakeWorker,
    setTimeout,
    clearTimeout,
    queueMicrotask
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/host.js'), 'utf8'), context);
  const port = { postMessage() {} };
  listener({ source: parent, origin: 'https://www.chess.com', data: { type: 'nyx-engine-connect' }, ports: [port] });
  // Eight cores minus one page core, capped at four search workers.
  assert.equal(created, 4);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('parallel search timed out')), 10000);
    port.postMessage = (message) => {
      if (message.type !== 'result') return;
      clearTimeout(timer);
      resolve(message);
    };
    port.onmessage({ data: {
      type: 'think', id: 41, fen: START_FEN,
      options: { mode: 'ruthless', depth: 3, timeMs: 80 }, historyFens: []
    } });
  });
  assert.equal(result.id, 41);
  assert.equal(result.result.source, 'search');
  assert.ok(result.result.nodes > 0);
  assert.ok(result.result.depth >= 1);
  assert.ok(new (require('../src/engine.js').Position)(START_FEN).legalMoves()
    .map((move) => require('../src/engine.js').uci(move)).includes(result.result.move));
});
