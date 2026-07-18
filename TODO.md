# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done this session

**Island skill tree, part 1 — Island XP + the shared trunk (junction stubbed).** Shipped the
first per-island progression loop from DESIGN.md "Island specialization": extract → gain XP →
level → buy a throughput node. The research-gated exclusive junction is defined but stubbed
locked (research doesn't exist yet — the user chose "trunk + XP, stub junction").

- **Core (new `IslandProgress` primitive, SAVE_VERSION 3→4):** `components/island-progress.ts`
  holds a per-island `{ xpAnchor, xpAnchorTime, xpRate, extractionMultiplier }`, keyed
  `Map<IslandId, IslandProgress>` on `SimState`. XP is an **analytic accumulator, event-free**:
  `deriveAll` gains a phase 5 that re-anchors XP and caches `xpRate = islandThroughput` (Σ
  `extractorEffectiveRate` into the island's pools + Σ `converterFeed` landing there — realized
  rates, so a jam pauses XP; route inflow excluded). No cap, no crossing → it schedules nothing;
  `islandXpAt(t)` is exact between events and runs offline at full fidelity. New commands:
  `registerIsland` (opt-in; `GLOBAL` knowledge never registered), `applyExtractionMultiplier`
  (atomic `debitCost` + multiplier, loud throw if the island's unregistered), `grantIslandXp`
  (discrete lump — the expedition/milestone hook, mirrors `grantResource`). The multiplier is
  applied in **both** `extractorEffectiveRate` and `totalInflow` (kept identical) so fill and
  depletion never diverge. serialize v3→v4 backfills `islandProgress: []`; validation mirrors the
  command boundary. New exports in `index.ts`.
- **App (`world.ts`, WORLD_CONTENT_VERSION 3→4):** `SkillNode` content + `HOME_SKILL_TREE` (3
  trunk nodes: level+cost+prereq gated, extraction-multiplier effect; 2 junction nodes flagged
  `researchGated`). `XP_LEVEL_THRESHOLDS` + `islandLevel`; `islandXpView`, `worldSkillNodes`,
  `canBuyNode`, `buyNode`. `DemoWorld.purchasedNodes` is envelope bookkeeping (reassigned, never
  mutated); the mechanical effect lives in core state, so both come straight from the save and
  can't drift. `createDemoWorld` registers `home`; a new v3→v4 upgrade step registers it on old
  saves at the restore epoch (no retroactive XP). `restoreWorld` drops unknown node ids (safe for
  a newer-app save on a stale bundle — the effect is already in core state).
- **UI (`PixiReadout.tsx`):** an XP bar per registered island (level + progress-to-next), and
  skill-node buttons (gated on `canBuyNode`, not just affordability); a `researchGated` node
  renders a static "🔒 … research required" disabled button.
- **Tests:** core `island XP` scenario (throughput accrual, jam-pause, multiplier scales rate,
  lump grant, offline==online, unregistered island = 0/×1) + serialize round-trip/migration/reject;
  app `island skill tree` scenario (level+cost gating, buy applies multiplier + persists, junction
  stays locked with trunk owned + XP maxed + stock full, v3→v4 injection with no retroactive XP).
  Fixed the pre-existing `knowledge tier` content-upgrade test (its `WORLD_CONTENT_VERSION - 1`
  shorthand + `createDemoWorld`-derived fixture broke when a step was added): pinned to a faithful
  iron-era v2 doc (`islandProgress: []`, version 2).

`typecheck | lint | format | test` green (**124 tests**). **Live-driven (browser-drive skill,
headless Chromium):** after the base economy + observatory + storage rung, the purple **home XP**
bar renders and climbs (drove to "Lvl 4 · 220/260 XP"); "Efficient Tools" was disabled at low
XP, enabled after leveling + re-accruing 40/40, one click flipped it to "— owned"; both
"🔒 … research required" junction buttons stayed locked; the owned node + 250 caps survived an
IndexedDB reopen; zero console errors. `drive.mjs` extended to cover the skill tree; screenshots
in the gitignored `packages/app/drive-output/`.

## Next session

1. **Research drain (part 2).** Still the gating dependency for the skill-tree junction. Per
   DESIGN.md "Research (global)": Factorio-style continuous knowledge drain, per-node absolute
   consumed, queue depth 0. First thing that _spends_ knowledge.
2. **Thin unlock tree (part 3).** A few research nodes across the unlock categories; research-gate
   the storage upgrade; a research/meta node raising queue depth 0→1 (queue machinery lands here).
3. **Wire the skill-tree junction to research.** Replace the `researchGated` stub with a real
   research-node gate and add **branch exclusivity** (picking Extraction locks Refinement, and
   vice versa) — the `TODO` markers are in `world.ts` (`HOME_SKILL_TREE` / `nodeUnlocked`) and
   `PixiReadout.tsx` (the locked-button branch). Add the Refinement-branch node effects then too.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) — networks
island pools; also what lets multiple islands' observatories feed the one global knowledge pool.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.
