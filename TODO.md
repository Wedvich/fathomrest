# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done last session

**App wiring** — the core now drives a live readout in the browser (TODO step 1).

- `packages/app/src/sim/world.ts` — `createDemoWorld()` builds a placeholder scene
  entirely through the core command surface (deposit → extractor → Pier warehouse
  with a pull rate → route → Depot). Pure core, no React/Pixi (core stays
  UI-agnostic). Stand-in until save-loading exists.
- `packages/app/src/PixiReadout.tsx` — owns the sim clock and drives
  `advance(t)` + `warehouseAmountAt`/`warehouseOutflowRate` off Pixi's ticker
  (rAF-based). Sim time derives from `performance.now()`, so a backgrounded tab
  (rAF paused) catches up in one big `advance()` on return — the analytic core needs
  no special offline handling here. React tree stays static; all animation lives in
  the ticker (no per-frame React re-render).
- `App.tsx` / `main.tsx` — static demo removed; renders `<PixiReadout />`.
- Verified end-to-end under headless Chromium: bars animate as the sim advances
  (Pier 2.1→14.1/100, Depot 2.8→18.9/200 over ~4s, route feeding the depot), zero
  console/page errors.

Two fixes made along the way:

- **StrictMode double-free** in `PixiReadout`: `app.renderer` is `undefined` (not
  `null`) before async `init()` resolves, so the old `renderer !== null` destroy guard
  tore down a half-initialized app and Pixi's second `destroy()` threw
  `_cancelResize is not a function`. Now gated on an explicit `live` ref set only
  after init resolves.
- **Import extensions**: relative imports now use the real source extension
  (`.ts`/`.tsx`), never `.js`/extensionless (TS 7 rewrites on emit). Documented in
  CLAUDE.md (Workspace) and enforced by a new oxlint `import/extensions` rule
  (`ts`/`tsx` always, `js`/`jsx` never; packages ignored). Enabling `plugins` in
  `.oxlintrc.json` overwrites oxlint's defaults, so the default set
  (`react`, `unicorn`, `typescript`, `oxc`) is re-listed alongside `import`.

`typecheck | lint | format | test` all green (46 tests).

## Next session

Per DESIGN.md / TODO step order (litmus-test each new mechanic against ADR-0001 §2 first):

1. **Persistence loop**: wire `serializeState`/`deserializeState` to storage
   (IndexedDB — never localStorage, it's synchronous; structured clone serializes the
   Map tables natively) so the demo world survives reload, re-stamping `state.wallTime` at
   save time and doing offline catch-up at load
   (`advance(epoch + offlineElapsedSeconds(now, wallTime))`). The `PixiReadout` clock
   currently starts fresh from `epoch 0` each mount — load a saved doc instead of
   `createDemoWorld` when one exists.
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
