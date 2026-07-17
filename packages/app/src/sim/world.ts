import {
  addDeposit,
  addWarehouse,
  advance,
  buildConverter as buildConverterCmd,
  buildExtractor as buildExtractorCmd,
  createSimState,
  deserializeState,
  forEachConverter,
  forEachExtractor,
  forEachWarehouse,
  getDeposit,
  getWarehouse,
  grantResource,
  InsufficientStockError,
  offlineElapsedSeconds,
  islandId,
  resourceType,
  serializeState,
  upgradeIslandCapacity as upgradeIslandCapacityCmd,
  type Id,
  type IslandId,
  type ResourceType,
  type SaveDocument,
  type SimState,
} from "@fathomrest/core";

// Placeholder archipelago scene. Built entirely through the core command surface at
// t=0, so the ticker just advances forward from epoch 0. Pure core calls — no
// React/Pixi here (core stays UI-agnostic).
export interface DemoWorld {
  state: SimState;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly Deposit[];
  converterSites: readonly ConverterSite[];
  // Content revision this world is at — WORLD_CONTENT_VERSION after createDemoWorld or a
  // fully-upgraded restore; lower when an upgrade step failed (the version is stamped per
  // successful step, so the next restore retries the failed one); higher when a newer app
  // wrote the loaded save. snapshotWorld stamps this (never a lower constant), so a stale
  // service-worker-pinned bundle can't downgrade a newer save's version and trick it into
  // re-running the newer app's steps.
  contentVersion: number;
}

// A deposit and everything the app needs to offer it as a build site: the core deposit id,
// the resource pool an extractor would fill (shared by every deposit of the same resource on
// the island — one pool per (island, resource)), and the build price/rate. This unifies
// "deposit" and "build site" — a deposit IS the thing you build an extractor on. Whether a
// deposit is worked is re-derivable from core state (an extractor wired to it), but the
// deposit->pool pairing and price are not, so they are carried and persisted. `cost` is serializable entries (a Map is built when the
// core command is called) matching what the core buildExtractor cost vector expects.
export interface Deposit {
  readonly id: Id;
  readonly warehouseId: Id;
  readonly label: string;
  readonly resource: ResourceType;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly rate: number;
  // The island whose stockpile funds building this deposit's extractor — the site's island. For a
  // same-island pool this equals getWarehouse(warehouseId).islandId; it differs only when the output
  // pool is global-scoped (a knowledge observatory sits on and is paid from home while filling the
  // global knowledge pool). Always present at runtime; pre-knowledge saves lack it, so
  // restoreWorld backfills it from the pool (SavedDeposit).
  readonly payIslandId: IslandId;
}

// A buildable converter (refinement recipe) and everything the app needs to offer it as a
// build site: the source pool it draws from, the destination pool it fills with the refined
// type, the build price, and the converter's own cap/ratio. Unlike a Deposit, no core id is
// carried — the converter doesn't exist until built; "built" is re-derived by matching a live
// converter's (src, dst) pair (isConverterBuilt), so it survives a save round-trip without a
// flag. That makes the (src, dst) pair the site's identity: at most ONE site per pool pair —
// a second recipe on the same pair would flip "built" for both, so it needs a real site id
// first. Both pools sit on one island (buildConverter is single-island), which is the island
// the cost is charged against. `cost` is serializable entries matching the core cost vector.
export interface ConverterSite {
  readonly srcWarehouseId: Id;
  readonly dstWarehouseId: Id;
  readonly label: string;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly cap: number;
  readonly ratio: number;
}

// Deposit as persisted: payIslandId is absent on pre-knowledge saves (it always equalled the
// pool's island then), so restoreWorld backfills it before the world is built.
export type SavedDeposit = Omit<Deposit, "payIslandId"> & { readonly payIslandId?: IslandId };

// App-level save envelope: the canonical core document plus the UI view model (warehouse
// labels, deposit build-sites, converter build-sites) the core doesn't carry. Persisted as-is
// (persistence.ts). Kept separate from the core SaveDocument so the sim's serialization never
// depends on presentation.
export interface SavedWorld {
  doc: SaveDocument;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly SavedDeposit[];
  // Absent on a pre-iron-tier save (contentVersion 1); restoreWorld defaults it to [] before
  // the upgrade step injects the iron refinery.
  converterSites?: readonly ConverterSite[];
  // App content revision this envelope was written at. Absent on a pre-versioning save
  // (treated as 1). Bumped whenever a WORLD_UPGRADES step is added, so restoreWorld can
  // raise older saves to current.
  contentVersion?: number;
}

