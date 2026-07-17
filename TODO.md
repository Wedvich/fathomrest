# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done this session

**Adversarial review of the storage-upgrade changes + all five findings fixed** (24
candidates from 8 finder angles, verified down to 3 confirmed + 2 plausible):

- **Ladder-reset re-buy tax (the design finding; settled: seed at island cap):** a content
  step adding a pool at base cap to an already-upgraded island reset the min-derived ladder
  to rung 1, forcing a full re-buy (540/540 wood/stone) to lift one pool. New
  `islandStorageCap` helper (min cap across the island's pools); `addIronTier` now seeds new
  pools at the island's current rung, so future content tiers never reset the ladder.
  Convention recorded in DESIGN.md; pinned by a restore test on a v1 save with 250 caps
  (`woodStoneV1Save(poolCap)`).
- **Frame-loop allocation:** `nextStorageTier` allocated a `.find` closure + `for...of`
  iterator per frame (banned by browser-performance.md) — now indexed loops, no closures.
- **Core cleanup:** `upgradeIslandCapacity`'s re-anchor loop now calls `reanchorWarehouse`
  (the dead `Math.min` dropped; comment notes the re-anchor-before-swap ordering is what's
  load-bearing).
- **Button cache:** three interlocking cache vars (NaN/Infinity sentinels, nullable costMap,
  dead null guard) collapsed to one `lastTier` reference compare — `nextStorageTier` returns
  a stable `STORAGE_TIERS` element, `undefined` once maxed.
- **Infinity guard:** `upgradeIslandCapacity` AND `addWarehouse` (identical pre-existing gap)
  now require `Number.isFinite(capacity)` — Infinity previously produced a save that failed
  `checkPositive` on the next load (quarantine). Core test walks 0/-1/NaN/Infinity.

`typecheck | lint | format | test` green (107 tests). **Live-driven + verified
(Playwright/Chromium, headless, persistent profile):** upgrade button disabled at 30/30,
enabled at 40/40, one click raised all four caps 100→250 with the canvas bar denominators
re-rendering live, label advanced to "→ 500", stable over ~90 frames, IDB reopen restored
caps + rung, zero console/page errors. Not reached live: the "storage maxed" label (~4 min
of accrual; pinned by the ladder-walk test).

**Repo-resident browser-drive harness shipped** (the post-commit live drive is no longer
hand-rolled per session): `packages/app/scripts/drive.mjs` (run with **node** via
`bun run --filter '@fathomrest/app' drive`; fresh temp profile, hard assertions, exit 1 on
any console error, screenshots to gitignored `packages/app/drive-output/`), playwright as an
app devDependency, and a `.claude/skills/browser-drive` project skill that `/run` discovers
(fail-driven setup — the script prescribes `bunx playwright install chromium` only when the
cached build is actually missing). Verified end-to-end from the committed entry point:
drive PASS in ~20s. **Extend the drive script when a change adds new UI** — it's the
standard verification after every commit.

## Next session

1. **Research track** (grilled 2026-07-17, settled in DESIGN.md "Progression"): knowledge as
   the first global-scoped resource (global capped pool, observatory extractor on a knowledge
   deposit) → timed research queue (depth 2, paid at enqueue) → thin unlock tree. Note: the
   storage upgrade shipped cost-gated only; research-gating it (DESIGN.md unlock category
   "in-place building upgrades") is a later layer once research exists.
2. **Island XP + skill tree**: throughput-fed XP accumulator (own stored quantity), levels,
   trunk + Extraction/Refinement branches; junction research-gated; nodes instant, paid in
   island-local resources.
3. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency. This is
   what makes "placeable storage building" distinct from the island upgrade shipped now — the
   ladder can re-skin onto slotted placeables once slots exist.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) — the
mechanism for networking island pools. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.
