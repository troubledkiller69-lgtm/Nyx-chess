// Installs the packaged Firefox ZIP as a temporary add-on through the WebDriver
// BiDi webExtension.install command. This validates Firefox's manifest/resource
// loading; it does not run the Chess.com harness.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const firefox = process.env.FIREFOX || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
const xpi = path.resolve(process.env.NYX_FIREFOX_ZIP
  || path.join(__dirname, `../../../nyx-chess-v${packageVersion}-firefox.zip`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

(async () => {
  if (!fs.existsSync(firefox)) throw new Error(`Firefox not found at ${firefox}`);
  if (!fs.existsSync(xpi)) throw new Error(`Firefox package not found at ${xpi}`);
  let firefoxVersion = 'Firefox';
  try {
    const probe = spawnSync(firefox, ['--version'], { encoding: 'utf8', timeout: 20000 });
    const label = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    if (label) firefoxVersion = label.split(/\r?\n/)[0];
  } catch { /* keep label */ }
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-firefox-'));
  const child = spawn(firefox, [
    '--headless', '--no-remote', '--new-instance',
    `--profile`, profile, `--remote-debugging-port=${port}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let ws;
  try {
    let version;
    let wsUrl;
    for (let i = 0; i < 120; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`);
        wsUrl = version.webSocketDebuggerUrl;
        break;
      } catch { /* Firefox exposes only the BiDi websocket, not /json/version. */ }
      const matched = /(?:^|\n)WebDriver BiDi listening on (ws:\/\/\S+)/.exec(stderr);
      if (matched) {
        version = { Browser: 'Firefox' };
        wsUrl = matched[1].replace(/\/$/, '') + '/session';
        break;
      }
      await sleep(250);
    }
    if (!wsUrl) throw new Error(`Firefox remote agent did not start.\n${stderr.slice(-2000)}`);
    ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.type === 'error') reject(new Error(`${message.error}: ${message.message}`));
      else resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
    const session = await send('session.new', { capabilities: { alwaysMatch: { browserName: 'firefox' } } });
    const installed = await send('webExtension.install', {
      extensionData: { type: 'archivePath', path: xpi }
    });
    console.log(JSON.stringify({
      firefox: firefoxVersion,
      session: Boolean(session.sessionId),
      installedExtension: installed.extension,
      archive: xpi
    }, null, 2));
    await send('webExtension.uninstall', { extension: installed.extension });
    console.log('Firefox temporary add-on installed and uninstalled successfully.');
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    child.kill();
    await sleep(500);
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
