# Nyx-chess

A dependency-free Chrome/Edge Manifest V3 extension with a local JavaScript chess engine, opening repertoires, and one-move/autoplay controls for Chess.com.

## 0.6.13 exact-parity evaluation fill

The engine now clears its pawn file/mask accumulators with a manual 8×4 store
loop instead of four typed-array `fill(0)` calls at the top of `evaluate()`. The
same arrays are zeroed to the same values before the same scan, so every score is
bit-identical — verified over 122,029 perft-tree positions, 3,767 random-play
positions across all three styles, 12/12 fixed-node diagnostics, and identical
node trees at depths 8, 9 and 10.

Measured effect is **throughput, not strength**: +2.4% nodes/s in match
conditions (558,470 vs 545,573 over 48 games), 2.5% median wall saving at fixed
depth 9, and `evaluate` itself 1.05× faster at 32 pieces. A preregistered 24-pair
match scored 51.0% (95% CI 40.6–61.5%, relative Elo +7.2 with interval
−65.9 to +81.1) with mean completed depth 9.15 in both builds. That sample cannot
resolve the roughly 1–3 Elo such a speed gain predicts, so **no strength gain is
claimed**; the release rests on exact parity plus reproducible speed. Every UI
file, the humanizer, the Coach pipeline and its deliberate errors are unchanged.
See [the 0.6.13 release note](docs/release-0.6.13.md).

## 0.6.12 faster Deep suggestions

Deep now uses a **1500 ms** search budget instead of 5000 ms. A Coach suggestion
on Deep therefore returns in roughly 1.5 seconds plus small iterative-deepening
overhead, while Autoplay Human keeps its existing search-time jitter and
post-search pause. Rapid remains 1400 ms, so Deep is still the longer search and
keeps the configured maximum-depth cap; the preset does not promise a depth.
Existing saved Deep sessions that used the old 5000 ms preset migrate to the
new budget, while an explicit **Custom** 5000 ms choice is preserved unchanged.
The status line calls Deep a budget rather than an exact finish time because the
engine can finish its current depth a little past the limit. Deliberate Human
errors, move variety, Coach error handling, and `src/engine.js` are unchanged.

The previous 0.6.11 build publishes a Coach recommendation as soon as the search
result lands, without waiting out the Human post-search pause or the status poll.

The previous 0.6.10 build made the Coach suggestion arrow visible by default,
kept optional hint-first staging, and reorganised the panel into five focused
tabs. Session tracking counts completed games with per-mode and time-control
buckets, keeps win/loss streaks and active play time, and can stop the
controller after a configured number of games or minutes. See
[session tracking](docs/session-tracking.md) and
[the coach contract](docs/coach-mode.md).

This remains a correctness/UI build, not a proven strength upgrade. The saved
0.6.5 package remains the known-strong reference; use it when measured strength
is the only priority. The original 0.6.7 evaluation lost **33.3%** (144 games)
against 0.6.5. The shipped engine uses the tested repair content: the 0.6.7
search and infrastructure with the 0.6.5 evaluation. It scored **53.5%**
(CI 47.6–59.4) on a 72-pair development sample and **56.9%** (CI 47.9–66.0) on
the 36-pair validation sample. Both intervals include 50%, the samples were not
pooled, and no superiority or absolute rating is claimed. Those samples belong
to the tested candidate `85f79c39…`, not to the released engine: 0.6.12 shipped
`9025cad4…`, and 0.6.13 ships `86431cbb…`, which differs from `9025cad4…` only in
how the identical evaluation is computed (bit-identical scores on the tested
corpus above), so the statement carries over on that corpus and no further.
The validation set is now consumed. Full history, integration deltas, and
hashes are in [the regression report](docs/benchmarks/rating/regression-0.6.7.md),
[the 0.6.7 release evidence](docs/release-0.6.7.md),
[the 0.6.8 re-version note](docs/release-0.6.8.md),
[the 0.6.9 release note](docs/release-0.6.9.md),
[the 0.6.10 release note](docs/release-0.6.10.md),
[the 0.6.11 release note](docs/release-0.6.11.md), and
[the 0.6.13 release note](docs/release-0.6.13.md).

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `C:\Users\howar\chess-autoplayer`.
4. Reload any Chess.com tabs already open.
5. Open a Chess.com board and click the **Nyx Chess** toolbar icon (or press **Ctrl+Shift+Y**). The movable panel opens over the board; drag its title bar and resize from its bottom-right corner.

