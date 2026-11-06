const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');

function harness() {
  const calls = [];
  const listeners = {};
  const context = {
    chrome: {
      action: { onClicked: { addListener: (fn) => { listeners.action = fn; } } },
      commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
      tabs: {
        sendMessage: async (...args) => { calls.push(args); },
        query: async () => [{ id: 7, url: 'https://www.chess.com/game/live/1' }]
      }
    }
  };
  vm.runInNewContext(source, context);
  return { calls, listeners };
}

test('toolbar click opens the overlay only on Chess.com', async () => {
  const h = harness();
  await h.listeners.action({ id: 5, url: 'https://www.chess.com/analysis' });
  await h.listeners.action({ id: 6, url: 'https://example.com/' });
  await h.listeners.action({ id: 4, url: undefined });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 5);
  assert.equal(JSON.stringify(h.calls[0][1]), JSON.stringify({ channel: 'nyx-chess-v1', type: 'overlay-open' }));
});

test('keyboard shortcut targets the active Chess.com tab', async () => {
  const h = harness();
  await h.listeners.command('toggle-overlay');
  await h.listeners.command('something-else');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 7);
  assert.equal(JSON.stringify(h.calls[0][1]), JSON.stringify({ channel: 'nyx-chess-v1', type: 'overlay-open' }));
});
