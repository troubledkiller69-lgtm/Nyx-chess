const C = require('../src/engine.js');
const S = require('../src/settings.js');
const cases = {
  start: C.START_FEN,
  mid: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6',
  tactics: 'r2qkb1r/pp2pppp/2n2b2/3N4/3P4/5N2/PP3PPP/R1BQKB1R b KQkq - 0 8'
};
(async () => {
  for (const [name, fen] of Object.entries(cases)) {
    const opts = S.engineOptions({ elo: 1600, depth: 5, timeMs: 700, variety: 0 });
    const t = performance.now();
    const r = await new C.Engine().think(fen, opts);
    console.log(name, r.move, 'd' + r.depth, r.nodes + ' nodes', Math.round(performance.now() - t) + 'ms', 'score ' + r.score);
  }
})();

