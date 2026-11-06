// Paired, sequential games against an explicitly saved local engine version.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const C = require('../src/engine.js');

const starts = [
  { name: 'open centre', moves: 'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6' },
  { name: 'closed centre', moves: 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6' },
  { name: 'asymmetric centre', moves: 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4' },
  { name: 'flank development', moves: 'g1f3 d7d5 g2g3 g8f6 f1g2 c7c6' },
  { name: 'opposite wings', moves: 'c2c4 e7e5 b1c3 g8f6 g2g3 d7d5' },
  { name: 'pawn tension', moves: 'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6' },
  { name: 'pawn ending', fen: '8/5pk1/6p1/3p4/3P4/5KP1/5P2/8 w - - 0 35' },
  { name: 'rook ending', fen: '8/5pk1/6p1/3r4/3R4/5KP1/5P2/8 w - - 0 35' }
];

function dead(pos) {
  const pieces = [...pos.board].filter((p) => p && (p & 7) !== 6);
  if (!pieces.length) return true;
  if (pieces.length === 1 && [2, 3].includes(pieces[0] & 7)) return true;
  if (pieces.every((p) => (p & 7) === 3)) {
    const colors = new Set();
    pos.board.forEach((p, sq) => { if ((p & 7) === 3) colors.add(((sq & 7) + (sq >> 3)) & 1); });
    return colors.size === 1;
  }
  return false;
}

async function game(B, start, candidateSide, timeMs, maxPlies, featureMask) {
  const pos = new C.Position(start.fen || C.START_FEN), history = [pos.fen()], moves = [];
  for (const name of (start.moves || '').split(' ').filter(Boolean)) {
    const move = pos.legalMoves().find((m) => C.uci(m) === name);
    if (!move) throw new Error(`Illegal starting line: ${name}`);
    pos.make(move); history.push(pos.fen());
  }
  const initialFen = pos.fen(), engines = [new C.Engine(), new B.Engine()];
  if (featureMask !== null) engines[0].configureEvaluation(featureMask);
  const stats = engines.map(() => ({ moves: 0, nodes: 0, depth: 0, ms: 0, overruns: 0 }));
  const counts = new Map();
  for (const fen of history) { const key = C.positionKey(fen); counts.set(key, (counts.get(key) || 0) + 1); }
  let winner = 0, reason = 'ply cap';
  for (let ply = 0; ; ply++) {
    const legal = pos.legalMoves();
    if (!legal.length) { winner = pos.inCheck(pos.side) ? 3 - pos.side : 0; reason = winner ? 'mate' : 'stalemate'; break; }
    if (pos.half >= 100 || counts.get(C.positionKey(pos.fen())) >= 3 || dead(pos)) { reason = 'rule draw'; break; }
    if (ply >= maxPlies) break;
    const index = pos.side === candidateSide ? 0 : 1, t = performance.now();
    const engine = engines[index];
    const result = await engine.think(pos.fen(), {
      mode: 'ruthless', skill: 100, variety: 0, depth: 16, timeMs, historyFens: history
    });
    const elapsed = performance.now() - t, stat = stats[index];
    stat.moves++; stat.ms += elapsed; stat.nodes += result.nodes; stat.depth += result.depth;
    if (elapsed > timeMs + Math.max(25, timeMs * 0.2)) stat.overruns++;
    const move = legal.find((m) => C.uci(m) === result.move);
    if (!move) throw new Error(`Illegal engine move ${result.move} at ${pos.fen()}`);
    moves.push(result.move); pos.make(move); history.push(pos.fen());
    const key = C.positionKey(pos.fen()); counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { start: start.name, initialFen, candidateSide, score: !winner ? 0.5 : winner === candidateSide ? 1 : 0,
    reason, plies: moves.length, moves, finalFen: pos.fen(), stats };
}

async function main() {
  const [baselineArg, outArg, pairsArg = '8', timeArg = '100', capArg = '240', startsArg, maskArg = 'default'] = process.argv.slice(2);
  if (!baselineArg || !outArg) throw new Error('Usage: node scripts/engine-match.js BASELINE.js REPORT.json [pairs=8] [ms=100] [plyCap=240] [STARTS.json] [featureMask=default|0..63]');
  const pairs = Number(pairsArg), timeMs = Number(timeArg), maxPlies = Number(capArg);
  const featureMask = maskArg === 'default' ? null : Number(maskArg);
  if (![pairs, timeMs, maxPlies].every(Number.isInteger) || (featureMask !== null && (!Number.isInteger(featureMask) || featureMask < 0 || featureMask > 63)) || pairs < 2 || timeMs < 50 || timeMs > 30000 || maxPlies < 2) throw new Error('Invalid match limits');
  const baseline = path.resolve(baselineArg), output = path.resolve(outArg), B = require(baseline);
  const suite = startsArg ? JSON.parse(fs.readFileSync(startsArg, 'utf8')) : starts;
  if (!Array.isArray(suite) || !suite.length || suite.some((s) => !s.name || (!s.fen && !s.moves))) throw new Error('Invalid starting-position suite');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = { baseline, baselineHash: hash(baseline), candidateHash: hash(path.join(__dirname, '../src/engine.js')),
    node: process.version, cpu: os.cpus()[0].model, timeMs, pairs, maxPlies, featureMask: featureMask ?? 'default', starts: suite, games: [] };
  for (const E of [C, B]) await new E.Engine().think(C.START_FEN, { mode: 'ruthless', depth: 4, timeMs: 200 });
  report.tactics = [];
  for (const [name, fen, accepted] of [
    ['back rank mate', '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', ['a1a8']],
    ['hanging queen', '4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1', ['e4d5']],
    ['promotion', '7k/P7/6K1/8/8/8/8/8 w - - 0 1', ['a7a8q', 'a7a8r']]
  ]) {
    const results = [];
    for (const E of [C, B]) {
      const engine = new E.Engine();
      if (E === C && featureMask !== null) engine.configureEvaluation(featureMask);
      const result = await engine.think(fen, { mode: 'ruthless', depth: 16, timeMs });
      results.push({ move: result.move, pass: accepted.includes(result.move), depth: result.depth });
    }
    report.tactics.push({ name, fen, accepted, candidate: results[0], baseline: results[1] });
  }
  for (let pair = 0; pair < pairs; pair++) {
    const start = suite[pair % suite.length];
    for (const side of pair % 2 ? [2, 1] : [1, 2]) {
      const result = await game(B, start, side, timeMs, maxPlies, featureMask);
      report.games.push(result);
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`${report.games.length}/${pairs * 2}: ${result.start}, candidate ${side === 1 ? 'white' : 'black'}: ${result.score}, ${result.reason}, ${result.plies} plies`);
    }
  }
  const scores = Array.from({ length: pairs }, (_, i) => (report.games[i * 2].score + report.games[i * 2 + 1].score) / 2);
  const mean = scores.reduce((a, b) => a + b, 0) / pairs;
  const se = Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (pairs - 1) / pairs);
  const elo = (p) => p <= 0 || p >= 1 ? null : 400 * Math.log10(p / (1 - p));
  report.summary = { wins: report.games.filter((g) => g.score === 1).length,
    draws: report.games.filter((g) => g.score === 0.5).length, losses: report.games.filter((g) => g.score === 0).length,
    capped: report.games.filter((g) => g.reason === 'ply cap').length, score: mean, eloEstimate: elo(mean),
    pairedScoreSE: se, approximate95ScoreInterval: [Math.max(0, mean - 1.96 * se), Math.min(1, mean + 1.96 * se)],
    note: 'Small-sample normal approximation over color-pair scores; repeated starts are not independent evidence. Ply caps count as draws. No absolute rating claim.' };
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { dead };
