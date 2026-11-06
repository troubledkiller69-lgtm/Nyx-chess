const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const folder of ['src', 'popup', 'scripts', 'tests']) {
  const pending = [path.join(root, folder)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', name]);
    }
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const resourcePaths = [manifest.background?.service_worker, manifest.action?.default_popup,
  ...manifest.content_scripts.flatMap((entry) => entry.js),
  ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
  'src/host.js', 'src/worker.js', 'src/engine.js', 'src/openings.js', 'src/review.js', 'src/settings.js',
  'src/content.js', 'src/bridge.js', 'src/coach.js', 'src/session.js', 'popup/popup.css', 'README.md', 'docs/playing-model.md',
  'docs/evaluation-development.md', 'docs/post-game-review.md', 'docs/coach-mode.md', 'docs/session-tracking.md',
  'docs/release-0.6.10.md',
  'docs/release-0.6.11.md',
  'docs/release-0.6.12.md',
  'docs/release-0.6.13.md',
  'scripts/browser-integration/run.js',
  'scripts/browser-integration/firefox-install.js', 'scripts/browser-integration/harness.html'].filter(Boolean);
for (const name of resourcePaths) {
  if (!fs.existsSync(path.join(root, name))) throw new Error(`Missing manifest resource: ${name}`);
}
console.log('JavaScript syntax and manifest resources checked.');
