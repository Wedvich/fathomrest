# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Resource typing — the upstream unblocker.** Warehouses and deposits are no longer
untyped "stuff"; each carries a single resource type. Refinement and resource-costed
building now have their prerequisite.

- New `packages/core/src/resource.ts`: `ResourceType` — a branded string (like `Id`),
  opaque to the core. The core stores and compares tags for equality but knows no fixed
  resource set; resources are authored content in the app layer (DESIGN.md: procedural
  islands). `resourceType(value)` is the mint/rehydrate site. Exported from `index.ts`.
- `Deposit` and `Warehouse` each gain a `resource: ResourceType` field; their factories
  (`createDeposit`, `createWarehouse`) take it first. Commands `addDeposit` and
  `addWarehouse` take `resource` after `t`.
- **Type-match enforced at the boundaries:**
  - `addExtractor` — the deposit's resource must equal the target warehouse's; throws
    `resource mismatch` otherwise.
  - `addRoute` — source and destination resources must match (a route moves one type;
    type conversion is refinement's job).
  - `serialize.ts` mirrors both invariants at the import boundary for hand-edited saves,
    plus a non-empty-string check on every `resource` tag. `checkTable` now passes the
    entry id to its component checker so cross-table resource lookups work.
- **The flow solver is untouched.** No route crosses types, so each connected component
  of the route DAG is monochromatic — the solver stays per-type by construction. Every
  quantity remains a scalar closed form (analytic litmus holds, ADR-0001 §2).
- App demo world (`packages/app/src/sim/world.ts`): the ore chain (Pier → Depot route)
  is `ore`; the Quarry build site is `stone`. Exercises typing end-to-end. `SavedWorld`
  envelope is unchanged (resource rides inside the core `SaveDocument`).
- Tests: new `resource typing` scenarios in `sim.test.ts` (extractor + route mismatch
  rejected) and import-boundary cases in `serialize.test.ts` (empty tag, extractor
  deposit/warehouse mismatch, route type mismatch). All existing scenarios updated for
  the new `resource` arg.

`typecheck | lint | format | test` all green (59 tests). Production build clean.

Note: resource type is not yet surfaced in the readout UI — the Pixi rows still label by
warehouse/deposit name only. Optional polish; add it when refinement makes types
player-relevant.

## Next session

Both pillars below are now unblocked by resource typing (litmus-test each against
ADR-0001 §2 first):

1. **Refinement** — a converter component: consumes type A from one warehouse at a rate,
   produces type B into another. Couples two warehouse regimes much like a route, so it
   should ride the same derive/solve path (settle its throughput against source supply
   and destination acceptance, then schedule crossings). Keep the math per-type and
   closed-form; the converter's rate is stepwise-constant between events.

2. **Building pillar** — fixed slots, placement cost (now expressible: deduct typed
   resources from warehouses on build), siting/adjacency. This is where the current thin
   `buildExtractor` app command grows into a real cost-gated build layer.

Engine follow-ups (do when they start to matter):

- `removeRoute` (and warehouse/extractor/deposit deletion generally) — needed once the UI
  lets players tear down structures. One table-deletion function per module (perf doc:
  deletion through one function) and a `deriveAll` after.
- `solveRoutes` rebuilds adjacency + topo order and re-solves the whole graph every
  event/command (global O(N+R)). Fine at design scale; the natural place for targeted
  downstream invalidation if a profile ever shows it.
- Stale events linger in the heap until their time passes (lazy deletion); the serializer
  filters them. Consider periodic compaction only if heap size ever matters during very
  long offline spans.

Heads-up: the working tree has unrelated **PWA integration** changes in flight
(`vite-plugin-pwa`, `workbox-window`, `UpdatePrompt.tsx`, `vite-env.d.ts`, app
`package.json`/`vite.config.ts`, `bun.lock`) that predate this session and are not part of
resource typing — keep them out of the resource-typing commit.