No package installation or build step is required. If using the ZIP, extract it first and select the extracted folder containing `manifest.json`.

For Firefox, use the Firefox package (or copy `manifest-firefox.json` over
`manifest.json` in a separate extracted folder) and load it from
`about:debugging` → **This Firefox** → **Load Temporary Add-on**. The Firefox
manifest keeps the MV3 content scripts and the background-script entry point;
the review worker is the same `src/worker.js` used by Chromium.

## Controls

- **0.6.5 setup-page fix:** Coach and autoplay no longer refuse to start on `/play/online` and `/play/computer` preview boards — only Auto-queue claims those pages, and everything else analyzes the preview as before. A queued game now initializes the engine, side to play, and per-game error budget as soon as its board appears; previously it could sit on “Loading local engine…” with no suggestion arrow. The controller also re-locks to a new board instead of stopping when the queue crosses into the next game.
- **0.6.4 auto-rematch / queue:** **Auto-rematch** is now a continuous queue. It survives Chess.com navigating to a new game page, matches icon-only controls through `aria-label`, keeps trying after the first few rematch clicks, and falls back to **New Game → Start Game / Play** when the opponent does not accept. The queue is scoped to the tab, expires after 30 minutes, and is cleared by **Stop**. On a play setup page, clicking Start queues a game instead of autoplaying the preview board. It still waits according to the session planner, so it does not look mechanical.
- **0.6.3 human sandbagging:** Human mode no longer plays the silicon-best move every turn just because Elo is at **Maximum** and Move variety is 0. It keeps a small near-best allowance (roughly 24–38 cp, widening with variety and lower Elo), so Good and Excellent moves appear naturally. On top of that, soft errors now request 25–180 cp on roughly 16% of eligible moves, and the configured hard-error budget is rolled at roughly 10% per eligible move until spent. Ruthless is unchanged and still plays the exact best move.
- **0.6.2 error severity and variety:** **Error severity** sits beside Blunders. **Major** asks for a 300–900 centipawn loss when a legal, non-mate material error exists; **Mixed** keeps the older 80–450 cp range. Both are our engine's estimates, not Chess.com's labels, and a scarce candidate set can still yield a smaller error or none. **Move variety** now appears on Play. Adaptation can no longer overwrite an explicit variety setting (it previously collapsed 100 to 12). At maximum variety, opening candidates widen across sound first moves; expect some offbeat but legal choices rather than exclusively `Nf3`-style development.

- **0.6.1 Human-mode fix:** the single-worker coordinator now preserves the selected move and its error metadata instead of replacing it with the top candidate. This restores strength handicaps, move variety, and deliberate mistakes in the actual autoplay path.
- **Blunders** is near the top of **Play**, directly below Move control in both menus. The counter shows confirmed hard errors played against the configured limit (0–3), with a queued indicator. Ruthless explicitly shows that deliberate errors are off; Coach shares the budget with Autoplay. Stop/Start preserves the count; a new game resets it. This is a limit, not a guaranteed count: book moves and positions without a suitable losing alternative do not spend it.

