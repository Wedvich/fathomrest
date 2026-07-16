# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Refinement — the single-input converter (A → B).** The first refinement tier from the
vertical slice is in: a `Converter` consumes resource A from one warehouse and produces
B = `ratio · A` into another, riding the existing flow solver as a ratio-scaled transfer
edge.

- New `packages/core/src/components/converter.ts`: `Converter { srcId, dstId, cap,
ratio, flow }` — `cap` is the player-set max draw (A-units/sec), `ratio` (> 0) the B
  produced per A consumed, `flow` the cached realized draw (feed = `flow · ratio`).
  Table accessors mirror `route.ts`; `converters` table added to `SimState`.
- **Solver generalized:** `solveRoutes` → `solveTransfers` over transfer edges =
  routes ∪ converters (routes first, then converters, both table order). Edge allowances
  (`srcCap`/`dstCap`) stay in **source units** for every edge; `ratio` applies only at
  the destination-side water-fill (multiply in, divide out). Routes are the `ratio = 1`
  special case — bit-identical to the old solver (all 66 pre-existing tests pass
  untouched). Convergence proof unchanged; combined graph is one DAG (ADR-0001 §route
  solver updated).
- **Command** `addConverter(state, t, srcId, dstId, cap, ratio)`: rejects self-loops,
  non-finite/non-positive ratio, bad cap, **same-resource endpoints** (refinement must
  change type — a same-type converter would be a lossy/gainy route), and any cycle over
  the combined route+converter graph (`assertTransfersAcyclic`, shared with `addRoute`).
  Queries: `converterDraw` (A-units) / `converterFeed` (B-units).
- **Serialization:** `SAVE_VERSION` 2 → 3; `converters` table in `SaveDocument`; import
  validation mirrors every command invariant (dangling ids, self-loop, same-resource,
  ratio > 0, combined-graph acyclicity via `checkTransfersAcyclic`). `migrateDocument`
  now chains v1 → v2 (island backfill) → v3 (empty converter table), preserving idle
  progress.
- **App demo world:** Depot (ore) → converter (2 ore/s, ratio 0.5) → Foundry (ingot,
  new warehouse row in the Pixi readout).
- **Tests:** converter scenarios in `sim.test.ts` (cap+ratio happy path, backpressure
  throttling in source units, water-fill split of a starved source between a route and a
  converter, cross-type cycle rejection, boundary validation); serialize round-trip,
  import rejections, combined-cycle rejection, v2→v3 migration; the route determinism
  scenario now includes a converter tail and still replays bit-identically.

`typecheck | lint | format | test` green (76 tests), production build clean.

The handoff doc `HANDOFF-refinement-converter.md` (untracked, in the main checkout root)
is implemented by this session — **delete it once this branch lands on `main`**.

## Next session

1. **Building pillar** — fixed slots, siting/adjacency, and growing the thin app-level
   `buildExtractor` into a real cost-gated build layer (DESIGN.md active half). Converters
   and routes should become buildable/costed through the same layer.
2. **Surface refinement in the UI** — the Foundry bar renders, but there's no converter
   rate readout or player control. Needs a `setConverterCap` command in core (mirror
   `setRouteCap` — trivial now that the solver is unified) when the UI grows the control.

Carried over from the Firefox persistence session (dc52b82): the PWA service worker pins
old bundles until the update prompt is accepted — rebuild `packages/app/dist/` before
serving it anywhere.

Engine follow-ups (do when they start to matter):

- `removeRoute` / `removeConverter` (and entity deletion generally) — needed once the UI
  lets players tear down structures. One table-deletion function per module and a
  `deriveAll` after.
- Multi-input (Leontief) recipes (`iron + coal → steel`) are **explicitly deferred**:
  they turn 2-endpoint edges into fixed-proportion nodes and break the clean ≤ 2·N sweep
  proof. ADR-first effort, only after single-input refinement is proven in play.
- `solveTransfers` rebuilds adjacency + topo order and re-solves the whole graph every
  event/command (global O(N+E)). Fine at design scale; the natural place for targeted
  invalidation if a profile ever shows it.
- Stale events linger in the heap until their time passes (lazy deletion); the serializer
  filters them. Consider periodic compaction only if heap size ever matters during very
  long offline spans.
