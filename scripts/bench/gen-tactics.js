// Generate verified tactical positions.
//
// Every mate position written here is proven by exhaustive search: the solver
// checks that the side to move can force mate against every legal defence.
// Nothing is included because an engine "liked" the move.
//
// The search is memoised on (position hash, remaining moves) so transpositions
// are not re-explored, and candidates are restricted to positions where the
// defending king is on an edge, which is where forced mates actually live.
//
// Run once, review the output, then treat tactics.json as frozen input.

const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/engine.js');

const WHITE = 1, BLACK = 2;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

function isMate(pos) {
  return pos.inCheck(pos.side) && pos.legalMoves().length === 0;
}

function createSolver() {
  const memo = new Map();
  let nodes = 0;

  function canForceMate(pos, n) {
    if (n <= 0) return false;
    const key = `${pos.hashA}:${pos.hashB}:${n}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    nodes++;

    let result = false;
    const moves = pos.legalMoves();
    for (const move of moves) {
      pos.make(move);
      let wins;
      if (isMate(pos)) {
        wins = true;
      } else {
        const replies = pos.legalMoves();
        if (!replies.length) {
          wins = false; // stalemate is not a win
        } else {
          wins = true;
          for (const reply of replies) {
            pos.make(reply);
            const forced = canForceMate(pos, n - 1);
            pos.unmake();
            if (!forced) { wins = false; break; }
          }
        }
      }
      pos.unmake();
      if (wins) { result = true; break; }
    }
    memo.set(key, result);
    return result;
  }

  return {
    mateDistance(pos, maxN) {
      for (let n = 1; n <= maxN; n++) if (canForceMate(pos, n)) return n;
      return 0;
    },
    get nodes() { return nodes; },
    reset() { memo.clear(); nodes = 0; }
  };
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = { Q: QUEEN, R: ROOK, B: BISHOP, N: KNIGHT, P: PAWN };
const MATERIAL_SETS = [
  ['Q'], ['R'], ['Q', 'R'], ['R', 'R'], ['Q', 'B'], ['Q', 'N'], ['R', 'B'], ['R', 'N']
];

// Edge and corner squares for the defending king.
const EDGE = [];
for (let sq = 0; sq < 64; sq++) {
  const file = sq & 7, rank = sq >> 3;
  if (file === 0 || file === 7 || rank === 0 || rank === 7) EDGE.push(sq);
}

function toFen(board) {
  let out = '';
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board[rank * 8 + file];
      if (!piece) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      const letter = ' pnbrqk'[piece & 7];
      out += piece < 9 ? letter.toUpperCase() : letter;
    }
    if (empty) out += empty;
    if (rank) out += '/';
  }
  return `${out} w - - 0 1`;
}

function randomPosition(random, material) {
  const board = new Array(64).fill(0);
  const whiteKing = Math.floor(random() * 64);
  const blackKing = EDGE[Math.floor(random() * EDGE.length)];
  if (whiteKing === blackKing) return null;
  if (Math.abs((blackKing & 7) - (whiteKing & 7)) <= 1 &&
      Math.abs((blackKing >> 3) - (whiteKing >> 3)) <= 1) return null;
  board[whiteKing] = KING;
  board[blackKing] = 8 + KING;

  for (const letter of material) {
    let square, guard = 0;
    do {
      square = Math.floor(random() * 64);
      guard++;
      if (guard > 200) return null;
    } while (board[square] || (letter === 'P' && ((square >> 3) === 0 || (square >> 3) === 7)));
    board[square] = PIECES[letter];
  }

  let pos;
  try { pos = new C.Position(toFen(board)); } catch { return null; }
  if (!pos.legalMoves().length) return null;
  // White to move cannot have Black already in check.
  if (pos.isSquareAttacked(pos.kingSq[BLACK], WHITE)) return null;
  return pos;
}

function main() {
  const target = Number(process.argv[2] || 80);
  const random = rng(20261101);
  const solver = createSolver();
  const seen = new Set();
  const entries = [];
  const counts = new Map();
  const caps = { 1: 30, 2: 30, 3: 20 };
  let attempts = 0;

  while (entries.length < target && attempts < 200000) {
    attempts++;
    const material = MATERIAL_SETS[Math.floor(random() * MATERIAL_SETS.length)];
    const pos = randomPosition(random, material);
    if (!pos) continue;
    const fen = pos.fen();
    if (seen.has(fen)) continue;
    const distance = solver.mateDistance(pos, 3);
    if (!distance) continue;
    if ((counts.get(distance) || 0) >= caps[distance]) continue;
    seen.add(fen);
    counts.set(distance, (counts.get(distance) || 0) + 1);
    entries.push({
      id: `mate-${distance}-${entries.length + 1}`,
      category: `mate in ${distance}`,
      fen,
      mateIn: distance,
      best: null
    });
  }

  entries.sort((a, b) => a.mateIn - b.mateIn || a.fen.localeCompare(b.fen));
  const out = path.join(__dirname, 'tactics.json');
  fs.writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${entries.length} verified mate positions to ${out}`);
  for (const [distance, count] of [...counts.entries()].sort()) {
    console.log(`  mate in ${distance}: ${count}`);
  }
  console.log(`Attempts: ${attempts}, solver nodes: ${solver.nodes.toLocaleString()}`);
}

main();
