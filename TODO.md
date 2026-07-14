# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Next session

Scaffold the workspace and build the sim core's spine (per
[ADR-0001](docs/adr-0001-game-loop-and-state-model.md)):

- Workspace: Vite, strict TS (ESM), Vitest. Decide layout — single package vs
  workspaces; sim core must be importable with zero React/Pixi deps either way.
- Core spine: event queue with deterministic same-time tiebreak, `advance(t)` /
  `query(t)`, wall-clock anchor + `performance.now` delta clock, seeded PRNG in
  the state document.
- First test written before mechanics: determinism — `advance(3 days)` ≡ the same
  span as thousands of small advances.
- Toy chain to exercise it all: one extractor → warehouse fill event → saturation
  regime (pinned at cap, throttled rates).
- Update CLAUDE.md's "Working in this repo" with layout/commands once scaffolded
  (it asks for this).
