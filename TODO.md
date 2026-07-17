# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Adversarial review of the pool-refactor commit (8293414) + fixes.** Eight verified
findings, all fixed:

- `serialize.ts` pool-invariant check: the NUL-joined pair-key `Set` embedded a literal NUL
  byte in source (git classified the file as binary — unreviewable diffs) and wasn't
  collision-proof anyway. Replaced with a nested `Map<island, Set<resource>>` — no joined
  key at all. File is text again; the commit boundary itself still diffs as `Bin` because
  the pre-fix blob is binary, but everything after is textual.
- `addWarehouse`/`addDeposit` now reject an empty resource tag — previously a command-legal
  state failed its own import round-trip (`checkTag`) and got quarantined. `resource.ts`'s
  "enforced at the command boundary" claim is now true.
- `islandWarehouse`: dropped the stale islandPayers "table order keeps replay bit-identical"
  comment; direct `values()` loop + early return (no closure on the frame path via
  `canAffordBuild`). Deliberately **no** (island, resource) index in `SimState` — conflicts
  with "state shape IS the serialization shape" and the perf doc's don't-optimize-unprofiled
  rule; revisit if a profile flags it.
- Extracted `availableForBuild` shared by `debitCost` + `canAffordBuild`, restoring the
  can't-drift guarantee the deleted `islandPayers` comment promised.
- v1 migration: the island backfill now collides with the pool invariant for any routed v1
  save (route endpoints share a resource) → quarantine under the blessed pre-pool reset;
  ADR-0001's "preserves idle progress" sentence corrected, behavior pinned by a test.
- New coverage: two extractors on one pool fill it at the summed rate (the refactor's
  headline behavior — previously an `inflow = rate` regression would have passed the suite),
  plus empty-tag command-boundary rejections.

`typecheck | lint | format | test` green (90 tests).

## Next session

**Focus: single island first. Inter-island work is deferred** — including buildable
routes, since a same-resource route is now inter-island by construction (one pool per
island per resource). Routes as a mechanic already work (`addRoute`, solver, DAG
constraint); only the buildable/costed wrapper is missing, and that waits until we
take on island networking.

1. **Buildable converters + refinement** (one increment, two commits) — a converter
   changes resource *type*, so it's meaningless until there's a refined resource to
   produce; the mechanism and the content ship together. Converters are single-island
   (both endpoints on one island), so they're the on-island consumer that keeps built
   pools from capping out and jamming. (`buildRoute` deferred with the rest of inter-island.)
   - **Commit 1 (engine):** `buildConverter` fronting `addConverter`, mirroring
     `buildExtractor` (debit `cost` from the shared island pool, then place, atomically at
     `t`; assert src/dst share an island). Add a scenario test. No save-version bump.
   - **Commit 2 (content):** re-introduce refinement as a tier on wood/stone — a refined
     resource B, its pool wired into `createDemoWorld`, the converter recipe (`ratio`/`cap`
     defaults). Ships as the first new `WORLD_UPGRADES` step + save-version bump per the
     standing rule.
2. **Storage buildings / capacity command** (deferred from the pool refactor): pool caps are
   authored constants today. A placeable storage building that raises a pool's capacity is the
   "pool + capacity buildings" model the grill settled on — fold into the costed-builds layer.
3. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) —
the mechanism for networking island pools. Pick up once single-island depth is proven.

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
