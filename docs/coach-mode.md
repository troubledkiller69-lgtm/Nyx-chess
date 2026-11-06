# Coach mode — `NyxCoach` module contract

`src/coach.js` is a standalone, advisory-only presentation and evidence module for
Coach mode. It reads the position from `NyxChess` and the result already produced
by the normal Nyx search. It does **not** search, score, pick a different move,
or execute anything.

The integration owner consumes this module from `content.js`; this document is
the contract for that work.

---

## 1. Loading

The module is an IIFE with a CommonJS fallback, like the other `src/*.js`
modules.

```js
// Browser (content script order): src/engine.js, src/review.js, src/coach.js
const guidance = globalThis.NyxCoach.buildGuidance(fen, result, options);

// Node / tests
const C = require('../src/engine.js');
const review = require('../src/review.js'); // optional, needed for feedback grading
const coach = require('../src/coach.js');
```

`src/coach.js` requires `globalThis.NyxChess` for legal-move generation. It does
not require `NyxReview`; feedback grading is marked `unrated` when `NyxReview`
is absent.

## 2. Public API

### `buildGuidance(fen, result, options?) -> Guidance`

Pure and synchronous. Builds the complete Coach display model for one position.

* `fen` — six-field FEN string.
* `result` — a `NyxChess.Engine.think()` result. Only fields that already exist
  are read: `move`, `best`, `bestMove`, `score`, `mate`, `depth`, `nodes`,
  `time`, `scoreSource`, `exactScores`, `legalMoves`, `blundered`,
  `blunderLoss`, `lines`.
* `options` — optional:
  * `revision` — any value the integration uses to identify the board revision.
    It is embedded in `guidance.key`; it is not interpreted.
  * `hintLevel` — `'concept'`, `'piece'`, or `'move'` (default). Controls how
    much of the suggestion the hint reveals. Nyx's Coach UI defaults to
    `'move'` so the suggestion arrow is visible; `'concept'` is used when the
    optional staged hint style starts or the arrow is hidden.
  * `includeSecond` — default `true`. A second candidate is included only when
    the search supplied comparable exact scores (see §5).
  * `includeThreats` — default `true`.
  * `previous` — optional post-move context:
    `{ fen, result, played }`, where `fen`/`result` are the analysis of the
    position **before** the move and `played` is the move that was played
    (UCI or SAN). Feedback is added to `guidance.feedback`.

Returns a `Guidance` DTO. It never throws for malformed FEN, missing results, or
illegal result moves; it returns a status instead.

### `buildFeedback({ beforeFen, afterFen, before, after, played }) -> Feedback`

Standalone version of the post-move grading used when `options.previous` is
supplied. `before`/`after` are Nyx results for the two positions. Grading uses
`NyxReview.normalizeScore()` and `NyxReview.verdictFor()` and only grades when
the two searches are comparable:

* `afterFen` is the exact position produced by the played move, and either
* the played move is the analysis's own top move, or
* the resulting position is terminal, or
* the after-search reports a proven mate, or
* both searches completed the same positive depth.

Otherwise `status: 'unrated'` with a reason. The FEN pairing check prevents a
stale after-position from being graded against a different move. No loss,
verdict, or confidence is invented.

### `resolveMove(fen, token) -> MoveInfo | null`

Resolves a legal move from a UCI string, SAN string, or numeric engine move
against `fen`'s legal move list. SAN matching ignores `+`, `#`, `!`, `?`, and
normalizes `0-0` to `O-O`. This is the only SAN parser; the module never guesses
a move from a board difference.

### `isStale(guidance, fen, revision) -> boolean`

Compares `guidance.key` with `keyFor(fen, revision)`. Integrations must discard
the guidance and rebuild it when the FEN or revision changed. `positionKey()`
ignores clock counters, but `keyFor` also includes `revision`: if the caller's
revision advances on clock ticks, the guidance is stale and must be rebuilt (or
the caller should pass a stable analysis revision). A clock-only FEN change with
the same revision does not change the position key.

### `keyFor(fen, revision) -> string`

Stable position/revision key. Falls back to the first four FEN fields if
`NyxChess.positionKey` is unavailable.

