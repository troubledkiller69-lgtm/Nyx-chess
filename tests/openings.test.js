const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine.js');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// The repertoire is built once per module load and only offers the book when
// data was present at that moment, so each test loads a fresh copy.
function loadOpenings(bookData) {
  if (bookData === undefined) delete globalThis.NyxBookData;
  else globalThis.NyxBookData = bookData;
  delete require.cache[require.resolve('../src/openings.js')];
  return require('../src/openings.js');
}

afterEach(() => {
  delete globalThis.NyxBookData;
});

test('the book is not offered when no book has been built', () => {
  const openings = loadOpenings(undefined);
  assert.equal(openings.repertoire.some((item) => item.id === 'own-games'), false);
  assert.equal(openings.pick(START, { openingWhite: 'own-games' }), null);
});

test('the book is offered once data exists, and answers for that position', () => {
  const openings = loadOpenings({ [C.positionKey(START)]: [['e2e4', 9, 0.7], ['d2d4', 3, 0.4]] });
  const entry = openings.repertoire.find((item) => item.id === 'own-games');
  assert.ok(entry, 'own-games entry exists');
  assert.equal(entry.lines.length, 0, 'the book supplies its own moves');
  const pick = openings.pick(START, { openingWhite: 'own-games', bookSeed: 11 });
  assert.equal(pick.source, 'book');
  assert.equal(pick.move, 'e2e4');
  assert.equal(pick.ply, 1);
});

test('a recorded move that is no longer legal is skipped, not played', () => {
  const openings = loadOpenings({ [C.positionKey(START)]: [['e2e5', 50, 1], ['g1f3', 2, 0.5]] });
  const pick = openings.pick(START, { openingWhite: 'own-games', bookSeed: 3 });
  assert.equal(pick.move, 'g1f3');
});

test('an unknown position falls through to the search instead of guessing', () => {
  const openings = loadOpenings({});
  assert.equal(openings.pick(START, { openingWhite: 'own-games', bookSeed: 1 }), null);
});

test('book selection is reproducible for a given seed and varies across seeds', () => {
  const openings = loadOpenings({ [C.positionKey(START)]: [['e2e4', 5, 0.5], ['d2d4', 5, 0.5], ['c2c4', 5, 0.5]] });
  const first = openings.pick(START, { openingWhite: 'own-games', bookSeed: 42 }).move;
  const again = openings.pick(START, { openingWhite: 'own-games', bookSeed: 42 }).move;
  assert.equal(first, again);
  const seen = new Set([first]);
  for (let seed = 0; seed < 40; seed++) {
    seen.add(openings.pick(START, { openingWhite: 'own-games', bookSeed: seed }).move);
  }
  assert.ok(seen.size > 1, 'different seeds reach different book moves');
});
