# Opening suites for rating runs

- `tuning-72.json`: 72 lines, SHA-256
  `b34d9c5138da20828f22ebb240855f2c25bb20d392794a4ec84e6fe531418541`.
  This is a frozen copy of the development opening set. Reuse is allowed.
- `validation-36.json`: 36 lines, SHA-256
  `7e9d453a5f918b7f6983100c3885576e2f73b9ecca066b2b4759993d975b041d`.
  This set is reserved for one confirmatory run after tuning. Do not use it to
  choose or tune a build, and do not edit it to rescue a result. The lines were
  authored from standard opening theory for this work; no engine search or game
  result was used to pick or edit them.

Both suites use UCI move lists from the standard start position. The runner
validates every line before the first game.

## Provenance is verified, not assumed

`node scripts/rating/check-openings.js` replays every line with `Position` only
(no search, no games) and writes `docs/benchmarks/rating/openings/provenance.json`:
per-suite hashes, duplicate lines, duplicate final positions, and cross-suite
transposition overlap. Current state:

- 0 duplicate lines and 0 duplicate final positions inside either suite;
- 0 identical final positions between validation and tuning;
- 0 validation final positions reachable anywhere inside a tuning line;
- 36/36 validation lines share at least one non-start position with tuning
  (median 6, max 10). Shared prefixes are expected in chess and are disclosed;
  they mean the suites are not independent samples of opening space.

That is the evidence behind calling the validation file untouched, rather than
just it having a different filename. The fixed-sample bootstrap remains
conditional on whichever suite is used, not on a random sample of all openings.
The full methodology is in `docs/rating-methodology.md`.
