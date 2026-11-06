// Development endgame play-out.
//
// Every position in endgames.json has a known theoretical result. This runner
// plays each one out at a fixed budget and records what happened on the board.
// That is evidence about this engine at this budget, not a proof of the
// theoretical outcome: only checkmate, stalemate, the fifty-move rule and
// threefold repetition are treated as proven results. Reaching the ply cap is
// UNKNOWN, never a successful "draw".
//
// Usage:
//   node scripts/bench/run-endgames.js [--engine src/engine.js] [--out file]
//                                     [--nodes 60000] [--plies 1] [--mask 0]
//
// A plies factor of 2 doubles every cap, which is useful for a slower build.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DEFAULT_ENGINE = path.resolve(__dirname, '../../src/engine.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

const PIECE_VALUE = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };
const DRAW_PROOFS = new Set(['stalemate', 'fifty-move', 'repetition', 'insufficient-material']);
const PROOF = {
  mate: 'checkmate',
  stalemate: 'stalemate',
  'fifty-move': 'fifty-move rule',
  repetition: 'threefold repetition',
  'insufficient-material': 'insufficient material'
};

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

function material(pos, color) {
  let total = 0;
  for (const piece of pos.board) {
    if (!piece || (piece & 8 ? 2 : 1) !== color) continue;
    total += PIECE_VALUE[piece & 7] || 0;
  }
  return total;
}

function sideOf(fen) {
  return String(fen).split(' ')[1] === 'b' ? 'b' : 'w';
}

// Conservative dead-position check for the pieces this suite actually uses.
// It does not try to enumerate every FIDE dead position; it only claims the
// cases where no mate is possible at all.
function deadMaterial(pos) {
  const minors = { 1: [], 2: [] };
  for (let sq = 0; sq < 64; sq++) {
    const piece = pos.board[sq], type = piece & 7;
    if (!piece || type === 6) continue;
    if (type === 1 || type === 4 || type === 5) return false;
    const side = piece & 8 ? 2 : 1;
    minors[side].push({ type, color: ((sq & 7) + (sq >> 3)) & 1 });
  }
  const w = minors[1], b = minors[2];
  if (!w.length && !b.length) return true; // K vs K
  if (w.length <= 1 && !b.length) return true; // K+minor vs K
  if (b.length <= 1 && !w.length) return true;
  if (w.length === 1 && b.length === 1 && w[0].type === 3 && b[0].type === 3 &&
      w[0].color === b[0].color) return true; // same-colour bishops
  return false;
}

