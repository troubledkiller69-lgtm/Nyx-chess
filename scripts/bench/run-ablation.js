// Evaluation ablation.
//
// Answers one question per feature: does switching it off make the engine
// worse? A term that can be removed without a measurable loss is not carrying
// its weight, and every term costs nodes per second.
//
// Both suites run at a fixed node budget, so the comparison isolates the
// evaluation change from any speed difference. The production build is the
// control and always runs first.
//
// Usage:
//   node scripts/bench/run-ablation.js [engine.js] [options]
//
// Options:
//   --masks <a,b,c>   feature masks to test (default: one per known bit)
//   --nodes <n>       node budget per position (default 30000)
//   --out <file>      JSON report path
//
// Mask bits, as read from the evaluator:
//   1   passed pawn base term
//   2   pawn race, pawn endgame terms, lone-king conversion
//   4   mobility and pin penalty
//   8   king danger from attackers
//   16  hanging pieces
//   32  attack-map fallback in bare endgames
//
// Mask 0 is the production evaluation: none of the above are active.

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

const FEATURES = [
  { mask: 1, name: 'passed pawns' },
  { mask: 2, name: 'pawn race / endgame' },
  { mask: 4, name: 'mobility + pins' },
  { mask: 8, name: 'king danger' },
  { mask: 16, name: 'hanging pieces' },
  { mask: 32, name: 'attack fallback' },
  { mask: 1 | 2, name: 'pawns only' },
  { mask: 4 | 8 | 16, name: 'attacks only' },
  { mask: 1 | 2 | 4 | 8 | 16 | 32, name: 'everything' }
];

async function runTactics(Engine, positions, nodeLimit, mask) {
  const solver = createSolver();
  let solved = 0;
  const misses = [];
  for (const entry of positions) {
    const pos = new C.Position(entry.fen);
    const engine = new Engine.Engine();
    let result;
    try {
      result = await engine.think(entry.fen, {
        mode: 'ruthless', skill: 100, variety: 0, depth: 16, timeMs: 30000, nodeLimit,
        evalFeatureMask: mask
      });
    } catch (error) {
      misses.push({ id: entry.id, error: error.message });
      continue;
    }
    const move = pos.legalMoves().find((m) => C.uci(m) === result.move);
    const ok = Boolean(move) && solver.moveWinsIn(pos, move, entry.mateIn);
    if (ok) solved++;
    else misses.push({ id: entry.id, category: entry.category, played: result.move });
  }
  return { solved, total: positions.length, rate: solved / positions.length, misses };
}

async function runPositional(Engine, positions, nodeLimit, mask) {
  let agreed = 0;
  let loss = 0;
  let scored = 0;
  let blunders = 0;
  const worst = [];
  for (const entry of positions) {
    const engine = new Engine.Engine();
    const result = await engine.think(entry.fen, {
      mode: 'ruthless', skill: 100, variety: 0, depth: 16, timeMs: 30000, nodeLimit,
      evalFeatureMask: mask
    });
    if (result.move === entry.best) agreed++;
    const known = entry.scores[result.move];
    if (known === undefined) continue;
    const delta = Math.max(0, entry.bestScore - known);
    loss += delta;
    scored++;
    if (delta >= 150) {
      blunders++;
      worst.push({ id: entry.id, played: result.move, reference: entry.best, loss: delta });
    }
  }
  return {
    agreed,
    total: positions.length,
    agreementRate: agreed / positions.length,
    meanLoss: scored ? loss / scored : null,
    blunders,
    worst: worst.sort((a, b) => b.loss - a.loss).slice(0, 5)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engineFile = args._[0]
    ? path.resolve(args._[0])
    : path.resolve(__dirname, '../../src/engine.js');
  const nodeLimit = Number(args.nodes || 30000);
  const masks = args.masks
    ? args.masks.split(',').map((value) => Number(value.trim()))
    : FEATURES.map((feature) => feature.mask);

  const Engine = loadEngine(engineFile);
  const tactics = readJson(path.join(__dirname, 'tactics.json'));
  const reference = readJson(path.join(__dirname, 'positional-reference.json'));

  const report = {
    kind: 'ablation',
    started: new Date().toISOString(),
    engine: { file: path.basename(engineFile), sha256: sha256File(engineFile) },
    configuration: { nodeLimit, control: 0 },
    runs: []
  };

  console.log(`Ablation: ${tactics.length} tactics, ${reference.positions.length} positions, ` +
    `${nodeLimit.toLocaleString()} nodes each`);
  console.log(`Engine:   ${path.basename(engineFile)} ${sha256File(engineFile).slice(0, 12)}\n`);
  console.log('mask  name                tactics    agreement  loss   blunders');

  for (const mask of [0, ...masks.filter((value) => value !== 0)]) {
    const name = mask === 0
      ? 'control (production)'
      : (FEATURES.find((feature) => feature.mask === mask)?.name || `mask ${mask}`);
    const started = Date.now();
    const tactical = await runTactics(Engine, tactics, nodeLimit, mask);
    const positional = await runPositional(Engine, reference.positions, nodeLimit, mask);
    const run = {
      mask,
      name,
      elapsedMs: Date.now() - started,
      tactics: tactical,
      positional
    };
    report.runs.push(run);
    console.log(
      `${String(mask).padEnd(5)} ${name.padEnd(19)} ` +
      `${String(tactical.solved).padStart(2)}/${tactical.total} ${pct(tactical.rate).padStart(6)}  ` +
      `${pct(positional.agreementRate).padStart(6)}     ` +
      `${positional.meanLoss === null ? 'n/a' : positional.meanLoss.toFixed(1).padStart(5)}  ` +
      `${String(positional.blunders).padStart(3)}`
    );
  }

  const control = report.runs[0];
  for (const run of report.runs.slice(1)) {
    run.delta = {
      tactics: run.tactics.solved - control.tactics.solved,
      agreement: run.positional.agreementRate - control.positional.agreementRate,
      meanLoss: run.positional.meanLoss === null || control.positional.meanLoss === null
        ? null
        : run.positional.meanLoss - control.positional.meanLoss,
      blunders: run.positional.blunders - control.positional.blunders
    };
  }
  report.finished = new Date().toISOString();

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, '../../docs/benchmarks', `ablation-${Date.now()}.json`);
  writeJson(outFile, report);

  console.log('\nDelta versus control (positive = worse):');
  for (const run of report.runs.slice(1)) {
    console.log(`  ${run.name.padEnd(19)} tactics ${run.delta.tactics >= 0 ? '+' : ''}${run.delta.tactics}, ` +
      `agreement ${(run.delta.agreement * 100).toFixed(1)}pp, ` +
      `loss ${run.delta.meanLoss === null ? 'n/a' : run.delta.meanLoss.toFixed(1)}, ` +
      `blunders ${run.delta.blunders >= 0 ? '+' : ''}${run.delta.blunders}`);
  }
  console.log(`\nReport: ${outFile}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
