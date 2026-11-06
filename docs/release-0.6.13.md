# Nyx Chess 0.6.13 release note

Date: 2026-11-03
Version: **0.6.13**
Version name: `0.6.13 exact-parity evaluation fill`
Type: Engine content patch — one parity-preserving micro-optimization in `evaluate()`.

## Scope

This is the first release since 0.6.9 that changes engine content. It changes
exactly one hunk: the four typed-array `fill(0)` calls that clear the pawn file
and mask accumulators at the top of `evaluate()` are replaced by a manual 8×4
store loop.

```diff
     const wk = pos.kingSq[WHITE], bk = pos.kingSq[BLACK];
-    PAWN_FILES_W.fill(0); PAWN_FILES_B.fill(0);
-    PAWN_MASK_W.fill(0); PAWN_MASK_B.fill(0);
+    for (let f = 0; f < 8; f++) {
+      PAWN_FILES_W[f] = 0; PAWN_FILES_B[f] = 0;
+      PAWN_MASK_W[f] = 0; PAWN_MASK_B[f] = 0;
+    }
     let np = 0, nr = 0, nk = 0;
```

The same arrays are cleared to the same values before the same scan, so the
evaluator returns bit-identical scores. No weight, term, ordering, pruning, or
search parameter is touched.

**Untouched by design:** every UI file, the humanizer, the Coach pipeline and its
deliberate-error model, the opening book, session/review logic, and the search
implementation. `git`-equivalent diff of this release against 0.6.12 is exactly
the hunk above plus version strings and documentation.

## Why this and not something bigger

Profiling the shipped 0.6.12 build (`node --cpu-prof`, 48 fixed 150 ms searches)
ranked `isSquareAttacked` 20.1%, `evaluate` 17.4%, `generateMoves` 16.3%,
`make` 11.1%. `evaluate()` rebuilds pawn structure from scratch at every leaf.

A larger variant that maintained pawn/piece bitboards incrementally in
`make`/`unmake` was built and measured first. It was exactly equivalent and made
`evaluate` 1.50× faster, but the extra XOR bookkeeping cost +13 ns per
make/unmake pair, netting only **1.2%** at fixed depth 8 — worse than the simple
change's **5.7%**. It was rejected and is retained only as documented negative
evidence (`docs/benchmarks/rating/experiments/leaf-eval-bb-engine.js`).

## Exactness evidence

The change is accepted on parity, not on strength:

- **Bit-exact scores** on 122,029 positions from exhaustive depth-3 perft trees
  of four reference FENs, and on 3,767 positions from 192 seeded random games
  across all three move styles (`balanced`, `tactical`, `positional`).
- **Perft node counts** identical on all standard positions (22/22 checks).
- **Fixed-node diagnostics:** 12/12 positions agree on move, score and depth
  (`scripts/bench/compare-diagnostics.js`), re-run after integration into
  `src/engine.js`.
- **Fixed-depth determinism:** identical node counts and identical best moves at
  depths 8, 9 and 10, including all 15 paired repetitions at depth 9.
- **Public API identical:** 17 module exports, 15 `Position` methods, 12 `Engine`
  methods, statics equal to 0.6.12.

## Measured speed

| Measurement | Result |
|---|---|
| Eval microbenchmark, 32 pieces | 258–260 → 243–248 ns/call (1.05–1.06×) |
| Eval microbenchmark, 30 pieces | 276–292 → 256–259 ns/call (1.08–1.13×) |
| Eval microbenchmark, 2 kings | 104 → 77–79 ns/call (1.32–1.35×) |
| Paired fixed-depth 9, 15 pairs | median **2.5%** wall saved (IQR 0.963–0.992) |
| Fixed-depth 8, min of 7 | 5.7% |
| Interleaved fixed-time 150 ms | +1.2% nodes/s |
| Interleaved fixed-time 450 ms | +0.3% nodes/s |
| **Match-condition throughput, 48 games** | **558,470 vs 545,573 nps → +2.4%** |

The reported headline number is **+2.4% nodes/second at the match condition**
(150 ms/move). Fixed-depth figures are pure compute; fixed-time figures are
diluted by identical iteration-boundary and deadline-overshoot overhead in both
builds.

## Strength result — stated plainly

A preregistered 24-pair (48-game) match was run: `exploration-24.json`
(sha256 `df066737…3294`), seed 11, 150 ms/move, 200-ply cap.

