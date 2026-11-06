(function (global) {
  'use strict';

  const MATE = 100000;
  const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900 };
  const STORAGE_KEY = 'nyxHumanOpeningMemory';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function randomValue(rng) {
    const draw = Number((typeof rng === 'function' ? rng : Math.random)());
    return Number.isFinite(draw) ? clamp(draw, 0, 1 - Number.EPSILON) : 0;
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function optionalNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeResult(result) {
    const text = String(result == null ? '' : result).trim().toLowerCase();
    if (['win', 'won', 'w', '1-0', '1'].includes(text)) return 'win';
    if (['loss', 'lose', 'lost', 'l', '0-1', '0', 'resigned', 'timeout', 'checkmated'].includes(text)) return 'loss';
    if (['draw', 'drew', 'd', '1/2-1/2', '½-½', '0.5'].includes(text)) return 'draw';
    return 'unknown';
  }

  function normalizeSide(side) {
    const text = String(side == null ? '' : side).toLowerCase();
    if (text === 'white' || text === 'w') return 'w';
    if (text === 'black' || text === 'b') return 'b';
    return 'any';
  }

  function normalizeLine(moves) {
    const tokens = Array.isArray(moves) ? moves : String(moves == null ? '' : moves).split(/\s+/);
    return tokens.map((move) => String(move).trim().toLowerCase()).filter(Boolean).join(' ');
  }

  // The serialized opening history only needs identity, not the full move list.
  function lineHash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function createSession(options) {
    options = options || {};
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const startedAt = Number.isFinite(Number(options.startedAt)) ? Number(options.startedAt) : Date.now();
    const declineRate = clamp(finiteNumber(options.declineRate, 0.06), 0.04, 0.08);
    const history = [];
    let gamesPlayed = 0;
    let consecutiveLosses = 0;
    let consecutiveWins = 0;
    let lastDecline = false;
    let breakAfter = 4 + Math.floor(randomValue(rng) * 6);
    let sinceBreak = 0;

    function summary() {
      return {
        gamesPlayed,
        startedAt,
        consecutiveLosses,
        consecutiveWins,
        breakAfter,
        sinceBreak,
        history: history.slice()
      };
    }

    function recordGame(game) {
      game = game || {};
      const result = normalizeResult(game.result);
      gamesPlayed++;
      sinceBreak++;
      if (result === 'loss') {
        consecutiveLosses++;
        consecutiveWins = 0;
      } else if (result === 'win') {
        consecutiveWins++;
        consecutiveLosses = 0;
      } else {
        consecutiveLosses = 0;
        consecutiveWins = 0;
      }
      history.push({
        result,
        moves: Math.max(0, Math.floor(finiteNumber(game.moves, 0))),
        accuracyHint: optionalNumber(game.accuracyHint),
        opponentRating: optionalNumber(game.opponentRating)
      });
      if (history.length > 50) history.shift();
      return summary();
    }

    function nextGameDelay(now) {
      const stamp = now instanceof Date ? now.getTime() : Number(now);
      const at = Number.isFinite(stamp) ? stamp : Date.now();
      const hour = new Date(at).getHours();
      const night = hour >= 0 && hour < 6;

      if (sinceBreak >= breakAfter) {
        sinceBreak = 0;
        breakAfter = 4 + Math.floor(randomValue(rng) * 6);
        // Night breaks keep the same 4-12 minute window but lean longer.
        const breakMs = (240000 + randomValue(rng) * 480000) * (night ? 1.15 : 1);
        return Math.round(clamp(breakMs, 240000, 720000));
      }

      const roll = randomValue(rng);
      const streakChance = consecutiveLosses >= 3 ? 0.28 : consecutiveLosses >= 2 ? 0.15 : 0;
      if (roll < streakChance + (night && consecutiveLosses >= 2 ? 0.05 : 0)) {
        const tiltMs = (90000 + randomValue(rng) * 150000) * (night ? 1.15 : 1);
        return Math.round(clamp(tiltMs, 90000, 240000));
      }

      let delay = 6000 + randomValue(rng) * 15000;
      let max = 25000;
      if (consecutiveLosses >= 3) {
        delay *= 1 + Math.min(0.5, (consecutiveLosses - 2) * 0.2);
        max = 60000;
      }
      if (night) delay *= 1.35;
      return Math.round(clamp(delay, 6000, max));
    }

    function shouldDeclineRematch(random) {
      if (lastDecline) {
        lastDecline = false;
        return false;
      }
      const decline = randomValue(typeof random === 'function' ? random : rng) < declineRate;
      lastDecline = decline;
      return decline;
    }

    return {
      nextGameDelay,
      recordGame,
      shouldDeclineRematch,
      stats: summary,
      get gamesPlayed() { return gamesPlayed; },
      get startedAt() { return startedAt; },
      get history() { return history.slice(); }
    };
  }

  function createOpeningMemory(storage, options) {
    options = options || {};
    const backend = storage && typeof storage.get === 'function' && typeof storage.set === 'function' ? storage : null;
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const recent = new Map();
    let games = 0;
    let writeQueue = Promise.resolve();

    function memoryKey(side, moves) {
      return normalizeSide(side) + ':' + lineHash(normalizeLine(moves));
    }

    function prune() {
      for (const [key, until] of recent) if (until <= games) recent.delete(key);
      if (recent.size > 96) {
        const oldest = [...recent].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < oldest.length - 96; i++) recent.delete(oldest[i][0]);
      }
    }

    function snapshot() {
      prune();
      return { v: 1, g: games, e: [...recent].map(([key, until]) => [key, until]) };
    }

    function readStored(raw) {
      let value = raw;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return null; }
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && STORAGE_KEY in value) {
        value = value[STORAGE_KEY];
      }
      if (!value || typeof value !== 'object' || value.v !== 1) return null;
      const storedGames = Math.max(0, Math.floor(finiteNumber(value.g, 0)));
      const source = Array.isArray(value.e) ? value.e
        : value.e && typeof value.e === 'object' ? Object.entries(value.e) : [];
      const entries = [];
      for (const entry of source) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const key = entry[0];
        const until = Math.floor(Number(entry[1]));
        if (typeof key !== 'string' || !key || key.length > 80 || !Number.isFinite(until)) continue;
        entries.push([key, until]);
      }
      return { games: storedGames, entries };
    }

    const ready = (backend ? Promise.resolve().then(() => backend.get(STORAGE_KEY)) : Promise.resolve(null))
      .then((raw) => {
        const stored = readStored(raw);
        if (!stored) return;
        games = Math.max(games, stored.games);
        for (const [key, until] of stored.entries) {
          if (until > games) recent.set(key, Math.max(recent.get(key) || 0, until));
        }
      })
      .catch(() => {});

    function persist() {
      if (!backend) return Promise.resolve();
      writeQueue = writeQueue
        .catch(() => {})
        .then(() => ready)
        .then(() => backend.set(snapshot()))
        .catch(() => {});
      return writeQueue;
    }

    function noteLine(side, moves, random) {
      const ttl = 8 + Math.floor(randomValue(typeof random === 'function' ? random : rng) * 5);
      games++;
      recent.set(memoryKey(side, moves), games + ttl);
      prune();
      return persist();
    }

    function weightedPick(candidates, side, random) {
      const list = Array.isArray(candidates)
        ? candidates.filter((candidate) => candidate && typeof candidate === 'object')
        : [];
      if (!list.length) return null;
      const pick = typeof random === 'function' ? random : rng;
      const weights = list.map((candidate) => {
        const line = candidate.line == null ? candidate.id : candidate.line;
        const until = recent.get(memoryKey(side, line));
        // A recent line is discouraged for 8-12 games, never excluded.
        return until && until > games ? 0.2 : 1;
      });
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let roll = randomValue(pick) * total;
      for (let i = 0; i < list.length; i++) {
        if (roll < weights[i]) return list[i];
        roll -= weights[i];
      }
      return list[list.length - 1];
    }

    return { noteLine, weightedPick, ready };
  }

  function readMaterial(fen) {
    if (typeof fen !== 'string') return null;
    const parts = fen.trim().split(/\s+/);
    const ranks = parts[0] ? parts[0].split('/') : [];
    if (ranks.length !== 8) return null;
    let white = 0;
    let black = 0;
    let whiteNonPawn = 0;
    let blackNonPawn = 0;
    for (const rank of ranks) {
      let squares = 0;
      for (const piece of rank) {
        if (piece >= '1' && piece <= '8') {
          squares += Number(piece);
          continue;
        }
        const lower = piece.toLowerCase();
        if (lower !== 'k' && !(lower in PIECE_VALUE)) return null;
        squares++;
        if (lower === 'k') continue;
        const value = PIECE_VALUE[lower];
        if (piece === lower) {
          black += value;
          if (lower !== 'p') blackNonPawn += value;
        } else {
          white += value;
          if (lower !== 'p') whiteNonPawn += value;
        }
      }
      if (squares !== 8) return null;
    }
    return {
      white,
      black,
      nonPawn: whiteNonPawn + blackNonPawn,
      side: parts[1] === 'b' ? 'b' : 'w'
    };
  }

  function isEndgameMaterial(material) {
    return Boolean(material && (material.nonPawn <= 2400 || material.white + material.black <= 2600));
  }

  function isEndgame(fen) {
    return isEndgameMaterial(readMaterial(fen));
  }

  function endgamePlan(fen, options) {
    options = options || {};
    const neutral = { drift: 0, repeatChance: 0, avoidStalemate: true, tradeDown: false };
    const material = readMaterial(fen);
    if (!isEndgameMaterial(material)) return neutral;
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const sideSign = material.side === 'b' ? -1 : 1;
    const supplied = Number(options.score);
    // Engine scores are from the side to move; material is a safe fallback.
    const score = clamp(Number.isFinite(supplied) ? supplied : (material.white - material.black) * sideSign, -MATE, MATE);
    const phase = clamp(1 - material.nonPawn / 6400, 0, 1);

    let plan;
    if (score >= 250) {
      const drift = Math.min(Math.round(randomValue(rng) * 40), Math.max(0, Math.round(score - 150)));
      plan = {
        drift,
        repeatChance: 0.01 + randomValue(rng) * 0.06,
        avoidStalemate: true,
        tradeDown: false
      };
    } else if (score <= -200) {
      plan = {
        drift: Math.round(8 + randomValue(rng) * 52 * (0.6 + 0.4 * phase)),
        repeatChance: 0.03 + randomValue(rng) * 0.09,
        avoidStalemate: false,
        tradeDown: true
      };
    } else {
      plan = {
        drift: Math.round(randomValue(rng) * 18),
        repeatChance: 0.02 + randomValue(rng) * 0.08,
        avoidStalemate: true,
        tradeDown: false
      };
    }
    return { ...plan, repeatChance: Math.round(plan.repeatChance * 1000) / 1000 };
  }

  function shouldResign(fen, options) {
    options = options || {};
    const score = Number(options.score);
    const movesPlayed = Number(options.movesPlayed);
    if (!Number.isFinite(score) || !Number.isFinite(movesPlayed)) return false;
    // movesPlayed is in plies: 36 plies is 18 full moves.
    if (movesPlayed < 36 || score > -900) return false;
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const severity = clamp((-score - 900) / 2600, 0, 1);
    let chance = 0.22 + severity * 0.48;
    const opponentRating = Number(options.opponentRating);
    if (Number.isFinite(opponentRating)) {
      chance += clamp((opponentRating - 1500) / 5000, -0.08, 0.08);
    }
    return randomValue(rng) < clamp(chance, 0.16, 0.8);
  }

  function thinkTime(options) {
    options = options || {};
    const base = clamp(finiteNumber(options.base, 450), 50, 30000);
    const elapsed = clamp(finiteNumber(options.elapsed, 0), 0, 55000);
    const complexity = clamp(finiteNumber(options.complexity, 0.35), 0, 1);
    const rng = typeof options.rng === 'function' ? options.rng : Math.random;
    const mood = randomValue(rng);
    let pause = 140 + complexity * 520 + randomValue(rng) * 220;
    if (mood < 0.09) pause *= 0.45;
    else if (mood > 0.93) pause *= 1.7 + randomValue(rng) * 0.7;
    pause = clamp(pause, 120, 1600);
    // The pause is added after the search, so a slow search cannot eat it.
    const budget = Math.max(elapsed, base * (mood < 0.09 ? 0.7 : 1));
    let total = budget + pause;
    if (mood > 0.955) total += base * (0.25 + randomValue(rng) * 0.5);
    return Math.round(clamp(total, 150, 60000));
  }

  function clockPlan({ remaining, fen, elapsed = 0 } = {}) {
    if (!Number.isFinite(remaining) || remaining < 0) return { searchMax: 5000, pauseMax: Infinity, errorScale: 1 };
    const move = Number(String(fen).split(' ')[5]) || 1;
    const horizon = isEndgame(fen) ? 22 : move < 16 ? 40 : 30;
    const reserve = Math.min(1000, remaining * 0.12);
    const available = Math.max(0, remaining - reserve);
    const allocation = Math.min(available, remaining / horizon);
    return {
      searchMax: Math.max(50, Math.min(5000, allocation * 0.4)),
      pauseMax: Math.max(0, Math.min(allocation * 0.6, available - elapsed - 650)),
      errorScale: remaining < 15000 ? 1.7 : remaining < 40000 ? 1.35 : 1
    };
  }

  // Track turn duration, not polling frequency. Ignore the partial first turn
  // and use a bounded moving average so one disconnect cannot set the tempo.
  function createTempo() {
    let last, started, average = null, samples = 0;
    return {
      observe(state, side, now = Date.now()) {
        if (!state?.available || !['w', 'b'].includes(side)) return;
        if (!last) { last = state; return; }
        if (state.boardId !== last.boardId || state.url !== last.url) {
          last = state; started = null; average = null; samples = 0; return;
        }
        if (state.fen === last.fen) return;
        if (last.turn !== side && state.turn === side && started != null) {
          const duration = now - started;
          if (duration >= 200 && duration <= 120000) {
            average = average == null ? duration : average * 0.75 + duration * 0.25;
            samples++;
          }
        }
        started = state.turn !== side ? now : null;
        last = state;
      },
      scale() { return samples < 2 ? 1 : clamp(Math.sqrt(average / 5000), 0.8, 1.15); },
      reset() { last = null; started = null; average = null; samples = 0; }
    };
  }

  function mousePause(rng) {
    const random = typeof rng === 'function' ? rng : Math.random;
    return {
      hover: Math.round(120 + randomValue(random) * 330),
      settle: Math.round(40 + randomValue(random) * 120)
    };
  }

  global.NyxHuman = {
    createSession,
    createOpeningMemory,
    endgamePlan,
    isEndgame,
    shouldResign,
    thinkTime,
    clockPlan,
    createTempo,
    mousePause
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NyxHuman;
})(typeof globalThis !== 'undefined' ? globalThis : this);
