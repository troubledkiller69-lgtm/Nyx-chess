// Bounded, reproducible search diagnostics.
//
// A fixed node budget makes the result independent of machine speed, so a move
// or score difference between two engine files is attributable to the build,
// not to a faster CPU. A fixed wall-clock budget is also supported for the
// product-like measurement; that mode is deliberately not called deterministic.
//
// Usage:
//   node scripts/bench/run-fixed-diagnostics.js [engine.js] [options]
//
// Options:
//   --mode nodes|time     fixed nodes (default) or fixed wall-clock budget
//   --nodes <n>           nodes per position in nodes mode (default 20000)
//   --time-ms <n>         wall-clock budget in time mode (default 150)
//   --repeat <n>          repeated independent searches per position (default 2 in nodes mode, 1 in time mode)
//   --positions <file>    fixture (default diagnostics-positions.json)
//   --out <file>          JSON report path
//   --limit <n>           only the first n fixture entries

'use strict';

const os = require('node:os');
const path = require('node:path');
const { C, loadEngine, readJson, writeJson, sha256File } = require('./lib.js');

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

function applyFixture(entry) {
  if (entry.fen) return { fen: entry.fen, moves: '' };
  const pos = new C.Position(C.START_FEN);
  const applied = [];
  for (const name of String(entry.moves || '').split(/\s+/).filter(Boolean)) {
    const move = pos.legalMoves().find((candidate) => C.uci(candidate) === name);
    if (!move) throw new Error(`illegal fixture move ${name} in ${entry.id}`);
    pos.make(move);
    applied.push(name);
  }
  return { fen: pos.fen(), moves: applied.join(' ') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engineFile = args._[0]
    ? path.resolve(args._[0])
    : path.resolve(__dirname, '../../src/engine.js');
  const mode = args.mode === 'time' ? 'time' : 'nodes';
  const nodes = Math.max(1, Math.floor(Number(args.nodes || 20000)));
  const timeMs = Math.max(1, Math.floor(Number(args['time-ms'] || 150)));
  const defaultRepeat = mode === 'nodes' ? 2 : 1;
  const repeat = Math.max(1, Math.floor(Number(args.repeat || defaultRepeat)));
  const positionsFile = path.resolve(args.positions || path.join(__dirname, 'diagnostics-positions.json'));
  const fixture = readJson(positionsFile);
  const limit = args.limit ? Math.max(0, Number(args.limit)) : fixture.length;
  const engine = loadEngine(engineFile);
  const engineSha = sha256File(engineFile);

  const results = [];
  for (const entry of fixture.slice(0, limit)) {
    const applied = applyFixture(entry);
    const runs = [];
    for (let r = 0; r < repeat; r++) {
      const instance = new engine.Engine();
      const options = {
        mode: 'ruthless',
        skill: 100,
        variety: 0,
        depth: 16,
        timeMs: mode === 'time' ? timeMs : 30000
      };
      if (mode === 'nodes') options.nodeLimit = nodes;
      const started = performance.now();
      const result = await instance.think(applied.fen, options);
      const elapsed = performance.now() - started;
      runs.push({
        move: result.move,
        score: result.score,
        depth: result.depth,
        nodes: result.nodes,
        engineMs: result.time,
        wallMs: Math.round(elapsed * 10) / 10,
        nodesPerSecond: Math.round((result.nodes || 0) / Math.max(elapsed / 1000, 1e-9)),
        scoreSource: result.scoreSource,
        mate: result.mate,
        legalMoves: result.legalMoves
      });
    }
    const signature = (run) => `${run.move}|${run.score}|${run.depth}|${run.nodes}`;
    const deterministic = mode === 'nodes' && runs.every((run) => signature(run) === signature(runs[0]));
    const first = runs[0];
    results.push({
      id: entry.id,
      category: entry.category,
      fen: applied.fen,
      openingMoves: applied.moves,
      runs,
      deterministic: mode === 'nodes' ? deterministic : null
    });
    const flags = mode === 'nodes' && !deterministic ? ' NONDETERMINISTIC' : '';
    console.log(
      `${entry.id.padEnd(24)} ${String(first.move || '-').padEnd(6)} ` +
      `d${String(first.depth).padStart(2)} ${String(first.nodes).padStart(7)} nodes ` +
      `${String(first.wallMs).padStart(8)} ms${flags}`
    );
  }

  const totalNodes = results.reduce((sum, item) => sum + item.runs[0].nodes, 0);
  const totalWall = results.reduce((sum, item) => sum + item.runs[0].wallMs, 0);
  const report = {
    kind: 'fixed-diagnostics',
    started: new Date().toISOString(),
    engine: { file: path.basename(engineFile), path: engineFile, sha256: engineSha },
    configuration: {
      budgetMode: mode,
      nodes: mode === 'nodes' ? nodes : null,
      timeMs: mode === 'time' ? timeMs : null,
      repeat,
      depthCap: 16,
      engineMode: 'ruthless'
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model || null,
      cpus: os.cpus().length
    },
    positions: positionsFile,
    summary: {
      positions: results.length,
      deterministic: mode === 'nodes' ? results.every((item) => item.deterministic) : null,
      totalNodes,
      totalWallMs: Math.round(totalWall * 10) / 10,
      aggregateNodesPerSecond: Math.round(totalNodes / Math.max(totalWall / 1000, 1e-9)),
      averageDepth: results.length
        ? Math.round((results.reduce((sum, item) => sum + item.runs[0].depth, 0) / results.length) * 100) / 100
        : 0
    },
    results
  };
  report.finished = new Date().toISOString();

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(
      __dirname, '../../docs/benchmarks/rating/diagnostics',
      `${path.basename(engineFile, '.js')}-${mode}-${mode === 'nodes' ? nodes : timeMs}.json`
    );
  writeJson(outFile, report);

  console.log('');
  console.log(
    `Summary: ${report.summary.positions} positions, ${totalNodes.toLocaleString()} nodes, ` +
    `${report.summary.aggregateNodesPerSecond.toLocaleString()} nodes/s, average depth ${report.summary.averageDepth}` +
    (mode === 'nodes' ? `, deterministic ${report.summary.deterministic}` : '')
  );
  console.log(`Report: ${outFile}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
