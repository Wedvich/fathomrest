# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**Review follow-ups on the app wiring** — the two non-mechanical findings from the
adversarial `/code-review` of the readout commit:

- `packages/app/src/simClock.ts` (new) — app-side sim-second clock. `now()` runs
  purely off `performance.now()` (hot path: two reads, zero allocation);
  `reanchor()` folds in wall-clock time the monotonic clock missed
  (`max(0, wallDelta − perfDelta)`, ≥1s threshold, clamped so a user clock set
  backward never rewinds sim time). Anchors don't move on a skipped reanchor, so
  repeated sub-threshold freezes accumulate and eventually fold in. Unit-tested
  (4 cases, the self-contained-primitive carve-out).
- `PixiReadout.tsx` — sim time now comes from `simClock`; `visibilitychange` →
  `visible` and `pageshow` with `persisted === true` call `reanchor()` (per
  docs/browser-performance.md §lifecycle / ADR-0001 §4), so Safari
  suspension/bfcache restores catch up in one `advance()`. Bar fill regained its
  rounded corners via a static rounded-rect mask on the white-texture Sprite —
  per-frame work stays a single `width` assignment, no Graphics in the frame path.
  Tick loop is indexed (perf doc, JSC iterator allocation); row objects carry only
  what the tick reads.
- Verified live under headless Chromium with a skewed `Date.now()` standing in for
  suspension: +30s via `visibilitychange` and +20s via persisted `pageshow` both
  caught up in one step (Pier saturated at 100/100, Depot 141→200/200);
  sub-threshold (+0.5s) skew correctly ignored; wall clock set back 1h → no rewind;
  zero console/page errors.

Known cosmetic nit: the readout template hardcodes the minus sign, so a zero rate
renders as `(−0.0/s)` (Depot). One-character fix if it grates.

`typecheck | lint | format | test` all green (50 tests).

## Next session

Per DESIGN.md / TODO step order (litmus-test each new mechanic against ADR-0001 §2 first):

1. **Persistence loop**: wire `serializeState`/`deserializeState` to storage
   (IndexedDB — never localStorage, it's synchronous; structured clone serializes the
   Map tables natively) so the demo world survives reload, re-stamping `state.wallTime` at
   save time and doing offline catch-up at load
   (`advance(epoch + offlineElapsedSeconds(now, wallTime))`). The `PixiReadout` clock
   currently starts fresh from `epoch 0` each mount — load a saved doc instead of
   `createDemoWorld` when one exists. `simClock`'s wall/monotonic anchor pair is the
   piece to hook save-time `wallTime` re-stamping into — don't fork the anchor math.
2. **Interaction**: the readout is display-only. First player command surfaced through
   the UI (e.g. adjust a warehouse pull rate, add a route) — the app calls the same
   core commands `createDemoWorld` already uses.

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
