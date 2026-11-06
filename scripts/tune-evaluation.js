// Run independent tactical/positional ablations against an original baseline.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [baseline, outputDir, starts = 'scripts/heldout-starts.json', pairs = '8', ms = '200', cap = '180'] = process.argv.slice(2);
if (!baseline || !outputDir) throw new Error('Usage: node scripts/tune-evaluation.js BASELINE.js OUTPUT_DIR [STARTS.json] [pairs=8] [ms=200] [plyCap=180]');
fs.mkdirSync(outputDir, { recursive: true });
const jobs = [
  ['control-default', 'default'],
  ['blocked-passer-only', '1'],
  ['race-key-opposition-only', '2'],
  ['outpost-mobility-only', '4'],
  ['king-zone-attacks-only', '8'],
  ['hanging-pieces-only', '16'],
  ['lone-king-conversion-only', '32'],
  ['all-evaluation-features', '63']
];

async function run([name, mask, flags = '']) {
  const report = path.resolve(outputDir, `${name}.json`);
  const args = [path.join(__dirname, 'engine-match.js'), path.resolve(baseline), report, pairs, ms, cap,
    path.resolve(starts), mask, flags];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)));
  });
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  console.log(`${name}: ${result.summary.wins}-${result.summary.draws}-${result.summary.losses}, score=${result.summary.score}`);
}

(async () => {
  // Each ablation gets a fresh process so cache history and memory cannot leak
  // between candidates. Run serially to keep move-time budgets comparable.
  for (const job of jobs) await run(job);
})().catch((error) => { console.error(error); process.exitCode = 1; });
