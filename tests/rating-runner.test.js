'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'src', 'engine.js');
const OPENINGS = path.join(ROOT, 'scripts', 'rating', 'openings', 'tuning-72.json');
const RUNNER = path.join(ROOT, 'scripts', 'rating', 'run-fixed-match.js');
const REPLAY = path.join(ROOT, 'scripts', 'rating', 'replay.js');

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(args, timeout = 120000) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024
  });
}

test('fixed-sample runner freezes inputs, plays a pair, and reports a valid completion', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-rating-run-'));
  const out = path.join(temp, 'run');
  try {
    const result = run([
      RUNNER,
      '--candidate', ENGINE,
      '--baseline', ENGINE,
      '--allow-identical',
      '--openings', OPENINGS,
      '--pairs', '1',
      '--time-ms', '50',
      '--node-limit', '800',
      '--max-plies', '12',
      '--seed', '3',
      '--resamples', '1000',
      '--out', out
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    const games = JSON.parse(fs.readFileSync(path.join(out, 'games.json'), 'utf8'));
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.inputs.candidate.sha256, sha(ENGINE));
    assert.equal(manifest.inputs.baseline.sha256, sha(ENGINE));
    assert.equal(sha(path.join(out, manifest.inputs.candidate.frozenPath)), sha(ENGINE));
    assert.equal(sha(path.join(out, manifest.inputs.baseline.frozenPath)), sha(ENGINE));
    assert.equal(manifest.design.plannedPairs, 1);
    assert.equal(summary.games, 2);
    assert.equal(summary.n, 1);
    assert.ok(summary.scoreCI.lower <= summary.mean);
    assert.ok(summary.scoreCI.upper >= summary.mean);
    assert.equal(summary.scoreCI.design, 'fixed-sample');
    assert.equal(summary.scoreCI.inferential, true);
    assert.equal(summary.scoreCI.label, 'confirmatory fixed-sample interval');
    assert.equal(summary.scope.universalElo, false);
    assert.equal(summary.scope.repeatedOpenings, false);
    assert.ok(games.every((game) => game.startFen && Array.isArray(game.moves)));
    assert.ok(games.every((game) => game.moves.length === game.plies));
    // A 12-ply cap guarantees unresolved cut-offs; they must not be called draws.
    assert.ok(summary.adjudication.unresolvedPlyCaps > 0);
    assert.equal(summary.adjudication.convention, 'unresolved ply-cap games are scored 0.5, not ruled draws');
    assert.match(summary.adjudication.note, /partly measures the cap/);
    const capped = games.filter((game) => game.adjudicated);
    assert.ok(capped.length > 0);
    assert.ok(capped.every((game) => game.resolved === false));
    assert.ok(capped.every((game) => game.outcomeType === 'unresolved-ply-cap'));
    assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /not recorded as a true draw/);

    const replay = run([REPLAY, out]);
    assert.equal(replay.status, 0, `${replay.stdout}\n${replay.stderr}`);
    assert.match(replay.stdout, /replayed 2 games/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('dry run validates and freezes but writes no games', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-rating-dry-'));
  const out = path.join(temp, 'dry');
  try {
    const result = run([
      RUNNER,
      '--candidate', ENGINE,
      '--baseline', ENGINE,
      '--allow-identical',
      '--openings', OPENINGS,
      '--pairs', '2',
      '--out', out,
      '--dry-run'
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'validated');
    assert.equal(manifest.design.plannedPairs, 2);
    assert.equal(fs.existsSync(path.join(out, 'games.json')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('runner refuses to repeat an opening as a separate cluster', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-rating-repeat-'));
  const out = path.join(temp, 'repeat');
  const suite = path.join(temp, 'openings.json');
  fs.writeFileSync(suite, JSON.stringify([{ name: 'only', moves: 'e2e4 e7e5' }]));
  try {
    const result = run([
      RUNNER,
      '--candidate', ENGINE,
      '--baseline', ENGINE,
      '--allow-identical',
      '--openings', suite,
      '--pairs', '2',
      '--out', out
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unique openings|correlated clusters/);
    assert.equal(fs.existsSync(path.join(out, 'games.json')), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('runner rejects an illegal opening line before playing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-rating-bad-'));
  const out = path.join(temp, 'bad');
  const suite = path.join(temp, 'openings.json');
  fs.writeFileSync(suite, JSON.stringify([{ name: 'illegal', moves: 'e2e4 e7e5 e2e5' }]));
  try {
    const result = run([
      RUNNER,
      '--candidate', ENGINE,
      '--baseline', ENGINE,
      '--allow-identical',
      '--openings', suite,
      '--pairs', '1',
      '--out', out
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /illegal opening move|illegal move/i);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
