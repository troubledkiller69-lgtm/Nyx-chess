// Freeze the current extension bytes as a measurement baseline.
//
// The snapshot is written outside the packaged extension tree so later engine
// experiments cannot mutate the bytes that a match actually tested. Every file
// is copied and re-hashed; the manifest records the source hash, the snapshot
// hash, and the bytes on disk. This script never executes the copied files.
//
// Usage:
//   node scripts/rating/freeze-baseline.js
//   node scripts/rating/freeze-baseline.js --out docs/benchmarks/rating/baselines/nyx-0.6.12-9025cad4
//
// The default label and output directory name are derived from the current
// package version and engine hash.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_GROUPS = [
  'manifest.json',
  'manifest-firefox.json',
  'package.json',
  'README.md',
  'src',
  'popup'
];

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

function collect(absPath, relPath, files) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absPath, { withFileTypes: true })) {
      collect(path.join(absPath, entry.name), path.join(relPath, entry.name), files);
    }
    return;
  }
  if (!stat.isFile()) return;
  files.push({ absPath, relPath });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const enginePath = path.join(ROOT, 'src', 'engine.js');
  const engineSha = sha256(fs.readFileSync(enginePath));
  const short = engineSha.slice(0, 8);
  const label = args.label || `nyx-${packageJson.version}-${short}`;
  const outDir = path.resolve(args.out || path.join(
    ROOT, 'docs', 'benchmarks', 'rating', 'baselines', label
  ));

  const files = [];
  for (const group of DEFAULT_GROUPS) {
    const abs = path.join(ROOT, group);
    if (fs.existsSync(abs)) collect(abs, group, files);
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const records = [];
  for (const file of files) {
    const sourceBytes = fs.readFileSync(file.absPath);
    const sourceSha = sha256(sourceBytes);
    const dest = path.join(outDir, file.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, sourceBytes);
    const frozenBytes = fs.readFileSync(dest);
    const frozenSha = sha256(frozenBytes);
    if (sourceSha !== frozenSha) throw new Error(`snapshot hash mismatch: ${file.relPath}`);
    records.push({
      path: file.relPath.replaceAll(path.sep, '/'),
      bytes: frozenBytes.length,
      sourceSha256: sourceSha,
      frozenSha256: frozenSha
    });
  }

  const snapshot = {
    kind: 'frozen-extension-baseline',
    createdAt: new Date().toISOString(),
    label,
    note: 'Measurement baseline. Outside the packaged extension. Copied without execution.',
    package: {
      name: packageJson.name,
      version: packageJson.version
    },
    browserManifest: {
      version: manifest.version,
      version_name: manifest.version_name
    },
    engine: {
      path: 'src/engine.js',
      sha256: engineSha
    },
    files: records
  };
  fs.writeFileSync(
    path.join(outDir, 'snapshot-manifest.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );

  console.log(`Snapshot ${outDir}`);
  console.log(`version  ${packageJson.version} (${manifest.version_name})`);
  console.log(`engine   ${engineSha}`);
  console.log(`files    ${records.length}`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
