# Fathomrest — Design Document

**Fathomrest** (working title): browser-based hybrid idle/active game about resource extraction across an archipelago,
driven by a rich research tree. Free passion project, no monetization.

## Fantasy & tone

A single huge ocean world of islands. Art direction blends Anno and Heroes of Might
and Magic — 2.5D, fantasy/nature, not sci-fi. The player runs a settlement venture:
extract, refine, research, and sail out to discover new islands.

## Core loop

### Idle half

- Extractors on islands harvest deposits over time.
- Shallow refinement chains: raw → refined, one or two tiers. No deep production graphs.
- Warehouses have capacity limits. A full warehouse **blocks** further accumulation —
  and pauses that deposit's depletion, so absence stalls progress rather than wasting it.
- Returning to a jammed network is the intended session-starter: find the bottleneck, fix it.
- **Caps are deliberately tight — active play is the primary throughput.** Offline yield
  is a bounded "welcome back" stockpile plus a jam to unpick, never the main income.
  Balance rates for active sessions first, then size caps so waiting past the jam earns
  nothing; a schedule that incentivizes waiting around in real time is a balancing bug.

### Active half

1. **Building** — Anno-style placement of extractors and support buildings into
   **fixed slots on illustrated island maps**. Deposits sit at specific sites;
   adjacency perks reward smart siting. Build _order_ and _site choice_ are the decisions
   (buildings cost resources; slots are scarce).
2. **Expeditions** — outfit a voyage (crew, supplies, gear crafted from resources),
   pick a heading guided by rumors, resolve over minutes with 2–4 live decision points
   ("storm ahead: press on or detour?"). Success discovers a new island; failure still
   yields charts, samples, or knowledge.

## Economy & meta-progression

- **Deposits deplete to a permanent floor** — a rich phase decays to a small perpetual
  trickle. Depletion urgency without zeroed income. Research can slow decay / raise floors.
  The "curve" is stepped richness tiers (per-tier rate multiplier over a fixed amount):
  piecewise-constant rates keep crossings analytic per ADR-0001 §2, no transcendentals.
- **No prestige, no resets.** Meta-progression is horizontal: settle new islands
  (each bootstraps with finite local resources) while **completed research persists
  forever**. Old islands persist as trickle-producers and network nodes.
- **Transport routes are instant flows with rate caps** ("B pulls from A, max X/min").
  No simulated ships. Geography can be re-weighted later via distance-priced route
  slots without engine changes; ships are visual flavor only. Routes form a **DAG**
  (cycles rejected) and support hubs (fan-in/fan-out). A jammed destination backs up
  its sources and a drained source starves its destinations; that backpressure/
  starvation resolves within the event that triggers it (ADR-0001 §route solver), so a
  saturated network jams cleanly for the player to unpick — find the true bottleneck (a
  route cap, a closed sink, or a dry deposit), not just any full warehouse.
- **Resources are typed; a warehouse (and its deposit) holds exactly one type.** An island
  holds **exactly one warehouse per resource — a single pool** (enforced as a core invariant
  at the command and import boundaries), so a resource shows one bar per island and every
  extractor of that type feeds it: two wood extractors fill the one Wood bar twice as fast,
  not two bars in parallel. A consequence: since routes connect same-typed warehouses and a
  resource has one pool per island, a same-type route is necessarily **inter-island** —
  transport is the between-islands mechanic, matching the archipelago fantasy.
  Extractors and transport routes only connect matching types (enforced at the command
  and import boundaries); changing type is refinement's job (a converter), never a
  route's. This keeps every quantity a per-type scalar closed form and leaves the flow
  solver unchanged — each route-DAG component is single-type by construction, so the
  solver "stays per-type" for free. Typed inventories are the prerequisite for refinement
  (raw → refined) and resource-costed building. The type tag is opaque to the core
  (`ResourceType`, a branded string); the resource set is authored content in the app.
- **Resource types carry a scope: island (default) or global.** Island-scoped resources
  follow the one-pool-per-island rule above and are routable. A global-scoped resource
  has **one shared pool with a global cap** — fed by extractors on any island, jams when
  full, never routable or convertible (no logistics for global currencies). Knowledge is
  the first global resource; the scope is generic so later global currencies reuse it.
