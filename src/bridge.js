(() => {
  'use strict';
  if (window.__nyxChessBridge) return;
  window.__nyxChessBridge = true;
  const channel = 'nyx-chess-v1';
  let board;
  let boardId = 0;
  let revision = 0;
  let previous = '';
  let pending;
  let generation = 0;

  const send = (data) => window.postMessage({ channel, direction: 'page', ...data }, location.origin);
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return element.isConnected && rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  function findBoard() {
    return [...document.querySelectorAll('wc-chess-board, chess-board')]
      .filter((element) => visible(element) && typeof element.game?.getFEN === 'function')
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  }
  function orientation(element) {
    // Piece coordinates also work when the board's flipped class changes name.
    const rect = element.getBoundingClientRect();
    let whiteVotes = 0, blackVotes = 0;
    for (const piece of element.querySelectorAll('.piece')) {
      const square = /(?:^|\s)square-([1-8])([1-8])(?:\s|$)/.exec(piece.className);
      if (!square) continue;
      const file = Number(square[1]) - 1;
      const center = piece.getBoundingClientRect();
      if (!center.width || !center.height || !rect.width || !rect.height) continue;
      const actual = (center.left + center.width / 2 - rect.left) / rect.width;
      const actualRow = (center.top + center.height / 2 - rect.top) / rect.height;
      const white = (file + 0.5) / 8;
      const whiteRow = (8 - Number(square[2]) + 0.5) / 8;
      if (Math.abs(actual - white) < 0.035 && Math.abs(actualRow - whiteRow) < 0.035) whiteVotes++;
      if (Math.abs(actual - (1 - white)) < 0.035 && Math.abs(actualRow - (1 - whiteRow)) < 0.035) blackVotes++;
    }
    // Ignore a dragged/animating piece when the stationary pieces disagree.
    if (whiteVotes !== blackVotes) return whiteVotes > blackVotes ? 'w' : 'b';
    const flipped = element.game?.getOptions?.().flipped;
    if (typeof flipped === 'boolean') return flipped ? 'b' : 'w';
    return element.classList.contains('flipped') || element.hasAttribute('flipped') ? 'b' : 'w';
  }
  // The two name plates next to the board carry a color class. Reading them
  // lets the controller remember an opponent across games instead of treating
  // every rematch as a stranger.
  function names() {
    const result = { w: null, b: null };
    for (const element of document.querySelectorAll('[class*="user-username-component"]')) {
      const name = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!name || name.length > 40) continue;
      const classes = String(element.className);
      if (/username-white/.test(classes)) result.w = name;
      else if (/username-black/.test(classes)) result.b = name;
    }
    return result;
  }
  function parseClock(text) {
    const value = String(text || '').trim();
    if (!/^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?$/.test(value)) return null;
    const parts = value.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
  }
  // Clocks live outside wc-chess-board and their markup changes between
  // layouts, so this is deliberately loose: find time-shaped text near the
  // board, then assign it by vertical position relative to the board centre.
  function clocks() {
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const found = [];
    for (const element of document.querySelectorAll('[class*="clock"], [class*="timer"]')) {
      if (element.childElementCount) continue;
      const ms = parseClock(element.textContent);
      if (ms == null) continue;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (Math.abs(box.top - rect.top) > rect.height * 1.4) continue;
      found.push({ ms, top: box.top });
    }
    if (found.length < 2) return null;
    found.sort((a, b) => a.top - b.top);
    const top = found[0].ms, bottom = found[found.length - 1].ms;
    const flipped = orientation(board) === 'b';
    return flipped ? { w: top, b: bottom } : { w: bottom, b: top };
  }
  function gameId(game) {
    try {
      const options = game?.getOptions?.();
      const value = game?.getGameId?.() ?? game?.getGameID?.() ??
        options?.gameId ?? options?.gameID ?? options?.id ?? null;
      return value == null ? null : String(value).slice(0, 64);
    } catch { return null; }
  }
  function getState() {
    const next = findBoard();
    if (next !== board) { board = next; boardId++; }
    const state = { available: false, boardId, url: location.href };
    if (board) {
      const game = board.game;
      const fen = game.getFEN();
      if (typeof fen === 'string' && /^[wb]$/.test(fen.split(' ')[1])) {
        const playing = game.getPlayingAs?.();
        const plates = names();
        const playerColor = playing === 1 || playing === 'w' || playing === 'white' ? 'w' :
          playing === 2 || playing === 'b' || playing === 'black' ? 'b' : null;
        Object.assign(state, {
          available: true, fen, turn: fen.split(' ')[1], orientation: orientation(board),
          historyFens: game.getHistoryFENs?.() || [],
          playingAs: playerColor,
          opponent: playerColor ? plates[playerColor === 'w' ? 'b' : 'w'] : null,
          clocks: clocks(),
          gameId: gameId(game),
          result: game.getResult?.() || game.getCalculatedResult?.() || '*'
        });
      }
    }
    // /play/online and /play/computer render a preview board before a game
    // starts. Treat that as a setup page so Auto-queue clicks Start Game / Play
    // instead of autoplaying the preview. A visible Resign control or a real
    // move history means a game is already running.
    const setupPath = /^\/play\/(online|computer)\/?$/.test(location.pathname);
    state.setupPage = Boolean(setupPath && state.available && state.result === '*' &&
      (state.historyFens || []).length <= 1 && !hasControl(/^(resign|offer draw|draw)$/i));
    // Clock/name updates are telemetry, not a new chess position. Including
    // them here cancels every search and queued move on a running clock.
    const key = JSON.stringify([state.available, state.boardId, state.url,
      state.fen, state.result, state.playingAs, state.orientation, state.setupPage, state.gameId]);
    if (key !== previous) { revision++; previous = key; }
    return { ...state, revision };
  }
  function publish() {
    try {
      if (hintMove) {
        const fen = board?.game?.getFEN?.();
        if (!board || (hintFen && fen && fen !== hintFen)) drawHint(null);
        else if (!board.querySelector(':scope > svg.nyx-hint')) drawHint(hintMove);
      }
      if (coachData) {
        // Self-heal like the autoplay hint: if Chess.com replaces the board's
        // children (or the layer is removed) redraw instead of waiting for a
        // board identity change.
        if (coachBoard !== board || !board?.querySelector(':scope > svg.nyx-coach')) {
          drawCoach(coachData.guidance, coachData.reveal, coachData.threats);
        }
      }
      send({ type: 'state', state: getState() });
    }
    catch (error) { send({ type: 'state', state: { available: false, error: error.message } }); }
  }
  function point(square) {
    const rect = board.getBoundingClientRect();
    let file = square.charCodeAt(0) - 97;
    let row = 8 - Number(square[1]);
    if (orientation(board) === 'b') { file = 7 - file; row = 7 - row; }
    return { x: rect.left + (file + 0.5) * rect.width / 8, y: rect.top + (row + 0.5) * rect.height / 8 };
  }
  function fire(type, position, element = board) {
    // Chess.com resolves the dragged piece from event.target, not from the
    // board's client coordinates. Dispatching on wc-chess-board itself made a
    // synthetic drag a no-op; aim at the piece/square actually under the point.
    const target = document.elementFromPoint(position.x, position.y) || element;
    const options = {
      bubbles: true, cancelable: true, composed: true,
      view: window,
      clientX: position.x, clientY: position.y, pointerId: 1,
      pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1
    };
    const accepted = target.dispatchEvent(new PointerEvent(type, options));
    // Synthetic pointer events do not generate compatibility mouse events.
    // Firefox board handlers can listen to the mouse stream instead.
    if (accepted && /Firefox\//.test(globalThis.navigator?.userAgent || '')) {
      target.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), options));
    }
  }

  // A lightweight arrow drawn over the board for the move the engine queued.
  // The board's own arrow SVG uses a 0..100 viewBox, so square centres are
  // 12.5 units apart in every direction.
  let hintMove = null;
  let hintFen = null;
  let coachData = null;
  let coachBoard = null;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function hintLayer() {
    if (!board) return null;
    let layer = board.querySelector(':scope > svg.nyx-hint');
    if (layer?.isConnected) return layer;
    layer = document.createElementNS(SVG_NS, 'svg');
    layer.setAttribute('class', 'nyx-hint');
    layer.setAttribute('viewBox', '0 0 100 100');
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;overflow:visible;';
    layer.innerHTML = [
      '<g style="opacity:0;transition:opacity .16s ease">',
      '<line class="nyx-hint-casing" stroke="#1e160b" stroke-opacity=".38" stroke-width="5.6" stroke-linecap="round"/>',
      '<polygon class="nyx-hint-casing" fill="#1e160b" fill-opacity=".38"/>',
      '<line class="nyx-hint-line" stroke="#f0b64e" stroke-width="3" stroke-linecap="round"/>',
      '<polygon class="nyx-hint-head" fill="#f0b64e"/>',
      '<circle class="nyx-hint-origin" r="3.1" fill="#f0b64e" stroke="#1e160b" stroke-opacity=".35" stroke-width="1.2"/>',
      '</g>'
    ].join('');
    board.append(layer);
    return layer;
  }
  function drawHint(moveName) {
    hintMove = moveName || null;
    hintFen = hintMove && board?.game?.getFEN ? board.game.getFEN() : null;
    const layer = hintLayer();
    if (!layer) return;
    const group = layer.firstElementChild;
    if (!hintMove || !board) { group.style.opacity = '0'; return; }
    const flipped = orientation(board) === 'b';
    const centre = (square) => {
      let file = square.charCodeAt(0) - 97;
      let row = 8 - Number(square[1]);
      if (flipped) { file = 7 - file; row = 7 - row; }
      return { x: (file + 0.5) * 12.5, y: (row + 0.5) * 12.5 };
    };
    const from = centre(hintMove.slice(0, 2));
    const to = centre(hintMove.slice(2, 4));
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    const px = -uy, py = ux;
    const headLength = 9.5, headWidth = 6.2;
    const tip = { x: to.x - ux * 1.5, y: to.y - uy * 1.5 };
    const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
    const start = { x: from.x + ux * 2.4, y: from.y + uy * 2.4 };
    const points = [
      `${tip.x},${tip.y}`,
      `${base.x + px * headWidth},${base.y + py * headWidth}`,
      `${base.x - px * headWidth},${base.y - py * headWidth}`
    ].join(' ');
    const line = layer.querySelector('.nyx-hint-line');
    const casing = layer.querySelector('line.nyx-hint-casing');
    const head = layer.querySelector('.nyx-hint-head');
    const headCasing = layer.querySelector('polygon.nyx-hint-casing');
    for (const el of [line, casing]) {
      el.setAttribute('x1', start.x); el.setAttribute('y1', start.y);
      el.setAttribute('x2', base.x); el.setAttribute('y2', base.y);
    }
    head.setAttribute('points', points);
    headCasing.setAttribute('points', points);
    layer.querySelector('.nyx-hint-origin').setAttribute('cx', from.x);
    layer.querySelector('.nyx-hint-origin').setAttribute('cy', from.y);
    group.style.opacity = '0.92';
  }
  function coachLayer() {
    if (!board) return null;
    let layer = board.querySelector(':scope > svg.nyx-coach');
    if (layer?.isConnected) return layer;
    layer = document.createElementNS(SVG_NS, 'svg');
    layer.setAttribute('class', 'nyx-coach');
    layer.setAttribute('viewBox', '0 0 100 100');
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;overflow:visible;';
    layer.appendChild(document.createElementNS(SVG_NS, 'g'));
    board.append(layer);
    return layer;
  }
  function coachCentre(square) {
    let file = square.charCodeAt(0) - 97;
    let row = 8 - Number(square[1]);
    if (orientation(board) === 'b') { file = 7 - file; row = 7 - row; }
    return { x: (file + 0.5) * 12.5, y: (row + 0.5) * 12.5 };
  }
  const COACH_COLORS = { suggestion: '#f0b64e', candidate: '#9fb3c8', threat: '#cf5a3c' };
  const COACH_INK = '#1b150d';
  // Legible by default: a dark casing separates the arrow from both board
  // colours, and each kind has its own weight. Threat and candidate arrows are
  // deliberately lighter and dashed so the main recommendation stays dominant.
  const COACH_ARROW_STYLE = {
    suggestion: { width: 2.3, head: 8.4, spread: 5.4, casing: 4.2, casingHead: 9.2, casingSpread: 6.4,
      opacity: 0.96, dash: null, origin: true },
    candidate: { width: 1.7, head: 6.2, spread: 4.1, casing: 3.1, casingHead: 7.0, casingSpread: 5.0,
      opacity: 0.78, dash: '5 3', origin: false },
    threat: { width: 1.5, head: 5.6, spread: 3.9, casing: 2.8, casingHead: 6.4, casingSpread: 4.8,
      opacity: 0.72, dash: '3 2.4', origin: false }
  };
  function arrowGeometry(from, to, style) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    const px = -uy, py = ux;
    const tip = { x: to.x - ux * 1.3, y: to.y - uy * 1.3 };
    const base = { x: tip.x - ux * style.head, y: tip.y - uy * style.head };
    const casingTip = { x: tip.x + ux * 0.4, y: tip.y + uy * 0.4 };
    const casingBase = { x: casingTip.x - ux * style.casingHead, y: casingTip.y - uy * style.casingHead };
    return {
      start: { x: from.x + ux * 2.2, y: from.y + uy * 2.2 },
      base, tip, ux, uy, px, py,
      headPoints: [tip, { x: base.x + px * style.spread, y: base.y + py * style.spread },
        { x: base.x - px * style.spread, y: base.y - py * style.spread }],
      casingHeadPoints: [casingTip, { x: casingBase.x + px * style.casingSpread, y: casingBase.y + py * style.casingSpread },
        { x: casingBase.x - px * style.casingSpread, y: casingBase.y - py * style.casingSpread }],
      casingEnd: casingBase
    };
  }
  function svgEl(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    return node;
  }
  function drawCoachArrow(group, arrow, offset = 0) {
    const style = COACH_ARROW_STYLE[arrow.kind] || COACH_ARROW_STYLE.candidate;
    let from = coachCentre(arrow.from), to = coachCentre(arrow.to);
    // When a threat shares the same corridor as the suggested move (the common
    // "opponent could capture the piece you are advised to move" case), shift it
    // sideways so both arrows stay readable instead of stacking exactly.
    if (offset) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const ox = (-dy / length) * offset, oy = (dx / length) * offset;
      from = { x: from.x + ox, y: from.y + oy };
      to = { x: to.x + ox, y: to.y + oy };
    }
    const g = arrowGeometry(from, to, style);
    const colour = COACH_COLORS[arrow.kind] || COACH_COLORS.candidate;
    // Casing first, so the coloured shape always reads on light and dark squares.
    group.appendChild(svgEl('line', { x1: g.start.x, y1: g.start.y, x2: g.casingEnd.x, y2: g.casingEnd.y,
      stroke: COACH_INK, 'stroke-opacity': 0.55, 'stroke-width': style.casing,
      'stroke-linecap': 'round', 'stroke-dasharray': style.dash }));
    group.appendChild(svgEl('polygon', { points: g.casingHeadPoints.map((p) => `${p.x},${p.y}`).join(' '),
      fill: COACH_INK, 'fill-opacity': 0.55, stroke: COACH_INK, 'stroke-width': 0.8, 'stroke-linejoin': 'round' }));
    group.appendChild(svgEl('line', { x1: g.start.x, y1: g.start.y, x2: g.base.x, y2: g.base.y,
      stroke: colour, 'stroke-opacity': style.opacity, 'stroke-width': style.width,
      'stroke-linecap': 'round', 'stroke-dasharray': style.dash }));
    group.appendChild(svgEl('polygon', { points: g.headPoints.map((p) => `${p.x},${p.y}`).join(' '),
      fill: colour, 'fill-opacity': style.opacity, 'stroke-linejoin': 'round' }));
    if (style.origin) {
      group.appendChild(svgEl('circle', { cx: from.x, cy: from.y, r: 2.5,
        fill: colour, stroke: COACH_INK, 'stroke-opacity': 0.5, 'stroke-width': 1.1 }));
    }
  }
  function drawCoach(guidance, reveal, threatsEnabled) {
    if (!board) return;
    coachBoard = board;
    coachData = guidance ? { guidance, reveal, threats: threatsEnabled !== false } : null;
    const layer = coachLayer();
    if (!layer) return;
    const group = layer.firstElementChild;
    while (group.firstChild) group.removeChild(group.firstChild);
    if (!guidance) { group.style.opacity = '0'; return; }
    const showMove = reveal === 'move';
    const showThreats = threatsEnabled !== false;
    const arrows = (guidance.highlights?.arrows || []).filter((arrow) => arrow &&
      /^[a-h][1-8]$/.test(arrow.from || '') && /^[a-h][1-8]$/.test(arrow.to || ''));
    // Draw threats under the recommendation, then the optional alternative,
    // then the main arrow. The cap comes from NyxCoach (three threats).
    const movePairs = new Set();
    if (showMove) {
      for (const arrow of arrows) {
        if (arrow.kind === 'suggestion' || arrow.kind === 'candidate') {
          movePairs.add(arrow.from + arrow.to);
          movePairs.add(arrow.to + arrow.from);
        }
      }
    }
    for (const kind of ['threat', 'candidate', 'suggestion']) {
      for (const arrow of arrows) {
        if (arrow.kind !== kind) continue;
        if ((kind === 'suggestion' || kind === 'candidate') && !showMove) continue;
        if (kind === 'threat' && !showThreats) continue;
        const offset = kind === 'threat' && movePairs.has(arrow.from + arrow.to) ? 3 : 0;
        drawCoachArrow(group, arrow, offset);
      }
    }
    // Restrained square marks: only the target of a threat (and a king in
    // check). Safety duplicates and suggestion from/to squares stay off the
    // board; the arrows already carry that information.
    const marked = new Set();
    for (const mark of guidance.highlights?.squares || []) {
      if (!mark || !/^[a-h][1-8]$/.test(mark.square || '')) continue;
      const kind = mark.kind || '';
      const threat = kind === 'threat' || kind === 'king-check';
      if (!threat || !showThreats || marked.has(mark.square)) continue;
      marked.add(mark.square);
      const point = coachCentre(mark.square);
      group.appendChild(svgEl('rect', {
        x: point.x - 6.25, y: point.y - 6.25, width: 12.5, height: 12.5, rx: 1.2,
        fill: COACH_COLORS.threat, 'fill-opacity': kind === 'king-check' ? 0.2 : 0.14,
        stroke: COACH_COLORS.threat, 'stroke-opacity': 0.82,
        'stroke-width': kind === 'king-check' ? 0.75 : 0.45,
        'stroke-dasharray': kind === 'king-check' ? null : '1.8 1.2'
      }));
    }
    group.style.opacity = '1';
  }
  function move(data) {
    if (pending) throw new Error('A move is already in progress.');
    const state = getState();
    if (!state.available || state.fen !== data.fen || state.revision !== data.revision) {
      throw new Error('The position changed before the move.');
    }
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(data.move)) throw new Error('Invalid move.');
    const from = data.move.slice(0, 2), to = data.move.slice(2, 4), promotion = data.move[4];
    const legal = board.game.getLegalMoves().some((m) => m.from === from && m.to === to &&
      (!promotion || m.promotion === promotion || m.promotion === ' pnbrqk'.indexOf(promotion)));
    if (!legal) throw new Error('The board rejected this move as illegal.');
    // Chess.com sometimes leaves the board scrolled above the viewport (for
    // example after the game-over panel collapses). Pointer events at negative
    // coordinates never reach the board, so bring it back before aiming.
    const box = board.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth) {
      board.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const fromPoint = point(from), toPoint = point(to);
    const token = ++generation;
    const initialBoard = board;
    const started = Date.now();
    pending = data.id;
    drawHint(null);
    const finish = (error) => {
      if (token !== generation) return;
      pending = null;
      send({ type: 'played', id: data.id, error });
      publish();
    };
    // A human drag is not a teleport: press, a few noisy intermediate points,
    // then release. Exact square centres and an instant release are trivially
    // distinguishable from a person.
    const wobble = () => (Math.random() - 0.5) * 5;
    const steps = [0.28, 0.62, 0.86].map((t) => ({
      x: fromPoint.x + (toPoint.x - fromPoint.x) * t + wobble(),
      y: fromPoint.y + (toPoint.y - fromPoint.y) * t + wobble()
    }));
    const release = { x: toPoint.x + wobble(), y: toPoint.y + wobble() };
    fire('pointerdown', { x: fromPoint.x + wobble(), y: fromPoint.y + wobble() }, initialBoard);
    const press = 55 + Math.random() * 95;
    const glide = 90 + Math.random() * 150;
    let step = 0;
    const advance = () => {
      if (token !== generation) return;
      if (!initialBoard.isConnected || findBoard() !== initialBoard || initialBoard.game.getFEN() !== data.fen) return;
      if (step < steps.length) {
        fire('pointermove', steps[step++], initialBoard);
        setTimeout(advance, glide / steps.length * (0.7 + Math.random() * 0.6));
        return;
      }
      setTimeout(() => {
        if (token !== generation || initialBoard.game.getFEN() !== data.fen) return;
        fire('pointermove', release, initialBoard);
        setTimeout(() => {
          if (token !== generation || initialBoard.game.getFEN() !== data.fen) return;
          fire('pointerup', release, initialBoard);
        }, 35 + Math.random() * 85);
      }, 20 + Math.random() * 45);
    };
    if (data.humanize === false) {
      fire('pointermove', toPoint, initialBoard);
      fire('pointerup', toPoint, initialBoard);
    } else setTimeout(advance, press);
    const confirm = () => {
      if (token !== generation) return;
      if (!initialBoard.isConnected || findBoard() !== initialBoard) return finish('Board changed during the move.');
      if (promotion && initialBoard.game.getFEN() === data.fen) {
        const choice = [...document.querySelectorAll(`.promotion-window .promotion-piece.${state.turn}${promotion}, .promotion-window .piece.${state.turn}${promotion}`)].find(visible);
        if (choice) {
          const rect = choice.getBoundingClientRect();
          const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          fire('pointerdown', center, choice);
          fire('pointerup', center, choice);
        }
      }
      const last = initialBoard.game.getLastMove?.();
      if (initialBoard.game.getFEN() !== data.fen) {
        return finish(last?.from === from && last?.to === to && (!promotion || last?.promotion === promotion)
          ? null : 'Position changed before move confirmation.');
      }
      if (Date.now() - started > 2000) return finish('Move was not accepted. Check that this board is interactive.');
      setTimeout(confirm, 50);
    };
    confirm();
  }
  // Chess.com's desktop buttons sometimes contain only an SVG and expose their
  // label through aria-label. Match every accessible label, not just text.
  function controlLabels(element) {
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-test-element'),
      element.getAttribute('data-cy'),
      element.getAttribute('data-testid'),
      (element.textContent || '').replace(/\s+/g, ' ').trim()
    ].filter(Boolean);
  }
  function matchesControl(element, label) {
    return controlLabels(element).some((value) => label.test(value));
  }
  function hasControl(label) {
    return [...document.querySelectorAll('button, a[role="button"], [role="button"]')]
      .some((element) => visible(element) && !element.disabled &&
        element.getAttribute('aria-disabled') !== 'true' && matchesControl(element, label));
  }
  // Click a visible button by accessible label. Chess.com moves the rematch
  // control between the game-over banner and the sidebar depending on the page.
  function clickButton(label) {
    const scope = [...document.querySelectorAll('[class*="game-over"], [class*="modal"], [role="dialog"]')]
      .filter(visible);
    for (const root of [...scope, document]) {
      const target = [...root.querySelectorAll('button, a[role="button"], [role="button"]')]
        .filter(visible)
        .find((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
          matchesControl(el, label));
      if (!target) continue;
      const rect = target.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        target.dispatchEvent(new EventType(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: center.x, clientY: center.y, pointerId: 1, pointerType: 'mouse',
          isPrimary: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0
        }));
      }
      return true;
    }
    return false;
  }
  function rematch() {
    const labels = [/^rematch\b/i, /^play again\b/i, /^next game\b/i];
    const clicked = labels.some(clickButton);
    send({ type: 'rematch', ok: clicked });
  }
  // Auto-queue fallback for pages where Rematch is not offered: start the next
  // online game, start a new bot game, or return to the play screen.
  function queue() {
    const labels = [/^start game\b/i, /^play$/i, /^new game\b/i, /^new bot\b/i, /^play again\b/i];
    const clicked = labels.some(clickButton);
    send({ type: 'queue', ok: clicked });
  }
  // Chess.com usually asks for confirmation before resigning, so the second
  // click is delayed long enough for the dialog to render.
  function resign() {
    const clicked = clickButton(/^resign$/i);
    if (clicked) setTimeout(() => clickButton(/^(yes,?\s*)?resign$|^confirm$/i), 420);
    send({ type: 'resign', ok: clicked });
  }
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== channel || data.direction !== 'extension') return;
    if (data.type === 'read') publish();
    if (data.type === 'cancel') { generation++; pending = null; drawHint(null); }
    if (data.type === 'coach') drawCoach(data.guidance || null, data.reveal, data.threats);
    if (data.type === 'hint') drawHint(data.move);
    if (data.type === 'rematch') rematch();
    if (data.type === 'queue') queue();
    if (data.type === 'resign') resign();
    if (data.type === 'move') {
      try { move(data); }
      catch (error) { pending = null; send({ type: 'played', id: data.id, error: error.message }); }
    }
  });
  setInterval(publish, 200);
  publish();
})();
