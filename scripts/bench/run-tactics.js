// Suite B — tactical suite.
//
// Fixed positions with a proven answer, solved under a fixed node budget so the
// result is machine-independent and reproducible. A failure names the position
// and the move chosen, which is more useful than a bare percentage.
//
// Usage:
//   node scripts/bench/run-tactics.js [engine.js] [options]
//
// Options:
//   --nodes <n>    node budget per position (default 60000)
//   --out <file>   JSON report path
//   --limit <n>    only run the first n positions (smoke testing)

const path = require('node:path');
const { C, sha256File, loadEngine, readJson, writeJson, pct } = require('./lib.js');
const { createSolver } = require('./mate-solver.js');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(token);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engineFile = args._[0]
    ? path.resolve(args._[0])
    : path.resolve(__dirname, '../../src/engine.js');
  const nodeLimit = Number(args.nodes || 60000);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const positions = readJson(path.join(__dirname, 'tactics.json')).slice(0, limit);

  const Engine = loadEngine(engineFile);
  const solver = createSolver();

  const results = [];
  const byCategory = new Map();
  let solved = 0;

  console.log(`Tactics: ${positions.length} positions at ${nodeLimit.toLocaleString()} nodes each`);
  console.log(`Engine:  ${path.basename(engineFile)} ${sha256File(engineFile).slice(0, 12)}\n`);

  for (const entry of positions) {
    const pos = new C.Position(entry.fen);
    const engine = new Engine.Engine();
    const started = performance.now();
    let result;
    try {
      result = await engine.think(entry.fen, {
        mode: 'ruthless',
        skill: 100,
        variety: 0,
        depth: 16,
        timeMs: 30000,
        nodeLimit
      });
    } catch (error) {
      results.push({ ...entry, solved: false, error: error.message });
      continue;
    }
    const elapsed = performance.now() - started;
    const move = pos.legalMoves().find((m) => C.uci(m) === result.move);
    const ok = Boolean(move) && solver.moveWinsIn(pos, move, entry.mateIn);

    const bucket = byCategory.get(entry.category) || { solved: 0, total: 0, nodes: 0 };
    bucket.total++;
    bucket.nodes += result.nodes || 0;
    if (ok) { bucket.solved++; solved++; }
    byCategory.set(entry.category, bucket);

    results.push({
      id: entry.id,
      category: entry.category,
      fen: entry.fen,
      mateIn: entry.mateIn,
      move: result.move,
      score: result.score,
      depth: result.depth,
      nodes: result.nodes,
      ms: Math.round(elapsed),
      solved: ok
    });

    if (!ok) {
      console.log(`FAIL ${entry.id} (${entry.category}) ${entry.fen}`);
      console.log(`     chose ${result.move} at depth ${result.depth}, ${result.nodes} nodes`);
    }
  }

  const report = {
    kind: 'tactics',
    started: new Date().toISOString(),
    engine: { file: path.basename(engineFile), sha256: sha256File(engineFile) },
    configuration: { nodeLimit },
    total: positions.length,
    solved,
    rate: positions.length ? solved / positions.length : 0,
    categories: [...byCategory.entries()].map(([category, value]) => ({
      category,
      solved: value.solved,
      total: value.total,
      rate: value.total ? value.solved / value.total : 0,
      averageNodes: value.total ? Math.round(value.nodes / value.total) : 0
    })),
    failures: results.filter((r) => !r.solved),
    results
  };
  report.finished = new Date().toISOString();

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, '../../docs/benchmarks', `tactics-${Date.now()}.json`);
  writeJson(outFile, report);

  console.log('');
  for (const category of report.categories) {
    console.log(`${category.category.padEnd(12)} ${category.solved}/${category.total} ` +
      `(${pct(category.rate)}), avg ${category.averageNodes.toLocaleString()} nodes`);
  }
  console.log(`\nOverall ${solved}/${positions.length} (${pct(report.rate)})`);
  console.log(`Report: ${outFile}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
