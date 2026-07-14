# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

Workspace scaffolded: Bun workspaces, `@fathomrest/core` (pure TS, boundary enforced
by oxlint) + `@fathomrest/app` (React + PixiJS + Vite). TS 7, Vitest, oxlint/oxfmt.
All of `bun run typecheck | test | lint | build` green. Core is a placeholder export —
no sim yet.

## Next session — sim core spine

Build the engine skeleton in `packages/core` (per
[ADR-0001](docs/adr-0001-game-loop-and-state-model.md)). No gameplay mechanics yet;
the toy chain below exists only to exercise the plumbing. Suggested order — each step
builds on the last:

1. **Ids & state document** — branded `Id` type; the `SimState` shape: EC component
   tables (`Map<Id, Component>`), PRNG state, `epoch` (sim seconds) + `wallTime`
   anchor. This type _is_ the serialization shape — design it once here.
2. **Seeded PRNG** — one deterministic generator, state lives in `SimState`.
   `Math.random` banned in core (oxlint rule to enforce later). Unit-test reproducibility.
3. **Clock helpers** — pure functions: `offlineElapsed = max(0, now − wallTime)`;
   never advance backwards. No timers in core (the app owns rAF/visibility).
4. **Table access boundary** — per-table accessor modules (`get`/`set`/`forEach`/`ids`),
   one factory per component for shape stability (all fields set, sentinels not absent).
   No raw `Map` ops at call sites; iteration order owned by the module.
5. **Event queue** — binary min-heap over a preallocated array, `(time, kindPriority,
entityId)` tiebreak; lazy deletion (mark stale, skip on pop) for reschedules.
6. **`advance(t)` / `query(t)`** — `advance` pops & applies due events then reschedules
   affected ones; `query` is a pure read evaluating `f(t)` from the last event's anchor
   (absolute closed form, never incremental accumulation).
7. **Serializer** — `Map` ↔ `[id, component][]` codec, one function shared by
   export/import (and future cloud sync); round-trip test.

Prove it (test-first — write the determinism test before any mechanic):

- **Determinism**: `advance(3 days)` ≡ the same span done as thousands of small
  advances — bit-identical state. This is the load-bearing invariant (ADR §5, §8).
- **Toy chain**: one extractor → warehouse fill event → saturation regime (warehouse
  pinned at cap, producer throttled to consumer pull rate). Validates the piecewise
  regime model and event rescheduling, not just the plumbing.

## After the spine (don't start until the above is green)

First real mechanics slice: deposits with depletion-to-floor curves, transport routes
as instant rate-capped flows. Each must pass the ADR §2 litmus test before coding.
Wire the app's rAF loop → `advance`/`query` → a placeholder Pixi readout once the
core exposes a stable surface.
