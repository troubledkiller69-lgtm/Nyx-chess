// Statistics for relative playing-strength measurement.
//
// The unit of observation is the opening pair, not the game. The two
// colour-swapped games from one opening share an opening and are therefore
// correlated; resampling games as if they were independent understates the
// interval. Every interval here resamples whole pairs.
//
// There are two interval paths:
//
//   * BCa cluster bootstrap for a completed, fixed-sample run with at least
//     MIN_BOOTSTRAP_PAIRS pairs and non-degenerate pair scores.
//   * A distribution-free Hoeffding bound for small runs and for degenerate
//     runs where every pair has the same score. A percentile bootstrap would
//     return a zero-width interval in that case, which is exactly the fake
//     certainty this project is trying to remove.
//
// No function here knows about SPRT. A fixed-sample run is analysed once,
// after the predeclared number of pairs has finished. Looking repeatedly and
// stopping when an interval looks good invalidates the nominal interval, so
// the runner refuses to produce a fixed-sample report for a partial run.

'use strict';

const MIN_BOOTSTRAP_PAIRS = 6;
const EPSILON = 1e-12;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function mean(values) {
  if (!values.length) return NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

// Elo difference relative to a 0.5 score, on the logistic scale.
// +Infinity and -Infinity are deliberate for a swept or swept-against run.
function eloFromScore(score) {
  if (!Number.isFinite(score)) return NaN;
  if (score <= 0) return -Infinity;
  if (score >= 1) return Infinity;
  const value = -400 * Math.log10(1 / score - 1);
  return Object.is(value, -0) ? 0 : value;
}

function scoreFromElo(elo) {
  return 1 / (1 + 10 ** (-elo / 400));
}

// Deterministic PRNG. A fixed seed makes a bootstrap interval reproducible
// from the report alone.
function mulberry32(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26; absolute error below 1.5e-7.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Peter J. Acklam's inverse normal CDF approximation.
function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function quantileSorted(sorted, p) {
  if (!sorted.length) return NaN;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

// Distribution-free two-sided Hoeffding interval for a bounded mean.
// Valid (conservative) for independent i.i.d. draws in [0, 1]. Here that means
// independent opening pairs from the fixed suite, not independent games and
// not repeated openings. Used for small n and degenerate samples so an
// all-draws or all-wins run cannot masquerade as a precise one.
function hoeffdingCI(values, level = 0.95) {
  const n = values.length;
  const centre = mean(values);
  if (!n) return { lower: 0, upper: 1, method: 'hoeffding', n: 0, level };
  const alpha = 1 - level;
  const radius = Math.sqrt(Math.log(2 / alpha) / (2 * n));
  return {
    lower: clamp01(centre - radius),
    upper: clamp01(centre + radius),
    method: 'hoeffding',
    n,
    level,
    radius
  };
}

// BCa cluster bootstrap over pair scores. Resamples whole pairs, so the
// colour-swapped games inside a pair stay together. This is conditional on the
// fixed, nonrandom opening suite and assumes pairs are exchangeable clusters;
// it does not estimate variation over all possible openings. Repeated
// openings would violate the independent-cluster assumption and are excluded
// by the runner.
function bootstrapCI(values, options = {}) {
  const n = values.length;
  if (n < 2) return { ...hoeffdingCI(values, options.level ?? 0.95), degenerate: true };
  const level = options.level ?? 0.95;
  const resamples = Math.max(1000, Number(options.resamples) || 20000);
  const seed = (Number(options.seed) >>> 0) || 1;
  const theta = mean(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < EPSILON) {
    return {
      lower: theta,
      upper: theta,
      method: 'degenerate',
      n,
      level,
      resamples: 0,
      seed,
      degenerate: true,
      note: 'all pair scores are identical; a percentile bootstrap has zero width'
    };
  }

  const rng = mulberry32(seed);
  const boot = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rng() * n)];
    boot[b] = sum / n;
  }
  const sorted = Array.from(boot).sort((a, b) => a - b);

  let below = 0;
  let equal = 0;
  for (const value of boot) {
    if (value < theta) below++;
    else if (Math.abs(value - theta) < EPSILON) equal++;
  }
  // Bias correction. The half-tie correction keeps p0 away from 0 and 1 when
  // every replicate lies on one side.
  const p0 = Math.min(1 - 1 / (2 * resamples), Math.max(1 / (2 * resamples), (below + 0.5 * equal) / resamples));
  const z0 = normalQuantile(p0);

  // Jackknife acceleration.
  const sum = values.reduce((a, b) => a + b, 0);
  const jack = values.map((value) => (sum - value) / (n - 1));
  const jackMean = mean(jack);
  let numerator = 0;
  let denominator = 0;
  for (const value of jack) {
    const delta = jackMean - value;
    numerator += delta ** 3;
    denominator += delta ** 2;
  }
  const acceleration = denominator < EPSILON ? 0 : numerator / (6 * denominator ** 1.5);

  const alpha = 1 - level;
  const adjust = (p) => {
    const z = normalQuantile(p);
    const denominator2 = 1 - acceleration * (z0 + z);
    if (Math.abs(denominator2) < EPSILON) return clamp01(normalCdf(z0 + (z0 + z)));
    return clamp01(normalCdf(z0 + (z0 + z) / denominator2));
  };
  const lower = Math.min(1, Math.max(0, quantileSorted(sorted, adjust(alpha / 2))));
  const upper = Math.min(1, Math.max(0, quantileSorted(sorted, adjust(1 - alpha / 2))));
  // Numerical guard: the ordered endpoints must not cross.
  return {
    lower: Math.min(lower, upper),
    upper: Math.max(lower, upper),
    method: 'bca-cluster-bootstrap',
    n,
    level,
    resamples,
    seed,
    degenerate: false
  };
}

