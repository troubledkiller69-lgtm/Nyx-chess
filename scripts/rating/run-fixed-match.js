// Fixed-sample, paired, colour-swapped match for Nyx Chess.
//
// This is the primary relative-strength instrument. It is deliberately not a
// sequential test: every predeclared opening pair is played, then the data are
// analysed once. That makes the nominal interval meaningful without an SPRT
// correction for repeated looks.
//
// Properties:
//   * candidate and baseline bytes are copied to the run directory and hashed;
//     the frozen copies, not the source paths, are loaded;
//   * the opening suite is copied and hashed too;
//   * each opening is played twice, once with each colour;
//   * opening order is shuffled with the run seed before any game starts;
//   * games run serially, one at a time;
//   * every game is written to games.jsonl immediately, with start FEN and UCI
//     moves, so it can be replayed even if the run is interrupted;
//   * a partial run never produces a nominal confidence interval.
//
// Usage:
//   node scripts/rating/run-fixed-match.js \
//     --candidate src/engine.js \
//     --baseline docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js \
//     --openings scripts/rating/openings/tuning-72.json \
//     --pairs 72 --time-ms 150 --max-plies 200 --seed 1
//
// Common options:
//   --out <dir>          run directory (default docs/benchmarks/rating/runs/<id>)
//   --node-limit <n>     fixed nodes per move instead of a pure time budget
//   --depth <n>          depth cap (default 16)
//   --resamples <n>      bootstrap resamples (default 20000)
//   --smoke              one pair, short games; not evidence
//   --dry-run            validate and freeze inputs, play nothing
//   --allow-identical    permit candidate and baseline with the same hash
//   --force-lock         remove a stale/foreign lock (use with care)

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stats = require('./stats.js');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_OPENINGS = path.join(__dirname, 'openings', 'tuning-72.json');
const LOCK_PATH = path.join(ROOT, 'docs', 'benchmarks', 'rating', '.active-run.json');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function acquireLock(force) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  if (fs.existsSync(LOCK_PATH) && !force) {
    const existing = (() => {
      try { return readJson(LOCK_PATH); } catch { return null; }
    })();
    throw new Error(
      `another rating run appears active: ${LOCK_PATH}` +
      (existing ? ` (pid ${existing.pid}, started ${existing.started})` : '') +
      '. Wait for it, or remove the lock if it is stale. Use --force-lock only after checking.'
    );
  }
  const record = { pid: process.pid, started: new Date().toISOString(), run: process.argv.join(' ') };
  writeJson(LOCK_PATH, record);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = readJson(LOCK_PATH);
      if (current && current.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
    } catch {
      // A missing or unreadable lock is already released.
    }
  };
  process.on('exit', release);
  return release;
}

function deadMaterial(pos, C) {
  const pieces = [...pos.board].filter((piece) => piece && (piece & 7) !== 6);
  if (!pieces.length) return true;
  if (pieces.length === 1 && [2, 3].includes(pieces[0] & 7)) return true;
  if (pieces.every((piece) => (piece & 7) === 3)) {
    const colors = new Set();
    pos.board.forEach((piece, square) => {
      if ((piece & 7) === 3) colors.add(((square & 7) + (square >> 3)) & 1);
    });
    return colors.size === 1;
  }
  return false;
}

// Referee rules. The candidate module owns the Position implementation used by
// both sides, so a legality difference cannot favour one engine.
function adjudicate(pos, history, counts, maxPlies, ply, C) {
  const legal = pos.legalMoves();
  if (!legal.length) {
    return pos.inCheck(pos.side)
      ? { result: pos.side === C.WHITE ? '0-1' : '1-0', reason: 'mate', plies: ply }
      : { result: '1/2-1/2', reason: 'stalemate', plies: ply };
  }
  if (pos.half >= 100) return { result: '1/2-1/2', reason: 'fifty-move', plies: ply };
  const key = C.positionKey(pos.fen());
  if ((counts.get(key) || 0) >= 3) return { result: '1/2-1/2', reason: 'threefold', plies: ply };
  if (deadMaterial(pos, C)) return { result: '1/2-1/2', reason: 'insufficient material', plies: ply };
  if (ply >= maxPlies) return { result: '1/2-1/2', reason: 'ply cap', plies: ply };
  return { result: null, reason: 'in progress', plies: ply };
}

