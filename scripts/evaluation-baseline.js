// Build a measurement-only ablation: old evaluation with our new square weights.
// Output stays outside the extension. No third-party weights survive in it.
const fs = require('node:fs');
const path = require('node:path');
const [baseline, output] = process.argv.slice(2);
if (!baseline || !output) throw new Error('Usage: node scripts/evaluation-baseline.js OLD_ENGINE.js OUTPUT.js');
const current = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
let old = fs.readFileSync(baseline, 'utf8');
const start = old.indexOf('  // Tapered piece-square tables.');
const end = old.indexOf('  const VALUE =');
if (start < 0 || end < start) throw new Error('Unrecognized baseline table layout');
const newStart = current.indexOf('  // Original tapered material weights');
const newEnd = current.indexOf('  const VALUE =');
old = old.slice(0, start) + current.slice(newStart, newEnd) + old.slice(end);
old = old.replace(/MG_TABLES\[t\]\[sq \^ 56\]/g, 'squareValue(t, sq, false)')
  .replace(/MG_TABLES\[t\]\[sq\]/g, 'squareValue(t, sq ^ 56, false)')
  .replace(/EG_TABLES\[t\]\[sq \^ 56\]/g, 'squareValue(t, sq, true)')
  .replace(/EG_TABLES\[t\]\[sq\]/g, 'squareValue(t, sq ^ 56, true)');
fs.writeFileSync(output, old);