async function playOut(C, position, nodeLimit, maxPlies, mask) {
  const engine = new C.Engine();
  const pos = new C.Position(position.fen);
  const historyFens = [pos.fen()];
  const seen = new Map([[C.positionKey(pos.fen()), 1]]);
  const startMaterial = { 1: material(pos, 1), 2: material(pos, 2) };
  const moves = [];

  for (let ply = 0; ply < maxPlies; ply++) {
    const legal = pos.legalMoves();
    if (!legal.length) {
      return { result: pos.inCheck(pos.side) ? 'mate' : 'stalemate', plies: ply, moves, pos, startMaterial };
    }
    if (deadMaterial(pos)) return { result: 'insufficient-material', plies: ply, moves, pos, startMaterial };
    if (pos.half >= 100) return { result: 'fifty-move', plies: ply, moves, pos, startMaterial };

    const out = await engine.think(pos.fen(), {
      nodeLimit,
      depth: 16,
      evalFeatureMask: mask,
      historyFens
    });
    const move = legal.find((candidate) => C.uci(candidate) === out.move);
    if (!move) return { result: 'no-move', plies: ply, moves, pos, startMaterial };
    pos.make(move);
    moves.push(out.move);
    historyFens.push(pos.fen());

    const key = C.positionKey(pos.fen());
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count >= 3) return { result: 'repetition', plies: ply + 1, moves, pos, startMaterial };
  }
  return { result: 'cap', plies: maxPlies, moves, pos, startMaterial };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const enginePath = args.engine ? path.resolve(args.engine) : DEFAULT_ENGINE;
  const setPath = path.resolve(__dirname, 'endgames.json');
  const set = JSON.parse(fs.readFileSync(setPath, 'utf8'));
  const nodeLimit = Number(args.nodes || set.nodeLimit || 60000);
  const factor = Number(args.plies || 1);
  const mask = Number.isFinite(Number(args.mask)) ? Number(args.mask) : 0;

  delete require.cache[require.resolve(enginePath)];
  const C = require(enginePath);

  const results = [];
  const initialFens = [];
  for (const entry of set.positions) {
    initialFens.push(entry.fen);
    const maxPlies = Math.round(entry.maxPlies * factor);
    const played = await playOut(C, entry, nodeLimit, maxPlies, mask);
    const finalMaterial = { 1: material(played.pos, 1), 2: material(played.pos, 2) };
    const lostMaterial = played.startMaterial[1] > finalMaterial[1] ||
      played.startMaterial[2] > finalMaterial[2];
    const mate = played.result === 'mate';
    const provenDraw = DRAW_PROOFS.has(played.result);

    // A won position passes only on checkmate. A drawn position passes only
    // when a rule actually proves the draw. Cap / no-move are unknown, not
    // hidden successes.
    let pass = null;
    if (entry.goal === 'mate') pass = mate;
    else if (mate) pass = false;
    else if (provenDraw) pass = true;

    const loser = played.pos.side === C.WHITE ? 'w' : 'b';
    results.push({
      id: entry.id,
      category: entry.category,
      goal: entry.goal,
      result: played.result,
      proof: PROOF[played.result] || null,
      pass,
      plies: played.plies,
      maxPlies,
      startFen: entry.fen,
      finalFen: played.pos.fen(),
      startHash: sha256(entry.fen),
      finalHash: sha256(played.pos.fen()),
      startMaterial: played.startMaterial,
      finalMaterial,
      lostMaterial,
      winner: mate ? (loser === 'w' ? 'b' : 'w') : null,
      loser: mate ? loser : null,
      moves: played.moves
    });
  }

  const converted = results.filter((entry) => entry.goal === 'mate');
  const held = results.filter((entry) => entry.goal === 'draw');
  const wonOk = converted.filter((entry) => entry.pass === true).length;
  const heldOk = held.filter((entry) => entry.pass === true).length;
  const failed = results.filter((entry) => entry.pass === false).length;
  const unknown = results.filter((entry) => entry.pass === null).length;
  const total = results.length;
  const passed = results.filter((entry) => entry.pass === true).length;

  console.log(`Engine ${enginePath} (${hashFile(enginePath).slice(0, 12)})`);
  console.log(`Suite ${set.suite || 'development'}${set.sealed ? ' (sealed)' : ' (not sealed)'}`);
  console.log(`Nodes ${nodeLimit} per move, mask ${mask}\n`);
  for (const entry of results) {
    const mark = entry.pass === true ? 'PASS' : entry.pass === false ? 'FAIL' : 'UNKNOWN';
    const proof = entry.proof ? ` (${entry.proof})` : '';
    console.log(`${mark.padEnd(7)} ${entry.id.padEnd(16)} ${entry.category.padEnd(24)} ${entry.result.padEnd(10)}${proof} ${String(entry.plies).padStart(4)} plies`);
  }
  console.log(`\nConversion ${wonOk}/${converted.length}, proven draws ${heldOk}/${held.length}, ` +
    `failed ${failed}, unknown ${unknown}, passed ${passed}/${total}`);

  if (args.out) {
    const outFile = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
      kind: 'endgames',
      started: new Date().toISOString(),
      engine: enginePath,
      build: { file: path.basename(enginePath), sha256: hashFile(enginePath) },
      suite: { name: set.suite || 'development', sealed: set.sealed === true,
        file: path.basename(setPath), sha256: hashFile(setPath),
        positionsSha256: sha256(initialFens.join('\n')) },
      configuration: { nodeLimit, pliesFactor: factor, mask, maxDepth: 16 },
      summary: {
        passed, total, failed, unknown,
        converted: wonOk, convertedTotal: converted.length,
        held: heldOk, heldTotal: held.length,
        // Old reports called every non-mate a held draw. Keep the field name
        // for readability, but only rule-proven draws are counted here.
        heldProven: heldOk
      },
      results
    }, null, 2));
    console.log(`Report: ${outFile}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
