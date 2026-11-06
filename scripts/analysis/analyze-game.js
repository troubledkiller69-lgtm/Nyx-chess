#!/usr/bin/env node
'use strict';

// External Stockfish post-game review for recorded Nyx games.
//
// Usage:
//   node scripts/analysis/analyze-game.js <match.json> [options]
//
// This tool is diagnostic only. It does not change Nyx's evaluation, import
// eval terms, create weights, or claim an Elo rating.

const fs = require('node:fs');
const path = require('node:path');
const { Stockfish, isAbortError } = require('./lib/stockfish.js');
const { inspectGameFile, sha256File, readJson, selectGame } = require('./lib/game.js');
const { analyzeGame } = require('./lib/analyze.js');
const { discoverStockfish, ensureStockfish, findProvenanceForExecutable } = require('./lib/download.js');

const ROOT = path.resolve(__dirname, '../..');
const ANALYSIS_DIR = path.join(ROOT, 'analysis');

const USAGE = `External Stockfish analysis for a recorded Nyx game.

Usage:
  node scripts/analysis/analyze-game.js <match.json> [options]

Options:
  --game N            0-based game index in the report (default 0)
  --list              List games in the report and exit
  --side w|b|both     Analyze White, Black or both (default both)
  --limit N           Analyze only the first N selected moves (smoke runs)
  --depth N           Fixed search depth for both root and played searches (default 12)
  --movetime MS       Optional per-search time cap; incomplete depth is ungraded
  --timeout MS        Hard per-search timeout (default derived from depth)
  --threads N         Stockfish Threads option (default 1)
  --hash MB           Stockfish Hash option in MB (default 128)
  --stockfish PATH    Explicit local Stockfish executable
  --download          Download the official pinned release if not found
  --tag TAG           Official release tag for --download (default sf_19)
  --openings PATH     Opening suite used to resolve game.opening
  --starts PATH       Optional start-position suite for game.start names
  --start-fen FEN     Override the recorded starting FEN
  --opening-moves M   Override opening history (space-separated UCI moves)
  --out PATH          JSON output path
  --markdown PATH     Markdown output path
  --json              Also print the full JSON report to stdout
  -h, --help          Show this help

Examples:
  node scripts/analysis/analyze-game.js docs/benchmarks/match-selfplay.json --game 0
  node scripts/analysis/analyze-game.js docs/benchmarks/match-selfplay.json --game 0 \\
    --limit 3 --depth 10 --movetime 1500 --out analysis/smoke.json

The reported scores are Stockfish scores from the side to move at the analyzed
position. They are not Nyx weights or an absolute strength measurement.
`;

