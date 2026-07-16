# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Persistence loop** — the demo world now survives reload with offline catch-up.

- `packages/app/src/persistence.ts` (new) — IndexedDB layer (never localStorage: it's
  synchronous). One record holds the save envelope; DB opened per op (writes are
  infrequent, nothing leaks). Structured clone stores the envelope's plain arrays/objects
  directly — no JSON step.
- `packages/app/src/sim/world.ts` — added the `SavedWorld` envelope (core `SaveDocument`
  + the UI label view model the core doesn't carry). `snapshotWorld` = `serializeState` +
  labels; `restoreWorld` = `deserializeState` + offline catch-up
  (`advance(epoch + offlineElapsedSeconds(now, wallTime))`) — reuses the clock math, no
  fork. `wallTime` is left as the deserialized value at load; the saved `(epoch, wallTime)`
  pair stays a valid 1:1 anchor and the next save re-stamps it.
- `PixiReadout.tsx` — loads from IndexedDB on mount (`restoreWorld` when a save exists,
  else `createDemoWorld`). Captures `epochAtStart`; tick advances to
  `epochAtStart + clock.now()` (identical to before for a fresh epoch-0 world). Saves on
  `visibilitychange→hidden`, `pagehide`, and a 15s backstop interval — each save advances
  to current sim time, re-stamps `wallTime = Date.now()`, writes. Listeners + interval
  torn down in cleanup.
- Verified the round-trip through the real serialize/deserialize/advance path with
  `structuredClone` standing in for IndexedDB storage (same algorithm): save at epoch 30 /
  wall +30s, reload after +120s offline → epoch caught up to exactly 150, Pier/Depot
  amounts matched a never-saved control to 1e-9, labels survived.

`typecheck | lint | format | test` all green (50 tests).

**Known flag — pagehide save race:** IndexedDB writes are async, so a save fired during
`pagehide` can be dropped when the browser tears down the tab before the transaction
commits. Safe *today* because the world is display-only — elapsed time is reconstructed
from the `(epoch, wallTime)` anchor on load, so a dropped save just recomputes from the
previous anchor. **Revisit when interaction lands** (below): once player commands mutate
state, a dropped pagehide save loses real actions, not just recomputable time.

## Next session

Per DESIGN.md / TODO step order (litmus-test each new mechanic against ADR-0001 §2 first):

1. **Interaction**: the readout is display-only. Surface the first player command through
   the UI (e.g. adjust a warehouse pull rate, add a route) — the app calls the same core
   commands `createDemoWorld` already uses. Save-on-command (or ensure the autosave/
   lifecycle saves cover it) and resolve the pagehide race flagged above, since commands
   now mutate persisted state.

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
