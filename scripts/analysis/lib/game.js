'use strict';

// Recorded-game loader and validator for Nyx match reports.
//
// Match reports contain a UCI move list and an opening name. The opening name
// is resolved against the benchmark opening suite, then every move is replayed
// through Nyx's own move generator. Nothing is inferred from board differences
// and SAN is not parsed: an illegal or unrecognised move is an error.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../../../src/engine.js');

const DEFAULT_OPENINGS = path.resolve(__dirname, '../../../scripts/bench/openings.json');
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const ENDGAME_POINTS = 20;
const OPENING_DEVELOPMENT_PLIES = 8;

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function readJson(file) {
  const absolute = path.resolve(file);
  const raw = fs.readFileSync(absolute);
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Could not parse JSON at ${absolute}: ${error.message}`);
  }
  return { absolute, raw, data, sha256: sha256Buffer(raw) };
}

function normalizeUciMove(value, context) {
  if (value && typeof value === 'object') {
    value = value.uci || value.move || value.played;
  }
  if (typeof value !== 'string') {
    throw new Error(`${context}: move is not a UCI string`);
  }
  const move = value.trim().toLowerCase();
  if (!UCI_MOVE.test(move)) {
    throw new Error(`${context}: "${value}" is not a UCI move (SAN is not accepted)`);
  }
  return move;
}

function moveList(value, context) {
  if (Array.isArray(value)) return value.map((move, index) => normalizeUciMove(move, `${context}[${index}]`));
  if (typeof value === 'string') {
    return value.split(/\s+/).filter(Boolean).map((move, index) => normalizeUciMove(move, `${context}[${index}]`));
  }
  if (value === undefined || value === null) return [];
  throw new Error(`${context}: expected a UCI move list`);
}

function fenPositionKey(fen) {
  return String(fen).trim().split(/\s+/).slice(0, 4).join(' ');
}

function validateFen(fen, context) {
  const fields = String(fen).trim().split(/\s+/);
  if (fields.length !== 6) throw new Error(`${context}: expected a six-field FEN, got "${fen}"`);
  try {
    const position = new C.Position(fen);
    position.legalMoves();
  } catch (error) {
    throw new Error(`${context}: invalid FEN "${fen}": ${error.message}`);
  }
  return fields.join(' ');
}

function loadOpenings(file = DEFAULT_OPENINGS) {
  const { absolute, data } = readJson(file);
  if (!Array.isArray(data)) throw new Error(`${absolute}: expected an array of opening definitions`);
  const map = new Map();
  for (const entry of data) {
    if (!entry || typeof entry.name !== 'string') continue;
    map.set(entry.name, {
      name: entry.name,
      moves: moveList(entry.moves, `${absolute}:${entry.name}`)
    });
  }
  return { file: absolute, map };
}

function loadStartSuites(file) {
  const { absolute, data } = readJson(file);
  if (!Array.isArray(data)) throw new Error(`${absolute}: expected an array of starting positions`);
  const map = new Map();
  for (const entry of data) {
    if (!entry || typeof entry.name !== 'string') continue;
    map.set(entry.name, {
      name: entry.name,
      fen: entry.fen ? validateFen(entry.fen, `${absolute}:${entry.name}`) : null,
      moves: moveList(entry.moves, `${absolute}:${entry.name}`)
    });
  }
  return { file: absolute, map };
}

function applyPrefix(startFen, moves, context) {
  const position = new C.Position(startFen);
  const applied = [];
  for (let i = 0; i < moves.length; i++) {
    const move = position.legalMoves().find((candidate) => C.uci(candidate) === moves[i]);
    if (!move) {
      throw new Error(`${context}: illegal opening move ${moves[i]} at ply ${i + 1} in ${position.fen()}`);
    }
    position.make(move);
    applied.push(moves[i]);
  }
  return { fen: position.fen(), moves: applied };
}

function resolveStart(game, options = {}) {
  const openings = options.openings || loadOpenings(options.openingsPath || DEFAULT_OPENINGS);
  const suites = options.starts || (options.startsPath ? loadStartSuites(options.startsPath) : null);
  const explicitFen = options.startFen || null;
  const explicitOpeningMoves = options.openingMoves
    ? moveList(options.openingMoves, '--opening-moves')
    : null;

  let initialFen = explicitFen ||
    game.initialFen || game.startFen || game.fen ||
    (game.start && typeof game.start === 'object' ? game.start.fen : null) ||
    null;
  if (initialFen) initialFen = validateFen(initialFen, 'starting FEN');

  let openingName = null;
  let openingMoves = explicitOpeningMoves;
  if (!openingMoves) {
    if (Array.isArray(game.openingMoves)) openingMoves = moveList(game.openingMoves, 'openingMoves');
    else if (typeof game.openingMoves === 'string') openingMoves = moveList(game.openingMoves, 'openingMoves');
    else if (typeof game.opening === 'string') openingName = game.opening;
    else if (game.opening && typeof game.opening === 'object') {
      openingName = game.opening.name || null;
      if (game.opening.moves) openingMoves = moveList(game.opening.moves, 'opening.moves');
    } else if (typeof game.start === 'string') {
      openingName = game.start;
    } else if (game.start && typeof game.start === 'object') {
      openingName = game.start.name || null;
      if (game.start.moves) openingMoves = moveList(game.start.moves, 'start.moves');
    }
  }

  let opening = null;
  if (!openingMoves && openingName) {
    const suiteEntry = openings.map.get(openingName);
    if (suiteEntry) {
      opening = suiteEntry;
      openingMoves = suiteEntry.moves;
    } else if (suites) {
      const startEntry = suites.map.get(openingName);
      if (startEntry) {
        if (startEntry.fen && !initialFen) initialFen = startEntry.fen;
        opening = { name: openingName, moves: startEntry.moves };
        openingMoves = startEntry.moves;
      }
    }
    if (!opening && !initialFen) {
      throw new Error(
        `Opening "${openingName}" is not in ${openings.file}${suites ? ` or ${suites.file}` : ''}. ` +
        'Pass --openings, --starts, --start-fen or --opening-moves; the tool will not guess a start position.'
      );
    }
  }

  let startFen = initialFen || C.START_FEN;
  let openingApplied = [];
  if (openingMoves && openingMoves.length) {
    const applied = applyPrefix(C.START_FEN, openingMoves, `opening${openingName ? ` "${openingName}"` : ''}`);
    openingApplied = applied.moves;
    if (initialFen && fenPositionKey(applied.fen) !== fenPositionKey(initialFen)) {
      throw new Error(
        `Opening moves do not lead to the recorded starting FEN. ` +
        `opening=${applied.fen} recorded=${initialFen}`
      );
    }
    startFen = applied.fen;
  } else if (initialFen) {
    startFen = initialFen;
  }

  return {
    startFen,
    opening: openingName,
    openingMoves: openingApplied,
    openingPlies: openingApplied.length,
    resolvedFrom: openingApplied.length
      ? (openingName ? 'opening-suite' : 'explicit-opening-moves')
      : (initialFen ? 'starting-fen' : 'standard-start')
  };
}

function materialPoints(fen) {
  const board = String(fen).split(/\s+/)[0] || '';
  let points = 0;
  for (const char of board) {
    switch (char.toLowerCase()) {
      case 'q': points += 9; break;
      case 'r': points += 5; break;
      case 'b': points += 3; break;
      case 'n': points += 3; break;
      default: break;
    }
  }
  return points;
}

// Heuristic phase label. This is a diagnostic bucket, not a chess judgement:
// the endgame threshold is total non-pawn material (Q=9 R=5 B/N=3, both sides)
// at or below 20, and "opening" is the resolved opening plus eight development
// plies (or the first ten plies when no opening was resolved).
function phaseFor(fen, ply, openingPlies = 0) {
  const points = materialPoints(fen);
  if (points <= ENDGAME_POINTS) return 'endgame';
  const openingLimit = openingPlies > 0
    ? openingPlies + OPENING_DEVELOPMENT_PLIES
    : 10;
  if (ply < openingLimit) return 'opening';
  return 'middlegame';
}

function replayGame(game, start, options = {}) {
  const moves = moveList(game.moves, 'game.moves');
  const position = new C.Position(start.startFen);
  const positions = [{
    fen: position.fen(),
    ply: 0,
    side: position.side === C.BLACK ? 'b' : 'w',
    phase: phaseFor(position.fen(), 0, start.openingPlies)
  }];
  const records = [];

  for (let index = 0; index < moves.length; index++) {
    const before = position.fen();
    const legal = position.legalMoves();
    const played = moves[index];
    const move = legal.find((candidate) => C.uci(candidate) === played);
    if (!move) {
      throw new Error(
        `Illegal recorded move ${played} at ply ${index + 1} (move ${Math.floor(index / 2) + 1}) ` +
        `in ${before}`
      );
    }
    const mover = position.side === C.BLACK ? 'b' : 'w';
    position.make(move);
    const after = position.fen();
    records.push({
      ply: index + 1,
      moveNumber: Number(before.split(' ')[5]) || Math.floor(index / 2) + 1,
      side: mover,
      phase: phaseFor(before, index, start.openingPlies),
      beforeFen: before,
      afterFen: after,
      played,
      historyMoves: moves.slice(0, index)
    });
    positions.push({
      fen: after,
      ply: index + 1,
      side: position.side === C.BLACK ? 'b' : 'w',
      phase: phaseFor(after, index + 1, start.openingPlies)
    });
  }

  if (game.finalFen) {
    const expected = validateFen(game.finalFen, 'game.finalFen');
    if (fenPositionKey(expected) !== fenPositionKey(position.fen())) {
      throw new Error(
        `Replayed game does not match finalFen. replay=${position.fen()} finalFen=${expected}`
      );
    }
  }
  if (Number(game.plies) > 0 && Number(game.plies) !== moves.length) {
    throw new Error(`Recorded plies=${game.plies} but move list has ${moves.length} moves`);
  }

  return {
    startFen: start.startFen,
    finalFen: position.fen(),
    opening: start.opening,
    openingMoves: start.openingMoves,
    openingPlies: start.openingPlies,
    resolvedFrom: start.resolvedFrom,
    moves: records,
    positions,
    declaredResult: game.result || null,
    declaredReason: game.reason || null,
    declaredScore: typeof game.score === 'number' ? game.score : null
  };
}

function selectGame(data, gameIndex = 0) {
  let games;
  if (Array.isArray(data)) games = data;
  else if (Array.isArray(data.games)) games = data.games;
  else if (data && Array.isArray(data.moves)) games = [data];
  else throw new Error('Input is not a match report (no games array) or a single game (no moves array)');
  if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= games.length) {
    throw new Error(`--game ${gameIndex} is out of range; file contains ${games.length} game(s)`);
  }
  return { game: games[gameIndex], index: gameIndex, total: games.length, games };
}

function inspectGameFile(file, options = {}) {
  const parsed = readJson(file);
  const selected = selectGame(parsed.data, options.gameIndex ?? 0);
  const start = resolveStart(selected.game, options);
  const game = replayGame(selected.game, start, options);
  return {
    file: parsed.absolute,
    inputSha256: parsed.sha256,
    reportKind: Array.isArray(parsed.data) ? 'game-array' : (parsed.data.kind || 'match-report'),
    gameIndex: selected.index,
    gameCount: selected.total,
    game,
    rawGame: selected.game
  };
}

module.exports = {
  DEFAULT_OPENINGS,
  ENDGAME_POINTS,
  OPENING_DEVELOPMENT_PLIES,
  UCI_MOVE,
  sha256File,
  readJson,
  loadOpenings,
  loadStartSuites,
  resolveStart,
  replayGame,
  selectGame,
  inspectGameFile,
  phaseFor,
  materialPoints,
  fenPositionKey,
  moveList,
  validateFen
};
