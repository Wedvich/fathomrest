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
  - `sim/session.ts`); deep-link primitive (`ui/navigation.ts`: `NavigationContext` +
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

Phase 1 island view (`1a`) — React right dock complete; research + island-plan overlays
(phases 3/4) landed, unblocking the temp-readout retirement. Landed:

- **Right dock + WAREHOUSE POOLS** (`ui/IslandDock.tsx`): parchment 352 px `<aside>`,
  pinned right in a flex-row `<main>` (canvas region left, temp `PixiReadout` still fills
  it). Island header (name · `LV n` · XP, `XP paused ⏸` when any pool jammed) + one pool
  row per island warehouse (chip, `cur/cap`, net rate, resource-color bar). Jam state
  (JAM tag + rust cap-stripe + ROOT/`caused by …` sub-line) and converter outflow
  sub-lines render from the core solver, no UI inference.
- **Dock selectors** (`sim/dock.ts`): `poolRowViews` (island-filtered, so the global
  knowledge pool is excluded — hard rule 1); outflow attribution via `forEachConverter` /
  `converterDraw` matched to `converterSites` labels; `jamRootReason` (exhaustive over
  `JamRootKind`). `resourceChip()` lookup helper added to `ui/tokens.ts`.
- Verified live (fresh world screenshot, no console errors); typecheck/lint/166 tests green.

- **DEPOSITS + BUILD sections** (same two files): deposit cards (× badge, reserve bar,
  `remaining/total`, pause + next-step + floor sub-line) and build cards (striped icon,
  per-resource cost chips ✓/`need n`, affordability ETA line, `→ GLOBAL K` tag, Build
  button via `session.command`). Selectors added: `depositCardViews`, `buildCardViews`,
  `affordabilityEta`. Verified live (fresh → affordable; post-spend → shortfall/ETA/disabled).

- **Harbormaster's log** (`ui/HarbormasterLog.tsx`): dark translucent panel floating
  bottom-left of the canvas, rendering `listJams` roots-first (rust dot + ROOT reason for a
  bottleneck, amber dot + "caused by <root>" for a symptom); hidden when clean. Fix/View
  rows deep-link: `navigation.ts` grew `focusPool` + `focus(poolId)`; `AppShell` owns the
  transient focus (auto-clears after 2.5 s) and hosts the log in a relative canvas frame;
  the dock scrolls the target pool row into view and pulses a teal ring. `jamLogEntries`
  added to `sim/dock.ts`. Verified live (two closed-sink jams; Fix scrolls + highlights).

- **Research + island-plan overlays** (`ui/ResearchOverlay.tsx`, `ui/IslandPlanOverlay.tsx`):
  the two scaffolds are now real content, homing the skill-node/research controls off the
  temp readout. Island plan = full-parchment surveyor's plan (trunk → research-gated
  exclusive junction → branch columns, lock reasons from the core predicates, XP-bar
  header); research = violet star chart with the reduced state set (no queue yet). Shared
  plumbing extracted: `ui/OverlayFrame.tsx` (modal chrome), `ui/KnowledgePill.tsx`,
  `ui/CostChips.tsx` + `dock.costChips` (one chip treatment for build + skill cards). Map
  overlay stays a scaffold (phase 5). Verified live; no console errors.

Next, in order:

1. **Retire the temp readout / build the real Pixi island scene.** NOW UNBLOCKED — the
   skill-node + research buttons have homes (overlays above), so `PixiReadout` can be
   deleted once its content moves. The dock already duplicates its warehouse+deposit bars
   and build/storage buttons; only the island XP + research-collect ticker logic still lives
   there. Move `PixiReadout`'s content into a real island scene on `useIslandScene`
   (radial-ocean bg, slot markers, JAM/deposit badges, slot tooltip); the canvas region then
   fills the space left of the dock. **Carry over the research-collect loop** — the temp
   ticker calls `collectCompletedResearch` every frame via `session.command(collect)`; the
   new scene's ticker (or a small session-owned loop) must keep doing that, or research never
   banks completion. Slot tooltip + JAM/deposit badges can reuse the `nav.focus` plumbing.
2. **Starved pools:** `poolRowViews` surfaces `isWarehouseJammed` (full) only — add the
   `isWarehouseStarved` (empty, amber symptom) treatment when a starve case exists to show
   it (single-island slice rarely starves yet). The log already handles `pool-empty` rows.
3. **Deferred polish:** slot tooltip adjacency copy; deposit-card richness-tier colors;
   build-card icon art (striped placeholder for now); log-row jam duration (needs a core
   jam-onset timestamp — not tracked yet); research overlay's queue strip + sample gates +
   selected-detail column (needs the phase-3 core work: queue depth 0→1, sample gates).

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) —
the mechanism for networking island pools, and what lets multiple islands' observatories
feed the one global knowledge pool. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere. Fonts follow-up: subset/convert
the bundled TTFs to latin woff2 (needs fonttools or woff2 tooling).
