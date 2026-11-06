// Suite A — correctness gate.
//
// Runs the project's unit tests before any strength measurement. A broken move
// generator can look strong in a short match, so correctness is a precondition
// for measuring strength, not a separate concern.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tests = path.join(root, 'tests');

function main() {
  if (!fs.existsSync(tests)) {
    console.error('No tests directory found.');
    process.exit(1);
  }
  const files = fs.readdirSync(tests).filter((name) => name.endsWith('.test.js'));
  if (!files.length) {
    console.error('No test files found.');
    process.exit(1);
  }
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(tests, f))], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  const elapsed = Date.now() - started;
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const passed = (output.match(/^# pass (\d+)$/m) || [])[1] ||
    (output.match(/pass (\d+)/) || [])[1];
  const failed = (output.match(/^# fail (\d+)$/m) || [])[1] ||
    (output.match(/fail (\d+)/) || [])[1];

  if (run.status !== 0) {
    console.error(output);
    console.error(`\nCorrectness gate FAILED (${failed ?? '?'} failing) in ${elapsed} ms.`);
    console.error('Stop here. A strength measurement on a broken engine is meaningless.');
    process.exit(1);
  }
  console.log(`Correctness gate passed: ${passed ?? files.length} test files, ${elapsed} ms.`);
}

main();