- Pair score **51.0%** (10-5-9; game record 15-19-14)
- 95% CI **40.6% – 61.5%** (bca cluster bootstrap, seed 11)
- Relative Elo **+7.2** (−65.9, +81.1)
- 0 unresolved ply caps, 838 s wall clock
- Mean completed depth **9.15 in both builds**

**This does not demonstrate a strength gain.** The interval straddles 50% with
roughly ±10 points of slack, while a 2.4% nps change predicts on the order of
1–3 Elo. Mean completed depth did not move, so the speed gain did not buy a ply
at this budget. The release is justified by reproducible throughput plus exact
parity, and by nothing else.

## Verification on the integrated tree

All gates were run serially on `src/engine.js` after copying the exact measured
candidate in:

| Gate | Result |
|---|---|
| Candidate → `src/engine.js` hash | `86431CBBDBC7B4A866AA052B24960698026B4EC5CAC28D855BFBB6A1FB1E5A16` (byte-identical) |
| `node --test tests/*.test.js` | 171 pass, 0 fail |
| `npm run check` | syntax + manifest resources OK |
| `node scripts/bench/run-perft.js` | 22/22 |
| `node scripts/bench/run-correctness.js` | pass |
| `compare-diagnostics.js` (12 positions, 20,000 nodes) | 12/12 parity on move, score, depth |
| Browser integration (Chromium, 96 checks) | pass, from source and from the packaged ZIP |

## Packages

Built from the same tree, 20 files each. The Firefox package substitutes
`manifest-firefox.json` as `manifest.json`.

- `C:\Users\howar\nyx-chess-v0.6.13-chromium.zip` — 120,021 B, sha256 `A84D527781F01E54947BCF4828B8D82D7F4F014B1794A43A32B397874C209F92`
- `C:\Users\howar\nyx-chess-v0.6.13-firefox.zip` — 120,047 B, sha256 `D5B648A7E5818069EED2A703F69C7A1BE451570C5716DD5D314117CCAA99F5BA`

Both archives list 20 entries. Embedded `src/engine.js` in both packages is
`86431CBBDBC7B4A866AA052B24960698026B4EC5CAC28D855BFBB6A1FB1E5A16`
(97,160 B) — byte-identical to the engine that was benchmarked and matched.

The first build of these archives shipped a stale `README.md`. `README.md` is one
of the 20 packaged files, so the archives were **rebuilt** and the rebuilt
chromium archive was extracted and re-tested in full; the hashes above are the
rebuilt ones, and the 96/96 result below belongs to them. The engine bytes were
identical before and after that rebuild, so no engine-adjacent change went
untested.

| Run | Root | Checks | Failures |
|---|---|---|---|
| Source tree | `chess-autoplayer` | 96 | 0 |
| Packaged | extracted 0.6.13 chromium ZIP | 96 | 0 |

Firefox: `npm run test:firefox` installs `nyx-chess-v0.6.13-firefox.zip` as a
temporary add-on (`nyx-chess@local`) and removes it — manifest and resource
loading OK. That check validates Firefox packaging only; the 96-check harness is
Chromium-only.


## Remaining limits

- "Parity proven" means parity **on the tested corpus**: 122,029 perft-tree
  positions, 3,767 random-play positions, 12 fixed-node diagnostic positions,
  and the seed-11 match games. It is not a proof over all legal positions.
- 48 games cannot resolve a 1–3 Elo effect. No strength claim is made, and none
  should be inferred later from this release note.
- The measured speed gain is engine throughput at 150 ms/move, not a
  user-visible latency change. Coach/Deep latency work was 0.6.12 and is
  unchanged here.
- The 0.6.12 baseline snapshot
  (`docs/benchmarks/rating/baselines/nyx-0.6.12-9025cad4/`) is retained so this
  change remains attributable and reversible.

### Record-keeping note

`scripts/browser-integration/run.js` used to default its label to the literal
string `0.6.12`. The first 0.6.13 run therefore wrote into the `0.6.12-*`
filenames and replaced the 0.6.12 **source-tree** evidence. Those files were
renamed to `0.6.13-*` (they are honestly 0.6.13 data); they were not regenerated
for 0.6.12, because that would require swapping the engine back. The 0.6.12
**packaged** record — `0.6.12-packaged-browser-results.json` and its screenshots,
96/96, dated 2026-11-02 — is intact and still documents 0.6.12.

Both harness defaults now read the version from `package.json`
(`run.js` label, `firefox-install.js` ZIP name), so this cannot recur. That is
developer tooling only; neither script is inside the release archives.
