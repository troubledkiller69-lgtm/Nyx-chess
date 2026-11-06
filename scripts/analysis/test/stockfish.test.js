'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Stockfish,
  UciTimeoutError,
  UciAbortError,
  UciError,
  isAbortError,
  START_FEN
} = require('../lib/stockfish.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-stockfish.js');
const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function fake(env = {}, extra = {}) {
  return new Stockfish(process.execPath, {
    args: [FIXTURE],
    timeoutMs: 5000,
    env,
    ...extra
  });
}

test('handshake exposes id and options', async () => {
  const engine = fake();
  try {
    await engine.start();
    assert.equal(engine.version, 'FakeFish 1.0');
    assert.equal(engine.id.author, 'Nyx adapter tests');
    assert.ok(engine.hasOption('Threads'));
    assert.ok(engine.hasOption('Clear Hash'));
    await engine.setOption('Threads', 2);
    await engine.isReady();
  } finally {
    await engine.close();
  }
});

test('cp score keeps the root mover perspective for White and Black', async () => {
  const engine = fake();
  try {
    await engine.start();
    const white = await engine.analyze({ fen: START_FEN, depth: 5 });
    assert.equal(white.bestmove, 'e2e4');
    assert.equal(white.score.type, 'cp');
    assert.equal(white.score.value, 105);
    assert.equal(white.depth, 5);
    assert.equal(white.nodes, 5000);

    const black = await engine.analyze({ fen: BLACK_TO_MOVE, depth: 4 });
    assert.equal(black.score.type, 'cp');
    assert.equal(black.score.value, -96);
  } finally {
    await engine.close();
  }
});

test('searchmoves is sent and its move is returned', async () => {
  const engine = fake();
  try {
    await engine.start();
    const result = await engine.analyze({
      fen: START_FEN,
      depth: 3,
      searchmoves: ['g1f3']
    });
    assert.equal(result.bestmove, 'g1f3');
    assert.equal(result.depth, 3);
  } finally {
    await engine.close();
  }
});

test('mate and bound scores are parsed without conversion', async () => {
  const mate = fake({ FAKE_MODE: 'mate' });
  try {
    await mate.start();
    const result = await mate.analyze({ fen: START_FEN, depth: 2 });
    assert.deepEqual(result.score, { type: 'mate', value: 1, bound: null, raw: 'mate 1' });
  } finally {
    await mate.close();
  }

  const bound = fake({ FAKE_MODE: 'bound' });
  try {
    await bound.start();
    const result = await bound.analyze({ fen: START_FEN, depth: 2 });
    assert.equal(result.score.type, 'cp');
    assert.equal(result.score.bound, 'lowerbound');
  } finally {
    await bound.close();
  }
});

test('missing score stays missing rather than becoming zero', async () => {
  const engine = fake({ FAKE_MODE: 'no-score' });
  try {
    await engine.start();
    const result = await engine.analyze({ fen: START_FEN, depth: 2 });
    assert.equal(result.score, null);
  } finally {
    await engine.close();
  }
});

test('a silent engine times out and is cleaned up', async () => {
  const engine = fake({ FAKE_DELAY_MS: '5000' });
  try {
    await engine.start();
    const started = Date.now();
    await assert.rejects(
      engine.analyze({ fen: START_FEN, depth: 5, timeoutMs: 300 }),
      (error) => error instanceof UciTimeoutError
    );
    assert.ok(Date.now() - started < 3000, 'timeout should not wait for the fake delay');
    assert.equal(engine.busy, false);
  } finally {
    await engine.close();
  }
});

test('an aborted search rejects as an abort and can be closed', async () => {
  const engine = fake({ FAKE_DELAY_MS: '5000' });
  const controller = new AbortController();
  try {
    await engine.start();
    const promise = engine.analyze({
      fen: START_FEN,
      depth: 5,
      timeoutMs: 5000,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, (error) => error instanceof UciAbortError && isAbortError(error));
    assert.equal(engine.busy, false);
  } finally {
    await engine.close();
  }
});

test('a crashed engine rejects the running search with a clear error', async () => {
  const engine = fake({ FAKE_MODE: 'crash' });
  try {
    await engine.start();
    await assert.rejects(
      engine.analyze({ fen: START_FEN, depth: 3, timeoutMs: 5000 }),
      (error) => error instanceof UciError && /exited unexpectedly/.test(error.message)
    );
  } finally {
    await engine.close();
  }
});

test('works when the executable argument path contains spaces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx fake engine '));
  const copy = path.join(dir, 'fake stockfish fixture.js');
  const executableCopy = path.join(dir, 'node executable copy.exe');
  fs.copyFileSync(FIXTURE, copy);
  fs.copyFileSync(process.execPath, executableCopy);
  const engine = new Stockfish(executableCopy, {
    args: [copy],
    timeoutMs: 5000
  });
  try {
    await engine.start();
    const result = await engine.analyze({ fen: START_FEN, depth: 2 });
    assert.equal(result.bestmove, 'e2e4');
  } finally {
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
