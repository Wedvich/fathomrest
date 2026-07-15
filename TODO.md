# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Transport routes**, now review-hardened — instant rate-capped flows between warehouses,
on branch `routes` (not yet merged; rebase + `merge --ff-only` when ready). General DAG
with hubs (fan-in/fan-out), passing the ADR-0001 §2 litmus test.

Adversarial `/code-review` pass fixed 6 findings on top of the build:

- Import boundary now mirrors the command-boundary sign/range checks (`capacity > 0`,
  `anchorAmount ∈ [0, capacity]`, `pullRate/cap/flow/rate ≥ 0`) — a hand-edited save can
  no longer feed the solver reversed flows or a negative-floor warehouse.
- One shared iterative Kahn helper (`graph.ts topoSort`) replaces three separate DAG
  checkers (recursive-DFS import check, quadratic `routeReaches`, solver
  `topologicalOrder`); no recursion (deep chains can't overflow), O(V+E) cycle check,
  determinism preserved (node order = table order).
- Dropped dead-wire `routeInflow`/`routeOutflow` from `Warehouse` (they were intra-derive
  temporaries); `solveRoutes` now returns them as scratch consumed by `scheduleWarehouse`.
- Removed all `as Id` casts flagged under `noUncheckedIndexedAccess` (iterate `.entries()`
  / element-typed `for…of`); extracted a shared `checkCap`.

The build itself (below) is unchanged; solver math untouched.

- New `Route` component `{ srcId, dstId, cap, flow }` + accessor module; `routes` table
  on `SimState`; `addRoute` / `setRouteCap` commands; `routeFlow` query. Deletion
  deferred (add-only; `setRouteCap(…, 0)` disables). `removeRoute` is the obvious next
  gap when the UI needs it — no table has deletion yet.
- A route couples its source and destination regimes (full dest backs up sources; dry
  source starves dests), so warehouse net rate now depends on neighbours'. Resolved
  within each event/command by `solveRoutes`: alternating topological sweeps + a capped
  proportional **water-filling** split (`allocateCapped`) at each saturated warehouse.
  Converges in ≤ 2·N sweeps (loud guard-throw as canary); no new event kind — routes ride
  the existing warehouse fill/empty crossings. Cycles + self-loops rejected at the
  command **and** import boundaries (the DAG restriction is what keeps the solver bounded
  and deterministic — ADR-0001 §Implementation notes, route solver).
- `deriveAll` restructured: (1) re-anchor + cache extractor inflow, (2) `solveRoutes`,
  (3) schedule crossings, (4) deposits. `extractorEffectiveRate` / `warehouseOutflowRate`
  now read the solver's water-fill levels (`inflowThrottle` / `outflowThrottle`); both
  reduce to the old formulas in the no-routes case, so existing tests are unchanged.
- Serializer: `routes` table with referential-integrity + self-loop + acyclicity + sign
  checks on import. Warehouse caches `inflowThrottle`/`outflowThrottle` (query hot path).
- New integration scenarios (backpressure, starvation, fan-in reflow, un-jam cascade,
  cycle rejection, sign-check rejections) + a coupled-route-network determinism test
  (bit-identical across 1 vs 10 000 advances). `typecheck | test | lint | format` all
  green (46 tests).

## Next session

Per DESIGN.md / TODO step order (litmus-test each new mechanic against ADR-0001 §2 first):

1. **App wiring**: rAF loop → `advance(t)` / `query(t)` → a placeholder Pixi readout once
   the core surface feels stable (it now is: warehouses, deposits, extractors, routes).
   Replace the static demo in `App.tsx`. The app re-stamps `state.wallTime` at save time
   (state.ts contract); offline catch-up is `advance(epoch + offlineElapsedSeconds(...))`.
   The core is UI-agnostic — keep all React/Pixi out of `@fathomrest/core`.

Engine follow-ups (do when they start to matter):

- `removeRoute` (and warehouse/extractor deletion generally) — needed once the UI lets
  players tear down structures. Add a single table-deletion function per module (perf
  doc: deletion through one function) and a `deriveAll` after.
- `solveRoutes` rebuilds adjacency + topo order and re-solves the whole graph every
  event/command (global O(N+R), acyclicity re-checked via Kahn each derive). Fine at
  design scale; the natural place for targeted downstream invalidation if a profile ever
  shows it.
- Stale events still linger in the heap until their time passes (lazy deletion); the
  serializer filters them. Consider periodic compaction only if heap size ever matters
  during very long offline spans.