const EXTRACTOR_RATE = 1; // units/s an extractor produces once built
const WAREHOUSE_CAP = 100;
const STARTING_STOCK = 30; // seeded into each resource's pool at t=0
const BUILD_COST = 20; // paid in the *other* resource
// Iron builds (extractor and refinery) each cost this much wood AND stone. Deliberately above
// STARTING_STOCK: the seeded 30/30 can never fund an iron build, so the wood/stone extractors
// (the only income) must be running first — otherwise building the refinery first would strand
// the bootstrap at 10/10 with zero income (permanent soft-lock).
const IRON_BUILD_COST = 40;

// Demo world resources and its single starting island — module-level so createDemoWorld and
// the iron-tier upgrade step build identical content from one source.
const HOME: IslandId = islandId("home");
const WOOD = resourceType("wood");
const STONE = resourceType("stone");
const IRON_ORE = resourceType("iron-ore");
const IRON_INGOT = resourceType("iron-ingot");
// Iron refinery tuning (placeholder, DESIGN.md vertical slice): draws CONVERTER_CAP iron-ore/s
// and produces CONVERTER_RATIO iron-ingot per iron-ore.
const CONVERTER_CAP = 2;
const CONVERTER_RATIO = 0.5;

const KNOWLEDGE = resourceType("knowledge");
// Knowledge is the first GLOBAL-scoped resource (DESIGN.md Progression/Knowledge): a single
// shared pool with its own cap, not an island pool. It lives on a distinguished GLOBAL scope so
// (a) future islands' observatories all feed one pool and (b) its cap stays out of the island
// storage ladder — upgradeIslandCapacity is per-island; knowledge's cap is research-gated later.
const GLOBAL: IslandId = islandId("global");
const KNOWLEDGE_CAP = 100; // placeholder; raised by research later, never by the storage ladder
// The tier-0 observatory is cost-gated only (wood/stone), above STARTING_STOCK like the iron
// builds so the base economy must already be running (DESIGN.md: the bootstrap into research).
const OBSERVATORY_COST = 40;

// True for the distinguished global scope: its pools sit outside every per-island system —
// the storage ladder today, island XP later. Island-enumerating features must filter through
// this predicate rather than re-deriving the exclusion.
export function isGlobalScope(island: IslandId): boolean {
  return island === GLOBAL;
}

// One rung of the storage-upgrade ladder: raise a pool's capacity to `capacity` for `cost`.
export interface StorageTier {
  readonly capacity: number;
  readonly cost: readonly (readonly [ResourceType, number])[];
}

// The island-warehouse upgrade ladder (placeholder tuning, DESIGN.md vertical slice): each rung
// raises every pool on an island to `capacity` from the WAREHOUSE_CAP base, paid in wood/stone
// like every other build. Storage is island-level, so one rung lifts all the island's caps
// together (including the wood/stone cost pools). The current rung isn't stored — it's derived
// from the island's live pool caps (core is source of truth, like isExtractorBuilt), so it
// round-trips without a persisted index; the next offered rung is the first above what the
// island holds now. Each rung's cost stays under the previous rung's cap so it's reachable once
// the one before it is bought (DESIGN.md: build costs coupled to storage progression).
const STORAGE_TIERS: readonly StorageTier[] = [
  {
    capacity: 250,
    cost: [
      [WOOD, 40],
      [STONE, 40],
    ],
  },
  {
    capacity: 500,
    cost: [
      [WOOD, 150],
      [STONE, 150],
    ],
  },
  {
    capacity: 1000,
    cost: [
      [WOOD, 350],
      [STONE, 350],
    ],
  },
];

// The rich vein every demo deposit shares: a 500-unit tier at ×2 depleting to a 0.5 perpetual
// floor (mirrors the earlier placeholder).
function addDemoDeposit(
  state: SimState,
  t: number,
  resource: ResourceType,
  warehouseId: Id,
  label: string,
  cost: readonly (readonly [ResourceType, number])[],
  payIslandId: IslandId,
): Deposit {
  const id = addDeposit(state, t, resource, [{ amount: 500, multiplier: 2 }], 0.5);
  return { id, warehouseId, label, resource, cost, rate: EXTRACTOR_RATE, payIslandId };
}

