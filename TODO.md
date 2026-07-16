# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**World content upgrades in `restoreWorld`.** Restored saves now receive new _content_
(not just state migrations) without a reset. All in `packages/app/src/sim/world.ts`.

- `SavedWorld` gains optional `contentVersion` (absent → treated as `1`); `DemoWorld`
  carries it and `snapshotWorld` stamps it — `max(saved, WORLD_CONTENT_VERSION)` on
  restore, so a stale service-worker-pinned bundle can never downgrade a newer save's
  version and trick the updated app into re-running steps.
- Upgrade framework: `WORLD_UPGRADES` is an ordered list of
  `(world, t) => DemoWorld` steps expressed through the **normal core command surface**
  (so typing/DAG/determinism invariants are enforced by the commands). `WORLD_CONTENT_VERSION`
  is derived from the list length — adding a step bumps the version by construction.
- `restoreWorld` runs the steps **after** offline catch-up, threading the world through
  each step at `t = state.epoch`, so backfilled structures are wired at the restore-time
  epoch and never retroactively produce across the offline gap.
- First step `upgradeV1AddFoundry` (v1 → v2): backfills the ingot Foundry warehouse + the
  Depot→Foundry converter (mirrors `createDemoWorld`) and appends the `Foundry` label.
  Idempotent: no-ops when a `Foundry` label already exists (saves from 82bdbc0 itself
  predate the version stamp but already carry the content). A missing `Depot` label skips
  converter wiring but still advances the version.
- Hardened after adversarial review: `contentVersion` is validated at the restore
  boundary (non-integer or < 1 throws into the existing quarantine path — no busy-loop,
  no silent step-skipping); each step runs in try/catch, so a failing command logs and
  degrades to missing content instead of quarantining (= resetting) a working save.
- Persistence unchanged: save-on-command/interval in `PixiReadout` re-stamps the upgraded
  envelope (now carrying the new `contentVersion`) shortly after boot; the epoch
  write-guard is satisfied since upgrade commands only advance epoch forward.
- Tests (`world.test.ts`): pre-refinement save upgrades on restore (Foundry appears,
  converter produces, re-snapshot stamps current version), idempotence across a
  restore→snapshot→restore round-trip, a current-version save left untouched, no
  duplication on a version-stamp-less 82bdbc0 save, corrupt `contentVersion` rejection,
  newer-version preservation, and a failing step degrading instead of throwing.

`typecheck | lint | format | test` green (83 tests), production build clean.

**Every future demo-world content change must ship with a new `WORLD_UPGRADES` step**
(and the version bump follows for free from the list length).

The handoff doc `HANDOFF-world-content-upgrade.md` (untracked, in the main checkout root)
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
