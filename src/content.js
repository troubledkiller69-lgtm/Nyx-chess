(() => {
  'use strict';
  const channel = 'nyx-chess-v1';
  let settings = { ...NyxSettings.defaults };
  let state = { available: false };
  let engineReady = false;
  let enginePort;
  let frame;
  let engineTimer;
  let running = false;
  let once = false;
  let active;
  let review = null;
  let reviewSerial = 0;
  let serial = 0;
  let timer;
  let moveTimer;
  let selectedSide;
  let lockedBoard;
  let lockedUrl;
  let lastAttempt;
  let message = 'Open a Chess.com board.';
  let phase = 'idle';
  let result;
  let resultTurn;
  let blunderBudget = 0;
  let blundersPlayed = 0;
  let errorGame = null;
  let rematchFor;
  let rematchTries = 0;
  let rematchTimer;
  // A transient rejected drag (background-tab timer throttling, a board that
  // was still animating) should get a couple of retries on the same position
  // before the controller gives up.
  let moveFailures = 0;
  let moveFailureFor = null;
  // Auto-rematch is also an auto-queue: the intent survives navigation to the
  // next game page and is cleared only by Stop or by turning the setting off.
  let queueArmed = false;
  let queueTimer;
  let lastQueueAction = 0;
  const queueKey = 'nyx-chess-autoqueue-v1';
  const queueMaxAge = 30 * 60 * 1000;
  let declineThisGame = false;
  let resignTried = false;
  let ourScore = null;
  let recordedFor = null;
  // Per-game form. People do not play at the same accuracy every session;
  // varying the error rate across games is more convincing than a constant one.
  let form = 1;
  let tilt = 0;
  let lastStateError;
  let stateErrorCount = 0;
  const maxStateErrors = 3;
  // Opponent model and cross-game memory. Both are optional so the controller
  // still runs in tests or if the module is missing.
  const profiler = globalThis.NyxProfile?.create({ ourSide: null });
  const opponentMemory = globalThis.NyxProfile?.createMemory({
    get: () => chrome.storage.local.get('opponentMemory').then((saved) => saved.opponentMemory).catch(() => null),
    set: (value) => chrome.storage.local.set({ opponentMemory: value })
  });
  opponentMemory?.load();
  const session = globalThis.NyxHuman?.createSession();
  const tempo = globalThis.NyxHuman?.createTempo();
  // Session aggregates are intentionally separate from the human-pacing
  // session above: that one keeps the bot's rhythm, this one is what the user
  // reads in the panel and what stop-after limits count.
  const sessionStats = globalThis.NyxSession?.createTracker?.({
    storage: {
      get: () => chrome.storage.local.get('sessionStats').then((saved) => saved?.sessionStats).catch(() => null),
      set: (value) => chrome.storage.local.set({ sessionStats: value })
    }
  });
  let currentGame = null;
  let gameSerial = 0;
  let nextMoveAt = 0;
  let queueAttempts = 0;
  let queueFailures = 0;
  const maxQueueAttempts = 30;
  const maxQueueFailures = 5;
  let coachGuidance = null;
  // The suggested move arrow is visible by default. Players who prefer the
  // idea-first flow opt into staged hints in the Coach tab.
  const coachDefaultReveal = () => settings.coachHints === 'staged' ? 'concept' : 'move';
  let coachReveal = coachDefaultReveal();
  let coachResult = null;
  let coachPrevious = null;
  let gameSeed = (Math.random() * 0xffffffff) >>> 0;
  // Opening lines already played recently, keyed by the position after the
  // move. This is what keeps the account from repeating the same ten moves.
  let openingMemory = {};
  let openingGame = 0;
  chrome.storage.local.get('openingHistory').then((saved) => {
    const data = saved?.openingHistory;
    if (data?.v === 1 && data.entries && typeof data.entries === 'object') {
      openingMemory = data.entries;
      openingGame = Number(data.game) || 0;
    }
  }).catch(() => {});
  let overlay;
  let overlayInitialization;
  function initializeOverlay() {
    if (overlayInitialization) return overlayInitialization;
    overlayInitialization = Promise.resolve().then(() => {
    overlay = (() => {
    const root = document.createElement('div');
    root.setAttribute('data-nyx-chess-overlay', '');
    root.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    const shadow = root.attachShadow({ mode: 'closed' });
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('src/overlay.css');
    const styleReady = new Promise((resolve) => {
      style.addEventListener('load', () => resolve(true), { once: true });
      style.addEventListener('error', () => resolve(false), { once: true });
    });
    shadow.append(style);
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Nyx Chess controls');
    panel.style.pointerEvents = 'auto';
    panel.innerHTML = `<header><div class="brand"><b>♞ Nyx Chess</b><small>The next move, considered.</small></div><button class="icon close" aria-label="Minimize panel" title="Minimize">−</button></header><main><section class="readout" aria-label="Engine readout"><span class="turn">No board</span><span class="phase">Idle</span><strong class="move">—</strong><span class="score">—</span><span class="metrics">Search runs on your device</span></section><div class="panel-scroll"><nav class="tabs" role="tablist" aria-label="Sections"><button role="tab" id="tab-play" aria-controls="panel-play" aria-selected="true" data-tab="play">Play</button><button role="tab" id="tab-coach" aria-controls="panel-coach" aria-selected="false" data-tab="coach" tabindex="-1">Coach</button><button role="tab" id="tab-openings" aria-controls="panel-openings" aria-selected="false" data-tab="openings" tabindex="-1">Openings</button><button role="tab" id="tab-session" aria-controls="panel-session" aria-selected="false" data-tab="session" tabindex="-1">Session</button><button role="tab" id="tab-engine" aria-controls="panel-engine" aria-selected="false" data-tab="engine" tabindex="-1">Engine</button></nav><section class="panel-body" id="panel-play" role="tabpanel" aria-labelledby="tab-play" data-panel="play"><label>Move control<select name="control"><option value="autoplay">Autoplay - move pieces</option><option value="coach">Coach - suggestions only</option></select></label><div class="segmented" role="group" aria-label="Playing mode"><button type="button" data-mode="human">Human</button><button type="button" data-mode="ruthless">Ruthless</button></div><input type="hidden" name="mode" value="human"><p class="hint mode-hint">Human keeps move variety and practice errors. Its post-search pause applies to Autoplay; Coach shows the result at once.</p><div class="segmented pace" role="group" aria-label="Time control"><button type="button" data-pace="bullet">Bullet</button><button type="button" data-pace="blitz">Blitz</button><button type="button" data-pace="rapid">Rapid</button><button type="button" data-pace="deep">Deep</button></div><input type="hidden" name="pace" value="blitz"><p class="hint pace-hint">160 ms search · 25 ms delivery</p><div class="two"><label>Play as<select name="side"><option value="auto">Auto-detect</option><option value="w">White</option><option value="b">Black</option><option value="both">Both sides</option></select></label><label>Style<select name="style"><option value="balanced">Balanced</option><option value="tactical">Attacking</option><option value="positional">Positional</option></select></label></div><label>Target Elo <span class="elo-value">1,600</span><input name="elo" type="range" min="600" max="2250" step="50" value="1600"><small class="hint">Approximate preset; not a calibrated rating. Ruthless ignores it.</small></label></section><section class="panel-body" id="panel-coach" role="tabpanel" aria-labelledby="tab-coach" data-panel="coach" hidden><section class="coach" aria-label="Coach guidance"><div class="coach-head"><b>Coach</b><button type="button" class="coach-reveal" disabled>Hide arrow</button></div><div class="coach-hint">Start Coach to see the suggested move and its idea.</div><div class="coach-move"></div><div class="coach-explain"></div><div class="coach-legend">Gold arrow: suggested move. Rust marks: captures the opponent could play if the turn passed, not a predicted reply.</div><div class="coach-threats"></div><div class="coach-feedback"></div><div class="two"><label>Hint style<select name="coachHints"><option value="arrow">Move arrow</option><option value="staged">Reveal in steps</option></select></label><label>Threat marks<select name="coachThreats"><option value="yes">On</option><option value="no">Off</option></select></label></div><label>Alternative suggestion<select name="coachSecond"><option value="yes">On</option><option value="no">Off</option></select><small class="hint coach-second-hint">Only shown when the search has exact comparable scores.</small></label><p class="hint coach-help">Move arrow shows the recommendation immediately. Reveal in steps starts with the idea, then the piece, then the move.</p></section></section><section class="panel-body" id="panel-openings" role="tabpanel" aria-labelledby="tab-openings" data-panel="openings" hidden><label>With White<select name="openingWhite"></select></label><label class="custom" data-custom="white" hidden>Custom White line<textarea name="customLineWhite" rows="2" maxlength="1000" placeholder="e2e4 e7e5 f2f4"></textarea><small class="hint">Coordinate notation from the normal starting position.</small></label><label>With Black<select name="openingBlack"></select></label><label class="custom" data-custom="black" hidden>Custom Black line<textarea name="customLineBlack" rows="2" maxlength="1000" placeholder="e7e5 g1f3 b8c6"></textarea><small class="hint">Coordinate notation from the normal starting position.</small></label></section><section class="panel-body" id="panel-session" role="tabpanel" aria-labelledby="tab-session" data-panel="session" hidden><div class="review"><div class="review-actions"><button type="button" class="review-run" disabled>Review last game</button><button type="button" class="review-cancel" hidden>Cancel review</button></div><p class="hint review-status" role="status">Review runs after a game, never during one.</p></div><section class="session" aria-label="Session statistics"><div class="session-head"><b>Session</b><button type="button" class="session-reset">Reset stats</button></div><div class="session-counts" role="status">No games counted yet.</div><div class="session-modes"></div><div class="session-time"></div><p class="hint session-limit">No session limit.</p><p class="hint queue-status">Queue off.</p><label>Auto-rematch / queue<select name="autoRematch"><option value="no">Off</option><option value="yes">On</option></select></label><p class="hint">Queue continues across games until Stop.</p><div class="two session-fields"><label>Stop after games<input name="stopAfterGames" type="number" min="0" max="500" step="1" inputmode="numeric"></label><label>Stop after minutes<input name="stopAfterMinutes" type="number" min="0" max="1440" step="1" inputmode="numeric"></label></div><p class="hint">0 turns a limit off. Limits only stop the controller; stats stay until Reset stats.</p></section></section><section class="panel-body" id="panel-engine" role="tabpanel" aria-labelledby="tab-engine" data-panel="engine" hidden><label>Maximum depth<select name="depth">${[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16].map((n) => `<option value="${n}">${n} plies</option>`).join('')}</select></label><label>Adapt to opponent<select name="adaptive"><option value="yes">On</option><option value="no">Off</option></select></label><div class="two"><label>Move variety <span class="variety-value">0</span><input name="variety" type="range" min="0" max="100" value="0"><small class="hint">Varies scored alternatives; Human mode already sandbags near-best moves. For opening diversity, choose Engine chooses rather than a fixed book.</small></label><label>Blunders <span class="blunders-value">2</span><input name="blunders" type="range" min="0" max="3" step="1" value="2"><small class="hint">Hard-error limit per game; eligible positions only.</small></label></div><p class="hint blunder-status" role="status">Blunders played: 0 / 2</p><label>Error severity<select name="blunderSeverity"><option value="major">Major — 3–9 pawn evaluation loss</option><option value="mixed">Mixed — 0.8–4.5 pawn evaluation loss</option></select><small class="hint">Our engine estimate; Chess.com may grade it differently. Human mode also plays near-best alternatives on its own.</small></label><div class="two"><label>Search budget (ms)<input name="timeMs" type="number" min="50" max="5000" step="50"></label><label>Move delay (ms)<input name="delayMs" type="number" min="0" max="10000" step="50"></label></div><p class="hint">Search depth and time are upper limits.</p></section></div><p class="status" role="status" aria-live="polite">Connecting to this tab…</p></main><footer><div class="actions"><button class="once">Play one move</button><button class="toggle primary">Start autoplay</button></div></footer>`;
    const launcher = document.createElement('button');
    panel.querySelector('.readout').insertAdjacentHTML('beforeend', '<span class="countdown" role="timer" aria-live="off"></span>');
    panel.querySelector('.metrics').insertAdjacentHTML('beforebegin', '<span class="quality" aria-label="Selected move quality">—</span>');
    launcher.className = 'launcher'; launcher.type = 'button'; launcher.textContent = '♞'; launcher.title = 'Open Nyx Chess'; launcher.setAttribute('aria-label', 'Open Nyx Chess controls'); launcher.style.pointerEvents = 'auto';
    shadow.append(panel, launcher);
    document.documentElement.append(root);
    const fields = Object.keys(NyxSettings.defaults);
    const $ = (selector) => shadow.querySelector(selector);
    // The panel is a fixed-size desk, not a shrink-to-fit card. A layout that
    // collapsed to the old 264x300 minimum used to be persisted and then
    // restored forever; anything below this floor is treated as corrupt.
    const MIN_WIDTH = 300, MIN_HEIGHT = 360, DEFAULT_WIDTH = 360, DEFAULT_HEIGHT = 540;
    const persistLayout = () => {
      if (panel.hidden) return;
      const rect = panel.getBoundingClientRect();
      if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return;
      try {
        chrome.storage.local.set({ overlayLayout: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }).catch(() => {});
      } catch {
        // Reloading the extension invalidates APIs in already-open tabs.
        // This throws synchronously, before a Promise exists to catch it.
      }
    };
    const saveLayout = persistLayout;
    const clampLayout = (layout = {}) => {
      const viewportWidth = Math.max(MIN_WIDTH, innerWidth);
      const viewportHeight = Math.max(MIN_HEIGHT, innerHeight);
      const storedWidth = Number(layout.width), storedHeight = Number(layout.height);
      const width = Math.max(MIN_WIDTH, Math.min(storedWidth >= MIN_WIDTH ? storedWidth : DEFAULT_WIDTH, viewportWidth - 16));
      const height = Math.max(MIN_HEIGHT, Math.min(storedHeight >= MIN_HEIGHT ? storedHeight : DEFAULT_HEIGHT, viewportHeight - 16));
      const storedLeft = Number(layout.left), storedTop = Number(layout.top);
      const left = Number.isFinite(storedLeft) ? storedLeft : innerWidth - width - 24;
      const top = Number.isFinite(storedTop) ? storedTop : 24;
      panel.style.width = `${width}px`; panel.style.height = `${height}px`;
      panel.style.left = `${Math.max(8, Math.min(left, Math.max(8, innerWidth - width - 8)))}px`;
      panel.style.top = `${Math.max(8, Math.min(top, Math.max(8, innerHeight - height - 8)))}px`;
    };
    const initialized = chrome.storage.local.get(['overlayLayout', 'settings', 'overlayTab']).then((saved) => {
      clampLayout(saved.overlayLayout);
      const normalized = NyxSettings.normalize(saved.settings);
      for (const field of fields) {
        const input = $(`[name="${field}"]`);
        if (!input) continue;
        input.value = ['autoRematch', 'adaptive', 'coachThreats', 'coachSecond'].includes(field)
          ? (normalized[field] ? 'yes' : 'no')
          : normalized[field] === 'max' ? '2250' : normalized[field];
      }
      // Build both selectors from the single repertoire definition so a new
      // opening only ever has to be added in one place.
      const repertoire = globalThis.NyxOpenings?.repertoire || [];
      for (const [field, side] of [['openingWhite', 'w'], ['openingBlack', 'b']]) {
        const select = $(`[name="${field}"]`);
        select.add(new Option('Engine chooses', 'none'));
        for (const opening of repertoire) {
          if (opening.side === side) select.add(new Option(opening.name, opening.id));
          // Side-agnostic entries (the own-games book) belong in both lists.
          else if (opening.side === 'any' && opening.id !== 'none' && opening.id !== 'custom') {
            select.add(new Option(opening.name, opening.id));
          }
        }
        select.add(new Option('Custom line…', 'custom'));
        select.value = normalized[field];
        if (!select.value) select.value = 'none';
      }
      updateForm();
      selectTab(saved.overlayTab || 'play');
    }).catch(() => clampLayout());
    function updateForm() {
      const elo = Number($('[name="elo"]').value);
      $('.elo-value').textContent = elo === 2250 ? 'Maximum' : elo.toLocaleString('en-US');
      $('.variety-value').textContent = $('[name="variety"]').value;
      $('.blunders-value').textContent = $('[name="blunders"]').value;
      for (const [side, field] of [['white', 'openingWhite'], ['black', 'openingBlack']]) {
        $(`[data-custom="${side}"]`).hidden = $(`[name="${field}"]`).value !== 'custom';
      }
      const mode = $('[name="mode"]').value;
      shadow.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
      const paceId = $('[name="pace"]').value;
      const preset = NyxSettings.paces[paceId];
      const timeMs = Number($('[name="timeMs"]').value);
      const delayMs = Number($('[name="delayMs"]').value);
      const customPace = !preset || timeMs !== preset.timeMs || delayMs !== preset.delayMs;
      shadow.querySelectorAll('[data-pace]').forEach((button) => button.setAttribute('aria-pressed', String(!customPace && button.dataset.pace === paceId)));
      $('.mode-hint').textContent = mode === 'ruthless'
        ? 'Ruthless: full search, every CPU core, no pause, no mistakes.'
        : 'Human: real pause after search, adaptive style, occasional mistakes.';
      const pause = pauseRange(timeMs);
      const budget = NyxSettings.searchBudgetLabel(paceId, timeMs, delayMs);
      $('.pace-hint').textContent =
        `${budget} · ${Math.round(pause.min / 100) / 10}–${Math.round(pause.max / 100) / 10} s human pause`;
    }
    const TAB_NAMES = ['play', 'coach', 'openings', 'session', 'engine'];
    function selectTab(name, persist = false) {
      const target = TAB_NAMES.includes(name) ? name : 'play';
      shadow.querySelectorAll('[role="tab"]').forEach((tab) => {
        const selected = tab.dataset.tab === target;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      shadow.querySelectorAll('.panel-body').forEach((body) => {
        body.hidden = body.dataset.panel !== target;
      });
      panel.dataset.tab = target;
      if (persist) {
        try { chrome.storage.local.set({ overlayTab: target }).catch(() => {}); }
        catch { /* extension reloaded; the next open restores the default */ }
      }
      return target;
    }
    function readForm() {
      for (const [field, label] of [['customLineWhite', 'White'], ['customLineBlack', 'Black']]) {
        const select = $(`[name="${field.replace('customLine', 'opening')}"]`);
        if (select.value !== 'custom') continue;
        const line = $(`[name="${field}"]`).value.trim();
        const tokens = line.split(/\s+/).filter(Boolean);
        if (!tokens.length || tokens.length > 80 || tokens.some((token) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token))) {
          throw new Error(`Enter a custom ${label} line of coordinate moves (for example, e2e4 e7e5).`);
        }
        const check = globalThis.NyxOpenings?.validate(line);
        if (!check?.ok) throw new Error(check?.error || 'The custom line is not legal.');
      }
      const values = Object.fromEntries(fields.map((key) => {
        const input = $(`[name="${key}"]`);
        return [key, key === 'elo' && input.value === '2250' ? 'max' : input.value];
      }));
      const preset = NyxSettings.paces[values.pace];
      if (preset && (Number(values.timeMs) !== preset.timeMs || Number(values.delayMs) !== preset.delayMs)) values.pace = 'custom';
      return NyxSettings.normalize(values);
    }
    let settingsQueue = Promise.resolve();
    function saveSettings() {
      const value = readForm();
      settingsQueue = settingsQueue.catch(() => {}).then(() => request('configure', { settings: value }));
      return settingsQueue;
    }
    function request(type, extra = {}) {
      return handleRequest({ channel, type, ...extra });
    }
    async function action(type) {
      const buttons = ['.once', '.toggle', '.review-run', '.review-cancel']
        .map((selector) => $(selector)).filter(Boolean);
      buttons.forEach((button) => { button.disabled = true; });
      try {
        if (!['stop', 'review', 'review-cancel'].includes(type)) await saveSettings();
        render(await request(type));
      } catch (error) { $('.status').textContent = error.message; }
      // Re-render the current state instead of blanket-enabling every button:
      // starting a review must leave "Review last game" disabled, and starting
      // autoplay must not re-enable "Play one move" behind the poll. Only the
      // four action buttons are touched, so tab and settings controls stay live.
      finally {
        try { render(await request('status')); }
        catch { buttons.forEach((button) => { button.disabled = false; }); }
      }
    }
    let countdownAt = 0;
    const formatSpan = (ms) => {
      const total = Math.max(0, Math.round(Number(ms) / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor(total / 60) % 60;
      const seconds = total % 60;
      return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
    };
    const updateCountdown = () => {
      const node = $('.countdown');
      if (!node) return;
      const left = countdownAt ? countdownAt - Date.now() : 0;
      node.textContent = left > 0 ? `Move in ${(left / 1000).toFixed(1)} s` : '';
    };
    function render(data) {
      $('.turn').textContent = data.state.available ? `${data.state.turn === 'w' ? 'White' : 'Black'} to move` : 'No board';
      if (data.state.available) {
        const side = data.settings.side === 'auto'
          ? data.state.playingAs || data.state.orientation : data.settings.side;
        $('.turn').textContent += ` · Side: ${side === 'w' ? 'White' : side === 'b' ? 'Black' : 'Both'}${data.settings.side === 'auto' ? ' (auto)' : ''}`;
      }
      const phaseLabels = { thinking: 'Searching', waiting: 'Waiting', moving: 'Playing', confirming: 'Confirming', coaching: 'Coaching', finished: 'Finished', queueing: 'Queuing', loading: 'Loading', idle: 'Idle' };
      $('.phase').textContent = phaseLabels[data.phase] || String(data.phase || 'idle').replace(/^./, (s) => s.toUpperCase());
      const result = data.result;
      const quality = NyxSettings.moveQuality(result);
      $('.blunder-status').textContent = data.settings.mode === 'ruthless'
        ? 'Deliberate errors off in Ruthless mode.'
        : `Blunders played: ${data.blundersPlayed || 0} / ${data.settings.blunders}${data.pendingBlunder ? ' · queued' : ''}. Small inaccuracies are separate.`;
      $('.quality').textContent = quality.label;
      $('.quality').title = quality.detail;
      const reviewData = data.review || {};
      $('.review-run').textContent = reviewData.active ? 'Reviewing…' : 'Review last game';
      $('.review-run').disabled = !reviewData.canStart;
      $('.review-cancel').hidden = !reviewData.active;
      $('.review-cancel').disabled = !reviewData.active;
      $('.review-status').textContent = reviewData.active
        ? `Reviewing… ${reviewData.done || 0}/${reviewData.total || '?'} moves. Cancel is safe.`
        : reviewData.error || reviewData.summary || 'Review runs after a game, never during one.';
      const sessionData = data.session || {};
      const counts = sessionData.counts || {};
      const games = Number(sessionData.games) || 0;
      $('.session-counts').textContent = games
        ? `${counts.win || 0}W · ${counts.draw || 0}D · ${counts.loss || 0}L${counts.unknown ? ` · ${counts.unknown} unknown` : ''} — ${games} game${games === 1 ? '' : 's'}`
        : 'No games counted yet.';
      const modes = sessionData.byMode || {};
      $('.session-modes').textContent = ['human', 'ruthless', 'coach'].map((mode) => {
        const row = modes[mode] || {};
        const played = Number(row.games) || 0;
        return played ? `${mode[0].toUpperCase()}${mode.slice(1)} ${played} (${formatSpan(row.timeMs)})` : null;
      }).filter(Boolean).join(' · ') || 'No mode split yet.';
      const times = sessionData.byTime || {};
      const timeParts = ['bullet', 'blitz', 'rapid', 'classical', 'unknown']
        .filter((key) => Number(times[key]) > 0)
        .map((key) => `${key} ${times[key]}`);
      const streak = sessionData.streak?.current;
      const streakText = streak?.count ? ` · ${streak.count} ${streak.result} streak` : '';
      $('.session-time').textContent = `Played ${formatSpan(sessionData.activeMs)}${timeParts.length ? ` · ${timeParts.join(' · ')}` : ''}${streakText}`;
      const limit = sessionData.limit || {};
      const limits = [];
      if (limit.games) limits.push(`${limit.games} game${limit.games === 1 ? '' : 's'} (${limit.remainingGames ?? 0} left)`);
      if (limit.minutes) limits.push(`${limit.minutes} min (${formatSpan(limit.remainingMs)} left)`);
      $('.session-limit').textContent = limit.reached ? `Session limit reached: ${limit.reasons?.join(' and ') || 'limit'}.`
        : limits.length ? `Stops after ${limits.join(' or ')}.` : 'No session limit.';
      const queue = data.queue || {};
      $('.queue-status').textContent = queue.armed
        ? `Queue armed · ${queue.attempts || 0} attempt${queue.attempts === 1 ? '' : 's'}${queue.failures ? ` · ${queue.failures} failed` : ''}.`
        : 'Queue off.';
      const coach = data.coach || {};
      const coaching = data.settings.control === 'coach';
      const staged = coach.hintMode === 'staged';
      $('.coach-reveal').disabled = !coaching || !coach.active;
      $('.coach-reveal').textContent = staged
        ? coach.hintLevel === 'concept' ? 'Reveal piece'
          : coach.hintLevel === 'piece' ? 'Reveal move' : 'Hide hint'
        : coach.hintLevel === 'move' ? 'Hide arrow' : 'Show arrow';
      $('.coach-hint').textContent = coaching
        ? coach.active ? coach.hint?.text || 'No hint for this position.'
          : 'Coach is ready. Start it to search the current position.'
        : 'Switch Move control to Coach to use the coach tab.';
      const suggestion = coach.suggestion;
      $('.coach-move').textContent = coaching && coach.active
        ? coach.hintLevel === 'move' && suggestion
          ? `Suggestion: ${suggestion.san}${coach.second ? ` · alternative ${coach.second.san}` : ''}`
          : coach.hintLevel === 'piece' ? `Piece: ${coach.hint?.piece?.name || 'unknown'}`
            : staged ? 'Move hidden until you reveal it.' : 'Arrow hidden.'
        : '';
      const explanation = coach.explanation;
      $('.coach-explain').textContent = coaching && explanation
        ? [explanation.headline, ...(explanation.points || []).slice(0, 3)].filter(Boolean).join(' · ')
        : '';
      $('.coach-legend').textContent = 'Gold arrow: suggested move. Rust marks: opponent capture options if the turn passed — not a predicted or guaranteed winning reply.';
      const threatLabels = coaching && coach.active && data.settings.coachThreats
        ? (coach.threats?.labels || []) : [];
      const threatTotal = Number(coach.threats?.total) || 0;
      $('.coach-threats').textContent = threatLabels.length
        ? `Opponent capture options: ${threatLabels.join(' ')}${threatTotal > threatLabels.length
          ? ` ${threatTotal - threatLabels.length} more in the legal move list.` : ''}`
        : '';
      $('.coach-second-hint').textContent = coach.secondReason ||
        'Only shown when the search has exact comparable scores.';
      const altControl = $('[name="coachSecond"]');
      altControl.disabled = Boolean(coaching && coach.active && coach.secondAvailable === false);
      $('.coach-help').textContent = coach.analysis?.blundered
        ? 'Practice suggestion: this position uses the configured human-style error, so it is not Nyx\'s strongest or guaranteed move.'
        : staged
          ? 'Reveal in steps: idea, then piece, then move. The arrow appears only at the move step.'
          : 'Move arrow: the recommendation is shown immediately. Choose Reveal in steps for idea-first hints.';
      const feedback = coach.feedback;
      $('.coach-feedback').textContent = feedback
        ? feedback.status === 'rated'
          ? `Last move: ${feedback.verdict}${Number.isFinite(feedback.loss) ? ` (${feedback.loss} cp)` : ''} · search comparison, not ground truth.`
          : `Last move unrated: ${feedback.reason || 'not enough comparable evidence'}.`
        : '';
      countdownAt = Number(data.nextMoveAt) || 0;
      updateCountdown();
      const coachMoveHidden = coaching && coach.active && coach.hintLevel !== 'move';
      $('.move').textContent = coachMoveHidden ? '—' : result?.move
        ? `${result.move.slice(0,2)}–${result.move.slice(2,4)}${result.move[4] ? '=' + result.move[4].toUpperCase() : ''}` : '—';
      $('.score').textContent = result?.source === 'book' ? 'Book' : result ? `${(result.score * (data.resultTurn === 'b' ? -1 : 1) / 100).toFixed(2)}` : '—';
      $('.metrics').textContent = result?.source === 'book' ? result.opening
        : result ? `Depth ${result.depth} / ${result.nodes.toLocaleString()} nodes / ${result.time} ms`
          : 'Search runs on your device';
      if (data.profile?.moves >= 6 && data.profile.adaptedStyle && data.profile.style !== 'balanced') {
        $('.metrics').textContent += ` · vs ${data.profile.style} → ${data.profile.adaptedStyle}`;
      }
      $('.status').textContent = data.message || 'Ready.';
      $('.toggle').textContent = data.running || data.once ? 'Stop' : data.settings.control === 'coach' ? 'Start coach' : 'Start autoplay';
      $('.once').textContent = data.settings.control === 'coach' ? 'Suggest one move' : 'Play one move';
      $('.toggle').classList.toggle('stopping', data.running || data.once);
      $('.toggle').disabled = !data.state.available && !(data.running || data.once);
      $('.once').disabled = !data.state.available || data.running || data.once;
    }
    async function open() {
      await initialized;
      const stylesLoaded = await styleReady;
      if (!stylesLoaded) throw new Error('Overlay stylesheet did not load. Reload the extension and tab.');
      panel.hidden = false;
      launcher.hidden = true;
      clampLayout({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), width: panel.offsetWidth, height: panel.offsetHeight });
      $('.close').focus();
      request('status').then(render).catch((error) => { $('.status').textContent = error.message; });
    }
    launcher.addEventListener('click', open);
    $('.close').addEventListener('click', () => { persistLayout(); panel.hidden = true; launcher.hidden = false; launcher.focus(); });
    $('.tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (!tab) return;
      selectTab(tab.dataset.tab, true);
    });
    $('.tabs').addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...shadow.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      let next;
      if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs.at(-1);
      else next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
    });
    $('.toggle').addEventListener('click', () => action($('.toggle').classList.contains('stopping') ? 'stop' : 'start'));
    $('.once').addEventListener('click', () => action('once'));
    $('.review-run').addEventListener('click', () => action('review'));
    $('.review-cancel').addEventListener('click', () => action('review-cancel'));
    $('.session-reset').addEventListener('click', async () => {
      try {
        render(await request('session-reset'));
        $('.status').textContent = 'Session stats reset.';
      } catch (error) { $('.status').textContent = error.message; }
    });
    $('.coach-reveal').addEventListener('click', async () => {
      try { render(await request('coach-reveal')); }
      catch (error) { $('.status').textContent = error.message; }
    });
    fields.forEach((key) => $(`[name="${key}"]`)?.addEventListener('input', updateForm));
    fields.forEach((key) => $(`[name="${key}"]`)?.addEventListener('change', async () => {
      updateForm();
      try {
        await saveSettings();
        $('.status').textContent = 'Settings saved.';
        // Selecting Coach is an explicit request for the coach controls, so
        // bring its focused tab forward. Switching tabs changes no state.
        if (key === 'control') selectTab($('[name="control"]').value === 'coach' ? 'coach' : 'play', true);
      }
      catch (error) { $('.status').textContent = error.message; }
    }));
    // Mode and pace are segmented buttons backed by hidden form fields.
    shadow.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
      $('[name="mode"]').value = button.dataset.mode;
      // Ruthless is the "beat the bot" mode; don't leave it capped at a
      // human-mode depth the user set months ago.
      if (button.dataset.mode === 'ruthless' && Number($('[name="depth"]').value) < 10) {
        $('[name="depth"]').value = '12';
      }
      updateForm();
      try { await saveSettings(); $('.status').textContent = button.dataset.mode === 'ruthless' ? 'Ruthless mode armed.' : 'Human mode armed.'; }
      catch (error) { $('.status').textContent = error.message; }
    }));
    shadow.querySelectorAll('[data-pace]').forEach((button) => button.addEventListener('click', async () => {
      const preset = NyxSettings.paces[button.dataset.pace];
      if (!preset) return;
      $('[name="pace"]').value = button.dataset.pace;
      $('[name="timeMs"]').value = preset.timeMs;
      $('[name="delayMs"]').value = preset.delayMs;
      if (button.dataset.pace === 'deep' && Number($('[name="depth"]').value) < 12) {
        $('[name="depth"]').value = '12';
      }
      updateForm();
      try { await saveSettings(); $('.status').textContent = `${button.textContent} pace saved.`; }
      catch (error) { $('.status').textContent = error.message; }
    }));
    let drag;
    $('header').addEventListener('pointerdown', (event) => { if (event.target.closest('button')) return; const rect = panel.getBoundingClientRect(); drag = { x: event.clientX - rect.left, y: event.clientY - rect.top }; event.currentTarget.setPointerCapture(event.pointerId); });
    $('header').addEventListener('pointercancel', () => { if (drag) persistLayout(); drag = null; });
    $('header').addEventListener('pointermove', (event) => { if (!drag) return; panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, event.clientX - drag.x))}px`; panel.style.top = `${Math.max(8, Math.min(innerHeight - panel.offsetHeight - 8, event.clientY - drag.y))}px`; });
    $('header').addEventListener('pointerup', () => { if (drag) persistLayout(); drag = null; });
    new ResizeObserver(() => { if (!panel.hidden) { clampLayout({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), width: panel.offsetWidth, height: panel.offsetHeight }); persistLayout(); } }).observe(panel);
    addEventListener('resize', () => clampLayout({ left: parseFloat(panel.style.left), top: parseFloat(panel.style.top), width: panel.offsetWidth, height: panel.offsetHeight }));
    addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) { persistLayout(); panel.hidden = true; launcher.hidden = false; launcher.focus(); }
      else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'y') { event.preventDefault(); open(); }
    });
    const poll = setInterval(() => { if (!panel.hidden) request('status').then(render).catch((error) => { $('.status').textContent = error.message; }); }, 650);
    // Results that must appear at once (Coach recommendations) push a refresh
    // instead of waiting for the next 650 ms poll. The poll remains the
    // fallback for clocks, review progress, and other slow-changing state.
    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window || event.origin !== location.origin || data?.channel !== channel ||
          data.direction !== 'extension' || data.type !== 'status-changed' || panel.hidden) return;
      request('status').then(render).catch((error) => { $('.status').textContent = error.message; });
    });
    const countdownTick = setInterval(updateCountdown, 200);
    addEventListener('pagehide', () => { clearInterval(poll); clearInterval(countdownTick); persistLayout(); root.remove(); });
    return { panel, launcher, render, clampLayout, updateForm, request, open, styleReady, initialized };
    })();
      return overlay;
    });
    return overlayInitialization;
  }

  function send(data) {
    window.postMessage({ channel, direction: 'extension', ...data }, location.origin);
  }
  // Human pacing is an additive pause: search time is not subtracted from it.
  // That distinction is what makes the pause actually felt on rapid and deep
  // paces instead of being swallowed by a 5-second search.
  const HUMAN_PAUSE = [
    { limit: 250, min: 220, max: 980 },
    { limit: 800, min: 1150, max: 3300 },
    { limit: 2200, min: 3800, max: 9000 },
    { limit: Infinity, min: 1600, max: 5200 }
  ];
  function pauseRange(budget = Number(settings.timeMs) || 0) {
    return HUMAN_PAUSE.find((range) => budget <= range.limit) || HUMAN_PAUSE[HUMAN_PAUSE.length - 1];
  }
  // Remaining time changes how a person behaves. Low on the clock they move on
  // instinct; with a big reserve they settle in. The bridge supplies clocks
  // only when it can read them, so absence just means a normal pause.
  function clockScale() {
    const clocks = state.clocks;
    if (!clocks || selectedSide === 'both') return 1;
    const mine = clocks[selectedSide];
    if (!Number.isFinite(mine)) return 1;
    if (mine < 15000) return 0.28;
    if (mine < 40000) return 0.5;
    if (mine < 90000) return 0.78;
    if (mine > 480000) return 1.12;
    return 1;
  }
  function humanPause(result = null) {
    if (settings.mode === 'ruthless') return 0;
    // "Play one move" is a direct instruction, not a game turn.
    if (once) return 0;
    const range = pauseRange();
    let pause = range.min + Math.random() * (range.max - range.min);
    // Occasionally a person just bangs out a move. Occasionally they tank on
    // nothing in particular. Uniform pauses are the easiest pattern to spot.
    const roll = Math.random();
    if (roll < 0.08) pause *= 0.3 + Math.random() * 0.35;
    else if (roll > 0.93) pause *= 1.35 + Math.random() * 0.55;
    if (result) {
      if (result.source === 'book') pause *= 0.78;
      else if (result.legalMoves === 1) pause *= 0.32;
      else if (result.exactScores && Number.isFinite(result.gap) && result.gap > 150) pause *= 0.7;
      else if (result.exactScores && Number.isFinite(result.gap) &&
        result.gap < 18 && result.legalMoves > 22) pause *= 1.2;
    }
    pause *= clockScale();
    if (settings.adaptive) pause *= tempo?.scale() ?? 1;
    const mouse = globalThis.NyxHuman?.mousePause?.();
    if (mouse) pause += mouse.hover + mouse.settle;
    const plan = turnClock(result?.time || 0);
    return Math.max(0, Math.round(Math.min(pause, plan.pauseMax)));
  }
  function turnClock(elapsed = 0) {
    return globalThis.NyxHuman?.clockPlan({ remaining: state.clocks?.[state.turn], fen: state.fen, elapsed })
      ?? { searchMax: 5000, pauseMax: Infinity, errorScale: 1 };
  }
  // Human mode jitters both sides of the clock: search budget and pause.
  // Ruthless sends the configured budget and plays as soon as the result lands.
  function thinkOptions() {
    const options = { ...settings };
    // Coach shows the same human recommendation Autoplay would play, including
    // its configured practice errors. Only the actual board input stays manual.
    if (settings.control === 'coach') return { ...options, elo: 'max' };
    if (settings.mode !== 'ruthless') {
      const jitter = 0.7 + Math.random() * 0.55;
      options.timeMs = Math.max(50, Math.round(settings.timeMs * jitter));
      if (settings.adaptive && profiler) {
        const adapted = profiler.adapt(options);
        options.style = adapted.style;
        // Adapt the style without silently flattening an explicit high-variety
        // choice to 12. Tactical checks still narrow the engine candidate pool.
        options.variety = Math.max(settings.variety, adapted.variety);
        options.timeMs = Math.max(50, Math.round(options.timeMs * adapted.timeScale));
        options.profile = adapted.profile;
      }
      options.timeMs = Math.max(50, Math.round(Math.min(options.timeMs, turnClock().searchMax)));
    }
    return options;
  }
  // Pick a book seed that avoids the lines played in the last dozen games.
  // The same seed is passed to the worker, so the local preview and the actual
  // book move cannot disagree.
  function openingSeed(fen, options, fullmove) {
    const base = (gameSeed + fullmove * 131 + (fen.split(' ')[1] === 'w' ? 7 : 19)) >>> 0;
    const C = globalThis.NyxChess;
    if (!C?.Position || !globalThis.NyxOpenings?.pick) return base;
    try {
      let best = base, bestPenalty = Infinity, hasBook = false;
      for (let k = 0; k < 6; k++) {
        const seed = (base + Math.imul(k + 1, 0x9e3779b1)) >>> 0;
        const pick = globalThis.NyxOpenings.pick(fen, { ...options, bookSeed: seed });
        if (pick?.source !== 'book' || !pick.move) continue;
        const position = new C.Position(fen);
        const move = position.legalMoves().find((candidate) => C.uci(candidate) === pick.move);
        if (!move) continue;
        position.make(move);
        const signature = C.positionKey(position.fen());
        const last = Number(openingMemory[signature]);
        const age = Number.isFinite(last) ? openingGame - last : Infinity;
        const penalty = age < 12 ? 12 - Math.max(0, age) : 0;
        hasBook = true;
        if (penalty < bestPenalty) { best = seed; bestPenalty = penalty; }
      }
      return hasBook ? best : base;
    } catch { return base; }
  }
  function rememberOpening(historyFens) {
    if (!Array.isArray(historyFens) || historyFens.length < 3 || !globalThis.NyxChess?.positionKey) return;
    openingGame++;
    for (let i = 1; i < Math.min(13, historyFens.length); i++) {
      try { openingMemory[globalThis.NyxChess.positionKey(historyFens[i])] = openingGame; }
      catch { /* ignore malformed history */ }
    }
    const newest = Object.entries(openingMemory).sort((a, b) => b[1] - a[1]).slice(0, 160);
    openingMemory = Object.fromEntries(newest);
    chrome.storage.local.set({ openingHistory: { v: 1, game: openingGame, entries: openingMemory } }).catch(() => {});
  }
  // Session storage is per tab, so a queue survives Chess.com navigation but
  // not a closed tab. The timestamp stops a stale queue from reviving later.
  function readQueueIntent() {
    try {
      const saved = Number(sessionStorage.getItem(queueKey));
      return Number.isFinite(saved) && saved > 0 && Date.now() - saved < queueMaxAge;
    } catch { return false; }
  }
  function writeQueueIntent(on) {
    try {
      if (on) sessionStorage.setItem(queueKey, String(Date.now()));
      else sessionStorage.removeItem(queueKey);
    } catch { /* storage can be unavailable in tests or restricted tabs */ }
  }
  function scheduleQueue(delay = 4000) {
    if (!queueArmed || queueTimer) return;
    queueTimer = setTimeout(() => {
      queueTimer = null;
      queueStep();
    }, delay);
  }
  function armQueue() {
    queueArmed = true;
    writeQueueIntent(true);
    scheduleQueue(1200);
  }
  function disarmQueue() {
    queueArmed = false;
    clearTimeout(queueTimer);
    queueTimer = null;
    writeQueueIntent(false);
  }
  // This watchdog is deliberately separate from tick(): a navigation destroys
  // the page, and the next content script has to re-arm itself and click Start
  // Game / Play before there is any live board to tick.
  function queuePage(url = state.url) {
    try {
      return /^\/(play|game)(\/|$)/.test(new URL(url).pathname);
    } catch { return false; }
  }
  function sendQueueAction(type) {
    if (!running && !once) return false;
    if (queueAttempts >= maxQueueAttempts) {
      stop(`Queue stopped after ${maxQueueAttempts} attempts. Check the Chess.com page, then press Start.`);
      return false;
    }
    queueAttempts++;
    lastQueueAction = Date.now();
    send({ type });
    return true;
  }
  function queueStep() {
    if (!queueArmed) return;
    if (enforceSessionLimit()) return;
    if (settings.control === 'coach' || !settings.autoRematch) {
      disarmQueue();
      return;
    }
    writeQueueIntent(true);
    if (!queuePage()) {
      phase = 'queueing';
      message = 'Queue paused outside a game page.';
      return scheduleQueue(5000);
    }
    if (!state.available || state.setupPage) {
      if (Date.now() - lastQueueAction > 7000) {
        if (!sendQueueAction('queue')) return;
      }
      phase = 'queueing';
      message = 'Queue armed. Looking for the next game…';
      return scheduleQueue(4000);
    }
    if (state.result && state.result !== '*') {
      if (running) gameOver();
      return scheduleQueue(3000);
    }
    if (!running) {
      try { start(false); }
      catch (error) {
        phase = 'queueing';
        message = error.message;
      }
      return scheduleQueue(3000);
    }
    if (state.boardId !== lockedBoard || state.url !== lockedUrl) {
      lockedBoard = state.boardId;
      lockedUrl = state.url;
      lastAttempt = null;
      if (settings.side === 'auto') selectedSide = state.playingAs || state.orientation;
      if (active) cancelWork();
      tick();
    }
    scheduleQueue(5000);
  }
  function cancelWork() {
    active = null;
    nextMoveAt = 0;
    syncErrorBudget();
    clearTimeout(timer);
    clearTimeout(moveTimer);
    // A game search and a review must never compete for the CPU. The host
    // terminates the review worker on this cancel; update the panel at once
    // rather than waiting for the round trip.
    if (review?.active) {
      review.active = false;
      review.error = null;
      review.summary = 'Review cancelled.';
    }
    enginePort?.postMessage({ type: 'cancel' });
    send({ type: 'cancel' });
  }
  function reviewSummary(report) {
    if (!report) return '';
    const counts = report.counts || {};
    const parts = [];
    for (const [key, label] of [['blunder', 'blunder'], ['mistake', 'mistake'], ['inaccuracy', 'inaccuracy']]) {
      if (counts[key]) parts.push(`${counts[key]} ${label}${counts[key] === 1 ? '' : 's'}`);
    }
    if (!parts.length) parts.push('no blunders or mistakes');
    return `Review: ${report.reviewed} ${report.side === 'b' ? 'Black' : 'White'} moves, ` +
      `${parts.join(', ')}. Average loss ${report.averageLoss} cp` +
      `${report.unrated ? ` · ${report.unrated} unrated` : ''}. ` +
      'Search estimate, not a Chess.com grade.';
  }
  function compactReview(report) {
    if (!report) return null;
    return {
      version: report.version,
      side: report.side,
      reviewed: report.reviewed,
      rated: report.rated,
      unrated: report.unrated,
      counts: report.counts,
      averageLoss: report.averageLoss,
      clean: report.clean,
      stopped: report.stopped,
      worst: (report.worst || []).map(({ ply, number, played, best, loss, verdict, matched, comparable, beforeDepth, afterDepth }) => ({
        ply, number, played, best, loss, verdict, matched, comparable, beforeDepth, afterDepth
      }))
    };
  }
  function canReview() {
    return !running && !once && !active && !queueArmed && engineReady &&
      Boolean(state.available) &&
      Boolean(state.result && state.result !== '*') &&
      Array.isArray(state.historyFens) && state.historyFens.length > 1 &&
      (selectedSide === 'w' || selectedSide === 'b') &&
      !review?.active;
  }
  function startReview() {
    if (review?.active) throw new Error('A review is already running.');
    if (running || once) throw new Error('Stop autoplay before reviewing the last game.');
    if (queueArmed) throw new Error('Turn off Auto-rematch before reviewing; the next game would compete with the review.');
    if (!state.available) throw new Error('Open a Chess.com board first.');
    if (!state.result || state.result === '*') throw new Error('Finish a game before reviewing it.');
    if (selectedSide !== 'w' && selectedSide !== 'b') throw new Error('Choose White or Black to review a game.');
    if (!Array.isArray(state.historyFens) || state.historyFens.length < 2) {
      throw new Error('No move history is available for this game.');
    }
    if (!engineReady) {
      ensureEngine();
      throw new Error('Engine is still loading. Try again in a moment.');
    }
    review = {
      id: ++reviewSerial,
      active: true,
      done: 0,
      total: 0,
      report: null,
      summary: 'Starting review…',
      error: null
    };
    enginePort.postMessage({
      type: 'review',
      id: review.id,
      historyFens: state.historyFens.slice(),
      side: selectedSide,
      // Small budget: review is an explanation, not a second game. Both
      // searches get the same limits; review.js refuses to grade a move when
      // their completed depths differ anyway.
      depth: 8,
      timeMs: 1200,
      nodeLimit: 30000
    });
  }
  function cancelReview(text = 'Review cancelled.') {
    if (!review?.active) return;
    review.active = false;
    review.error = null;
    review.summary = text;
    enginePort?.postMessage({ type: 'review-cancel', id: review.id });
  }
  function samePosition(a, b) {
    return a?.revision === b?.revision && a?.fen === b?.fen;
  }
  // NyxProfile.inferMove() reports FEN board indices (a8 = 0), while the
  // engine's squareName() uses a1 = 0. Convert before comparing move strings.
  function boardSquareName(index) {
    return 'abcdefgh'[index & 7] + (8 - (index >> 3));
  }
  // ---------------------------------------------------------------------
  // Session lifecycle. A game starts when the board first shows a fresh
  // position, and ends only when the bridge reports a terminal result.
  // Repeated terminal states (clock ticks, orientation flips) are deduped by
  // the game identity, not by revision: revisions move all the time.
  function modeNow() {
    if (settings.control === 'coach') return 'coach';
    return settings.mode === 'ruthless' ? 'ruthless' : 'human';
  }
  function sessionLimits() {
    return { stopAfterGames: settings.stopAfterGames, stopAfterMinutes: settings.stopAfterMinutes };
  }
  function gameSide(state) {
    if (settings.side === 'w' || settings.side === 'b') return settings.side;
    if (settings.side === 'both') return 'both';
    return state.playingAs || selectedSide || state.orientation || null;
  }
  function gameIdentity(state) {
    const direct = state.gameId || globalThis.NyxSession?.gameIdFromUrl?.(state.url);
    // currentGame.serial separates two games on the same URL (a rematch can
    // reuse the page), while repeated terminal observations keep the serial.
    const instance = currentGame?.serial || 0;
    if (direct) return `game:${direct}:${instance}`;
    // No game id in the URL (computer/analysis boards). The FEN and history
    // length are stable for every observation of the same finished game, and
    // change when a new game is started on the same URL.
    return `ctx:${state.url}|${state.fen}|${state.result}|${state.historyFens?.length || 0}`;
  }
  function beginGame(state) {
    currentGame = {
      serial: ++gameSerial,
      boardId: state.boardId,
      url: state.url,
      side: gameSide(state),
      mode: modeNow(),
      startedAt: Date.now(),
      initialMs: null,
      recorded: false
    };
    queueAttempts = 0;
    queueFailures = 0;
    nextMoveAt = 0;
  }
  function observeClocks(state) {
    if (!currentGame || currentGame.initialMs != null || !state.clocks) return;
    // Only the opening clock is a time-control observation. Attaching to a
    // game in progress must not pretend the remaining time is the control.
    const fullmove = Number(state.fen?.split(' ')[5]) || 1;
    if (fullmove > 4) return;
    const maximum = Math.max(Number(state.clocks.w) || 0, Number(state.clocks.b) || 0);
    if (maximum > 0) currentGame.initialMs = maximum;
  }
  function recordTerminal(state) {
    if (!currentGame || currentGame.recorded) return;
    if (!globalThis.NyxSession?.isTerminal?.(state.result)) return;
    const result = globalThis.NyxSession.normalizeResult(state.result, currentGame.side);
    currentGame.recorded = true;
    const record = sessionStats?.recordGame?.({
      id: gameIdentity(state),
      result,
      mode: currentGame.mode,
      timeControl: globalThis.NyxSession.classifyTime(currentGame.initialMs),
      startedAt: currentGame.startedAt,
      endedAt: Date.now(),
      moves: Array.isArray(state.historyFens) ? Math.max(0, state.historyFens.length - 1) : 0
    });
    if (!record?.recorded) return;
    const view = sessionStats.summary(Date.now(), sessionLimits());
    if ((running || once) && view.limit?.reached) {
      return stop(`Session limit reached: ${view.limit.reasons.join(' and ')}. Stats stay until Reset stats.`);
    }
    if (!running && !once) {
      message = `Game finished: ${state.result}. Session: ${view.games} game${view.games === 1 ? '' : 's'}.`;
    }
  }
  function enforceSessionLimit() {
    if (!running && !once) return false;
    const view = sessionStats?.summary?.(Date.now(), sessionLimits());
    if (!view?.limit?.reached) return false;
    stop(`Session limit reached: ${view.limit.reasons.join(' and ')}. Stats stay until Reset stats.`);
    return true;
  }
  function sessionView() {
    return sessionStats?.summary?.(Date.now(), sessionLimits()) || null;
  }
  // ---------------------------------------------------------------------
  // Coach presentation. NyxCoach is pure: this controller owns the reveal
  // level and sends the DTO to the page bridge, which only draws arrows and
  // marks. No coach action ever moves a piece.
  function coachActive() {
    return Boolean(coachGuidance && state.available &&
      globalThis.NyxCoach?.isStale?.(coachGuidance, state.fen, state.revision) === false);
  }
  function sendCoachLayer() {
    send({ type: 'coach', guidance: coachGuidance || null, reveal: coachReveal,
      mode: settings.coachHints, threats: Boolean(settings.coachThreats) });
  }
  function rebuildCoach(result = coachResult) {
    if (!globalThis.NyxCoach?.buildGuidance || !result || !state.available) {
      coachGuidance = null;
      return null;
    }
    coachResult = result;
    try {
      coachGuidance = globalThis.NyxCoach.buildGuidance(state.fen, result, {
        revision: state.revision,
        hintLevel: coachReveal,
        includeSecond: Boolean(settings.coachSecond),
        includeThreats: Boolean(settings.coachThreats),
        ...(coachPrevious ? { previous: coachPrevious } : {})
      });
    } catch {
      coachGuidance = null;
    }
    sendCoachLayer();
    return coachGuidance;
  }
  function clearCoachLayer() {
    coachGuidance = null;
    coachResult = null;
    coachReveal = coachDefaultReveal();
    send({ type: 'coach', guidance: null });
  }
  function resetCoachState() {
    coachPrevious = null;
    clearCoachLayer();
  }
  function cycleCoachHint() {
    if (!coachActive()) throw new Error('There is no current coach hint to reveal.');
    if (settings.coachHints === 'staged') {
      coachReveal = coachReveal === 'concept' ? 'piece' : coachReveal === 'piece' ? 'move' : 'concept';
    } else {
      // Arrow mode is a single visibility toggle. It never cycles through the
      // staged piece level, which would be a hidden extra step.
      coachReveal = coachReveal === 'move' ? 'concept' : 'move';
    }
    rebuildCoach();
    phase = 'coaching';
    message = coachGuidance?.hint?.text || 'Coach hint updated.';
  }
  function secondAvailability(guidance) {
    if (!guidance) return { available: false, reason: 'Start Coach to check for an alternative.' };
    if (guidance.analysis?.exactScores !== true) {
      return { available: false, reason: 'This search does not expose exact comparable root scores, so no alternative is ranked.' };
    }
    if (settings.coachSecond !== true) return { available: true, reason: 'Alternative suggestions are off.' };
    if (!guidance.second) return { available: true, reason: 'No comparable alternative in this search.' };
    return { available: true, reason: 'Shown when a second candidate has a directly comparable score. No rank claim is made.' };
  }
  function coachView() {
    const active = coachActive();
    const hintMode = settings.coachHints;
    if (!active) return {
      active: false, hintLevel: coachReveal, hintMode, status: 'idle',
      secondAvailable: false, secondReason: 'Start Coach to check for an alternative.',
      threats: { inCheck: false, immediate: 0, king: null, labels: [], total: 0 }
    };
    const guidance = coachGuidance;
    const alt = secondAvailability(guidance);
    const threats = guidance.threats?.immediate || [];
    return {
      active: true,
      status: guidance.status,
      hintLevel: coachReveal,
      hintMode,
      arrowVisible: coachReveal === 'move',
      hint: guidance.hint,
      suggestion: coachReveal === 'move' && guidance.suggestion
        ? { uci: guidance.suggestion.uci, san: guidance.suggestion.san, check: guidance.suggestion.check, mate: guidance.suggestion.mate }
        : null,
      second: coachReveal === 'move' && guidance.second
        ? { san: guidance.second.san, score: guidance.second.score } : null,
      secondAvailable: alt.available,
      secondReason: alt.reason,
      explanation: guidance.explanation,
      analysis: guidance.analysis,
      feedback: guidance.feedback,
      threats: {
        inCheck: Boolean(guidance.threats?.inCheck),
        immediate: threats.length,
        king: guidance.threats?.king?.square || null,
        labels: threats.slice(0, 3).map((threat) => threat.text).filter(Boolean),
        total: threats.length
      },
      safety: {
        hanging: (guidance.safety?.own || []).filter((item) => item.hanging).length,
        attacked: (guidance.safety?.own || []).filter((item) => item.status === 'attacked').length
      },
      limitations: guidance.evidence?.limitations || [],
      warnings: guidance.warnings || [],
      stale: false
    };
  }
  function stop(text = 'Stopped.') {
    running = false;
    once = false;
    rematchFor = undefined;
    rematchTries = 0;
    declineThisGame = false;
    clearTimeout(rematchTimer);
    rematchTimer = null;
    if (review?.active) cancelReview();
    disarmQueue();
    cancelWork();
    sessionStats?.observeActive?.(false);
    resetCoachState();
    phase = 'idle';
    message = text;
  }
  function status() {
    const profile = profiler ? profiler.profile() : null;
    if (profile && settings.adaptive) profile.adaptedStyle = profiler.adapt(settings).style;
    return { settings, state, running, once, engineReady, phase, message, result, resultTurn, selectedSide, profile,
      queueArmed, nextMoveAt, countdownMs: nextMoveAt ? Math.max(0, nextMoveAt - Date.now()) : 0,
      queue: { armed: queueArmed, attempts: queueAttempts, failures: queueFailures, lastActionAt: lastQueueAction },
      session: sessionView(),
      coach: coachView(),
      blundersPlayed, pendingBlunder: Boolean(active?.hardBlunder && result?.blundered && active.move),
      review: {
        active: Boolean(review?.active),
        done: review?.done || 0,
        total: review?.total || 0,
        canStart: canReview(),
        report: review?.report || null,
        summary: review?.summary || '',
        error: review?.error || null
      } };
  }
  function syncErrorBudget(reset = false) {
    if (reset) { blundersPlayed = 0; tilt = 0; }
    blunderBudget = Math.max(0, settings.blunders - blundersPlayed - (active?.hardBlunder ? 1 : 0));
  }
  // The floating panel lives in this same content script, so it must not use
  // chrome.runtime.sendMessage: a content script cannot deliver a message to
  // itself. Route panel actions through the same handler the popup uses.
  async function handleRequest(request) {
    await loaded;
    if (request.type === 'configure') {
      const wasRunning = running || once;
      const previousSettings = JSON.stringify(settings);
      settings = NyxSettings.normalize(request.settings);
      syncErrorBudget();
      if (!settings.autoRematch || settings.control === 'coach') disarmQueue();
      else if (running && !once) armQueue();
      await chrome.storage.local.set({ settings });
      if (settings.control !== 'coach') resetCoachState();
      else if (coachGuidance) {
        // Switching hint style changes the starting reveal, but a settings
        // save never discards the current advisory result.
        if (previousSettings !== JSON.stringify(settings) && previousSettings) {
          const before = JSON.parse(previousSettings);
          if (before.coachHints !== settings.coachHints) coachReveal = coachDefaultReveal();
        }
        rebuildCoach();
      }
      if (wasRunning && previousSettings !== JSON.stringify(settings)) {
        selectedSide = settings.side === 'auto' ? state.playingAs || state.orientation : settings.side;
        if (active && !active.sent) {
          cancelWork();
          lastAttempt = null;
          tick();
        }
      }
    } else if (request.type === 'start') start(false);
    else if (request.type === 'once') start(true);
    else if (request.type === 'stop') stop();
    else if (request.type === 'session-reset') {
      sessionStats?.reset?.();
      message = 'Session stats reset.';
      phase = running || once ? phase : 'idle';
    }
    else if (request.type === 'coach-reveal') cycleCoachHint();
    else if (request.type === 'review') startReview();
    else if (request.type === 'review-cancel') cancelReview();
    else if (request.type !== 'status') throw new Error(`Unknown request: ${request.type}`);
    return { ok: true, ...status() };
  }
  function ensureEngine() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/host.html');
    frame.hidden = true;
    frame.title = 'Nyx Chess engine';
    frame.setAttribute('aria-hidden', 'true');
    frame.addEventListener('load', () => {
      const pipe = new MessageChannel();
      enginePort?.close();
      enginePort = pipe.port1;
      enginePort.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(engineTimer);
          engineReady = true;
          tick();
          return;
        }
        if (data.type === 'review-progress') {
          if (!review || review.id !== data.id || !review.active) return;
          review.done = Number(data.done) || 0;
          review.total = Number(data.total) || 0;
          return;
        }
        if (data.type === 'review-result') {
          if (!review || review.id !== data.id || !review.active) return;
          review.active = false;
          if (data.error) {
            review.error = String(data.error);
            review.summary = `Review failed: ${data.error}`;
            return;
          }
          const report = compactReview(data.review);
          review.report = report;
          review.done = review.total = report?.reviewed || 0;
          review.summary = reviewSummary(report);
          return;
        }
        if (data.type === 'review-cancelled') {
          if (!review || review.id !== data.id) return;
          review.active = false;
          review.summary = 'Review cancelled.';
          return;
        }
        if (!active || data.id !== active.id) return;
        if (data.error) {
          lastAttempt = `${state.boardId}:${state.revision}`;
          return stop(`Engine error: ${data.error}`);
        }
        if (data.type !== 'result') return;
        if (!samePosition(active, state) || data.fen !== active.fen) {
          cancelWork();
          tick();
          return;
        }
        stateErrorCount = 0;
        lastStateError = undefined;
        result = data.result;
        resultTurn = state.turn;
        ourScore = Number.isFinite(result.score)
          ? (selectedSide === 'b' || selectedSide === 'w'
            ? (state.turn === selectedSide ? result.score : -result.score)
            : result.score)
          : null;
        // The book answers before the search starts, and some positions have no
        // reasonable losing alternative. Give a hard-blunder budget back.
        if (active.hardBlunder && (result.source === 'book' || !result.blundered)) {
          // The request could not be fulfilled; return its reservation.
          active.hardBlunder = false;
          syncErrorBudget();
        }
        if (!result.move) return stop(result.mate ? 'Checkmate.' : 'No legal moves.');
        // Resigning a dead position is human; grinding 40 moves down a queen
        // is not. The score is from the current position, so this cannot fire
        // on a stale evaluation from an earlier turn.
        if (running && settings.control !== 'coach' && settings.mode !== 'ruthless' && settings.adaptive && !resignTried &&
            result.source !== 'book' && Number.isFinite(ourScore) &&
            globalThis.NyxHuman?.shouldResign?.(state.fen, {
              score: ourScore,
              movesPlayed: Number(state.fen.split(' ')[5] || 1) * 2,
              opponentRating: settings.elo === 'max' ? 2200 : Number(settings.elo),
              rng: Math.random
            })) {
          resignTried = true;
          send({ type: 'resign' });
          return stop('Resigned a lost position.');
        }
        active.move = result.move;
        if (settings.control === 'coach') {
          coachReveal = coachDefaultReveal();
          rebuildCoach(result);
          phase = 'coaching';
          message = coachGuidance?.hint?.text
            ? `${coachGuidance.hint.text}${settings.coachHints === 'staged' ? ' Use Reveal piece or Reveal move for more.' : ''}`
            : 'Coach suggestion ready.';
          // A coaching suggestion is not a committed move, so it cannot tilt
          // the next few turns or increment the confirmed-use count. It does
          // spend the per-game budget if accepted, through the board history.
          once = false;
          // Coach is advisory: the result is the deliverable. It never enters
          // the Human post-search pause above, and an open panel is refreshed
          // now rather than on the next status poll.
          nextMoveAt = 0;
          clearTimeout(timer);
          timer = null;
          send({ type: 'status-changed' });
          return;
        }
        send({ type: 'hint', move: result.move });
        phase = 'waiting';
        const pause = humanPause(result);
        message = pause >= 400
          ? `Queued ${result.move}. Pausing ${(pause / 1000).toFixed(1)} s.`
          : `Ready to play ${result.move}.`;
        nextMoveAt = Date.now() + Math.max(0, pause);
        timer = setTimeout(() => { nextMoveAt = 0; play(); }, pause);
      };
      frame.contentWindow.postMessage({ type: 'nyx-engine-connect' }, new URL(frame.src).origin, [pipe.port2]);
    });
    document.documentElement.append(frame);
    engineTimer = setTimeout(() => {
      if (engineReady) return;
      frame?.remove();
      frame = null;
      enginePort?.close();
      enginePort = null;
      stop('Engine could not load. Press Start to retry.');
    }, 8000);
  }
  function start(single) {
    if (!state.available) throw new Error('Open a board, then try again.');
    const limit = sessionView()?.limit;
    if (limit?.reached) throw new Error(`Session limit reached: ${limit.reasons.join(' and ')}. Reset stats to start a new session.`);
    if (currentGame && !currentGame.recorded) {
      // Start is an explicit statement of intent: adopt the mode and side the
      // user chose now, even if the game page was observed earlier.
      currentGame.side = gameSide(state);
      currentGame.mode = modeNow();
    } else if (!currentGame) {
      beginGame(state);
    }
    // The play pages show a preview board at the starting position. Auto-queue
    // uses it to launch a real game. Coach and plain autoplay still analyze the
    // preview because that is what the user asked Start to do; refusing here
    // made the panel look dead on /play/computer and /play/online.
    if (state.setupPage && !single && settings.control !== 'coach' && settings.autoRematch) {
      cancelWork();
      running = true;
      once = false;
      lockedBoard = state.boardId;
      lockedUrl = state.url;
      phase = 'queueing';
      message = 'Queue armed. Starting a new game…';
      selectedSide = settings.side === 'auto' ? state.playingAs || state.orientation : settings.side;
      moveFailures = 0;
      moveFailureFor = null;
      queueAttempts = 0;
      queueFailures = 0;
      // Load the engine now so it is ready by the time the new board appears.
      ensureEngine();
      armQueue();
      lastQueueAction = Date.now();
      sendQueueAction('queue');
      return;
    }
    if (state.result && state.result !== '*') {
      if (settings.control !== 'coach' && settings.autoRematch && !single) {
        running = true; once = false;
        lockedBoard = state.boardId; lockedUrl = state.url;
        rematchFor = undefined; rematchTries = 0;
        armQueue();
        return gameOver();
      }
      throw new Error('This game has ended.');
    }
    if (lastAttempt === `${state.boardId}:${state.revision}`) throw new Error('This position already failed. Wait for a board update before retrying.');
    cancelWork();
    lastStateError = undefined;
    stateErrorCount = 0;
    lockedBoard = state.boardId;
    lockedUrl = state.url;
    selectedSide = settings.side === 'auto' ? state.playingAs || state.orientation : settings.side;
    running = !single;
    once = single;
    sessionStats?.observeActive?.(true);
    if (running && settings.autoRematch && settings.control !== 'coach') armQueue();
    else disarmQueue();
    profiler?.reset(selectedSide);
    tempo?.reset();
    tempo?.observe(state, selectedSide);
    // Stop/Start in the same game must not refill spent blunders.
    const identity = `${state.boardId}:${state.url}`;
    syncErrorBudget(errorGame !== identity);
    errorGame = identity;
    rematchFor = undefined;
    rematchTries = 0;
    declineThisGame = false;
    resignTried = false;
    ourScore = null;
    recordedFor = null;
    clearTimeout(rematchTimer);
    rematchTimer = null;
    lastAttempt = null;
    moveFailures = 0;
    moveFailureFor = null;
    gameSeed = (Math.random() * 0xffffffff) >>> 0;
    form = 0.65 + Math.random() * 0.8;
    tilt = 0;
    ensureEngine();
    tick();
  }
  // Chess.com's rematch button can take a moment to appear after the result
  // banner. Retry a few times, each with a human-sized pause.
  function gameOver() {
    phase = 'finished';
    message = `Game finished: ${state.result}. ${settings.autoRematch
      ? (rematchTries >= 3 ? 'Starting a new game…' : 'Rematch queued…')
      : ''}`;
    if (active || timer) cancelWork();
    if (rematchFor !== state.revision) {
      const ours = selectedSide === 'b' ? 'b' : 'w';
      const outcome = state.result === '1-0' ? (ours === 'w' ? 'win' : 'loss')
        : state.result === '0-1' ? (ours === 'b' ? 'win' : 'loss')
          : state.result === '1/2-1/2' ? 'draw' : null;
      if (profiler && opponentMemory) {
        // Clocks tick after the result, which changes the position revision.
        // Record each game once, keyed by board, result, and move count.
        const gameKey = `${state.boardId}:${state.fen}:${state.result}`;
        if (recordedFor !== gameKey) {
          recordedFor = gameKey;
          opponentMemory.note(state.opponent || 'unknown', profiler.profile(), outcome);
          opponentMemory.save();
          rememberOpening(state.historyFens);
          profiler.reset(selectedSide);
          session?.recordGame?.({ result: outcome, opponentRating: settings.elo });
          // Never decline the very first rematch of a session; after that a
          // rare decline keeps the queue from looking mechanical.
          declineThisGame = Boolean((session?.stats?.().gamesPlayed || 0) > 1 &&
            session?.shouldDeclineRematch?.());
        }
      }
      rematchFor = state.revision;
      rematchTries = 0;
      resignTried = false;
      ourScore = null;
      clearTimeout(rematchTimer);
      rematchTimer = null;
      gameSeed = (Math.random() * 0xffffffff) >>> 0;
      form = 0.65 + Math.random() * 0.8;
      tilt = 0;
      tempo?.reset();
    }
    if (settings.control === 'coach' || !settings.autoRematch || !running || rematchTimer) return;
    if (declineThisGame) {
      // A human sometimes skips the rematch, but auto-queue keeps going: take
      // a longer break, then start a fresh game instead of stopping for good.
      declineThisGame = false;
      phase = 'queueing';
      message = 'Taking a short break before the next game.';
      armQueue();
      const pause = 30000 + Math.random() * 60000;
      rematchTimer = setTimeout(() => {
        rematchTimer = null;
        rematchTries = 3;
        if (!running || !settings.autoRematch) return;
        if (!sendQueueAction('queue')) return;
        scheduleQueue(3000);
      }, pause);
      return;
    }
    // Keep the queue armed across page navigation. After a few Rematch tries,
    // fall back to New Game / Start Game so online games continue even when
    // the opponent does not accept a rematch.
    armQueue();
    const wait = session?.nextGameDelay?.(Date.now()) ??
      (rematchTries ? 5000 + Math.random() * 9000 : 6000 + Math.random() * 12000);
    rematchTimer = setTimeout(() => {
      rematchTimer = null;
      rematchTries++;
      if (!running || !settings.autoRematch) return;
      if (!sendQueueAction(rematchTries <= 2 ? 'rematch' : 'queue')) return;
      scheduleQueue(2500);
    }, wait);
  }
  function tick() {
    if (!running && !once) return;
    if (enforceSessionLimit()) return;
    if (!state.available) {
      if (queueArmed) {
        phase = 'queueing';
        message = 'Queue armed. Looking for the next game…';
        scheduleQueue(3000);
        return;
      }
      return stop('Board disconnected.');
    }
    if (state.setupPage && queueArmed && settings.control !== 'coach') {
      phase = 'queueing';
      message = 'Queue armed. Starting a new game…';
      scheduleQueue(2000);
      return;
    }
    if (state.boardId !== lockedBoard || state.url !== lockedUrl) {
      if (!queueArmed) return stop('Board changed. Press Start to continue.');
      // A queue navigation creates a new board. Re-lock instead of requiring
      // another Start, and adopt the new side. Without this the first queued
      // game sat on "Waiting for the other side" because selectedSide was
      // never initialized by the setup-page branch in start().
      lockedBoard = state.boardId;
      lockedUrl = state.url;
      lastAttempt = null;
      if (settings.side === 'auto') selectedSide = state.playingAs || state.orientation;
      const identity = `${state.boardId}:${state.url}`;
      if (errorGame !== identity) {
        syncErrorBudget(true);
        errorGame = identity;
      }
      if (active) cancelWork();
    }
    if (state.result && state.result !== '*') {
      if (settings.control !== 'coach' && settings.autoRematch && running) return gameOver();
      return stop(`Game finished: ${state.result}`);
    }
    if (!engineReady) {
      // A queue can start the next game without going through start(), so the
      // engine iframe may never have been created. ensureEngine() is
      // idempotent; without this the panel sat on "Loading local engine…".
      ensureEngine();
      phase = 'loading';
      message = 'Loading local engine…';
      return;
    }
    if (active) return;
    if (!once && selectedSide !== 'both' && state.turn !== selectedSide) {
      phase = 'waiting'; message = 'Waiting for the other side.'; return;
    }
    if (lastAttempt === `${state.boardId}:${state.revision}`) return;
    clearTimeout(rematchTimer);
    rematchTimer = null;
    // Human errors come in two sizes. The hard blunder spends the per-game
    // budget; the small inaccuracy is free and keeps the move-quality
    // distribution from looking like a machine's.
    const fullmove = Number((state.fen.split(' ')[5]) || 1);
    let blunder = false, hardBlunder = false, blunderMin = 0, blunderMax = 0;
    // Coach uses the identical error roll. Its budget is tracked against the
    // game just like Autoplay; the only difference is who touches the board.
    if (running && settings.mode !== 'ruthless' && fullmove >= 4) {
      const roll = Math.random();
      // A hard blunder rattles a person for a couple of moves.
      const adaptedError = settings.adaptive && profiler ? profiler.adapt(settings).errorScale : 1;
      const formNow = form * (tilt > 0 ? 1.25 : 1) * turnClock().errorScale * adaptedError;
      if (tilt > 0) tilt--;
      const hardChance = blunderBudget > 0 ? 0.10 * formNow : 0;
      const softChance = 0.16 * formNow;
      if (blunderBudget > 0 && roll < hardChance) {
        blunder = true; hardBlunder = true;
        blunderMin = settings.blunderSeverity === 'major' ? 300 : 80;
        blunderMax = settings.blunderSeverity === 'major' ? 900 : 450;
        blunderBudget--;
      } else if (roll < hardChance + softChance) {
        blunder = true;
        blunderMin = 25; blunderMax = 180;
      } else {
        // Winning endgames get converted with a little drift instead of
        // machine-perfect technique. Small enough to stay winning.
        const plan = globalThis.NyxHuman?.endgamePlan?.(state.fen);
        if (plan && plan.drift > 0 && Math.random() < 0.06 * form) {
          blunder = true;
          blunderMin = 10;
          blunderMax = Math.max(18, Math.min(45, plan.drift));
        }
      }
    }
    active = { id: ++serial, fen: state.fen, revision: state.revision,
      blunder, hardBlunder, blunderMin, blunderMax };
    phase = 'thinking';
    message = `${state.turn === 'w' ? 'White' : 'Black'} to move. Thinking…`;
    const options = thinkOptions();
    enginePort.postMessage({ type: 'think', ...active, blunder, blunderMin, blunderMax,
      bookSeed: openingSeed(state.fen, options, fullmove),
      options,
      historyFens: Array.isArray(state.historyFens) ? state.historyFens : [] });
  }
  function play() {
    if ((!running && !once) || !active) return;
    if (settings.control === 'coach') return;
    if (active.fen !== state.fen || active.revision !== state.revision) {
      cancelWork();
      tick();
      return;
    }
    active.sent = true;
    lastAttempt = `${state.boardId}:${state.revision}`;
    phase = 'confirming';
    message = `Confirming ${active.move}…`;
    send({ type: 'move', ...active, humanize: settings.mode !== 'ruthless' && !once });
    moveTimer = setTimeout(() => stop('Move confirmation timed out. Reload the tab and retry.'), 6000);
  }
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== channel || data.direction !== 'page') return;
    if (data.type === 'state') {
      const changed = state.revision !== data.state.revision || state.fen !== data.state.fen;
      const previousState = state;
      state = data.state;
      // A live game can assign our color after Start without replacing the
      // board or changing its URL. Refresh auto-side before scheduling work.
      // Once a side is locked, an orientation flip is a display change, not a
      // new color assignment; only an explicit playingAs can move the lock.
      if (state.available && settings.side === 'auto') {
        const nextSide = state.playingAs ||
          (selectedSide === 'w' || selectedSide === 'b' || selectedSide === 'both' ? null : state.orientation);
        if (nextSide && nextSide !== selectedSide) {
          if (active) cancelWork();
          result = undefined;
          resultTurn = undefined;
          selectedSide = nextSide;
          if (currentGame && !currentGame.recorded) currentGame.side = nextSide;
          lastAttempt = null;
        }
      }
      // Coach cannot see its own click confirmation. If the board now shows the
      // suggestion it made, count that error as spent (and tilt, just as
      // Autoplay would); an ignored suggestion costs nothing.
      if (settings.control === 'coach' && active?.move && previousState.available &&
          state.fen !== previousState.fen && globalThis.NyxProfile?.inferMove && globalThis.NyxChess?.squareName) {
        try {
          const played = globalThis.NyxProfile.inferMove(previousState.fen, state.fen);
          const move = played ? boardSquareName(played.from) + boardSquareName(played.to) +
            (played.promotion || '') : null;
          if (move === active.move) {
            if (active.hardBlunder && result?.blundered) {
              blundersPlayed++;
              tilt = 2 + Math.floor(Math.random() * 2);
            }
            active.hardBlunder = false;
          }
        } catch { /* an unrecognized transition costs nothing */ }
      }
      if (settings.control === 'coach' && coachGuidance && previousState.available &&
          state.fen !== previousState.fen && globalThis.NyxProfile?.inferMove && globalThis.NyxChess?.squareName) {
        // Keep the analysis of the position before the move so the next search
        // can grade the played move. The coach module refuses to grade unless
        // the two positions and search evidence actually match.
        try {
          const played = globalThis.NyxProfile.inferMove(previousState.fen, state.fen);
          if (played && coachResult) {
            coachPrevious = {
              fen: previousState.fen,
              result: coachResult,
              played: boardSquareName(played.from) + boardSquareName(played.to) + (played.promotion || '')
            };
          }
        } catch { coachPrevious = null; }
      }
      if (coachGuidance && (!state.available ||
          globalThis.NyxCoach?.isStale?.(coachGuidance, state.fen, state.revision) !== false)) {
        clearCoachLayer();
      }
      if (!state.available || state.fen !== previousState.fen || state.boardId !== previousState.boardId) {
        result = undefined;
        resultTurn = undefined;
      }
      const newGame = state.available && (!previousState.available || state.boardId !== previousState.boardId ||
        state.url !== previousState.url ||
        (previousState.result && previousState.result !== '*' && state.result === '*') ||
        (Number(state.fen?.split(' ')[5]) < Number(previousState.fen?.split(' ')[5])));
      if (newGame) {
        if (active) cancelWork();
        resetCoachState();
        // A report belongs to the game that just ended. New game means new
        // history: terminate any review still running and discard its report
        // so a late result cannot be shown against the new board.
        if (review) {
          if (review.active) cancelReview();
          review = null;
        }
        errorGame = `${state.boardId}:${state.url}`;
        syncErrorBudget(true);
        beginGame(state);
      }
      if (!currentGame && state.available) beginGame(state);
      observeClocks(state);
      const wasRunning = running || once;
      recordTerminal(state);
      sessionStats?.observeActive?.(Boolean((running || once) && state.available && !state.setupPage));
      if ((running || once) && (!state.available || state.boardId !== lockedBoard || state.url !== lockedUrl)) {
        if (!state.available) {
          stateErrorCount++;
          if (state.error) lastStateError = state.error;
          return stop(state.error || 'Board disconnected.');
        }
        if (queueArmed) {
          // The queue survives Chess.com replacing the board or navigating to
          // the next game. Re-lock to the new board and let tick() resume.
          lockedBoard = state.boardId;
          lockedUrl = state.url;
          lastAttempt = null;
        } else {
          return stop('Board changed. Press Start to continue.');
        }
      }
      if (state.available) {
        stateErrorCount = 0;
        lastStateError = undefined;
      }
      if (state.available && profiler && selectedSide) {
        profiler.observe(state.historyFens, selectedSide);
        if (state.opponent) profiler.opponent = state.opponent;
      }
      if (running) tempo?.observe(state, selectedSide);
      if (changed && active && !active.sent) {
        cancelWork();
        active = null;
      }
      if (changed && !running && !once && !wasRunning) message = state.available ? 'Board connected. Ready when you are.' : state.error || 'Open a Chess.com board.';
      tick();
    }
    if (data.type === 'queue' || data.type === 'rematch') {
      if (data.ok === false) {
        queueFailures++;
        if (queueFailures >= maxQueueFailures) {
          return stop(`Queue could not ${data.type === 'rematch' ? 'rematch' : 'start a game'} after ${queueFailures} tries. Check the Chess.com page, then press Start.`);
        }
        phase = 'queueing';
        message = `Queue ${data.type} was not accepted (${queueFailures}/${maxQueueFailures}). Retrying…`;
      } else {
        queueFailures = 0;
        phase = 'queueing';
        message = data.type === 'rematch' ? 'Rematch requested. Waiting for the next game…' : 'Next game requested. Waiting for the board…';
      }
      return;
    }
    if (data.type === 'played' && data.id === active?.id) {
      clearTimeout(moveTimer);
      if (data.error) {
        const key = `${state.boardId}:${state.revision}`;
        moveFailures = moveFailureFor === key ? moveFailures + 1 : 1;
        moveFailureFor = key;
        if (running && moveFailures <= 2) {
          active = null;
          lastAttempt = null;
          phase = 'waiting';
          message = 'Move not accepted. Retrying…';
          clearTimeout(timer);
          timer = setTimeout(() => { if (running) tick(); }, 1200);
          return;
        }
        return stop(data.error);
      }
      moveFailures = 0;
      moveFailureFor = null;
      if (active.hardBlunder && result?.blundered) {
        blundersPlayed++;
        tilt = 2 + Math.floor(Math.random() * 2);
      }
      active = null;
      syncErrorBudget();
      if (once) return stop('Move played.');
      phase = 'waiting';
      message = 'Move played. Waiting for the board.';
      send({ type: 'read' });
    }
  });
  const loaded = Promise.all([chrome.storage.local.get('settings'), sessionStats?.ready ?? null]).then(([saved]) => {
    settings = NyxSettings.normalize(saved.settings);
    coachReveal = coachDefaultReveal();
    // A navigation destroys this content script. If the tab still carries the
    // queue intent and Auto-rematch is on, re-arm as soon as the new page is
    // alive; no second Start press.
    if (readQueueIntent() && settings.autoRematch && settings.control !== 'coach') {
      queueArmed = true;
      phase = 'queueing';
      message = 'Queue armed. Looking for the next game…';
      scheduleQueue(1500);
    } else if (readQueueIntent()) {
      writeQueueIntent(false);
    }
  });
  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
    if (request?.channel !== channel) return;
    if (request.type === 'overlay-open') {
      initializeOverlay().then(async (panelOverlay) => {
        await loaded;
        await panelOverlay.open();
        respond({ ok: true, ...status() });
      }).catch((error) => respond({ ok: false, error: error.message, ...status() }));
      return true;
    }
    handleRequest(request)
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message, ...status() }));
    return true;
  });
  window.addEventListener('pageshow', () => {
    if (queueArmed) scheduleQueue(400);
  });
  send({ type: 'read' });
})();