// The cap a NEW pool takes when a content step lands it on an existing island: the island's
// current storage rung (min cap across its pools, matching nextStorageTier's derivation). A
// content tier added to an already-upgraded save then arrives at the island's rung instead of
// resetting the ladder to rung 1 and re-charging rungs the player already bought. Base cap on an
// island with no pools yet (fresh world).
function islandStorageCap(state: SimState, island: IslandId): number {
  let cap = Infinity;
  forEachWarehouse(state, (_id, warehouse) => {
    if (warehouse.islandId === island) cap = Math.min(cap, warehouse.capacity);
  });
  return cap === Infinity ? WAREHOUSE_CAP : cap;
}

// The iron refinement tier layered on the wood/stone base: an iron-ore pool worked by two
// cost-gated deposits, an iron-ingot pool, and a refinery converter site (iron-ore -> iron-ingot,
// paid in wood/stone). Built at epoch t through the core surface and returned as envelope view
// models. Shared by createDemoWorld (t=0) and the v1->v2 upgrade step, so a fresh world and an
// upgraded save get identical iron content.
function addIronTier(
  state: SimState,
  t: number,
): {
  warehouses: { id: Id; label: string }[];
  deposits: Deposit[];
  converterSites: ConverterSite[];
} {
  const poolCap = islandStorageCap(state, HOME);
  const ironOrePool = addWarehouse(state, t, IRON_ORE, HOME, poolCap);
  const ironIngotPool = addWarehouse(state, t, IRON_INGOT, HOME, poolCap);
  // Iron-ore extractors and the refinery are both paid in wood/stone (IRON_BUILD_COST each,
  // above the seeded stock), gating the tier behind a base-economy surplus.
  const ironCost: readonly (readonly [ResourceType, number])[] = [
    [WOOD, IRON_BUILD_COST],
    [STONE, IRON_BUILD_COST],
  ];
  return {
    warehouses: [
      { id: ironOrePool, label: "Iron Ore" },
      { id: ironIngotPool, label: "Iron Ingot" },
    ],
    deposits: [
      addDemoDeposit(state, t, IRON_ORE, ironOrePool, "Iron Ore A vein", ironCost, HOME),
      addDemoDeposit(state, t, IRON_ORE, ironOrePool, "Iron Ore B vein", ironCost, HOME),
    ],
    converterSites: [
      {
        srcWarehouseId: ironOrePool,
        dstWarehouseId: ironIngotPool,
        label: "Iron Refinery",
        cost: ironCost,
        cap: CONVERTER_CAP,
        ratio: CONVERTER_RATIO,
      },
    ],
  };
}

// The knowledge tier layered on the wood/stone base (DESIGN.md Progression): a global-scoped
// knowledge pool worked by a cost-gated observatory on the home island. Built through the core
// surface at epoch t; shared by createDemoWorld (t=0) and the v2->v3 upgrade step so a fresh world
// and an upgraded save get identical knowledge content. No converterSites — knowledge is extracted,
// not refined (goods->knowledge labs are a later addition).
function addKnowledgeTier(
  state: SimState,
  t: number,
): {
  warehouses: { id: Id; label: string }[];
  deposits: Deposit[];
} {
  // The pool sits on GLOBAL with its own cap (not islandStorageCap): global scope is outside the
  // island storage ladder, so it never seeds from or advances an island's rung.
  const knowledgePool = addWarehouse(state, t, KNOWLEDGE, GLOBAL, KNOWLEDGE_CAP);
  const observatoryCost: readonly (readonly [ResourceType, number])[] = [
    [WOOD, OBSERVATORY_COST],
    [STONE, OBSERVATORY_COST],
  ];
  // Site island is HOME (where the observatory is built and paid); the output pool is GLOBAL.
  return {
    warehouses: [{ id: knowledgePool, label: "Knowledge" }],
    deposits: [
      addDemoDeposit(
        state,
        t,
        KNOWLEDGE,
        knowledgePool,
        "Knowledge deposit",
        observatoryCost,
        HOME,
      ),
    ],
  };
}

