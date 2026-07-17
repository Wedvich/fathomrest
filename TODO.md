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

## Next session

1. **Repo-resident browser-drive setup (do this first).** The post-commit live drive (dev
   server + Playwright/Chromium) has been hand-rolled from a throwaway tmp dir two sessions
   in a row; it's the standard "verify what we just did" step after every commit, so make it
   repeatable in-repo:
   - Playwright as a devDependency (app package or a small tools workspace); browser install
     via `bunx playwright install chromium`; run the driver with **node, not bun**.
   - A committed drive script covering this session's proven flow: fresh persistent profile →
     assert storage button disabled at 30/30 → click both base extractor buttons → wait for
     enable (~15s) → click upgrade → assert label "→ 500" + disabled → screenshots → close and
     reopen the same profile → assert restored caps/rung. Working version (recoverable if tmp
     was cleaned: rewrite from this description) at
     `~/.claude/jobs/0d20a627/tmp/pw/drive.mjs`.
   - A project skill under `.claude/skills/` so `/run` finds it (`/run-skill-generator` can
     scaffold): launch recipe (`bun run --filter '@fathomrest/app' dev`, port 5173), driver
     invocation, and the key caveat — pool readouts are Pixi **canvas** text, so verify bars
     via screenshots; only the buttons are DOM-assertable.
   - Keep it a drive (verification harness), not a test suite — Vitest already owns the
     scenario coverage.
2. **Research track** (grilled 2026-07-17, settled in DESIGN.md "Progression"): knowledge as
   the first global-scoped resource (global capped pool, observatory extractor on a knowledge
   deposit) → timed research queue (depth 2, paid at enqueue) → thin unlock tree. Note: the
   storage upgrade shipped cost-gated only; research-gating it (DESIGN.md unlock category
   "in-place building upgrades") is a later layer once research exists.
3. **Island XP + skill tree**: throughput-fed XP accumulator (own stored quantity), levels,
   trunk + Extraction/Refinement branches; junction research-gated; nodes instant, paid in
   island-local resources.
4. **Building pillar depth** (DESIGN.md active half): fixed slots, siting/adjacency. This is
   what makes "placeable storage building" distinct from the island upgrade shipped now — the
   ladder can re-skin onto slotted placeables once slots exist.

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) — the
mechanism for networking island pools. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.
