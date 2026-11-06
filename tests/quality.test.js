const { test } = require('node:test');
const assert = require('node:assert/strict');
const { moveQuality } = require('../src/settings.js');

test('move labels distinguish book, search quality, and insufficient evidence', () => {
  assert.equal(moveQuality({ move: 'e2e4', source: 'book' }).label, 'Book');
  const result = { move: 'd2d4', depth: 8, exactScores: true, lines: [{ move: 'e2e4', score: 100 }] };
  for (const [loss, label] of [[0, 'Best'], [10, 'Excellent'], [40, 'Good'], [80, 'Inaccuracy'], [200, 'Mistake'], [300, 'Blunder']]) {
    assert.equal(moveQuality({ ...result, score: 100 - loss }).label, label);
  }
  assert.equal(moveQuality({ ...result, score: 80, exactScores: false }).label, 'Unrated');
  assert.equal(moveQuality({ ...result, score: 100, scoreSource: 'static' }).label, 'Unrated');
});