- **Refinement is a single-input converter** (`sim.ts: addConverter`): consume resource A
  from a source warehouse at up to a player-set `cap` (A/sec), produce `ratio · A` of
  resource B into a destination warehouse of a **different** type — same-type converters
  are rejected (that would be a lossy/gainy route). To the solver a converter is a
  ratio-scaled transfer edge riding the same combined DAG and fixed point as routes
  (ADR-0001 §route solver). Multi-input (Leontief) recipes — `iron + coal → steel` — are
  deferred to a future ADR-first effort; they escalate edges to fixed-proportion nodes.
- **Warehouses carry an opaque island tag** (`IslandId`, a branded string like
  `ResourceType`). A **resource-costed build** debits only stock on the build site's
  island — for each cost resource, the island's single pool for it (the one-pool invariant
  above) — so you can't pay for one island's buildings out of another's stockpile.
  Affordability is checked for the whole cost vector before any stock is touched, so a
  shortfall can't half-charge. Islands are otherwise app-authored content: the core stores the grouping,
  not island geometry, slots, or adjacency (`sim.ts: buildExtractor`, `island.ts`).
- Longer refinement chains require networking specialized islands — that is the
  strategy layer.

## Progression: research & island specialization

Two tracks with different characters. Gating between them runs **strictly one-way,
research → island nodes** — reverse pressure is expressed through sample-gate
ingredients, never structural edges into the island trees.

### Research (global)

- The tree is **cumulative** — everything is eventually researchable; picking the
  order is the strategy.
- Paced by **knowledge** (a global-scoped resource, below) **plus resource-sample
  gates** on bigger nodes — rare samples come from expeditions. All three systems
  (idle extraction, expeditions, refinement) feed research.
- **Research is a drain, not a purchase** (Factorio-style): no upfront cost. The
  active node consumes knowledge continuously at a **global base drain rate** (one
  tunable knob; upgradeable later via labs/research); node duration = cost ÷ rate
  when fed. Empty pool → progress **stalls, never fails**. Runs offline at full
  fidelity with the same math as converters (extractor feeds pool, research drains
  it), so offline research is bounded by banked knowledge + income — no longer a
  real exception to "waiting never wins".
- **Progress is preserved**: per-node **absolute knowledge consumed** (complete at
  `consumed ≥ cost`, clamped to cost at load so rebalancing can't strand progress),
  no decay. The active node can be **swapped freely** — cancel at 43%, resume later
  at 43%.
- **Resource-sample gates** (bigger nodes): samples are consumed **once, at first
  start** — a discrete entry fee, recorded in the node's progress; no refund on
  cancel, never re-charged on resume. Knowledge is the only over-time component.
- **Queue starts at depth 0** (active slot only); depth is raised by research nodes
  (the **research/meta** unlock category — seed of a technology-focused playstyle
  branch, and the check on queueing the whole tree passively). Enqueueing is free;
  a queued node whose prerequisites resolve mid-queue starts automatically, so
  dependency chains can be planned ahead. A blocked node (missing samples) **holds**
  the queue rather than being skipped. There is no bank-past-cap via the queue —
  active research draining the pool is the only cap-pressure relief.
- Unlock categories: buildings, **in-place building upgrades** (e.g. warehouse
  upgrade — a build verb alongside placement), economy modifiers (decay/floors),
  island-tree gates, expedition tech, **research/meta** (queue depth, drain rate).
- **Shipped (vertical slice — the drain mechanic):** the active node is a core
  `Research` component that OWNS the knowledge pool's `pullRate` (drainRate while
  active, zeroed at completion), so the existing warehouse empty-throttle machinery
  gives the full-fidelity stall (empty pool → drain at income, never fails) and the
  offline path for free — the same converter math, one code path. Progress is the
  node's **absolute consumed**, anchored closed-form like a warehouse amount and
  clamped to cost at load; completion is a scheduled `research-complete` event that
  pins consumed at cost and stops the drain (so a long offline jump can't over-drain
  a finished node). **Single active slot** (queue depth 0) enforced at the command
  (`startResearch`) and import boundaries. Free swap/cancel is `clearResearch`,
  which returns the banked consumed; the app keeps **per-node progress** for the
  inactive nodes (the active node's live progress is the single source of truth in
  core) and resumes a node from its banked value. Nodes are app-authored content
  (flat list, knowledge-only cost); **completing a node has no gameplay effect yet**
  — the unlock categories above land in part 3. No content-version step was needed
  (research adds no core state on upgrade); the core save gained a `research` table
  as a v3→v4 migration.

