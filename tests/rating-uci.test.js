'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'engine.js');
const ADAPTER = path.join(ROOT, 'scripts', 'rating', 'nyx-uci.js');

test('UCI adapter answers a legal search and preserves the position', async () => {
  const C = require(ENGINE);
  const child = spawn(process.execPath, [ADAPTER, ENGINE], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = [];
  let pending = null;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  rl.on('line', (line) => {
    lines.push(line);
    if (pending && pending.pattern.test(line)) {
      const resolve = pending.resolve;
      pending = null;
      resolve(line);
    }
  });

  function waitFor(pattern, timeout = 20000) {
    return new Promise((resolve, reject) => {
      if (pending) {
        reject(new Error('only one UCI wait may be pending'));
        return;
      }
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error(`timed out waiting for ${pattern}; lines=${lines.slice(-8).join(' | ')} stderr=${stderr}`));
      }, timeout);
      pending = {
        pattern,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        }
      };
    });
  }

  try {
    child.stdin.write('uci\n');
    await waitFor(/^uciok$/);
    child.stdin.write('isready\n');
    await waitFor(/^readyok$/);
    child.stdin.write('position startpos moves e2e4 e7e5\n');
    child.stdin.write('go nodes 500\n');
    const best = await waitFor(/^bestmove /);
    const moveName = best.split(/\s+/)[1];
    assert.notEqual(moveName, '0000');

    const pos = new C.Position(C.START_FEN);
    for (const name of ['e2e4', 'e7e5']) {
      const move = pos.legalMoves().find((candidate) => C.uci(candidate) === name);
      assert.ok(move);
      pos.make(move);
    }
    const legal = pos.legalMoves().some((candidate) => C.uci(candidate) === moveName);
    assert.ok(legal, `adapter returned illegal move ${moveName} at ${pos.fen()}`);

    child.stdin.write('quit\n');
    await new Promise((resolve) => child.once('exit', resolve));
  } finally {
    rl.close();
    if (!child.killed) child.kill();
  }
});
