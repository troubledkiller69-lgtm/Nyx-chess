// Static provenance and overlap check for opening suites.
//
// This applies move lists with Position only. It never calls Engine.think() and
// runs no games. The output records exact-line duplicates, identical final
// positions (full transpositions), and shared non-start positions across
// suites. That is the evidence needed to say a validation file is distinct from
// the tuning file rather than merely differently named.
//
// Usage:
//   node scripts/rating/check-openings.js
//   node scripts/rating/check-openings.js --out docs/benchmarks/rating/openings/provenance.json

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const C = require(path.join(ROOT, 'src/engine.js'));

const DEFAULT_SUITES = {
  tuning: { file: 'scripts/rating/openings/tuning-72.json', role: 'tuning' },
  validation: { file: 'scripts/rating/openings/validation-36.json', role: 'validation' },
  earlierHeldout: { file: 'scripts/heldout-starts.json', role: 'historical-heldout (already used)' },
  benchOpenings: { file: 'scripts/bench/openings.json', role: 'tuning source' }
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = next;
    i++;
  }
  return args;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function positionKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function traceOpening(opening) {
  const pos = new C.Position(opening.fen || C.START_FEN);
  const positions = [positionKey(pos.fen())];
  const moves = (opening.moves || '').split(' ').filter(Boolean);
  for (const name of moves) {
    const move = pos.legalMoves().find((candidate) => C.uci(candidate) === name);
    if (!move) throw new Error(`illegal opening move ${name} in ${opening.name}`);
    pos.make(move);
    positions.push(positionKey(pos.fen()));
  }
  return {
    name: opening.name,
    line: opening.fen ? `fen:${opening.fen}|${moves.join(' ')}` : moves.join(' '),
    moves: moves.join(' '),
    finalFen: positions[positions.length - 1],
    positions
  };
}

function duplicateMap(entries, keyOf) {
  const map = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry.name);
  }
  return [...map.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([key, names]) => ({ key, names }));
}

function crossOverlap(a, b) {
  const bFinal = new Map();
  const bPositions = new Map();
  for (const entry of b) {
    if (!bFinal.has(entry.finalFen)) bFinal.set(entry.finalFen, []);
    bFinal.get(entry.finalFen).push(entry.name);
    for (const position of new Set(entry.positions.slice(1))) {
      if (!bPositions.has(position)) bPositions.set(position, []);
      bPositions.get(position).push(entry.name);
    }
  }
  const finalOverlaps = [];
  const reachableOverlaps = [];
  const positionOverlapRows = [];
  for (const entry of a) {
    if (bFinal.has(entry.finalFen)) {
      finalOverlaps.push({ name: entry.name, finalFen: entry.finalFen, otherNames: bFinal.get(entry.finalFen) });
    } else if (bPositions.has(entry.finalFen)) {
      // The result is the same position as one reached mid-line elsewhere: a
      // real transposition even though the other suite's line continues.
      reachableOverlaps.push({
        name: entry.name,
        finalFen: entry.finalFen,
        otherNames: [...new Set(bPositions.get(entry.finalFen))]
      });
    }
    const shared = [...new Set(entry.positions.slice(1))].filter((position) => bPositions.has(position));
    if (shared.length) {
      positionOverlapRows.push({
        name: entry.name,
        sharedNonStartPositions: shared.length,
        otherNames: [...new Set(shared.flatMap((position) => bPositions.get(position)))].slice(0, 8)
      });
    }
  }
  return {
    identicalFinalPositions: finalOverlaps.length,
    finalOverlapRows: finalOverlaps,
    finalPositionReachableInOther: reachableOverlaps.length,
    reachableOverlapRows: reachableOverlaps,
    linesSharingNonStartPositions: positionOverlapRows.length,
    positionOverlapRows
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outFile = path.resolve(args.out || path.join(ROOT, 'docs', 'benchmarks', 'rating', 'openings', 'provenance.json'));
  const suites = {};
  for (const [id, spec] of Object.entries(DEFAULT_SUITES)) {
    const file = path.resolve(ROOT, spec.file);
    if (!fs.existsSync(file)) throw new Error(`suite not found: ${file}`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = raw.map(traceOpening);
    suites[id] = {
      role: spec.role,
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      sha256: sha256File(file),
      lines: entries.length,
      duplicateLinesWithin: duplicateMap(entries, (entry) => entry.line),
      duplicateFinalPositionsWithin: duplicateMap(entries, (entry) => entry.finalFen),
      entries
    };
  }

  const pairs = [
    ['validation', 'tuning'],
    ['validation', 'earlierHeldout'],
    ['validation', 'benchOpenings']
  ];
  const overlaps = {};
  for (const [a, b] of pairs) {
    overlaps[`${a}->${b}`] = crossOverlap(suites[a].entries, suites[b].entries);
  }

  const publicSuites = {};
  for (const [id, suite] of Object.entries(suites)) {
    publicSuites[id] = {
      role: suite.role,
      file: suite.file,
      sha256: suite.sha256,
      lines: suite.lines,
      duplicateLinesWithin: suite.duplicateLinesWithin,
      duplicateFinalPositionsWithin: suite.duplicateFinalPositionsWithin
    };
  }

  const report = {
    kind: 'opening-suite-provenance',
    generatedAt: new Date().toISOString(),
    method: 'Position move application only; no Engine.think/search and no games',
    provenance: {
      validation: 'Authored as a new suite for this rating work from standard opening theory. No search or game result was used to select or edit a line. Legality and transposition checks are static move application only.',
      tuning: 'Frozen copy of the existing development opening set. Reuse is allowed.',
      earlierHeldout: 'Historical held-out set from docs/evaluation-development.md. It was used in a past 0.6.6 validation run and is no longer untouched.'
    },
    suites: publicSuites,
    overlaps,
    interpretation: {
      identicalFinalPositions: 'A non-zero count is a genuine transposition overlap: the two suites reach the same final chess position.',
      finalPositionReachableInOther: 'A validation line ends on a position the other suite reaches mid-line. Not a duplicate pair, but it is a real transposition of the played position.',
      sharedNonStartPositions: 'Non-zero does not mean duplicate pairs; it means the lines share an opening prefix or transpose transiently. Large shared-prefix counts mean less opening independence and should be disclosed.',
      bootstrapScope: 'The fixed-sample bootstrap is conditional on the chosen suite, not on a random sample of all openings.'
    }
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  const v = publicSuites.validation;
  console.log(`validation (${v.lines} lines, sha256 ${v.sha256})`);
  console.log(`  duplicate lines within suite: ${v.duplicateLinesWithin.length}`);
  console.log(`  duplicate final positions within suite: ${v.duplicateFinalPositionsWithin.length}`);
  for (const [a, b] of pairs) {
    const o = overlaps[`${a}->${b}`];
    console.log(`  ${a}->${b}: identical final ${o.identicalFinalPositions}, final reachable in other ${o.finalPositionReachableInOther}, lines sharing non-start positions ${o.linesSharingNonStartPositions}/${publicSuites[a].lines}`);
  }
  console.log(`written ${outFile}`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