function applyOpening(start, C) {
  const pos = new C.Position(start.fen || C.START_FEN);
  const history = [pos.fen()];
  const moves = (start.moves || '').split(' ').filter(Boolean);
  for (const name of moves) {
    const move = pos.legalMoves().find((candidate) => C.uci(candidate) === name);
    if (!move) throw new Error(`illegal opening move ${name} in ${start.name || start.fen}`);
    pos.make(move);
    history.push(pos.fen());
  }
  return { pos, history, startFen: pos.fen(), openingMoves: moves.join(' ') };
}

function validateOpenings(openings, C) {
  if (!Array.isArray(openings) || !openings.length) throw new Error('opening suite must be a non-empty array');
  const names = new Set();
  const validated = [];
  for (const start of openings) {
    if (!start || typeof start !== 'object') throw new Error('opening entry must be an object');
    if (typeof start.name !== 'string' || !start.name.trim()) throw new Error('every opening needs a name');
    if (names.has(start.name)) throw new Error(`duplicate opening name: ${start.name}`);
    names.add(start.name);
    if (!start.fen && !start.moves) throw new Error(`opening ${start.name} needs fen or moves`);
    const applied = applyOpening(start, C);
    validated.push({ ...start, startFen: applied.startFen, moves: start.moves || '' });
  }
  return validated;
}