### `positionKey(fen) -> string`

`NyxChess.positionKey` when available, otherwise the normalized first four FEN
fields.

### Constants

* `VERSION` — DTO version (`1`).
* `HINT_LEVELS` — `['concept', 'piece', 'move']`.

## 3. Guidance DTO

```js
{
  version: 1,
  api: 'NyxCoach',
  status: 'ready' | 'no-suggestion' | 'terminal' | 'invalid-position' |
          'invalid-result' | 'unsupported',
  advisory: true,
  executesMoves: false,

  fen: string,
  revision: any,
  key: string,
  side: 'w' | 'b' | null,          // null only when the FEN is invalid
  turn: 'white' | 'black' | null,
  moveNumber: number | null,

  suggestion: MoveView | null,
  second: MoveView | null,

  hint: {
    level: 'concept' | 'piece' | 'move',
    conceptKey: 'king-safety' | 'forcing' | 'material' | 'promotion' |
                'development' | 'endgame' | 'activity' | 'game-over',
    text: string,                  // does not reveal the move at 'concept'
    piece: null | { letter, name, text },
    move: null | { uci, san, text }, // populated only at 'move'
    fullMoveAvailable: boolean
  },

  explanation: {
    category: 'mate' | 'check' | 'capture' | 'promotion' | 'castle' |
              'defensive' | 'endgame' | 'positional' | 'game-over' |
              'unavailable',
    headline: string,
    points: string[],
    scoreText: string | null
  },

  analysis: {
    source: 'nyx-engine',
    depth: number | null,
    timeMs: number | null,
    nodes: number | null,
    legalMoves: number | null,     // result.legalMoves: root moves searched
    positionLegalMoves: number | null, // legal moves in the supplied FEN
    scoreSource: string | null,
    exactScores: boolean,
    blundered: boolean,
    blunderLoss: number | null,
    searchCompleteness: 'searched' | 'static-only' | 'missing',
    score: { type: 'cp' | 'mate' | 'none', value: number | null, text: string | null },
    linesAvailable: number,
    pv: null                       // Nyx does not expose a PV; never invented
  },

  threats: {
    inCheck: boolean,
    king: { square, attackedBy: string[], inCheck: boolean },
    immediate: Threat[]            // legal captures/checks if the opponent moved now
  },

  safety: {
    own: PieceSafety[],            // pieces of the side to move
    enemy: PieceSafety[]           // opponent pieces, useful as capture targets
  },

  highlights: {
    arrows: Arrow[],
    squares: SquareMark[]
  },

  feedback: null | Feedback,

  evidence: {
    basis: string[],
    pv: null,
    limitations: string[]
  },

  warnings: string[]               // structural/input problems only
}
```

### `MoveView`

```js
{
  uci: 'e2e4',
  from: 'e2',
  to: 'e4',
  promotion: null | 'q' | 'r' | 'b' | 'n',
  san: 'e4',
  piece: 'P',                 // P N B R Q K
  pieceName: 'pawn',
  color: 'w' | 'b',
  capture: null | { square, piece, pieceName, value, enPassant: boolean },
  castle: null | 'k' | 'q',
  check: boolean,             // verified by making the move
  mate: boolean,              // verified: opponent has no legal reply
  enPassant: boolean,
  score: number | null,       // only for second candidates; search units
  scoreComparable: boolean    // true only when result.exactScores was true
}
```

`check` and `mate` are recomputed from the legal position after the move, not
taken from engine metadata. `score` on the suggestion is available through
`analysis.score`; on `second` it is the search's root score when exact scores
were supplied.

### `Threat`

```js
{
  kind: 'capture' | 'check',
  from: 'e5',
  to: 'd4',
  san: 'exd4',
  piece: 'P',
  pieceName: 'pawn',
  attackerValue: 1,
  target: null | { square, piece, pieceName, value, defended: boolean, hanging: boolean },
  legal: true
}
```

Threats are **legal moves available to the opponent if the turn passed**, not a
prediction of the opponent's reply and not a PV. Checks are verified by making
the move. Lists are capped at 12 captures and 6 checks, sorted by target value,
then by attacker value.