- **Move control → Autoplay / Coach** (Play tab, popup and floating panel): Autoplay moves pieces; Coach never touches the board, resigns, or rematches. Coach shows the main suggested move arrow by default, with the idea and SAN beside it; **Hide arrow** removes it and **Show arrow** brings the same suggestion back. An optional **Hint style → Reveal in steps** stages help as concept (idea and threat marks, no arrow), piece, then move. It uses the same recommendation Autoplay would play, including configured hard/soft errors, and labels a degraded practice result honestly when the simulation error fires. **Coach plus Human is advisory and immediate:** it uses the configured search budget but skips the Human post-search pause and all search-time jitter, then pushes the result to an open panel without waiting for the status poll. Its one-shot action is **Suggest one move**. If you follow a suggested error, the displayed count increments; if you ignore it, nothing is spent. Threat marks are legal opponent capture options, not predicted replies, capped at three; the alternative suggestion appears only when the two searches are directly comparable, and is disabled with a reason otherwise. See [the coach contract](docs/coach-mode.md).
- **Tabs** (panel): **Play** (side, mode, pace, start), **Coach** (hint style, arrow toggle, threat marks, alternative suggestion), **Openings** (repertoire), **Session** (record, limits, reset, queue), **Engine** (depth, threading). The header, readout and Start/Stop stay visible on every tab; keyboard Left/Right/Home/End moves between tabs, and the selected tab is remembered. Switching tabs never resets a run or a setting.
- **Session** (Session tab): completed games are counted once with win/draw/loss/unknown, split by Coach/Human/Ruthless and by the opening clock (bullet/blitz/rapid/classical/unknown). It tracks win and loss streaks and active play time, never guesses an unrecognised result, and survives tab reloads through `chrome.storage.local`. **Stop after games/minutes** stops the controller at the limit; **Reset stats** clears the record explicitly. Statistics stay visible after a limit stop. See [session tracking](docs/session-tracking.md).
- **Move quality** appears beneath the selected move. Labels are Book, Best, Excellent, Good, Inaccuracy, Mistake, or Blunder. Hover for the estimated centipawn loss and depth. These are Nyx estimates for the selected suggestion, not Chess.com Game Review grades or a review of your manual move. Incomplete or incomparable searches show **Unrated**.
- **Review last game** (Session tab): available only after a game has ended and autoplay and the rematch queue are stopped. It replays your side at a small fixed search budget, reports the worst moves, and can be **cancelled** at any time. The review runs on a dedicated worker, so it never takes CPU from a live game search. It is a search estimate, not a Chess.com Game Review grade; if the two searches finish at different depths, the move is marked **Unrated** instead of inventing a loss. See [post-game review](docs/post-game-review.md).
- **0.6.0 autoplay fix:** clock ticks no longer change the position revision or cancel searches/queued moves. The delayed pointer drag was also checked on a real Chess.com analysis board.
- **Clock allocation:** Human mode caps search and pause against remaining time with a reserve; missing clocks retain the selected pace. Time pressure raises the error probability. With adaptation enabled, a moving average of complete opponent turns nudges pacing by −20% to +15%.

- **Play one move** searches and plays for the current side to move.
- A gold arrow on the board shows the chosen move before it is played; it clears when the move starts or when you stop.
- **Start autoplay** follows White, Black, both sides, or the detected player color. When a player color is unavailable, Auto uses the board orientation at Start.
- **Stop** cancels search and queued moves. A move already dispatched to the board cannot be undone by Stop.
- Minimize the on-board panel to the corner launcher; closing or moving between boards keeps its layout settings. Reloading the tab stops autoplay.
- **Human / Ruthless** switches the playing personality. Human adds a real post-search pause, a variable think clock, a mouse-like drag, opponent adaptation, and deliberate errors. Ruthless removes every handicap: full skill, no variety, no blunders, no pause, and a root-split search across the available CPU cores.
- **Bullet / Blitz / Rapid / Deep** set the search budget: 160 ms, 450 ms, 1400 ms, and 1500 ms. The Human pause is **added after** search, so it cannot be swallowed by a long search: bullet ~0.2–1.0 s, blitz ~1.2–3.3 s, rapid ~3.8–9 s, deep ~3.8–9 s. About 8% of moves are impatient and about 7% are long thinks.
- **The Human clock reads the board clock when Chess.com exposes it.** Under 15 s left the pause collapses to instinct speed; under 40 s it roughly halves; with a large reserve it stretches. If no clock can be read, the normal range is used.
- **Adapt to opponent (Play tab):** builds a live model from the opponent's moves — captures, checks, early queen sorties, pawn storms, castling, and trades. A lunger gets a positional, lower-variety response; a solid trader gets a tactical imbalance; a tricky opponent gets positional play. The model also nudges search time and how readily errors are spent. Profiles are remembered per opponent name across games.
- **Maximum depth** (Engine tab) is a hard cap, not a promise. Human mode also limits depth by the Target Elo preset. Ruthless uses the cap literally; choosing Ruthless or Deep raises a stale low cap to 12.
- **Blunders per game (0–3):** Human mode spends this budget on hard errors, never in the opening book, never on a forced mate, and never in Ruthless. **Major** uses 300–900 centipawns; **Mixed** uses 80–450. Separately, human move selection itself leaves the top move on a portion of ordinary turns, and a soft error is requested on roughly 16% of eligible moves (25–180 centipawns). The error rate varies with per-game form, time pressure, and a short tilt window after a confirmed hard error. Each new game receives a fresh limit; unused errors do not accumulate.
- **Auto-rematch / queue:** when a game ends, waits according to the session planner — normally 6–25 s, longer after a losing streak or late at night, with a 4–12 minute break every 4–9 games. It clicks Rematch / Play Again, retries, then falls back to New Game → Start Game / Play if the opponent does not accept. The queue survives page navigation in the same tab until **Stop**, and matches icon buttons by `aria-label` as well as visible text. It occasionally skips the rematch (4–8%) for a longer break, then starts a fresh game, so the account does not look like an infinite queue machine.
- **Resignation:** with adaptation on, a genuinely lost position (worse than −900 cp after at least 18 full moves) is sometimes resigned instead of defended perfectly for 40 moves. Never in Ruthless.
- **The Human clock is position-aware:** forced moves and obvious best moves are played faster; crowded, sharp positions get the longer end of the range. Book moves are quicker than calculated ones.
- **Search budget** limits computation. **Move delay** is legacy: the Human pause is automatic in Human mode, and a zero value no longer disables it. "Play one move" is always immediate.
- To face a strong bot: choose **Ruthless**, **Deep**, keep **Move variety** at 0, and pick a sound opening or **Engine chooses**. The parallel search only runs in Ruthless; Human mode stays single-threaded because it needs one exact root score list.
- Rated or human games are the wrong place for Ruthless. Perfect engine correlation plus a fixed clock is what gets accounts flagged; Human mode with **Maximum** Elo, a rapid clock, and 2 blunders looks far more ordinary.

