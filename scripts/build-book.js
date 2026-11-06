// Build an opening book from the engine's own games.
//
// The book is not imported from anywhere. It is the record of what this engine
// actually plays and what those moves actually score for it, which keeps the
// project's "own code, own weights" rule intact and makes the book a snapshot
// of the engine rather than a foreign opinion.
//
// Method:
//   - Play self-play games from the standard start position.
//   - Vary the play so the games explore more than one opening family.
//   - Record, for every position in the first `plyLimit` plies, which move was
//     played and how the game ended.
//   - Keep a position when it appears often enough and keep the moves that
//     were played often enough to mean something.
//
// The output is deliberately small. A book that doubles the extension's size
// for four extra opening moves is a bad trade.
//
// Usage:
//   node scripts/build-book.js [options]
//
// Options:
//   --games <n>       self-play games (default 120)
//   --time <ms>       time per move (default 40)
//   --plies <n>       plies recorded per game (default 12)
//   --min-games <n>   games a position needs before it is kept (default 4)
//   --out <file>      output path (default src/book-data.js)
//   --seed <n>        base seed (default 7)

const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/engine.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

function makeRng(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deadMaterial(pos) {
  const pieces = [...pos.board].filter((p) => p && (p & 7) !== 6);
  if (!pieces.length) return true;
  if (pieces.length === 1 && [2, 3].includes(pieces[0] & 7)) return true;
  return false;
}

function resultOf(pos, history, maxPlies) {
  const legal = pos.legalMoves();
  if (!legal.length) {
    if (!pos.inCheck(pos.side)) return 0.5; // stalemate
    return pos.side === C.WHITE ? 0 : 1;
  }
  if (pos.half >= 100) return 0.5;
  if (deadMaterial(pos)) return 0.5;
  if (history >= maxPlies) return 0.5;
  return null;
}

// One game. Returns the recorded plies and the final result.
async function playGame(seed, timeMs, plyLimit) {
  const rng = makeRng(seed);
  const white = new C.Engine();
  const black = new C.Engine();
  const pos = new C.Position(C.START_FEN);
  const historyFens = [pos.fen()];
  const recorded = [];

  for (let ply = 0; ply < 240; ply++) {
    const done = resultOf(pos, ply, 240);
    if (done !== null) return { recorded, result: done };

    const engine = pos.side === C.WHITE ? white : black;
    // Not ruthless: ruthless pins variety to 0 and the search returns the same
    // move every time, so every game would be identical. A capped variety
    // allowance explores different sound openings without recording junk.
    const result = await engine.think(pos.fen(), {
      skill: 100,
      variety: 60,
      depth: 16,
      timeMs,
      historyFens,
      random: rng
    });
    const move = pos.legalMoves().find((m) => C.uci(m) === result.move);
    if (!move) return { recorded, result: 0.5 };

    if (ply < plyLimit) {
      recorded.push({ key: C.positionKey(pos.fen()), move: result.move });
    }
    pos.make(move);
    historyFens.push(pos.fen());
  }
  return { recorded, result: 0.5 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const games = Number(args.games || 120);
  const timeMs = Number(args.time || 40);
  const plyLimit = Number(args.plies || 12);
  const minGames = Number(args['min-games'] || 4);
  const baseSeed = Number(args.seed || 7);
  const outFile = args.out
    ? path.resolve(args.out)
    : path.resolve(__dirname, '../src/book-data.js');

  // key -> move -> { games, score }
  const positions = new Map();
  let whiteWins = 0, draws = 0, blackWins = 0;

  console.log(`Self-play: ${games} games, ${timeMs} ms/move, recording ${plyLimit} plies`);
  for (let i = 0; i < games; i++) {
    const { recorded, result } = await playGame(baseSeed + i * 7919, timeMs, plyLimit);
    if (result === 1) whiteWins++;
    else if (result === 0) blackWins++;
    else draws++;

    for (const { key, move } of recorded) {
      const side = key.split(' ')[1] === 'w' ? C.WHITE : C.BLACK;
      const moverScore = side === C.WHITE ? result : 1 - result;
      let bucket = positions.get(key);
      if (!bucket) { bucket = new Map(); positions.set(key, bucket); }
      const entry = bucket.get(move) || { games: 0, score: 0 };
      entry.games++;
      entry.score += moverScore;
      bucket.set(move, entry);
    }
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${games}`);
  }

  // Keep positions that were reached often enough, and the moves that were
  // played often enough inside them.
  const book = {};
  let keptPositions = 0;
  let keptMoves = 0;
  for (const [key, bucket] of positions) {
    const total = [...bucket.values()].reduce((sum, entry) => sum + entry.games, 0);
    if (total < minGames) continue;
    const moves = [...bucket.entries()]
      .map(([move, entry]) => [move, entry.games, entry.score / entry.games])
      .filter(([, count]) => count >= Math.max(2, Math.ceil(total * 0.15)))
      .sort((a, b) => b[1] - a[1] || b[2] - a[2])
      .slice(0, 3);
    if (!moves.length) continue;
    book[key] = moves;
    keptPositions++;
    keptMoves += moves.length;
  }

  const body = [
    '// GENERATED FILE — built by scripts/build-book.js from the engine\'s own',
    '// self-play games. Do not edit by hand; rebuild it instead.',
    '//',
    `// Format: position key -> [ [uci move, games played, average score 0..1] ]`,
    `// ${games} games, ${keptPositions} positions, ${keptMoves} moves.`,
    '(function (global) {',
    "  'use strict';",
    `  global.NyxBookData = ${JSON.stringify(book)};`,
    '})(globalThis);',
    ''
  ].join('\n');

  fs.writeFileSync(outFile, body);
  const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
  console.log(`\nWrote ${outFile} (${kb} KB)`);
  console.log(`Positions kept ${keptPositions}, moves ${keptMoves}`);
  console.log(`Results: white ${whiteWins}, draw ${draws}, black ${blackWins}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