function seededShuffle(items, seed) {
  const copy = items.slice();
  const rng = stats.mulberry32(seed);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function gameSeed(baseSeed, pairIndex, candidateWhite) {
  return (baseSeed + pairIndex * 2 + (candidateWhite ? 0 : 1)) >>> 0;
}

async function playGame({ Candidate, Baseline, opening, candidateWhite, settings, seed, C }) {
  const { pos, history, startFen } = applyOpening(opening, C);
  const counts = new Map();
  for (const fen of history) {
    const key = C.positionKey(fen);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const engines = {
    candidate: new Candidate.Engine(),
    baseline: new Baseline.Engine()
  };
  const statsBySide = {
    candidate: { moves: 0, nodes: 0, depth: 0, ms: 0, overruns: 0 },
    baseline: { moves: 0, nodes: 0, depth: 0, ms: 0, overruns: 0 }
  };
  const rngs = {
    candidate: stats.mulberry32((seed ^ 0x9e3779b9) >>> 0),
    baseline: stats.mulberry32((seed ^ 0x85ebca6b) >>> 0)
  };
  const moves = [];
  const moveTimesMs = [];
  let adjudication = { result: null, reason: 'in progress', plies: 0 };

  for (let ply = 0; ; ply++) {
    adjudication = adjudicate(pos, history, counts, settings.maxPlies, ply, C);
    if (adjudication.result) break;

    const candidateToMove = (pos.side === C.WHITE) === candidateWhite;
    const side = candidateToMove ? 'candidate' : 'baseline';
    const engine = engines[side];
    const started = performance.now();
    const options = {
      mode: 'ruthless',
      skill: 100,
      variety: 0,
      depth: settings.depth,
      timeMs: settings.timeMs,
      historyFens: history,
      random: rngs[side]
    };
    if (settings.nodeLimit !== null) options.nodeLimit = settings.nodeLimit;
    const result = await engine.think(pos.fen(), options);
    const elapsed = performance.now() - started;

    const stat = statsBySide[side];
    stat.moves++;
    stat.ms += elapsed;
    stat.nodes += result.nodes || 0;
    stat.depth += result.depth || 0;
    if (elapsed > settings.timeMs + Math.max(25, settings.timeMs * 0.2)) stat.overruns++;
    moveTimesMs.push(Math.round(elapsed));

    const legal = pos.legalMoves();
    const move = legal.find((candidate) => C.uci(candidate) === result.move);
    if (!move) throw new Error(`illegal engine move ${result.move} at ${pos.fen()} (${side})`);
    moves.push(result.move);
    pos.make(move);
    history.push(pos.fen());
    const key = C.positionKey(pos.fen());
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const unresolved = adjudication.reason === 'ply cap';
  const score = adjudication.result === '1-0'
    ? (candidateWhite ? 1 : 0)
    : adjudication.result === '0-1'
      ? (candidateWhite ? 0 : 1)
      : 0.5;

  return {
    opening: opening.name,
    startFen,
    openingMoves: opening.moves || '',
    candidateWhite,
    result: adjudication.result,
    reason: adjudication.reason,
    plies: adjudication.plies,
    score,
    adjudicated: unresolved,
    resolved: !unresolved,
    outcomeType: unresolved ? 'unresolved-ply-cap' : 'game-result',
    scoreConvention: unresolved ? 'unresolved ply cap counted as 0.5' : 'rules result',
    seed,
    moves,
    moveTimesMs,
    stats: statsBySide
  };
}

function gameOutcomeCounts(games) {
  const counts = { wins: 0, draws: 0, losses: 0 };
  for (const game of games) {
    if (game.score === 1) counts.wins++;
    else if (game.score === 0) counts.losses++;
    else counts.draws++;
  }
  return counts;
}

function pairOutcomeCounts(pairScores) {
  const counts = { wins: 0, draws: 0, losses: 0 };
  for (const score of pairScores) {
    if (score > 0.5) counts.wins++;
    else if (score < 0.5) counts.losses++;
    else counts.draws++;
  }
  return counts;
}

function meanDepth(stat) {
  return stat.moves ? stat.depth / stat.moves : 0;
}

function nodesPerSecond(stat) {
  return stat.ms > 0 ? (stat.nodes / stat.ms) * 1000 : 0;
}

function formatElo(value) {
  if (value === null || value === undefined) return 'undefined';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function reportMarkdown({ manifest, summary }) {
  const lines = [];
  lines.push('# Fixed-sample rating match');
  lines.push('');
  lines.push(`Run \`${manifest.runId}\`, finished ${summary.finished}.`);
  lines.push('');
  lines.push('> Relative measurement against the named frozen baseline under these exact settings.');
  lines.push('> This is not an absolute FIDE or Chess.com rating and says nothing about Stockfish');
  lines.push('> strength settings.');
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push(`- Candidate: \`${manifest.inputs.candidate.frozenPath}\` SHA-256 \`${manifest.inputs.candidate.sha256}\``);
  lines.push(`- Baseline: \`${manifest.inputs.baseline.frozenPath}\` SHA-256 \`${manifest.inputs.baseline.sha256}\``);
  lines.push(`- Openings: \`${manifest.inputs.openings.frozenPath}\` SHA-256 \`${manifest.inputs.openings.sha256}\``);
  lines.push(`- Design hash: \`${manifest.designHash}\``);
  lines.push('');
  lines.push('## Design');
  lines.push('');
  lines.push(`- ${manifest.design.plannedPairs} predeclared opening ${manifest.design.plannedPairs === 1 ? 'pair' : 'pairs'}, ${manifest.design.plannedGames} games.`);
  lines.push('- Each opening played once with each colour; the pair is the observation.');
  lines.push('- Fixed sample, one analysis after all pairs. No optional stopping, no SPRT.');
  lines.push(`- ${manifest.settings.timeMs} ms/move${manifest.settings.nodeLimit === null ? '' : `, ${manifest.settings.nodeLimit} node cap`}, ${manifest.settings.maxPlies}-ply cap.`);
  lines.push(`- Seed ${manifest.settings.seed}; opening order fixed before the first move.`);
  lines.push('- The interval is conditional on this fixed, nonrandom opening suite. It is not an uncertainty statement about all openings or a universal Elo.');
  lines.push('- No opening is repeated as a separate pair; each pair is a distinct cluster.');
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push(`Candidate score: **${(summary.mean * 100).toFixed(1)}%** (pair record ${summary.pairOutcomes.wins}-${summary.pairOutcomes.draws}-${summary.pairOutcomes.losses}; game record ${summary.gameOutcomes.wins}-${summary.gameOutcomes.draws}-${summary.gameOutcomes.losses}).`);
  lines.push('');
  lines.push(`Score interval: ${(summary.scoreCI.lower * 100).toFixed(1)}% to ${(summary.scoreCI.upper * 100).toFixed(1)}% (${summary.scoreCI.nominalLevel * 100}% nominal, ${summary.scoreCI.method}, seed ${summary.scoreCI.seed}; ${summary.scoreCI.label}).`);
  lines.push('');
  lines.push(`Relative Elo point: **${formatElo(summary.elo.point)}**; interval ${formatElo(summary.elo.lower)} to ${formatElo(summary.elo.upper)}.`);
  lines.push('');
  if (!summary.elo.intervalDefined) {
    const both = summary.elo.lower === null && summary.elo.upper === null;
    lines.push(both
      ? 'Both Elo endpoints are undefined because the score interval reaches 0 and 1. The score interval is the result; there is no bounded Elo range.'
      : 'One Elo endpoint is undefined because the score interval reaches 0 or 1. Read the finite endpoint, not a bounded Elo range.');
    lines.push('');
  }
  lines.push(`Games: ${summary.games}; unresolved ply caps: ${summary.capped} (${(summary.adjudication.cappedFraction * 100).toFixed(1)}% of games, ${summary.adjudication.cappedPairs} pairs affected). Elapsed: ${summary.elapsedSeconds.toFixed(0)} s.`);
  lines.push('');
  if (summary.capped > 0) {
    const nonCappedText = summary.adjudication.nonCappedGames
      ? `${(summary.adjudication.nonCappedScore * 100).toFixed(1)}% over ${summary.adjudication.nonCappedGames} games`
      : 'no non-capped games';
    lines.push(`Ply-cap convention: every unresolved cap is scored 0.5, not recorded as a true draw. The primary score therefore includes ${summary.capped} adjudicated non-results. A high cap rate means the score partly measures the cap. Non-capped games only: ${nonCappedText}; this is descriptive and unpaired, not a replacement interval.`);
    lines.push('');
  }
  lines.push('## Interpretation limits');
  lines.push('');
  lines.push('- Elo is the logistic conversion of the observed pair score against this one baseline, at this time control and opening set.');
  lines.push('- The interval is conditional on the fixed, nonrandom suite. It does not cover all openings or a universal Elo.');
  lines.push('- It does not transfer to another opponent pool, another time control, or a human rating pool.');
  lines.push('- The opening set is a tuning set unless this run used the sealed validation file.');
  lines.push('- A repeated look at a growing sample is not covered by this interval; the runner plays the whole predeclared sample.');
  lines.push('- Ply caps are unresolved adjudications, not true draws. Their rate is reported because it affects what the score means.');
  lines.push('');
  lines.push('## Replay');
  lines.push('');
  lines.push(`The file \`games.json\` stores each game's start FEN and UCI moves. Replay from the project root with \`node scripts/rating/replay.js docs/benchmarks/rating/runs/${manifest.runId}\`.`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/rating/run-fixed-match.js --candidate <engine.js> --baseline <engine.js> [options]');
    return;
  }
  const candidatePath = args.candidate && path.resolve(args.candidate);
  const baselinePath = args.baseline && path.resolve(args.baseline);
  if (!candidatePath || !baselinePath) {
    throw new Error('Both --candidate and --baseline are required');
  }
  const smoke = Boolean(args.smoke);
  const settings = {
    timeMs: Number(args['time-ms'] ?? (smoke ? 50 : 150)),
    maxPlies: Number(args['max-plies'] ?? (smoke ? 40 : 200)),
    depth: Number(args.depth ?? 16),
    nodeLimit: args['node-limit'] === undefined ? (smoke ? 2000 : null) : Number(args['node-limit']),
    seed: Number(args.seed ?? 1)
  };
  const plannedPairs = Number(args.pairs ?? (smoke ? 1 : 72));
  const resamples = Number(args.resamples ?? 20000);
  if (!Number.isInteger(plannedPairs) || plannedPairs < 1) throw new Error('--pairs must be a positive integer');
  if (!Number.isInteger(settings.maxPlies) || settings.maxPlies < 2) throw new Error('--max-plies must be an integer >= 2');
  if (!Number.isInteger(settings.depth) || settings.depth < 1) throw new Error('--depth must be a positive integer');
  if (!(settings.timeMs >= 50 && settings.timeMs <= 30000)) throw new Error('--time-ms must be in [50, 30000]');
  if (settings.nodeLimit !== null && (!Number.isInteger(settings.nodeLimit) || settings.nodeLimit < 1)) {
    throw new Error('--node-limit must be a positive integer');
  }

  for (const file of [candidatePath, baselinePath]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`engine file not found: ${file}`);
  }
  const candidateBytes = fs.readFileSync(candidatePath);
  const baselineBytes = fs.readFileSync(baselinePath);
  const candidateSha = sha256(candidateBytes);
  const baselineSha = sha256(baselineBytes);
  if (candidateSha === baselineSha && !args['allow-identical']) {
    throw new Error('candidate and baseline have identical SHA-256; pass --allow-identical only for a pipeline smoke test');
  }

  const openingsPath = path.resolve(args.openings || DEFAULT_OPENINGS);
  if (!fs.existsSync(openingsPath)) throw new Error(`opening suite not found: ${openingsPath}`);
  const openingsBytes = fs.readFileSync(openingsPath);
  const openingsSha = sha256(openingsBytes);
  const rawOpenings = JSON.parse(openingsBytes.toString('utf8'));

  const outDir = path.resolve(
    args.out || path.join(ROOT, 'docs', 'benchmarks', 'rating', 'runs', `${timestampId()}-${candidateSha.slice(0, 8)}-vs-${baselineSha.slice(0, 8)}`)
  );
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !args.force) {
    throw new Error(`output directory is not empty: ${outDir}. Choose a new --out or pass --force.`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const releaseLock = acquireLock(Boolean(args['force-lock']));
  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
    console.error('\nInterrupt received; finishing the current game, then stopping without a fixed-sample report.');
  });

  const frozenDir = path.join(outDir, 'frozen');
  fs.mkdirSync(frozenDir, { recursive: true });
  const frozenCandidate = path.join(frozenDir, 'candidate-engine.js');
  const frozenBaseline = path.join(frozenDir, 'baseline-engine.js');
  const frozenOpenings = path.join(frozenDir, 'openings.json');
  fs.copyFileSync(candidatePath, frozenCandidate);
  fs.copyFileSync(baselinePath, frozenBaseline);
  fs.copyFileSync(openingsPath, frozenOpenings);
  if (sha256(fs.readFileSync(frozenCandidate)) !== candidateSha) throw new Error('candidate copy hash changed');
  if (sha256(fs.readFileSync(frozenBaseline)) !== baselineSha) throw new Error('baseline copy hash changed');
  if (sha256(fs.readFileSync(frozenOpenings)) !== openingsSha) throw new Error('opening copy hash changed');

  const Candidate = require(frozenCandidate);
  const Baseline = require(frozenBaseline);
  if (typeof Candidate.Engine !== 'function' || typeof Candidate.Position !== 'function') {
    throw new Error('candidate does not export Engine and Position');
  }
  if (typeof Baseline.Engine !== 'function') throw new Error('baseline does not export Engine');

  const C = Candidate; // Referee for both sides.
  const openings = validateOpenings(rawOpenings, C);
  if (plannedPairs > openings.length) {
    throw new Error(
      `planned ${plannedPairs} pairs but the suite has ${openings.length} unique openings. ` +
      'Repeating an opening would create correlated clusters and invalidate the fixed-sample interval. ' +
      'Use a larger suite of distinct openings, or a different design.'
    );
  }
  const order = seededShuffle(openings, settings.seed ^ 0x5f3759df);
  const selected = order.slice(0, plannedPairs);

  const design = {
    type: 'fixed-sample-paired-colour-swapped',
    pairUnit: 'opening',
    plannedPairs,
    plannedGames: plannedPairs * 2,
    stoppingRule: 'none; all predeclared pairs are played',
    analysis: 'one analysis at completion',
    repeatedOpenings: false,
    openingOrder: selected.map((opening) => opening.name)
  };
  const configuration = {
    settings,
    design,
    adjudication: {
      mate: 'natural',
      stalemate: 'draw',
      fiftyMove: 'draw',
      threefold: 'draw',
      insufficientMaterial: 'draw',
      plyCap: 'draw (counted separately)'
    },
    search: {
      mode: 'ruthless',
      skill: 100,
      variety: 0,
      random: 'seeded per game',
      referee: 'candidate Position implementation'
    }
  };
  const settingsHash = sha256(Buffer.from(stableStringify(configuration)));
  const designHash = sha256(Buffer.from([candidateSha, baselineSha, openingsSha, settingsHash].join('\n')));

  const started = new Date().toISOString();
  const manifest = {
    kind: 'rating-fixed-match',
    schema: 1,
    runId: path.basename(outDir),
    status: 'running',
    started,
    command: process.argv.join(' '),
    inputs: {
      candidate: {
        source: candidatePath,
        sha256: candidateSha,
        bytes: candidateBytes.length,
        frozenPath: path.relative(outDir, frozenCandidate).replace(/\\/g, '/')
      },
      baseline: {
        source: baselinePath,
        sha256: baselineSha,
        bytes: baselineBytes.length,
        frozenPath: path.relative(outDir, frozenBaseline).replace(/\\/g, '/')
      },
      openings: {
        source: openingsPath,
        sha256: openingsSha,
        bytes: openingsBytes.length,
        frozenPath: path.relative(outDir, frozenOpenings).replace(/\\/g, '/'),
        names: openings.map((opening) => opening.name)
      }
    },
    configuration,
    settings,
    design,
    settingsHash,
    designHash,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpu: os.cpus()[0] && os.cpus()[0].model
    }
  };
  writeJson(path.join(outDir, 'manifest.json'), manifest);

  console.log(`Run ${manifest.runId}`);
  console.log(`candidate ${candidateSha.slice(0, 16)}  ${candidatePath}`);
  console.log(`baseline  ${baselineSha.slice(0, 16)}  ${baselinePath}`);
  console.log(`openings  ${openingsSha.slice(0, 16)}  ${openingsPath} (${openings.length} lines)`);
  console.log(`design    ${plannedPairs} pairs / ${plannedPairs * 2} games, fixed sample, seed ${settings.seed}`);
  console.log(`budget    ${settings.timeMs} ms/move${settings.nodeLimit === null ? '' : `, ${settings.nodeLimit} nodes`}, ${settings.maxPlies}-ply cap\n`);

  if (args['dry-run']) {
    manifest.status = 'validated';
    manifest.finished = new Date().toISOString();
    writeJson(path.join(outDir, 'manifest.json'), manifest);
    console.log('Dry run: inputs frozen and validated; no games played.');
    releaseLock();
    return;
  }

  const games = [];
  const pairScores = [];
  const gamesFile = path.join(outDir, 'games.json');
  const gamesJsonl = path.join(outDir, 'games.jsonl');
  fs.writeFileSync(gamesJsonl, '');
  const runStarted = Date.now();

  try {
    for (let pairIndex = 0; pairIndex < selected.length; pairIndex++) {
      if (interrupted) break;
      const opening = selected[pairIndex];
      const pair = [];
      for (const candidateWhite of [true, false]) {
        if (interrupted) break;
        const seed = gameSeed(settings.seed, pairIndex, candidateWhite);
        const game = await playGame({
          Candidate, Baseline, opening, candidateWhite, settings, seed, C
        });
        game.pairIndex = pairIndex;
        game.eloRun = manifest.runId;
        games.push(game);
        pair.push(game.score);
        fs.appendFileSync(gamesJsonl, `${JSON.stringify(game)}\n`);
        writeJson(gamesFile, games);
        const label = candidateWhite ? 'white' : 'black';
        console.log(
          `${String(pairIndex + 1).padStart(3, ' ')}/${selected.length} ${opening.name}, candidate ${label}: ` +
          `${game.score} ${game.reason} ${game.plies}p ${game.moveTimesMs.reduce((a, b) => a + b, 0)}ms`
        );
      }
      if (pair.length === 2) {
        pairScores.push((pair[0] + pair[1]) / 2);
        writeJson(path.join(outDir, 'partial.json'), {
          status: 'in progress',
          pairsCompleted: pairScores.length,
          plannedPairs,
          meanPairScore: pairScores.reduce((a, b) => a + b, 0) / pairScores.length,
          note: 'Descriptive progress only. This is not a completed fixed-sample analysis and no interval is reported.'
        });
      }
    }

    if (interrupted || pairScores.length !== plannedPairs) {
      manifest.status = interrupted ? 'interrupted' : 'failed';
      manifest.finished = new Date().toISOString();
      manifest.pairsCompleted = pairScores.length;
      manifest.error = interrupted
        ? 'interrupted before the predeclared sample completed'
        : `completed ${pairScores.length} of ${plannedPairs} planned pairs`;
      writeJson(path.join(outDir, 'manifest.json'), manifest);
      writeJson(path.join(outDir, 'partial.json'), {
        status: manifest.status,
        pairsCompleted: pairScores.length,
        plannedPairs,
        note: 'No nominal confidence interval is reported for a partial or interrupted run.'
      });
      console.log(`\n${manifest.error}. No confidence interval will be reported.`);
      releaseLock();
      process.exitCode = 1;
      return;
    }

    stats.assertFixedSampleComplete(pairScores, plannedPairs);
    const analysis = stats.analyzePairs(pairScores, {
      seed: settings.seed,
      level: 0.95,
      resamples,
      design: 'fixed-sample',
      plannedPairs
    });
    const gameOutcomes = gameOutcomeCounts(games);
    const pairOutcomes = pairOutcomeCounts(pairScores);
    const capped = games.filter((game) => game.adjudicated).length;
    const cappedPairs = new Set(games.filter((game) => game.adjudicated).map((game) => game.pairIndex)).size;
    const nonCappedGames = games.filter((game) => !game.adjudicated);
    const nonCappedScore = nonCappedGames.length
      ? nonCappedGames.reduce((sum, game) => sum + game.score, 0) / nonCappedGames.length
      : null;
    const total = {
      candidate: { nodes: 0, ms: 0, depth: 0, moves: 0 },
      baseline: { nodes: 0, ms: 0, depth: 0, moves: 0 }
    };
    for (const game of games) {
      for (const side of ['candidate', 'baseline']) {
        total[side].nodes += game.stats[side].nodes;
        total[side].ms += game.stats[side].ms;
        total[side].depth += game.stats[side].depth;
        total[side].moves += game.stats[side].moves;
      }
    }
    const elapsedSeconds = (Date.now() - runStarted) / 1000;
    const summary = {
      ...analysis,
      pairOutcomes,
      gameOutcomes,
      games: games.length,
      capped,
      adjudication: {
        unresolvedPlyCaps: capped,
        cappedPairs,
        cappedFraction: games.length ? capped / games.length : 0,
        convention: 'unresolved ply-cap games are scored 0.5, not ruled draws',
        nonCappedGames: nonCappedGames.length,
        nonCappedScore,
        note: 'The primary pair score includes ply caps at 0.5. A high cap rate means the score partly measures the cap, not only chess strength. The non-capped score is descriptive and unpaired.'
      },
      elapsedSeconds,
      throughput: {
        candidate: {
          meanDepth: meanDepth(total.candidate),
          nodesPerSecond: nodesPerSecond(total.candidate)
        },
        baseline: {
          meanDepth: meanDepth(total.baseline),
          nodesPerSecond: nodesPerSecond(total.baseline)
        }
      },
      finished: new Date().toISOString()
    };
    writeJson(path.join(outDir, 'summary.json'), summary);
    manifest.status = 'complete';
    manifest.finished = summary.finished;
    manifest.pairsCompleted = pairScores.length;
    manifest.sourceStability = {
      candidateUnchanged: sha256(fs.readFileSync(candidatePath)) === candidateSha,
      baselineUnchanged: sha256(fs.readFileSync(baselinePath)) === baselineSha,
      openingsUnchanged: sha256(fs.readFileSync(openingsPath)) === openingsSha,
      note: 'The frozen copies played the games regardless. False means the source path changed during the run.'
    };
    manifest.result = {
      meanPairScore: summary.mean,
      scoreCI: summary.scoreCI,
      elo: summary.elo,
      pairOutcomes: summary.pairOutcomes,
      gameOutcomes: summary.gameOutcomes,
      adjudication: summary.adjudication
    };
    writeJson(path.join(outDir, 'manifest.json'), manifest);
    fs.writeFileSync(path.join(outDir, 'report.md'), reportMarkdown({ manifest, summary }));

    console.log(`\n${pairOutcomes.wins} pair wins ${pairOutcomes.draws} draws ${pairOutcomes.losses} losses; ` +
      `${gameOutcomes.wins} game wins ${gameOutcomes.draws} draws ${gameOutcomes.losses} losses ` +
      `(${capped} unresolved ply caps, ${(summary.adjudication.cappedFraction * 100).toFixed(1)}%)`);
    console.log(`pair score ${(summary.mean * 100).toFixed(1)}%  ` +
      `95% CI ${(summary.scoreCI.lower * 100).toFixed(1)}-${(summary.scoreCI.upper * 100).toFixed(1)}%  ` +
      `(${summary.scoreCI.method}, seed ${summary.scoreCI.seed})`);
    console.log(`relative Elo ${formatElo(summary.elo.point)}  ` +
      `interval ${formatElo(summary.elo.lower)} to ${formatElo(summary.elo.upper)}`);
    console.log(`mean depth ${meanDepth(total.candidate).toFixed(1)} vs ${meanDepth(total.baseline).toFixed(1)}; ` +
      `${Math.round(nodesPerSecond(total.candidate)).toLocaleString()} vs ${Math.round(nodesPerSecond(total.baseline)).toLocaleString()} nps`);
    console.log(`elapsed ${elapsedSeconds.toFixed(0)} s\nreport ${path.join(outDir, 'report.md')}`);
  } catch (error) {
    manifest.status = 'failed';
    manifest.finished = new Date().toISOString();
    manifest.pairsCompleted = pairScores.length;
    manifest.error = String(error.stack || error.message || error);
    writeJson(path.join(outDir, 'manifest.json'), manifest);
    throw error;
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
