(function (global) {
  'use strict';
  const defaults = { side: 'auto', mode: 'human', pace: 'blitz', depth: 12, timeMs: 450, delayMs: 120,
    elo: 1600, variety: 0, style: 'balanced', blunders: 2, blunderSeverity: 'major', autoRematch: false, adaptive: true, control: 'autoplay',
    coachHints: 'arrow', coachThreats: true, coachSecond: true,
    stopAfterGames: 0, stopAfterMinutes: 0,
    openingWhite: 'none', openingBlack: 'none', customLineWhite: '', customLineBlack: '' };
  // Pace presets are deliberately honest about the total time per move: the
  // search budget plus the delivery delay. Bullet spends more of it searching.
  const paces = {
    bullet: { timeMs: 160, delayMs: 25 },
    blitz: { timeMs: 450, delayMs: 120 },
    rapid: { timeMs: 1400, delayMs: 350 },
    deep: { timeMs: 1500, delayMs: 0 }
  };
  // 0.6.11 and earlier shipped Deep as a 5-second search. A saved Deep session
  // with exactly that pair is the old preset, not a custom 5-second choice, so
  // it follows the faster Deep budget. An explicit Custom 5-second choice keeps
  // its values, and a Deep session with any other pair becomes Custom.
  const legacyDeep = { timeMs: 5000, delayMs: 0 };
  function normalize(value = {}) {
    if (value.elo == null && Number.isFinite(Number(value.skill))) {
      value = { ...value, elo: 600 + Math.min(100, Math.max(0, Number(value.skill))) * 16 };
    }
    const number = (key, min, max) => {
      const n = Number(value[key] ?? defaults[key]);
      return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : defaults[key];
    };
    // Zero is a valid value for a session limit ("no limit"). The generic
    // number() helper clamps from its minimum, so these get their own read.
    const limit = (key, max) => {
      const n = Number(value[key] ?? defaults[key]);
      return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(0, n))) : defaults[key];
    };
    const text = (key, limit) => typeof value[key] === 'string' ? value[key].trim().slice(0, limit) : '';
    // One shared custom line was the old format. Mirror it into both sides the
    // first time those fields are missing, then stop carrying the old key.
    const legacy = text('customLine', 1000);
    const perSide = (key) => typeof value[key] === 'string' ? text(key, 1000) : legacy;
    const mode = value.mode === 'ruthless' ? 'ruthless' : 'human';
    let pace = ['bullet', 'blitz', 'rapid', 'deep', 'custom'].includes(value.pace) ? value.pace : defaults.pace;
    const pacePreset = paces[pace];
    // A partial settings object that only names a pace still gets that pace's
    // real budget instead of inheriting the Blitz defaults by accident.
    let timeMs = value.timeMs == null && pacePreset ? pacePreset.timeMs : number('timeMs', 50, 5000);
    let delayMs = value.delayMs == null && pacePreset ? pacePreset.delayMs : number('delayMs', 0, 10000);
    if (pace === 'deep') {
      if (timeMs === legacyDeep.timeMs && delayMs === legacyDeep.delayMs) {
        timeMs = paces.deep.timeMs;
        delayMs = paces.deep.delayMs;
      } else if (timeMs !== paces.deep.timeMs || delayMs !== paces.deep.delayMs) {
        pace = 'custom';
      }
    }
    return {
      side: ['auto', 'w', 'b', 'both'].includes(value.side) ? value.side : defaults.side,
      mode,
      control: value.control === 'coach' ? 'coach' : 'autoplay',
      // The suggestion arrow is the default; staged hints remain available for
      // players who want the idea before the move.
      coachHints: value.coachHints === 'staged' ? 'staged' : 'arrow',
      coachThreats: value.coachThreats === false || value.coachThreats === 'no' || value.coachThreats === 'off' ? false : true,
      coachSecond: value.coachSecond === false || value.coachSecond === 'no' || value.coachSecond === 'off' ? false : true,
      pace,
      depth: number('depth', 1, 16),
      timeMs,
      delayMs,
      elo: value.elo === 'max' ? 'max' : Math.round(number('elo', 600, 2200) / 50) * 50,
      variety: number('variety', 0, 100),
      // Deliberate errors per game. Ruthless turns them off in engineOptions;
      // the controller is the only thing that ever sets the per-move flag.
      blunders: number('blunders', 0, 3),
      blunderSeverity: ['mixed', 'major'].includes(value.blunderSeverity) ? value.blunderSeverity : defaults.blunderSeverity,
      autoRematch: value.autoRematch === true || value.autoRematch === 'on' || value.autoRematch === 'yes',
      adaptive: value.adaptive === true || value.adaptive === 'on' || value.adaptive === 'yes' ||
        (value.adaptive === undefined && defaults.adaptive),
      stopAfterGames: limit('stopAfterGames', 500),
      stopAfterMinutes: limit('stopAfterMinutes', 1440),
      style: ['balanced', 'tactical', 'positional'].includes(value.style) ? value.style : 'balanced',
      openingWhite: typeof value.openingWhite === 'string' ? value.openingWhite.slice(0, 40) : 'none',
      openingBlack: typeof value.openingBlack === 'string' ? value.openingBlack.slice(0, 40) : 'none',
      customLineWhite: perSide('customLineWhite'),
      customLineBlack: perSide('customLineBlack')
    };
  }
  function engineOptions(value) {
    const settings = normalize(value);
    const ruthless = settings.mode === 'ruthless';
    return {
      ...settings,
      ruthless,
      // Ruthless is the one mode that removes every handicap. Human mode keeps
      // a thin layer of imperfection even at the top of the slider.
      variety: ruthless ? 0 : settings.variety,
      blunders: ruthless ? 0 : settings.blunders,
      skill: ruthless || settings.elo === 'max' ? 100 : (settings.elo - 600) / 16
    };
  }
  function searchBudgetLabel(pace, timeMs, delayMs) {
    const preset = paces[pace];
    const matches = preset && Number(timeMs) === preset.timeMs && Number(delayMs) === preset.delayMs;
    if (!matches) return `${Math.round(Number(timeMs) || 0)} ms search`;
    // Deep is a short, useful budget now rather than a five-second wall. Say it
    // is a budget: the engine may finish the current iteration just past it.
    if (pace === 'deep') return `${(preset.timeMs / 1000).toFixed(1)} s search budget (small overrun possible)`;
    return `${preset.timeMs} ms search`;
  }
  function moveQuality(result) {
    if (!result?.move) return { label: '—', detail: 'No selected move.' };
    if (result.source === 'book') return { label: 'Book', detail: result.opening || 'From the selected opening repertoire.' };
    const unknown = { label: 'Unrated', detail: 'Insufficient completed search data to grade this move.' };
    if (!result.depth || result.scoreSource === 'static' || !Number.isFinite(result.score)) return unknown;
    const top = result.lines?.[0];
    if (!top || !Number.isFinite(top.score)) return unknown;
    const loss = Math.max(0, top.score - result.score);
    if (top.move !== result.move && !result.exactScores) return unknown;
    const label = loss === 0 ? 'Best' : loss <= 20 ? 'Excellent' : loss <= 50 ? 'Good'
      : loss <= 100 ? 'Inaccuracy' : loss <= 250 ? 'Mistake' : 'Blunder';
    return { label, loss, detail: `Nyx estimate at depth ${result.depth}: ${loss} cp behind its top move. Not a Chess.com review grade.` };
  }
  global.NyxSettings = { defaults, paces, normalize, engineOptions, searchBudgetLabel, moveQuality };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NyxSettings;
})(globalThis);
