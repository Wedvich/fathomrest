# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**One pool per (island, resource).** Fixed the "Wood A / Wood B / Stone A / Stone B" readout:
each resource now has a single warehouse (pool) per island, so two wood extractors fill one
Wood bar faster instead of two bars in parallel. This is a **hard core invariant**, not just
demo-world authoring (chosen over "convention only" knowing the cost below).

Core (`packages/core`):

- `sim.ts addWarehouse` rejects a second warehouse for an existing `(island, resource)` pair;
  `serialize.ts validateDocument` re-checks it on import (NUL-joined pair set).
- `islandPayers` (proportional multi-warehouse debit spread) **removed** — replaced by
  `islandWarehouse` returning the single pool. `debitCost`/`canAffordBuild` now resolve each
  cost resource to one pool. The proportional-spread feature is gone (was vacuous under the
  invariant); ADR-0001 §Island grouping / §Resource-costed building updated to match.
- No `SAVE_VERSION` bump: pre-pool saves carry duplicate `(island, resource)` pairs and fail
  the new import check, so the existing restore→quarantine path resets them. Recorded in
  DESIGN.md as the **second** blessed one-time reset exception (pre-release only).

App (`packages/app/src/sim/world.ts`):

- `createDemoWorld` mints one Wood pool + one Stone pool on `home`; all four veins feed their
  resource's pool. `warehouses` view model is now `[Wood, Stone]`. Cap 100, stock 30, cost 20
  (placeholder). No `restoreWorld`/readout code changes needed — both are thin maps over the
  view model.

**Consequence baked into the design**: a same-type route is now necessarily **inter-island**
(one pool per island per resource, routes connect same types). Route/hub/chain test fixtures
in `sim.test.ts`/`serialize.test.ts` place same-typed warehouses on distinct islands (`I/J/K`)
purely to satisfy the invariant — the solver still ignores island tags.

`typecheck | lint | format | test` green (87 tests). Drove `createDemoWorld` at runtime:
2 warehouse bars + 4 deposit bars, both wood veins share one pool, Wood fills at 4/s with two
extractors. Not committed yet.

## Next session

1. **Make routes and converters buildable/costed through the same layer** — extend the
   `Deposit`-style cost-gated build to routes and converters (needs `addRoute`/`addConverter`
   fronted by a build command that debits, mirroring `buildExtractor`). Still the natural next
   increment: built pools cap out and jam with no consumer. Note routes are now inter-island by
   construction, so buildable routes are the mechanism for networking island pools.
2. **Storage buildings / capacity command** (deferred from the pool refactor): pool caps are
   authored constants today. A placeable storage building that raises a pool's capacity is the
   "pool + capacity buildings" model the grill settled on — fold into the costed-builds layer.
3. **Re-introduce refinement** as a tier layered on wood/stone (the deferred half of the
   pivot). Ships as the first new `WORLD_UPGRADES` step (+ version bump) per the standing rule.
4. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.

Engine follow-ups (do when they start to matter):

- `removeExtractor` / `removeRoute` / `removeConverter` (entity deletion generally) — needed
  once the UI lets players tear down structures. One table-deletion function per module and a
  `deriveAll` after.
- Multi-input (Leontief) recipes (`iron + coal → steel`) are **explicitly deferred**: they
  turn 2-endpoint edges into fixed-proportion nodes and break the clean ≤ 2·N sweep proof.
  ADR-first effort, only after single-input refinement is proven in play.
- `solveTransfers` rebuilds adjacency + topo order and re-solves the whole graph every
  event/command (global O(N+E)). Fine at design scale; the natural place for targeted
  invalidation if a profile ever shows it.
- Stale events linger in the heap until their time passes (lazy deletion); the serializer
  filters them. Consider periodic compaction only if heap size ever matters during very
  long offline spans.
