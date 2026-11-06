'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectGameFile,
  phaseFor,
  materialPoints,
  fenPositionKey,
  ENDGAME_POINTS
} = require('../lib/game.js');
const {
  gradeMove,
  summarizeMoves,
  analyzeGame,
  terminalAfter
} = require('../lib/analyze.js');
const { Stockfish, START_FEN } = require('../lib/stockfish.js');

const ROOT = path.resolve(__dirname, '../../..');
const MATCH = path.join(ROOT, 'docs', 'benchmarks', 'match-selfplay.json');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-stockfish.js');

function fakeResult(score, options = {}) {
  const bestmove = options.bestmove === undefined ? 'e2e4' : options.bestmove;
  return {
    bestmove,
    depth: options.depth ?? 12,
    seldepth: (options.depth ?? 12) + 2,
    nodes: options.nodes ?? 100000,
    nps: 1000000,
    timeMs: 100,
    score,
    pv: bestmove ? [bestmove, 'e7e5'] : [],
    wdl: null
  };
}

test('real match report game 0 replays legally through Nyx movegen', () => {
  const inspected = inspectGameFile(MATCH, { gameIndex: 0 });
  assert.equal(inspected.gameIndex, 0);
  assert.ok(inspected.gameCount > 0);
  assert.equal(inspected.game.opening, 'Ruy Lopez');
  assert.equal(inspected.game.openingMoves.length, 6);
  assert.equal(inspected.game.openingPlies, 6);
  assert.equal(inspected.game.resolvedFrom, 'opening-suite');
  assert.notEqual(inspected.game.startFen, START_FEN);
  assert.equal(inspected.game.moves.length, 79);
  assert.equal(inspected.game.moves[0].played, 'b5d3');
  assert.equal(inspected.game.moves[0].side, 'w');
  assert.equal(inspected.game.moves[0].ply, 1);
  assert.equal(inspected.game.positions.length, 80);
  assert.equal(fenPositionKey(inspected.game.positions[0].fen), fenPositionKey(inspected.game.startFen));
  assert.equal(inspected.inputSha256.length, 64);
});