### Knowledge

- The first **global-scoped resource**: one shared pool with a global cap, jams
  when full — a full knowledge bar is a "come spend me" session prompt.
- Produced by extractors (observatories/labs) on **knowledge deposits** — the
  standard deposit/extractor/depletion machinery, skinned. The starting island has
  a knowledge deposit, and the tier-0 observatory is **cost-gated only**
  (wood/stone), never research-gated — that's the bootstrap. Resource-converting
  labs (goods → knowledge) are a compatible later addition.
- **Shipped (vertical slice):** the global pool is a warehouse on a distinguished
  `global` scope tag, kept off the per-island storage ladder — its cap is
  research-gated, not raised by `upgradeIslandCapacity` (`world.ts: worldIslands`
  excludes it). The observatory is a normal cost-gated extractor whose **build-site
  island** (home, which funds the wood/stone cost) is decoupled from its **output
  pool** (global): `buildExtractor` now takes the build-site island explicitly rather
  than inferring it from the output warehouse. The build island must hold a pool for
  every cost resource — a miss throws a loud wiring error at the command (never the
  benign "can't afford"), and the deposit's persisted pay island is validated at
  restore. The global-scope exclusion is a shared predicate (`world.ts:
isGlobalScope`) that every island-enumerating feature must filter through. Added as
  a content-version step, so existing saves gain it at the restore epoch without
  retroactive production.

### Island specialization (per-island)

- A leveled skill tree per island: a shared trunk of generic nodes, then an
  **exclusive junction** (itself research-gated) that locks the island's identity.
  A wrong pick costs one island, not the save; complementary specs across islands
  drive route strategy. Respec is deferred (reconcile with no-prestige if it ever
  grows into an island-prestige mechanic).
- Branches: **Extraction** (throughput + deposit-longevity sub-paths),
  **Refinement** (converter ratios/caps), **Logistics** (route/hub perks — stubbed
  until inter-island work lands).
- **Island XP is throughput-based** — it accrues from resources extracted/refined
  on the island, so it pauses when jammed by construction and stays cap-bounded
  like all idle income. XP is its **own stored accumulator** (never derived from
  lifetime-extracted) so activity XP, milestone XP, and research-unlocked passive
  XP stay addable later without migration.
- **Nodes are instant** and cost **island-local resources** through the normal
  build-cost path — levels gate _when_ a node may be bought, stockpiles gate
  _whether it's affordable now_. No skill-point currency. (Node costs must fit
  under pool caps — coupled to storage progression, accepted.)
- **Buildings are the lever, nodes are the multiplier**: anything that occupies a
  slot stays a building (storage adds flat capacity); skill nodes give
  percentage/rule bonuses and never substitute for a placeable. **Storage ships as a
  tiered island-warehouse upgrade** — storage is **island-level, not per resource
  pool**: one upgrade (`upgradeIslandCapacity`, a costed build verb) lifts every pool
  on the island to the next rung of an authored ladder in a single command, cost
  charged once. The current rung is derived from the island's live pool caps (min, so
  a lagging pool is pulled up first) so it round-trips without a persisted index; the
  command is raise-only (never clamps a higher pool down). Content steps that add a
  pool to an existing island seed it at the island's current rung, so a later content
  tier never resets the ladder or re-charges already-bought rungs. Until building **slots**
  exist, a "placeable storage building" and this island cap-raise are mechanically
  equivalent; the placeable/slot framing is reconciled when the slot pillar lands.
