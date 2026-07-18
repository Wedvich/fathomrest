# TODO

Living handoff doc: replaced (not appended) at the end of every working session with
the concrete next steps. Long-term plans live in DESIGN.md — this is only "what to
pick up next".

## Done this session

**Research track, part 1 — knowledge (the first global-scoped resource).** Shipped the
extraction half of DESIGN.md "Progression/Knowledge": a global knowledge pool fed by a
cost-gated observatory on the demo island.

- **Core:** `buildExtractor` now takes an explicit **build-site island** (`buildIslandId`)
  instead of inferring the cost island from the output warehouse. This decouples where the
  cost is paid from where the output lands — needed because the observatory sits on (and is
  paid from) `home` while filling the `global` pool. Same-island builds are unchanged
  (callers pass the pool's island). New core test pins the decoupling; the 6 existing
  `buildExtractor` call sites updated.
- **App (`world.ts`):** `KNOWLEDGE` resource, a `GLOBAL` scope tag, `KNOWLEDGE_CAP` (100,
  placeholder), and `addKnowledgeTier` (global pool on `GLOBAL` + observatory deposit on
  `home`, cost 40 wood + 40 stone above the seed like the iron tier). Wired into
  `createDemoWorld` and as a **v2→v3 content-upgrade step** (WORLD_CONTENT_VERSION now 3),
  so existing saves gain knowledge at the restore epoch without retroactive production. App
  `Deposit` view model carries `payIslandId` (the funding/site island). `worldIslands`
  excludes `GLOBAL` so the global pool's cap stays **off the wood/stone storage ladder**
  (it's research-gated later).
- **UI (`PixiReadout.tsx`):** build buttons now key off an explicit `payIslandId` (not a
  paying-warehouse). Knowledge pool bar + observatory build button appear automatically.
- **Tests:** new `knowledge tier` scenario in `world.test.ts` (global scope + off-ladder,
  observatory gated behind the base economy then accrues into the global pool + jams at cap,
  content-upgrade injection). Storage/label tests updated for the extra pool.

**Adversarial review of the knowledge changes + the four load-bearing findings fixed** (8
finder angles → 10 verified findings; the remaining six are test/drive-script nits that can
ride along later):

- **Loud wiring error:** core `debitCost` now throws a plain `Error` (never the benign,
  catch-and-retried `InsufficientStockError`) when the build island has **no pool at all**
  for a cost resource — a miswired `payIslandId` fails loud instead of presenting as a
  forever-disabled build button (silent soft-lock). Pinned by a core test.
- **Restore boundary:** `restoreWorld` validates each deposit's persisted `payIslandId`
  against the doc's islands — corruption quarantines loudly, same as dangling ids.
- **`payIslandId` required at runtime:** backfilled once in `restoreWorld` (new
  `SavedDeposit` keeps the field optional for pre-knowledge saves); the duplicated
  `?? getWarehouse(...).islandId` fallbacks in `world.ts` and `PixiReadout.tsx` are gone.
- **`isGlobalScope` predicate (exported):** the GLOBAL exclusion is a shared predicate, no
  longer an inline string-compare in `worldIslands` — island XP and any future
  island-enumerating feature must filter through it, not re-derive the exclusion.

`typecheck | lint | format | test` green (113 tests). **Live-driven (browser-drive skill,
headless Chromium):** observatory disabled at the 30/30 seed, enabled once the base economy
funds 40/40, one click built it (button flipped to "extractor built"), then the storage rung
still bought after re-accrual — proving the observatory is paid from home, not the global
pool it fills. Knowledge bar renders (0/100 fresh, 47/100 accrued on reopen), no "global
storage" button, IDB reopen clean, zero console errors. `drive.mjs` extended to cover the
observatory; screenshots in the gitignored `packages/app/drive-output/`.

Note: `package.json` gained a `dev` script (was already in the working tree at session
start, not from this work) — fine to keep, just not part of the knowledge change.

## Next session

1. **Research drain (part 2 of the research track).** With knowledge now produced, build
   active research per the **redesigned** DESIGN.md "Research (global)" (2026-07-18 —
   supersedes the old upfront-cost/queue-depth-2 plan): a Factorio-style **continuous
   drain** at a global base rate (duration = cost ÷ rate; empty pool stalls, never fails),
   full-fidelity offline via the converter math, per-node **absolute consumed** progress
   preserved across free cancel/swap. **Queue depth starts at 0** (active slot only; depth
   is itself research-unlocked later — research/meta category), so part 2 needs no queue
   machinery beyond the single active slot. This is the first thing that _spends_
   knowledge and turns the "jam at cap" into the "come spend me" prompt.
2. **Thin unlock tree (part 3).** A few research nodes across the unlock categories
   (buildings, in-place building upgrades, economy modifiers, island-tree gates). First
   concrete payoff: **research-gate the storage upgrade** (it shipped cost-gated only —
   DESIGN.md unlock category "in-place building upgrades"). Include a **research/meta**
   node raising queue depth 0→1 — the queue machinery lands here, as an unlock.
3. Then the two-track's second track: **Island XP + skill tree** (throughput-fed XP,
   trunk + Extraction/Refinement branches, junction research-gated).

Deferred (inter-island): **buildable/costed routes** (`buildRoute` fronting `addRoute`) — the
mechanism for networking island pools, and what makes multiple islands' observatories all
feed the one global knowledge pool. Pick up once single-island depth is proven.

Carried over: the PWA service worker pins old bundles until the update prompt is accepted —
rebuild `packages/app/dist/` before serving it anywhere.
