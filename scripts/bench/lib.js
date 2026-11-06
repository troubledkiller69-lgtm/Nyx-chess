// Shared utilities for the benchmark suite.
//
// Design notes:
// - Every measurement carries an interval. Nothing here returns a bare
//   percentage that could be mistaken for a rating claim.
// - Engine files are hashed before use so a report always names the exact
//   build that produced it.
// - Adjudication is centralised so every suite agrees on what a draw is.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../../src/engine.js');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Load an engine build without the require cache handing back a stale module.
// Each distinct path gets a fresh evaluation, which is what "frozen build"
// means in practice.
function loadEngine(file) {
  const resolved = path.resolve(file);
  delete require.cache[resolved];
  const module = require(resolved);
  if (typeof module.Engine !== 'function' || typeof module.Position !== 'function') {
    throw new Error(`${file} does not export Engine and Position`);
  }
  return module;
}

// Deterministic RNG. Any stochastic engine option receives this instead of
// Math.random so a run can be reproduced from its seed.
function makeRng(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deadMaterial(pos) {
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

// Returns { result, reason, plies } where result is '1-0', '0-1', '1/2-1/2',
// or null when the game is still in progress.
function adjudicate(pos, history, counts, maxPlies, ply) {
  const legal = pos.legalMoves();
  if (!legal.length) {
    return pos.inCheck(pos.side)
      ? { result: pos.side === C.WHITE ? '0-1' : '1-0', reason: 'mate', plies: ply }
      : { result: '1/2-1/2', reason: 'stalemate', plies: ply };
  }
  if (pos.half >= 100) return { result: '1/2-1/2', reason: 'fifty-move', plies: ply };
  const key = C.positionKey(pos.fen());
  if ((counts.get(key) || 0) >= 3) return { result: '1/2-1/2', reason: 'threefold', plies: ply };
  if (deadMaterial(pos)) return { result: '1/2-1/2', reason: 'insufficient material', plies: ply };
  if (ply >= maxPlies) return { result: '1/2-1/2', reason: 'ply cap', plies: ply };
  return { result: null, reason: 'in progress', plies: ply };
}

// Mean of pair scores and a 95% interval.
//
// The pair is the unit of observation: the two colour-swapped games from one
// opening are correlated, so treating them as independent overstates
// confidence.
//
// The interval is Agresti-Coull rather than the normal approximation. That
// matters because this engine is deterministic: a short match can produce
// identical pair scores, the sample variance collapses to zero, and a normal
// interval then claims certainty from two games. Agresti-Coull never does. It
// also degrades gracefully at the ends, where a candidate wins or loses every
// pair and a normal interval would be a point.
function pairStats(pairScores) {
  const n = pairScores.length;
  if (!n) return { pairs: 0, mean: 0, se: Infinity, ci95: [0, 1], min: 0, max: 1 };
  const sum = pairScores.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const adjusted = n + 4;
  const p = (sum + 2) / adjusted;
  const se = Math.sqrt((p * (1 - p)) / adjusted);
  const margin = 1.96 * se;
  return {
    pairs: n,
    mean,
    se,
    ci95: [Math.max(0, p - margin), Math.min(1, p + margin)],
    min: Math.min(...pairScores),
    max: Math.max(...pairScores)
  };
}

function eloFromScore(score) {
  if (score <= 0) return -Infinity;
  if (score >= 1) return Infinity;
  return -400 * Math.log10(1 / score - 1);
}

// Normal-approximation SPRT over pair scores.
//
// H0: expected pair score = s0 (the change is worth `elo0`).
// H1: expected pair score = s1 (the change is worth `elo1`).
//
// Two guards keep this from producing confident nonsense:
//
// - The variance comes from the Agresti-Coull standard error, not the raw
//   sample variance. A deterministic engine produces identical pair scores,
//   and a zero sample variance would otherwise make the LLR explode after two
//   games.
// - No decision is reported before `minPairs`. A stopping rule that fires on
//   a sample of two is not a stopping rule, it is a coin flip with a formula
//   attached.
//
// The result is still an approximation and is labelled as one. It is more
// honest than a fixed game count with no stopping rule at all.
function sprt(pairScores, options = {}) {
  const elo0 = options.elo0 ?? 0;
  const elo1 = options.elo1 ?? 10;
  const alpha = options.alpha ?? 0.05;
  const beta = options.beta ?? 0.05;
  const minPairs = options.minPairs ?? 8;
  const n = pairScores.length;
  const upper = Math.log((1 - beta) / alpha);
  const lower = Math.log(beta / (1 - alpha));
  const sum = pairScores.reduce((a, b) => a + b, 0);
  const mean = n ? sum / n : 0;
  const adjusted = n + 4;
  const p = (sum + 2) / adjusted;
  const sigma2 = (p * (1 - p)) / adjusted;
  if (n < minPairs) {
    return { decision: 'continue', llr: 0, lower, upper, n, elo0, elo1, alpha, beta, mean, sigma2, minPairs };
  }
  const s0 = 1 / (1 + 10 ** (-elo0 / 400));
  const s1 = 1 / (1 + 10 ** (-elo1 / 400));
  const llr = (n / (2 * sigma2)) * ((mean - s0) ** 2 - (mean - s1) ** 2);
  let decision = 'continue';
  if (llr >= upper) decision = 'accept';
  else if (llr <= lower) decision = 'reject';
  return { decision, llr, lower, upper, n, elo0, elo1, alpha, beta, mean, sigma2, minPairs };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

// A one-line human summary used by every suite.
function summarise(stats) {
  const [lo, hi] = stats.ci95;
  return `${pct(stats.mean)} over ${stats.pairs} pairs ` +
    `(95% CI ${pct(lo)}-${pct(hi)}, SE ${stats.se.toFixed(3)})`;
}

module.exports = {
  C,
  sha256File,
  loadEngine,
  makeRng,
  deadMaterial,
  adjudicate,
  pairStats,
  eloFromScore,
  sprt,
  readJson,
  writeJson,
  pct,
  summarise
};
