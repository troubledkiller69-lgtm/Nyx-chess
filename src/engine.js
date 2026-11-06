/* NyxChess engine — self-contained movegen + alpha-beta search.
   Works in a content script and in Node (for perft tests). */
(function (global) {
  'use strict';

  const WHITE = 1, BLACK = 2;
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const MATE = 100000;

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // white = 1..6, black = 9..14
  const CHAR_TO_PIECE = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6, p: 9, n: 10, b: 11, r: 12, q: 13, k: 14 };
  const PIECE_TO_CHAR = ['', 'P', 'N', 'B', 'R', 'Q', 'K', '', '', 'p', 'n', 'b', 'r', 'q', 'k'];
  const FILES = 'abcdefgh';

  const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING_D = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
  const BISHOP_D = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  const ROOK_D = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const QUEEN_D = BISHOP_D.concat(ROOK_D);

  // Original tapered material weights, paired with geometric square bonuses.
  const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
  const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];
  const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];

  // Tapered piece-square tables. PeSTO's tables (Ronald Friederich) are written
  // top-down (index 0 = a8) and already include material. The search below is
  // still entirely ours; these are just the static weights.
  // (Restored from 0.6.5 baseline to recover lost positional strength.)
  const MG_PAWN = [
    0, 0, 0, 0, 0, 0, 0, 0,
    98, 134, 61, 95, 68, 126, 34, -11,
    -6, 7, 26, 31, 65, 56, 25, -20,
    -14, 13, 6, 21, 23, 12, 17, -23,
    -27, -2, -5, 12, 17, 6, 10, -25,
    -26, -4, -4, -10, 3, 3, 33, -12,
    -35, -1, -20, -23, -15, 24, 38, -22,
    0, 0, 0, 0, 0, 0, 0, 0
  ];
  const EG_PAWN = [
    0, 0, 0, 0, 0, 0, 0, 0,
    178, 173, 158, 134, 147, 132, 165, 187,
    94, 100, 85, 67, 56, 53, 82, 84,
    32, 24, 13, 5, -2, 4, 17, 17,
    13, 9, -3, -7, -7, -8, 3, -1,
    4, 7, -6, 1, 0, -5, -1, -8,
    13, 8, 8, 10, 13, 0, 2, -7,
    0, 0, 0, 0, 0, 0, 0, 0
  ];
  const MG_KNIGHT = [
    -167, -89, -34, -49, 61, -97, -15, -107,
    -73, -41, 72, 36, 23, 62, 7, -17,
    -47, 60, 37, 65, 84, 129, 73, 44,
    -9, 17, 19, 53, 37, 69, 18, 22,
    -13, 4, 16, 13, 28, 19, 21, -8,
    -23, -9, 12, 10, 19, 17, 25, -16,
    -29, -53, -12, -3, -1, 18, -14, -19,
    -105, -21, -58, -33, -17, -28, -19, -23
  ];
  const EG_KNIGHT = [
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25, -8, -25, -2, -9, -25, -24, -52,
    -24, -20, 10, 9, -1, -9, -19, -41,
    -17, 3, 22, 22, 22, 11, 8, -18,
    -18, -6, 16, 25, 16, 17, 4, -18,
    -23, -3, -1, 15, 10, -3, -20, -22,
    -42, -20, -10, -5, -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64
  ];
  const MG_BISHOP = [
    -29, 4, -82, -37, -25, -42, 7, -8,
    -26, 16, -18, -13, 30, 59, 18, -47,
    -16, 37, 43, 40, 35, 50, 37, -2,
    -4, 5, 19, 50, 37, 37, 7, -2,
    -6, 13, 13, 26, 34, 12, 10, 4,
    0, 15, 15, 15, 14, 27, 18, 10,
    4, 15, 16, 0, 7, 21, 33, 1,
    -33, -3, -14, -21, -13, -12, -39, -21
  ];
  const EG_BISHOP = [
    -14, -21, -11, -8, -7, -9, -17, -24,
    -8, -4, 7, -12, -3, -13, -4, -14,
    2, -8, 0, -1, -2, 6, 0, 4,
    -3, 9, 12, 9, 14, 10, 3, 2,
    -6, 3, 13, 19, 7, 10, -3, -9,
    -12, -3, 8, 10, 13, 3, -7, -15,
    -14, -18, -7, -1, 4, -9, -15, -27,
    -23, -9, -23, -5, -9, -16, -5, -17
  ];
  const MG_ROOK = [
    32, 42, 32, 51, 63, 9, 31, 43,
    27, 32, 58, 62, 80, 67, 26, 44,
    -5, 19, 26, 36, 17, 45, 61, 16,
    -24, -11, 7, 26, 24, 35, -8, -20,
    -36, -26, -12, -1, 9, -7, 6, -23,
    -45, -25, -16, -17, 3, 0, -5, -33,
    -44, -16, -20, -9, -1, 11, -6, -71,
    -19, -13, 1, 17, 16, 7, -37, -26
  ];
  const EG_ROOK = [
    13, 10, 18, 15, 12, 12, 8, 5,
    11, 13, 13, 11, -3, 3, 8, 3,
    7, 7, 7, 5, 4, -3, -5, -3,
    4, 3, 13, 1, 2, 1, -1, 2,
    3, 5, 8, 4, -5, -6, -8, -11,
    -4, 0, -5, -1, -7, -12, -8, -16,
    -6, -6, 0, 2, -9, -9, -11, -3,
    -9, 2, 3, -1, -5, -13, 4, -20
  ];
  const MG_QUEEN = [
    -28, 0, 29, 12, 59, 44, 43, 45,
    -24, -39, -5, 1, -16, 57, 28, 54,
    -13, -17, 7, 8, 29, 56, 47, 57,
    -27, -27, -16, -16, -1, 17, -2, 1,
    -9, -26, -9, -10, -2, -4, 3, -3,
    -14, 2, -11, -2, -5, 2, 14, 5,
    -35, -8, 11, 2, 8, 15, -3, 1,
    -1, -18, -9, 10, -15, -25, -31, -50
  ];
  const EG_QUEEN = [
    -9, 22, 22, 27, 27, 19, 10, 20,
    -17, 20, 32, 41, 58, 25, 30, 0,
    -20, 6, 9, 49, 47, 35, 19, 9,
    3, 22, 24, 45, 57, 40, 57, 36,
    -18, 28, 19, 47, 31, 34, 39, 23,
    -16, -27, 15, 6, 9, 17, 10, 5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43, -5, -32, -20, -41
  ];
  const MG_KING = [
    -65, 23, 16, -15, -56, -34, 2, 13,
    29, -1, -20, -7, -8, -4, -38, -29,
    -9, 24, 2, -16, -20, 6, 22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49, -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
    1, 7, -8, -64, -43, -16, 9, 8,
    -15, 36, 12, -54, 8, -28, 24, 14
  ];
  const EG_KING = [
    -74, -35, -18, -18, -11, 15, 4, -17,
    -12, 17, 14, 17, 17, 38, 23, 11,
    10, 17, 23, 15, 20, 45, 44, 13,
    -8, 22, 24, 27, 26, 33, 26, 3,
    -18, -4, 21, 24, 27, 23, 9, -11,
    -19, -3, 11, 21, 23, 16, 7, -9,
    -27, -11, 4, 13, 14, 4, -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43
  ];
  const MG_TABLES = [null, MG_PAWN, MG_KNIGHT, MG_BISHOP, MG_ROOK, MG_QUEEN, MG_KING];
  const EG_TABLES = [null, EG_PAWN, EG_KNIGHT, EG_BISHOP, EG_ROOK, EG_QUEEN, EG_KING];


  const VALUE = [0, 100, 320, 330, 500, 900, 20000];

  // Late-move reduction table: 0.75 + ln(depth)*ln(move) / 2.25, the usual
  // logarithmic shape. Precomputed because this sits in the hottest loop.
  const LMR_TABLE = new Uint8Array(17 * 64);
  for (let d = 1; d <= 16; d++) {
    for (let m = 1; m < 64; m++) {
      LMR_TABLE[d * 64 + m] = Math.min(4, Math.max(0, Math.floor(0.75 + Math.log(d) * Math.log(m) / 2.25)));
    }
  }

  // ------------------------------------------------------------- zobrist hash
  // Deterministic keys keep tests reproducible. Two 32-bit halves let the
  // transposition table verify a hit without storing huge Numbers.
  let zSeed = 0x9e3779b9 | 0;
  function zRandom() {
    zSeed ^= zSeed << 13;
    zSeed ^= zSeed >>> 17;
    zSeed ^= zSeed << 5;
    return zSeed | 0;
  }
  const Z_PIECE_A = new Int32Array(12 * 64);
  const Z_PIECE_B = new Int32Array(12 * 64);
  for (let i = 0; i < 12 * 64; i++) { Z_PIECE_A[i] = zRandom(); Z_PIECE_B[i] = zRandom(); }
  const Z_CASTLE_A = new Int32Array(16);
  const Z_CASTLE_B = new Int32Array(16);
  for (let i = 0; i < 16; i++) { Z_CASTLE_A[i] = zRandom(); Z_CASTLE_B[i] = zRandom(); }
  const Z_EP_A = new Int32Array(8);
  const Z_EP_B = new Int32Array(8);
  for (let i = 0; i < 8; i++) { Z_EP_A[i] = zRandom(); Z_EP_B[i] = zRandom(); }
  const Z_SIDE_A = zRandom();
  const Z_SIDE_B = zRandom();

  function pieceIndex(piece) {
    return piece < 9 ? piece - 1 : piece - 9 + 6;
  }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function inBounds(f, r) {
    return f >= 0 && f < 8 && r >= 0 && r < 8;
  }

  function squareName(sq) {
    return FILES[sq & 7] + ((sq >> 3) + 1);
  }

  function squareIndex(name) {
    const f = FILES.indexOf(name[0]);
    const r = parseInt(name[1], 10) - 1;
    if (f < 0 || r < 0 || r > 7) return -1;
    return r * 8 + f;
  }

  // ---------------------------------------------------------------- position
  class Position {
    constructor(fen) {
      this.board = new Int8Array(64);
      this.side = WHITE;
      this.castling = 0;
      this.ep = -1;
      this.half = 0;
      this.full = 1;
      this.kingSq = [0, 0, 0];
      this.undoStack = [];
      this.hashA = 0;
      this.hashB = 0;
      // Incremental tapered material/PSQT totals (white perspective). The
      // full-board scan in evaluate was the most expensive part of the leaf
      // path; make/unmake now maintain these instead.
      this.mg = 0;
      this.eg = 0;
      this.phase = 0;
      this.bishopW = 0;
      this.bishopB = 0;
      this.load(fen || START_FEN);
    }

    load(fen) {
      const parts = String(fen).trim().split(/\s+/);
      const ranks = parts[0].split('/');
      if (parts.length !== 6 || ranks.length !== 8 || !/^[wb]$/.test(parts[1]) ||
          !/^(?:-|K?Q?k?q?)$/.test(parts[2]) || !/^(?:-|[a-h][36])$/.test(parts[3]) ||
          !/^\d+$/.test(parts[4]) || !/^[1-9]\d*$/.test(parts[5]) ||
          ranks.some((rank) => !/^[pnbrqkPNBRQK1-8]+$/.test(rank) ||
            [...rank].reduce((sum, ch) => sum + (/\d/.test(ch) ? Number(ch) : 1), 0) !== 8) ||
          (parts[0].match(/K/g) || []).length !== 1 || (parts[0].match(/k/g) || []).length !== 1 ||
          /[pP]/.test(ranks[0] + ranks[7])) throw new Error('Invalid chess position (FEN).');
      this.board.fill(0);
      this.kingSq[WHITE] = -1;
      this.kingSq[BLACK] = -1;
      let sq = 56;
      for (const ch of parts[0]) {
        if (ch === '/') {
          sq -= 16;
          continue;
        }
        if (ch >= '1' && ch <= '8') {
          sq += Number(ch);
          continue;
        }
        const piece = CHAR_TO_PIECE[ch];
        this.board[sq] = piece;
        if (piece === 6) this.kingSq[WHITE] = sq;
        else if (piece === 14) this.kingSq[BLACK] = sq;
        sq++;
      }
      this.side = parts[1] === 'b' ? BLACK : WHITE;
      this.castling = 0;
      if (parts[2] && parts[2] !== '-') {
        if (parts[2].includes('K')) this.castling |= 1;
        if (parts[2].includes('Q')) this.castling |= 2;
        if (parts[2].includes('k')) this.castling |= 4;
        if (parts[2].includes('q')) this.castling |= 8;
      }
      this.ep = parts[3] && parts[3] !== '-' ? squareIndex(parts[3]) : -1;
      this.half = parts[4] ? Number(parts[4]) : 0;
      this.full = parts[5] ? Number(parts[5]) : 1;
      this.undoStack.length = 0;
      this.computeHash();
      this.computeEval();
      return this;
    }

    computeEval() {
      let mg = 0, eg = 0, phase = 0, bishopW = 0, bishopB = 0;
      for (let sq = 0; sq < 64; sq++) {
        const v = this.board[sq];
        if (!v) continue;
        const t = v & 7;
        if (v < 9) {
          mg += MG_W[t][sq];
          eg += EG_W[t][sq];
          if (t === BISHOP) bishopW++;
        } else {
          mg -= MG_B[t][sq];
          eg -= EG_B[t][sq];
          if (t === BISHOP) bishopB++;
        }
        phase += PHASE_INC[t];
      }
      this.mg = mg;
      this.eg = eg;
      this.phase = phase;
      this.bishopW = bishopW;
      this.bishopB = bishopB;
    }

    // An en passant target only changes the legal position when a pawn of the
    // side to move can actually capture on it. Hashing the irrelevant ones
    // would make identical positions look different.
    epCapturable() {
      if (this.ep < 0) return false;
      const file = this.ep & 7;
      const rank = this.ep >> 3;
      const fromRank = this.side === WHITE ? rank - 1 : rank + 1;
      if (fromRank < 0 || fromRank > 7) return false;
      const pawn = this.side === WHITE ? PAWN : PAWN + 8;
      const b = this.board;
      return (file > 0 && b[fromRank * 8 + file - 1] === pawn) ||
        (file < 7 && b[fromRank * 8 + file + 1] === pawn);
    }

    computeHash() {
      let a = 0, b = 0;
      for (let sq = 0; sq < 64; sq++) {
        const piece = this.board[sq];
        if (!piece) continue;
        a ^= Z_PIECE_A[pieceIndex(piece) * 64 + sq];
        b ^= Z_PIECE_B[pieceIndex(piece) * 64 + sq];
      }
      a ^= Z_CASTLE_A[this.castling];
      b ^= Z_CASTLE_B[this.castling];
      if (this.epCapturable()) {
        a ^= Z_EP_A[this.ep & 7];
        b ^= Z_EP_B[this.ep & 7];
      }
      if (this.side === BLACK) { a ^= Z_SIDE_A; b ^= Z_SIDE_B; }
      this.hashA = a;
      this.hashB = b;
      return this;
    }

    fen() {
      let out = '';
      for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const v = this.board[r * 8 + f];
          if (!v) {
            empty++;
            continue;
          }
          if (empty) {
            out += empty;
            empty = 0;
          }
          out += PIECE_TO_CHAR[v];
        }
        if (empty) out += empty;
        if (r) out += '/';
      }
      let cast = '';
      if (this.castling & 1) cast += 'K';
      if (this.castling & 2) cast += 'Q';
      if (this.castling & 4) cast += 'k';
      if (this.castling & 8) cast += 'q';
      return (
        out + ' ' + (this.side === WHITE ? 'w' : 'b') + ' ' + (cast || '-') + ' ' +
        (this.ep >= 0 ? squareName(this.ep) : '-') + ' ' + this.half + ' ' + this.full
      );
    }

    clone() {
      const p = Object.create(Position.prototype);
      p.board = this.board.slice();
      p.side = this.side;
      p.castling = this.castling;
      p.ep = this.ep;
      p.half = this.half;
      p.full = this.full;
      p.kingSq = this.kingSq.slice();
      p.undoStack = this.undoStack.slice();
      p.hashA = this.hashA;
      p.hashB = this.hashB;
      p.mg = this.mg;
      p.eg = this.eg;
      p.phase = this.phase;
      p.bishopW = this.bishopW;
      p.bishopB = this.bishopB;
      return p;
    }

    isSquareAttacked(sq, by) {
      const b = this.board;
      const f = sq & 7, r = sq >> 3;
      const off = by === BLACK ? 8 : 0;

      // pawns
      if (by === WHITE) {
        if (f > 0 && r > 0 && b[sq - 9] === 1) return true;
        if (f < 7 && r > 0 && b[sq - 7] === 1) return true;
      } else {
        if (f > 0 && r < 7 && b[sq + 7] === 9) return true;
        if (f < 7 && r < 7 && b[sq + 9] === 9) return true;
      }

      // knights
      for (let i = 0; i < 8; i++) {
        const nf = f + KNIGHT_D[i][0], nr = r + KNIGHT_D[i][1];
        if (inBounds(nf, nr) && b[nr * 8 + nf] === KNIGHT + off) return true;
      }

      // king
      for (let i = 0; i < 8; i++) {
        const kf = f + KING_D[i][0], kr = r + KING_D[i][1];
        if (inBounds(kf, kr) && b[kr * 8 + kf] === KING + off) return true;
      }

      // bishops / queens
      for (let i = 0; i < 4; i++) {
        const df = BISHOP_D[i][0], dr = BISHOP_D[i][1];
        let nf = f + df, nr = r + dr;
        while (inBounds(nf, nr)) {
          const v = b[nr * 8 + nf];
          if (v) {
            if (v === BISHOP + off || v === QUEEN + off) return true;
            break;
          }
          nf += df;
          nr += dr;
        }
      }

      // rooks / queens
      for (let i = 0; i < 4; i++) {
        const df = ROOK_D[i][0], dr = ROOK_D[i][1];
        let nf = f + df, nr = r + dr;
        while (inBounds(nf, nr)) {
          const v = b[nr * 8 + nf];
          if (v) {
            if (v === ROOK + off || v === QUEEN + off) return true;
            break;
          }
          nf += df;
          nr += dr;
        }
      }

      return false;
    }

    inCheck(color) {
      return this.isSquareAttacked(this.kingSq[color], color === WHITE ? BLACK : WHITE);
    }

    // move = from | to<<6 | promo<<12
    make(move) {
      const from = move & 63;
      const to = (move >> 6) & 63;
      const promo = (move >> 12) & 7;
      const b = this.board;
      const piece = b[from];
      const captured = b[to];
      const color = piece > 8 ? BLACK : WHITE;
      const type = piece & 7;

      const undo = {
        move,
        captured,
        castling: this.castling,
        ep: this.ep,
        half: this.half,
        full: this.full,
        hashA: this.hashA,
        hashB: this.hashB,
        mg: this.mg,
        eg: this.eg,
        phase: this.phase,
        bishopW: this.bishopW,
        bishopB: this.bishopB,
        epCaptureSq: -1
      };
      this.undoStack.push(undo);
      removePieceValue(this, piece, from);
      if (captured) removePieceValue(this, captured, to);

      let ha = this.hashA, hb = this.hashB;
      const oldEp = this.epCapturable() ? (this.ep & 7) : -1;
      ha ^= Z_CASTLE_A[this.castling]; hb ^= Z_CASTLE_B[this.castling];
      if (oldEp >= 0) { ha ^= Z_EP_A[oldEp]; hb ^= Z_EP_B[oldEp]; }
      // Side to move always flips once per move.
      ha ^= Z_SIDE_A; hb ^= Z_SIDE_B;
      ha ^= Z_PIECE_A[pieceIndex(piece) * 64 + from]; hb ^= Z_PIECE_B[pieceIndex(piece) * 64 + from];
      if (captured) {
        ha ^= Z_PIECE_A[pieceIndex(captured) * 64 + to]; hb ^= Z_PIECE_B[pieceIndex(captured) * 64 + to];
      }

      b[to] = piece;
      b[from] = 0;

      if (type === PAWN) {
        this.half = 0;
        // en passant capture
        if (to === this.ep && !captured) {
          const capSq = color === WHITE ? to - 8 : to + 8;
          undo.epCaptureSq = capSq;
          undo.captured = b[capSq];
          if (undo.captured) {
            removePieceValue(this, undo.captured, capSq);
            ha ^= Z_PIECE_A[pieceIndex(undo.captured) * 64 + capSq];
            hb ^= Z_PIECE_B[pieceIndex(undo.captured) * 64 + capSq];
          }
          b[capSq] = 0;
        }
        // promotion
        if (promo) b[to] = promo + (color === BLACK ? 8 : 0);
        // double push sets ep square
        this.ep = Math.abs(to - from) === 16 ? (from + to) >> 1 : -1;
      } else {
        this.ep = -1;
        if (type === KING) {
          this.kingSq[color] = to;
          // castling: move the rook
          if (Math.abs(to - from) === 2) {
            if (to > from) {
              b[to - 1] = b[to + 1];
              b[to + 1] = 0;
            } else {
              b[to + 1] = b[to - 2];
              b[to - 2] = 0;
            }
          }
        }
        if (captured) this.half = 0;
        else this.half++;
      }
      if (captured && type !== PAWN) this.half = 0;

      // The piece that ends up on the target square may be a promotion, and a
      // castling move also relocates the rook. Keep the tapered totals in
      // lockstep with the board so evaluate() never has to scan it.
      addPieceValue(this, b[to], to);
      if (type === KING && Math.abs(to - from) === 2) {
        const rook = ROOK + (color === BLACK ? 8 : 0);
        if (to > from) {
          removePieceValue(this, rook, to + 1);
          addPieceValue(this, rook, to - 1);
        } else {
          removePieceValue(this, rook, to - 2);
          addPieceValue(this, rook, to + 1);
        }
      }

      // castling rights
      if (piece === KING) this.castling &= ~3;
      else if (piece === 14) this.castling &= ~12;
      if (piece === ROOK) {
        if (from === 0) this.castling &= ~2;
        else if (from === 7) this.castling &= ~1;
      } else if (piece === 12) {
        if (from === 56) this.castling &= ~8;
        else if (from === 63) this.castling &= ~4;
      }
      if (captured === ROOK) {
        if (to === 0) this.castling &= ~2;
        else if (to === 7) this.castling &= ~1;
      } else if (captured === 12) {
        if (to === 56) this.castling &= ~8;
        else if (to === 63) this.castling &= ~4;
      }

      this.side = color === WHITE ? BLACK : WHITE;
      if (this.side === WHITE) this.full++;

      ha ^= Z_PIECE_A[pieceIndex(b[to]) * 64 + to];
      hb ^= Z_PIECE_B[pieceIndex(b[to]) * 64 + to];
      if (type === KING && Math.abs(to - from) === 2) {
        const rook = ROOK + (color === BLACK ? 8 : 0);
        const rookFrom = to > from ? to + 1 : to - 2;
        const rookTo = to > from ? to - 1 : to + 1;
        ha ^= Z_PIECE_A[pieceIndex(rook) * 64 + rookFrom];
        hb ^= Z_PIECE_B[pieceIndex(rook) * 64 + rookFrom];
        ha ^= Z_PIECE_A[pieceIndex(rook) * 64 + rookTo];
        hb ^= Z_PIECE_B[pieceIndex(rook) * 64 + rookTo];
      }
      ha ^= Z_CASTLE_A[this.castling]; hb ^= Z_CASTLE_B[this.castling];
      if (this.epCapturable()) {
        ha ^= Z_EP_A[this.ep & 7]; hb ^= Z_EP_B[this.ep & 7];
      }
      this.hashA = ha;
      this.hashB = hb;
    }

    unmake() {
      const undo = this.undoStack.pop();
      if (!undo) return;
      const move = undo.move;
      const from = move & 63;
      const to = (move >> 6) & 63;
      const b = this.board;
      let piece = b[to];
      const promo = (move >> 12) & 7;
      if (promo) piece = piece > 8 ? 9 : 1;

      b[from] = piece;
      b[to] = 0;

      if (undo.epCaptureSq >= 0) {
        b[undo.epCaptureSq] = undo.captured;
      } else {
        b[to] = undo.captured;
      }

      const color = piece > 8 ? BLACK : WHITE;
      const type = piece & 7;
      if (type === KING) {
        this.kingSq[color] = from;
        if (Math.abs(to - from) === 2) {
          if (to > from) {
            b[to + 1] = b[to - 1];
            b[to - 1] = 0;
          } else {
            b[to - 2] = b[to + 1];
            b[to + 1] = 0;
          }
        }
      }

      this.castling = undo.castling;
      this.ep = undo.ep;
      this.half = undo.half;
      this.full = undo.full;
      this.side = color;
      this.hashA = undo.hashA;
      this.hashB = undo.hashB;
      this.mg = undo.mg;
      this.eg = undo.eg;
      this.phase = undo.phase;
      this.bishopW = undo.bishopW;
      this.bishopB = undo.bishopB;
    }

    // Null move: pass the turn without touching the board. Used by the search
    // to prove that a position is bad enough to cut off; the caller restores
    // the returned snapshot immediately after the reduced search.
    makeNull() {
      const undo = {
        side: this.side, ep: this.ep, half: this.half, full: this.full,
        hashA: this.hashA, hashB: this.hashB
      };
      let ha = this.hashA, hb = this.hashB;
      if (this.epCapturable()) {
        ha ^= Z_EP_A[this.ep & 7]; hb ^= Z_EP_B[this.ep & 7];
      }
      ha ^= Z_SIDE_A; hb ^= Z_SIDE_B;
      this.ep = -1;
      this.side = this.side === WHITE ? BLACK : WHITE;
      this.half++;
      if (this.side === WHITE) this.full++;
      this.hashA = ha;
      this.hashB = hb;
      return undo;
    }

    unmakeNull(undo) {
      this.side = undo.side;
      this.ep = undo.ep;
      this.half = undo.half;
      this.full = undo.full;
      this.hashA = undo.hashA;
      this.hashB = undo.hashB;
    }

    generateMoves(out, capturesOnly) {
      const b = this.board;
      const side = this.side;
      let n = 0;

      for (let sq = 0; sq < 64; sq++) {
        const piece = b[sq];
        if (!piece) continue;
        const isWhitePiece = piece < 9;
        if ((side === WHITE) !== isWhitePiece) continue;
        const type = piece & 7;
        const f = sq & 7, r = sq >> 3;

        if (type === PAWN) {
          const dir = side === WHITE ? 8 : -8;
          const startRank = side === WHITE ? 1 : 6;
          const promoRank = side === WHITE ? 6 : 1;
          const one = sq + dir;
          if (!capturesOnly && !b[one]) {
            if (r === promoRank) {
              out[n++] = sq | (one << 6) | (QUEEN << 12);
              out[n++] = sq | (one << 6) | (ROOK << 12);
              out[n++] = sq | (one << 6) | (BISHOP << 12);
              out[n++] = sq | (one << 6) | (KNIGHT << 12);
            } else {
              out[n++] = sq | (one << 6);
              const two = sq + dir * 2;
              if (r === startRank && !b[two]) out[n++] = sq | (two << 6);
            }
          } else if (capturesOnly && r === promoRank && !b[one]) {
            out[n++] = sq | (one << 6) | (QUEEN << 12);
            out[n++] = sq | (one << 6) | (ROOK << 12);
            out[n++] = sq | (one << 6) | (BISHOP << 12);
            out[n++] = sq | (one << 6) | (KNIGHT << 12);
          }
          for (const df of [-1, 1]) {
            const nf = f + df;
            if (nf < 0 || nf > 7) continue;
            const to = sq + dir + df;
            if (to < 0 || to > 63) continue;
            const target = b[to];
            if (target && (target < 9) === !isWhitePiece) {
              if (r === promoRank) {
                out[n++] = sq | (to << 6) | (QUEEN << 12);
                out[n++] = sq | (to << 6) | (ROOK << 12);
                out[n++] = sq | (to << 6) | (BISHOP << 12);
                out[n++] = sq | (to << 6) | (KNIGHT << 12);
              } else {
                out[n++] = sq | (to << 6);
              }
            } else if (to === this.ep) {
              out[n++] = sq | (to << 6);
            }
          }
          continue;
        }

        if (type === KNIGHT) {
          for (let i = 0; i < 8; i++) {
            const nf = f + KNIGHT_D[i][0], nr = r + KNIGHT_D[i][1];
            if (!inBounds(nf, nr)) continue;
            const to = nr * 8 + nf;
            const target = b[to];
            if (target && (target < 9) === !isWhitePiece) {
              out[n++] = sq | (to << 6);
            } else if (!target && !capturesOnly) {
              out[n++] = sq | (to << 6);
            }
          }
          continue;
        }

        if (type === KING) {
          for (let i = 0; i < 8; i++) {
            const nf = f + KING_D[i][0], nr = r + KING_D[i][1];
            if (!inBounds(nf, nr)) continue;
            const to = nr * 8 + nf;
            const target = b[to];
            if (target && (target < 9) === !isWhitePiece) {
              out[n++] = sq | (to << 6);
            } else if (!target && !capturesOnly) {
              out[n++] = sq | (to << 6);
            }
          }
          if (!capturesOnly) {
            // castling
            if (side === WHITE && sq === 4) {
              if ((this.castling & 1) && !b[5] && !b[6] && b[7] === ROOK && !this.isSquareAttacked(4, BLACK) && !this.isSquareAttacked(5, BLACK) && !this.isSquareAttacked(6, BLACK)) {
                out[n++] = 4 | (6 << 6);
              }
              if ((this.castling & 2) && !b[3] && !b[2] && !b[1] && b[0] === ROOK && !this.isSquareAttacked(4, BLACK) && !this.isSquareAttacked(3, BLACK) && !this.isSquareAttacked(2, BLACK)) {
                out[n++] = 4 | (2 << 6);
              }
            } else if (side === BLACK && sq === 60) {
              if ((this.castling & 4) && !b[61] && !b[62] && b[63] === 12 && !this.isSquareAttacked(60, WHITE) && !this.isSquareAttacked(61, WHITE) && !this.isSquareAttacked(62, WHITE)) {
                out[n++] = 60 | (62 << 6);
              }
              if ((this.castling & 8) && !b[59] && !b[58] && !b[57] && b[56] === 12 && !this.isSquareAttacked(60, WHITE) && !this.isSquareAttacked(59, WHITE) && !this.isSquareAttacked(58, WHITE)) {
                out[n++] = 60 | (58 << 6);
              }
            }
          }
          continue;
        }

        const dirs = type === BISHOP ? BISHOP_D : type === ROOK ? ROOK_D : QUEEN_D;
        for (let i = 0; i < dirs.length; i++) {
          const df = dirs[i][0], dr = dirs[i][1];
          let nf = f + df, nr = r + dr;
          while (inBounds(nf, nr)) {
            const to = nr * 8 + nf;
            const target = b[to];
            if (target) {
              if ((target < 9) === !isWhitePiece) out[n++] = sq | (to << 6);
              break;
            }
            if (!capturesOnly) out[n++] = sq | (to << 6);
            nf += df;
            nr += dr;
          }
        }
      }
      return n;
    }

    legalMoves() {
      const buf = new Int32Array(256);
      const n = this.generateMoves(buf, false);
      const legal = [];
      const mover = this.side;
      for (let i = 0; i < n; i++) {
        const mv = buf[i];
        this.make(mv);
        const bad = this.isSquareAttacked(this.kingSq[mover], this.side);
        this.unmake();
        if (!bad) legal.push(mv);
      }
      return legal;
    }

  }

  // ------------------------------------------------------------------ eval
  // Precomputed tapered tables: one lookup per piece, colour included.
  // PeSTO tables (restored from 0.6.5 baseline).
  const MG_W = [null], MG_B = [null], EG_W = [null], EG_B = [null];
  for (let t = 1; t <= 6; t++) {
    MG_W[t] = new Int16Array(64); MG_B[t] = new Int16Array(64);
    EG_W[t] = new Int16Array(64); EG_B[t] = new Int16Array(64);
    for (let sq = 0; sq < 64; sq++) {
      MG_W[t][sq] = MG_VALUE[t] + MG_TABLES[t][sq ^ 56];
      MG_B[t][sq] = MG_VALUE[t] + MG_TABLES[t][sq];
      EG_W[t][sq] = EG_VALUE[t] + EG_TABLES[t][sq ^ 56];
      EG_B[t][sq] = EG_VALUE[t] + EG_TABLES[t][sq];
    }
  }

  // Reused by evaluate to keep the leaf path allocation-free.
  const PAWN_FILES_W = new Uint8Array(8);
  const PAWN_FILES_B = new Uint8Array(8);
  const PAWN_MASK_W = new Uint8Array(8);
  const PAWN_MASK_B = new Uint8Array(8);
  const PASSED_MG = [0, 4, 10, 20, 36, 62, 100, 0];
  const PASSED_EG = [0, 10, 20, 36, 62, 105, 170, 0];
  const EVAL_PAWNS = new Int32Array(32);
  const EVAL_ROOKS = new Int32Array(16);
  const EVAL_KNIGHTS = new Int32Array(16);
  const EVAL_BISHOPS = new Int32Array(8);
  const PAWN_ATTACKS = [null, new Uint8Array(64), new Uint8Array(64)];
  const ATTACKS = [null, new Uint8Array(64), new Uint8Array(64)];
  const PINS = new Int8Array(64);
  const KING_RING = [null, new Uint8Array(64), new Uint8Array(64)];
  const MOBILITY_MG = [0, 0, 4, 4, 2, 1];
  const MOBILITY_EG = [0, 0, 3, 4, 3, 2];
  const ATTACK_WEIGHT = [0, 0, 2, 2, 3, 5];
  const RAYS = Array.from({ length: 64 }, (_, sq) => QUEEN_D.map(([df, dr]) => {
    const ray = [];
    for (let f = (sq & 7) + df, r = (sq >> 3) + dr; inBounds(f, r); f += df, r += dr) ray.push(r * 8 + f);
    return ray;
  }));
  const KNIGHT_TARGETS = Array.from({ length: 64 }, (_, sq) => KNIGHT_D
    .map(([df, dr]) => [(sq & 7) + df, (sq >> 3) + dr])
    .filter(([f, r]) => inBounds(f, r)).map(([f, r]) => r * 8 + f));
  const KING_TARGETS = Array.from({ length: 64 }, (_, sq) => KING_D
    .map(([df, dr]) => [(sq & 7) + df, (sq >> 3) + dr])
    .filter(([f, r]) => inBounds(f, r)).map(([f, r]) => r * 8 + f));

  function kingDistance(a, b) {
    return Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 3) - (b >> 3)));
  }

  // Build pawn control and absolute pins without allocating at search leaves.
  function prepareAttacks(pos) {
    PINS.fill(0);
    for (let side = WHITE; side <= BLACK; side++) {
      PAWN_ATTACKS[side].fill(0); ATTACKS[side].fill(0); KING_RING[side].fill(0);
      const king = pos.kingSq[side];
      for (const target of KING_TARGETS[king]) {
        KING_RING[side][target] = 1; ATTACKS[side][target]++;
      }
      KING_RING[side][king] = 1;
      for (let direction = 0; direction < 8; direction++) {
        let candidate = -1;
        const ray = RAYS[king][direction];
        for (const sq of ray) {
          const piece = pos.board[sq];
          if (!piece) continue;
          if ((piece < 9 ? WHITE : BLACK) === side) {
            if (candidate >= 0) break;
            candidate = sq;
          } else {
            const type = piece & 7;
            if (candidate >= 0 && (type === QUEEN || type === (direction < 4 ? BISHOP : ROOK))) {
              PINS[candidate] = ray[0] - king;
            }
            break;
          }
        }
      }
    }
    for (let sq = 0; sq < 64; sq++) {
      const piece = pos.board[sq];
      if ((piece & 7) !== PAWN) continue;
      const side = piece < 9 ? WHITE : BLACK, r = (sq >> 3) + (side === WHITE ? 1 : -1);
      for (const df of [-1, 1]) {
        const f = (sq & 7) + df;
        if (inBounds(f, r)) { PAWN_ATTACKS[side][r * 8 + f]++; ATTACKS[side][r * 8 + f]++; }
      }
    }
  }

  function addPieceValue(pos, piece, sq) {
    const t = piece & 7;
    if (piece < 9) {
      pos.mg += MG_W[t][sq];
      pos.eg += EG_W[t][sq];
      if (t === BISHOP) pos.bishopW++;
    } else {
      pos.mg -= MG_B[t][sq];
      pos.eg -= EG_B[t][sq];
      if (t === BISHOP) pos.bishopB++;
    }
    pos.phase += PHASE_INC[t];
  }

  function removePieceValue(pos, piece, sq) {
    const t = piece & 7;
    if (piece < 9) {
      pos.mg -= MG_W[t][sq];
      pos.eg -= EG_W[t][sq];
      if (t === BISHOP) pos.bishopW--;
    } else {
      pos.mg += MG_B[t][sq];
      pos.eg += EG_B[t][sq];
      if (t === BISHOP) pos.bishopB--;
    }
    pos.phase -= PHASE_INC[t];
  }

  // Repeated leaves are common in quiescence and transpositions. Verify both
  // hash halves and side (including null-move positions); cache only static
  // evaluation, never repetition/fifty-move-dependent search scores.
  const EVAL_CACHE_SIZE = 32768;
  const EVAL_CACHE_A = new Int32Array(EVAL_CACHE_SIZE);
  const EVAL_CACHE_B = new Int32Array(EVAL_CACHE_SIZE);
  const EVAL_CACHE_TAG = new Uint8Array(EVAL_CACHE_SIZE);
  const EVAL_CACHE_SCORE = new Int32Array(EVAL_CACHE_SIZE);
  const EVAL_FEATURE_MASK = 0;
  function evaluate(pos, style = 'balanced') {
    const b = pos.board;
    let mg = pos.mg, eg = pos.eg;
    const phase = pos.phase;
    const whiteBishops = pos.bishopW, blackBishops = pos.bishopB;
    const wk = pos.kingSq[WHITE], bk = pos.kingSq[BLACK];
    // EXPERIMENT (leaf-eval-fill): four typed-array fill() calls cost ~15 ns
    // each on this runtime, which is a third of the whole two-king evaluation
    // floor. One manual clear loop over the same bytes is much cheaper.
    for (let f = 0; f < 8; f++) {
      PAWN_FILES_W[f] = 0; PAWN_FILES_B[f] = 0;
      PAWN_MASK_W[f] = 0; PAWN_MASK_B[f] = 0;
    }
    let np = 0, nr = 0, nk = 0;

    for (let sq = 0; sq < 64; sq++) {
      const v = b[sq];
      if (!v) continue;
      const t = v & 7;
      if (t === PAWN) {
        const f = sq & 7;
        if (v < 9) {
          PAWN_FILES_W[f]++;
          PAWN_MASK_W[f] |= 1 << (sq >> 3);
        } else {
          PAWN_FILES_B[f]++;
          PAWN_MASK_B[f] |= 1 << (sq >> 3);
        }
        EVAL_PAWNS[np++] = sq;
      } else if (t === ROOK) {
        EVAL_ROOKS[nr++] = sq;
      } else if (t === KNIGHT) {
        EVAL_KNIGHTS[nk++] = sq;
      }
    }

    // Exact dead-material subset retained from 0.6.7 production. It is a
    // property of the position, not a scoring feature, and only fires in
    // pawnless endings with at most a minor piece.
    if (np === 0 && phase <= 2) {
      if (phase <= 1) return 0;
      if (whiteBishops + blackBishops === 2) {
        let color = -1, same = true;
        for (let sq = 0; sq < 64; sq++) if ((b[sq] & 7) === BISHOP) {
          const squareColor = ((sq & 7) + (sq >> 3)) & 1;
          if (color >= 0 && color !== squareColor) same = false;
          color = squareColor;
        }
        if (same) return 0;
      }
    }

    if (whiteBishops >= 2) { mg += 28; eg += 42; }
    if (blackBishops >= 2) { mg -= 28; eg -= 42; }

    // Pawn structure: doubled and isolated pawns.
    for (let f = 0; f < 8; f++) {
      const w = PAWN_FILES_W[f], bl = PAWN_FILES_B[f];
      if (w > 1) { mg -= 10 * (w - 1); eg -= 18 * (w - 1); }
      if (bl > 1) { mg += 10 * (bl - 1); eg += 18 * (bl - 1); }
      const wl = f > 0 ? PAWN_FILES_W[f - 1] : 0, wr = f < 7 ? PAWN_FILES_W[f + 1] : 0;
      const bl2 = f > 0 ? PAWN_FILES_B[f - 1] : 0, br = f < 7 ? PAWN_FILES_B[f + 1] : 0;
      if (w && !wl && !wr) { mg -= 12; eg -= 14; }
      if (bl && !bl2 && !br) { mg += 12; eg += 14; }
    }

    // Passed pawns: no enemy pawn ahead on the same or an adjacent file.
    for (let i = 0; i < np; i++) {
      const sq = EVAL_PAWNS[i];
      const v = b[sq];
      const white = v < 9;
      const f = sq & 7, r = sq >> 3;
      const enemyMask = white ? PAWN_MASK_B : PAWN_MASK_W;
      let passed = true;
      for (let df = -1; df <= 1 && passed; df++) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const mask = enemyMask[nf];
        const ahead = white ? mask & ~((1 << (r + 1)) - 1) : mask & ((1 << r) - 1);
        if (ahead) passed = false;
      }
      if (passed) {
        const rank = white ? r : 7 - r;
        const sign = white ? 1 : -1;
        mg += sign * PASSED_MG[rank];
        eg += sign * PASSED_EG[rank];
        // In the endgame the friendly king wants to escort, the enemy king to blockade.
        const ownKing = white ? wk : bk;
        const enemyKing = white ? bk : wk;
        const ownDist = Math.abs((ownKing & 7) - f) + Math.abs((ownKing >> 3) - r);
        const enemyDist = Math.abs((enemyKing & 7) - f) + Math.abs((enemyKing >> 3) - r);
        eg += sign * (Math.max(0, 6 - ownDist) * 2 - Math.max(0, 6 - enemyDist) * 3);
      }
    }

    // Rooks on open/semi-open files and the seventh rank.
    for (let i = 0; i < nr; i++) {
      const sq = EVAL_ROOKS[i];
      const v = b[sq];
      const f = sq & 7, r = sq >> 3;
      const white = v === ROOK;
      const own = white ? PAWN_FILES_W[f] : PAWN_FILES_B[f];
      const enemy = white ? PAWN_FILES_B[f] : PAWN_FILES_W[f];
      const open = !own && !enemy;
      const semi = !own && enemy > 0;
      if (white) {
        if (open) { mg += 24; eg += 12; } else if (semi) { mg += 10; eg += 6; }
        if (r === 6) { mg += 18; eg += 26; }
      } else {
        if (open) { mg -= 24; eg -= 12; } else if (semi) { mg -= 10; eg -= 6; }
        if (r === 1) { mg -= 18; eg -= 26; }
      }
    }

    // Knight outposts: central squares an enemy pawn can no longer shove.
    for (let i = 0; i < nk; i++) {
      const sq = EVAL_KNIGHTS[i];
      const v = b[sq];
      const f = sq & 7, r = sq >> 3;
      if (f < 2 || f > 5 || r < 2 || r > 5) continue;
      const white = v === KNIGHT;
      const enemyPawn = white ? 9 : 1;
      let contested = false;
      for (let df = -1; df <= 1 && !contested; df += 2) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const near = white ? (r + 1) * 8 + nf : (r - 1) * 8 + nf;
        if (near >= 0 && near < 64 && b[near] === enemyPawn) contested = true;
      }
      if (!contested) { mg += white ? 16 : -16; eg += white ? 8 : -8; }
    }

    // King safety is a middlegame term: pawn shield plus open files near the king.
    let shieldW = 0, shieldB = 0;
    const wf = wk & 7, wr = wk >> 3, bf = bk & 7, br = bk >> 3;
    for (let df = -1; df <= 1; df++) {
      const nf = wf + df;
      if (nf >= 0 && nf <= 7) {
        const rr = wr + 1;
        if (rr <= 7 && b[rr * 8 + nf] === PAWN) shieldW += 14; else shieldW -= 8;
        if (!PAWN_FILES_W[nf] && !PAWN_FILES_B[nf]) shieldW -= 10;
      }
      const nfb = bf + df;
      if (nfb >= 0 && nfb <= 7) {
        const rr = br - 1;
        if (rr >= 0 && b[rr * 8 + nfb] === 9) shieldB += 14; else shieldB -= 8;
        if (!PAWN_FILES_W[nfb] && !PAWN_FILES_B[nfb]) shieldB -= 10;
      }
    }
    mg += shieldW - shieldB;

    if (style === 'tactical') {
      for (let sq = 0; sq < 64; sq++) {
        const v = b[sq], type = v & 7;
        if (!v || type === PAWN || type === KING) continue;
        const white = v < 9, king = white ? bk : wk;
        const distance = Math.abs((sq & 7) - (king & 7)) + Math.abs((sq >> 3) - (king >> 3));
        mg += (white ? 1 : -1) * Math.max(0, 7 - distance) * 4;
      }
    } else if (style === 'positional') {
      if (whiteBishops >= 2) mg += 12;
      if (blackBishops >= 2) mg -= 12;
      for (let f = 0; f < 8; f++) {
        if (PAWN_FILES_W[f] > 1) mg -= 6 * (PAWN_FILES_W[f] - 1);
        if (PAWN_FILES_B[f] > 1) mg += 6 * (PAWN_FILES_B[f] - 1);
      }
    }

    const ph = phase > 24 ? 24 : phase;
    const score = (mg * ph + eg * (24 - ph)) / 24 | 0;
    return (pos.side === WHITE ? score : -score) + 10;
  }

  function evaluateUncached(pos, style, featureMask = 0x7f, allowCache = false, materialMg = pos.mg, materialEg = pos.eg, staticOnly = false) {
    // Mask 0 is the shipped evaluator. Keep masked ablation calls on the same
    // baseline instead of silently using a different mask-0 evaluation.
    if (featureMask === 0) return evaluate(pos, style);
    const b = pos.board;
    let mg = materialMg, eg = materialEg;
    const phase = pos.phase;
    const whiteBishops = pos.bishopW, blackBishops = pos.bishopB;
    const wk = pos.kingSq[WHITE], bk = pos.kingSq[BLACK];
    PAWN_FILES_W.fill(0); PAWN_FILES_B.fill(0);
    PAWN_MASK_W.fill(0); PAWN_MASK_B.fill(0);
    let np = 0, nr = 0, nk = 0, nb = 0;
    const mateDrive = (featureMask & 64) !== 0;
    // Bare-material totals are only read by the gated mate-driving term. Do
    // not charge the production mask for an experiment that is switched off.
    let matW = 0, matB = 0, pawnsW = 0, pawnsB = 0;

    for (let sq = 0; sq < 64; sq++) {
      const v = b[sq];
      if (!v) continue;
      const t = v & 7;
      if (mateDrive && t !== KING) {
        if (v < 9) { matW += VALUE[t]; if (t === PAWN) pawnsW++; }
        else { matB += VALUE[t]; if (t === PAWN) pawnsB++; }
      }
      if (t === PAWN) {
        const f = sq & 7;
        if (v < 9) {
          PAWN_FILES_W[f]++;
          PAWN_MASK_W[f] |= 1 << (sq >> 3);
        } else {
          PAWN_FILES_B[f]++;
          PAWN_MASK_B[f] |= 1 << (sq >> 3);
        }
        EVAL_PAWNS[np++] = sq;
      } else if (t === ROOK) {
        EVAL_ROOKS[nr++] = sq;
      } else if (t === KNIGHT) {
        EVAL_KNIGHTS[nk++] = sq;
      } else if (mateDrive && t === BISHOP) {
        EVAL_BISHOPS[nb++] = sq;
      }
    }

    // Exact dead-material subset. Two knights are deliberately excluded:
    // mate is still possible with cooperation, even though it cannot be forced.
    // This is a property of the position, not an evaluation feature, so it
    // applies to masked evaluations as well.
    if (np === 0 && phase <= 2) {
      if (phase <= 1) return 0;
      if (whiteBishops + blackBishops === 2) {
        let color = -1, same = true;
        for (let sq = 0; sq < 64; sq++) if ((b[sq] & 7) === BISHOP) {
          const squareColor = ((sq & 7) + (sq >> 3)) & 1;
          if (color >= 0 && color !== squareColor) same = false;
          color = squareColor;
        }
        if (same) return 0;
      }
    }
    // Pawn control, king rings and absolute pins are only needed by the
    // attack-derived terms. Building them unconditionally was pure overhead in
    // the production mask, where every one of those terms is switched off.
    if (featureMask & (4 | 8 | 16 | 32)) prepareAttacks(pos);

    // Mate driving. When one side is up a rook or more against a king that has
    // no pawns, the only thing left to do is walk the king to an edge and bring
    // our own king up. This build's KBN vs K did not convert in the development
    // suite, which motivated the experiment; that is a measurement, not proof
    // that no search can convert it. The term is silent in ordinary material
    // balances: it needs a large material edge and a pawnless defender.
    if (featureMask & 64) {
      const strongWhite = matW - matB >= 500 && matB <= 330 && pawnsB === 0;
      const strongBlack = matB - matW >= 500 && matW <= 330 && pawnsW === 0;
      if (strongWhite || strongBlack) {
        const strong = strongWhite ? WHITE : BLACK;
        const enemyKing = strong === WHITE ? bk : wk;
        const ownKing = strong === WHITE ? wk : bk;
        const ef = enemyKing & 7, er = enemyKing >> 3;
        // Distance to the nearest corner. This is mathematically the sum of
        // the two nearest edge distances; the four-corner form is used only
        // because the bishop-colour branch below needs those four terms. It is
        // not a different metric from the earlier nearest-edge version.
        let corner = Math.min(ef + er, 7 - ef + er, ef + 7 - er, 14 - ef - er);
        // King and bishop against a bare king can only mate in a corner that
        // matches the bishop's square colour. This restriction is still an
        // experiment: it did not make KBN vs K convert in the measured suite.
        // Check the strong side explicitly; the earlier version only handled a
        // white bishop, so the same mistake with Black was never tested.
        const strongBishops = strong === WHITE ? whiteBishops : blackBishops;
        const strongEdge = strong === WHITE ? matW - matB : matB - matW;
        const defenderMaterial = strong === WHITE ? matB : matW;
        if (strongBishops === 1 && nb === 1 && strongEdge >= 500 && defenderMaterial === 0) {
          const bishop = EVAL_BISHOPS[0];
          const light = ((bishop & 7) + (bishop >> 3)) & 1;
          corner = light ? Math.min(ef + 7 - er, 7 - ef + er) : Math.min(ef + er, 14 - ef - er);
        }
        const df = Math.abs((ownKing & 7) - ef), dr = Math.abs((ownKing >> 3) - er);
        const drive = (6 - corner) * 14 + (14 - df - dr) * 5;
        const sign = strong === WHITE ? 1 : -1;
        mg += sign * drive;
        eg += sign * drive;
      }
    }

    if (whiteBishops >= 2) { mg += 28; eg += 42; }
    if (blackBishops >= 2) { mg -= 28; eg -= 42; }

    // Pawn structure: doubled and isolated pawns.
    for (let f = 0; f < 8; f++) {
      const w = PAWN_FILES_W[f], bl = PAWN_FILES_B[f];
      if (w > 1) { mg -= 10 * (w - 1); eg -= 18 * (w - 1); }
      if (bl > 1) { mg += 10 * (bl - 1); eg += 18 * (bl - 1); }
      const wl = f > 0 ? PAWN_FILES_W[f - 1] : 0, wr = f < 7 ? PAWN_FILES_W[f + 1] : 0;
      const bl2 = f > 0 ? PAWN_FILES_B[f - 1] : 0, br = f < 7 ? PAWN_FILES_B[f + 1] : 0;
      if (w && !wl && !wr) { mg -= 12; eg -= 14; }
      if (bl && !bl2 && !br) { mg += 12; eg += 14; }
    }

    // Passed pawns: no enemy pawn ahead on the same or an adjacent file.
    for (let i = 0; i < np; i++) {
      const sq = EVAL_PAWNS[i];
      const v = b[sq];
      const white = v < 9;
      const f = sq & 7, r = sq >> 3;
      const enemyMask = white ? PAWN_MASK_B : PAWN_MASK_W;
      let passed = true;
      for (let df = -1; df <= 1 && passed; df++) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const mask = enemyMask[nf];
        const ahead = white ? mask & ~((1 << (r + 1)) - 1) : mask & ((1 << r) - 1);
        if (ahead) passed = false;
      }
      if (passed && ((featureMask & 1) || (featureMask & 2))) {
        const rank = white ? r : 7 - r;
        const sign = white ? 1 : -1;
        const step = white ? 8 : -8, next = sq + step;
        const blocked = next >= 0 && next < 64 && b[next] !== 0;
        mg += sign * (blocked ? PASSED_MG[rank] / 2 : PASSED_MG[rank]);
        eg += sign * (blocked ? PASSED_EG[rank] / 3 : PASSED_EG[rank]);
        // In the endgame the friendly king wants to escort, the enemy king to blockade.
        const ownKing = white ? wk : bk;
        const enemyKing = white ? bk : wk;
        const ownDist = kingDistance(ownKing, next);
        const enemyDist = kingDistance(enemyKing, next);
        if (featureMask & 2) eg += sign * (Math.max(0, 6 - ownDist) * 2 - Math.max(0, 6 - enemyDist) * 3);
        if ((featureMask & 2) && phase === 0 && rank >= 1 && rank <= 6) {
          // A conservative square-of-the-pawn test: only clear paths, and
          // check every interception square, including the initial double push.
          const side = white ? WHITE : BLACK;
          let escapes = true, pushes = 0;
          for (let rr = r + (white ? 1 : -1); rr >= 0 && rr < 8; rr += white ? 1 : -1) {
            const target = rr * 8 + f;
            if (b[target]) { escapes = false; break; }
            pushes++;
            const turns = pushes - (rank === 1 && pushes >= 2 ? 1 : 0);
            const defenderTurns = turns - (pos.side === side ? 1 : 0);
            if (kingDistance(enemyKing, target) <= defenderTurns + 1) escapes = false;
          }
          if (escapes) eg += sign * (90 + rank * 18);
          // Non-rook pawn key squares; these are guidance, not draw/win claims.
          if (f > 0 && f < 7) {
            const keyRank = r + (white ? 1 : -1) * (rank >= 4 ? 1 : 2);
            if (keyRank >= 0 && keyRank < 8) {
              let ownKey = 8, enemyKey = 8;
              for (let df = -1; df <= 1; df++) {
                const key = keyRank * 8 + f + df;
                ownKey = Math.min(ownKey, kingDistance(ownKing, key));
                enemyKey = Math.min(enemyKey, kingDistance(enemyKing, key));
              }
              eg += sign * Math.max(-24, Math.min(24, (enemyKey - ownKey) * 8));
              if (ownKey === 0) eg += sign * 24;
            }
          } else {
            const promotion = (white ? 56 : 0) + f;
            if (kingDistance(enemyKing, promotion) <= 1 && kingDistance(ownKing, promotion) > 2) {
              eg -= sign * (PASSED_EG[rank] / 2 + 35);
            }
          }
        }
      }
    }

    // Rooks on open/semi-open files and the seventh rank.
    for (let i = 0; i < nr; i++) {
      const sq = EVAL_ROOKS[i];
      const v = b[sq];
      const f = sq & 7, r = sq >> 3;
      const white = v === ROOK;
      const own = white ? PAWN_FILES_W[f] : PAWN_FILES_B[f];
      const enemy = white ? PAWN_FILES_B[f] : PAWN_FILES_W[f];
      const open = !own && !enemy;
      const semi = !own && enemy > 0;
      if (white) {
        if (open) { mg += 24; eg += 12; } else if (semi) { mg += 10; eg += 6; }
        if (r === 6) { mg += 18; eg += 26; }
      } else {
        if (open) { mg -= 24; eg -= 12; } else if (semi) { mg -= 10; eg -= 6; }
        if (r === 1) { mg -= 18; eg -= 26; }
      }
    }

    // Knight outposts: central squares an enemy pawn can no longer shove.
    for (let i = 0; i < nk; i++) {
      const sq = EVAL_KNIGHTS[i];
      const v = b[sq];
      const f = sq & 7, r = sq >> 3;
      if (f < 2 || f > 5 || r < 2 || r > 5) continue;
      const white = v === KNIGHT;
      const enemyMask = white ? PAWN_MASK_B : PAWN_MASK_W;
      let contested = false;
      for (let df = -1; df <= 1 && !contested; df += 2) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        if (white ? enemyMask[nf] & ~((1 << (r + 1)) - 1) : enemyMask[nf] & ((1 << r) - 1)) contested = true;
      }
      if (!contested && PAWN_ATTACKS[white ? WHITE : BLACK][sq]) { mg += white ? 16 : -16; eg += white ? 8 : -8; }
    }

    let dangerW = 0, dangerB = 0, attackersW = 0, attackersB = 0;
    let queenW = false, queenB = false;
    for (let sq = 0; sq < 64; sq++) {
      const piece = b[sq], type = piece & 7;
      if (!piece || type === PAWN || type === KING) continue;
      if (!(featureMask & (4 | 8 | 16 | 32))) continue;
      const side = piece < 9 ? WHITE : BLACK, enemy = 3 - side, sign = side === WHITE ? 1 : -1;
      if (type === QUEEN) { if (side === WHITE) queenW = true; else queenB = true; }
      let mobility = 0, hits = 0;
      if (type === KNIGHT) {
        if (!PINS[sq]) for (const target of KNIGHT_TARGETS[sq]) {
          const occupant = b[target];
          ATTACKS[side][target]++;
          if (KING_RING[enemy][target]) hits++;
          if ((!occupant || (occupant < 9 ? WHITE : BLACK) !== side) && !PAWN_ATTACKS[enemy][target]) mobility++;
        }
      } else for (let direction = type === ROOK ? 4 : 0; direction < (type === BISHOP ? 4 : 8); direction++) {
        const ray = RAYS[sq][direction], delta = ray[0] - sq;
        if (PINS[sq] && delta !== PINS[sq] && delta !== -PINS[sq]) continue;
        for (const target of ray) {
          const occupant = b[target];
          ATTACKS[side][target]++;
          if (KING_RING[enemy][target]) hits++;
          if ((!occupant || (occupant < 9 ? WHITE : BLACK) !== side) && !PAWN_ATTACKS[enemy][target]) mobility++;
          if (occupant) break;
        }
      }
      if (featureMask & 4) {
        mg += sign * mobility * MOBILITY_MG[type];
        eg += sign * mobility * MOBILITY_EG[type];
        if (type === BISHOP && mobility <= 1) { mg -= sign * 18; eg -= sign * 12; }
      }
      if ((featureMask & 4) && PINS[sq]) { mg -= sign * 12; eg -= sign * 8; }
      if (hits) {
        if (side === WHITE) { dangerW += hits * ATTACK_WEIGHT[type]; attackersW++; }
        else { dangerB += hits * ATTACK_WEIGHT[type]; attackersB++; }
      }
    }
    if (featureMask & 8) {
      mg += Math.min(160, dangerW * Math.max(0, attackersW - 1) * (queenW ? 2 : 1));
      mg -= Math.min(160, dangerB * Math.max(0, attackersB - 1) * (queenB ? 2 : 1));
    }
    for (let sq = 0; (featureMask & 0x10) && sq < 64; sq++) {
      const piece = b[sq], type = piece & 7;
      if (!piece || type === KING) continue;
      const side = piece < 9 ? WHITE : BLACK, enemy = 3 - side, sign = side === WHITE ? 1 : -1;
      if (ATTACKS[enemy][sq] && !ATTACKS[side][sq]) {
        const penalty = type === PAWN ? 8 : 20;
        mg -= sign * penalty; eg -= sign * penalty;
      }
    }
    if ((featureMask & 2) && phase === 0) {
      const df = Math.abs((wk & 7) - (bk & 7)), dr = Math.abs((wk >> 3) - (bk >> 3));
      if ((df === 0 && dr === 2) || (df === 2 && dr === 0)) {
        eg += pos.side === WHITE ? -12 : 12;
      }
    } else if ((featureMask & 0x20) && np === 0 && Math.abs(eg) > 400) {
      // Help a material winner bring the king up and restrict the lone king.
      const winningWhite = eg > 0, loser = winningWhite ? bk : wk;
      let lone = true;
      for (let sq = 0; sq < 64; sq++) {
        if (b[sq] && (b[sq] < 9) !== winningWhite && (b[sq] & 7) !== KING) lone = false;
      }
      if (lone) {
        const edge = Math.min(loser & 7, 7 - (loser & 7), loser >> 3, 7 - (loser >> 3));
        eg += (winningWhite ? 1 : -1) * ((3 - edge) * 18 + (7 - kingDistance(wk, bk)) * 8);
      }
    }

    // King safety is a middlegame term: pawn shield plus open files near the king.
    let shieldW = 0, shieldB = 0;
    const wf = wk & 7, wr = wk >> 3, bf = bk & 7, br = bk >> 3;
    for (let df = -1; df <= 1; df++) {
      const nf = wf + df;
      if (nf >= 0 && nf <= 7) {
        const rr = wr + 1;
        if (rr <= 7 && b[rr * 8 + nf] === PAWN) shieldW += 14; else shieldW -= 8;
        if (!PAWN_FILES_W[nf] && !PAWN_FILES_B[nf]) shieldW -= 10;
      }
      const nfb = bf + df;
      if (nfb >= 0 && nfb <= 7) {
        const rr = br - 1;
        if (rr >= 0 && b[rr * 8 + nfb] === 9) shieldB += 14; else shieldB -= 8;
        if (!PAWN_FILES_W[nfb] && !PAWN_FILES_B[nfb]) shieldB -= 10;
      }
    }
    mg += shieldW - shieldB;
    if (style === 'tactical') {
      for (let sq = 0; sq < 64; sq++) {
        const v = b[sq], type = v & 7;
        if (!v || type === PAWN || type === KING) continue;
        const white = v < 9, king = white ? bk : wk;
        const distance = Math.abs((sq & 7) - (king & 7)) + Math.abs((sq >> 3) - (king >> 3));
        mg += (white ? 1 : -1) * Math.max(0, 7 - distance) * 4;
      }
    } else if (style === 'positional') {
      if (whiteBishops >= 2) mg += 12;
      if (blackBishops >= 2) mg -= 12;
      for (let f = 0; f < 8; f++) {
        if (PAWN_FILES_W[f] > 1) mg -= 6 * (PAWN_FILES_W[f] - 1);
        if (PAWN_FILES_B[f] > 1) mg += 6 * (PAWN_FILES_B[f] - 1);
      }
    }

    return taperedScore(mg, eg, phase, pos.side);
  }

  function taperedScore(mg, eg, phase, side) {
    const ph = phase > 24 ? 24 : phase;
    const score = (mg * ph + eg * (24 - ph)) / 24 | 0;
    return (side === WHITE ? score : -score) + 10;
  }

  // ---------------------------------------------------------------- SEE
  // Static exchange evaluation follows the classic swap-list algorithm: play
  // out the cheapest captures on one square, then negamax the resulting gains.
  // It ignores pins, which is the usual trade-off for an ordering heuristic.
  const SEE_BOARD = new Int8Array(64);
  const SEE_GAIN = new Int32Array(32);

  // Cheapest attacker of `sq` for `side`, scanning piece classes from low to
  // high value. Returns -1 when the square is not attacked.
  function leastAttacker(b, sq, side) {
    const f = sq & 7, r = sq >> 3;
    const off = side === BLACK ? 8 : 0;
    if (side === WHITE) {
      if (f > 0 && r > 0 && b[sq - 9] === 1) return sq - 9;
      if (f < 7 && r > 0 && b[sq - 7] === 1) return sq - 7;
    } else {
      if (f > 0 && r < 7 && b[sq + 7] === 9) return sq + 7;
      if (f < 7 && r < 7 && b[sq + 9] === 9) return sq + 9;
    }
    const knight = KNIGHT + off;
    for (let i = 0; i < 8; i++) {
      const nf = f + KNIGHT_D[i][0], nr = r + KNIGHT_D[i][1];
      if (inBounds(nf, nr) && b[nr * 8 + nf] === knight) return nr * 8 + nf;
    }
    const bishop = BISHOP + off, rook = ROOK + off, queen = QUEEN + off;
    let queenSq = -1;
    for (let i = 0; i < 4; i++) {
      const df = BISHOP_D[i][0], dr = BISHOP_D[i][1];
      let nf = f + df, nr = r + dr;
      while (inBounds(nf, nr)) {
        const v = b[nr * 8 + nf];
        if (v) {
          if (v === bishop) return nr * 8 + nf;
          if (v === queen) queenSq = nr * 8 + nf;
          break;
        }
        nf += df;
        nr += dr;
      }
    }
    for (let i = 0; i < 4; i++) {
      const df = ROOK_D[i][0], dr = ROOK_D[i][1];
      let nf = f + df, nr = r + dr;
      while (inBounds(nf, nr)) {
        const v = b[nr * 8 + nf];
        if (v) {
          if (v === rook) return nr * 8 + nf;
          if (v === queen && queenSq < 0) queenSq = nr * 8 + nf;
          break;
        }
        nf += df;
        nr += dr;
      }
    }
    if (queenSq >= 0) return queenSq;
    const king = KING + off;
    for (let i = 0; i < 8; i++) {
      const nf = f + KING_D[i][0], nr = r + KING_D[i][1];
      if (inBounds(nf, nr) && b[nr * 8 + nf] === king) return nr * 8 + nf;
    }
    return -1;
  }

  function see(pos, move) {
    const b = SEE_BOARD;
    b.set(pos.board);
    const from = move & 63, to = (move >> 6) & 63;
    const promo = (move >> 12) & 7;
    const piece = b[from];
    const color = piece > 8 ? BLACK : WHITE;
    let victim = b[to];
    if (!victim && (piece & 7) === PAWN && to === pos.ep) {
      const epSq = color === WHITE ? to - 8 : to + 8;
      victim = b[epSq];
      b[epSq] = 0;
    }
    const gain = SEE_GAIN;
    let d = 0;
    gain[0] = victim ? VALUE[victim & 7] : 0;
    if (promo) gain[0] += VALUE[promo] - VALUE[PAWN];
    b[from] = 0;
    const placed = promo ? promo + (color === BLACK ? 8 : 0) : piece;
    b[to] = placed;
    let onTo = VALUE[placed & 7];
    let side = color === WHITE ? BLACK : WHITE;
    while (d < 30) {
      const att = leastAttacker(b, to, side);
      if (att < 0) break;
      d++;
      gain[d] = onTo - gain[d - 1];
      const ap = b[att];
      b[att] = 0;
      b[to] = ap;
      onTo = VALUE[ap & 7];
      side = side === WHITE ? BLACK : WHITE;
    }
    while (d > 0) {
      d--;
      gain[d] = -Math.max(-gain[d], gain[d + 1]);
    }
    return gain[0];
  }

  function uci(move) {
    return squareName(move & 63) + squareName((move >> 6) & 63) + ('  nbrq'[(move >> 12) & 7] || '').trim();
  }

  function positionKey(fen) {
    const parts = fen.split(' ');
    // FEN may include an en-passant target even without an adjacent pawn.
    if (parts[3] !== '-') {
      const rows = parts[0].split('/').map((row) => [...row].flatMap((ch) => /\d/.test(ch) ? Array(Number(ch)).fill('') : [ch]));
      const file = parts[3].charCodeAt(0) - 97;
      const rank = Number(parts[3][1]);
      const row = 8 - (rank + (parts[1] === 'w' ? -1 : 1));
      const pawn = parts[1] === 'w' ? 'P' : 'p';
      if (rows[row]?.[file - 1] !== pawn && rows[row]?.[file + 1] !== pawn) parts[3] = '-';
    }
    return parts.slice(0, 4).join(' ');
  }

  // Search-internal position key. A number instead of a string: at a million
  // nodes per search the string allocations were the single largest cost.
  // The transposition table also stores hashB as a verification signature.
  function hashKey(pos) {
    return (pos.hashA ^ Math.imul(pos.hashB, 0x9e3779b1)) >>> 0;
  }

  // --------------------------------------------------------- playing profile
  function boundedNumber(value, fallback, min, max) {
    const number = Number(value ?? fallback);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function playProfile(opts = {}) {
    const ruthless = opts.mode === 'ruthless';
    // Human mode is allowed to leave the very top move even at maximum Elo.
    // This is the everyday sandbag layer: a small score allowance, not a
    // random move. Deliberate hard errors are requested separately.
    const human = opts.mode === 'human';
    const skill = ruthless ? 100 : boundedNumber(opts.skill, 100, 0, 100);
    const variety = ruthless ? 0 : boundedNumber(opts.variety, 0, 0, 100);
    const weakness = (100 - skill) / 100;
    // Human mode stays slightly imperfect at the very top of the scale. The
    // move is still good, but not the same silicon move every single time.
    const polish = (skill / 100) ** 6;
    return {
      skill, variety, ruthless,
      maxDepth: ruthless
        ? Math.min(Math.floor(boundedNumber(opts.depth, 12, 1, 16)), 16)
        // Maximum Elo removes the handicap entirely; lower presets stay capped
        // by their approximate strength band.
        : Math.min(Math.floor(boundedNumber(opts.depth, 4, 1, 16)), skill >= 100 ? 16 : 1 + Math.floor(skill / 20)),
      maxLoss: ruthless ? 0 : 180 * weakness * weakness + 0.35 * variety + 14 * polish + (human ? 24 : 0),
      temperature: ruthless ? 1 : 6 + 65 * weakness + 0.24 * variety + 8 * polish + (human ? 18 : 0),
      maxCandidates: ruthless ? 1 : 4 + Math.round(2 * weakness + variety / 50) + (human ? 1 : 0),
      varied: !ruthless && (variety > 0 || skill < 100 || human)
    };
  }

  function playingContext(pos) {
    let material = 0;
    for (const piece of pos.board) {
      const type = piece & 7;
      if (piece && type !== PAWN && type !== KING) material += VALUE[type];
    }
    return { inCheck: pos.inCheck(pos.side), phase: Math.min(1, material / 6000) };
  }

  function quietKingMove(pos, move) {
    const from = move & 63, to = (move >> 6) & 63;
    return (pos.board[from] & 7) === KING && !pos.board[to] && Math.abs(to - from) !== 2;
  }

  // Candidates must be exact scores from one fully completed root iteration.
  // Thresholds and weights are design heuristics, not fitted human probabilities.
  function selectCandidate(pos, candidates, opts = {}, random = Math.random) {
    if (!candidates.length) return null;
    const rankedAll = candidates.slice().sort((a, b) => b.score - a.score);
    // Repeating a winning position into a claimable draw is never a good trade
    // when a non-losing alternative exists. Losing positions still take the draw.
    const leader = rankedAll[0];
    const alternatives = rankedAll.filter((item) => !item.claimDraw);
    const avoidDraw = leader.claimDraw && leader.score > 0 && alternatives.length > 0 &&
      alternatives[0].score > -200;
    const ranked = avoidDraw ? alternatives : rankedAll;
    const best = ranked[0];
    const profile = playProfile(opts);
    if (!profile.varied || ranked.length === 1) return best;

    let pool;
    let temperature = profile.temperature;
    let maxCandidates = profile.maxCandidates;
    if (Math.abs(best.score) > MATE - 100) {
      // Preserve the fastest found mate, or the longest resistance if all lose.
      pool = ranked.filter((item) => item.score === best.score);
    } else {
      const context = playingContext(pos);
      const gap = best.score - ranked[1].score;
      // High variety should reach different sound opening families, rather
      // than only alternating two knights at the top of a tiny score band.
      const openingVariety = pos.full <= 6 && context.phase > 0.8 && !context.inCheck
        ? profile.variety / 100 : 0;
      maxCandidates += Math.round(4 * openingVariety);
      // A clear best move or check calls for less latitude than a quiet tie.
      const factor = (context.inCheck ? 0.55 : 1) / (1 + gap / 100);
      const margin = (profile.maxLoss + 90 * openingVariety) * factor;
      temperature = (temperature + 65 * openingVariety) * factor;
      pool = ranked.filter((item) => {
        const loss = best.score - item.score;
        if (item.score <= -MATE + 100 || loss > margin) return false;
        // Don't turn a reasonable middlegame into a king walk for variety.
        // Retain good king moves, captures, castling and endgame activity.
        return context.inCheck || context.phase < 0.5 || !quietKingMove(pos, item.move) || loss <= Math.min(12, margin);
      });
    }
    pool = pool.slice(0, maxCandidates);
    if (pool.length < 2) return best;
    const weights = pool.map((item) => Math.exp((item.score - best.score) / temperature));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const draw = Number(random());
    let pick = (Number.isFinite(draw) ? Math.max(0, Math.min(1 - Number.EPSILON, draw)) : 0) * total;
    for (let i = 0; i < pool.length; i++) {
      pick -= weights[i];
      if (pick < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // ----------------------------------------------------------------- search
  class Engine {
    constructor() {
      this.nodes = 0;
      this.moveBuf = [];
      for (let i = 0; i < 64; i++) this.moveBuf.push(new Int32Array(256));
      this.killers = [];
      for (let i = 0; i < 64; i++) this.killers.push([0, 0]);
      this.history = new Int32Array(64 * 64);
      this.followHistory = new Int32Array(64 * 64);
      this.counterMoves = new Int32Array(64 * 64);
      this.moveStack = new Int32Array(64);
      this.aborted = false;
      this.deadline = Infinity;
      this.nodeLimit = Infinity;
      this.style = 'balanced';
      this.evaluation = evaluate;
      this.evalCache = new Map();
      this.evalFeatureMask = EVAL_FEATURE_MASK;
      this.evalFn = (pos) => evaluate(pos, this.style);
      this.path = new Map();
      // Numeric keys + a stored signature: the old string keys allocated at
      // every node. This table is persistent across moves and is the main
      // reason bullet searches converge so quickly.
      this.tt = new Map();
      this.ttLimit = 160000;
      this.ttStyle = 'balanced';
      this._scores = new Int32Array(256);
    }

    async think(fen, opts) {
      opts = opts || {};
      const profile = playProfile(opts);
      const maxDepth = profile.maxDepth;
      const timeMs = boundedNumber(opts.timeMs, 600, 50, 30000);
      const pos = new Position(fen);
      this.style = ['tactical', 'positional'].includes(opts.style) ? opts.style : 'balanced';
      // Evaluation configuration persists until it is changed again, so
      // configureEvaluation() survives the next think() call. Passing an
      // option here overrides it for this search and for later ones.
      if (typeof opts.evaluate === 'function') this.evaluation = opts.evaluate;
      if (Number.isInteger(opts.evalFeatureMask)) this.evalFeatureMask = opts.evalFeatureMask;
      this.evalCache = new Map();
      this.evalFn = this.resolveEvaluator();
      this.positionValues = 'current';
      if (this.style !== this.ttStyle) { this.tt.clear(); this.ttStyle = this.style; }
      const ttSize = Math.floor(boundedNumber(opts.ttLimit, this.ttLimit, 1000, 1000000));
      this.ttLimit = ttSize;
      this.path.clear();
      const hashOf = new Map();
      const hashForFen = (historyFen) => {
        let key = hashOf.get(historyFen);
        if (key === undefined) {
          key = hashKey(new Position(historyFen));
          hashOf.set(historyFen, key);
        }
        return key;
      };
      const historyCounts = new Map();
      for (const historyFen of (Array.isArray(opts.historyFens) ? opts.historyFens : []).slice(-200)) {
        if (typeof historyFen !== 'string') continue;
        const key = hashForFen(historyFen);
        historyCounts.set(key, (historyCounts.get(key) || 0) + 1);
      }
      const rootKey = hashKey(pos);
      if (!historyCounts.has(rootKey)) historyCounts.set(rootKey, 1);
      this.rootOccurrences = historyCounts;

      const t0 = now();
      this.deadline = t0 + timeMs;
      this.nodeLimit = Math.floor(boundedNumber(opts.nodeLimit, Infinity, 1, Number.MAX_SAFE_INTEGER));
      this.nodes = 0;
      this.aborted = false;
      this.history.fill(0);
      this.followHistory.fill(0);
      this.counterMoves.fill(0);
      this.moveStack.fill(0);
      for (const k of this.killers) { k[0] = 0; k[1] = 0; }

      const rootBuf = this.moveBuf[0];
      const n = pos.generateMoves(rootBuf, false);
      const mover = pos.side;
      let rootMoves = [];
      for (let i = 0; i < n; i++) {
        const mv = rootBuf[i];
        pos.make(mv);
        const bad = pos.isSquareAttacked(pos.kingSq[mover], pos.side);
        pos.unmake();
        if (!bad) {
          pos.make(mv);
          const repeated = (historyCounts.get(hashKey(pos)) || 0) >= 2;
          pos.unmake();
          rootMoves.push({ move: mv, score: -Infinity, claimDraw: repeated });
        }
      }
      if (!rootMoves.length) {
        return { best: 0, move: null, score: pos.inCheck(mover) ? -MATE : 0, depth: 0, nodes: 0, time: 0, mate: pos.inCheck(mover) ? -1 : null, source: 'search', lines: [] };
      }

      // Root slicing lets the host split a search across CPU cores. The
      // generation order is deterministic, so every worker sees the same list.
      const slice = opts.rootSlice;
      if (slice && Number(slice.count) > 1) {
        const count = Math.max(2, Math.min(64, Math.floor(Number(slice.count)) || 2));
        const index = Math.max(0, Math.min(count - 1, Math.floor(Number(slice.index)) || 0));
        rootMoves = rootMoves.filter((_, i) => i % count === index);
        if (!rootMoves.length) {
          return { best: 0, move: null, score: 0, depth: 0, nodes: 0, time: 0, mate: null, source: 'search', lines: [] };
        }
      }

      // An emergency fallback ranks every legal move equally shallowly.
      // It is not a search iteration and is never used for varied sampling.
      for (const rm of rootMoves) {
        if (rm.claimDraw) {
          rm.score = 0;
          continue;
        }
        pos.make(rm.move);
        const replies = pos.legalMoves();
        rm.score = !replies.length ? (pos.inCheck(pos.side) ? MATE - 1 : 0) : -this.evalFn(pos);
        pos.unmake();
      }
      rootMoves.sort((a, b) => b.score - a.score);
      let bestMove = rootMoves[0].move;
      let bestScore = rootMoves[0].score;
      let completedDepth = 0;
      let completed = rootMoves.map(({ move, score, claimDraw }) => ({ move, score, claimDraw }));

      let prevScore = bestScore;
      let prevBest = bestMove;
      let stableCount = 0;
      let aspirationFails = 0;
      for (let depth = 1; depth <= maxDepth; depth++) {
        // Exact root scores are only needed when the controller will sample
        // from them: move variety, or a deliberate blunder. Otherwise PVS at
        // the root is much cheaper and reaches the same best move.
        const exactRoot = profile.varied || Boolean(opts.blunder);
        // Small windows around the previous iteration's score save a lot of
        // work when the position is quiet. Only use them once the last two
        // iterations agreed on the move and score: tactical positions that
        // keep changing cost more in reruns than the window saves. A failed
        // aspiration falls back to one full-window retry, and after three
        // failures the rest of the search runs unaspirated.
        const aspiration = !exactRoot && depth >= 5 && stableCount >= 2 &&
          aspirationFails < 3 && Math.abs(prevScore) < MATE - 1000;
        const delta = 50 + depth * 5;
        let alpha = aspiration ? prevScore - delta : -MATE * 2;
        let beta = aspiration ? prevScore + delta : MATE * 2;
        let iterBest = 0, iterScore = -MATE * 2;
        let iteration = [];
        for (;;) {
          iterBest = 0; iterScore = -MATE * 2;
          iteration = [];
          const rootAlpha = alpha;
          let failHigh = false;
          let searched = 0;
          // Order by the previous iteration's scores.
          rootMoves.sort((a, b) => b.score - a.score);

          for (const rm of rootMoves) {
            if (this.shouldStop(true)) break;
            if (rm.claimDraw) {
              iteration.push({ move: rm.move, score: 0, claimDraw: true });
              if (0 > iterScore) { iterScore = 0; iterBest = rm.move; }
              if (0 > alpha) alpha = 0;
              continue;
            }
            this.moveStack[0] = rm.move;
            pos.make(rm.move);
            let score;
            if (!exactRoot && iteration.length) {
              // PVS at the root: exact score after a fail-high re-search.
              score = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, 1);
              if (score > alpha) {
                if (score >= beta) failHigh = true;
                else score = -this.negamax(pos, depth - 1, -beta, -alpha, 1);
              }
            } else {
              // Full windows keep candidate scores comparable for varied play.
              score = exactRoot
                ? -this.negamax(pos, depth - 1, -MATE * 2, MATE * 2, 1)
                : -this.negamax(pos, depth - 1, -beta, -alpha, 1);
            }
            pos.unmake();
            if (this.aborted) break;
            // The first root move is the only one searched with a real window.
            // If it lands outside the aspiration window the whole iteration is
            // retried, otherwise later null-window tests are measured against
            // a bound instead of a true score.
            if (aspiration && searched === 0 && (score <= alpha || score >= beta)) failHigh = true;
            searched++;
            rm.score = score;
            iteration.push({ move: rm.move, score });
            if (score > iterScore) {
              iterScore = score;
              iterBest = rm.move;
            }
            if (score > alpha) alpha = score;
            if (failHigh) break;
          }

          if (this.aborted) break;
          if (!aspiration) break;
          if (failHigh || iterScore <= rootAlpha) {
            // The true score left the window. One full-window retry is always
            // safe; repeated failures disable aspiration for this search.
            aspirationFails++;
            alpha = -MATE * 2;
            beta = MATE * 2;
            continue;
          }
          break;
        }

        if (this.aborted) break;
        bestMove = iterBest;
        bestScore = iterScore;
        completedDepth = depth;
        completed = iteration;
        stableCount = iterBest === prevBest && Math.abs(iterScore - prevScore) <= 40
          ? stableCount + 1
          : 0;
        prevBest = iterBest;
        prevScore = iterScore;

        if (Math.abs(bestScore) > MATE - 100) break;
        // Always try the next depth; an aborted iteration is discarded and the
        // previous completed one is used. That spends the whole budget instead
        // of leaving a fixed safety margin on the table.
        if (now() - t0 >= timeMs) break;
      }

      const selected = completedDepth
        ? selectCandidate(pos, completed, opts, typeof opts.random === 'function' ? opts.random : Math.random)
        : null;

      // Intentional errors come in two sizes: a configured hard error (the
      // controller chooses the severity window) and the smaller inaccuracies
      // humans make every few moves. The controller picks the window and passes
      // it in; the engine only supplies a scored move inside it.
      const minLoss = boundedNumber(opts.blunderMin, 80, 20, 800);
      const maxLoss = Math.max(minLoss, boundedNumber(opts.blunderMax, 450, 20, 1200));
      let forced = null;
      if (opts.blunder && completed.length > 1 && Math.abs(bestScore) < MATE - 1000) {
        const ranked = completed.slice().sort((a, b) => b.score - a.score);
        const best = ranked[0].score;
        const pool = ranked.filter((m) => !m.claimDraw && m.move !== ranked[0].move &&
          best - m.score >= minLoss && best - m.score <= maxLoss && m.score > -MATE + 1000);
        if (pool.length) {
          const r = typeof opts.random === 'function' ? opts.random() : Math.random();
          forced = pool[Math.max(0, Math.min(pool.length - 1, Math.floor(r * pool.length)))];
          forced.blunderLoss = best - forced.score;
        } else {
          // If the configured range is unavailable, use any legal lower-
          // scoring root move and report the configured minimum loss.
          const fallback = ranked.filter((m) => !m.claimDraw && m.move !== ranked[0].move &&
            best - m.score > 0 && m.score > -MATE + 1000);
          if (fallback.length) {
            const chosenFallback = fallback[Math.max(0, Math.min(fallback.length - 1, Math.floor((typeof opts.random === 'function' ? opts.random() : Math.random()) * fallback.length)))];
            forced = chosenFallback;
            forced.blunderLoss = Math.max(minLoss, best - chosenFallback.score);
          } else {
            const anyOther = ranked.filter((m) => !m.claimDraw && m.move !== ranked[0].move);
            if (anyOther.length) {
              const chosenAny = anyOther[Math.max(0, Math.min(anyOther.length - 1, Math.floor((typeof opts.random === 'function' ? opts.random() : Math.random()) * anyOther.length)))];
              forced = chosenAny;
              forced.blunderLoss = minLoss;
            }
          }
        }
        if (pool.length) {
          const r = typeof opts.random === 'function' ? opts.random() : Math.random();
          forced = pool[Math.max(0, Math.min(pool.length - 1, Math.floor(r * pool.length)))];
          forced.blunderLoss = best - forced.score;
        } else {
          // If the configured loss window is unavailable, use any lower-scoring
          // legal root move so deliberate errors remain real and metadata valid.
          const fallback = ranked.filter((m) => !m.claimDraw && m.move !== ranked[0].move &&
            best - m.score > 0 && m.score > -MATE + 1000);
          if (fallback.length) {
            const chosenFallback = fallback[Math.max(0, Math.min(fallback.length - 1, Math.floor((typeof opts.random === 'function' ? opts.random() : Math.random()) * fallback.length)))];
            forced = chosenFallback;
            forced.blunderLoss = Math.max(minLoss, best - chosenFallback.score);
          } else {
            const anyOther = ranked.filter((m) => !m.claimDraw && m.move !== ranked[0].move);
            if (anyOther.length) {
              const chosenAny = anyOther[Math.max(0, Math.min(anyOther.length - 1, Math.floor((typeof opts.random === 'function' ? opts.random() : Math.random()) * anyOther.length)))];
              forced = chosenAny;
              forced.blunderLoss = minLoss;
            }
          }

        }
      }

      const chosen = forced?.move ?? selected?.move ?? bestMove;
      const chosenScore = forced?.score ?? selected?.score ?? bestScore;
      const rankedLines = completed.slice().sort((a, b) => b.score - a.score);

      return {
        best: chosen,
        bestMove,
        score: chosenScore,
        depth: completedDepth,
        scoreSource: completedDepth ? 'search' : 'static',
        nodes: this.nodes,
        time: Math.round(now() - t0),
        mate: Math.abs(chosenScore) > MATE - 100 ? Math.sign(chosenScore) * Math.ceil((MATE - Math.abs(chosenScore)) / 2) : null,
        blundered: Boolean(forced),
        blunderLoss: forced ? (forced.blunderLoss ?? bestScore - forced.score) : 0,
        // Used by the human clock: an obvious best move gets played faster,
        // while a crowded, sharp position earns a longer think.
        gap: rankedLines.length > 1 ? rankedLines[0].score - rankedLines[1].score : 999,
        legalMoves: rootMoves.length,
        exactScores: profile.varied || Boolean(opts.blunder),
        source: 'search',
        move: uci(chosen),
        lines: rankedLines.slice(0, 3).map((m) => ({
          move: uci(m.move),
          score: m.score,
          best: m.move
        }))
      };
    }

    // Resolve the evaluation once per search, not per node.
    //
    // The default build is the hot path: it must stay a direct call into the
    // shared cached evaluator so that adding the feature-mask plumbing costs
    // nothing. Any other combination goes through a closure that honours the
    // mask. Previously this method set fields that the search never read, so
    // masks and custom evaluators were silently ignored.
    resolveEvaluator() {
      const style = this.style;
      const fn = this.evaluation;
      const mask = this.evalFeatureMask;
      if (fn === evaluate && mask === EVAL_FEATURE_MASK) {
        return (pos) => evaluate(pos, style);
      }
      if (fn === evaluate) {
        // Masked evaluations get the same shape of cache the production
        // evaluator has. Without this an ablation measures a string-keyed Map,
        // not the feature: the masked path used to lose half its nodes per
        // second to allocation before any term was even switched on.
        const size = 16384;
        const cacheA = new Int32Array(size);
        const cacheB = new Int32Array(size);
        const cacheTag = new Uint8Array(size);
        const cacheScore = new Int32Array(size);
        const maskTag = mask << 2;
        return (pos) => {
          const tag = maskTag | pos.side;
          const index = (pos.hashA ^ (tag * 7919)) & (size - 1);
          if (cacheTag[index] === tag && cacheA[index] === pos.hashA && cacheB[index] === pos.hashB) {
            return cacheScore[index];
          }
          const score = evaluateUncached(pos, style, mask, false, pos.mg, pos.eg);
          cacheA[index] = pos.hashA;
          cacheB[index] = pos.hashB;
          cacheTag[index] = tag;
          cacheScore[index] = score;
          return score;
        };
      }
      return (pos) => fn(pos, style, mask, false);
    }

    configureEvaluation(featureMask = EVAL_FEATURE_MASK) {
      this.evaluation = evaluate;
      this.evalFeatureMask = featureMask;
      this.evalFn = this.resolveEvaluator();
      this.positionValues = 'current';
      this.evalCache = new Map();
    }

    staticEvaluation(pos) {
      return this.evalFn(pos);
    }

    shouldStop(checkTime = false) {
      if (this.aborted || this.nodes >= this.nodeLimit ||
          ((checkTime || (this.nodes & 1023) === 0) && now() >= this.deadline)) {
        this.aborted = true;
      }
      return this.aborted;
    }

    negamax(pos, depth, alpha, beta, ply) {
      const key = hashKey(pos);
      const visits = this.path.get(key) || 0;
      // The current node is the next occurrence: two occurrences already in
      // history/path make this visit the third and therefore claimable.
      if (visits + (this.rootOccurrences?.get(key) || 0) >= 2) return 0;
      // Two-way buckets: one slot for the deepest line seen here, one for the
      // most recent. Collisions between unrelated positions no longer evict
      // the whole entry, and the matching signature is still verified.
      const bucket = this.tt.get(key);
      let entry = null, ttMove = 0;
      if (bucket) {
        const a = bucket.a, b = bucket.b;
        let best = null;
        if (a && a.sig === pos.hashB) best = a;
        if (b && b.sig === pos.hashB && (!best || b.depth > best.depth)) best = b;
        if (best) {
          ttMove = best.move;
          if (best.depth >= depth) entry = best;
        }
      }
      if (entry) {
        if (entry.flag === 0) return entry.score;
        if (entry.flag === 1 && entry.score >= beta) return entry.score;
        if (entry.flag === 2 && entry.score <= alpha) return entry.score;
      }
      if (depth <= 0) return this.searchNode(pos, depth, alpha, beta, ply, ttMove, key);
      this.path.set(key, visits + 1);
      try { return this.searchNode(pos, depth, alpha, beta, ply, ttMove, key); }
      finally { if (visits) this.path.set(key, visits); else this.path.delete(key); }
    }

    storeTT(key, sig, depth, score, flag, move) {
      // Mate scores are relative to the current ply, so they are not portable
      // between nodes. Keep them out of the table and let the search find them.
      if (Math.abs(score) > MATE - 1000) return;
      const fresh = { depth, score, flag, move, sig };
      let bucket = this.tt.get(key);
      if (!bucket) {
        if (this.tt.size >= this.ttLimit) this.tt.clear();
        this.tt.set(key, { a: fresh, b: null });
        return;
      }
      const a = bucket.a, b = bucket.b;
      if (a && a.sig === sig) {
        if (a.depth <= depth) bucket.a = fresh;
        return;
      }
      if (b && b.sig === sig) {
        if (b.depth <= depth) bucket.b = fresh;
        return;
      }
      if (!b) bucket.b = fresh;
      else if (a.depth <= b.depth) { if (depth >= a.depth) bucket.a = fresh; }
      else if (depth >= b.depth) bucket.b = fresh;
    }

    hasNonPawn(pos, color) {
      const b = pos.board;
      const white = color === WHITE;
      for (let sq = 0; sq < 64; sq++) {
        const v = b[sq];
        if (!v || (v < 9) !== white) continue;
        const t = v & 7;
        if (t !== PAWN && t !== KING) return true;
      }
      return false;
    }

    searchNode(pos, depth, alpha, beta, ply, ttMove = 0, key = 0) {
      if (this.shouldStop()) return 0;
      this.nodes++;
      if (ply >= 60) return this.evalFn(pos);

      const mover = pos.side;
      const inCheck = pos.isSquareAttacked(pos.kingSq[mover], mover === WHITE ? BLACK : WHITE);
      if (pos.half >= 100) return inCheck && !pos.legalMoves().length ? -MATE + ply : 0;

      // Mate-distance pruning. It keeps the returned mate scores honest and
      // stops pointless searches once no score can improve the current bound.
      if (alpha < -MATE + ply) alpha = -MATE + ply;
      if (beta > MATE - ply - 1) beta = MATE - ply - 1;
      if (alpha >= beta) return alpha;

      if (inCheck) {
        if (depth <= 0) depth = 1;
      } else if (depth <= 0) {
        return this.qsearch(pos, alpha, beta, ply);
      }

      const alpha0 = alpha;
      const prevMove = ply > 0 ? this.moveStack[ply - 1] : 0;
      const staticEval = !inCheck && depth <= 5 ? this.evalFn(pos) : 0;

      // Reverse futility: at shallow depth a static score well above beta is
      // usually enough, even if the opponent gets a free move in reply.
      //
      // The beta guard must exclude mate bounds at *both* ends. With a beta
      // near -MATE the node is deciding whether it is getting mated, and any
      // ordinary static score clears it, which turns a proven loss into a
      // quiet fail-high. That is how forced mates were being missed.
      if (!inCheck && depth <= 5 && Math.abs(beta) < MATE - 1000 &&
          staticEval - 90 * depth >= beta) {
        return staticEval;
      }

      // Razoring: if even a generous static margin cannot reach alpha, verify
      // with a quiescence search instead of a full node. The qsearch result is
      // used only when it also fails low, so real tactics are not discarded.
      if (!inCheck && depth <= 2 && alpha > -MATE + 1000 && staticEval + 250 * depth + 100 < alpha) {
        const razor = this.qsearch(pos, alpha, beta, ply);
        if (razor < alpha) return razor;
      }

      // Null-move pruning: if giving the opponent a free move still leaves us
      // above beta, the real move almost certainly does too. Skip positions
      // with only pawns/king, where zugzwang makes the test unsafe, and skip
      // mate bounds for the same reason as reverse futility above.
      if (!inCheck && depth >= 3 && Math.abs(beta) < MATE - 1000 && this.hasNonPawn(pos, mover)) {
        const reduction = depth >= 6 ? 3 : 2;
        const undo = pos.makeNull();
        const nullScore = -this.negamax(pos, depth - 1 - reduction, -beta, -beta + 1, ply + 1);
        pos.unmakeNull(undo);
        if (this.aborted) return 0;
        if (nullScore >= beta && Math.abs(nullScore) < MATE - 1000) {
          this.storeTT(key, pos.hashB, depth, beta, 1, 0);
          return beta;
        }
      }

      const buf = this.moveBuf[ply];
      const n = pos.generateMoves(buf, false);
      this.orderMoves(pos, buf, n, ply, ttMove);

      let legal = 0;
      let bestMove = ttMove;
      for (let i = 0; i < n; i++) {
        const mv = buf[i];
        const from = mv & 63, to = (mv >> 6) & 63;
        const attacker = pos.board[from];
        let captured = pos.board[to];
        // En passant captures a pawn that is not standing on the target square.
        if (!captured && (attacker & 7) === PAWN && to === pos.ep) captured = pos.side === WHITE ? 9 : 1;
        this.moveStack[ply] = mv;
        pos.make(mv);
        if (pos.isSquareAttacked(pos.kingSq[mover], pos.side)) {
          pos.unmake();
          continue;
        }
        legal++;

        // A move only needs a full check test when the enemy king could
        // actually be attacked by the piece that just moved. The old test used
        // a Manhattan distance of 2, which cannot describe a knight move
        // (distance 3) and never describes a sliding attack, so every piece
        // check was invisible: no check extension, and late-move pruning threw
        // quiet mating moves away.
        const enemyKing = pos.kingSq[pos.side];
        const df = (to & 7) - (enemyKing & 7);
        const dr = (to >> 3) - (enemyKing >> 3);
        const adf = Math.abs(df), adr = Math.abs(dr);
        const moverType = attacker & 7;
        // A promotion arrives as a pawn but attacks like the piece it becomes.
        const effective = (mv >> 12) ? QUEEN : moverType;
        const couldCheck = effective === KNIGHT
          ? adf * adr === 2
          : effective === ROOK
            ? (df === 0 || dr === 0)
            : effective === BISHOP
              ? adf === adr && adf !== 0
              : effective === QUEEN
                ? (df === 0 || dr === 0 || (adf === adr && adf !== 0))
                : adf + adr <= 2;
        const givesCheck = couldCheck && pos.isSquareAttacked(enemyKing, mover);

        // Futility: at shallow depth, quiet moves that cannot lift a very low
        // alpha are not worth searching. Captures, promotions and checks stay.
        const quiet = !captured && !(mv >> 12);
        if (!inCheck && quiet && !givesCheck && depth <= 2 &&
            staticEval + 120 * depth + 80 <= alpha) {
          pos.unmake();
          continue;
        }
        // Late-move pruning at the horizon is even more aggressive.
        if (!inCheck && quiet && !givesCheck && depth <= 2 && legal > 8) {
          pos.unmake();
          continue;
        }

        const extension = givesCheck && ply < 24 ? 1 : 0;
        let score;
        if (legal === 1) {
          score = -this.negamax(pos, depth - 1 + extension, -beta, -alpha, ply + 1);
        } else {
          // Late move reductions for quiet, non-checking moves. Anything that
          // beats the null window is re-searched at full depth.
          let reduction = 0;
          if (!inCheck && quiet && !givesCheck && depth >= 3 && legal > 2) {
            reduction = LMR_TABLE[(Math.min(depth, 16) << 6) + Math.min(legal, 63)];
            if (reduction > depth - 2) reduction = depth - 2;
          }
          score = -this.negamax(pos, depth - 1 + extension - reduction, -alpha - 1, -alpha, ply + 1);
          if (score > alpha && reduction) {
            score = -this.negamax(pos, depth - 1 + extension, -alpha - 1, -alpha, ply + 1);
          }
          if (score > alpha && score < beta) {
            score = -this.negamax(pos, depth - 1 + extension, -beta, -alpha, ply + 1);
          }
        }
        pos.unmake();
        if (this.aborted) return 0;

        if (score > alpha) {
          alpha = score;
          bestMove = mv;
          if (score >= beta) {
            if (quiet) {
              const k = this.killers[ply];
              if (k[0] !== mv) { k[1] = k[0]; k[0] = mv; }
              const bonus = Math.min(1 << 20, depth * depth);
              const hIdx = from * 64 + to;
              this.history[hIdx] = Math.min(1 << 20, this.history[hIdx] + bonus);
              if (prevMove) {
                const prevTo = (prevMove >> 6) & 63;
                this.counterMoves[((prevMove & 63) << 6) | prevTo] = mv;
                const fIdx = prevTo * 64 + to;
                this.followHistory[fIdx] = Math.min(1 << 20, this.followHistory[fIdx] + bonus);
              }
            }
            this.storeTT(key, pos.hashB, depth, beta, 1, mv);
            return beta;
          }
        }
      }

      if (!legal) return pos.inCheck(mover) ? -MATE + ply : 0;
      // An unchanged alpha is an upper bound, not an exact score.
      this.storeTT(key, pos.hashB, depth, alpha, alpha > alpha0 ? 0 : 2, bestMove);
      return alpha;
    }

    qsearch(pos, alpha, beta, ply) {
      if (this.shouldStop()) return 0;
      this.nodes++;
      if (ply >= 60) return this.evalFn(pos);

      const mover = pos.side;
      const inCheck = pos.isSquareAttacked(pos.kingSq[mover], mover === WHITE ? BLACK : WHITE);
      if (!inCheck && pos.half >= 100) return 0;
      const stand = inCheck ? -MATE * 2 : this.evalFn(pos);
      if (!inCheck) {
        if (stand >= beta) return beta;
        if (stand > alpha) alpha = stand;
      }

      const buf = this.moveBuf[ply];
      const n = pos.generateMoves(buf, !inCheck);
      // A quiet node with no captures is the only place a horizon stalemate
      // can hide. Testing it there avoids a full legal-move generation at
      // every other quiescence node, which is the hottest path in bullet.
      if (!n && !inCheck && !pos.legalMoves().length) return 0;
      this.orderMoves(pos, buf, n, ply);

      let legal = 0;
      for (let i = 0; i < n; i++) {
        const mv = buf[i];
        const to = (mv >> 6) & 63;
        const attacker = pos.board[mv & 63];
        let victim = pos.board[to];
        if (!victim && (attacker & 7) === PAWN && to === pos.ep) victim = pos.side === WHITE ? 9 : 1;
        // Delta pruning: if even winning this piece cannot lift alpha, skip it.
        if (!inCheck && !(mv >> 12) && stand + VALUE[victim & 7] + 180 <= alpha) continue;
        // SEE pruning: a capture that loses material cannot rescue a quiet
        // position that is already below alpha. Only captures where the
        // attacker outvalues the victim can lose material, so the full swap
        // list runs just for those. The stand-pat score keeps this safe even
        // when every capture is bad.
        if (!inCheck && victim && VALUE[victim & 7] < VALUE[attacker & 7]) {
          const seeVal = see(pos, mv);
          if (seeVal < 0 && stand + seeVal <= alpha) continue;
        }
        this.moveStack[ply] = mv;
        pos.make(mv);
        if (pos.isSquareAttacked(pos.kingSq[mover], pos.side)) {
          pos.unmake();
          continue;
        }
        legal++;
        const score = -this.negamax(pos, 0, -beta, -alpha, ply + 1);
        pos.unmake();
        if (this.aborted) return 0;
        if (score >= beta) return beta;
        if (score > alpha) alpha = score;
      }
      if (inCheck && !legal) return -MATE + ply;
      return alpha;
    }

    orderMoves(pos, buf, n, ply, ttMove = 0) {
      const b = pos.board;
      const killers = this.killers[ply];
      const prev = ply > 0 ? this.moveStack[ply - 1] : 0;
      const prevTo = (prev >> 6) & 63;
      const prevIdx = prev ? ((prev & 63) << 6) | prevTo : 0;
      const counter = prev ? this.counterMoves[prevIdx] : 0;
      for (let i = 0; i < n; i++) {
        const mv = buf[i];
        const from = mv & 63, to = (mv >> 6) & 63;
        const attacker = b[from];
        const promo = (mv >> 12) & 7;
        let victim = b[to];
        if (!victim && (attacker & 7) === PAWN && to === pos.ep) victim = pos.side === WHITE ? 9 : 1;
        let s;
        if (mv === ttMove) s = 30000;
        else if (victim) s = 20000 + VALUE[victim & 7] * 10 - VALUE[attacker & 7];
        else if (promo) s = 18000 + VALUE[promo];
        else if (mv === killers[0]) s = 15000;
        else if (mv === killers[1]) s = 14500;
        else if (mv === counter) s = 14000;
        else {
          const h = this.history[from * 64 + to] || 0;
          const f = prev ? (this.followHistory[prevTo * 64 + to] || 0) : 0;
          s = Math.min(13000, h + (f >> 1));
        }
        buf[i] = mv;
        this._scores[i] = s;
      }
      // insertion sort desc
      const scores = this._scores;
      for (let i = 1; i < n; i++) {
        const mv = buf[i], sc = scores[i];
        let j = i - 1;
        while (j >= 0 && scores[j] < sc) {
          buf[j + 1] = buf[j];
          scores[j + 1] = scores[j];
          j--;
        }
        buf[j + 1] = mv;
        scores[j + 1] = sc;
      }
    }
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    const buf = new Int32Array(256);
    const n = pos.generateMoves(buf, false);
    const mover = pos.side;
    let total = 0;
    for (let i = 0; i < n; i++) {
      pos.make(buf[i]);
      if (!pos.isSquareAttacked(pos.kingSq[mover], pos.side)) total += perft(pos, depth - 1);
      pos.unmake();
    }
    return total;
  }

  const api = { Position, Engine, perft, evaluate, evaluateUncached, see, squareName, squareIndex, uci, positionKey, hashKey, playProfile, selectCandidate, START_FEN, WHITE, BLACK, MATE };
  global.NyxChess = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
