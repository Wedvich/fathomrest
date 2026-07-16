# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Firefox save-reset hardening.** Investigated the resets ae4ab0f didn't fix
(user-confirmed gone afterward). Findings from driving Firefox via Playwright against
the dev server:

- Firefox aborts **every** IndexedDB write issued from `pagehide` — even a synchronous
  transaction+put on the already-open connection. Teardown saves are a WebKit-only best
  effort; in Firefox only the interval autosave and save-on-command persist. (The wall
  gap is recovered by offline catch-up, so at most ~15s of *commands* is at risk.)
- The storage layer itself was robust in a clean Firefox profile (~90 reload cycles,
  rapid sub-second reloads, full browser quit/relaunch — no reset, even with the
  pre-fix build), so the defenses now live at the write sink:
- `persistence.ts`: **epoch write-guard** — `writeSavedWorld` refuses (warns + skips) a
  document whose epoch is lower than the stored save's, so no stale writer (second tab,
  SW-pinned old bundle, fresh world racing a real save) can clobber progress.
  `quarantineCorruptSave` moves an unrestorable save to a `corrupt-backup` key instead
  of destroying it. A localStorage **breadcrumb** (epoch + wallTime, written on each
  successful save) lets boot distinguish "never saved" from "save existed and was lost".
  `ensurePersistentStorage()` requests persistent storage to opt out of quota eviction.
- `PixiReadout.tsx`: restore-failure path quarantines the save and logs loudly; an
  absent save with a breadcrumb present is reported as external storage loss.

All four paths verified end-to-end in Playwright Firefox (normal grow, guard skip,
quarantine + resume, breadcrumb report). `typecheck | lint | format | test` green
(66 tests).

Note: `packages/app/dist/` predates ae4ab0f — rebuild before serving it anywhere; the
PWA service worker pins old bundles until the update prompt is accepted.

## Next session

Both pillars below are unblocked by resource typing (litmus-test each against
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