function parseArgs(argv) {
  const options = {
    input: null,
    game: 0,
    list: false,
    side: 'both',
    limit: 0,
    depth: 12,
    movetime: 0,
    timeout: 0,
    threads: 1,
    hash: 128,
    stockfish: null,
    download: false,
    tag: 'sf_19',
    openings: null,
    starts: null,
    startFen: null,
    openingMoves: null,
    out: null,
    markdown: null,
    json: false
  };
  const valueArgs = new Set([
    'game', 'side', 'limit', 'depth', 'movetime', 'timeout', 'threads', 'hash',
    'stockfish', 'tag', 'openings', 'starts', 'start-fen', 'opening-moves', 'out', 'markdown'
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--list') { options.list = true; continue; }
    if (arg === '--download') { options.download = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (!arg.startsWith('--')) {
      if (options.input) throw new Error(`Unexpected argument: ${arg}`);
      options.input = arg;
      continue;
    }
    const name = arg.slice(2);
    if (!valueArgs.has(name)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Option --${name} requires a value`);
    if (name === 'start-fen') options.startFen = value;
    else if (name === 'opening-moves') options.openingMoves = value;
    else if (name === 'stockfish') options.stockfish = value;
    else if (name === 'out') options.out = value;
    else if (name === 'markdown') options.markdown = value;
    else if (name === 'openings') options.openings = value;
    else if (name === 'starts') options.starts = value;
    else if (name === 'tag') options.tag = value;
    else if (name === 'side') {
      if (!['w', 'b', 'both'].includes(value)) throw new Error('--side must be w, b or both');
      options.side = value;
    } else {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`);
      options[name] = number;
    }
  }
  const integers = {
    game: [0, Infinity],
    limit: [0, Infinity],
    depth: [1, 512],
    movetime: [0, Infinity],
    timeout: [0, Infinity],
    threads: [1, 1024],
    hash: [1, 33554432]
  };
  for (const [name, [min, max]] of Object.entries(integers)) {
    if (!Number.isInteger(options[name]) || options[name] < min || options[name] > max) {
      throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    }
  }
  if (!options.input && !options.help) throw new Error('Missing match JSON path');
  return options;
}

function phaseName(phase) {
  return phase === 'opening' ? 'Opening' : phase === 'endgame' ? 'Endgame' : 'Middlegame';
}

function sideName(side) {
  return side === 'w' ? 'White' : side === 'b' ? 'Black' : side;
}

function fmtScore(record) {
  return record && record.text ? record.text : 'n/a';
}

function fmtPct(value) {
  return value === null || value === undefined ? 'n/a' : `${value}%`;
}

function buildMarkdown(report) {
  const { input, stockfish, config, game, analysis } = report;
  const summary = analysis.summary;
  const lines = [];
  lines.push(`# External Stockfish review — game ${input.gameIndex}`);
  lines.push('');
  lines.push(`> Diagnostic only. This is an external Stockfish review of recorded Nyx moves, not an Elo proof, ` +
    `not a strength benchmark and not a source of Nyx evaluation weights.`);
  lines.push('');
  lines.push(`**Input:** \`${input.file}\`  `);
  lines.push(`**Input SHA-256:** \`${input.inputSha256}\`  `);
  lines.push(`**Game:** ${input.gameIndex + 1}/${input.gameCount} · ${game.opening || 'unresolved opening'} · ` +
    `${game.moves.length} plies${game.declaredResult ? ` · recorded ${game.declaredResult}` : ''}  `);
  lines.push(`**Stockfish:** ${stockfish.version || 'unknown'} · \`${stockfish.executable}\` · ` +
    `SHA-256 \`${stockfish.sha256}\`  `);
  lines.push(`**Method:** ${config.method} · depth ${config.depth}` +
    `${config.movetimeMs ? ` · movetime ${config.movetimeMs} ms` : ''} · ` +
    `Threads ${config.threads} · Hash ${config.hashMb} MB  `);
  lines.push(`**Side(s):** ${config.side === 'both' ? 'both' : sideName(config.side)} · ` +
    `analyzed ${summary.analyzed} move(s)`);
  if (config.smokeRun) {
    lines.push('');
    lines.push('**Scope:** short diagnostic smoke run (limited plies). Not a timing, throughput or strength measurement.');
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Analyzed: **${summary.analyzed}** — graded **${summary.graded}**, ungraded **${summary.ungraded}**`);
  lines.push(`- Labels: ${Object.entries(summary.counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ') || 'none'}`);
  lines.push(`- Average cp loss over graded cp moves: **${summary.averageLossCp === null ? 'n/a' : `${summary.averageLossCp} cp`}**`);
  lines.push(`- Missed mates: **${summary.missedMates.length}**`);
  lines.push('');
  lines.push('## Phases (heuristic labels)');
  lines.push('');
  lines.push('| Phase | Analyzed | Graded | Errors | Avg cp loss | Worst |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const phase of ['opening', 'middlegame', 'endgame']) {
    const bucket = summary.phases[phase];
    const worst = bucket.worst
      ? `ply ${bucket.worst.ply} ${bucket.worst.played} (${bucket.worst.label}, ${bucket.worst.lossCp} cp)`
      : '—';
    lines.push(`| ${phaseName(phase)} | ${bucket.analyzed} | ${bucket.graded} | ${bucket.errors} | ` +
      `${bucket.averageLossCp === null ? 'n/a' : `${bucket.averageLossCp} cp`} | ${worst} |`);
  }
  lines.push('');
  lines.push('Opening/middlegame/endgame are material- and ply-based buckets, not chess judgement.');
  lines.push('');
  lines.push('## Turning points');
  lines.push('');
  if (!summary.turningPoints.length) {
    lines.push('No graded errors or missed mates were found in the analyzed moves.');
  } else {
    lines.push('Scores are from the side to move at that ply (the mover), not from White\'s perspective.');
    lines.push('');
    lines.push('| Ply | Side | Phase | Played | Best | Root score | Played score | Label | Evidence |');
    lines.push('|---:|---|---|---|---|---|---|---|---|');
    for (const point of summary.turningPoints) {
      lines.push(`| ${point.ply} | ${sideName(point.side)} | ${phaseName(point.phase)} | ` +
        `\`${point.played}\` | \`${point.best || '—'}\` | ${point.bestScore || 'n/a'} | ` +
        `${point.playedScore || 'n/a'} | **${point.label}**${point.lossCp === null ? '' : ` (${point.lossCp} cp)`} | ` +
        `${point.reason}${point.depth !== null ? ` Depth ${point.depth}.` : ''}` +
        `${point.nodes !== null && point.nodes !== undefined ? ` Nodes ${point.nodes}.` : ''} |`);
    }
  }
  lines.push('');
  lines.push('## Missed mate opportunities');
  lines.push('');
  if (!summary.missedMates.length) {
    lines.push('None detected at this depth.');
  } else {
    for (const mate of summary.missedMates) {
      lines.push(`- Ply ${mate.ply} (${sideName(mate.side)}): played \`${mate.played}\`, ` +
        `root best \`${mate.best || '—'}\` (${mate.bestScore || 'n/a'}). ${mate.reason}`);
    }
  }
  lines.push('');
  lines.push('## Ungraded moves');
  lines.push('');
  const ungraded = analysis.moves.filter((move) => !move.graded);
  if (!ungraded.length) {
    lines.push('None.');
  } else {
    const reasons = new Map();
    for (const move of ungraded) reasons.set(move.reason, (reasons.get(move.reason) || 0) + 1);
    for (const [reason, count] of reasons) lines.push(`- ${count}× ${reason}`);
  }
  lines.push('');
  lines.push('## Limits');
  lines.push('');
  lines.push('- Both searches use the same requested depth; a cp gap is reported only when both reached it exactly. ' +
    'Bounds, missing scores and shallower searches are ungraded rather than converted into losses.');
  lines.push('- Mate scores stay mate scores. The tool never converts mate distances to centipawns.');
  lines.push('- A repeated position can still be searched from a fresh hash table. Reported nodes are evidence, ' +
    'not an equal-work guarantee; depth is the controlled budget.');
  lines.push('- This does not prove theoretical correctness, does not measure Nyx Elo, and is not used to train or ' +
    'tune the Nyx evaluator.');
  if (stockfish.reusedBinary) {
    lines.push('- Pre-existing external binary reused; provenance is recorded in JSON.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function defaultOutputPaths(inputPath, gameIndex) {
  const base = path.basename(inputPath, path.extname(inputPath)).replace(/[^A-Za-z0-9._-]/g, '_');
  const stem = path.join(ANALYSIS_DIR, `${base}-game${gameIndex + 1}-stockfish`);
  return { json: `${stem}.json`, markdown: `${stem}.md` };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (options.list) {
    const parsed = readJson(options.input);
    const selected = selectGame(parsed.data, 0);
    for (let i = 0; i < selected.total; i++) {
      const raw = selected.games[i];
      const opening = raw && typeof raw.opening === 'object'
        ? raw.opening.name
        : (raw && (raw.opening || raw.start));
      const count = Array.isArray(raw && raw.moves)
        ? raw.moves.length
        : String((raw && raw.moves) || '').split(/\s+/).filter(Boolean).length;
      process.stdout.write(
        `${i}: ${opening || '(unknown)'} · ${count} plies` +
        `${raw && raw.result ? ` · ${raw.result}` : ''}${raw && raw.reason ? ` · ${raw.reason}` : ''}\n`
      );
    }
    return;
  }

  const inspected = inspectGameFile(options.input, {
    gameIndex: options.game,
    openingsPath: options.openings || undefined,
    startsPath: options.starts || undefined,
    startFen: options.startFen,
    openingMoves: options.openingMoves
  });

  let executable = options.stockfish ? path.resolve(options.stockfish) : null;
  let binarySource = 'explicit --stockfish path';
  let downloadInfo = null;
  if (executable) {
    const found = findProvenanceForExecutable(executable);
    if (found) downloadInfo = { provenance: found.provenance, reused: true };
  }
  if (!executable) {
    const found = discoverStockfish();
    if (found) {
      executable = found.executable;
      binarySource = found.source;
      if (found.provenance) {
        downloadInfo = { provenance: found.provenance, reused: true };
      }
    } else if (options.download) {
      process.stderr.write('No Stockfish found; downloading the official pinned release...\n');
      downloadInfo = await ensureStockfish({ tag: options.tag, log: (line) => process.stderr.write(`${line}\n`) });
      executable = downloadInfo.executable;
      binarySource = 'downloaded official release';
    } else {
      throw new Error(
        'No Stockfish executable found. Pass --stockfish PATH or run with --download. ' +
        'This tool never bundles Stockfish with the extension.'
      );
    }
  }
  if (!fs.existsSync(executable)) throw new Error(`Stockfish executable not found: ${executable}`);

  const stockfishSha256 = sha256File(executable);
  const effectiveTimeoutMs = options.timeout > 0
    ? options.timeout
    : Math.max(15000, options.depth * 5000 + (options.movetime > 0 ? options.movetime : 0));
  const engine = new Stockfish(executable, {
    timeoutMs: effectiveTimeoutMs
  });
  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write('\nCancelling Stockfish analysis...\n');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  let version = null;
  let author = null;
  const configuredOptions = { Threads: options.threads, Hash: options.hash, MultiPV: 1, ClearHashBetweenSearches: true };
  try {
    await engine.start();
    version = engine.version;
    author = engine.id.author;
    if (engine.hasOption('Threads')) await engine.setOption('Threads', options.threads);
    else delete configuredOptions.Threads;
    if (engine.hasOption('Hash')) await engine.setOption('Hash', options.hash);
    else delete configuredOptions.Hash;
    if (engine.hasOption('MultiPV')) await engine.setOption('MultiPV', 1);
    else delete configuredOptions.MultiPV;
    await engine.newGame();

    const analysis = await analyzeGame({
      engine,
      game: inspected.game,
      depth: options.depth,
      movetimeMs: options.movetime > 0 ? options.movetime : null,
      timeoutMs: options.timeout > 0 ? options.timeout : null,
      side: options.side,
      limit: options.limit > 0 ? options.limit : null,
      clearHash: true,
      signal: controller.signal,
      onProgress: ({ done, total, move }) => {
        const loss = move.lossCp === null ? '' : `, ${move.lossCp} cp`;
        process.stderr.write(
          `[${done}/${total}] ply ${move.ply} ${move.side} ${move.played} vs ${move.best || '—'}: ` +
          `${move.label}${loss}\n`
        );
      }
    });

    const defaults = defaultOutputPaths(inspected.file, inspected.gameIndex);
    const outPath = path.resolve(options.out || defaults.json);
    const markdownPath = path.resolve(options.markdown || defaults.markdown);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });

    const report = {
      schema: 'nyx-stockfish-analysis/v1',
      kind: 'external-diagnostic',
      generatedAt: new Date().toISOString(),
      disclaimer: 'External diagnostic review of recorded moves. Not an Elo proof, not a match-strength test, ' +
        'and not a source of Nyx evaluation weights or training data.',
      tool: {
        name: 'nyx-external-stockfish-analysis',
        node: process.version,
        platform: process.platform,
        architecture: process.arch
      },
      input: {
        file: inspected.file,
        inputSha256: inspected.inputSha256,
        reportKind: inspected.reportKind,
        gameIndex: inspected.gameIndex,
        gameCount: inspected.gameCount,
        gameRecorded: {
          opening: inspected.rawGame.opening || inspected.rawGame.start || null,
          result: inspected.rawGame.result || null,
          reason: inspected.rawGame.reason || null,
          plies: inspected.rawGame.plies || null,
          candidateWhite: typeof inspected.rawGame.candidateWhite === 'boolean'
            ? inspected.rawGame.candidateWhite
            : null
        }
      },
      stockfish: {
        executable,
        binarySource,
        version,
        author,
        sha256: stockfishSha256,
        options: configuredOptions,
        clearHashBetweenSearches: true,
        downloaded: downloadInfo ? downloadInfo.provenance : null,
        reusedBinary: Boolean(downloadInfo && downloadInfo.reused)
      },
      config: {
        method: analysis.method,
        depth: options.depth,
        movetimeMs: options.movetime > 0 ? options.movetime : null,
        timeoutMs: effectiveTimeoutMs,
        threads: options.threads,
        hashMb: options.hash,
        side: options.side,
        limit: options.limit > 0 ? options.limit : null,
        smokeRun: options.limit > 0,
        notStrengthTiming: true,
        clearHashBetweenSearches: true,
        scorePerspective: 'side to move at the root position (UCI default; no sign flip)',
        phaseHeuristic: 'endgame when non-pawn material <= 20 points; opening = resolved opening + 8 plies ' +
          '(or first 10 plies without an opening); otherwise middlegame',
        grading: 'cp loss only when both searches reach the requested depth and both scores are exact cp; ' +
          'mate scores handled as mate distances'
      },
      game: {
        startFen: inspected.game.startFen,
        finalFen: inspected.game.finalFen,
        opening: inspected.game.opening,
        openingMoves: inspected.game.openingMoves,
        openingPlies: inspected.game.openingPlies,
        resolvedFrom: inspected.game.resolvedFrom,
        declaredResult: inspected.game.declaredResult,
        declaredReason: inspected.game.declaredReason,
        moves: inspected.game.moves.map((move) => ({
          ply: move.ply,
          moveNumber: move.moveNumber,
          side: move.side,
          phase: move.phase,
          played: move.played,
          beforeFen: move.beforeFen,
          afterFen: move.afterFen
        })),
        positions: inspected.game.positions.map((position) => position.fen)
      },
      analysis: {
        moves: analysis.moves,
        summary: analysis.summary
      }
    };

    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, buildMarkdown(report));

    const summary = analysis.summary;
    process.stdout.write(
      `Stockfish ${version || 'unknown'} · game ${inspected.gameIndex + 1}/${inspected.gameCount} · ` +
      `depth ${options.depth} · ${summary.analyzed} moves analyzed\n` +
      `graded ${summary.graded}, ungraded ${summary.ungraded}, ` +
      `missed mates ${summary.missedMates.length}, avg loss ` +
      `${summary.averageLossCp === null ? 'n/a' : `${summary.averageLossCp} cp`}\n` +
      `JSON: ${outPath}\nMarkdown: ${markdownPath}\n`
    );
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (isAbortError(error)) {
      process.stderr.write('Analysis cancelled; no report written.\n');
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await engine.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    if (error.stderr) process.stderr.write(`Stockfish stderr: ${error.stderr}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, buildMarkdown, defaultOutputPaths };