function validatePairScores(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('pairScores must be a non-empty array');
  for (const value of values) {
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
      throw new Error(`pair score must be finite and in [0, 1], got ${value}`);
    }
  }
}

// Main analysis object for one pair-score sample.
//
// `design: 'fixed-sample'` is an explicit claim that the caller predeclared
// the sample and completed all of it. It enables the confirmatory interval
// label. Any other call is descriptive/exploratory, even if the numeric
// interval is the same. This prevents an old optionally-stopped run from being
// relabelled as a confirmatory 95% result by simply feeding its scores here.
function analyzePairs(pairScores, options = {}) {
  validatePairScores(pairScores);
  const design = options.design === 'fixed-sample' ? 'fixed-sample' : 'descriptive';
  const inferential = design === 'fixed-sample';
  if (inferential && options.plannedPairs !== undefined) {
    assertFixedSampleComplete(pairScores, options.plannedPairs);
  }
  const level = options.level ?? 0.95;
  const seed = (Number(options.seed) >>> 0) || 1;
  const n = pairScores.length;
  const centre = mean(pairScores);
  const min = Math.min(...pairScores);
  const max = Math.max(...pairScores);
  const degenerate = max - min < EPSILON;

  let ci;
  if (degenerate) {
    ci = { ...hoeffdingCI(pairScores, level), method: 'hoeffding-degenerate', degenerate: true };
  } else if (n < MIN_BOOTSTRAP_PAIRS) {
    ci = { ...hoeffdingCI(pairScores, level), method: 'hoeffding-small-n', degenerate: false };
  } else {
    ci = bootstrapCI(pairScores, { level, seed, resamples: options.resamples });
  }

  const point = eloFromScore(centre);
  const lower = ci.lower <= 0 ? null : eloFromScore(ci.lower);
  const upper = ci.upper >= 1 ? null : eloFromScore(ci.upper);
  const counts = { wins: 0, draws: 0, losses: 0 };
  const histogram = new Map();
  for (const value of pairScores) {
    if (value === 1) counts.wins++;
    else if (value === 0) counts.losses++;
    else if (Math.abs(value - 0.5) < EPSILON) counts.draws++;
    histogram.set(value, (histogram.get(value) || 0) + 1);
  }

  const intervalDefined = lower !== null && upper !== null;
  const isHoeffding = ci.method.startsWith('hoeffding');
  return {
    n,
    mean: centre,
    min,
    max,
    counts,
    distribution: [...histogram.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pairScore, count]) => ({ pairScore, count })),
    design,
    inferential,
    scope: {
      conditionalOn: 'frozen opening suite and exact engine/settings',
      unit: 'opening pair',
      universalElo: false,
      repeatedOpenings: false,
      note: 'The interval describes pair-score variation under the fixed suite; it is not an uncertainty statement about all openings or an absolute rating.'
    },
    scoreCI: {
      lower: ci.lower,
      upper: ci.upper,
      level,
      nominalLevel: level,
      method: ci.method,
      resamples: ci.resamples || 0,
      seed,
      degenerate: Boolean(ci.degenerate),
      inferential,
      design,
      label: inferential
        ? 'confirmatory fixed-sample interval'
        : 'descriptive/exploratory nominal interval; not a confirmatory 95% interval',
      assumptions: isHoeffding
        ? ['independent bounded pair draws', 'fixed nonrandom opening suite', 'exchangeability only within the observed suite']
        : ['pair scores treated as exchangeable clusters', 'fixed nonrandom opening suite', 'no repeated opening clusters']
    },
    elo: {
      point: Number.isFinite(point) ? point : null,
      lower,
      upper,
      intervalDefined,
      pointInfinite: !Number.isFinite(point),
      lowerInfinite: ci.lower <= 0,
      upperInfinite: ci.upper >= 1,
      note: 'Relative to the frozen baseline under these exact settings; not an absolute rating and not a universal Elo.'
    },
    interpretation: degenerate && Math.abs(centre - 0.5) < EPSILON
      ? 'Every pair drew. The data give no evidence of a non-zero difference; the interval is deliberately conservatively wide.'
      : !Number.isFinite(point)
        ? 'The observed score is 0 or 1, so the point Elo is infinite. Only one side of the interval is finite.'
        : 'Point Elo is the logistic conversion of the observed pair score; the interval is over pairs, conditional on the suite.'
  };
}

