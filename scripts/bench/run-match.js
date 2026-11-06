// Suite D — match suite.
//
// The only suite that measures relative playing strength directly.
//
// Properties that make the result trustworthy:
// - Paired, colour-swapped openings. The pair is the unit of observation.
// - Sealed opening file, never edited during development.
// - Both engine builds are hashed before the first move.
// - Randomness is seeded per game, so a run is reproducible.
// - Serial execution only; parallel matches change the effective time control.
// - SPRT stopping rule, so "not enough data" is a legitimate verdict.
//
// Usage:
//   node scripts/bench/run-match.js <candidate.js> <baseline.js> [options]
//
// Options:
//   --out <file.json>        report path
//   --time <ms>              time per move (default 150)
//   --plies <n>              ply cap (default 180)
//   --openings <file.json>   opening set (default openings.json)
//   --elo0 <n> --elo1 <n>    SPRT bounds (default 0 / 10)
//   --max-pairs <n>          hard stop (default 200)
//   --seed <n>               base seed (default 1)
//   --fixed                  play every pair up to --max-pairs; do not stop
//                            on the SPRT bound (for predeclared fixed samples)

const path = require('node:path');
const {
  C, sha256File, loadEngine, makeRng, adjudicate, pairStats, eloFromScore,
  sprt, readJson, writeJson, pct, summarise
} = require('./lib.js');

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

function applyLine(pos, moves) {
  const history = [pos.fen()];
  for (const name of (moves || '').split(' ').filter(Boolean)) {
    const move = pos.legalMoves().find((m) => C.uci(m) === name);
    if (!move) throw new Error(`Illegal opening move ${name} at ${pos.fen()}`);
    pos.make(move);
    history.push(pos.fen());
  }
  return history;
}

