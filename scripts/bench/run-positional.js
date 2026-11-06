// Suite C — positional suite.
//
// Compares a candidate build against a frozen reference build on positions
// sampled from self-play. Two different questions are answered:
//
//   agreement — how often the candidate picks the reference's move
//   cost      — how much evaluation the candidate gives up versus the
//               reference's best, in centipawns, per move played
//
// The reference is our own engine at a much deeper search, not an external
// engine. That makes the yardstick internal and reproducible, and it means the
// suite measures self-consistency rather than agreeing with a foreign style.
//
// The reference answers are cached. Build them once with --build-reference,
// then treat positional-reference.json as frozen input.
//
// Usage:
//   node scripts/bench/run-positional.js --build-reference [--ref-depth 14]
//   node scripts/bench/run-positional.js [engine.js] [options]
//
// Options:
//   --nodes <n>          candidate node budget per position (default 60000)
//   --ref-nodes <n>      reference node budget when building (default 400000)
//   --ref-depth <n>      reference depth when building (default 14)
//   --reference <file>   cached reference answers (default positional-reference.json)
//   --out <file>         JSON report path
//   --limit <n>          only run the first n positions

const path = require('node:path');
const { C, sha256File, loadEngine, readJson, writeJson, pct } = require('./lib.js');

const POSITIONS = path.join(__dirname, 'positional.json');
const REFERENCE = path.join(__dirname, 'positional-reference.json');
const ORACLE = path.join(__dirname, 'oracle/engine-reference.js');

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

function material(pos) {
  const value = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };
  let total = 0;
  for (const piece of pos.board) if (piece) total += value[piece & 7] || 0;
  return total;
}

function phaseOf(pos) {
  const heavy = [...pos.board].filter((p) => p && [4, 5].includes(p & 7)).length;
  if (heavy <= 2) return 'endgame';
  if (heavy <= 5) return 'late middlegame';
  return 'middlegame';
}

// Search a position and return the score of the best move in centipawns from
// the side to move's perspective, plus the move itself.
async function search(Engine, fen, options) {
  const engine = new Engine.Engine();
  const result = await engine.think(fen, {
    mode: 'ruthless',
    skill: 100,
    variety: 0,
    timeMs: 30000,
    ...options
  });
  return {
    move: result.move,
    score: result.score,
    depth: result.depth,
    nodes: result.nodes
  };
}

// Score a specific move by searching the position after it and negating. This
// is how centipawn loss is measured: play the candidate's move, let the
// reference evaluate the resulting position, compare to the reference's own
// best-move score. Without this, a shallow score would be compared to a deep
// one and every move would look like a blunder.
async function scoreAfter(Engine, fen, move, options) {
  const pos = new C.Position(fen);
  const legal = pos.legalMoves().find((m) => C.uci(m) === move);
  if (!legal) return null;
  pos.make(legal);
  if (pos.legalMoves().length === 0) {
    // Mate or stalemate: the reference reports terminal scores directly.
    return pos.inCheck(pos.side) ? 100000 : 0;
  }
  const result = await search(Engine, pos.fen(), options);
  return -result.score;
}

async function buildReference(args) {
  const Reference = loadEngine(ORACLE);
  const positions = readJson(POSITIONS);
  const refNodes = Number(args['ref-nodes'] || 400000);
  const refDepth = Number(args['ref-depth'] || 14);
  const limit = args.limit ? Number(args.limit) : Infinity;

  const entries = [];
  console.log(`Building reference: ${Math.min(positions.length, limit)} positions ` +
    `at ${refNodes.toLocaleString()} nodes / depth ${refDepth}`);
  console.log(`Oracle: ${path.basename(ORACLE)} ${sha256File(ORACLE).slice(0, 12)}\n`);

  for (const [index, entry] of positions.slice(0, limit).entries()) {
    const pos = new C.Position(entry.fen);
    const started = performance.now();
    const best = await search(Reference, entry.fen, { depth: refDepth, nodeLimit: refNodes });
    const elapsed = performance.now() - started;
    // Score every legal move at a modest budget so centipawn loss can be
    // computed for any candidate move without re-searching later.
    const scores = {};
    for (const move of pos.legalMoves()) {
      const name = C.uci(move);
      if (name === best.move) { scores[name] = best.score; continue; }
      scores[name] = await scoreAfter(Reference, entry.fen, name, {
        depth: Math.min(refDepth, 10), nodeLimit: Math.floor(refNodes / 4)
      });
    }
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    entries.push({
      id: entry.id,
      fen: entry.fen,
      phase: entry.phase,
      opening: entry.opening,
      ply: entry.ply,
      best: best.move,
      bestScore: best.score,
      depth: best.depth,
      nodes: best.nodes,
      secondBest: sorted[1] ? { move: sorted[1][0], score: sorted[1][1] } : null,
      scores
    });
    console.log(`[${index + 1}/${Math.min(positions.length, limit)}] ${entry.id} ` +
      `${best.move} ${best.score} d${best.depth} (${Math.round(elapsed)} ms)`);
  }

  const output = {
    kind: 'positional-reference',
    built: new Date().toISOString(),
    oracle: { file: path.basename(ORACLE), sha256: sha256File(ORACLE) },
    configuration: { refNodes, refDepth },
    positions: entries
  };
  writeJson(REFERENCE, output);
  console.log(`\nReference written to ${REFERENCE}`);
}

