# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

Adversarial review of the sim-core spine (branch `sim-core-spine`), then applied all
six surviving findings:

- `advance(t)` rejects non-finite `t` (NaN used to drain the whole event queue).
- `deserializeState` fully validates the untrusted save document (finite fields,
  table shapes, event kinds, referential integrity of entity ids).
- Package index trimmed to the command/query/serialize surface + read accessors;
  mutating internals (table setters, event queue ops, PRNG steppers) are
  package-private so the command layer can't be bypassed.
- Warehouse caches `inflow` at derive time; rate queries are allocation-free O(1)
  again (no table scan in the query path).
- Commands now take the command time `t` and `advance(t)` internally — "commands
  land at the current time" is a mechanism, not a caller convention. ADR-0001
  Commands bullet updated to match.
- `serializeState` copies events, so a save document never aliases live state.

`typecheck | test | lint` all green. Branch not yet merged to `main` (rebase +
`merge --ff-only` when ready).

## Next session — first real mechanics slice

Per DESIGN.md (don't start a mechanic before it passes the ADR-0001 §2 litmus test):

1. **Deposits** with depletion-to-floor curves feeding extractors; full warehouse
   pauses depletion (extend the pinned-full regime to throttle deposit draw).
   Watch the float-determinism caveat if the curve needs transcendentals
   (docs/browser-performance.md) — prefer arithmetic-closed forms.
2. **Transport routes** as instant rate-capped flows between warehouses. This makes
   inflow/outflow a small dependency graph — generalize `deriveWarehouseRegime`'s
   rederive-on-change into rate re-derivation across connected entities. The cached
   `warehouse.inflow` becomes derived graph state here.
3. **App wiring**: rAF loop → `advance(t)`/`query(t)` → a placeholder Pixi readout
   once the core surface feels stable. Replace the static demo in `App.tsx`.
   Remember the app re-stamps `state.wallTime` at save time (state.ts contract).

Engine follow-ups deferred from the spine (do when they start to matter):

- oxlint rule banning `Math.random` in core (ADR-0001 §5 says enforce by lint).
- Event dispatch currently assumes all events target warehouses
  (`isStaleEvent`/`handleEvent` in `sim.ts`) — generalize when a second
  event-bearing table appears; the save-document validator's entityId check
  generalizes with it.
- Commands re-derive only the directly-touched warehouse; routes (step 2) will need
  downstream invalidation.
