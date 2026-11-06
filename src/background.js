chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https:\/\/(www\.)?chess\.com\//.test(tab.url || '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { channel: 'nyx-chess-v1', type: 'overlay-open' });
  } catch {
    // The tab may still be loading; clicking the toolbar icon again retries.
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlay') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(www\.)?chess\.com\//.test(tab.url || '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { channel: 'nyx-chess-v1', type: 'overlay-open' });
  } catch {
    // Reload the Chess.com tab if its content script isn't available yet.
  }
});
