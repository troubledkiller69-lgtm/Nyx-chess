(function (global) {
  'use strict';

  // Session bookkeeping lives here so the controller, the overlay and the
  // tests share one definition of a game, a result and a session limit.
  // Nothing in this module talks to Chess.com; it only accepts observations.
  const VERSION = 1;
  const MODES = ['coach', 'human', 'ruthless'];
  const TIME_CONTROLS = ['bullet', 'blitz', 'rapid', 'classical', 'unknown'];
  const RECENT_LIMIT = 60;
  const MAX_GAME_MS = 6 * 60 * 60 * 1000;

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function integer(value, fallback, min, max) {
    const number = Math.round(finite(value, fallback));
    return Math.max(min, Math.min(max, number));
  }

  function emptyCounts() {
    return { win: 0, draw: 0, loss: 0, unknown: 0 };
  }

  function emptyMode() {
    return { games: 0, win: 0, draw: 0, loss: 0, unknown: 0, timeMs: 0 };
  }

  function emptyTimeControls() {
    return { bullet: 0, blitz: 0, rapid: 0, classical: 0, unknown: 0 };
  }

  function fresh(now) {
    return {
      v: VERSION,
      startedAt: now,
      updatedAt: now,
      counts: emptyCounts(),
      byMode: { coach: emptyMode(), human: emptyMode(), ruthless: emptyMode() },
      byTime: emptyTimeControls(),
      timeMs: 0,
      activeMs: 0,
      streak: { current: { result: null, count: 0 }, best: { win: 0, loss: 0 } },
      recent: []
    };
  }

  function normalizeMode(mode) {
    const text = String(mode == null ? '' : mode).toLowerCase();
    return MODES.includes(text) ? text : 'human';
  }

  // Accept only results that can be attributed without guessing. A bare
  // draw/win/loss string is only meaningful when the player's side is known.
  function normalizeResult(result, side) {
    const text = String(result == null ? '' : result).trim().toLowerCase();
    const color = String(side == null ? '' : side).toLowerCase();
    const ours = color === 'w' || color === 'white' ? 'w' : color === 'b' || color === 'black' ? 'b' : null;
    if (['1-0', 'white wins', 'white won'].includes(text)) return ours ? (ours === 'w' ? 'win' : 'loss') : 'unknown';
    if (['0-1', 'black wins', 'black won'].includes(text)) return ours ? (ours === 'b' ? 'win' : 'loss') : 'unknown';
    if (['1/2-1/2', '½-½', '0.5-0.5', 'draw', 'drew', 'stalemate', 'repetition', 'insufficient material'].includes(text)) return 'draw';
    // Chess.com board code sometimes exposes side-relative words. They are
    // safe because the caller knows which color this client played.
    if (['win', 'won', 'w'].includes(text)) return ours ? 'win' : 'unknown';
    if (['loss', 'lose', 'lost', 'l'].includes(text)) return ours ? 'loss' : 'unknown';
    return 'unknown';
  }

  function isTerminal(result) {
    const text = String(result == null ? '' : result).trim();
    return text !== '' && text !== '*';
  }

  // Chess.com does not expose a formal time-control field on the board object.
  // The starting clock is the honest observation: classify it, and when no
  // clock was seen the time control is unknown rather than guessed.
  function classifyTime(initialMs) {
    const ms = Number(initialMs);
    if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
    if (ms <= 3 * 60 * 1000) return 'bullet';
    if (ms <= 10 * 60 * 1000) return 'blitz';
    if (ms <= 30 * 60 * 1000) return 'rapid';
    return 'classical';
  }

  function gameIdFromUrl(url) {
    try {
      const parsed = new URL(String(url));
      const match = parsed.pathname.match(/\/game\/(?:[^/]+\/)?(\d{4,})/);
      if (match) return match[1];
      for (const key of ['game_id', 'gameId', 'gameID', 'id']) {
        const value = parsed.searchParams.get(key);
        if (value && /^\d{4,}$/.test(value)) return value;
      }
    } catch { /* not a URL; the controller can still supply its own id */ }
    return null;
  }

  function readStored(raw) {
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return null; }
    }
    if (!value || typeof value !== 'object' || value.v !== VERSION) return null;
    const now = Date.now();
    const next = fresh(integer(value.startedAt, now, 0, Number.MAX_SAFE_INTEGER));
    next.updatedAt = integer(value.updatedAt, now, 0, Number.MAX_SAFE_INTEGER);
    for (const key of Object.keys(next.counts)) next.counts[key] = integer(value.counts?.[key], 0, 0, 1000000);
    for (const mode of MODES) {
      for (const key of Object.keys(next.byMode[mode])) {
        next.byMode[mode][key] = integer(value.byMode?.[mode]?.[key], 0, 0, 1000000000);
      }
    }
    for (const key of TIME_CONTROLS) next.byTime[key] = integer(value.byTime?.[key], 0, 0, 1000000);
    next.timeMs = integer(value.timeMs, 0, 0, 1000000000000);
    next.activeMs = integer(value.activeMs, 0, 0, 1000000000000);
    const current = value.streak?.current;
    if (current && ['win', 'loss'].includes(current.result) && finite(current.count, 0) > 0) {
      next.streak.current = { result: current.result, count: integer(current.count, 0, 0, 1000000) };
    }
    next.streak.best.win = integer(value.streak?.best?.win, 0, 0, 1000000);
    next.streak.best.loss = integer(value.streak?.best?.loss, 0, 0, 1000000);
    const recent = Array.isArray(value.recent) ? value.recent : [];
    next.recent = recent
      .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 600)
      .slice(-RECENT_LIMIT);
    return next;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createTracker(options) {
    options = options || {};
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const backend = options.storage && typeof options.storage.get === 'function' &&
      typeof options.storage.set === 'function' ? options.storage : null;
    let state = fresh(now());
    let loaded = !backend;
    let activeSince = null;
    let saveQueue = Promise.resolve();
    let lastSave = 0;
    const pending = [];

    function elapsed(at) {
      const stamp = at == null ? now() : Number(at);
      return Math.max(0, finite(stamp, now()) - finite(state.startedAt, stamp)) + 0;
    }

    function activeMs(at) {
      const stamp = at == null ? now() : Number(at);
      const open = activeSince == null ? 0 : Math.max(0, stamp - activeSince);
      return Math.max(0, state.activeMs + open);
    }

    function snapshot(at) {
      const stamp = at == null ? now() : Number(at);
      const copy = clone(state);
      copy.updatedAt = stamp;
      copy.activeMs = activeMs(stamp);
      copy.recent = state.recent.slice(-RECENT_LIMIT);
      return copy;
    }

    function save() {
      if (!backend) return Promise.resolve();
      const value = snapshot(now());
      lastSave = now();
      saveQueue = saveQueue.catch(() => {}).then(() => backend.set(value)).catch(() => {});
      return saveQueue;
    }

    function hydrate(raw) {
      const stored = readStored(raw);
      if (stored) state = stored;
      loaded = true;
      // Records observed while storage was still loading are folded in now.
      const queued = pending.splice(0);
      for (const game of queued) apply(game);
      return summary();
    }

    const ready = backend
      ? Promise.resolve().then(() => backend.get()).then(hydrate).catch(() => { loaded = true; return summary(); })
      : Promise.resolve(summary());

    function limits(at, overrides) {
      const stamp = at == null ? now() : Number(at);
      const configured = overrides || options;
      const limitGames = integer(configured.stopAfterGames ?? 0, 0, 0, 500);
      const limitMinutes = integer(configured.stopAfterMinutes ?? 0, 0, 0, 1440);
      const games = Object.values(state.counts).reduce((sum, value) => sum + value, 0);
      const playedMs = activeMs(stamp);
      const reasons = [];
      if (limitGames && games >= limitGames) reasons.push(`${limitGames} game${limitGames === 1 ? '' : 's'}`);
      if (limitMinutes && playedMs >= limitMinutes * 60000) reasons.push(`${limitMinutes} minute${limitMinutes === 1 ? '' : 's'}`);
      return {
        games: limitGames,
        minutes: limitMinutes,
        reached: reasons.length > 0,
        reasons,
        remainingGames: limitGames ? Math.max(0, limitGames - games) : null,
        remainingMs: limitMinutes ? Math.max(0, limitMinutes * 60000 - playedMs) : null
      };
    }

    function summary(at, overrides) {
      const stamp = at == null ? now() : Number(at);
      return {
        v: VERSION,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        games: Object.values(state.counts).reduce((sum, value) => sum + value, 0),
        counts: { ...state.counts },
        byMode: clone(state.byMode),
        byTime: { ...state.byTime },
        timeMs: state.timeMs,
        activeMs: activeMs(stamp),
        elapsedMs: elapsed(stamp),
        streak: { current: { ...state.streak.current }, best: { ...state.streak.best } },
        recentGames: state.recent.length,
        limit: limits(stamp, overrides)
      };
    }

    function apply(game) {
      game = game || {};
      const id = String(game.id == null ? '' : game.id).slice(0, 600);
      if (!id) return { recorded: false, reason: 'missing-id', stats: summary() };
      if (state.recent.includes(id)) return { recorded: false, reason: 'duplicate', stats: summary() };
      const result = ['win', 'draw', 'loss', 'unknown'].includes(game.result)
        ? game.result : normalizeResult(game.result, game.side);
      const mode = normalizeMode(game.mode);
      const timeControl = TIME_CONTROLS.includes(game.timeControl) ? game.timeControl : classifyTime(game.initialMs);
      const endedAt = integer(game.endedAt, now(), 0, Number.MAX_SAFE_INTEGER);
      const startedAt = integer(game.startedAt, endedAt, 0, Number.MAX_SAFE_INTEGER);
      const duration = Math.min(MAX_GAME_MS, Math.max(0, endedAt - startedAt));
      state.counts[result]++;
      state.byMode[mode].games++;
      state.byMode[mode][result]++;
      state.byMode[mode].timeMs += duration;
      state.byTime[timeControl]++;
      state.timeMs += duration;
      if (result === 'win' || result === 'loss') {
        const current = state.streak.current;
        if (current.result === result) current.count++;
        else state.streak.current = { result, count: 1 };
        state.streak.best[result] = Math.max(state.streak.best[result], state.streak.current.count);
      } else {
        state.streak.current = { result: null, count: 0 };
      }
      state.recent.push(id);
      if (state.recent.length > RECENT_LIMIT) state.recent.splice(0, state.recent.length - RECENT_LIMIT);
      const updated = now();
      state.updatedAt = updated;
      const stats = summary(updated);
      save();
      return { recorded: true, result, mode, timeControl, stats, limit: stats.limit };
    }

    function recordGame(game) {
      if (!loaded) {
        pending.push(game);
        return { recorded: false, pending: true, stats: summary() };
      }
      return apply(game);
    }

    function observeActive(active, at) {
      const stamp = at == null ? now() : Number(at);
      if (active) {
        if (activeSince == null) activeSince = stamp;
        // Fold long segments into the durable total so a tab close loses at
        // most the last 15 seconds of session play time.
        if (stamp - lastSave > 15000) {
          state.activeMs = activeMs(stamp);
          activeSince = stamp;
          save();
        }
      } else if (activeSince != null) {
        state.activeMs = activeMs(stamp);
        activeSince = null;
        save();
      }
    }

    function reset(at) {
      const stamp = at == null ? now() : Number(at);
      state = fresh(stamp);
      activeSince = null;
      pending.length = 0;
      save();
      return summary(stamp);
    }

    return {
      ready,
      recordGame,
      observeActive,
      reset,
      save,
      summary,
      limits,
      snapshot,
      get loaded() { return loaded; },
      get startedAt() { return state.startedAt; }
    };
  }

  global.NyxSession = {
    VERSION,
    MODES,
    TIME_CONTROLS,
    createTracker,
    normalizeResult,
    normalizeMode,
    isTerminal,
    classifyTime,
    gameIdFromUrl
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NyxSession;
})(typeof globalThis !== 'undefined' ? globalThis : this);
