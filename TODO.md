# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Building pillar + wood/stone bootstrap economy.** The demo world is now a real building
loop: it boots with a seeded stockpile and **no extractors**, and the early game is building
extractors on deposits, gated by cross-resource costs.

Core (`packages/core/src/sim.ts`, exported via `index.ts`):

- `grantResource(state, t, warehouseId, amount)` — seed stock straight into a warehouse
  (no producer needed), capped at capacity. Backs the starting stockpile; also the future
  hook for rewards/gifts.
- `canAffordBuild(state, t, island, cost)` — read-only affordability query mirroring
  `debitCost`'s whole-vector precondition. The shared per-resource island sum is factored
  into `islandPayers`, so the check and the debit can't drift. Used to drive the build
  buttons' disabled state.

App (`packages/app/src/sim/world.ts`):

- `createDemoWorld` rewritten to wood + stone. 4 deposits (2 wood, 2 stone), each with its
  own empty target warehouse and **no extractor**; the two "A" warehouses seeded with 30
  each. Extractor rate 1/s; warehouse cap 100; build cost 20 of the _other_ resource
  (all placeholder tuning). Removed the old ore/ingot/Foundry converter and Pier→Depot route.
- **Ubiquitous language**: the old `BuildSite` type is folded into a richer app-level
  `Deposit` (id, warehouseId, label, resource, cost, rate) — a deposit _is_ a build site.
  `isExtractorBuilt`/`buildExtractor` are now per-deposit.
- **One-time save reset**: legacy ore/ingot envelopes carried a singular `buildSite`;
  `restoreWorld` throws on its presence, routing old saves through the existing quarantine
  path (blessed exception to the no-reset rule — pre-release placeholder content).
  `WORLD_UPGRADES` reset to `[]`, `WORLD_CONTENT_VERSION` back to 1; the content-upgrade
  framework itself is retained for future changes.

UI (`packages/app/src/PixiReadout.tsx`): one build button per deposit, created imperatively
so the React tree stays static; each button's disabled state and label are driven from the
Pixi ticker via `canAffordBuild` + `isExtractorBuilt` (cost Map and island cached per button
— no per-frame allocation). Build-on-click still does save-on-command.

`typecheck | lint | format | test` green (85 tests). Verify the app run + production build
before handing off.

## Next session

1. **Make routes and converters buildable/costed through the same layer** — extend the
   `Deposit`-style cost-gated build to routes and converters (needs `addRoute`/`addConverter`
   fronted by a build command that debits, mirroring `buildExtractor`). This is the natural
   next increment: right now built warehouses cap out and jam with no consumer, which is the
   motivation for buildable routes/converters.
2. **Re-introduce refinement** as a tier layered on wood/stone (the deferred half of the
   pivot). Ships as the first new `WORLD_UPGRADES` step (+ version bump) per the standing rule.
3. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency — this
   session did cost-gating only.

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
