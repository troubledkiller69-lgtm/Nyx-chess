// Bounded perft gate for an engine file.
//
// Published reference counts are hard-coded below. The runner loads one frozen
// engine file, verifies every count, and records elapsed time and nodes/second.
// It never calls the search, so it is a move-generation and make/unmake check,
// not a strength measurement.
//
// Usage:
//   node scripts/bench/run-perft.js [engine.js] [--out report.json]

'use strict';

const path = require('node:path');
const { C, loadEngine, sha256File, writeJson } = require('./lib.js');

const CASES = [
  {
    name: 'start',
    fen: C.START_FEN,
    depths: [
      [1, 20], [2, 400], [3, 8902], [4, 197281], [5, 4865609]
    ]
  },
  {
    name: 'kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    depths: [
      [1, 48], [2, 2039], [3, 97862], [4, 4085603]
    ]
  },
  {
    name: 'position-3',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    depths: [
      [1, 14], [2, 191], [3, 2812], [4, 43238], [5, 674624]
    ]
  },
  {
    name: 'position-4',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    depths: [
      [1, 6], [2, 264], [3, 9467], [4, 422333]
    ]
  },
  {
    name: 'position-5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    depths: [
      [1, 44], [2, 1486], [3, 62379], [4, 2103487]
    ]
  }
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const engineFile = args._[0]
    ? path.resolve(args._[0])
    : path.resolve(__dirname, '../../src/engine.js');
  const Engine = loadEngine(engineFile);
  const results = [];
  let failed = 0;

  console.log(`Perft engine: ${engineFile}`);
  console.log(`SHA-256:      ${sha256File(engineFile)}\n`);

  for (const testCase of CASES) {
    for (const [depth, expected] of testCase.depths) {
      const position = new Engine.Position(testCase.fen);
      const before = position.fen();
      const started = performance.now();
      const nodes = Engine.perft(position, depth);
      const elapsed = performance.now() - started;
      const restored = position.fen() === before && position.undoStack.length === 0;
      const ok = nodes === expected && restored;
      if (!ok) failed++;
      results.push({
        name: testCase.name,
        depth,
        nodes,
        expected,
        ok,
        restored,
        ms: Math.round(elapsed * 10) / 10,
        nodesPerSecond: Math.round(nodes / Math.max(elapsed / 1000, 1e-9))
      });
      console.log(
        `${(ok ? 'PASS' : 'FAIL')} ${testCase.name.padEnd(11)} d${depth} ` +
        `${String(nodes).padStart(9)} / ${String(expected).padStart(9)} ` +
        `${String(Math.round(elapsed)).padStart(6)} ms` +
        (restored ? '' : ' POSITION NOT RESTORED')
      );
    }
  }

  const report = {
    kind: 'perft',
    started: new Date().toISOString(),
    engine: { file: path.basename(engineFile), path: engineFile, sha256: sha256File(engineFile) },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    failed,
    total: results.length,
    results
  };
  report.finished = new Date().toISOString();
  if (args.out) writeJson(path.resolve(args.out), report);
  console.log(`\n${results.length - failed}/${results.length} perft checks passed.`);
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
