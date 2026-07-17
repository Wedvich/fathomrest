# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Buildable converters + the first refinement tier (iron-ore → iron-ingot). Two commits.**

- **Commit 1 (engine, `247be49`):** `buildConverter` fronting `addConverter`, mirroring
  `buildExtractor` — validate → advance → `debitCost` from the shared island pool → place →
  `deriveAll`, atomically at `t`. Adds a single-island assertion (both endpoints must share
  an island, checked before any mutation) and charges the cost against that island's pool.
  Extracted `checkConverterWiring` shared by `addConverter`/`buildConverter`. No save-version
  bump. Two scenario tests (debit-and-wire happy path; cross-island rejection is atomic).
- **Commit 2 (content, `03bbf79`):** iron-ore worked by two cost-gated deposits, refined to
  iron-ingot by the converter — iron-ore extractor and refinery both paid in wood/stone.
  New `ConverterSite` envelope model (built-state derived from a live converter's (src, dst)
  pair via `isConverterBuilt`); `buildConverter` world wrapper; a `PixiReadout` build button
  mirroring the deposit buttons. First real `WORLD_UPGRADES` step (v1→v2 injects the iron
  tier into pre-iron saves) + `WORLD_CONTENT_VERSION` bump. DESIGN.md updated (refinement no
  longer "deferred"). Live UI driven end-to-end (build button flips, stock debits, iron-ore
  extractor gates correctly); `typecheck | lint | format | build | test` green (96 tests).

## Next session

**Focus stays single-island. Inter-island (buildable routes) still deferred.**

1. **Refinery affordability tuning (small, flagged during the UI drive):** the refinery is
   affordable at t=0 from the 30/30 starting stock (costs 20 wood + 20 stone), so it can be
   built before any iron-ore extractor exists — the "gates behind a base-economy surplus"
   intent only bites on the *second* iron build. If we want the refinery itself gated, raise
   its cost or require iron-ore in the recipe. Placeholder tuning — playtest territory.
2. **Storage buildings / capacity command** (deferred from the pool refactor): pool caps are
   authored constants today. A placeable storage building that raises a pool's capacity is the
   "pool + capacity buildings" model the grill settled on — fold into the costed-builds layer.
   Now more pressing: with the refinery capping iron-ingot at 100 and no on-island sink beyond
   it, the ingot pool jams — capacity/consumption is the next real depth lever.
3. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) —
the mechanism for networking island pools. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.

Engine follow-ups (do when they start to matter):

- `removeExtractor` / `removeRoute` / `removeConverter` (entity deletion generally) — needed
  once the UI lets players tear down structures. Converters are now buildable, so a
  `removeConverter` is the first one players will reach for. One table-deletion function per
  module and a `deriveAll` after.
- Multi-input (Leontief) recipes (`iron + coal → steel`) are **explicitly deferred**: they
  turn 2-endpoint edges into fixed-proportion nodes and break the clean ≤ 2·N sweep proof.
  ADR-first effort, only after single-input refinement is proven in play.
- `solveTransfers` rebuilds adjacency + topo order and re-solves the whole graph every
  event/command (global O(N+E)). Fine at design scale; the natural place for targeted
  invalidation if a profile ever shows it.
- Stale events linger in the heap until their time passes (lazy deletion); the serializer
  filters them. Consider periodic compaction only if heap size ever matters during very
  long offline spans.
