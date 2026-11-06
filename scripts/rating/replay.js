// Replay saved games from a rating run and verify every move is legal.
//
// Usage:
//   node scripts/rating/replay.js <run-directory-or-games.json> [--json]
//
// A run directory must contain manifest.json, frozen/candidate-engine.js, and
// games.json. Replaying uses the frozen candidate module as the referee; it
// does not search, so it is fast and deterministic.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) args[token.slice(2)] = true;
    else args._.push(token);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args._[0];
  if (!target) throw new Error('Usage: node scripts/rating/replay.js <run-directory-or-games.json> [--json]');
  const resolved = path.resolve(target);
  let gamesFile;
  let candidateFile;
  let manifest = null;
  if (fs.statSync(resolved).isDirectory()) {
    manifest = readJson(path.join(resolved, 'manifest.json'));
    gamesFile = path.join(resolved, 'games.json');
    candidateFile = path.join(resolved, manifest.inputs.candidate.frozenPath);
  } else {
    gamesFile = resolved;
    candidateFile = path.resolve(args.candidate || path.join(__dirname, '../../src/engine.js'));
  }
  if (!fs.existsSync(gamesFile)) throw new Error(`games file not found: ${gamesFile}`);
  if (!fs.existsSync(candidateFile)) throw new Error(`referee engine not found: ${candidateFile}`);

  const C = require(candidateFile);
  if (typeof C.Position !== 'function') throw new Error(`${candidateFile} does not export Position`);
  const games = readJson(gamesFile);
  const results = [];
  for (const game of games) {
    const pos = new C.Position(game.startFen || C.START_FEN);
    const history = [pos.fen()];
    for (const name of game.moves || []) {
      const move = pos.legalMoves().find((candidate) => C.uci(candidate) === name);
      if (!move) throw new Error(`game ${game.opening}/${game.candidateWhite ? 'white' : 'black'}: illegal move ${name} at ${pos.fen()}`);
      pos.make(move);
      history.push(pos.fen());
    }
    results.push({
      opening: game.opening,
      candidateWhite: game.candidateWhite,
      plies: (game.moves || []).length,
      finalFen: pos.fen(),
      legal: true
    });
  }

  if (args.json) {
    console.log(JSON.stringify({ games: results.length, results }, null, 2));
  } else {
    console.log(`replayed ${results.length} games from ${gamesFile}`);
    for (const result of results) {
      console.log(`${result.opening} (${result.candidateWhite ? 'candidate white' : 'candidate black'}): ${result.plies} plies, ${result.finalFen}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