## Openings and gambits

Select separate White and Black repertoires in the **Openings** tab. The list is generated from one repertoire definition: 76 named systems and 100 legal lines, including the Italian, Ruy López, Scotch, Queen's Gambit, London, English, Catalan, Sicilian, Caro–Kann, French, Scandinavian, and the gambit families (King's, Evans, Danish, Smith–Morra, Budapest, Albin, and others).

A line is a short recipe, not a complete repertoire: a gambit depends on the opponent's replies. Moves are selected by the complete position, including turn and castling rights; if the position leaves the book, engine search takes over. Book moves are rechecked for legality. The controller remembers the first twelve plies of the last games and weights the book away from recently repeated lines, so the same ten-move sequence does not recur every game. For maximum strength against a strong bot, use **Engine chooses** or a sound mainline rather than a speculative gambit.

For **Custom opening line**, enter both sides' moves from the normal starting position using UCI coordinate notation:

```text
e2e4 e7e5 f2f4 e5f4 g1f3
```

Select Custom for White, Black, or both. A single starting move such as `g1f3` is valid. Castling is `e1g1`/`e1c1`; promotion includes a suffix, such as `a7a8q`. Illegal lines are rejected with the move number.

## Target Elo and style

- **Target Elo (600–2200, in steps of 50):** a rough move-quality preset, not a calibrated rating. The numbers are not Chess.com ratings or a claim that the engine achieves that Elo. Actual play depends on the position and search budget. The slider’s final **Maximum** stop has no rating label and removes the Elo handicap.
- The default target is **1600**. Existing Strength settings migrate to a corresponding Elo-labelled preset. Internally, the setting maps to bounded search and move-selection parameters.
- **Maximum** removes the Elo handicap and uses the full configured depth/time budget. In Human mode a small near-best allowance remains, so it can choose a sound alternative even with Move variety at 0. Ruthless, not Maximum alone, is what guarantees the highest-scored completed search move.
- **Move variety (0–100):** samples among a bounded set of similarly scored legal moves. This is heuristic weaker-play selection, not a model of human decision-making; see [Playing model and research](docs/playing-model.md).
- **Ruthless** ignores Target Elo, variety, move delay, and blunders. It forces skill 100 and always plays the best completed root score.
- **Blunders** are chosen from the engine's own completed root scores, not by picking a random legal move: a hard error loses 300–900 centipawns on **Major** or 80–450 on **Mixed**, while the recurring soft error stays inside 25–180. Human mode also sandbags near-best moves by a few dozen centipawns. That produces ordinary club-player errors instead of obvious nonsense.
- **Balanced:** tapered material and piece-square evaluation, bishop pair, pawn structure, passed pawns, rooks on open files and the seventh, knight outposts, and king safety.
- **Attacking:** adds a small preference for pieces near the opposing king.
- **Positional:** increases pawn-structure and bishop-pair preferences.

