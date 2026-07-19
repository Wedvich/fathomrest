# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Current track: UI design handoff implementation

Recreate the five committed surfaces from `docs/design_handoff_fathomrest_ui/README.md`
(React panels + Pixi canvas; high fidelity for layout/color/type, placeholders for art).
Phases, in order — sim-side prerequisites interleaved where noted:

- **Phase 0 — foundations — DONE.** Design-token module (parchment/ocean ramps, accents,
  resource colors — one hex source for React strings + Pixi numbers); bundled Caveat
  Brush + Playpen Sans (TTFs + OFL; "Coming Soon" placeholder retired now that both real
  faces are wired everywhere — woff2/latin subsetting is still a follow-up, no conversion
  tooling installed); app shell (HUD bar, canvas region, overlay routing, Esc); sim-view
  layer (event-driven + ≥250 ms coarse-timer React subscription, `ui/SimSessionProvider.tsx`
  + `sim/session.ts`); deep-link primitive (`ui/navigation.ts`: `NavigationContext` +
  `useNavigation()`, HUD buttons route through it — extend `DeepLink` with a focus target
  when phase 1's log rows / phase 2's fix buttons need one); `PixiReadout` split into sim
  session (above) + island scene (`scene/IslandScene.ts`'s `useIslandScene` hook — generic
  Pixi Application create/mount/destroy lifecycle, StrictMode-safe; `PixiReadout` keeps the
  temp bar/button content as that hook's `build` callback, ready to be swapped for the real
  island scene in phase 1).
- **Phase 1 — island view (`1a`).** Top HUD, right dock (pool rows w/ jam states +
  outflow lines, deposit cards, build cards w/ cost chips), Pixi island scene (slot
  markers, JAM/deposit badges), slot tooltip, harbormaster's log. New selectors: jam
  flag + block reason, outflow attribution, affordability ETA, deposit next-step ETA.
- **Root-cause solver query (core) — DONE.** `packages/core/src/jam.ts`:
  `warehouseJamChain` (symptom→root chain with route/converter `via` steps),
  root classification (closed-sink / outflow-deficit / transfer-capped / no-producer /
  dry-deposit / inflow-deficit), `isWarehouseJammed`/`isWarehouseStarved` (frame-safe),
  `routeStatus`/`converterStatus` (cause pool named), `listJams` (roots first). Every jam
  surface (incl. phase-5 route popovers) renders these — no UI inference. Review
  follow-ups deferred, need a decision each: (1) persist per-edge binding attribution at
  derive time so `edgeStatus` stops guessing when BOTH ends are pinned (save-schema
  addition, `flow` precedent); (2) chains are linear (first blocked edge) — fan-out jams
  with several blocked edges show one cause; consider per-step blocked-via lists;
  (3) `listJams` is O(W·chain·E) full-table scans — fine at slice scale, needs adjacency
  maps + suffix memoization before big archipelagos.
- **Phase 2 — welcome-back dialog (`2a`).** Offline summary capture in core/world (away
  duration, per-resource gains with cap-hit times recorded during the offline advance,
  completions, ranked jam list) + the dialog + deep-link fix buttons.
- **Phase 4 — island skill tree (`3c`)** (promoted ahead of research: sim side is done —
  junction gate + branch exclusivity landed; `isNodeResearchLocked`/`isNodeBranchLocked`
  map 1:1 onto the two locked treatments). **Branch depth is authored** (3 nodes past
  each mastery, levels 6–8, storage-ladder/iron costs — `world.ts: HOME_SKILL_TREE`);
  only the panel UI remains.
- **Phase 3 — research panel (`3a`).** Interleave with unlock-tree part 3 core work:
  queue depth 0→1 machinery (enqueue, auto-start on prereqs, blocked node holds queue),
  first resource-sample gate, research-gated storage upgrade. Panel can land first with
  the reduced state set (researched/researching/affordable/too-expensive).
- **Phase 5 — archipelago map (`4a`)** last: buildable/costed routes (`buildRoute`) still
  deferred, rumors/expeditions unbacked. Initially a one-island chart with route/rumor
  affordances stubbed.

Reference designs: `docs/design_handoff_fathomrest_ui/` (README + HTML mock; commit it
with this track). Non-committed alternates (`1b`,`1c`,`3b`,`4b`) stay design-only.

## Next session

Phase 0 is done (see above). Start island view (`1a`):

1. Right dock pool rows first (real data exists — jam flag/block reason come from
   `isWarehouseJammed` + `warehouseJamChain`, landed on the
   `worktree-rippling-dancing-honey` branch), then build cards + selectors (affordability
   ETA, outflow attribution).
2. When the dock needs to fill the canvas region properly (design handoff §1: canvas
   left of a 352 px dock, not the current fixed-width temp readout), that's when
   `PixiReadout`'s content moves into the real island scene built on `useIslandScene`.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) —
the mechanism for networking island pools, and what lets multiple islands' observatories
feed the one global knowledge pool. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere. Fonts follow-up: subset/convert
the bundled TTFs to latin woff2 (needs fonttools or woff2 tooling).
