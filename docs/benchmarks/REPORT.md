# Nyx Chess benchmark report

Generated 2026-11-01T06:35:51.466Z

> Historical report from before the Phase 2/3 search and evaluation work. It
> records the build hash beside it; it is not a current strength claim and its
> numbers are not directly comparable to the latest runs.

A result here is only a claim about the exact build hash beside it. Match scores are pair scores with an interval, never a rating.

### Tactics

Build `engine.js` `fb7030bd8b16`, 60,000 nodes per position.

| Category | Solved | Rate | Avg nodes |
| --- | --- | --- | --- |
| mate in 1 | 30/30 | 100.0% | 34 |
| mate in 2 | 28/30 | 93.3% | 876 |
| mate in 3 | 16/20 | 80.0% | 9,410 |
| **Overall** | **74/80** | **92.5%** | |

Failures:

- `mate-2-60` mate in 2: played h3d3 at depth 5 — `8/1K2Q3/8/8/8/7R/8/2k5 w - - 0 1`
- `mate-2-30` mate in 2: played e5b5 at depth 4 — `8/2Q5/8/K3R3/8/8/k7/8 w - - 0 1`
- `mate-3-32` mate in 3: played b6b7 at depth 8 — `2N4k/8/1Q6/8/5K2/8/8/8 w - - 0 1`
- `mate-3-59` mate in 3: played g5f6 at depth 6 — `4k3/8/1B6/6K1/8/5Q2/8/8 w - - 0 1`
- `mate-3-12` mate in 3: played b7e4 at depth 5 — `8/1Q1K4/8/8/8/8/7k/R7 w - - 0 1`
- `mate-3-58` mate in 3: played a7e7 at depth 8 — `8/R4K2/8/8/1R6/7k/8/8 w - - 0 1`