- **Shipped (vertical slice):** the throughput-fed XP accumulator and the shared
  **trunk** of nodes. XP is a core per-island `IslandProgress` accumulator
  (`sim.ts: registerIsland`, `islandXpAt`) whose rate is the island's realized
  production — Σ extractor effective-rate + Σ converter feed into the island's pools,
  re-anchored each `deriveAll`, closed-form and event-free (no cap/crossing), so it
  pauses at a jam and runs offline at full fidelity. It's an opt-in per island
  (`GLOBAL` knowledge is never registered) and supports discrete lump grants
  (`grantIslandXp`, the expedition/milestone hook) alongside rate accrual. Trunk nodes
  are app-authored content (`world.ts: HOME_SKILL_TREE`), instant, level- (XP) and
  cost-gated; their effect is an **island extraction multiplier**
  (`applyExtractionMultiplier`, scaling every extractor on the island in
  `extractorEffectiveRate` **and** `totalInflow` so fill and depletion agree). Owned
  nodes are envelope bookkeeping (`purchasedNodes`); the mechanical effect lives in
  core state, so a save round-trip and offline catch-up preserve it. Added as a
  content-version step (registers `home`'s XP at the restore epoch — no retroactive
  XP).
- **Shipped (vertical slice):** the **exclusive junction** into Extraction/Refinement.
  A junction node is gated on a **completed research node** (`world.ts: SkillNode.
researchRequired`, both home masters gate on _Tidal Almanac_) AND on **branch
  exclusivity** — buying into one branch locks the other for good (`nodeUnlocked`,
  `isNodeBranchLocked`). Gating stays one-way research→island. A node's **branch also
  selects its effect**: trunk/extraction scale the island's extraction multiplier,
  refinement scales a new **refinement multiplier** — an `IslandProgress` field lifting
  the **yield** of every converter producing into the island
  (`sim.ts: applyRefinementMultiplier`, `converterEffectiveRatio`; the solver builds each
  converter edge at the boosted ratio, so dst inflow, water-fill, and `converterFeed`
  agree — more refined output per input, source draw unchanged). Serialized on
  `IslandProgress` (SAVE_VERSION 6, v5→v6 backfills identity), so it survives round-trip
  and offline catch-up like the extraction multiplier.
