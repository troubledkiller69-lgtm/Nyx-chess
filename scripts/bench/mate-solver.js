// Exhaustive forced-mate solver.
//
// Used to verify tactical positions and to judge whether an engine's chosen
// move actually wins. Memoised on (position hash, remaining moves) so
// transpositions are explored once.

const C = require('../../src/engine.js');

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
    for (const move of pos.legalMoves()) {
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
    mateDistance(pos, maxN = 4) {
      for (let n = 1; n <= maxN; n++) if (canForceMate(pos, n)) return n;
      return 0;
    },
    // True when the move just played forces mate within `n` more moves by the
    // side that moved. Caller passes the position before the move.
    moveWinsIn(pos, move, n) {
      pos.make(move);
      let wins;
      if (isMate(pos)) {
        wins = n >= 1;
      } else {
        const replies = pos.legalMoves();
        wins = replies.length > 0;
        if (wins) {
          for (const reply of replies) {
            pos.make(reply);
            const forced = canForceMate(pos, n - 1);
            pos.unmake();
            if (!forced) { wins = false; break; }
          }
        }
      }
      pos.unmake();
      return wins;
    },
    get nodes() { return nodes; },
    reset() { memo.clear(); nodes = 0; }
  };
}

module.exports = { createSolver, isMate };
