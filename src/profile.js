(function (global) {
  'use strict';
  // Opponent modelling. The controller feeds every observed position into a
  // profiler; the profiler turns the opponent's own moves into a coarse style
  // and strength estimate. Nothing here searches, so it is safe to run on every
  // board update.
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const STYLES = ['balanced', 'aggressive', 'solid', 'tricky'];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const rate = (count, total) => total > 0 ? count / total : 0;
  const pieceType = (piece) => (piece || '').toLowerCase();

  function parseBoard(fen) {
    const board = new Array(64).fill(null);
    let square = 0;
    for (const char of (fen || '').split(' ')[0]) {
      if (char === '/') continue;
      if (char >= '1' && char <= '8') { square += Number(char); continue; }
      board[square++] = char;
    }
    return board;
  }
  function squareIndex(square) {
    return (8 - Number(square[1])) * 8 + (square.charCodeAt(0) - 97);
  }
  function material(fen) {
    const values = { p: 1, n: 3, b: 3.2, r: 5, q: 9 };
    let white = 0, black = 0, pieces = 0;
    for (const piece of parseBoard(fen)) {
      if (!piece) continue;
      const value = values[pieceType(piece)] || 0;
      if (piece === piece.toUpperCase()) white += value; else black += value;
      if (pieceType(piece) !== 'k') pieces++;
    }
    return { white, black, balance: white - black, pieces };
  }
  // The move that produced `after` is recoverable by comparing the two boards:
  // exactly one origin empties and one destination changes. Castling moves two
  // pieces, so it gets its own signature.
  function inferMove(beforeFen, afterFen) {
    const before = parseBoard(beforeFen);
    const after = parseBoard(afterFen);
    const removed = [], added = [];
    for (let i = 0; i < 64; i++) {
      if (before[i] === after[i]) continue;
      if (before[i] && !after[i]) removed.push(i);
      else if (after[i]) added.push(i);
    }
    if (removed.length === 1 && added.length === 1) {
      const beforePiece = before[removed[0]];
      const promotion = pieceType(beforePiece) === 'p' && (added[0] < 8 || added[0] >= 56)
        ? pieceType(after[added[0]]) : undefined;
      return { from: removed[0], to: added[0], piece: beforePiece, captured: before[added[0]] || null, promotion };
    }
    // Castling: king and rook both move on the same rank.
    if (removed.length === 2 && added.length === 2) {
      const king = removed.find((i) => pieceType(before[i]) === 'k');
      if (king != null) {
        const side = before[king] === 'K' ? 'w' : 'b';
        const target = side === 'w' ? (king === 60 ? 62 : 58) : (king === 4 ? 6 : 2);
        return { from: king, to: target, piece: before[king], castle: side };
      }
    }
    return null;
  }
  function isCheck(fen) {
    // A check is visible in the side-to-move king's attack status; the engine
    // exposes that through Position when available. Illegal/odd FENs fall back
    // to false instead of throwing into the controller.
    try {
      const Position = global.NyxChess?.Position;
      if (!Position) return false;
      const position = new Position(fen);
      return position.inCheck(position.side);
    } catch { return false; }
  }

  function create(seed = {}) {
    const seen = new Set();
    let side = seed.ourSide || null;
    let opponent = seed.opponent || '';
    let moves = 0, captures = 0, checks = 0, earlyQueen = 0, pawnPushes = 0;
    let castles = 0, trades = 0, quiet = 0, longMoves = 0, promotions = 0;
    let openingPlies = 0, aggression = 0, caution = 0;
    let lastFen = START;
    let history = [];

    function reset(nextSide = side) {
      side = nextSide || side;
      moves = captures = checks = earlyQueen = pawnPushes = 0;
      castles = trades = quiet = longMoves = promotions = 0;
      openingPlies = aggression = caution = 0;
      lastFen = START;
      history = [];
      seen.clear();
    }
    // `observe` is called with the full FEN list, so it is idempotent: only
    // positions after the last processed one are inspected.
    function observe(historyFens, ourSide) {
      if (Array.isArray(historyFens) && historyFens.length) {
        if (ourSide && ourSide !== side) reset(ourSide);
        const start = history.findIndex((fen, index) => historyFens[index] !== fen);
        const from = start === -1 ? Math.max(0, history.length - 1) : start;
        for (let i = Math.max(1, from); i < historyFens.length; i++) {
          const before = historyFens[i - 1], after = historyFens[i];
          if (!before || !after) continue;
          history.push(after);
          const key = before + '>' + after;
          if (seen.has(key)) continue;
          seen.add(key);
          // Move number is encoded in the FEN that follows the move.
          const fullmove = Number((after.split(' ')[5]) || 1);
          const mover = before.split(' ')[1];
          if (side && mover === side) { lastFen = after; continue; }
          const move = inferMove(before, after);
          if (!move) { lastFen = after; continue; }
          moves++;
          const type = pieceType(move.piece);
          if (move.captured) captures++;
          if (move.castle) castles++;
          if (isCheck(after)) checks++;
          if (type === 'p') {
            const rank = 8 - Math.floor(move.to / 8);
            if ((mover === 'w' && rank >= 4) || (mover === 'b' && rank <= 5)) pawnPushes++;
            if ((mover === 'w' && rank === 8) || (mover === 'b' && rank === 1)) promotions++;
          }
          if (type === 'q' && fullmove <= 8) earlyQueen++;
          if (!move.captured && type !== 'p') quiet++;
          const distance = Math.max(Math.abs((move.to & 7) - (move.from & 7)),
            Math.abs((move.to >> 3) - (move.from >> 3)));
          if (distance >= 4 && type !== 'p') longMoves++;
          // A capture that immediately gets recaptured reads as a trade, not a
          // sacrifice. The next FEN is the opponent's reply, so look ahead one.
          if (move.captured && historyFens[i + 1]) {
            const reply = inferMove(after, historyFens[i + 1]);
            if (reply?.captured && reply.to === move.to) trades++;
          }
          if (fullmove <= 12) openingPlies++;
          aggression += (move.captured ? 1.4 : 0) + (isCheck(after) ? 1.2 : 0) +
            (type === 'q' && fullmove <= 10 ? 0.8 : 0) + (type === 'p' && fullmove <= 10 ? 0.25 : 0);
          caution += (move.castle ? 1.1 : 0) + (type === 'n' || type === 'b' ? 0.18 : 0);
          lastFen = after;
        }
        return profile();
      }
      return profile();
    }
    function profile() {
      const total = Math.max(1, moves);
      const captureRate = rate(captures, total);
      const checkRate = rate(checks, total);
      const pawnRate = rate(pawnPushes, total);
      const castleRate = rate(castles, Math.max(1, moves));
      const tradeRate = rate(trades, Math.max(1, captures));
      const aggro = aggression / total;
      const calm = caution / total;
      let style = 'balanced';
      if (moves >= 6) {
        if (aggro > 0.85 || checkRate > 0.16 || earlyQueen >= 2) style = 'aggressive';
        else if (tradeRate > 0.55 && castleRate > 0.02 && pawnRate < 0.2) style = 'solid';
        else if (longMoves / total > 0.2 || pawnRate > 0.34) style = 'tricky';
      }
      const materialLeft = material(lastFen);
      const endgame = materialLeft.pieces <= 12;
      // A crude strength signal: very high capture and check rates coupled with
      // few quiet developing moves usually means a sharp, lower-rated player;
      // steady castling plus trades reads as a solid club player.
      const strength = clamp(0.25 + castleRate * 0.9 + tradeRate * 0.35 - checkRate * 0.6 -
        earlyQueen * 0.05 + Math.min(0.25, total * 0.004), 0, 1);
      return {
        style, strength, moves, captureRate, checkRate, pawnRate, castleRate,
        tradeRate, aggro, calm, endgame, materialBalance: materialLeft.balance,
        openingPlies, promotions, opponent
      };
    }
    // Turn the read into concrete call-time adjustments. These are multipliers
    // and preferences, never hard overrides of the user's own settings.
    function adapt(base = {}) {
      const current = profile();
      const rating = base.elo === 'max' ? 1 : clamp((Number(base.elo) || 1600) / 2200, 0, 1);
      const result = { ...base, profile: current };
      result.style = base.style || 'balanced';
      if (current.moves >= 8) {
        if (current.style === 'aggressive') {
          // Against a lunger, decline complications, trade into a clean edge.
          result.style = 'positional';
          result.variety = Math.min(Number(base.variety) || 0, 12);
        } else if (current.style === 'solid') {
          // Against a trader, create imbalance before the endgame arrives.
          result.style = 'tactical';
          result.variety = Math.min(100, (Number(base.variety) || 0) + 8);
        } else if (current.style === 'tricky') {
          result.style = 'positional';
        }
      }
      // If the opponent is clearly weaker, spend a little less clock and let the
      // engine's own error layer carry the game. Against a stronger-looking
      // opponent, spend the full budget.
      const strength = current.strength;
      result.timeScale = strength > 0.62 ? 1 : strength < 0.38 ? 0.82 : 0.92;
      // A passive opponent is safe to pressure; an aggressive one gets a
      // slightly larger blunder budget returned rather than spent.
      const aggression = clamp(current.aggro / 1.2, 0, 1);
      result.errorScale = current.style === 'aggressive' ? 0.85 : aggression > 0.7 ? 0.9 : 1;
      result.rating = rating;
      return result;
    }
    return {
      observe, profile, adapt, reset,
      get opponent() { return opponent; },
      set opponent(value) { opponent = String(value || '').slice(0, 40); },
      get side() { return side; },
      get moves() { return moves; }
    };
  }

  // A rolling, cross-game store keyed by opponent name. It is deliberately
  // tiny: only counters and a handful of opening signatures per opponent.
  function createMemory(storage) {
    const MAX = 24;
    let data = { v: 1, opponents: {} };
    let dirty = false;
    async function load() {
      try {
        const raw = await storage?.get?.();
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (parsed && parsed.v === 1 && parsed.opponents && typeof parsed.opponents === 'object') {
          data = parsed;
        }
      } catch { /* corrupt or unavailable storage starts empty */ }
      return data;
    }
    function note(name, profile, result) {
      const key = String(name || '').slice(0, 40);
      if (!key) return;
      const entry = data.opponents[key] || { games: 0, wins: 0, losses: 0, draws: 0,
        style: 'balanced', moves: 0, last: 0 };
      entry.games++;
      entry.moves += profile?.moves || 0;
      entry.style = profile?.style || entry.style;
      if (result === 'win') entry.wins++;
      else if (result === 'loss') entry.losses++;
      else if (result === 'draw') entry.draws++;
      entry.last = Date.now();
      data.opponents[key] = entry;
      const keys = Object.keys(data.opponents);
      if (keys.length > MAX) {
        keys.sort((a, b) => (data.opponents[a].last || 0) - (data.opponents[b].last || 0));
        for (const old of keys.slice(0, keys.length - MAX)) delete data.opponents[old];
      }
      dirty = true;
    }
    async function save() {
      if (!dirty) return;
      dirty = false;
      try { await storage?.set?.(data); } catch { /* storage is best effort */ }
    }
    function get(name) {
      return data.opponents[String(name || '').slice(0, 40)] || null;
    }
    return { load, note, save, get, get data() { return data; } };
  }

  global.NyxProfile = { create, createMemory, inferMove, material, STYLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NyxProfile;
})(typeof globalThis !== 'undefined' ? globalThis : this);
