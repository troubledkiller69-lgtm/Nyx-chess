// Compare two fixed-node diagnostic reports for output parity.
//
// A speed-only engine change must preserve the move, score and completed depth
// at the same node budget. This comparator fails on any difference and also
// reports the aggregate nodes/second ratio so a faster build can be identified
// without confusing speed with strength.
//
// Usage:
//   node scripts/bench/compare-diagnostics.js baseline.json candidate.json

'use strict';

const path = require('node:path');
const { readJson } = require('./lib.js');

function keyById(report) {
  const map = new Map();
  for (const result of report.results || []) map.set(result.id, result);
  return map;
}

function firstRun(result) {
  return result && Array.isArray(result.runs) ? result.runs[0] : null;
}

function main() {
  const [baselineFile, candidateFile] = process.argv.slice(2).map((file) => path.resolve(file));
  if (!baselineFile || !candidateFile) {
    throw new Error('Usage: node scripts/bench/compare-diagnostics.js baseline.json candidate.json');
  }
  const baseline = readJson(baselineFile);
  const candidate = readJson(candidateFile);
  if (baseline.configuration?.budgetMode !== 'nodes' || candidate.configuration?.budgetMode !== 'nodes') {
    throw new Error('parity comparison requires fixed-node reports');
  }
  if (baseline.configuration.nodes !== candidate.configuration.nodes) {
    throw new Error('reports used different node budgets');
  }

  const left = keyById(baseline);
  const right = keyById(candidate);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  const mismatches = [];
  for (const id of ids) {
    const a = firstRun(left.get(id));
    const b = firstRun(right.get(id));
    if (!a || !b) {
      mismatches.push({ id, field: 'position', baseline: Boolean(a), candidate: Boolean(b) });
      continue;
    }
    for (const field of ['move', 'score', 'depth']) {
      if (a[field] !== b[field]) {
        mismatches.push({ id, field, baseline: a[field], candidate: b[field] });
      }
    }
  }

  const baselineNps = baseline.summary?.aggregateNodesPerSecond || 0;
  const candidateNps = candidate.summary?.aggregateNodesPerSecond || 0;
  console.log(`Baseline  ${baseline.engine?.sha256}  ${baselineNps.toLocaleString()} nodes/s`);
  console.log(`Candidate ${candidate.engine?.sha256}  ${candidateNps.toLocaleString()} nodes/s`);
  if (baselineNps > 0) {
    console.log(`Speed ratio ${(candidateNps / baselineNps).toFixed(3)}x`);
  }
  if (mismatches.length) {
    console.log(`\nOUTPUT PARITY FAILED: ${mismatches.length} mismatch(es)`);
    for (const item of mismatches) {
      console.log(`  ${item.id}: ${item.field} ${JSON.stringify(item.baseline)} -> ${JSON.stringify(item.candidate)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\nOutput parity: ${ids.length}/${ids.length} positions agree on move, score and depth.`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