export function createDemoWorld(seed: number, wallTimeMs: number): DemoWorld {
  const state = createSimState(seed, wallTimeMs);

  // Cross-dependency: a wood extractor is paid in stone and vice versa, so the first builds
  // spend the starting stockpile and later ones must wait for the extractors already running
  // to replenish it. All numbers here are placeholder tuning (DESIGN.md vertical slice).
  const woodCost: readonly (readonly [ResourceType, number])[] = [[STONE, BUILD_COST]];
  const stoneCost: readonly (readonly [ResourceType, number])[] = [[WOOD, BUILD_COST]];

  // One pool per (island, resource) — a single Wood pool and a single Stone pool (core
  // invariant, sim.ts addWarehouse). Every extractor of a resource feeds its one pool, so two
  // wood veins make the Wood bar fill twice as fast rather than filling two separate bars.
  const woodPool = addWarehouse(state, 0, WOOD, HOME, WAREHOUSE_CAP);
  const stonePool = addWarehouse(state, 0, STONE, HOME, WAREHOUSE_CAP);

  // Two deposits per resource, all unworked (no extractor), each feeding its resource's shared
  // pool. Building the first of each is affordable from the starting stockpile; the others gate
  // behind accumulation.
  const woodA = addDemoDeposit(state, 0, WOOD, woodPool, "Wood A vein", woodCost, HOME);
  const woodB = addDemoDeposit(state, 0, WOOD, woodPool, "Wood B vein", woodCost, HOME);
  const stoneA = addDemoDeposit(state, 0, STONE, stonePool, "Stone A vein", stoneCost, HOME);
  const stoneB = addDemoDeposit(state, 0, STONE, stonePool, "Stone B vein", stoneCost, HOME);

  // Starting stockpile: enough to build one wood + one stone extractor (BUILD_COST each),
  // leaving a remainder the next builds must wait for the new extractors to top back up.
  grantResource(state, 0, woodPool, STARTING_STOCK);
  grantResource(state, 0, stonePool, STARTING_STOCK);

  const iron = addIronTier(state, 0);
  const knowledge = addKnowledgeTier(state, 0);

  return {
    state,
    warehouses: [
      { id: woodPool, label: "Wood" },
      { id: stonePool, label: "Stone" },
      ...iron.warehouses,
      ...knowledge.warehouses,
    ],
    deposits: [woodA, woodB, stoneA, stoneB, ...iron.deposits, ...knowledge.deposits],
    converterSites: iron.converterSites,
    contentVersion: WORLD_CONTENT_VERSION,
  };
}

// Content upgrades: each step raises a restored world from content version index+1 to
// index+2 using core commands at the current epoch, and appends any new envelope view models
// the core doesn't carry. restoreWorld gates them by contentVersion. WORLD_CONTENT_VERSION is
// derived from the list — adding a step bumps the version by construction, and createDemoWorld
// builds at the current version already.
const WORLD_UPGRADES: readonly ((world: DemoWorld, t: number) => DemoWorld)[] = [
  // v1 -> v2: layer the iron refinement tier onto a pre-iron wood/stone save. Injected through
  // the same core commands createDemoWorld uses, at the restore-time epoch, so the new pools and
  // deposits never retroactively produce across the offline gap.
  (world, t): DemoWorld => {
    const iron = addIronTier(world.state, t);
    return {
      ...world,
      warehouses: [...world.warehouses, ...iron.warehouses],
      deposits: [...world.deposits, ...iron.deposits],
      converterSites: [...world.converterSites, ...iron.converterSites],
    };
  },
  // v2 -> v3: layer the global knowledge tier onto a wood/stone+iron save. Same core commands as
  // createDemoWorld, at the restore-time epoch, so the pool and deposit never retroactively produce
  // across the offline gap.
  (world, t): DemoWorld => {
    const knowledge = addKnowledgeTier(world.state, t);
    return {
      ...world,
      warehouses: [...world.warehouses, ...knowledge.warehouses],
      deposits: [...world.deposits, ...knowledge.deposits],
    };
  },
];
export const WORLD_CONTENT_VERSION = WORLD_UPGRADES.length + 1;

export function snapshotWorld(world: DemoWorld): SavedWorld {
  return {
    doc: serializeState(world.state),
    warehouses: world.warehouses,
    deposits: world.deposits,
    converterSites: world.converterSites,
    contentVersion: world.contentVersion,
  };
}

