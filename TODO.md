# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Current track: UI design handoff implementation

Recreate the five committed surfaces from `docs/design_handoff_fathomrest_ui/README.md`
(React panels + Pixi canvas; high fidelity for layout/color/type, placeholders for art).
Phases, in order — sim-side prerequisites interleaved where noted:

- **Phase 0 — foundations (in progress).** Design-token module (parchment/ocean ramps,
  accents, resource colors — one hex source for React strings + Pixi numbers); bundle
  Caveat Brush + Playpen Sans (TTFs + OFL, Coming Soon pattern; woff2/latin subsetting is
  a follow-up — no conversion tooling installed); app shell (HUD bar, canvas region,
  overlay routing, Esc, deep-link primitive); sim-view layer (event-driven + ≥250 ms
  coarse-timer React subscription); split `PixiReadout` into sim session (clock,
  persistence, commands) + island scene, existing readout content kept working inside
  the shell.
- **Phase 1 — island view (`1a`).** Top HUD, right dock (pool rows w/ jam states +
  outflow lines, deposit cards, build cards w/ cost chips), Pixi island scene (slot
  markers, JAM/deposit badges), slot tooltip, harbormaster's log. New selectors: jam
  flag + block reason, outflow attribution, affordability ETA, deposit next-step ETA.
- **Root-cause solver query (core).** Jam causality chain (pool full → converter blocked
  → …) as a sim query; every jam surface renders it — UI inference is forbidden by the
  handoff. Do before the surfaces that triage jams.
- **Phase 2 — welcome-back dialog (`2a`).** Offline summary capture in core/world (away
  duration, per-resource gains with cap-hit times recorded during the offline advance,
  completions, ranked jam list) + the dialog + deep-link fix buttons.
- **Phase 4 — island skill tree (`3c`)** (promoted ahead of research: sim side is done —
  junction gate + branch exclusivity landed; `isNodeResearchLocked`/`isNodeBranchLocked`
  map 1:1 onto the two locked treatments). Fold in **branch depth** authoring (3–4 nodes
  per branch; each branch currently has only its mastery node).
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

Continue phase 0 wherever the task list below stands, then phase 1:

1. Finish phase 0 (tokens / fonts / shell / sim-view layer / PixiReadout split) and
   verify via browser-drive.
2. Start island view (`1a`): right dock pool rows first (real data exists), then build
   cards + selectors (affordability ETA, outflow attribution).

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) —
the mechanism for networking island pools, and what lets multiple islands' observatories
feed the one global knowledge pool. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere. Fonts follow-up: subset/convert
the bundled TTFs to latin woff2 (needs fonttools or woff2 tooling).
