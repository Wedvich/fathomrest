# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**First player command — build extractor → income appears.** The readout is no longer
display-only; the loop UI → core command → persist → re-derive on reload is closed.

- `packages/app/src/sim/world.ts`:
  - `createDemoWorld` now seeds an **unworked** vein (`graniteDeposit`) + an idle
    `Quarry` warehouse with **no extractor** — the build target. Quarry sits at zero
    until built.
  - New `BuildSite` (`{ depositId, warehouseId }`) carried on `DemoWorld` and persisted
    in the `SavedWorld` envelope. It's app-level metadata: the target warehouse has no
    producer until built, so it can't be re-derived from core state.
  - `buildExtractor(world, t)` — the command: `addExtractor` at sim time `t` (the core
    command advances to `t` first, so income begins exactly at `t`). Idempotent via
    `isExtractorBuilt` (scans extractors for one on the build deposit). Thin add — no
    cost/slots/adjacency; that's the separate "Building" pillar, still gated on resource
    typing.
  - New `deposits` view model (id + label), carried on `DemoWorld` and persisted in
    `SavedWorld` alongside warehouse labels — the readout now surfaces deposit levels.
- `PixiReadout.tsx`:
  - "Build extractor on Quarry" button. Click calls into `buildRef` (bridges React →
    the effect closure holding the sim clock/world), then **saves immediately**
    (save-on-command). Button disabled once built; disabled state seeded from
    `isExtractorBuilt` on load so it survives reload.
  - **Deposit levels in the readout.** Row rendering refactored into a shared `makeBar`
    + per-row `update(t)` closure (memoizes last frac/text; frame loop untouched unless a
    value moved). Warehouse bars fill toward capacity (blue); deposit bars drain their
    reserve (sum of tier amounts) toward the floor (amber), showing remaining + current
    `×multiplier`. Makes the rich-phase→floor decay visible.
  - Load path guards stale saves: `"deposits" in saved` (newest envelope field) — a save
    predating the current schema falls back to a fresh world (saves are unversioned
    pre-release, ADR-0001 §8).
- `packages/app/src/sim/world.test.ts` (new) — scenario coverage through the public
  world API: Quarry idle pre-build; building starts income from the command time;
  idempotent double-build; and survives a `snapshotWorld`→`structuredClone`→`restoreWorld`
  round-trip (deposits view model included; structuredClone stands in for IndexedDB, as
  in `persistence.ts`).

`typecheck | lint | format | test` all green (54 tests). Production build clean.

Note on the demo topology (came up while testing): Pier has two independent drains — the
route to Depot (subject to backpressure: a full Depot throttles the incoming route to 0)
**and** a local pull of 3/s (unrelated to Depot). Pier only visibly drains once the Ore
vein hits its floor (×2 → ×0.5, extractor output falls below the 3/s local pull) — now
observable via the deposit bars. Route backpressure is working; the drain is depletion.

**Pagehide race — resolved for commands.** The build command saves synchronously on
click (save-on-command), so a dropped async pagehide save no longer loses the action:
worst case the next load recomputes the _same_ built state. The 15s autosave + lifecycle
saves remain the backstop for time-only drift. Any _future_ mutating command must follow
the same save-on-command pattern.

## Next session

Per DESIGN.md (litmus-test each new mechanic against ADR-0001 §2 first):

1. **Resource typing** — the upstream unblocker. Warehouses currently store an untyped
   scalar; everything is fungible "stuff". Typed inventories are the prerequisite for
   both **refinement** (raw → refined, the milestone's one tier) and a _real_ build layer
   (buildings "cost resources"). This is a core-package change (warehouse/extractor/route
   all move typed quantities) — design it deliberately and check the analytic litmus
   (per-type closed-form amounts; the flow solver stays per-type).

2. Then either **refinement** (a converter component: consumes type A at a rate, produces
   type B — couples two warehouse regimes much like a route) or the **Building pillar**
   (fixed slots, placement cost, siting/adjacency). Both depend on step 1.

Engine follow-ups (do when they start to matter):

- `removeRoute` (and warehouse/extractor deletion generally) — needed once the UI lets
  players tear down structures. Add a single table-deletion function per module (perf
  doc: deletion through one function) and a `deriveAll` after.
- `solveRoutes` rebuilds adjacency + topo order and re-solves the whole graph every
  event/command (global O(N+R)). Fine at design scale; the natural place for targeted
  downstream invalidation if a profile ever shows it.
- Stale events linger in the heap until their time passes (lazy deletion); the
  serializer filters them. Consider periodic compaction only if heap size ever matters
  during very long offline spans.