// Illustrative normal-approximation planning calculation. It assumes the
// supplied pair-score SD is the relevant variance for the planned contrast,
// independent pairs, a fixed suite, and a two-sided test. It is not a promise
// of power; draw rate, opening heterogeneity, and the observed SD can change
// the answer substantially.
function pairsForPower({ deltaElo, sd = 0.25, alpha = 0.05, power = 0.8 } = {}) {
  if (!(deltaElo > 0)) throw new Error('deltaElo must be positive');
  if (!(sd > 0)) throw new Error('sd must be positive');
  const deltaScore = scoreFromElo(deltaElo) - 0.5;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  return Math.ceil(((zAlpha + zPower) * sd / deltaScore) ** 2);
}

// A fixed-sample report is only valid when the predeclared number of pairs
// finished. This is enforced rather than merely documented.
function assertFixedSampleComplete(pairScores, plannedPairs) {
  if (!Number.isInteger(plannedPairs) || plannedPairs < 1) {
    throw new Error(`plannedPairs must be a positive integer, got ${plannedPairs}`);
  }
  if (!Array.isArray(pairScores)) throw new Error('pairScores must be an array');
  if (pairScores.length !== plannedPairs) {
    throw new Error(
      `fixed-sample design requires exactly ${plannedPairs} pairs; ${pairScores.length} completed. ` +
      'A partial run cannot produce a nominal confidence interval.'
    );
  }
  return true;
}

module.exports = {
  MIN_BOOTSTRAP_PAIRS,
  eloFromScore,
  scoreFromElo,
  mulberry32,
  normalCdf,
  normalQuantile,
  hoeffdingCI,
  bootstrapCI,
  analyzePairs,
  pairsForPower,
  assertFixedSampleComplete
};
