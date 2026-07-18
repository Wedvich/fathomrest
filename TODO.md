# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done this session

**Skill-tree junction wired to research (part 3 kickoff) + the refinement branch effect.**
Replaced the `researchGated` stub with a real research gate, added branch exclusivity, and gave
the Refinement branch its own core effect distinct from Extraction.

- **Core:** new `refinementMultiplier` on `IslandProgress` (identity 1), scaling the **yield** of
  every converter producing INTO the island. Applied via a single `converterEffectiveRatio`
  (`converter.ratio * islandRefinementMultiplier(dstIsland)`) that the transfer solver builds each
  converter edge with — so dst inflow, water-fill, and `converterFeed` all agree; the source draw
  is unchanged (more output per input). New command `applyRefinementMultiplier` (mirrors
  `applyExtractionMultiplier`) + accessor `islandRefinementMultiplier`, both exported.
- **Serialize:** `refinementMultiplier` rides the `IslandProgress` spread, validated (`checkPositive`)
  at import. **SAVE_VERSION 5→6** — v5→v6 backfills identity (1) onto existing island-progress
  entries, so converters keep their content yield and the extraction bonus survives.
- **App (`world.ts`):** `SkillNode.researchGated?` → `researchRequired?: ResearchNodeId` (both home
  masters gate on **Tidal Almanac**, cost 100). `nodeUnlocked` now checks the research gate +
  branch exclusivity via two exported predicates `isNodeResearchLocked` / `isNodeBranchLocked`.
  `buyNode` dispatches the effect by branch — trunk/extraction → `applyExtractionMultiplier`,
  refinement → `applyRefinementMultiplier`. Restore needs no change: effects live in serialized core
  state (`purchasedNodes` is bookkeeping only).
- **UI (`PixiReadout.tsx`):** junction nodes are no longer static-locked — every skill node takes a
  per-frame update whose label carries the current lock reason (`🔒 … — research required`,
  `🔒 … — <Other> branch chosen`, or the buyable `Skill: …`).
- **Tests (+5, 147 total):** core — refinement multiplier scales yield without changing draw, and
  holds through a dst jam; serialize round-trips the field + v5→v6 migration backfills identity. App
  — junction stays locked until Tidal Almanac completes then unlocks; picking one branch locks the
  other; the refinement branch drives `refinementMultiplier`, not extraction.

`typecheck | lint | format | test` green (**147 tests**). **Live-driven (browser-drive, headless
Chromium):** the base→observatory→storage→trunk→research flow still passes; the junction now renders
the "research required" lock label (verified in `4-skill-node-owned.png`) instead of a permanent
lock. `drive.mjs` assertion updated to the new label. Screenshots in gitignored
`packages/app/drive-output/`.

## Next session

1. **Finish the unlock tree (part 3) — real effects on completed research nodes** (DESIGN.md unlock
   categories). First concrete payoff: **research-gate the storage upgrade**. Add a **research/meta**
   node raising **queue depth 0→1** (the queue machinery — enqueue, auto-start on prereqs, blocked
   node holds the queue — lands here; part 2 built only the single active slot). Add the first
   **resource-sample gate** (samples consumed once at first start — the discrete entry fee), which
   needs a sample resource or a stand-in.
2. **Branch depth.** Each specialization branch currently has ONLY its mastery node; DESIGN.md wants
   **3–4 nodes each**. Author the remaining Extraction/Refinement nodes now that both effects and the
   exclusive gate exist. Consider driving the full junction purchase in `drive.mjs` if a fast path to
   level 5 + Tidal Almanac exists (currently too slow live — Vitest covers the unlock mechanics).

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) — the
mechanism for networking island pools, and what lets multiple islands' observatories feed the one
global knowledge pool. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.
