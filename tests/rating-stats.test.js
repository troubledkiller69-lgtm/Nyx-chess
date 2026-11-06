'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  eloFromScore,
  scoreFromElo,
  analyzePairs,
  bootstrapCI,
  pairsForPower,
  assertFixedSampleComplete
} = require('../scripts/rating/stats.js');

test('score and Elo conversions are inverse at ordinary scores', () => {
  assert.equal(eloFromScore(0.5), 0);
  assert.ok(Math.abs(eloFromScore(0.75) - 190.84850188786498) < 1e-9);
  assert.ok(Math.abs(eloFromScore(0.25) + 190.84850188786498) < 1e-9);
  assert.equal(eloFromScore(0), -Infinity);
  assert.equal(eloFromScore(1), Infinity);
  assert.ok(Math.abs(scoreFromElo(190.84850188786498) - 0.75) < 1e-9);
});

test('all draws do not produce a zero-width interval or fake Elo certainty', () => {
  const result = analyzePairs(Array(20).fill(0.5), { seed: 7, resamples: 2000 });
  assert.equal(result.mean, 0.5);
  assert.equal(result.elo.point, 0);
  assert.equal(result.scoreCI.method, 'hoeffding-degenerate');
  assert.ok(result.scoreCI.lower < 0.5);
  assert.ok(result.scoreCI.upper > 0.5);
  assert.ok(result.elo.lower < -100);
  assert.ok(result.elo.upper > 100);
  assert.equal(result.elo.intervalDefined, true);
  assert.match(result.interpretation, /no evidence/i);
});

test('an all-wins run has an infinite point and one finite Elo endpoint', () => {
  const result = analyzePairs(Array(20).fill(1), { seed: 7 });
  assert.equal(result.mean, 1);
  assert.equal(result.elo.point, null);
  assert.equal(result.elo.pointInfinite, true);
  assert.equal(result.elo.upper, null);
  assert.equal(result.elo.upperInfinite, true);
  assert.ok(Number.isFinite(result.elo.lower));
  assert.ok(result.elo.lower > 0);
  assert.equal(result.scoreCI.upper, 1);
  assert.equal(result.elo.intervalDefined, false);
});

test('an all-losses run is the mirror image', () => {
  const result = analyzePairs(Array(20).fill(0), { seed: 7 });
  assert.equal(result.elo.point, null);
  assert.equal(result.elo.lower, null);
  assert.equal(result.elo.lowerInfinite, true);
  assert.ok(Number.isFinite(result.elo.upper));
  assert.ok(result.elo.upper < 0);
  assert.equal(result.scoreCI.lower, 0);
});

test('a mixed fixed sample is deterministic for a fixed seed', () => {
  const scores = [1, 0, 0.5, 0.5, 1, 0.5, 0, 1, 0.5, 0.75];
  const first = analyzePairs(scores, { seed: 42, resamples: 5000 });
  const second = analyzePairs(scores, { seed: 42, resamples: 5000 });
  assert.deepEqual(first, second);
  assert.equal(first.scoreCI.method, 'bca-cluster-bootstrap');
  assert.ok(first.scoreCI.lower <= first.mean);
  assert.ok(first.scoreCI.upper >= first.mean);
  assert.ok(Number.isFinite(first.elo.point));
  assert.ok(first.elo.lower < first.elo.point);
  assert.ok(first.elo.upper > first.elo.point);
});

test('small samples use a conservative bound, not a bootstrap point', () => {
  const result = analyzePairs([1, 0], { seed: 1 });
  assert.equal(result.scoreCI.method, 'hoeffding-small-n');
  assert.ok(result.scoreCI.upper - result.scoreCI.lower > 0.5);
});

test('bootstrap reports a degenerate flag instead of inventing width', () => {
  const ci = bootstrapCI(Array(10).fill(0.5), { seed: 1, resamples: 1000 });
  assert.equal(ci.degenerate, true);
  assert.equal(ci.lower, 0.5);
  assert.equal(ci.upper, 0.5);
});

test('power planning is in the expected range for realistic pair variance', () => {
  assert.equal(pairsForPower({ deltaElo: 50, sd: 0.216 }), 72);
  assert.ok(pairsForPower({ deltaElo: 30, sd: 0.216 }) > 180);
  assert.ok(pairsForPower({ deltaElo: 100, sd: 0.216 }) < 30);
});

test('a partial fixed sample is rejected explicitly', () => {
  assert.equal(assertFixedSampleComplete([0.5, 0.5], 2), true);
  assert.throws(() => assertFixedSampleComplete([0.5], 2), /exactly 2 pairs/);
  assert.throws(() => assertFixedSampleComplete([0.5], 0), /positive integer/);
});

test('undefined Elo endpoints survive JSON without becoming finite', () => {
  const result = analyzePairs(Array(10).fill(1), { seed: 1 });
  const parsed = JSON.parse(JSON.stringify(result));
  assert.equal(parsed.elo.point, null);
  assert.equal(parsed.elo.upper, null);
  assert.ok(Number.isFinite(parsed.elo.lower));
});

test('analysis defaults to descriptive and never claims a confirmatory interval', () => {
  const scores = [1, 0, 0.5, 0.5, 1, 0.5, 0, 1, 0.5, 0.75];
  const result = analyzePairs(scores, { seed: 42, resamples: 2000 });
  assert.equal(result.design, 'descriptive');
  assert.equal(result.inferential, false);
  assert.equal(result.scoreCI.inferential, false);
  assert.equal(result.scoreCI.design, 'descriptive');
  assert.match(result.scoreCI.label, /descriptive\/exploratory/);
  assert.match(result.scoreCI.label, /not a confirmatory 95% interval/);
});

test('only an explicitly predeclared completed sample is labelled confirmatory', () => {
  const scores = [1, 0, 0.5, 0.5, 1, 0.5, 0, 1, 0.5, 0.75];
  const result = analyzePairs(scores, {
    seed: 42,
    resamples: 2000,
    design: 'fixed-sample',
    plannedPairs: scores.length
  });
  assert.equal(result.design, 'fixed-sample');
  assert.equal(result.inferential, true);
  assert.equal(result.scoreCI.label, 'confirmatory fixed-sample interval');
  assert.throws(
    () => analyzePairs(scores, { seed: 42, design: 'fixed-sample', plannedPairs: scores.length + 2 }),
    /exactly 12 pairs/
  );
});

test('scope metadata states the fixed-suite, per-pair, non-universal limits', () => {
  const result = analyzePairs([1, 0, 0.5, 0.5, 1, 0.5, 0, 1], { seed: 3, resamples: 1000 });
  assert.equal(result.scope.unit, 'opening pair');
  assert.equal(result.scope.universalElo, false);
  assert.equal(result.scope.repeatedOpenings, false);
  assert.match(result.scope.conditionalOn, /frozen opening suite/);
  assert.match(result.scope.note, /not an uncertainty statement about all openings/);
  assert.ok(result.scoreCI.assumptions.some((line) => /fixed nonrandom opening suite/.test(line)));
});

test('small-sample Hoeffding states its independent-pair assumption', () => {
  const result = analyzePairs([1, 0], { seed: 1 });
  assert.match(result.scoreCI.method, /^hoeffding/);
  assert.ok(result.scoreCI.assumptions.includes('independent bounded pair draws'));
  assert.ok(result.scoreCI.assumptions.some((line) => /exchangeability only within the observed suite/.test(line)));
});