async function playGame({ Candidate, Baseline, start, candidateWhite, timeMs, maxPlies, seed, masks }) {
  const pos = new C.Position(start.fen || C.START_FEN);
  const history = applyLine(pos, start.moves);
  const counts = new Map();
  for (const fen of history) {
    const key = C.positionKey(fen);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const engines = {
    candidate: new Candidate.Engine(),
    baseline: new Baseline.Engine()
  };
  // The mask is set once per engine, not per move: think() preserves an
  // explicitly configured evaluation across searches.
  if (masks && masks.candidate !== null) engines.candidate.configureEvaluation(masks.candidate);
  if (masks && masks.baseline !== null) engines.baseline.configureEvaluation(masks.baseline);
  const rng = makeRng(seed);
  const stats = {
    candidate: { moves: 0, nodes: 0, depth: 0, ms: 0, overruns: 0 },
    baseline: { moves: 0, nodes: 0, depth: 0, ms: 0, overruns: 0 }
  };
  const moves = [];
  let adjudication = { result: null, reason: 'in progress', plies: 0 };

  for (let ply = 0; ; ply++) {
    adjudication = adjudicate(pos, history, counts, maxPlies, ply);
    if (adjudication.result) break;

    const candidateToMove = (pos.side === C.WHITE) === candidateWhite;
    const side = candidateToMove ? 'candidate' : 'baseline';
    const engine = engines[side];
    const started = performance.now();
    const result = await engine.think(pos.fen(), {
      mode: 'ruthless',
      skill: 100,
      variety: 0,
      depth: 16,
      timeMs,
      historyFens: history,
      random: rng
    });
    const elapsed = performance.now() - started;

    const stat = stats[side];
    stat.moves++;
    stat.ms += elapsed;
    stat.nodes += result.nodes || 0;
    stat.depth += result.depth || 0;
    if (elapsed > timeMs + Math.max(25, timeMs * 0.2)) stat.overruns++;

    const legal = pos.legalMoves();
    const move = legal.find((m) => C.uci(m) === result.move);
    if (!move) {
      throw new Error(`Illegal engine move ${result.move} at ${pos.fen()} (${side})`);
    }
    moves.push(result.move);
    pos.make(move);
    history.push(pos.fen());
    const key = C.positionKey(pos.fen());
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const score = adjudication.result === '1-0'
    ? (candidateWhite ? 1 : 0)
    : adjudication.result === '0-1'
      ? (candidateWhite ? 0 : 1)
      : 0.5;

  return {
    opening: start.name,
    candidateWhite,
    result: adjudication.result,
    reason: adjudication.reason,
    plies: adjudication.plies,
    score,
    moves,
    stats
  };
}

function meanDepth(stat) {
  return stat.moves ? stat.depth / stat.moves : 0;
}

function nodesPerSecond(stat) {
  return stat.ms > 0 ? (stat.nodes / stat.ms) * 1000 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [candidateFile, baselineFile] = args._;
  if (!candidateFile || !baselineFile) {
    console.error('Usage: node scripts/bench/run-match.js <candidate.js> <baseline.js> [options]');
    process.exit(1);
  }

  const timeMs = Number(args.time || 150);
  const maxPlies = Number(args.plies || 180);
  const elo0 = Number(args.elo0 ?? 0);
  const elo1 = Number(args.elo1 ?? 10);
  const maxPairs = Number(args['max-pairs'] || 200);
  const seed = Number(args.seed || 1);
  const fixedSample = Boolean(args.fixed);
  const masks = {
    candidate: args['candidate-mask'] === undefined ? null : Number(args['candidate-mask']),
    baseline: args['baseline-mask'] === undefined ? null : Number(args['baseline-mask'])
  };
  const openingsFile = args.openings
    ? path.resolve(args.openings)
    : path.join(__dirname, 'openings.json');
  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, '../../docs/benchmarks', `match-${Date.now()}.json`);

  const openings = readJson(openingsFile);
  const Candidate = loadEngine(candidateFile);
  const Baseline = loadEngine(baselineFile);

  const report = {
    kind: 'match',
    started: new Date().toISOString(),
    configuration: {
      timeMs, maxPlies, elo0, elo1, maxPairs, seed, fixedSample,
      candidateMask: masks.candidate,
      baselineMask: masks.baseline,
      openings: path.basename(openingsFile)
    },
    builds: {
      candidate: { file: path.basename(candidateFile), sha256: sha256File(candidateFile) },
      baseline: { file: path.basename(baselineFile), sha256: sha256File(baselineFile) }
    },
    games: [],
    pairScores: [],
    sprt: null,
    summary: null
  };

  console.log(`Candidate ${report.builds.candidate.file} ${report.builds.candidate.sha256.slice(0, 12)}`);
  console.log(`Baseline  ${report.builds.baseline.file} ${report.builds.baseline.sha256.slice(0, 12)}`);
  console.log(
    `Time ${timeMs} ms/move, ${openings.length} openings, SPRT ${elo0}..${elo1} Elo` +
    `${fixedSample ? ' (fixed sample: no early stop)' : ''}\n`
  );

  let index = 0;
  for (const opening of openings) {
    if (report.pairScores.length >= maxPairs) break;
    index++;
    const pair = [];
    for (const candidateWhite of [true, false]) {
      const gameSeed = (seed + index * 2 + (candidateWhite ? 0 : 1)) >>> 0;
      const game = await playGame({
        Candidate, Baseline, start: opening, candidateWhite, timeMs, maxPlies, seed: gameSeed, masks
      });
      report.games.push(game);
      pair.push(game.score);
      const label = candidateWhite ? 'white' : 'black';
      console.log(
        `${index}/${openings.length} ${opening.name}, candidate ${label}: ` +
        `${game.score} ${game.reason} ${game.plies}p`
      );
    }
    // The pair score is the average of the two colour-swapped games, so it is
    // on the same 0..1 scale as an expected score. Using the sum here would
    // feed a 0..2 value into the SPRT bounds and the Elo conversion, which
    // both assume a probability.
    const pairScore = (pair[0] + pair[1]) / 2;
    report.pairScores.push(pairScore);
    report.sprt = sprt(report.pairScores, { elo0, elo1 });
    if (!fixedSample && report.sprt.decision !== 'continue') break;
  }

  const stats = pairStats(report.pairScores);
  const elo = eloFromScore(stats.mean);
  const byCandidate = report.games.reduce((acc, g) => {
    acc[g.score === 1 ? 'wins' : g.score === 0 ? 'losses' : 'draws']++;
    return acc;
  }, { wins: 0, draws: 0, losses: 0 });
  const capped = report.games.filter((g) => g.reason === 'ply cap').length;
  const total = { candidate: { nodes: 0, ms: 0, depth: 0, moves: 0 }, baseline: { nodes: 0, ms: 0, depth: 0, moves: 0 } };
  for (const game of report.games) {
    for (const side of ['candidate', 'baseline']) {
      total[side].nodes += game.stats[side].nodes;
      total[side].ms += game.stats[side].ms;
      total[side].depth += game.stats[side].depth;
      total[side].moves += game.stats[side].moves;
    }
  }

  report.summary = {
    ...byCandidate,
    capped,
    games: report.games.length,
    ...stats,
    eloEstimate: Number.isFinite(elo) ? elo : null,
    note: 'Elo is a conversion of the pair score, not an absolute rating. ' +
      'The interval is over pairs; small samples are not independent evidence.',
    throughput: {
      candidate: {
        meanDepth: meanDepth(total.candidate),
        nodesPerSecond: nodesPerSecond(total.candidate)
      },
      baseline: {
        meanDepth: meanDepth(total.baseline),
        nodesPerSecond: nodesPerSecond(total.baseline)
      }
    }
  };
  report.finished = new Date().toISOString();

  writeJson(outFile, report);

  console.log(`\n${byCandidate.wins}W ${byCandidate.draws}D ${byCandidate.losses}L ` +
    `(${capped} capped)`);
  console.log(`Pair score ${summarise(stats)}`);
  console.log(`SPRT: ${report.sprt.decision} (LLR ${report.sprt.llr.toFixed(2)}, ` +
    `bounds ${report.sprt.lower.toFixed(2)}..${report.sprt.upper.toFixed(2)})`);
  console.log(`Mean depth ${meanDepth(total.candidate).toFixed(1)} vs ` +
    `${meanDepth(total.baseline).toFixed(1)}, ` +
    `${Math.round(nodesPerSecond(total.candidate)).toLocaleString()} vs ` +
    `${Math.round(nodesPerSecond(total.baseline)).toLocaleString()} nps`);
  console.log(`\nReport: ${outFile}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
