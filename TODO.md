# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

Sim core spine built in `packages/core` per ADR-0001 (branch `sim-core-spine`):
branded ids, `SimState` document (EC `Map` tables + PRNG + event queue + clocks),
sfc32 PRNG, clock helpers, per-table accessor boundary, binary min-heap event queue
with seq-based lazy staleness, `advance(t)`/pure queries, and the shared
`Map ↔ [id, component][]` serializer. Toy extractor → warehouse chain exercises the
piecewise regimes (tracking / pinned-full / pinned-empty) and event rescheduling.
Determinism test passes bit-identically (one 3-day advance ≡ 10 000 or 3 333 small
advances, with mid-run commands). `typecheck | test | lint | build` all green.

## Next session — first real mechanics slice

Per DESIGN.md (don't start a mechanic before it passes the ADR-0001 §2 litmus test):

1. **Deposits** with depletion-to-floor curves feeding extractors; full warehouse
   pauses depletion (extend the pinned-full regime to throttle deposit draw).
   Watch the float-determinism caveat if the curve needs transcendentals
   (docs/browser-performance.md) — prefer arithmetic-closed forms.
2. **Transport routes** as instant rate-capped flows between warehouses. This makes
   inflow/outflow a small dependency graph — generalize `deriveWarehouseRegime`'s
   rederive-on-change into rate re-derivation across connected entities.
3. **App wiring**: rAF loop → `advance(t)`/`query(t)` → a placeholder Pixi readout
   once the core surface feels stable. Replace the static demo in `App.tsx`.

Engine follow-ups deferred from the spine (do when they start to matter):

- oxlint rule banning `Math.random` in core (ADR-0001 §5 says enforce by lint).
- Event dispatch currently assumes all events target warehouses
  (`isStaleEvent`/`handleEvent` in `sim.ts`) — generalize when a second
  event-bearing table appears.
- Commands re-derive only the directly-touched warehouse; routes (step 2) will need
  downstream invalidation.
