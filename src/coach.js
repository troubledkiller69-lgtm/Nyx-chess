/* NyxCoach - advisory coach presentation built from NyxChess results.
   Reads a position and an existing Nyx search result. Never searches, scores,
   selects a different move, mutates the board, or executes anything.

   The result object is the one produced by NyxChess.Engine.think():
     { move, best, bestMove, score, mate, depth, nodes, time, scoreSource,
       exactScores, legalMoves, blundered, blunderLoss, lines }
   No principal variation is exposed by that result, so this module never
   predicts or invents an expected reply. */
(function (global) {
  'use strict';

  const VERSION = 1;
  const HINT_LEVELS = ['concept', 'piece', 'move'];
  const PIECE_LETTERS = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
  const PIECE_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
  const PIECE_VALUES = [0, 1, 3, 3, 5, 9, 0];
  const FILES = 'abcdefgh';
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;

  function chess() {
    return global.NyxChess || null;
  }

  function sideName(color) {
    return color === 'b' ? 'Black' : 'White';
  }

  function otherColor(color) {
    return color === 'b' ? 'w' : 'b';
  }

  function colorOf(piece) {
    return piece > 8 ? 'b' : 'w';
  }

  function typeOf(piece) {
    return piece & 7;
  }

  function squareName(square) {
    return FILES[square & 7] + ((square >> 3) + 1);
  }

  function squareFile(square) {
    return square & 7;
  }

  function squareRank(square) {
    return (square >> 3) + 1;
  }

  function pieceLetter(piece) {
    return PIECE_LETTERS[typeOf(piece)] || '';
  }

  function pieceName(piece) {
    return PIECE_NAMES[typeOf(piece)] || 'piece';
  }

  function pieceValue(piece) {
    return PIECE_VALUES[typeOf(piece)] || 0;
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeFen(fen) {
    return typeof fen === 'string' ? fen.trim().replace(/\s+/g, ' ') : '';
  }

  function positionKey(fen) {
    const normalized = normalizeFen(fen);
    const C = chess();
    if (C && typeof C.positionKey === 'function') {
      try { return C.positionKey(normalized); } catch { /* fall through */ }
    }
    return normalized.split(' ').slice(0, 4).join(' ');
  }

  function keyFor(fen, revision) {
    return positionKey(fen) + '|' +
      (revision === undefined || revision === null ? '' : String(revision));
  }

  function isStale(guidance, fen, revision) {
    return !guidance || typeof guidance.key !== 'string' ||
      guidance.key !== keyFor(fen, revision);
  }

  function makePosition(fen) {
    const C = chess();
    if (!C || typeof C.Position !== 'function') {
      return { error: 'unsupported', message: 'NyxChess is not loaded.' };
    }
    try {
      return { position: new C.Position(normalizeFen(fen)) };
    } catch {
      return { error: 'invalid-position', message: 'Not a legal six-field FEN.' };
    }
  }

  // Legal moves for either colour. The side that is not to move is evaluated
  // after a null pass; this is used only for attack/threat display, never for
  // choosing a move. Captures of a king are filtered by callers.
  function movesForColor(position, color) {
    if (position.side === color) return position.legalMoves();
    const copy = position.clone();
    copy.makeNull();
    return copy.legalMoves();
  }

  function rayClear(position, from, to) {
    const fromFile = squareFile(from), fromRank = from >> 3;
    const toFile = squareFile(to), toRank = to >> 3;
    const stepFile = Math.sign(toFile - fromFile);
    const stepRank = Math.sign(toRank - fromRank);
    let file = fromFile + stepFile;
    let rank = fromRank + stepRank;
    while (file !== toFile || rank !== toRank) {
      if (position.board[rank * 8 + file]) return false;
      file += stepFile;
      rank += stepRank;
    }
    return true;
  }

  // Geometric attacks, including squares occupied by friendly pieces. Used for
  // defenders, where legal-move generation cannot capture its own piece.
  function geometricAttackers(position, target, byColor) {
    const found = [];
    const targetFile = squareFile(target);
    const targetRank = target >> 3;
    const white = byColor === 'w';
    for (let square = 0; square < 64; square++) {
      const piece = position.board[square];
      if (!piece || square === target || colorOf(piece) !== byColor) continue;
      const type = typeOf(piece);
      const file = squareFile(square);
      const rank = square >> 3;
      const df = targetFile - file;
      const dr = targetRank - rank;
      let attacks = false;
      if (type === PAWN) {
        attacks = white ? (dr === 1 && Math.abs(df) === 1) : (dr === -1 && Math.abs(df) === 1);
      } else if (type === KNIGHT) {
        attacks = (Math.abs(df) === 2 && Math.abs(dr) === 1) ||
          (Math.abs(df) === 1 && Math.abs(dr) === 2);
      } else if (type === KING) {
        attacks = Math.max(Math.abs(df), Math.abs(dr)) === 1;
      } else {
        const diagonal = df !== 0 && Math.abs(df) === Math.abs(dr);
        const straight = (df === 0) !== (dr === 0);
        const ray = (type === BISHOP && diagonal) || (type === ROOK && straight) ||
          (type === QUEEN && (diagonal || straight));
        if (ray) attacks = rayClear(position, square, target);
      }
      if (attacks) found.push(squareName(square));
    }
    return found;
  }

  function unique(list) {
    return Array.from(new Set(list));
  }

  function legalAttackers(position, target, byColor, movesCache) {
    const moves = movesCache && movesCache[byColor]
      ? movesCache[byColor]
      : movesForColor(position, byColor);
    return unique(moves
      .filter((move) => ((move >> 6) & 63) === target)
      // A move that captures a king is not a legal move; it only appears after
      // a null pass. Callers handling a king target use isSquareAttacked.
      .filter((move) => typeOf(position.board[(move >> 6) & 63]) !== KING)
      .map((move) => squareName(move & 63)));
  }

  function promotedLetter(promotion) {
    return PIECE_LETTERS[promotion] ? PIECE_LETTERS[promotion].toLowerCase() : null;
  }

  function describeMove(position, move) {
    const C = chess();
    if (!C || !Number.isInteger(move)) return null;
    const legal = position.legalMoves();
    if (!legal.includes(move)) return null;

    const from = move & 63;
    const to = (move >> 6) & 63;
    const promotion = (move >> 12) & 7;
    const piece = position.board[from];
    if (!piece) return null;
    const color = colorOf(piece);
    const type = typeOf(piece);

    const directTarget = position.board[to];
    const enPassant = type === PAWN && to === position.ep && !directTarget;
    const capturedSquare = enPassant
      ? (color === 'w' ? to - 8 : to + 8)
      : to;
    const capturedPiece = enPassant ? position.board[capturedSquare] : directTarget;
    const castle = type === KING && Math.abs(to - from) === 2
      ? (to > from ? 'k' : 'q')
      : null;

    let san;
    if (castle) {
      san = castle === 'k' ? 'O-O' : 'O-O-O';
    } else {
      const letter = type === PAWN ? '' : PIECE_LETTERS[type];
      let disambiguation = '';
      if (type !== PAWN && type !== KING) {
        const rivals = legal.filter((candidate) => candidate !== move &&
          ((candidate >> 6) & 63) === to &&
          typeOf(position.board[candidate & 63]) === type);
        if (rivals.length) {
          const file = squareFile(from);
          const rank = squareRank(from);
          const sameFile = rivals.some((candidate) => squareFile(candidate & 63) === file);
          const sameRank = rivals.some((candidate) => squareRank(candidate & 63) === rank);
          if (!sameFile) disambiguation = FILES[file];
          else if (!sameRank) disambiguation = String(rank);
          else disambiguation = squareName(from);
        }
      }
      const captureMark = capturedPiece ? 'x' : '';
      const destination = squareName(to);
      if (type === PAWN) {
        san = captureMark ? FILES[squareFile(from)] + 'x' + destination : destination;
      } else {
        san = letter + disambiguation + captureMark + destination;
      }
      if (promotion) san += '=' + PIECE_LETTERS[promotion];
    }

    const after = position.clone();
    after.make(move);
    const opponent = otherColor(color);
    const check = after.inCheck(opponent === 'w' ? 1 : 2);
    const mate = check && after.legalMoves().length === 0;
    san += mate ? '#' : check ? '+' : '';

    return {
      uci: C.uci(move),
      from: squareName(from),
      to: squareName(to),
      promotion: promotion ? promotedLetter(promotion) : null,
      san,
      piece: PIECE_LETTERS[type],
      pieceName: PIECE_NAMES[type],
      color,
      capture: capturedPiece ? {
        square: squareName(capturedSquare),
        piece: pieceLetter(capturedPiece),
        pieceName: pieceName(capturedPiece),
        value: pieceValue(capturedPiece),
        enPassant: enPassant
      } : null,
      castle,
      check,
      mate,
      enPassant,
      score: null,
      scoreComparable: false
    };
  }

  function resolveWithPosition(position, token) {
    const C = chess();
    if (!C || token === null || token === undefined) return null;
    const raw = typeof token === 'object'
      ? (token.uci ?? token.san ?? token.move)
      : token;
    if (raw === null || raw === undefined) return null;

    if (Number.isInteger(raw)) {
      const legal = position.legalMoves();
      return legal.includes(raw) ? describeMove(position, raw) : null;
    }

    const text = String(raw).trim();
    if (!text) return null;

    // Coordinate notation first. It is unambiguous and needs no SAN guessing.
    const compact = text.replace(/\s+/g, '');
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(compact)) {
      const wanted = compact.toLowerCase();
      const legal = position.legalMoves();
      const move = legal.find((candidate) => C.uci(candidate).toLowerCase() === wanted);
      return move === undefined ? null : describeMove(position, move);
    }

    // SAN. Normalize castling and result punctuation, then require a single
    // legal match. Ambiguous input is rejected rather than guessed.
    let san = text.replace(/0/g, 'O').replace(/\s+/g, '')
      .replace(/e\.p\.?$/i, '')
      .replace(/[+#!?]/g, '');
    if (/^o-o-o$/i.test(san)) san = 'O-O-O';
    else if (/^o-o$/i.test(san)) san = 'O-O';

    const legal = position.legalMoves();
    const strict = [];
    const loose = [];
    for (const move of legal) {
      const description = describeMove(position, move);
      if (!description) continue;
      const candidate = description.san.replace(/[+#]/g, '');
      if (candidate === san) strict.push(move);
      if (candidate.replace(/=/g, '').toLowerCase() === san.replace(/=/g, '').toLowerCase()) {
        loose.push(move);
      }
    }
    if (strict.length === 1) return describeMove(position, strict[0]);
    if (!strict.length && loose.length === 1) return describeMove(position, loose[0]);
    return null;
  }

  function resolveMove(fen, token) {
    const parsed = makePosition(fen);
    if (parsed.error) return null;
    return resolveWithPosition(parsed.position, token);
  }

  function resultMoveToken(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.move !== undefined && result.move !== null) return result.move;
    if (result.move === null) return null;
    if (Number.isInteger(result.best)) return result.best;
    if (Number.isInteger(result.bestMove)) return result.bestMove;
    if (typeof result.bestMove === 'string') return result.bestMove;
    if (typeof result.best === 'string') return result.best;
    return null;
  }

  function hasScore(result) {
    if (!result) return false;
    const mate = numberOrNull(result.mate);
    if (mate !== null && mate !== 0) return true;
    return numberOrNull(result.score) !== null;
  }

  function scoreType(result) {
    if (!result) return 'none';
    const mate = numberOrNull(result.mate);
    if (mate !== null && mate !== 0) return 'mate';
    if (numberOrNull(result.score) !== null) return 'cp';
    return 'none';
  }

  function scoreText(result, side) {
    if (!result) return null;
    const knownSide = side === 'w' || side === 'b';
    const owner = knownSide ? ' for ' + sideName(side) : '';
    const mate = numberOrNull(result.mate);
    if (mate !== null && mate !== 0) {
      const distance = Math.abs(mate);
      return mate > 0
        ? 'Nyx reports mate in ' + distance + owner + '.'
        : 'Nyx reports mate in ' + distance + ' against ' +
          (knownSide ? sideName(side) : 'the side to move') + '.';
    }
    const score = numberOrNull(result.score);
    if (score === null) return null;
    const pawns = (score / 100).toFixed(2);
    return 'Nyx score ' + (score > 0 ? '+' : '') + pawns + owner + '.';
  }

  function isEndgame(position) {
    let nonPawnMaterial = 0;
    let pieces = 0;
    let queens = 0;
    for (let square = 0; square < 64; square++) {
      const piece = position.board[square];
      if (!piece) continue;
      pieces++;
      const type = typeOf(piece);
      if (type === KING) continue;
      if (type === PAWN) {
        nonPawnMaterial += 1;
        continue;
      }
      const value = type === QUEEN ? 9 : type === ROOK ? 5 : 3;
      nonPawnMaterial += value;
      if (type === QUEEN) queens++;
    }
    return pieces <= 8 || (queens === 0 && nonPawnMaterial <= 14);
  }

  function conceptFor(position, move, inCheck) {
    if (!move) return 'game-over';
    if (inCheck) return 'king-safety';
    if (move.castle) return 'king-safety';
    if (move.mate || move.check) return 'forcing';
    if (move.capture) return 'material';
    if (move.promotion) return 'promotion';
    if (isEndgame(position)) return 'endgame';
    const full = numberOrNull(position.full);
    if (full !== null && full <= 10) return 'development';
    return 'activity';
  }

  const CONCEPT_TEXT = {
    'king-safety': 'Look at king safety first: checks, loose pieces around the king, and escape squares.',
    'forcing': 'Look for forcing moves - checks first, then captures, then direct threats.',
    'material': 'Look at what is undefended. There may be a capture worth calculating.',
    'promotion': 'Look at pawn promotion. Calculate the square it lands on and the reply.',
    'development': 'Look at your undeveloped pieces and the centre. Finish development before starting an attack.',
    'endgame': 'Look at king activity and pawn races. In the endgame the king is a fighting piece.',
    'activity': 'Look at your least active piece. Improve it before committing to a plan.',
    'game-over': 'The game is over. There is no move to suggest.'
  };

  function buildHint(position, move, level, inCheck, status) {
    const normalizedLevel = HINT_LEVELS.includes(level) ? level : 'concept';
    const gameOver = status === 'terminal';
    const conceptKey = gameOver
      ? 'game-over'
      : move ? conceptFor(position, move, inCheck) : 'activity';
    let text = gameOver
      ? CONCEPT_TEXT['game-over']
      : CONCEPT_TEXT[conceptKey] || CONCEPT_TEXT.activity;
    let piece = null;
    let revealedMove = null;

    if (!gameOver && !move) {
      text = 'No full move is available to reveal. Look at the board, the king, and the listed threats.';
    }
    if (move && normalizedLevel !== 'concept') {
      piece = {
        letter: move.piece,
        name: move.pieceName,
        text: 'Start with your ' + move.pieceName + '.'
      };
      if (normalizedLevel === 'piece') text += ' ' + piece.text;
    }
    if (move && normalizedLevel === 'move') {
      revealedMove = {
        uci: move.uci,
        san: move.san,
        text: 'Suggested move: ' + move.san + ' (' + move.uci + ').'
      };
      text += ' ' + (piece ? piece.text + ' ' : '') + revealedMove.text;
    }
    return {
      level: normalizedLevel,
      conceptKey,
      text,
      piece,
      move: revealedMove,
      fullMoveAvailable: Boolean(move)
    };
  }

  function buildSafety(position, legalMoves) {
    const movesCache = {
      w: position.side === 1 ? legalMoves : movesForColor(position, 'w'),
      b: position.side === 2 ? legalMoves : movesForColor(position, 'b')
    };
    const own = [];
    const enemy = [];
    const sideToMove = position.side === 1 ? 'w' : 'b';

    function classify(square) {
      const piece = position.board[square];
      if (!piece) return null;
      const color = colorOf(piece);
      const enemyColor = otherColor(color);
      let attackers;
      let attacked;
      if (typeOf(piece) === KING) {
        attacked = position.isSquareAttacked(square, enemyColor === 'w' ? 1 : 2);
        attackers = geometricAttackers(position, square, enemyColor);
      } else {
        attackers = legalAttackers(position, square, enemyColor, movesCache);
        attacked = attackers.length > 0;
      }
      const defenders = geometricAttackers(position, square, color);
      const hanging = attacked && defenders.length === 0;
      return {
        square: squareName(square),
        piece: pieceLetter(piece),
        pieceName: pieceName(piece),
        color,
        value: pieceValue(piece),
        attacked,
        defended: defenders.length > 0,
        hanging,
        status: hanging ? 'hanging' : attacked ? 'attacked' : defenders.length ? 'defended' : 'quiet',
        attackers,
        defenders
      };
    }

    for (let square = 0; square < 64; square++) {
      if (!position.board[square]) continue;
      const entry = classify(square);
      if (!entry) continue;
      if (entry.color === sideToMove) own.push(entry);
      else enemy.push(entry);
    }
    return { own, enemy };
  }

  function buildThreats(position, side, includeThreats) {
    const inCheck = position.inCheck(side === 'w' ? 1 : 2);
    const kingSquare = position.kingSq[side === 'w' ? 1 : 2];
    const king = {
      square: kingSquare >= 0 ? squareName(kingSquare) : null,
      attackedBy: kingSquare >= 0
        ? geometricAttackers(position, kingSquare, otherColor(side))
        : [],
      inCheck
    };
    if (!includeThreats) return { inCheck, king, immediate: [] };

    const opponent = otherColor(side);
    const threatPosition = position.clone();
    threatPosition.makeNull();
    const opponentMoves = threatPosition.legalMoves();
    const captures = [];
    const checks = [];

    for (const move of opponentMoves) {
      const from = move & 63;
      const to = (move >> 6) & 63;
      const piece = position.board[from];
      const targetPiece = position.board[to];
      if (targetPiece && typeOf(targetPiece) === KING) continue; // king capture is not legal
      const enPassant = typeOf(piece) === PAWN && to === position.ep && !targetPiece;
      const isCapture = Boolean(targetPiece) || enPassant;
      const description = describeMove(threatPosition, move);
      if (!description) continue;

      if (isCapture) {
        const capturedSquare = enPassant
          ? (colorOf(piece) === 'w' ? to - 8 : to + 8)
          : to;
        const defenders = geometricAttackers(position, capturedSquare, side);
        const capturedPiece = enPassant ? position.board[capturedSquare] : targetPiece;
        captures.push({
          kind: 'capture',
          from: description.from,
          to: description.to,
          san: description.san,
          piece: description.piece,
          pieceName: description.pieceName,
          attackerValue: pieceValue(piece),
          target: {
            square: squareName(capturedSquare),
            piece: capturedPiece ? pieceLetter(capturedPiece) : 'P',
            pieceName: capturedPiece ? pieceName(capturedPiece) : 'pawn',
            value: capturedPiece ? pieceValue(capturedPiece) : 1,
            defended: defenders.length > 0,
            hanging: defenders.length === 0
          },
          // Plain language, explicitly hypothetical: this is a legal move if
          // the turn passed, never a prediction of the opponent's reply.
          text: 'If ' + sideName(opponent) + ' had the turn, its ' + description.pieceName +
            ' on ' + description.from + ' could capture the ' + (capturedPiece ? pieceName(capturedPiece) : 'pawn') +
            ' on ' + squareName(capturedSquare) + ' (' + description.san + ').',
          legal: true
        });
      }

      threatPosition.make(move);
      const givesCheck = threatPosition.inCheck(side === 'w' ? 1 : 2);
      threatPosition.unmake();
      if (givesCheck) {
        checks.push({
          kind: 'check',
          from: description.from,
          to: description.to,
          san: description.san,
          piece: description.piece,
          pieceName: description.pieceName,
          target: null,
          text: 'If ' + sideName(opponent) + ' had the turn, its ' + description.pieceName +
            ' on ' + description.from + ' could give check with ' + description.san + '.',
          legal: true
        });
      }
    }

    captures.sort((a, b) => (b.target.value - a.target.value) ||
      (a.attackerValue - b.attackerValue));

    const immediate = captures.slice(0, 12).concat(checks.slice(0, 6));
    return { inCheck, king, immediate };
  }

  function buildAnalysis(result, legalMovesAvailable, side) {
    const depth = result ? numberOrNull(result.depth) : null;
    const scoreSource = result && result.scoreSource ? String(result.scoreSource) : null;
    let completeness = 'missing';
    if (result) completeness = depth !== null && depth > 0 && scoreSource !== 'static'
      ? 'searched'
      : 'static-only';
    return {
      source: 'nyx-engine',
      depth,
      timeMs: result ? numberOrNull(result.time) : null,
      nodes: result ? numberOrNull(result.nodes) : null,
      legalMoves: result ? numberOrNull(result.legalMoves) : null,
      positionLegalMoves: legalMovesAvailable,
      scoreSource,
      exactScores: Boolean(result && result.exactScores),
      blundered: Boolean(result && result.blundered),
      blunderLoss: result ? numberOrNull(result.blunderLoss) : null,
      searchCompleteness: completeness,
      score: {
        type: scoreType(result),
        value: result
          ? (scoreType(result) === 'mate' ? numberOrNull(result.mate) : numberOrNull(result.score))
          : null,
        text: result ? scoreText(result, side) : null
      },
      linesAvailable: result && Array.isArray(result.lines) ? result.lines.length : 0,
      pv: null
    };
  }

  function buildExplanation(position, move, result, side, analysis, inCheck, second, status) {
    let category = 'unavailable';
    let headline = 'No Nyx result was supplied for this position.';
    const points = [];

    if (status === 'terminal') {
      const checkmate = inCheck;
      category = 'game-over';
      headline = checkmate ? 'Checkmate. The game is over.' : 'Stalemate. The game is over.';
      points.push(checkmate
        ? 'The side to move has no legal move and is in check.'
        : 'The side to move has no legal move and is not in check.');
    } else if (status === 'invalid-result') {
      headline = 'The supplied analysis move is not legal in this position, so no suggestion is shown.';
    } else if (move) {
      if (result && result.blundered) {
        category = move.capture ? 'capture' : move.check ? 'check' : 'positional';
        headline = 'Advisory only: this is a deliberately degraded suggestion, not Nyx\'s top move.';
      } else if (move.mate) {
        category = 'mate';
        headline = move.san + ' delivers checkmate.';
      } else if (move.check) {
        category = 'check';
        headline = move.san + ' gives check.';
      } else if (move.capture) {
        category = 'capture';
        headline = move.san + ' captures the ' + move.capture.pieceName +
          ' on ' + move.capture.square + '.';
      } else if (move.promotion) {
        category = 'promotion';
        headline = move.san + ' promotes the pawn to a ' + move.promotion + '.';
      } else if (move.castle) {
        category = 'castle';
        headline = move.san + ' castles ' + (move.castle === 'k' ? 'kingside' : 'queenside') + '.';
      } else if (analysis.score.type === 'mate' && analysis.score.value !== null) {
        if (analysis.score.value > 0) {
          category = 'mate';
          headline = 'Nyx reports a forced mate for ' + sideName(side) + '.';
        } else {
          category = 'defensive';
          headline = 'Nyx reports a forced mate against ' + sideName(side) + '.';
        }
      } else if (inCheck) {
        category = 'defensive';
        headline = 'You are in check. ' + move.san + ' is a legal way out.';
      } else if (isEndgame(position)) {
        category = 'endgame';
        headline = move.san + ' is the advisory pick in this endgame.';
      } else {
        category = 'positional';
        headline = move.san + ' is the search\'s advisory pick in this position.';
      }

      if (analysis.depth !== null && analysis.depth > 0) {
        let search = 'Nyx completed depth ' + analysis.depth;
        if (analysis.nodes !== null) search += ' with ' + analysis.nodes + ' nodes';
        if (analysis.timeMs !== null) search += ' in ' + analysis.timeMs + ' ms';
        points.push(search + '.');
      } else {
        points.push('No search iteration completed; the ranking comes from the static fallback.');
      }
      if (move.capture) {
        points.push('It captures the ' + move.capture.pieceName +
          ' on ' + move.capture.square + '.');
      }
      if (move.castle) {
        points.push('It moves the king to safety and activates the rook.');
      }
      if (move.promotion) {
        points.push('The pawn is promoted to a ' + move.promotion + '.');
      }
      if (analysis.score.text) points.push(analysis.score.text);
      if (analysis.blundered && analysis.blunderLoss !== null) {
        points.push('Simulated error: about ' + analysis.blunderLoss +
          ' centipawns below the supplied top move.');
      }
      if (second) {
        points.push('An alternative suggestion with a comparable score is ' + second.san + '.');
      }
    } else if (result) {
      headline = 'Nyx returned no legal move for this position.';
    }

    return {
      category,
      headline,
      points: points.slice(0, 6),
      scoreText: scoreText(result, side)
    };
  }

  function buildHighlights(suggestion, second, threats, safety, inCheck, moveSide) {
    const arrows = [];
    const squares = [];
    const seen = new Set();

    function arrow(from, to, kind) {
      if (!from || !to) return;
      const key = kind + ':' + from + to;
      if (seen.has(key)) return;
      seen.add(key);
      arrows.push({ from, to, kind });
    }

    function mark(square, kind, side) {
      if (!square) return;
      const key = kind + ':' + square;
      if (seen.has(key)) return;
      seen.add(key);
      squares.push({ square, kind, side: side || null });
    }

    if (suggestion) {
      arrow(suggestion.from, suggestion.to, 'suggestion');
      mark(suggestion.from, 'suggestion-from', suggestion.color);
      mark(suggestion.to, 'suggestion-to', suggestion.color);
    }
    if (second) {
      arrow(second.from, second.to, 'candidate');
      mark(second.from, 'candidate-from', second.color);
      mark(second.to, 'candidate-to', second.color);
    }
    // Keep the board readable: a handful of capture/check threats, not every
    // legal opponent move. The full list remains in guidance.threats.
    for (const threat of threats.immediate.slice(0, 3)) {
      arrow(threat.from, threat.to, 'threat');
      mark(threat.to, 'threat', moveSide);
    }
    // Mark only actionable conditions. The full defended/quiet classification
    // stays in `safety` and does not flood the board with marks.
    for (const entry of safety.own.concat(safety.enemy)) {
      if (entry.status !== 'hanging' && entry.status !== 'attacked') continue;
      mark(entry.square, entry.status, entry.color);
    }
    if (inCheck && threats.king.square) mark(threats.king.square, 'king-check', moveSide);
    return { arrows: arrows.slice(0, 24), squares: squares.slice(0, 64) };
  }

  function feedbackUnrated(reason, played, best, beforeDepth, afterDepth) {
    return {
      status: 'unrated',
      source: null,
      played: played ? { uci: played.uci, san: played.san } : null,
      best: best ? { uci: best.uci, san: best.san } : null,
      matched: false,
      comparable: false,
      beforeDepth,
      afterDepth,
      beforeScore: null,
      afterScore: null,
      loss: null,
      verdict: 'unrated',
      reason
    };
  }

  function buildFeedback(options = {}) {
    options = options || {};
    const parsedBefore = makePosition(options.beforeFen);
    const parsedAfter = makePosition(options.afterFen);
    if (parsedBefore.error || parsedAfter.error) {
      return feedbackUnrated('Both positions are needed to compare the searches.', null, null, null, null);
    }
    const before = options.before;
    const after = options.after;
    if (!before || typeof before !== 'object') {
      return feedbackUnrated('No before-move analysis is available.', null, null, null, null);
    }

    const played = resolveWithPosition(parsedBefore.position, options.played);
    const best = resolveWithPosition(parsedBefore.position, resultMoveToken(before));
    if (!played) {
      return feedbackUnrated('The played move could not be resolved legally in the before position.',
        null, best, numberOrNull(before.depth), after ? numberOrNull(after.depth) : null);
    }
    if (!best) {
      return feedbackUnrated('The before analysis does not contain a legal move to compare against.',
        played, null, numberOrNull(before.depth), after ? numberOrNull(after.depth) : null);
    }

    const beforeDepth = numberOrNull(before.depth);
    const afterDepth = after ? numberOrNull(after.depth) : null;

    // Pair the evidence to the actual move: the supplied after position must
    // be the position the played move produces. Otherwise the two searches are
    // describing different moments and cannot be subtracted.
    const C = chess();
    const playedInteger = C ? parsedBefore.position.legalMoves()
      .find((move) => C.uci(move) === played.uci) : undefined;
    if (playedInteger === undefined) {
      return feedbackUnrated('The played move could not be resolved legally in the before position.',
        played, best, beforeDepth, afterDepth);
    }
    const applied = parsedBefore.position.clone();
    applied.make(playedInteger);
    if (positionKey(applied.fen()) !== positionKey(options.afterFen)) {
      return feedbackUnrated('The after position does not match the played move, so the searches cannot be paired.',
        played, best, beforeDepth, afterDepth);
    }

    // Reuse NyxReview for score normalization and verdict bands. Without it the
    // move is explicitly unrated rather than graded by a private scale.
    const review = global.NyxReview;
    if (!review || typeof review.normalizeScore !== 'function' ||
        typeof review.verdictFor !== 'function') {
      return feedbackUnrated('NyxReview is not loaded; post-move grading is unavailable.',
        played, best, beforeDepth, afterDepth);
    }

    const matched = played.uci === best.uci;
    const afterPositionTerminal = parsedAfter.position.legalMoves().length === 0;
    const afterTerminal = Boolean(after && after.move === null) || afterPositionTerminal;
    const afterMate = Boolean(after && numberOrNull(after.mate) !== null &&
      numberOrNull(after.mate) !== 0);
    const comparable = matched || afterTerminal || afterMate ||
      (beforeDepth !== null && beforeDepth > 0 &&
       afterDepth !== null && beforeDepth === afterDepth);

    if (!comparable) {
      return feedbackUnrated(
        'The two searches are not comparable (different completed depths and no exact terminal/mate or matched move).',
        played, best, beforeDepth, afterDepth);
    }
    if (!after && !matched) {
      return feedbackUnrated('No after-move analysis is available for comparison.',
        played, best, beforeDepth, afterDepth);
    }
    if (!matched && !hasScore(before)) {
      return feedbackUnrated('The before analysis has no comparable score.',
        played, best, beforeDepth, afterDepth);
    }
    if (!matched && !hasScore(after)) {
      return feedbackUnrated('The after analysis has no comparable score.',
        played, best, beforeDepth, afterDepth);
    }

    const beforeScore = review.normalizeScore(before);
    const afterScore = after ? -review.normalizeScore(after) : matched ? beforeScore : null;
    const loss = matched ? 0 : Math.max(0, Math.round(beforeScore - afterScore));
    return {
      status: 'rated',
      source: 'NyxReview',
      played: { uci: played.uci, san: played.san },
      best: { uci: best.uci, san: best.san },
      matched,
      comparable: true,
      beforeDepth,
      afterDepth,
      beforeScore,
      afterScore,
      loss,
      verdict: matched ? review.verdictFor(0) : review.verdictFor(loss),
      reason: null
    };
  }

  function baseGuidance(fen, revision) {
    return {
      version: VERSION,
      api: 'NyxCoach',
      status: 'unsupported',
      advisory: true,
      executesMoves: false,
      fen: typeof fen === 'string' ? fen : '',
      revision: revision === undefined ? null : revision,
      key: keyFor(fen, revision),
      side: null,
      turn: null,
      moveNumber: null,
      hints: {
        defaultMode: 'arrow',
        modes: ['arrow', 'staged'],
        legend: 'Gold arrow: suggested move. Rust marks: captures the opponent could play if the turn passed, not a predicted reply.'
      },
      suggestion: null,
      second: null,
      hint: {
        level: 'concept',
        conceptKey: 'activity',
        text: CONCEPT_TEXT.activity,
        piece: null,
        move: null,
        fullMoveAvailable: false
      },
      explanation: {
        category: 'unavailable',
        headline: 'No guidance is available.',
        points: [],
        scoreText: null
      },
      analysis: buildAnalysis(null, null, null),
      threats: {
        inCheck: false,
        king: { square: null, attackedBy: [], inCheck: false },
        immediate: []
      },
      safety: { own: [], enemy: [] },
      highlights: { arrows: [], squares: [] },
      feedback: null,
      evidence: {
        basis: [],
        pv: null,
        limitations: [
          'Advisory only; NyxCoach does not execute moves.',
          'No principal variation is exposed by NyxChess results; no expected reply is predicted.'
        ]
      },
      warnings: []
    };
  }

  function pickSecond(position, result, suggestion) {
    if (!result || result.blundered || result.exactScores !== true ||
        !Array.isArray(result.lines) || !suggestion) return null;
    for (const line of result.lines) {
      if (!line || typeof line !== 'object') continue;
      const token = line.move ?? (Number.isInteger(line.best) ? line.best : null);
      if (token === null || token === undefined) continue;
      const description = resolveWithPosition(position, token);
      if (!description || description.uci === suggestion.uci) continue;
      const score = numberOrNull(line.score);
      if (score === null) continue;
      description.score = score;
      description.scoreComparable = true;
      return description;
    }
    return null;
  }

  function buildGuidance(fen, result, options = {}) {
    options = options || {};
    const revision = options.revision;
    const output = baseGuidance(fen, revision);
    const parsed = makePosition(fen);
    if (parsed.error === 'unsupported') {
      output.warnings.push('NyxChess is not loaded; coach guidance is unavailable.');
      output.evidence.limitations.push('NyxChess must be loaded before NyxCoach can read legal moves.');
      return output;
    }
    if (parsed.error) {
      output.status = 'invalid-position';
      output.warnings.push(parsed.message || 'Invalid position.');
      output.explanation.headline = 'The supplied position is not a legal FEN.';
      output.evidence.limitations.push('No legal moves, threats, or suggestion can be derived from an invalid position.');
      return output;
    }

    const position = parsed.position;
    const side = position.side === 1 ? 'w' : 'b';
    const legal = position.legalMoves();
    const inCheck = position.inCheck(position.side);
    output.fen = typeof fen === 'string' ? fen : position.fen();
    output.side = side;
    output.turn = sideName(side).toLowerCase();
    output.moveNumber = numberOrNull(position.full);
    output.key = keyFor(output.fen, revision);

    if (legal.length === 0) {
      output.status = 'terminal';
      output.threats = buildThreats(position, side, options.includeThreats !== false);
      output.analysis = buildAnalysis(result, 0, side);
      output.explanation = buildExplanation(position, null, result, side,
        output.analysis, inCheck, null, 'terminal');
      output.hint = buildHint(position, null, options.hintLevel, inCheck, 'terminal');
      output.highlights = buildHighlights(null, null, output.threats,
        output.safety, inCheck, side);
      output.evidence.basis.push(
        'Legal-move generation by NyxChess.',
        'Mate/stalemate checked from the terminal position.'
      );
      output.evidence.limitations.push('No move can be suggested from a terminal position.');
      return output;
    }

    output.threats = buildThreats(position, side, options.includeThreats !== false);
    output.safety = buildSafety(position, legal);

    if (!result || typeof result !== 'object') {
      output.status = 'no-suggestion';
      output.analysis = buildAnalysis(null, legal.length, side);
      output.hint = buildHint(position, null, options.hintLevel, inCheck, output.status);
      output.explanation = buildExplanation(position, null, null, side,
        output.analysis, inCheck, null, output.status);
      output.explanation.headline = 'No Nyx result was supplied for this position.';
      output.highlights = buildHighlights(null, null, output.threats,
        output.safety, inCheck, side);
      output.evidence.basis.push(
        'Legal-move generation by NyxChess.',
        'Threat and safety data from legal moves.'
      );
      output.evidence.limitations.push('No move suggestion, score, or move grade exists without a Nyx result.');
      return output;
    }

    const token = resultMoveToken(result);
    const suggestion = token === null ? null : resolveWithPosition(position, token);
    output.analysis = buildAnalysis(result, legal.length, side);
    output.analysis.score.text = scoreText(result, side);

    if (!suggestion) {
      output.status = 'invalid-result';
      output.warnings.push('The result move is not legal in this position; no suggestion was shown.');
      output.hint = buildHint(position, null, options.hintLevel, inCheck, output.status);
      output.explanation = buildExplanation(position, null, result, side,
        output.analysis, inCheck, null, output.status);
      output.highlights = buildHighlights(null, null, output.threats,
        output.safety, inCheck, side);
      output.evidence.basis.push(
        'Legal-move generation by NyxChess.',
        'The supplied move failed the legal-move check.'
      );
      output.evidence.limitations.push('A stale or mismatched analysis result must be discarded and rebuilt.');
      return output;
    }

    output.status = 'ready';
    output.suggestion = suggestion;
    // Advisory callers get the move arrow by default. Staged hint consumers
    // pass hintLevel: 'concept' or 'piece' explicitly.
    output.hint = buildHint(position, suggestion,
      options.hintLevel || 'move', inCheck, output.status);
    output.second = options.includeSecond === false
      ? null
      : pickSecond(position, result, suggestion);
    output.explanation = buildExplanation(position, suggestion, result, side,
      output.analysis, inCheck, output.second, output.status);
    output.highlights = buildHighlights(suggestion, output.second,
      output.threats, output.safety, inCheck, side);

    output.evidence.basis.push(
      'Legal-move generation by NyxChess.',
      'Move legality, captures, check, and mate are verified by making the move.',
      'Threats are legal opponent moves if the turn passed, not a predicted reply.',
      'Piece attack/defence comes from geometric attacks with legal-move confirmation for attacks.'
    );

    output.evidence.limitations.push(
      'Scores are bounded Nyx search estimates, not external-engine or tablebase truth.'
    );
    if (output.analysis.depth !== null && output.analysis.depth > 0) {
      output.evidence.limitations.push('Search completed to depth ' + output.analysis.depth +
        '; a deeper or longer search could rank moves differently.');
    } else {
      output.evidence.limitations.push('No search iteration completed; the ranking is a static fallback.');
    }
    if (output.analysis.exactScores) {
      output.evidence.limitations.push('Second-candidate scores are shown only because exact root scores were supplied.');
    } else {
      output.evidence.limitations.push('Root scores after the first candidate may be bounds, so no second candidate is shown.');
    }
    if (output.analysis.blundered) {
      output.evidence.limitations.push('The supplied move is a deliberate simulated error, not the engine top move.');
    }
    output.evidence.limitations.push('Defended counts geometric defenders; a pinned defender may be unable to recapture.');

    // Post-move feedback is optional and only exists when the caller supplies
    // the analysis of the position before the played move.
    const previous = options.previous;
    if (previous && typeof previous === 'object') {
      const played = previous.played ?? options.played;
      if (played === undefined || played === null) {
        output.warnings.push('previous.played is missing; post-move feedback was not built.');
      } else {
        output.feedback = buildFeedback({
          beforeFen: previous.fen,
          afterFen: output.fen,
          before: previous.result,
          after: result,
          played
        });
        if (output.feedback.status === 'unrated' && output.feedback.reason) {
          output.evidence.limitations.push('Post-move feedback: ' + output.feedback.reason);
        } else if (output.feedback.status === 'rated') {
          output.evidence.basis.push('Post-move grade compares two Nyx searches through NyxReview.');
        }
      }
    }

    output.evidence.limitations = unique(output.evidence.limitations);
    return output;
  }

  const api = {
    VERSION,
    HINT_LEVELS,
    buildGuidance,
    buildFeedback,
    resolveMove,
    isStale,
    keyFor,
    positionKey
  };

  global.NyxCoach = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
