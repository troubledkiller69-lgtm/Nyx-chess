// Aggregate benchmark JSON into one markdown page.
//
// Usage:
//   node scripts/bench/report.js [options]
//
// Options:
//   --dir <folder>    where the JSON reports live (default docs/benchmarks)
//   --out <file>      markdown output (default docs/benchmarks/REPORT.md)
//   --latest          only use the newest file of each kind (default true)
//
// Every table prints the engine hash. A number without a hash is not a result.

const fs = require('node:fs');
const path = require('node:path');
const { readJson, pct } = require('./lib.js');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(token);
  }
  return args;
}

function loadReports(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file: name, mtime: fs.statSync(file).mtimeMs, data: readJson(file) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function newestByKind(reports) {
  const kinds = new Map();
  for (const report of reports) {
    // Files written before the suite existed carry no kind and no build hash.
    // They are not results; silently leaving them out is the honest option.
    const kind = report.data.kind;
    if (!kind) continue;
    const current = kinds.get(kind);
    if (!current || report.mtime > current.mtime) kinds.set(kind, report);
  }
  return kinds;
}

function shortHash(hash) {
  return hash ? hash.slice(0, 12) : 'n/a';
}

function tacticsSection(report) {
  const lines = [
    '### Tactics',
    '',
    `Build \`${report.data.engine.file}\` \`${shortHash(report.data.engine.sha256)}\`, ` +
    `${report.data.configuration.nodeLimit.toLocaleString()} nodes per position.`,
    '',
    '| Category | Solved | Rate | Avg nodes |',
    '| --- | --- | --- | --- |'
  ];
  for (const category of report.data.categories) {
    lines.push(`| ${category.category} | ${category.solved}/${category.total} | ` +
      `${pct(category.rate)} | ${category.averageNodes.toLocaleString()} |`);
  }
  lines.push(`| **Overall** | **${report.data.solved}/${report.data.total}** | ` +
    `**${pct(report.data.rate)}** | |`);
  if (report.data.failures?.length) {
    lines.push('', 'Failures:', '');
    for (const failure of report.data.failures) {
      lines.push(`- \`${failure.id}\` ${failure.category}: played ${failure.move} ` +
        `at depth ${failure.depth} — \`${failure.fen}\``);
    }
  }
  return lines;
}

function positionalSection(report) {
  const lines = [
    '### Positional',
    '',
    `Build \`${report.data.engine.file}\` \`${shortHash(report.data.engine.sha256)}\` ` +
    `against reference \`${shortHash(report.data.reference.oracle)}\`, ` +
    `${report.data.configuration.nodeLimit.toLocaleString()} nodes per position.`,
    '',
    '| Phase | Positions | Agreement | Mean loss (cp) | Blunders |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const phase of report.data.byPhase) {
    lines.push(`| ${phase.phase} | ${phase.total} | ${pct(phase.agreementRate)} | ` +
      `${phase.meanLoss.toFixed(1)} | ${phase.blunders} |`);
  }
  lines.push('', `Overall agreement ${pct(report.data.agreement.rate)}, ` +
    `mean loss ${report.data.centipawnLoss.mean?.toFixed(1) ?? 'n/a'} cp, ` +
    `${report.data.centipawnLoss.blunders} blunders at 150 cp.`);
  return lines;
}

function matchSection(report) {
  const summary = report.data.summary;
  const lines = [
    '### Match',
    '',
    `Candidate \`${report.data.builds.candidate.file}\` ` +
    `\`${shortHash(report.data.builds.candidate.sha256)}\` vs ` +
    `\`${report.data.builds.baseline.file}\` ` +
    `\`${shortHash(report.data.builds.baseline.sha256)}\`, ` +
    `${report.data.configuration.timeMs} ms/move, ${report.data.configuration.openings}.`,
    '',
    `${summary.wins}W ${summary.draws}D ${summary.losses}L over ${summary.games} games ` +
    `(${summary.pairs} pairs).`,
    '',
    `Pair score ${pct(summary.mean)} (95% CI ${pct(summary.ci95[0])}-${pct(summary.ci95[1])}), ` +
    `Elo ${summary.eloEstimate === null ? 'n/a' : summary.eloEstimate.toFixed(1)}.`,
    '',
    `SPRT ${report.data.sprt.decision} at ${report.data.configuration.elo0}..` +
    `${report.data.configuration.elo1} Elo (LLR ${report.data.sprt.llr.toFixed(2)}, ` +
    `bounds ${report.data.sprt.lower.toFixed(2)}..${report.data.sprt.upper.toFixed(2)}).`,
    '',
    `Throughput: candidate ${Math.round(summary.throughput.candidate.nodesPerSecond).toLocaleString()} nps ` +
    `at depth ${summary.throughput.candidate.meanDepth.toFixed(1)}, ` +
    `baseline ${Math.round(summary.throughput.baseline.nodesPerSecond).toLocaleString()} nps ` +
    `at depth ${summary.throughput.baseline.meanDepth.toFixed(1)}.`
  ];
  if (report.data.sprt.decision === 'continue') {
    lines.push('', '**Verdict: inconclusive.** The stopping rule did not fire; ' +
      'this run is not evidence either way.');
  }
  return lines;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir
    ? path.resolve(args.dir)
    : path.resolve(__dirname, '../../docs/benchmarks');
  const outFile = args.out ? path.resolve(args.out) : path.join(dir, 'REPORT.md');

  const reports = loadReports(dir);
  const latest = newestByKind(reports);

  const lines = [
    '# Nyx Chess benchmark report',
    '',
    `Generated ${new Date().toISOString()}`,
    '',
    'A result here is only a claim about the exact build hash beside it. ' +
    'Match scores are pair scores with an interval, never a rating.',
    ''
  ];

  if (latest.has('tactics')) lines.push(...tacticsSection(latest.get('tactics')), '');
  if (latest.has('positional')) lines.push(...positionalSection(latest.get('positional')), '');
  if (latest.has('match')) lines.push(...matchSection(latest.get('match')), '');

  if (lines.length <= 7) {
    lines.push('No reports found.', '');
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
  console.log(`Wrote ${outFile}`);
  console.log(`Sections: ${[...latest.keys()].join(', ') || 'none'}`);
}

main();
