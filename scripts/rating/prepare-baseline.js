// Extract the saved 0.6.5 engine from its ZIP without executing it.
//
// The baseline is deliberately kept outside the extension tree. This script
// copies only the `src/engine.js` entry into a versioned measurement fixture
// and records both the ZIP hash and the extracted file hash.
//
// Usage:
//   node scripts/rating/prepare-baseline.js --zip C:\Users\howar\nyx-chess-v0.6.5.zip
//
// Optional:
//   --out <file>       default docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js
//   --expected <hex>   expected SHA-256 of the ZIP; default known 0.6.5 value

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_EXPECTED_ZIP = 'fc9cad2b5c5c8ce6bda0786f1d30b5c603dd9aa265e5d641d7c48f589ac64e8f';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = next;
    i++;
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.zip) {
    throw new Error('Usage: node scripts/rating/prepare-baseline.js --zip <nyx-chess-v0.6.5.zip> [--out <engine.js>] [--expected <sha256>]');
  }
  const zipPath = path.resolve(args.zip);
  const outPath = path.resolve(args.out || path.join(__dirname, '../../docs/benchmarks/rating/baselines/nyx-0.6.5-engine.js'));
  const expected = (args.expected || DEFAULT_EXPECTED_ZIP).toLowerCase();

  if (!fs.existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`);
  const zipBytes = fs.readFileSync(zipPath);
  const zipHash = sha256(zipBytes);
  if (zipHash !== expected) {
    throw new Error(`ZIP hash mismatch: expected ${expected}, got ${zipHash}. Refusing to extract.`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-baseline-'));
  try {
    // bsdtar ships with current Windows and reads ZIP entries. This extracts
    // data only; it never executes the engine.
    execFileSync('tar', ['-xf', zipPath, '-C', temp, 'src/engine.js'], { stdio: 'pipe' });
    const extracted = path.join(temp, 'src', 'engine.js');
    if (!fs.existsSync(extracted)) throw new Error('ZIP did not contain src/engine.js');
    const bytes = fs.readFileSync(extracted);
    const engineHash = sha256(bytes);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, bytes);

    const manifest = {
      kind: 'baseline-provision',
      createdAt: new Date().toISOString(),
      zip: {
        path: zipPath,
        sha256: zipHash,
        bytes: zipBytes.length
      },
      entry: 'src/engine.js',
      extracted: {
        path: outPath,
        sha256: engineHash,
        bytes: bytes.length
      },
      note: '0.6.5 measurement baseline. Not part of the extension. Extracted without execution.'
    };
    fs.writeFileSync(path.join(path.dirname(outPath), 'nyx-0.6.5-engine.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`ZIP      ${zipHash}`);
    console.log(`engine   ${engineHash}`);
    console.log(`written  ${outPath}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
