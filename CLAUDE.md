# CLAUDE.md

**Fathomrest** — browser-based hybrid idle/active game: resource extraction across an archipelago,
paced by a research tree. TypeScript, React + PixiJS, headless simulation core.

## Documents

- [DESIGN.md](DESIGN.md) — canonical design record: core loop, economy, research
  tree, technical architecture, vertical-slice milestone. **Read before making any
  design or architecture decision; update it when a decision changes.**
- [docs/adr-0001-game-loop-and-state-model.md](docs/adr-0001-game-loop-and-state-model.md) —
  event-driven analytic sim core (no fixed timestep), EC data model, clock/RNG/
  persistence rules, and the litmus test every new mechanic must pass.
- [docs/browser-performance.md](docs/browser-performance.md) — browser/engine
  guidance: hot-path allocation rules, shape stability, table access boundary,
  Safari lifecycle, float-determinism caveats. Read before writing core or
  render-loop code.
- Future decision docs (ADRs, balancing notes) live in `docs/` — add them to this
  list as they appear.

## Working in this repo

- [TODO.md](TODO.md) is the session handoff doc. At the end of every working session,
  **replace** its contents (never append) with the concrete next steps, and include it
  in that session's commit. Read it at the start of a session to pick up where the
  last one left off. Next steps only — long-term plans belong in DESIGN.md.

- Design decisions in DESIGN.md are settled unless the user reopens them. Flag
  conflicts between a requested change and the design doc instead of silently
  picking one.
- Simulation logic must stay in the headless core package — pure TS, no React/Pixi
  imports, fully unit-testable. Online ticking and offline catch-up share one math
  core; never fork the math.
- No codebase yet beyond docs. Update this section (layout, commands, conventions)
  once the workspace is scaffolded.