### `PieceSafety`

```js
{
  square: 'd4',
  piece: 'Q',
  pieceName: 'queen',
  color: 'w',
  value: 9,
  attacked: true,
  defended: false,
  hanging: true,
  status: 'hanging' | 'attacked' | 'defended' | 'quiet',
  attackers: ['e5'],          // squares of legal enemy attackers
  defenders: ['c3']           // squares of friendly geometric defenders
}
```

Distinctions are explicit:

* `hanging` — legally attacked, not defended.
* `attacked` — legally attacked and defended (contested).
* `defended` — defended, not legally attacked.
* `quiet` — neither.

`attacked` is confirmed with legal moves (a pinned attacker does not count).
`defended` uses geometric defenders; a pinned defender can still be listed, and
this is disclosed in `evidence.limitations`.

### `Arrow` / `SquareMark`

```js
{ from: 'g1', to: 'f3', kind: 'suggestion' | 'candidate' | 'threat' }
{ square: 'd4', kind: 'suggestion-from' | 'suggestion-to' | 'candidate-from' |
                    'candidate-to' | 'threat' | 'hanging' | 'attacked' |
                    'king-check', side: 'w' | 'b' | null }
```

Only actionable safety states (`hanging`, `attacked`) are marked; the complete
`defended`/`quiet` classification remains in `safety`. These are data only.
Styling and board rendering stay in the integration owner's files.

## 4. Reveal flow

The module supports staged disclosure; the integration decides when to advance.
The shipped panel shows the move arrow by default and offers staged hints as an
optional hint style.

Default (move arrow):

1. Build with `hintLevel: 'move'`.
   * `hint.move` contains UCI/SAN, and the integration draws `suggestion`'s arrow.
   * The panel offers **Hide arrow** / **Show arrow**; hiding rebuilds with
     `hintLevel: 'concept'` and redrawing the same suggestion restores it.

Optional staged style (`coachHints: 'staged'`):

1. Build with `hintLevel: 'concept'`.
   * `hint.text` gives a category cue, e.g. **"Look at king safety first…"**.
   * `hint.move` is `null`.
   * The full `suggestion` object exists in the DTO for the renderer, but the
     integration should not show the arrow or SAN yet.
2. On "another hint", rebuild with `hintLevel: 'piece'`.
   * `hint.piece` names the piece, still no squares or SAN.
3. On "show me", rebuild with `hintLevel: 'move'`.
   * `hint.move` contains UCI/SAN. Only now draw `suggestion`'s arrow.

The module does not hold reveal state; rebuilding is deterministic and cheap.

### Coach timing

Coach is advisory presentation, not a simulated turn. When Move control is
**Coach** and the playing mode is **Human**, the controller still sends the
normal Human search options and error roll, but the result path differs from
Autoplay:

* The configured search budget is still spent. The search is not shortened,
  Ruthless is not selected, and no worker/threading setting is changed.
* Search-time jitter, the post-search `humanPause()`, mouse pauses, and the
  clock-derived pause cap do not run. Those belong to Autoplay, which still
  queues and confirms its move exactly as before.
* As soon as the engine result arrives, the controller rebuilds the guidance,
  marks the phase `coaching`, and pushes a `status-changed` refresh to an open
  panel. The rebuild is not delayed by the 650 ms status poll.

The recommendation itself is unchanged: the same configured Elo, style,
variety, opening book, soft errors, and hard-error budget apply. A hard error
still spends its reservation only if the player follows the suggestion; ignoring
it costs nothing. The panel labels a `blundered` result as a practice
suggestion so an intentional error is not presented as Nyx's best move.

## 5. Second candidate support

A second candidate is emitted only when all of these hold:

* `options.includeSecond !== false`;
* `result.exactScores === true` (PVS root scores after the first move can be
  bounds, so they are not comparable);
* `result.lines` has a legal move different from the suggestion;
* that line has a finite numeric score.

Otherwise `second` is `null`. The module never labels a bound as "second best".

### Integration display rules

