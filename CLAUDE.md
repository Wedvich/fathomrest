# CLAUDE.md

Browser-based hybrid idle/active game: resource extraction across an archipelago,
paced by a research tree. TypeScript, React + PixiJS, headless simulation core.

## Documents

- [DESIGN.md](DESIGN.md) — canonical design record: core loop, economy, research
  tree, technical architecture, vertical-slice milestone. **Read before making any
  design or architecture decision; update it when a decision changes.**
- Future decision docs (ADRs, balancing notes) live in `docs/` — add them to this
  list as they appear.

## Working in this repo

- Design decisions in DESIGN.md are settled unless the user reopens them. Flag
  conflicts between a requested change and the design doc instead of silently
  picking one.
- Simulation logic must stay in the headless core package — pure TS, no React/Pixi
  imports, fully unit-testable. Online ticking and offline catch-up share one math
  core; never fork the math.
- No codebase yet beyond docs. Update this section (layout, commands, conventions)
  once the workspace is scaffolded.