Styles are evaluation preferences, not commands to force a fork, pin, or sacrifice. Book moves take priority over Elo/style until the book ends. These controls vary play; they do not establish that automation is indistinguishable from a person.

## Implementation

- `src/engine.js`: legal move generation, incremental Zobrist hashing, iterative deepening, principal-variation search, transposition table, null-move pruning, late-move reductions, quiescence search, search-path repetition checks, tapered evaluation, and bounded candidate selection.
- `src/openings.js`: compiled, position-keyed opening lines and custom-line validation.
- `src/bridge.js`: main-world Chess.com adapter; reads the actual FEN, opponent names, and board clocks, validates/displays moves with human-paced pointer drags, and clicks rematch/resign controls.
- `src/content.js`: isolated-world controller, per-tab start/stop, position revision checks, human pause clock, blunder budget, auto-rematch, resignation, and move confirmation.
- `src/profile.js`: opponent model built from observed moves, style classification, per-opponent memory, and adaptation rules.
- `src/human.js`: session planner, opening repetition memory, endgame imperfection, resignation policy, additive think time, and mouse pauses.
- `src/review.js`: post-game move recovery and review scoring. It refuses to grade a move when the before/after searches completed at different depths unless the played move is the engine's own choice or the after-position is a proven terminal result.
- `src/host.html`, `host.js`, `worker.js`: extension-origin iframe and cancellable worker pool. Ruthless splits the legal root moves across up to four workers, merges their exact scores, and picks the best; Human uses one worker. Review uses a dedicated, cancellable worker and is refused while a game search is active. Search stays off the board's main thread.
- `src/overlay.css`: movable, resizable shadow-DOM panel styles.
- `popup/`: browser-action fallback and local demo preview.

No remote engine, remote scripts, analytics, or build dependencies. Extension permissions: local storage plus Chess.com host access (needed so the toolbar action can target the active board). Content scripts run on Chess.com only.

The engine is a compact custom implementation, not Stockfish. Repetition detection combines the current search path with the board's game history supplied by Chess.com. Chess.com's page API and DOM are private and can change.

## Verification

On Windows PowerShell:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run test:browser
npm.cmd run test:firefox
```

`test:browser` launches Chromium with the unpacked extension, serves a fake
Chess.com board from local interception, and drives the real overlay, host
iframe, review worker, and engine worker. It does not open a Chess.com account,
start a rated game, or send a move to a live board. Set `CHROME` to a Chromium
or Chrome-for-Testing executable if the default path is not present. The latest
run used Chromium 159; results and a screenshot are written under
`docs/integration/`. The extension ID depends on the load path, so it differs
between the repo folder and an extracted package.

`test:firefox` opens headless Firefox, installs the packaged ZIP as a temporary
add-on through the WebDriver BiDi `webExtension.install` command, then
uninstalls it. Set `FIREFOX` and `NYX_FIREFOX_ZIP` to override the executable and
package paths. This proves Firefox accepts the manifest and all referenced
resources; it does not run the Chess.com harness.

The suite currently has 171 tests. Coverage includes perft, tactics, incremental evaluation, special moves, openings, repetition, worker cancellation, parallel search, post-game review recovery and scoring, review-worker isolation/cancellation, new-game review cancellation and stale-result rejection, clock-only updates, delayed move dispatch, Coach immediate-result timing with Human errors preserved, Coach default arrow and optional staged hints, post-move feedback, mode switching, move-quality labels, clock budgeting, opponent tempo, profiles, session dedup/limits/time buckets, popup persistence, and keyboard navigation. Evaluation regressions check color symmetry, mobility, pins, coordinated attacks, outposts, pawn races, blocked passers, dead material, and cache separation. Passing these checks establishes targeted correctness, not a playing-strength gain; see the measured regression above. The Chromium loaded-extension flow (post-game review availability, start/cancel, new-game cancellation, book and search routing, default Coach arrow and optional staged reveal, restrained threats, stale clearing, orientation, resize, SVG self-healing, tab navigation and persistence, member initialization, session count/dedup/reset and stop-after-games) is covered by `test:browser`; Firefox manifest/resource loading is covered by `test:firefox`, while Firefox runtime play still needs a manual smoke test.

To preview the popup with sample data:

```powershell
npm.cmd run dev
```

Open `http://127.0.0.1:8765/popup/popup.html?demo`. Demo state is injected by the local preview server only.
