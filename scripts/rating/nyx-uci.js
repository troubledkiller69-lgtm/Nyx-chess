// Minimal UCI adapter for a Nyx Chess engine build.
//
// This exists so a mature paired-game runner (cutechess-cli, fastchess) can
// drive Nyx without a browser. It is intentionally small: UCI handshake,
// position, go, and a fixed ruthless search. It does not implement pondering,
// MultiPV, or asynchronous stop.
//
// Usage:
//   node scripts/rating/nyx-uci.js <path-to-engine.js>
//
// The engine file is loaded from the path given at startup. Freeze and hash
// that file before a match; this adapter performs no copying.

'use strict';

const path = require('node:path');
const readline = require('node:readline');

function loadEngine(file) {
  const resolved = path.resolve(file);
  delete require.cache[resolved];
  const module = require(resolved);
  if (typeof module.Engine !== 'function' || typeof module.Position !== 'function') {
    throw new Error(`${file} does not export Engine and Position`);
  }
  return module;
}

function numberToken(tokens, name, fallback) {
  const index = tokens.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(tokens[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/rating/nyx-uci.js <path-to-engine.js>');
    process.exit(2);
  }
  const C = loadEngine(file);
  let engine = new C.Engine();
  let position = new C.Position(C.START_FEN);
  let history = [position.fen()];
  let mask = null;

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  function send(line) {
    process.stdout.write(`${line}\n`);
  }

  function setPosition(tokens) {
    let index = 1;
    let fen = C.START_FEN;
    if (tokens[index] === 'startpos') {
      index++;
    } else if (tokens[index] === 'fen') {
      const movesAt = tokens.indexOf('moves', index);
      const end = movesAt === -1 ? tokens.length : movesAt;
      fen = tokens.slice(index + 1, end).join(' ');
      index = end;
    } else {
      throw new Error(`unsupported position command: ${tokens.join(' ')}`);
    }
    position = new C.Position(fen);
    history = [position.fen()];
    if (tokens[index] === 'moves') {
      for (const name of tokens.slice(index + 1)) {
        const move = position.legalMoves().find((candidate) => C.uci(candidate) === name);
        if (!move) throw new Error(`illegal move ${name} in ${position.fen()}`);
        position.make(move);
        history.push(position.fen());
      }
    }
  }

  async function handle(line) {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const command = tokens[0];
    try {
      if (command === 'uci') {
        send(`id name Nyx Chess (${path.basename(file)})`);
        send('id author Nyx Chess project');
        send('option name EvalFeatureMask type spin default 0 min 0 max 63');
        send('option name Hash type spin default 160000 min 1000 max 1000000');
        send('uciok');
        return;
      }
      if (command === 'isready') {
        send('readyok');
        return;
      }
      if (command === 'ucinewgame') {
        engine = new C.Engine();
        if (mask !== null) engine.configureEvaluation(mask);
        position = new C.Position(C.START_FEN);
        history = [position.fen()];
        return;
      }
      if (command === 'setoption') {
        const nameAt = tokens.indexOf('name');
        const valueAt = tokens.indexOf('value');
        if (nameAt === -1 || valueAt === -1) return;
        const name = tokens.slice(nameAt + 1, valueAt).join(' ');
        const value = tokens.slice(valueAt + 1).join(' ');
        if (name.toLowerCase() === 'evalfeaturemask') {
          mask = Number(value);
          if (!Number.isInteger(mask) || mask < 0 || mask > 63) throw new Error(`bad EvalFeatureMask ${value}`);
          engine.configureEvaluation(mask);
        } else if (name.toLowerCase() === 'hash') {
          const size = Number(value);
          if (Number.isFinite(size)) engine.ttLimit = Math.max(1000, Math.min(1000000, Math.floor(size)));
        }
        return;
      }
      if (command === 'position') {
        setPosition(tokens);
        return;
      }
      if (command === 'go') {
        const movetime = numberToken(tokens, 'movetime', 1000);
        const nodes = numberToken(tokens, 'nodes', null);
        const depth = numberToken(tokens, 'depth', 16);
        const result = await engine.think(position.fen(), {
          mode: 'ruthless',
          skill: 100,
          variety: 0,
          depth,
          timeMs: Math.max(50, movetime),
          nodeLimit: nodes === null ? undefined : Math.max(1, nodes),
          historyFens: history
        });
        send(`info depth ${result.depth || 0} nodes ${result.nodes || 0} time ${result.time || 0} score cp ${Number.isFinite(result.score) ? result.score : 0} pv ${result.move || '0000'}`);
        send(`bestmove ${result.move || '0000'}`);
        return;
      }
      if (command === 'quit') {
        rl.close();
        return;
      }
      if (command === 'stop' || command === 'ponderhit' || command === 'debug') return;
      send(`info string unknown command ${command}`);
    } catch (error) {
      send(`info string error ${String(error.message || error).replace(/\s+/g, ' ')}`);
      if (command === 'go') send('bestmove 0000');
    }
  }

  rl.on('line', (line) => {
    queue = queue.then(() => handle(line)).catch((error) => {
      send(`info string fatal ${String(error.message || error).replace(/\s+/g, ' ')}`);
    });
  });
  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
