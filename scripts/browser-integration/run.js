// Loads the real unpacked Nyx Chess extension in Chromium against a local fake
// Chess.com board. No network game, account, or live move is touched.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const extensionRoot = path.resolve(process.env.NYX_EXTENSION_ROOT || root);
const chrome = process.env.CHROME || 'C:\\Users\\howar\\Downloads\\chrome-win\\chrome-win\\chrome.exe';
const harness = fs.readFileSync(path.join(__dirname, 'harness.html'));
const PAGE_AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const outDir = path.join(root, 'docs', 'integration');
const versionLabel = process.env.NYX_VERSION
  || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const failures = [];
function check(name, condition, evidence) {
  const ok = Boolean(condition);
  results.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence === undefined ? '' : ` :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`}`);
  if (!ok) failures.push({ name, evidence });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.method || 'CDP'}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
        return;
      }
      if (!message.method) return;
      for (const fn of this.listeners.get(message.method) || []) fn(message.params, message.sessionId);
    };
    return this;
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const list = this.listeners.get(method) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(chrome)) throw new Error(`Chromium not found at ${chrome}`);
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-browser-'));
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let browser;
  try {
    let version;
    for (let i = 0; i < 80; i++) {
      try { version = await getJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(250); }
    }
    if (!version) throw new Error(`Chromium did not expose CDP.\n${stderr.slice(-3000)}`);
    browser = await new Cdp(version.webSocketDebuggerUrl).open();

    // Find the extension's own service worker.
    let workerTarget;
    for (let i = 0; i < 40; i++) {
      const targets = (await browser.send('Target.getTargets')).targetInfos;
      workerTarget = targets.find((target) => target.type === 'service_worker' && /\/src\/background\.js$/.test(target.url));
      if (workerTarget) break;
      await sleep(250);
    }
    if (!workerTarget) throw new Error('Loaded extension service worker not found.');
    const extensionId = new URL(workerTarget.url).host;
    check('real unpacked extension loaded', Boolean(workerTarget), { extensionId, chromium: version.Browser });

    const { sessionId: workerSession } = await browser.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true });
    await browser.send('Runtime.enable', {}, workerSession);
    const evalWorker = async (expression) => {
      const response = await browser.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true
      }, workerSession);
      if (response.exceptionDetails) {
        const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
        throw new Error(`service worker evaluation failed: ${detail}`);
      }
      return response.result.value;
    };

    // Create a page and serve the harness for https://www.chess.com/*.
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: pageSession } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Page.enable', {}, pageSession);
    // Keep the harness tab focused so the panel's 650 ms refresh timer is not
    // throttled as a background tab; screenshots then show live state.
    await browser.send('Page.bringToFront', {}, pageSession);
    await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true }, pageSession);
    await browser.send('Runtime.enable', {}, pageSession);
    await browser.send('Log.enable', {}, pageSession);
    const exceptions = [];
    browser.on('Runtime.exceptionThrown', (params, session) => {
      if (session === pageSession) exceptions.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
    });
    browser.on('Log.entryAdded', (params, session) => {
      if (session === pageSession && params.entry.level === 'error') exceptions.push(params.entry.text);
    });

    await browser.send('Fetch.enable', {
      patterns: [{ urlPattern: 'https://www.chess.com/*', requestStage: 'Request' }]
    }, pageSession);
    browser.on('Fetch.requestPaused', async (params, session) => {
      if (session !== pageSession) return;
      try {
        if (params.resourceType === 'Document') {
          await browser.send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/html; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' }
            ],
            body: harness.toString('base64')
          }, pageSession);
        } else {
          await browser.send('Fetch.continueRequest', { requestId: params.requestId }, pageSession);
        }
      } catch (error) {
        // The renderer can cancel a request while it is being fulfilled.
        if (!/Invalid InterceptionId|No resource with given identifier/i.test(error.message)) throw error;
      }
    });
    const load = new Promise((resolve) => {
      const off = browser.on('Page.loadEventFired', (_params, session) => {
        if (session !== pageSession) return;
        off();
        resolve();
      });
    });
    await browser.send('Page.navigate', { url: 'https://www.chess.com/analysis' }, pageSession);
    await Promise.race([load, sleep(15000)]);

    const evalPage = async (expression) => {
      const response = await browser.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, userGesture: true
      }, pageSession);
      if (response.exceptionDetails) {
        const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
        throw new Error(`page evaluation failed: ${detail}`);
      }
      return response.result.value;
    };

    const tab = await (async () => {
      for (let i = 0; i < 60; i++) {
        const tabs = await evalWorker("(async () => (await chrome.tabs.query({ url: 'https://www.chess.com/*' })).map((tab) => ({ id: tab.id, url: tab.url })))()");
        if (tabs.length) return tabs[0];
        await sleep(250);
      }
      throw new Error('Chess.com harness tab was not visible to the extension.');
    })();
    check('content script connected to harness page', Boolean(tab.id), tab);

    const request = async (type, extra = {}) => evalWorker(
      `(async () => { try { return await chrome.tabs.sendMessage(${tab.id}, ${JSON.stringify({ channel: 'nyx-chess-v1', type, ...extra })}); } catch (error) { return { ok: false, transportError: error.message }; } })()`
    );
    const waitStatus = async (predicate, timeout = 20000, label = 'status') => {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeout) {
        last = await request('status');
        if (last && predicate(last)) return last;
        await sleep(150);
      }
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
    };

    // Overlay inspection through CDP's pierced DOM (the panel is a closed shadow root).
    let documentNode;
    const findNode = (node, predicate, out = []) => {
      if (predicate(node)) out.push(node);
      for (const child of node.children || []) findNode(child, predicate, out);
      for (const shadow of node.shadowRoots || []) findNode(shadow, predicate, out);
      return out;
    };
    const attr = (node, name) => {
      for (let i = 0; i < (node.attributes || []).length; i += 2) {
        if (node.attributes[i] === name) return node.attributes[i + 1];
      }
      return undefined;
    };
    // DOM.getDocument resets node ids, so fetch a fresh tree for every action.
    const nodeByClass = async (className) => {
      documentNode = await browser.send('DOM.getDocument', { depth: -1, pierce: true }, pageSession);
      return findNode(documentNode.root, (node) => attr(node, 'class')?.split(/\s+/).includes(className))[0];
    };
    const nodeByName = async (name) => {
      documentNode = await browser.send('DOM.getDocument', { depth: -1, pierce: true }, pageSession);
      return findNode(documentNode.root, (node) => attr(node, 'name') === name)[0];
    };
    const nodeByTab = async (tabName) => {
      documentNode = await browser.send('DOM.getDocument', { depth: -1, pierce: true }, pageSession);
      return findNode(documentNode.root, (node) => attr(node, 'role') === 'tab' && attr(node, 'data-tab') === tabName)[0];
    };
    const nodeByPace = async (pace) => {
      documentNode = await browser.send('DOM.getDocument', { depth: -1, pierce: true }, pageSession);
      return findNode(documentNode.root, (node) => attr(node, 'data-pace') === pace)[0];
    };
    const nodeByPanel = async (panelName) => {
      documentNode = await browser.send('DOM.getDocument', { depth: -1, pierce: true }, pageSession);
      return findNode(documentNode.root, (node) => attr(node, 'role') === 'tabpanel' && attr(node, 'data-panel') === panelName)[0];
    };
    const nodeInfo = async (node) => {
      if (!node) return null;
      const { object } = await browser.send('DOM.resolveNode', { nodeId: node.nodeId }, pageSession);
      const response = await browser.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
          const style = getComputedStyle(this);
          return {
            text: (this.textContent || "").replace(/\\s+/g, " ").trim(),
            disabled: Boolean(this.disabled), hidden: Boolean(this.hidden),
            className: String(this.className), value: this.value ?? null,
            tag: this.tagName, visible: this.getClientRects().length > 0 && style.visibility !== "hidden",
            ariaSelected: this.getAttribute("aria-selected"), tabIndex: this.tabIndex,
            ariaControls: this.getAttribute("aria-controls")
          };
        }`,
        returnByValue: true
      }, pageSession);
      return response.result.value;
    };
    const infoFor = async (className) => nodeInfo(await nodeByClass(className));
    const infoByName = async (name) => nodeInfo(await nodeByName(name));
    const infoByTab = async (tabName) => nodeInfo(await nodeByTab(tabName));
    const infoByPanel = async (panelName) => nodeInfo(await nodeByPanel(panelName));
    const clickNode = async (node) => {
      if (!node) throw new Error('Overlay control not found.');
      await browser.send('DOM.scrollIntoViewIfNeeded', { nodeId: node.nodeId }, pageSession);
      await sleep(120);
      const { model } = await browser.send('DOM.getBoxModel', { nodeId: node.nodeId }, pageSession);
      const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
      const x = (x1 + x2 + x3 + x4) / 4;
      const y = (y1 + y2 + y3 + y4) / 4;
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, pageSession);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, pageSession);
    };
    const clickClass = async (className) => {
      const node = await nodeByClass(className);
      if (!node) throw new Error(`Overlay control .${className} not found.`);
      await clickNode(node);
    };
    const clickTab = async (tabName) => {
      const node = await nodeByTab(tabName);
      if (!node) throw new Error(`Overlay tab ${tabName} not found.`);
      await clickNode(node);
      await sleep(120);
    };
    const focusNode = async (node) => {
      if (!node) throw new Error('Overlay control not found.');
      const { object } = await browser.send('DOM.resolveNode', { nodeId: node.nodeId }, pageSession);
      await browser.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { this.focus(); }',
        returnByValue: true
      }, pageSession);
    };
    const pressKey = async (key, code, windowsVirtualKeyCode) => {
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode }, pageSession);
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }, pageSession);
      await sleep(120);
    };
    const overlayOpen = async () => {
      const opened = await request('overlay-open');
      check('overlay opened through production runtime message', opened.ok === true, opened.error || 'ok');
      await sleep(400);
    };

    // Reset the fake board to a live game and configure a quiet human game.
    await evalPage('__harness.reset(); true');
    await request('configure', {
      settings: {
        side: 'w', mode: 'human', control: 'autoplay', pace: 'bullet', depth: 5,
        timeMs: 150, delayMs: 0, elo: 1600, variety: 0, style: 'balanced',
        blunders: 0, adaptive: false, autoRematch: 'no',
        openingWhite: 'italian', openingBlack: 'none'
      }
    });
    const initial = await waitStatus((status) => status.state?.available === true && status.state?.fen, 15000, 'connected board');
    check('review disabled while game is live', initial.review.canStart === false, {
      canStart: initial.review.canStart, result: initial.state.result, history: initial.state.historyFens?.length
    });
    check('review report is not started by default', initial.review.active === false && !initial.review.report);

    await overlayOpen();
    await clickTab('session');
    const runInfo = await infoFor('review-run');
    const cancelInfo = await infoFor('review-cancel');
    check('UI review button disabled on a live game', runInfo?.disabled === true && runInfo?.visible === true, runInfo);
    check('UI cancel button hidden before a review', cancelInfo?.hidden === true, cancelInfo);

    // Normal play routing: book/opening path through the real host + worker.
    await request('start');
    const book = await waitStatus((status) => status.result?.move, 20000, 'book move');
    check('normal play starts the real engine host/worker', book.running === true && book.engineReady === true, {
      running: book.running, engineReady: book.engineReady, phase: book.phase
    });
    check('opening repertoire routes to the book before search', book.result.source === 'book' &&
      /Italian/i.test(book.result.opening || ''), book.result);
    check('book result names a legal coordinate move', /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(book.result.move), book.result.move);
    check('review is blocked while autoplay runs', book.review.canStart === false && book.running === true);
    await request('stop');

    // Completed game: review becomes available only with the queue and autoplay stopped.
    await evalPage('__harness.completeFoolsMate(); true');
    const finished = await waitStatus((status) => status.state?.result === '1-0' && status.state?.historyFens?.length === 8, 15000, 'completed game');
    check('completed game exposes review availability', finished.review.canStart === true && finished.review.active === false, {
      canStart: finished.review.canStart, reviewedHistory: finished.state.historyFens.length
    });

    // A stopped game is not enough: an armed rematch queue also blocks review.
    await request('configure', { settings: { autoRematch: 'yes' } });
    await request('start');
    const queued = await waitStatus((status) => status.running === true && status.queueArmed === true, 10000, 'rematch queue armed');
    check('review blocked while autoplay/rematch queue is armed', queued.review.canStart === false, {
      running: queued.running, queueArmed: queued.queueArmed, phase: queued.phase
    });
    const queueButton = await infoFor('review-run');
    // The panel refreshes on a 650 ms timer; give it one cycle before reading.
    await sleep(900);
    const queueButtonLive = await infoFor('review-run');
    check('UI review button disabled while queue is armed', queueButtonLive?.disabled === true, queueButtonLive);
    await request('stop');
    const disarmed = await waitStatus((status) => status.running === false && status.queueArmed === false && status.review.canStart === true, 10000, 'queue stopped');
    check('review unlocked only after autoplay and queue stop', disarmed.review.canStart === true);
    await request('configure', { settings: { autoRematch: 'no' } });

    await evalPage('__harness.accept(false); true');
    await overlayOpen();
    await clickTab('session');
    const runReady = await infoFor('review-run');
    check('UI review button enabled after a completed game', runReady?.disabled === false && runReady?.visible === true, runReady);
    check('UI review button label is actionable', /Review last game/i.test(runReady?.text || ''), runReady?.text);

    // Start review from the real UI button.
    await clickClass('review-run');
    const reviewing = await waitStatus((status) => status.review.active === true, 10000, 'review start');
    check('UI button starts review through host/worker', reviewing.review.active === true, { done: reviewing.review.done, total: reviewing.review.total });
    const cancelVisible = await infoFor('review-cancel');
    const runDuring = await infoFor('review-run');
    check('UI switches to Cancel review while review runs', cancelVisible?.hidden === false && runDuring?.disabled === true, {
      cancelHidden: cancelVisible?.hidden, runLabel: runDuring?.text, runDisabled: runDuring?.disabled
    });
    await overlayOpen();
    const statusText = await infoFor('review-status');
    check('UI reports review progress', /Reviewing/i.test(statusText?.text || '') && statusText?.visible === true, statusText?.text);

    const reviewed = await waitStatus((status) => status.review.active === false && status.review.report, 60000, 'review result');
    check('real review produced a report', reviewed.review.report.reviewed === 4, {
      reviewed: reviewed.review.report.reviewed, rated: reviewed.review.report.rated,
      unrated: reviewed.review.report.unrated, counts: reviewed.review.report.counts
    });
    check('review summary is rendered for the completed game', /Review: 4 White moves/i.test(reviewed.review.summary), reviewed.review.summary);

    const screenshot = await browser.send('Page.captureScreenshot', { format: 'png' }, pageSession);
    const screenshotPath = path.join(outDir, `${versionLabel}-review-panel.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    check('review panel screenshot captured', fs.existsSync(screenshotPath), screenshotPath);

    // Cancel path and stale-result guard. A long legal history keeps the review
    // running long enough to exercise the UI cancel button.
    await evalPage('__harness.completeLongGame(); true');
    const longGame = await waitStatus((status) => (status.state?.historyFens?.length || 0) > 60 && status.review.canStart === true, 15000, 'long completed game');
    check('long completed game is reviewable', longGame.review.canStart === true, {
      history: longGame.state.historyFens.length, result: longGame.state.result
    });
    await overlayOpen();
    const runAfter = await infoFor('review-run');
    check('UI review button becomes available again', runAfter?.disabled === false && runAfter?.visible === true, runAfter?.text);
    await clickClass('review-run');
    const second = await waitStatus((status) => status.review.active === true, 10000, 'second review start');
    check('second review is running before cancel', second.review.active === true);
    await clickClass('review-cancel');
    const cancelled = await waitStatus((status) => status.review.active === false && /cancelled/i.test(status.review.summary || ''), 10000, 'review cancel');
    check('UI cancel stops the review', cancelled.review.active === false && !cancelled.review.report, cancelled.review.summary);
    await sleep(2500);
    const afterCancel = await request('status');
    check('late/stale review result is ignored after cancel', afterCancel.review.report === null || afterCancel.review.report === undefined,
      { active: afterCancel.review.active, summary: afterCancel.review.summary });

    // New game during review must cancel the old review and discard its result.
    await overlayOpen();
    await clickTab('session');
    await clickClass('review-run');
    const third = await waitStatus((status) => status.review.active === true, 10000, 'third review start');
    check('review is running before the new game', third.review.active === true);
    await evalPage('__harness.reset(); true');
    await waitStatus((status) => status.state?.result === '*' && (status.state?.historyFens?.length || 0) <= 1, 10000, 'new game state');
    let newGameStatus = await request('status');
    if (newGameStatus.review.active) {
      // Allow the content tick and host cancel to finish if they were in flight.
      await sleep(1000);
      newGameStatus = await request('status');
    }
    check('new game cancels the running review', newGameStatus.review.active === false, {
      active: newGameStatus.review.active, summary: newGameStatus.review.summary
    });
    await sleep(2500);
    const afterNewGame = await request('status');
    check('stale review result from the old game is not shown', !afterNewGame.review.report,
      { report: afterNewGame.review.report, summary: afterNewGame.review.summary });
    check('review stays unavailable on the new live game', afterNewGame.review.canStart === false);

    // Direct review request while autoplay/search is active must be refused.
    await request('configure', { settings: { openingWhite: 'none', autoRematch: 'no', timeMs: 300, depth: 6 } });
    await request('start');
    await waitStatus((status) => status.running === true, 10000, 'engine search run');
    const direct = await request('review');
    check('review request is refused during autoplay', direct.ok === false && /Stop autoplay/i.test(direct.error || ''), {
      ok: direct.ok, error: direct.error
    });
    await request('stop');

    // Normal engine search path: opening none must fall through to the worker.
    await request('configure', { settings: { openingWhite: 'none', autoRematch: 'no', timeMs: 250, depth: 6, blunders: 0 } });
    const searchStart = Date.now();
    await request('start');
    const search = await waitStatus((status) => status.result?.source === 'search' && status.result.depth > 0, 30000, 'engine search');
    check('normal engine worker returns a searched move', search.result.source === 'search' && search.result.nodes > 0 && search.result.depth > 0, {
      move: search.result.move, depth: search.result.depth, nodes: search.result.nodes, timeMs: search.result.time, wallMs: Date.now() - searchStart
    });
    check('searched move is legal coordinate notation', /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(search.result.move), search.result.move);
    await request('stop');

    // -----------------------------------------------------------------
    // Session tracking: one terminal observation counts once, the overlay
    // renders it, a stop-after-games limit stops the controller, and the
    // explicit reset clears it.
    // -----------------------------------------------------------------
    const currentSettings = async () => (await request('status')).settings;
    const configure = async (overrides) => request('configure', { settings: { ...(await currentSettings()), ...overrides } });

    await evalPage('__harness.reset(); true');
    await configure({ control: 'autoplay', mode: 'human', side: 'w', autoRematch: 'no',
      openingWhite: 'none', openingBlack: 'none', stopAfterGames: 1, stopAfterMinutes: 0 });
    await request('session-reset');
    await request('start');
    await waitStatus((status) => status.running === true, 10000, 'session game start');
    await evalPage('__harness.completeFoolsMate(); true');
    const counted = await waitStatus((status) => status.session?.games === 1 && status.running === false, 15000, 'session game counted');
    check('terminal result is counted once and attributed to our side', counted.session.games === 1 &&
      counted.session.counts.win === 1 && counted.session.byMode.human.win === 1, counted.session.counts);
    check('stop-after-games stops the controller', /Session limit reached: 1 game/.test(counted.message || '') &&
      counted.session.limit.reached === true, counted.message);

    await evalPage('__harness.completeFoolsMate(); true');
    await sleep(500);
    const deduped = await request('status');
    check('re-observing the same finished game does not double count', deduped.session.games === 1, deduped.session.counts);

    await overlayOpen();
    const sessionText = await infoFor('session-counts');
    check('overlay renders the session win count', /1W/.test(sessionText?.text || '') && /1 game/.test(sessionText?.text || ''), sessionText?.text);
    const limitText = await infoFor('session-limit');
    check('overlay renders the reached session limit', /Session limit reached: 1 game/.test(limitText?.text || ''), limitText?.text);
    await clickClass('session-reset');
    const reset = await waitStatus((status) => status.session?.games === 0, 10000, 'session reset');
    check('UI reset clears session stats and the limit', reset.session.limit.reached === false, {
      games: reset.session.games, limit: reset.session.limit
    });

    // Queue observability: arming is visible and bounded in the overlay.
    await evalPage('__harness.reset(); true');
    await configure({ stopAfterGames: 0, autoRematch: 'yes' });
    await request('start');
    const armed = await waitStatus((status) => status.queueArmed === true, 10000, 'queue armed');
    check('queue state is reported with bounds', armed.queue.armed === true && armed.queue.attempts >= 0 &&
      armed.queue.failures >= 0, armed.queue);
    await overlayOpen();
    const queueText = await infoFor('queue-status');
    check('overlay reports the armed queue', /Queue armed/.test(queueText?.text || ''), queueText?.text);
    await request('stop');
    await waitStatus((status) => status.queueArmed === false, 10000, 'queue stopped');
    await configure({ autoRematch: 'no' });

    // -----------------------------------------------------------------
    // Declutter: five focused tabs, one visible panel, persistent main
    // controls, roving tabindex and remembered selection.
    // -----------------------------------------------------------------
    await overlayOpen();
    const tabOrder = [];
    for (const name of ['play', 'coach', 'openings', 'session', 'engine']) {
      const info = await infoByTab(name);
      tabOrder.push(info ? { name, text: info.text, selected: info.ariaSelected, tabIndex: info.tabIndex,
        controls: info.ariaControls, visible: info.visible } : { name, missing: true });
    }
    check('overlay exposes five focused section tabs', tabOrder.length === 5 &&
      tabOrder.every((tab) => !tab.missing && tab.visible), tabOrder);
    check('section tabs expose ARIA relationships and roving tabindex', tabOrder.every((tab) =>
      tab.controls && tab.selected !== null && (tab.selected === 'true' ? tab.tabIndex === 0 : tab.tabIndex === -1)), tabOrder);
    await clickTab('play');
    check('play panel is the first visible panel', (await infoByPanel('play'))?.visible === true &&
      (await infoByPanel('coach'))?.visible === false, {
      play: await infoByPanel('play'), coach: await infoByPanel('coach')
    });
    check('primary start/stop actions stay visible outside the tab panels', (await infoFor('toggle'))?.visible === true &&
      (await infoFor('once'))?.visible === true, { toggle: await infoFor('toggle'), once: await infoFor('once') });

    await clickTab('coach');
    check('Coach tab shows coach controls and hides Play controls', (await infoByPanel('coach'))?.visible === true &&
      (await infoByPanel('play'))?.visible === false && (await infoByName('coachHints'))?.visible === true,
      { coachPanel: await infoByPanel('coach'), playPanel: await infoByPanel('play'),
        hintStyle: await infoByName('coachHints') });
    check('coach action stays available while the Coach tab is open', (await infoFor('coach-reveal'))?.visible === true &&
      (await infoFor('toggle'))?.visible === true);

    await clickTab('engine');
    check('Engine tab contains only advanced controls', (await infoByName('depth'))?.visible === true &&
      (await infoByName('control'))?.visible === false && (await infoByName('coachThreats'))?.visible === false,
      { depth: await infoByName('depth'), control: await infoByName('control') });
    await clickTab('session');
    check('Session tab contains review, limits and queue controls', (await infoFor('session-reset'))?.visible === true &&
      (await infoByName('autoRematch'))?.visible === true && (await infoByName('stopAfterGames'))?.visible === true,
      { reset: await infoFor('session-reset'), queue: await infoByName('autoRematch') });
    check('primary action remains visible on the Session tab', (await infoFor('toggle'))?.visible === true);

    // Roving keyboard navigation uses the live tab count, Home and End.
    await focusNode(await nodeByTab('play'));
    await pressKey('ArrowRight', 'ArrowRight', 39);
    check('Right Arrow moves selection to the next tab', (await infoByTab('coach'))?.ariaSelected === 'true' &&
      (await infoByPanel('coach'))?.visible === true, await infoByTab('coach'));
    await pressKey('End', 'End', 35);
    check('End selects the final tab without a hardcoded index', (await infoByTab('engine'))?.ariaSelected === 'true',
      await infoByTab('engine'));
    await pressKey('Home', 'Home', 36);
    check('Home returns to the first tab', (await infoByTab('play'))?.ariaSelected === 'true', await infoByTab('play'));
    await clickTab('session');
    const storedTab = await evalWorker("(async () => (await chrome.storage.local.get('overlayTab')).overlayTab)()");
    check('selected tab is remembered in extension storage', storedTab === 'session', storedTab);
    await clickTab('coach');

    const boardShapes = async () => evalPage(`(() => {
      const board = document.querySelector('wc-chess-board');
      const layer = board ? board.querySelector(':scope > svg.nyx-coach') : null;
      const hint = board ? board.querySelector(':scope > svg.nyx-hint') : null;
      const rects = layer ? [...layer.querySelectorAll('rect')] : [];
      const lines = layer ? [...layer.querySelectorAll('line')] : [];
      const byStroke = (colour) => lines.filter((line) => (line.getAttribute('stroke') || '').toLowerCase() === colour);
      const suggestions = byStroke('#f0b64e');
      const threats = byStroke('#cf5a3c');
      const first = suggestions[0];
      return {
        coach: layer ? {
          lines: lines.length,
          suggestionLines: suggestions.length,
          threatLines: threats.length,
          rects: rects.length,
          threatRects: rects.filter((rect) => (rect.getAttribute('fill') || '').toLowerCase() === '#cf5a3c').length,
          uniqueThreatSquares: new Set(rects.map((rect) => rect.getAttribute('x') + ':' + rect.getAttribute('y'))).size,
          opacity: layer.firstElementChild ? layer.firstElementChild.style.opacity : null,
          width: layer.getBoundingClientRect().width,
          firstSuggestion: first ? {
            x1: Number(first.getAttribute('x1')), y1: Number(first.getAttribute('y1')),
            x2: Number(first.getAttribute('x2')), y2: Number(first.getAttribute('y2'))
          } : null
        } : null,
        hint: { present: Boolean(hint), opacity: hint?.firstElementChild ? hint.firstElementChild.style.opacity : null }
      };
    })()`);

    // -----------------------------------------------------------------
    // Coach: the suggestion arrow is visible by default; staged hinting is an
    // explicit optional mode. Threats stay restrained and stale layers clear.
    // -----------------------------------------------------------------
    await evalPage('__harness.reset(); true');
    await configure({ control: 'coach', side: 'w', autoRematch: 'no', depth: 4, timeMs: 150,
      mode: 'human', variety: 0, blunders: 0, coachHints: 'arrow', coachThreats: 'yes', coachSecond: 'yes',
      openingWhite: 'none', openingBlack: 'none', stopAfterGames: 0, stopAfterMinutes: 0 });
    await request('start');
    const idea = await waitStatus((status) => status.coach?.active === true && status.coach?.hintLevel === 'move', 30000, 'coach arrow');
    check('coach shows the suggestion and arrow by default', idea.coach.hintLevel === 'move' &&
      idea.coach.arrowVisible === true && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(idea.coach.suggestion?.uci || ''), {
      hintLevel: idea.coach.hintLevel, arrowVisible: idea.coach.arrowVisible, suggestion: idea.coach.suggestion
    });
    const defaultShapes = await boardShapes();
    check('default coach layer draws a visible suggestion arrow', defaultShapes.hint.opacity === '0' &&
      defaultShapes.coach?.opacity === '1' && defaultShapes.coach.suggestionLines > 0, defaultShapes);
    const livePhase = await infoFor('phase');
    await sleep(900);
    const livePhaseAfter = await infoFor('phase');
    check('open panel refreshes live Coach state without being reopened', livePhaseAfter?.text === 'Coaching',
      { phase: livePhase?.text, after: livePhaseAfter?.text });
    const coachShot = await browser.send('Page.captureScreenshot', { format: 'png' }, pageSession);
    fs.writeFileSync(path.join(outDir, `${versionLabel}-coach-arrow.png`), Buffer.from(coachShot.data, 'base64'));

    await overlayOpen();
    await clickTab('coach');
    const coachHintText = await infoFor('coach-hint');
    check('overlay shows the coach idea beside the default arrow', (coachHintText?.text || '').length > 10, coachHintText?.text);
    const defaultMoveText = await infoFor('coach-move');
    check('overlay labels the default suggestion', /Suggestion:/.test(defaultMoveText?.text || ''), defaultMoveText?.text);

    // Hide/show is one toggle in arrow mode; it never introduces a piece step.
    await clickClass('coach-reveal');
    const hidden = await waitStatus((status) => status.coach?.hintLevel === 'concept', 10000, 'arrow hidden');
    await sleep(300);
    const hiddenShapes = await boardShapes();
    check('hiding the default arrow removes it and the move text', hidden.coach.suggestion === null &&
      hiddenShapes.coach?.suggestionLines === 0, { status: hidden.coach, shapes: hiddenShapes });
    await clickClass('coach-reveal');
    const shown = await waitStatus((status) => status.coach?.hintLevel === 'move', 10000, 'arrow shown');
    await sleep(300);
    check('showing the arrow again restores the same suggestion', shown.coach.suggestion?.uci === idea.coach.suggestion.uci,
      { before: idea.coach.suggestion, after: shown.coach.suggestion });

    // Optional hint-first flow.
    await configure({ coachHints: 'staged' });
    const stagedStart = await waitStatus((status) => status.coach?.hintMode === 'staged' && status.coach?.hintLevel === 'concept', 10000, 'staged concept');
    check('staged hint mode starts at the concept level', stagedStart.coach.suggestion === null &&
      Boolean(stagedStart.coach.hint?.text), stagedStart.coach.hint);
    await clickClass('coach-reveal');
    const piece = await waitStatus((status) => status.coach?.hintLevel === 'piece', 10000, 'coach piece level');
    check('staged first reveal exposes the piece but not the move', piece.coach.suggestion === null &&
      Boolean(piece.coach.hint?.piece?.name), piece.coach.hint?.piece);
    const pieceText = await infoFor('coach-move');
    check('overlay renders the revealed piece', /Piece:/.test(pieceText?.text || ''), pieceText?.text);
    await clickClass('coach-reveal');
    const move = await waitStatus((status) => status.coach?.hintLevel === 'move', 10000, 'coach move level');
    check('staged second reveal exposes a legal coached move', /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.coach.suggestion?.uci || ''), move.coach.suggestion);
    const moveText = await infoFor('coach-move');
    check('overlay renders the move only after the second reveal', /Suggestion:/.test(moveText?.text || ''), moveText?.text);
    const moveShapes = await boardShapes();
    check('staged move level draws the coach arrow on the board', moveShapes.coach?.suggestionLines > 0 &&
      moveShapes.coach.opacity === '1', moveShapes);
    await configure({ coachHints: 'arrow' });

    // Threat marks describe legal opponent captures and disappear when disabled.
    await request('stop');
    await evalPage('__harness.hangingQueen(); true');
    await configure({ control: 'coach', side: 'both', autoRematch: 'no', coachHints: 'arrow', coachThreats: 'yes',
      openingWhite: 'none', openingBlack: 'none' });
    await request('start');
    const threatened = await waitStatus((status) => status.coach?.active === true &&
      status.coach?.hintLevel === 'move' && status.coach.threats?.immediate > 0, 30000, 'coach threats');
    check('coach reports legal opponent capture options', threatened.coach.threats.immediate >= 1 &&
      /^If (White|Black) had the turn/.test(threatened.coach.threats.labels?.[0] || ''), threatened.coach.threats);
    const threatShapes = await boardShapes();
    check('threat marks stay restrained and never hide the main arrow', threatShapes.coach?.suggestionLines > 0 &&
      threatShapes.coach.threatLines >= 1 && threatShapes.coach.threatRects >= 1 &&
      threatShapes.coach.threatRects <= 3, threatShapes);
    await overlayOpen();
    const threatText = await infoFor('coach-threats');
    check('overlay explains capture options as hypothetical', /Opponent capture options:/.test(threatText?.text || '') &&
      /could capture/.test(threatText?.text || '') && !/\bwill capture\b/.test(threatText?.text || ''), threatText?.text);
    const threatShot = await browser.send('Page.captureScreenshot', { format: 'png' }, pageSession);
    fs.writeFileSync(path.join(outDir, `${versionLabel}-coach-threats.png`), Buffer.from(threatShot.data, 'base64'));

    await configure({ coachThreats: 'no' });
    const unthreatened = await waitStatus((status) => status.coach?.active === true && status.coach.threats?.immediate === 0, 30000, 'coach threats off');
    const noThreatShapes = await boardShapes();
    check('threat marks respect the setting without hiding the suggestion', unthreatened.coach.threats.immediate === 0 &&
      noThreatShapes.coach?.suggestionLines > 0 && noThreatShapes.coach?.threatLines === 0 &&
      noThreatShapes.coach?.threatRects === 0, noThreatShapes);

    // Both colours clear when the board changes.
    await configure({ coachThreats: 'yes' });
    await waitStatus((status) => status.coach?.active === true && status.coach.threats?.immediate > 0, 30000, 'threats re-enabled');
    await request('stop');
    await evalPage(`__harness.load('${PAGE_AFTER_E4}', 'w'); true`);
    await sleep(500);
    const stale = await request('status');
    const staleShapes = await boardShapes();
    check('board change clears stale gold and rust coach layers', stale.coach.active === false &&
      staleShapes.coach?.opacity === '0' && staleShapes.coach.lines === 0 &&
      staleShapes.coach.suggestionLines === 0 && staleShapes.coach.threatRects === 0,
      { active: stale.coach.active, shapes: staleShapes });
    await overlayOpen();
    const idleCoach = await infoFor('coach-move');
    check('overlay shows no leftover coached move after the board changes', (idleCoach?.text || '') === '', idleCoach?.text);

    // Orientation, resize and SVG self-healing. A fixed ruthless search keeps
    // the same recommendation so coordinates can be compared after a flip.
    await configure({ control: 'coach', side: 'both', mode: 'ruthless', variety: 0, blunders: 0,
      coachHints: 'arrow', openingWhite: 'none', openingBlack: 'none' });
    await request('start');
    const oriented = await waitStatus((status) => status.coach?.active === true && status.coach?.hintLevel === 'move', 30000, 'coach orientation');
    const normalShapes = await boardShapes();
    await evalPage("__harness.orient('b'); true");
    const flipped = await waitStatus((status) => status.coach?.active === true && status.coach?.hintLevel === 'move' &&
      status.state?.orientation === 'b', 30000, 'flipped coach');
    const flippedShapes = await boardShapes();
    check('coach arrow follows a flipped board orientation', Boolean(normalShapes.coach?.firstSuggestion && flippedShapes.coach?.firstSuggestion) &&
      Math.abs(normalShapes.coach.firstSuggestion.x1 + flippedShapes.coach.firstSuggestion.x1 - 100) < 2 &&
      Math.abs(normalShapes.coach.firstSuggestion.y1 + flippedShapes.coach.firstSuggestion.y1 - 100) < 2,
      { normal: normalShapes.coach?.firstSuggestion, flipped: flippedShapes.coach?.firstSuggestion, status: flipped.state?.orientation });

    await evalPage('__harness.resize(360); true');
    await sleep(300);
    const resized = await boardShapes();
    check('coach SVG scales with a resized board and keeps its arrow', resized.coach?.suggestionLines > 0 &&
      resized.coach.width > 340 && resized.coach.width < 380, { width: resized.coach?.width, shapes: resized.coach });
    await evalPage('__harness.resize(480); true');

    await evalPage("document.querySelector('wc-chess-board > svg.nyx-coach')?.remove(); true");
    await sleep(700);
    const healed = await boardShapes();
    check('removed coach SVG is redrawn on the same board element', Boolean(healed.coach) &&
      healed.coach.opacity === '1' && healed.coach.suggestionLines > 0, healed);
    await evalPage("document.querySelector('wc-chess-board').replaceChildren(); true");
    await sleep(700);
    const rebuilt = await boardShapes();
    check('replaced board children get the coach SVG redrawn', Boolean(rebuilt.coach) &&
      rebuilt.coach.opacity === '1' && rebuilt.coach.suggestionLines > 0, rebuilt);
    await request('stop');

    // Remembered tab and boolean select initialisation survive a page reload.
    await clickTab('session');
    await overlayOpen();
    const reloaded = new Promise((resolve) => {
      const off = browser.on('Page.loadEventFired', (_params, session) => {
        if (session !== pageSession) return;
        off();
        resolve();
      });
    });
    await browser.send('Page.reload', {}, pageSession);
    await Promise.race([reloaded, sleep(15000)]);
    await waitStatus((status) => status.state?.available === true, 15000, 'board after reload');
    await overlayOpen();
    const restoredTab = await infoByTab('session');
    check('panel restores the remembered tab after reload', restoredTab?.ariaSelected === 'true' &&
      (await infoByPanel('session'))?.visible === true, restoredTab);
    await clickTab('coach');
    const restoredThreats = await infoByName('coachThreats');
    const restoredSecond = await infoByName('coachSecond');
    const restoredHints = await infoByName('coachHints');
    check('coach boolean selectors initialize to saved yes/no values', restoredThreats?.value === 'yes' &&
      restoredSecond?.value === 'yes' && restoredHints?.value === 'arrow',
      { threats: restoredThreats?.value, second: restoredSecond?.value, hints: restoredHints?.value });

    // Deep is a faster preset. The visible budget and the real search must both
    // follow it, and an explicit 5 s Custom choice must remain available.
    await configure({ pace: 'custom', timeMs: 5000, delayMs: 0, control: 'coach', side: 'w',
      mode: 'human', adaptive: false, depth: 12, blunders: 0, variety: 0,
      openingWhite: 'none', openingBlack: 'none', autoRematch: 'no' });
    await clickTab('play');
    await clickNode(await nodeByPace('deep'));
    await sleep(400);
    const deepBudget = await infoByName('timeMs');
    const deepPaceHint = await infoFor('pace-hint');
    check('Deep button sets 1500 ms and labels it as a budget with slight overrun',
      deepBudget?.value === '1500' && /1\.5 s search budget/.test(deepPaceHint?.text || '') &&
      /small overrun possible/.test(deepPaceHint?.text || ''),
      { timeMs: deepBudget?.value, hint: deepPaceHint?.text });

    await request('stop');
    await evalPage('__harness.reset(); true');
    await waitStatus((status) => status.state?.available === true, 15000, 'deep board');
    const deepStarted = Date.now();
    await request('start');
    const deepCoach = await waitStatus((status) => status.coach?.active === true,
      15000, 'deep coach recommendation');
    const deepElapsed = Date.now() - deepStarted;
    check('Deep Coach result stays inside the 1.5 s budget',
      deepElapsed > 0 && deepElapsed < 4000 && deepCoach.result?.time > 0 &&
      deepCoach.result.time < 2000 && deepCoach.result.depth <= 12,
      { wallMs: deepElapsed, engineMs: deepCoach.result?.time,
        depth: deepCoach.result?.depth, nodes: deepCoach.result?.nodes });
    await request('stop');

    check('no uncaught page or content-script errors', exceptions.length === 0, exceptions.slice(0, 5));

    fs.writeFileSync(path.join(outDir, process.env.NYX_RESULTS || `${versionLabel}-browser-results.json`), JSON.stringify({
      generatedAt: new Date().toISOString(),
      chromium: version.Browser,
      extensionId,
      extensionRoot,
      actualExtensionLoaded: true,
      harness: 'https://www.chess.com/analysis served from local Fetch interception; fake board object',
      results,
      failures
    }, null, 2));
  } finally {
    try { browser?.ws?.close(); } catch { /* ignore */ }
    child.kill();
    await sleep(500);
  }
  if (failures.length) {
    console.error(`\n${failures.length} integration check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll browser integration checks passed.');
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