- **Shipped (vertical slice):** **branch depth** — three authored nodes past each
  mastery (levels 6–8 on an extended XP ladder), pure content in
  `world.ts: HOME_SKILL_TREE`. Both branches ship as a single **linear** chain, not yet
  the multiple sub-paths the branch list above envisions: extraction depth is throughput
  multipliers (the deposit-longevity sub-path waits for a longevity effect type);
  refinement depth is converter-yield multipliers whose product keeps effective yield
  below 1 ingot/ore (no mass minted — asserted behaviorally by test, not by a comment).
  Costs climb the storage ladder per the accepted cost↔storage coupling; refinement rungs
  are paid partly in iron (the branch's own output funds its upgrades), though their
  wood/stone components still gate on a storage upgrade like extraction.

All tree content is app-authored data over generic core primitives (timed-unlock
queue, XP accumulator, gate predicates) — reconfigurable via content edits +
`WORLD_CONTENT_VERSION` upgrade steps, no engine change.

## Arc & scale

- **Bounded per-island numbers** (human-readable; no bignum).
- **Soft-infinite expedition tiers**: farther/richer archipelago rings unlock
  indefinitely via generator tables. Each tier should be anchored by a small capstone
  unlock (landmark building, new mechanic) so rings don't feel like reskins.

## Technical decisions

- **Stack**: TypeScript (strict, ESM), Vite, React for panels/tree UI, **PixiJS**
  canvas for islands/world map. Vitest for tests.
- **Headless simulation core**: game logic is a pure TS package, UI-independent and
  fully unit-testable.
- **Event-driven analytic core, no fixed timestep**: state between events is a
  closed-form function of time; `advance(t)` jumps event-to-event (warehouse fills,
  deposit crosses floor, voyage resolves), `query(t)` evaluates exact amounts for
  rendering — no accumulator, no interpolation. A 16 ms frame, a backgrounded tab,
  and a multi-day absence are one code path, so online and offline share one math
  core by construction. New mechanics must pass the analytic litmus test. Full
  rationale and companion decisions (EC data model, clock, RNG, UI binding,
  persistence): [ADR-0001](docs/adr-0001-game-loop-and-state-model.md).
- **Offline progress is full-fidelity**: same rules as online, warehouses fill and jam.
  No reduced offline rates, no time banking.
- **Local-first persistence**: one serializable save document in IndexedDB with
  export/import. Schema designed so optional cloud sync can bolt on later.
- **State migrations vs. content upgrades are separate concerns**: core `migrateDocument`
  preserves _state_ only (schema-shape bumps, content-agnostic). Injecting new _content_
  into existing saves (new buildings, demo-world changes) is an app concern — a versioned
  `restoreWorld` (`packages/app/src/sim/world.ts`) runs ordered upgrade steps through the
  normal command surface after offline catch-up, so new content reaches live saves without
  a reset and every core invariant still holds. Every future demo-world content change
  ships with an upgrade step + a `WORLD_CONTENT_VERSION` bump. Steps are idempotent
  (saves written by a step's own introducing commit predate the version stamp) and
  failure-tolerant (a failing step logs and degrades to missing content — never a save
  reset); `contentVersion` is validated at the restore boundary, and a re-save never
  stamps below the version a newer app wrote (stale service-worker bundles). **One-time
  exception**: the wood/stone pivot (base economy redefined from scratch) is too large to
  express as an upgrade step, so `restoreWorld` detects the legacy ore/ingot envelope and
  discards it into the quarantine path once. This is a blessed exception for pre-release
  placeholder content only; the no-reset rule stands for all future changes.
- **One-time exception (second)**: the one-pool-per-island refactor (warehouses merged from
  per-deposit into a single pool per island per resource) redefined the warehouse invariant.
  Pre-pool saves carry two same-typed warehouses on one island and so fail the new invariant
  at the core import boundary (`deserializeState`); the existing restore path quarantines them
  and boots a fresh world. Blessed for pre-release placeholder content only, on the same terms
  as the wood/stone pivot above; the no-reset rule still binds all future changes.
- **Islands are procedural from hand-authored parts**: generator assembles shapes,
  biomes, slot layouts, and distance-scaled deposit tables from a template library.
  Story islands hand-placed at milestones.
- Assets: partially generated, 2.5D layered sprites. Pipeline TBD when art work starts.

## First milestone — vertical slice

Test every pillar at minimum depth; if this isn't fun, content won't fix it.

- 1 starting island + 2–3 discoverable islands
- ~8 resources, one refinement tier. **Tier-0 base is wood + stone** — the bootstrap starts
  with a seeded stockpile and no extractors; deposits are worked by cost-gated builds. The
  refinement tier is now layered on top: **iron-ore → iron-ingot** via a single-island
  buildable converter (`buildConverter`), the iron-ore extractor and the refinery both paid
  in wood/stone at a cost above the seeded stockpile, so the tier genuinely gates behind a
  base-economy surplus — the base extractors must be running before any iron build is
  affordable (also what makes the t=0 "refinery first" soft-lock unreachable).
- **Building bootstrap** — the early game is building extractors: cross-resource costs
  (a wood extractor is paid in stone and vice versa) gate later builds behind accumulation.
  Now extends to buildable/costed converters (the iron refinery) and to tiered island-warehouse
  capacity upgrades (`upgradeIslandCapacity`, island-level — one upgrade lifts all the island's
  pool caps) through the same cost layer;
  buildable/costed routes wait for inter-island work (a same-resource route is inter-island
  by construction under the one-pool invariant).
- ~20-node research tree + island skill trees (shared trunk + Extraction/Refinement
  branches, 3–4 nodes each) with one exclusive, research-gated specialization junction
- Expeditions with outfitting + one mid-voyage decision point
- Warehouses, caps, transport routes
- Full offline catch-up
- Placeholder art (colored shapes on a static island image)

## Open items

- Name; concrete resource/biome list (vertical slice forces these). Tier-0 base settled as
  wood + stone and the first refinement tier as iron-ore → iron-ingot; the rest of the
  ~8-resource set is still open.
- Asset-generation tooling.
- Tuning constants: depletion curves, cap sizes — playtest territory, under the
  tight-caps pacing principle (core loop, idle half).

## Standing risk

**Hybrid decay**: if expedition outfitting gets trivialized by resource surplus, the
active half degenerates into a timer and the game collapses into pure idle. The
resource-sample research gates are the main defense — protect them during balancing.
Tight warehouse caps (core loop, idle half) are the second: bounded stockpiles keep
surplus from ever getting deep enough to trivialize outfitting.
