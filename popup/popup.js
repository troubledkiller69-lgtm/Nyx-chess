(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fields = Object.keys(NyxSettings.defaults);
  // The popup does not render every stored field (custom lines live in the
  // overlay). Only touch inputs that exist, and merge the rest from the
  // current settings so a popup save cannot wipe them.
  const domFields = fields.filter((key) => $(key));
  const fieldValue = (key, value) => key === 'autoRematch' || key === 'adaptive'
    ? ((key === 'autoRematch' ? value === true || value === 'yes' || value === 'on'
      : value !== false && value !== 'no' && value !== 'off') ? 'yes' : 'no')
    : key === 'elo' && value === 'max' ? 2250 : value;
  let tabId;
  let busy = false;
  let current;
  let initialized = false;
  let polling = false;
  let localError = '';
  let connectionError = '';
  let dirty = false;
  let saveVersion = 0;
  let saveQueue = Promise.resolve();
  let responseVersion = 0;
  let requestVersion = 0;
  let savedSettings = '';
  let stopped = false;
  let pollTimer;
  const text = (id, value) => {
    const element = $(id);
    if (element.textContent !== value) element.textContent = value;
  };
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(name, focus = false) {
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    document.querySelector('.panels').scrollTop = 0;
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next != null) { event.preventDefault(); selectTab(tabs[next].dataset.tab, true); }
    });
  });
  for (const color of ['White', 'Black']) {
    for (const opening of NyxOpenings.repertoire.filter((item) => item.side === 'any' || item.side === color[0].toLowerCase())) {
      $('opening' + color).add(new Option(opening.name, opening.id));
    }
  }
  function updateControls() {
    $('custom-label').hidden = !['openingWhite', 'openingBlack'].some((id) => $(id).value === 'custom');
    const elo = Number($('elo').value);
    const maximum = elo === 2250;
    $('eloValue').textContent = maximum ? 'Max' : elo.toLocaleString('en-US');
    $('elo').setAttribute('aria-valuetext', maximum ? 'Maximum engine strength' : `${elo} approximate Elo`);
    $('levelName').textContent = maximum ? 'No Elo handicap' : 'Approximate playing level';
    $('eloNote').textContent = maximum ? 'No Elo handicap. Uses your full depth and time budget.' : 'Actual play varies by position and time; not a rated-strength promise.';
    $('varietyValue').textContent = $('variety').value;
    $('blundersValue').textContent = $('blunders').value;
    for (const id of ['elo', 'variety', 'blunders']) {
      const input = $(id);
      input.style.setProperty('--fill', `${100 * (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))}%`);
    }
  }
  for (const key of domFields) $(key).value = fieldValue(key, NyxSettings.defaults[key]);
  updateControls();

  function display(data) {
    current = data;
    const normalized = NyxSettings.normalize(data.settings);
    text('blunderStatus', normalized.mode === 'ruthless'
      ? 'Deliberate errors off in Ruthless mode.'
      : `Blunders played: ${data.blundersPlayed || 0} / ${normalized.blunders}${data.pendingBlunder ? ' · queued' : ''}. Small inaccuracies are separate.`);
    const settingsKey = JSON.stringify(normalized);
    if (!initialized || (!dirty && !busy && settingsKey !== savedSettings)) {
      for (const key of domFields) $(key).value = fieldValue(key, normalized[key]);
      initialized = true;
      savedSettings = settingsKey;
      updateControls();
    }
    const connected = !!data.state.available;
    const active = Boolean(data.running || data.once);
    $('connection').classList.toggle('connected', connected);
    $('connection').setAttribute('aria-label', connected ? 'Board connected' : 'Board disconnected');
    $('connection').title = connected ? 'Board connected' : 'Board disconnected';
    $('connectionText').textContent = connected ? 'Connected' : 'Offline';
    $('turn').textContent = connected ? `${data.state.turn === 'w' ? 'White' : 'Black'} to move` : 'No board';
    $('phase').textContent = data.phase[0].toUpperCase() + data.phase.slice(1);
    text('status', connectionError || localError || data.error || data.message);
    text('toggle', active ? 'Stop' : normalized.control === 'coach' ? 'Start coach' : 'Start autoplay');
    text('once', normalized.control === 'coach' ? 'Suggest one move' : 'Play one move');
    $('toggle').classList.toggle('stopping', active);
    $('toggle').disabled = busy || !!connectionError || (!active && !connected);
    $('once').disabled = busy || !!connectionError || active || !connected;
    for (const key of domFields) $(key).disabled = busy || active;
    const result = data.result;
    const quality = NyxSettings.moveQuality(result);
    text('quality', quality.label);
    $('quality').title = quality.detail;
    if (result) {
      const move = result.move;
      $('move').textContent = move ? `${move.slice(0, 2)}–${move.slice(2, 4)}${move[4] ? '=' + move[4].toUpperCase() : ''}` : '—';
      const score = result.score * (data.resultTurn === 'b' ? -1 : 1) / 100;
      const mate = result.mate * (data.resultTurn === 'b' ? -1 : 1);
      $('score').textContent = result.source === 'book' ? 'Book' : result.mate ? `${mate < 0 ? '−' : '+'}M${Math.abs(mate)}` : `${score >= 0 ? '+' : ''}${score.toFixed(2)}`;
      $('metrics').textContent = result.source === 'book' ? result.opening : `Depth ${result.depth} / ${result.nodes.toLocaleString()} nodes / ${result.time} ms`;
    } else {
      text('move', '—');
      text('score', '—');
      text('metrics', 'Search runs on your device');
    }
  }
  async function request(type, extra = {}, render = true) {
    if (!Number.isInteger(tabId)) throw new Error('Open Chess.com and select its tab.');
    const version = ++requestVersion;
    let timeout;
    const data = await Promise.race([
      chrome.tabs.sendMessage(tabId, { channel: 'nyx-chess-v1', type, ...extra }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Tab did not respond. Reload Chess.com to reconnect.')), 5000); })
    ]).finally(() => clearTimeout(timeout));
    if (!data) throw new Error('Reload this Chess.com tab to connect the extension.');
    connectionError = '';
    if (render && version >= responseVersion) { responseVersion = version; display(data); }
    if (!data.ok) throw new Error(data.error);
    return data;
  }
  function showError(error, transport = false) {
    const message = /Receiving end|connection|message port/i.test(error.message)
      ? 'Open Chess.com, then reload the tab to connect Nyx Chess.' : error.message;
    if (transport) connectionError = message;
    else localError = message;
    text('status', message);
  }
  function readSettings() {
    const invalid = domFields.map($).find((input) => !input.validity.valid);
    if (invalid) {
      selectTab(invalid.closest('[role="tabpanel"]').id.replace('panel-', ''));
      invalid.reportValidity();
      throw new Error('Check the search budget and move delay.');
    }
    const raw = { ...(current?.settings || {}) };
    for (const key of domFields) raw[key] = key === 'elo' && $('elo').value === '2250' ? 'max' : $(key).value;
    const settings = NyxSettings.normalize(raw);
    if (settings.openingWhite === 'custom' || settings.openingBlack === 'custom') {
      const checked = NyxOpenings.validate(settings.customLine);
      if (!checked.ok || !checked.plies) {
        selectTab('openings');
        throw new Error(checked.error || 'Enter at least one move for your custom opening.');
      }
    }
    return settings;
  }
  async function save() {
    const settings = readSettings();
    const version = ++saveVersion;
    const task = saveQueue.catch(() => {}).then(async () => {
      if (version !== saveVersion) return;
      const data = await request('configure', { settings }, false);
      if (version !== saveVersion) return;
      dirty = false;
      localError = '';
      savedSettings = JSON.stringify(NyxSettings.normalize(data.settings));
      for (const key of domFields) $(key).value = fieldValue(key, data.settings[key]);
      updateControls();
      display(data);
    });
    saveQueue = task;
    return task;
  }
  async function act(type) {
    localError = '';
    busy = true;
    if (current) display(current);
    try {
      if (type !== 'stop') await save();
      await request(type);
    } catch (error) { showError(error); }
    finally { busy = false; if (current) display(current); }
  }
  $('settings').addEventListener('submit', (event) => event.preventDefault());
  $('settings').addEventListener('input', () => { dirty = true; localError = ''; updateControls(); });
  $('settings').addEventListener('change', () => { dirty = true; save().catch(showError); });
  $('toggle').addEventListener('click', () => act(current?.running || current?.once ? 'stop' : 'start'));
  $('once').addEventListener('click', () => act('once'));
  async function poll() {
    if (stopped || busy || polling || document.hidden) return;
    polling = true;
    try { await request('status'); }
    catch (error) { showError(error, true); $('once').disabled = true; $('toggle').disabled = true; }
    finally { polling = false; }
  }
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
      await poll();
      pollTimer = setInterval(poll, 300);
    } catch (error) { showError(error); }
  })();
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(pollTimer); });
})();