async function compare(args) {
  const engineFile = args._[0]
    ? path.resolve(args._[0])
    : path.resolve(__dirname, '../../src/engine.js');
  const nodeLimit = Number(args.nodes || 60000);
  const referenceFile = args.reference ? path.resolve(args.reference) : REFERENCE;
  const limit = args.limit ? Number(args.limit) : Infinity;

  const Candidate = loadEngine(engineFile);
  const reference = readJson(referenceFile);
  const positions = reference.positions.slice(0, limit);

  const results = [];
  const byPhase = new Map();
  let agreed = 0;
  let totalLoss = 0;
  let blunders = 0;

  console.log(`Positional: ${positions.length} positions at ${nodeLimit.toLocaleString()} nodes each`);
  console.log(`Candidate: ${path.basename(engineFile)} ${sha256File(engineFile).slice(0, 12)}`);
  console.log(`Reference: ${reference.oracle.sha256.slice(0, 12)}\n`);

  for (const entry of positions) {
    const started = performance.now();
    const result = await search(Candidate, entry.fen, { depth: 16, nodeLimit });
    const elapsed = performance.now() - started;

    const known = entry.scores[result.move];
    const loss = known === undefined
      ? null
      : Math.max(0, entry.bestScore - known);
    const isAgreement = result.move === entry.best;
    const isBlunder = loss !== null && loss >= 150;

    if (isAgreement) agreed++;
    if (loss !== null) totalLoss += loss;
    if (isBlunder) blunders++;

    const bucket = byPhase.get(entry.phase) || { total: 0, agreed: 0, loss: 0, blunders: 0 };
    bucket.total++;
    if (isAgreement) bucket.agreed++;
    if (loss !== null) bucket.loss += loss;
    if (isBlunder) bucket.blunders++;
    byPhase.set(entry.phase, bucket);

    results.push({
      id: entry.id,
      phase: entry.phase,
      fen: entry.fen,
      reference: entry.best,
      candidate: result.move,
      agreement: isAgreement,
      referenceScore: entry.bestScore,
      candidateScore: known ?? null,
      loss,
      blunder: isBlunder,
      depth: result.depth,
      nodes: result.nodes,
      ms: Math.round(elapsed)
    });

    if (!isAgreement) {
      console.log(`DIFF ${entry.id} (${entry.phase}) ref ${entry.best} ${entry.bestScore} ` +
        `vs ${result.move} ${known ?? '?'} (loss ${loss ?? '?'})`);
    }
  }

  const scored = results.filter((r) => r.loss !== null);
  const report = {
    kind: 'positional',
    started: new Date().toISOString(),
    engine: { file: path.basename(engineFile), sha256: sha256File(engineFile) },
    reference: { file: path.basename(referenceFile), oracle: reference.oracle.sha256 },
    configuration: { nodeLimit },
    total: positions.length,
    agreement: { count: agreed, rate: positions.length ? agreed / positions.length : 0 },
    centipawnLoss: {
      mean: scored.length ? totalLoss / scored.length : null,
      blunders,
      blunderRate: scored.length ? blunders / scored.length : 0
    },
    byPhase: [...byPhase.entries()].map(([phase, value]) => ({
      phase,
      total: value.total,
      agreementRate: value.total ? value.agreed / value.total : 0,
      meanLoss: value.total ? value.loss / value.total : 0,
      blunders: value.blunders
    })),
    results
  };
  report.finished = new Date().toISOString();

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, '../../docs/benchmarks', `positional-${Date.now()}.json`);
  writeJson(outFile, report);

  console.log(`\nAgreement ${agreed}/${positions.length} (${pct(report.agreement.rate)})`);
  console.log(`Mean centipawn loss ${report.centipawnLoss.mean?.toFixed(1) ?? 'n/a'} ` +
    `(${blunders} blunders at 150cp)`);
  for (const phase of report.byPhase) {
    console.log(`  ${phase.phase.padEnd(16)} agreement ${pct(phase.agreementRate)}, ` +
      `loss ${phase.meanLoss.toFixed(1)}, ${phase.blunders} blunders`);
  }
  console.log(`Report: ${outFile}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['build-reference']) return buildReference(args);
  return compare(args);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