* The UI labels the field **Alternative suggestion**, never "second best".
* It is enabled only while `exactScores` is true and a genuinely comparable
  candidate exists; otherwise the control is disabled with a concise reason and
  no score or SAN is invented.
* Threat arrows are capped at three, drawn beneath the suggestion, and marked
  only on their target square. They describe legal opponent capture options if
  the turn passed; they are not a predicted reply, a guarantee of profit, or a
  claim that a defended piece is undefended (pinned defenders are disclosed).
* Threat text uses plain hypothetical wording, e.g. "If Black had the turn, its
  pawn on e5 could capture the queen on d4 (exd4)."
* When the controller asked for a configured human-style error and the search
  reports `blundered`, the panel says the advice is a practice suggestion for
  the configured difficulty, not Nyx's strongest or guaranteed move.

## 6. Post-move feedback

`buildGuidance(..., { previous: { fen, result, played } })` calls
`buildFeedback`. It reuses `NyxReview` and marks `unrated` when:

* `NyxReview` is not loaded;
* the played move cannot be resolved legally in `beforeFen`;
* the before/after searches are not comparable by the rules above;
* either result lacks the required score fields.

Rated feedback returns `status: 'rated'`, `verdict`, `loss`, `matched`,
`beforeDepth`, `afterDepth`, and `source: 'NyxReview'`. It is never presented as
ground truth; `evidence.limitations` repeats that it is a comparison of two
bounded searches.

```js
{
  status: 'rated' | 'unrated',
  source: 'NyxReview' | null,
  played: null | { uci, san },
  best: null | { uci, san },
  matched: boolean,
  comparable: boolean,
  beforeDepth: number | null,
  afterDepth: number | null,
  beforeScore: number | null,   // NyxReview.normalizeScore(before)
  afterScore: number | null,    // played side's point of view
  loss: number | null,          // centipawns, null when unrated
  verdict: 'good' | 'dubious' | 'inaccuracy' | 'mistake' | 'blunder' | 'unrated',
  reason: string | null         // why an unrated result is unrated
}
```

`buildFeedback` expects `beforeFen`/`afterFen` to match the supplied results and
the played move. It does not repair mismatched history; a stale pair simply
grades what the evidence supports, usually `unrated`.

## 7. Invalidation

```js
const g = coach.buildGuidance(fen, result, { revision: board.revision });
if (coach.isStale(g, currentFen, board.revision)) {
  // discard g, rebuild
}
```

`keyFor` includes `positionKey(fen)` (clocks ignored) and the revision value.
A FEN change or revision change invalidates. A clock-only FEN counter change
with an unchanged revision does not. The DTO is immutable-by-convention;
consumers should not mutate arrays in place.

## 8. Example

```js
const result = {
  move: 'g1f3', score: 28, depth: 8, nodes: 42000, time: 180,
  scoreSource: 'search', exactScores: true, legalMoves: 20,
  lines: [
    { move: 'g1f3', score: 28 },
    { move: 'e2e4', score: 20 }
  ]
};

const g = coach.buildGuidance(C.START_FEN, result, { revision: 7 });
// g.status === 'ready'
// g.suggestion.san === 'Nf3'
// g.hint.level === 'move'      (arrow visible by default)
// g.hint.move.san === 'Nf3'
// g.second.san === 'e4'
// g.analysis.searchCompleteness === 'searched'

const hidden = coach.buildGuidance(C.START_FEN, result, {
  revision: 7, hintLevel: 'concept'
});
// hidden.hint.move === null; the DTO still carries suggestion for the renderer
```

## 9. Deliberate non-goals

* No search, evaluation, move selection, or engine configuration changes.
* No external engine and no network access.
* No move execution, board mutation, or DOM work.
* No fabricated PV, expected reply, confidence score, or tactical motif that
  the module cannot verify from the legal position.
* No second candidate from non-exact root scores.
* No post-move grade without comparable evidence.

## 10. Tests

`tests/coach.test.js` is a lightweight deterministic Node test file:

```sh
node --test tests/coach.test.js
```

It covers legal-move resolution, SAN, hint staging, second-candidate gating,
threat/safety classification, invalid input, invalidation, and comparable vs
unrated feedback. It does not run the engine's search.
