# Engine roadmap (retired)

This note used to propose bundling a third-party Stockfish build. That is no
longer the plan. Nyx Chess uses only its own engine code in `src/engine.js`;
nothing is downloaded, embedded, or delegated to an external engine or service.

For the active plan, see `docs/engine-strength-plan.md`. It lists original-code
work: bitboards, magic/kindergarten sliding attacks, incremental evaluation,
SEE, transposition-table buckets, aspiration windows, better move ordering,
lazy SMP, an original opening book, and a small self-trained evaluation
network.

The rest of this file is kept only so old links do not break.
