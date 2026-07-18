# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done this session

**Research track, part 2 — the drain mechanic (rebased onto the island skill tree).** Shipped
DESIGN.md "Research (global)" (the redesigned continuous-drain version) on top of the already-
landed island-specialization track: the knowledge pool jam now has a spender, and both
progression tracks coexist.

- **Core:** new `Research` component (the single active drain) + `research` table on
  `SimState`. The node OWNS its knowledge pool's `pullRate` (drainRate while active, 0 at
  completion), so the existing warehouse empty-throttle machinery gives the full-fidelity
  stall (empty pool drains at income, never fails) and offline catch-up for free — same
  converter math, one code path. Progress is the node's **absolute consumed**, anchored
  closed-form and clamped to cost at load. Completion is a scheduled `research-complete`
  event (new event kind, priority between deposit-tier and the warehouse crossings) that
  pins consumed at cost and zeroes the drain — so a long offline jump can't over-drain a
  finished node. Commands: `startResearch` (single-slot; rejects a second start),
  `clearResearch` (cancel/collect, returns banked consumed), query `researchConsumedAt`.
  Research is the first **deletable** entity, so `isStaleEvent` now treats a
  `research-complete` whose node was cancelled as stale instead of throwing.
- **Serialize:** `research` table added, single-active + field validation at import,
  consumed clamped to cost on load. **SAVE_VERSION 4→5** — the island track already took v4
  (`islandProgress`), so research migrates **v4→v5** (backfill empty table) after it.
- **App (`world.ts`):** authored `RESEARCH_NODES` (flat, knowledge-only cost: Survey Cache
  40, Reinforced Holds 60, Tidal Almanac 100), `RESEARCH_DRAIN_RATE` (1/s). Per-node
  **inactive** progress in the envelope (`researchProgress`); the active node's live
  progress stays the single source of truth in core. Helpers `startResearch` (swaps freely,
  banking the outgoing node), `cancelResearch`, `collectCompletedResearch`, `isResearched`,
  `isResearchActive`, `researchConsumed`. Restore reconstructs the progress map (drops
  unknown/active nodes, clamps to cost) and clears an active drain whose node this app no
  longer defines. **No content-version bump** — research adds no core state on upgrade;
  `knowledgePoolId` is derived and undefined (research UI hidden) if the knowledge tier
  isn't present yet.
- **UI (`PixiReadout.tsx`):** one ⚑ progress bar (teal, distinct from the island XP bars'
  purple) + start/cancel button per node, laid out after the island XP rows. The active
  drain is scanned once per frame (allocation-free) and read by every node's row/button.
  `collectCompletedResearch` runs each frame so a node banks the moment the drain crosses
  cost (online or across an offline jump), and saves on completion.
- **Adversarial-review fixes (this session):**
  - _Finding 1 (correctness):_ a save whose consumed clamps up to a lowered cost loaded as
    complete but left the pool's `pullRate` live (the completion handler never ran), so the
    pool over-drained until the app's first-frame collect. Fixed by re-establishing the
    pool pull from the research entry's completion state on load — which makes
    `Research.drainRate` load-bearing (**finding 2 answer:** not dead — DESIGN.md makes it
    the node's authoritative rate and a future research/meta knob; `warehouse.pullRate` is
    the derived cache, now reconciled on load rather than trusted).
  - _Finding 3 (dedup):_ `PixiReadout`'s per-frame `nodeConsumed` no longer re-derives the
    same branch as `world.researchConsumed`.
- **Lint:** `no-nested-ternary` (error) in `.oxlintrc.json`; event-owner dispatch de-nested.

`typecheck | lint | format | test` green (**142 tests**). **Live-driven (browser-drive,
headless Chromium):** base economy + observatory + storage rung, then the skill-tree trunk node
"Efficient Tools" bought and the research node "Survey Cache" drained to "40/40 (researched)";
both survived an IndexedDB reopen; zero console errors. `drive.mjs` covers both flows;
screenshots in the gitignored `packages/app/drive-output/`.

## Next session

1. **Wire the skill-tree junction to research** (now unblocked — research exists). Replace the
   `researchGated` stub with a real research-node gate and add **branch exclusivity** (picking
   Extraction locks Refinement, and vice versa) — `TODO` markers are in `world.ts`
   (`HOME_SKILL_TREE` / `nodeUnlocked`) and `PixiReadout.tsx` (the locked-button branch). Add
   the Refinement-branch node effects then too.
2. **Thin unlock tree (part 3).** Wire real effects onto completed research nodes across the
   unlock categories (DESIGN.md): first concrete payoff **research-gate the storage upgrade**.
   Add a **research/meta** node raising **queue depth 0→1** — the queue machinery (enqueue,
   auto-start on prereqs, blocked node holds the queue) lands here, since part 2 deliberately
   built only the single active slot. Also the first **resource-sample gate** (samples consumed
   once at first start — the discrete entry fee), which needs a sample resource or a stand-in.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) — the
mechanism for networking island pools, and what lets multiple islands' observatories all feed
the one global knowledge pool. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.
