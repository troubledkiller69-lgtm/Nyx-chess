const C = require('../src/engine.js');
const path = require('node:path');
const files = process.argv.slice(2);
const positions = [C.START_FEN, 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6',
  '8/5pk1/6p1/3p4/3P4/5KP1/5P2/8 w - - 0 35'];
for (const file of [path.join(__dirname, '../src/engine.js'), ...files]) {
  const E = require(path.resolve(file)), samples = [];
  let seed = 1367;
  for (let game = 0; game < 500; game++) {
    const pos = new E.Position(positions[game % positions.length]);
    for (let ply = 0; ply < 100; ply++) {
      const legal = pos.legalMoves();
      if (!legal.length) break;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pos.make(legal[seed % legal.length]);
      samples.push(new E.Position(pos.fen()));
    }
  }
  let checksum = 0;
  for (let i = 0; i < 10000; i++) checksum += E.evaluate(samples[i % samples.length]);
  const start = performance.now();
  for (let i = 0; i < 100000; i++) checksum += E.evaluate(samples[i % samples.length]);
  console.log(JSON.stringify({ file, evaluations: 100000, ms: performance.now() - start, checksum }));
}
