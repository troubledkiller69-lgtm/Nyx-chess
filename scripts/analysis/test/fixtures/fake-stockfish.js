#!/usr/bin/env node
'use strict';

// Deterministic fake UCI engine for adapter tests. It is not a chess engine:
// it only emits protocol-shaped lines so handshake, score parsing, bounds,
// mate scores, cancellation and timeout handling can be tested without
// depending on a real Stockfish binary.

const readline = require('node:readline');

const MODE = process.env.FAKE_MODE || 'normal';
const DELAY = Number(process.env.FAKE_DELAY_MS) || 0;
const WHITE_SCORE = process.env.FAKE_WHITE_SCORE !== undefined ? Number(process.env.FAKE_WHITE_SCORE) : 100;
const BLACK_SCORE = process.env.FAKE_BLACK_SCORE !== undefined ? Number(process.env.FAKE_BLACK_SCORE) : -100;
const DEFAULT_BEST = process.env.FAKE_BESTMOVE || 'e2e4';

let positionSide = 'w';

function send(line) {
  process.stdout.write(`${line}\n`);
}

function sideFromPosition(line) {
  if (line.startsWith('position startpos')) {
    const match = /\bmoves\s+(.*)$/.exec(line);
    const moves = match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
    return moves.length % 2 === 0 ? 'w' : 'b';
  }
  const match = /^position fen\s+(.+)$/.exec(line);
  if (match) {
    const fields = match[1].trim().split(/\s+/);
    let side = fields[1] === 'b' ? 'b' : 'w';
    const movesIndex = fields.indexOf('moves');
    if (movesIndex >= 0) {
      const count = fields.slice(movesIndex + 1).filter(Boolean).length;
      if (count % 2 === 1) side = side === 'w' ? 'b' : 'w';
    }
    return side;
  }
  return 'w';
}

function scoreFor(side, depth) {
  if (MODE === 'mate') return `mate ${Math.max(1, 3 - depth)}`;
  if (MODE === 'mate-negative') return `mate -${Math.max(1, 3 - depth)}`;
  if (MODE === 'bound') return 'cp 10 lowerbound';
  if (MODE === 'no-score') return null;
  const base = side === 'w' ? WHITE_SCORE : BLACK_SCORE;
  return `cp ${base + depth}`;
}

function handleGo(tokens) {
  const depthIndex = tokens.indexOf('depth');
  const requestedDepth = depthIndex >= 0 ? Number(tokens[depthIndex + 1]) || 1 : 3;
  const searchIndex = tokens.indexOf('searchmoves');
  let bestmove = DEFAULT_BEST;
  if (searchIndex >= 0) bestmove = tokens[searchIndex + 1] || DEFAULT_BEST;

  const emit = () => {
    if (MODE === 'crash') {
      send('info string fake engine crashing');
      process.exit(3);
      return;
    }
    const maxDepth = MODE === 'early' ? Math.min(2, requestedDepth) : requestedDepth;
    for (let depth = 1; depth <= maxDepth; depth++) {
      const score = scoreFor(positionSide, depth);
      const scorePart = score ? ` score ${score}` : '';
      send(`info depth ${depth} seldepth ${depth + 2} multipv 1${scorePart} ` +
        `nodes ${depth * 1000} nps 100000 hashfull 1 tbhits 0 time ${depth * 10} ` +
        `pv ${bestmove} e7e5 g1f3`);
    }
    if (MODE === 'none') send('bestmove (none)');
    else send(`bestmove ${bestmove} ponder e7e5`);
  };

  if (DELAY > 0) setTimeout(emit, DELAY);
  else emit();
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (line === 'uci') {
    send('id name FakeFish 1.0');
    send('id author Nyx adapter tests');
    send('option name Threads type spin default 1 min 1 max 128');
    send('option name Hash type spin default 16 min 1 max 33554432');
    send('option name MultiPV type spin default 1 min 1 max 500');
    send('option name Clear Hash type button');
    send('uciok');
  } else if (line === 'isready') {
    send('readyok');
  } else if (line === 'ucinewgame') {
    // no state to reset
  } else if (line.startsWith('setoption')) {
    // accepted silently, as UCI engines do
  } else if (line.startsWith('position')) {
    positionSide = sideFromPosition(line);
  } else if (line.startsWith('go')) {
    handleGo(line.split(/\s+/));
  } else if (line === 'stop') {
    // A real engine would return a bestmove. Timeout tests intentionally want
    // the adapter to handle a silent engine, so do not emit here.
  } else if (line === 'quit') {
    process.exit(0);
  }
});