// Whether an extractor has already been built on this deposit — the source of truth is core
// state (a producer wired to the deposit), so it survives a save round-trip without a flag.
export function isExtractorBuilt(world: DemoWorld, depositId: Id): boolean {
  let built = false;
  forEachExtractor(world.state, (_id, extractor) => {
    if (extractor.depositId === depositId) built = true;
  });
  return built;
}

// Whether the refinery on this (src, dst) pool pair has already been built — source of truth is
// a live converter in core state, so it survives a save round-trip without a flag.
export function isConverterBuilt(world: DemoWorld, srcId: Id, dstId: Id): boolean {
  let built = false;
  forEachConverter(world.state, (_id, converter) => {
    if (converter.srcId === srcId && converter.dstId === dstId) built = true;
  });
  return built;
}

// Build an extractor on a deposit at sim time t, paying its cost from the island's stock (core
// buildExtractor advances to t, debits, then wires the producer, so income begins exactly at t).
// Idempotent per deposit; returns false if already built, unknown, or the cost can't be met yet
// (the UI disables the button until canAffordBuild — this is the backstop).
export function buildExtractor(world: DemoWorld, depositId: Id, t: number): boolean {
  const deposit = world.deposits.find((d) => d.id === depositId);
  if (deposit === undefined || isExtractorBuilt(world, depositId)) return false;
  try {
    buildExtractorCmd(
      world.state,
      t,
      new Map(deposit.cost),
      deposit.rate,
      deposit.id,
      deposit.warehouseId,
      deposit.payIslandId,
    );
    return true;
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
}

// Build the refinery converter for a site at sim time t, paying its cost from the island's stock
// (core buildConverter advances to t, debits, then wires the converter, so refining begins at t).
// Idempotent per (src, dst) pair; returns false if already built or the cost can't be met yet
// (the UI disables the button until canAffordBuild — this is the backstop).
export function buildConverter(world: DemoWorld, site: ConverterSite, t: number): boolean {
  if (isConverterBuilt(world, site.srcWarehouseId, site.dstWarehouseId)) return false;
  try {
    buildConverterCmd(
      world.state,
      t,
      new Map(site.cost),
      site.srcWarehouseId,
      site.dstWarehouseId,
      site.cap,
      site.ratio,
    );
    return true;
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
}

// The distinct islands present in the world, derived from the pools (core is source of truth).
// One island = one upgradable warehouse (storage is island-level, not per resource pool).
export function worldIslands(world: DemoWorld): readonly IslandId[] {
  const seen = new Set<IslandId>();
  for (const wh of world.warehouses) {
    // The GLOBAL scope (knowledge) has no island storage ladder — its cap is research-gated, not
    // raised by upgradeIslandCapacity — so it never yields a storage-upgrade button.
    const island = getWarehouse(world.state, wh.id).islandId;
    if (!isGlobalScope(island)) seen.add(island);
  }
  return [...seen];
}

// The next storage upgrade an island can buy, or undefined at max tier. Derived from the island's
// live pool caps (core is source of truth), so it survives a round-trip without a persisted index:
// the first ladder rung above the island's smallest pool cap (min, so a lagging pool — e.g. one a
// later content tier added at the base cap — is pulled up before the ladder advances).
export function nextStorageTier(world: DemoWorld, island: IslandId): StorageTier | undefined {
  let currentCap = Infinity;
  // Called per frame from the storage-button update — indexed loops, no closures
  // (browser-performance.md: the frame loop must not allocate).
  for (let i = 0; i < world.warehouses.length; i++) {
    const wh = world.warehouses[i];
    if (wh === undefined) continue;
    const warehouse = getWarehouse(world.state, wh.id);
    if (warehouse.islandId === island) currentCap = Math.min(currentCap, warehouse.capacity);
  }
  if (currentCap === Infinity) return undefined; // no pools on this island
  for (let i = 0; i < STORAGE_TIERS.length; i++) {
    const tier = STORAGE_TIERS[i];
    if (tier !== undefined && tier.capacity > currentCap) return tier;
  }
  return undefined;
}

// Upgrade an island's storage to its next tier at sim time t, paying the tier cost from that
// island (core upgradeIslandCapacity advances to t, debits once, then raises every island pool's
// cap in one command). Returns false if already at max tier or the cost can't be met yet (the UI
// disables the button until canAffordBuild — this is the backstop).
export function upgradeStorage(world: DemoWorld, island: IslandId, t: number): boolean {
  const tier = nextStorageTier(world, island);
  if (tier === undefined) return false;
  try {
    upgradeIslandCapacityCmd(world.state, t, new Map(tier.cost), island, tier.capacity);
    return true;
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
}

// Rebuild a world from a save, folding the wall-clock gap since save into sim time
// (offline catch-up, ADR-0001 §4). The saved (epoch, wallTime) pair stays a valid anchor
// afterward — the next save re-stamps wallTime — so wallTime is left as-is here.
export function restoreWorld(saved: SavedWorld, nowMs: number): DemoWorld {
  // One-time reset: legacy ore/ingot envelopes carried a singular `buildSite`; the wood/stone
  // envelope never does, so its presence marks a pre-pivot save. Throw so the caller quarantines
  // it and boots a fresh world — a blessed exception to the no-reset rule, since the discarded
  // content was pre-release placeholder (DESIGN.md).
  if ("buildSite" in saved) {
    throw new Error("legacy ore/ingot save format; discarding for the wood/stone world");
  }
  // contentVersion crosses an untrusted boundary (IndexedDB today, export/import later).
  // A malformed value must fail loud into the caller's quarantine path — a negative
  // number would otherwise walk the whole numeric range, a fractional one silently skip
  // steps and then get stamped current, losing the content forever.
  const savedVersion = saved.contentVersion ?? 1; // absent: save predates versioning
  if (!Number.isSafeInteger(savedVersion) || savedVersion < 1) {
    throw new Error(`invalid save contentVersion: ${String(saved.contentVersion)}`);
  }
  const state = deserializeState(saved.doc);
  // The envelope's view models cross the same untrusted boundary: every core id they carry
  // must resolve in the deserialized state, or we fail loud into the caller's quarantine path
  // now — a dangling id would otherwise crash the readout on every reload with the bad save
  // still in place.
  const islands = new Set<IslandId>();
  forEachWarehouse(state, (_id, warehouse) => islands.add(warehouse.islandId));
  const deposits: Deposit[] = saved.deposits.map((deposit) => {
    getDeposit(state, deposit.id);
    const pool = getWarehouse(state, deposit.warehouseId);
    // A carried payIslandId must name an island the doc holds — a bogus one would not crash,
    // just leave the build forever "unaffordable" (silent soft-lock), so fail loud here instead.
    if (deposit.payIslandId !== undefined && !islands.has(deposit.payIslandId)) {
      throw new Error(`no island ${deposit.payIslandId} for deposit ${deposit.id}`);
    }
    // Backfill for pre-knowledge saves: payIslandId always equalled the pool's island then.
    return { ...deposit, payIslandId: deposit.payIslandId ?? pool.islandId };
  });
  for (const site of saved.converterSites ?? []) {
    getWarehouse(state, site.srcWarehouseId);
    getWarehouse(state, site.dstWarehouseId);
  }
  advance(state, state.epoch + offlineElapsedSeconds(nowMs, state.wallTime));
  let world: DemoWorld = {
    state,
    warehouses: saved.warehouses,
    deposits,
    converterSites: saved.converterSites ?? [], // absent on a pre-iron-tier (v1) save
    contentVersion: savedVersion,
  };
  // Content upgrades run after offline catch-up (design decision 3): new structures are
  // wired at the restore-time epoch via commands, so they never retroactively produce
  // across the offline gap. A save at (or past) the current version runs no steps, so a
  // newer app's save keeps its higher version — re-saving on this stale bundle never
  // downgrades it into re-running the newer app's steps later. The version is stamped per
  // SUCCESSFUL step: a failing step logs, keeps the version where it was, and skips the
  // remaining steps (they assume its content), so the next restore retries — a content gap
  // is recoverable, quarantining (= resetting) a working save is not.
  const steps = WORLD_UPGRADES.slice(savedVersion - 1);
  for (const [index, step] of steps.entries()) {
    try {
      world = { ...step(world, world.state.epoch), contentVersion: savedVersion + index + 1 };
    } catch (error) {
      console.warn("World content upgrade step failed; retrying on the next restore.", error);
      break;
    }
  }
  return world;
}
