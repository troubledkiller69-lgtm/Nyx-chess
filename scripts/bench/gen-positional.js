// Generate realistic positional test positions from self-play.
//
// Positions are sampled from games played by the engine itself, so they are
// legal, reachable, and representative of the engine's own style. Each entry
// records the phase so the report can separate middlegame from endgame.

const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/engine.js');
const { readJson } = require('./lib.js');

const SAMPLES = [16, 24, 32, 40];

function phaseOf(pos) {
  const heavy = [...pos.board].filter((p) => p && [4, 5].includes(p & 7)).length;
  if (heavy <= 2) return 'endgame';
  if (heavy <= 5) return 'late middlegame';
  return 'middlegame';
}

async function main() {
  const openings = readJson(path.join(__dirname, 'openings.json')).slice(0, 12);
  const engine = new C.Engine();
  const entries = [];
  const seen = new Set();

  for (const opening of openings) {
    const pos = new C.Position(C.START_FEN);
    const history = [pos.fen()];
    for (const name of (opening.moves || '').split(' ').filter(Boolean)) {
      const move = pos.legalMoves().find((m) => C.uci(m) === name);
      if (!move) throw new Error(`Illegal opening move ${name}`);
      pos.make(move);
      history.push(pos.fen());
    }
    for (let ply = 0; ply < Math.max(...SAMPLES) + 8; ply++) {
      if (SAMPLES.includes(ply)) {
        const fen = pos.fen();
        if (!seen.has(fen)) {
          seen.add(fen);
          entries.push({
            id: `pos-${entries.length + 1}`,
            opening: opening.name,
            ply,
            phase: phaseOf(pos),
            fen
          });
        }
      }
      const result = await engine.think(pos.fen(), {
        mode: 'ruthless', skill: 100, variety: 0, depth: 16, timeMs: 120, historyFens: history
      });
      const move = pos.legalMoves().find((m) => C.uci(m) === result.move);
      if (!move) break;
      pos.make(move);
      history.push(pos.fen());
    }
  }

  const out = path.join(__dirname, 'positional.json');
  fs.writeFileSync(out, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${entries.length} positions to ${out}`);
  const byPhase = new Map();
  for (const entry of entries) byPhase.set(entry.phase, (byPhase.get(entry.phase) || 0) + 1);
  for (const [phase, count] of byPhase) console.log(`  ${phase}: ${count}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
