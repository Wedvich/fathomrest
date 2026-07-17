# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Adversarial review of the refinement-tier commits (`247be49` + `03bbf79`) + fixes.**
Nine verified findings (six confirmed, three plausible); eight fixed, one skipped:

- **t=0 soft-lock (the big one):** iron builds (20 wood + 20 stone) were affordable from the
  30/30 seed, so building the refinery (or iron-ore extractor) first stranded the player at
  10/10 with zero wood/stone income — permanently. Fixed by `IRON_BUILD_COST = 40` (> seed):
  both base extractors must be running before any iron build is affordable. This also made
  the DESIGN.md/world.ts "gates behind a base-economy surplus" claim true (it was false —
  the conventions finding); DESIGN.md wording updated. Pinned by a gating scenario test.
- **Upgrade-step version stamping:** `restoreWorld` stamped `contentVersion` to current
  _before_ running `WORLD_UPGRADES`, so a throwing step re-persisted at v2 with no iron
  content — permanent loss, contradicting the "recoverable" comment. Now stamped per
  successful step; a failing step keeps the version where it was, skips the remaining steps,
  and is retried on the next restore. Test: a sabotaged v1 save (pre-existing home iron-ore
  pool) stays at v1.
- **Envelope validation:** `restoreWorld` now resolves every core id the envelope carries
  (deposit ids/pools, converter-site pools) so a dangling id fails loud into the quarantine
  path instead of crashing the readout on every reload (was also a pre-existing gap for
  deposits).
- **Typed build failure:** new core `InsufficientStockError` thrown by `debitCost`; the
  world-layer `buildExtractor`/`buildConverter` catch only it and rethrow structural errors
  (single-island violation, DAG cycle, bad cap/ratio) instead of mislabeling them
  "insufficient stock". Tests pin both the typed throw and the propagation.
- **UI dedup:** the deposit and converter build-button loops in `PixiReadout` collapsed into
  one `addBuildButton` helper (isBuilt/build thunks + labels); converter label no longer
  hardcodes "Build refinery" (was "Build refinery · Iron Refinery"; now derives from
  `site.label`).
- **Documented limit:** the (src, dst) pool pair is a `ConverterSite`'s identity — at most
  one site per pair; a second recipe on the same pair needs a real site id first (comment on
  `ConverterSite`).
- **Skipped (deliberate):** `buildConverter` duplicating `addConverter`'s 3-line placement
  tail — same symmetric convention as `buildExtractor`/`addExtractor`, extraction not worth
  the churn. Refuted by the repo's own docs, not fixed: per-frame `isConverterBuilt` scan and
  `canAffordBuild` island lookup (browser-performance.md's don't-optimize-unprofiled rule),
  cap/ratio persisted per site (established envelope pattern, same as `Deposit.rate`).

`typecheck | lint | format | build | test` green (101 tests). **Not live-driven this
session** — the PixiReadout button refactor is typechecked and built but the buttons
haven't been clicked in a browser since the dedup; worth a quick drive next session.

## Done this session

**UI drive of the refactored build buttons — done + verified.** Confirmed the extractor and
refinery build buttons flip/disable correctly in the live app, and that the refinery stays
disabled at t=0 until the base economy accumulates 40/40. Closes the "not live-driven"
gap left by the PixiReadout button refactor.

## Next session

**Focus stays single-island. Inter-island (buildable routes) still deferred.**

1. **Storage buildings / capacity command** (deferred from the pool refactor): pool caps are
   authored constants today. A placeable storage building that raises a pool's capacity is the
   "pool + capacity buildings" model the grill settled on — fold into the costed-builds layer.
   Now more pressing: with the refinery capping iron-ingot at 100 and no on-island sink beyond
   it, the ingot pool jams — capacity/consumption is the next real depth lever.
2. **Research track** (grilled 2026-07-17, settled in DESIGN.md "Progression"): knowledge
   as the first global-scoped resource (global capped pool, observatory extractor on a
   knowledge deposit) → timed research queue (depth 2, paid at enqueue) → thin unlock tree.
3. **Island XP + skill tree**: throughput-fed XP accumulator (own stored quantity), levels,
   trunk + Extraction/Refinement branches; junction research-gated; nodes instant, paid in
   island-local resources.
4. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency.

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