test('illegal recorded moves are rejected instead of guessed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-analysis-game-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({
    games: [{ opening: 'Ruy Lopez', moves: ['e2e4'] }]
  }));
  try {
    assert.throws(
      () => inspectGameFile(file, { gameIndex: 0 }),
      /Illegal recorded move e2e4/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown opening is an error, not a silent standard start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-analysis-opening-'));
  const file = path.join(dir, 'unknown.json');
  fs.writeFileSync(file, JSON.stringify({
    games: [{ opening: 'Definitely Not An Opening', moves: ['e2e4'] }]
  }));
  try {
    assert.throws(
      () => inspectGameFile(file, { gameIndex: 0 }),
      /will not guess a start position/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit starting FEN is validated and used', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-analysis-fen-'));
  const file = path.join(dir, 'fen.json');
  const start = '8/5pk1/6p1/3p4/3P4/5KP1/5P2/8 w - - 0 35';
  fs.writeFileSync(file, JSON.stringify({
    initialFen: start,
    moves: ['f3e3']
  }));
  try {
    const inspected = inspectGameFile(file, { gameIndex: 0 });
    assert.equal(inspected.game.startFen, start);
    assert.equal(inspected.game.resolvedFrom, 'starting-fen');
    assert.equal(inspected.game.moves[0].played, 'f3e3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('phase labels are material/ply heuristics', () => {
  assert.equal(materialPoints(START_FEN), 62);
  assert.equal(phaseFor(START_FEN, 0, 0), 'opening');
  assert.equal(phaseFor(START_FEN, 30, 6), 'middlegame');
  const endgame = '8/5pk1/6p1/3p4/3P4/5KP1/5P2/8 w - - 0 35';
  assert.ok(materialPoints(endgame) <= ENDGAME_POINTS);
  assert.equal(phaseFor(endgame, 60, 6), 'endgame');
});

test('terminal detection distinguishes checkmate from stalemate', () => {
  assert.equal(terminalAfter('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1').type, 'checkmate');
  assert.equal(terminalAfter('7k/5Q2/8/8/8/8/8/7K b - - 0 1').type, 'stalemate');
  assert.equal(terminalAfter(START_FEN), null);
});

test('same move as the root best is graded good without a second search', () => {
  const best = fakeResult({ type: 'cp', value: 40, bound: null });
  const graded = gradeMove({
    played: 'e2e4',
    best,
    playedSearch: null,
    terminal: null,
    requestedDepth: 12,
    sameAsBest: true
  });
  assert.equal(graded.graded, true);
  assert.equal(graded.label, 'good');
  assert.equal(graded.lossCp, 0);
});

test('cp loss is compared at equal depth from the mover perspective', () => {
  const graded = gradeMove({
    played: 'd2d4',
    best: fakeResult({ type: 'cp', value: 50, bound: null }),
    playedSearch: fakeResult({ type: 'cp', value: 20, bound: null }, { bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(graded.graded, true);
  assert.equal(graded.lossCp, 30);
  assert.equal(graded.label, 'dubious');
  assert.equal(graded.bestScore.text, '+50 cp');
  assert.equal(graded.requestedDepth, 12);
});

test('incomplete depth is ungraded instead of a fake loss', () => {
  const graded = gradeMove({
    played: 'd2d4',
    best: fakeResult({ type: 'cp', value: 50, bound: null }, { depth: 12 }),
    playedSearch: fakeResult({ type: 'cp', value: 20, bound: null }, { depth: 8, bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(graded.graded, false);
  assert.equal(graded.lossCp, null);
  assert.match(graded.reason, /did not both reach exactly depth 12/);
});

test('bound and missing scores are never treated as exact losses', () => {
  const bound = gradeMove({
    played: 'd2d4',
    best: fakeResult({ type: 'cp', value: 50, bound: 'lowerbound' }),
    playedSearch: fakeResult({ type: 'cp', value: 20, bound: null }, { bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(bound.graded, false);
  assert.match(bound.reason, /bound score/);

  const missing = gradeMove({
    played: 'd2d4',
    best: fakeResult(null),
    playedSearch: fakeResult({ type: 'cp', value: 20, bound: null }, { bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(missing.graded, false);
  assert.match(missing.reason, /no score/);
});

test('mate scores stay mate scores', () => {
  const missed = gradeMove({
    played: 'd2d4',
    best: fakeResult({ type: 'mate', value: 3, bound: null }),
    playedSearch: fakeResult({ type: 'cp', value: 200, bound: null }, { bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(missed.label, 'missed mate');
  assert.equal(missed.lossCp, null);
  assert.equal(missed.missedMate, true);
  assert.equal(missed.bestScore.text, 'M3');

  const allowed = gradeMove({
    played: 'd2d4',
    best: fakeResult({ type: 'cp', value: 200, bound: null }),
    playedSearch: fakeResult({ type: 'mate', value: -2, bound: null }, { bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(allowed.label, 'allowed mate');
  assert.equal(allowed.lossCp, null);
  assert.equal(allowed.playedScore.text, '-M2');

  const slower = gradeMove({
    played: 'd2d4',
    best: fakeResult({ type: 'mate', value: 3, bound: null }),
    playedSearch: fakeResult({ type: 'mate', value: 5, bound: null }, { bestmove: 'd2d4' }),
    terminal: null,
    requestedDepth: 12
  });
  assert.equal(slower.label, 'slower mate');
  assert.equal(slower.lossCp, null);
});

test('terminal checkmate is separate from cp grading', () => {
  const graded = gradeMove({
    played: 'd1h5',
    best: fakeResult({ type: 'cp', value: 500, bound: null }),
    playedSearch: fakeResult({ type: 'mate', value: 1, bound: null }),
    terminal: { type: 'checkmate', sideToMove: 'b' },
    requestedDepth: 12
  });
  assert.equal(graded.graded, true);
  assert.equal(graded.label, 'checkmate');
  assert.equal(graded.lossCp, 0);
});

test('summary separates errors by phase and keeps ungraded moves out of averages', () => {
  const moves = [
    {
      ply: 1, moveNumber: 1, side: 'w', phase: 'opening', played: 'e2e4', best: 'd2d4',
      graded: true, label: 'good', lossCp: 0, severity: 0, bestScore: { text: '+20 cp' }, playedScore: { text: '+20 cp' }
    },
    {
      ply: 20, moveNumber: 10, side: 'b', phase: 'middlegame', played: 'e7e5', best: 'c7c5',
      graded: true, label: 'mistake', lossCp: 180, severity: 180, bestScore: { text: '+30 cp' }, playedScore: { text: '-150 cp' }
    },
    {
      ply: 21, moveNumber: 11, side: 'w', phase: 'middlegame', played: 'g1f3', best: 'b1c3',
      graded: false, label: 'ungraded', lossCp: null, severity: 0, reason: 'depth mismatch', bestScore: null, playedScore: null
    },
    {
      ply: 22, moveNumber: 11, side: 'b', phase: 'middlegame', played: 'h7h6', best: 'd8h4',
      graded: true, label: 'missed mate', lossCp: null, severity: 10003, bestScore: { text: 'M3', bestmove: 'd8h4' },
      playedScore: { text: '+100 cp' }, reason: 'the root search found mate in 3'
    }
  ];
  const summary = summarizeMoves(moves);
  assert.equal(summary.analyzed, 4);
  assert.equal(summary.graded, 3);
  assert.equal(summary.cpGraded, 2);
  assert.equal(summary.ungraded, 1);
  assert.equal(summary.averageLossCp, 90);
  assert.equal(summary.phases.middlegame.errors, 2);
  assert.equal(summary.phases.opening.errors, 0);
  assert.equal(summary.missedMates.length, 1);
  assert.equal(summary.turningPoints[0].label, 'missed mate');
});

test('analyzeGame drives sequential best/played searches through the adapter', async () => {
  const inspected = inspectGameFile(MATCH, { gameIndex: 0 });
  const engine = new Stockfish(process.execPath, {
    args: [FIXTURE],
    timeoutMs: 5000
  });
  try {
    await engine.start();
    await engine.newGame();
    const result = await analyzeGame({
      engine,
      game: inspected.game,
      depth: 3,
      limit: 1,
      side: 'both',
      clearHash: true
    });
    assert.equal(result.moves.length, 1);
    const move = result.moves[0];
    assert.equal(move.played, 'b5d3');
    assert.equal(move.best, 'e2e4');
    assert.equal(move.sameAsBest, false);
    assert.equal(move.graded, true);
    assert.equal(move.lossCp, 0);
    assert.equal(move.bestScore.depth, 3);
    assert.equal(move.playedScore.depth, 3);
    assert.equal(result.summary.analyzed, 1);
  } finally {
    await engine.close();
  }
});
