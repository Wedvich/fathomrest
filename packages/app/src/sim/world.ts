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
  grantResource,
  offlineElapsedSeconds,
  islandId,
  resourceType,
  serializeState,
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
  // Content revision this world is at — WORLD_CONTENT_VERSION after createDemoWorld or
  // an upgraded restore, higher when a newer app wrote the loaded save. snapshotWorld
  // stamps this (never a lower constant), so a stale service-worker-pinned bundle can't
  // downgrade a newer save's version and trick it into re-running upgrade steps.
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
}

// A buildable converter (refinement recipe) and everything the app needs to offer it as a
// build site: the source pool it draws from, the destination pool it fills with the refined
// type, the build price, and the converter's own cap/ratio. Unlike a Deposit, no core id is
// carried — the converter doesn't exist until built; "built" is re-derived by matching a live
// converter's (src, dst) pair (isConverterBuilt), so it survives a save round-trip without a
// flag. Both pools sit on one island (buildConverter is single-island), which is the island
// the cost is charged against. `cost` is serializable entries matching the core cost vector.
export interface ConverterSite {
  readonly srcWarehouseId: Id;
  readonly dstWarehouseId: Id;
  readonly label: string;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly cap: number;
  readonly ratio: number;
}

// App-level save envelope: the canonical core document plus the UI view model (warehouse
// labels, deposit build-sites, converter build-sites) the core doesn't carry. Persisted as-is
// (persistence.ts). Kept separate from the core SaveDocument so the sim's serialization never
// depends on presentation.
export interface SavedWorld {
  doc: SaveDocument;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly Deposit[];
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

// The rich vein every demo deposit shares: a 500-unit tier at ×2 depleting to a 0.5 perpetual
// floor (mirrors the earlier placeholder).
function addDemoDeposit(
  state: SimState,
  t: number,
  resource: ResourceType,
  warehouseId: Id,
  label: string,
  cost: readonly (readonly [ResourceType, number])[],
): Deposit {
  const id = addDeposit(state, t, resource, [{ amount: 500, multiplier: 2 }], 0.5);
  return { id, warehouseId, label, resource, cost, rate: EXTRACTOR_RATE };
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
  const ironOrePool = addWarehouse(state, t, IRON_ORE, HOME, WAREHOUSE_CAP);
  const ironIngotPool = addWarehouse(state, t, IRON_INGOT, HOME, WAREHOUSE_CAP);
  // Iron-ore extractors and the refinery are both paid in wood/stone, gating the tier behind
  // the base economy (the player must have a wood/stone surplus before refining begins).
  const ironCost: readonly (readonly [ResourceType, number])[] = [
    [WOOD, BUILD_COST],
    [STONE, BUILD_COST],
  ];
  return {
    warehouses: [
      { id: ironOrePool, label: "Iron Ore" },
      { id: ironIngotPool, label: "Iron Ingot" },
    ],
    deposits: [
      addDemoDeposit(state, t, IRON_ORE, ironOrePool, "Iron Ore A vein", ironCost),
      addDemoDeposit(state, t, IRON_ORE, ironOrePool, "Iron Ore B vein", ironCost),
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
  const woodA = addDemoDeposit(state, 0, WOOD, woodPool, "Wood A vein", woodCost);
  const woodB = addDemoDeposit(state, 0, WOOD, woodPool, "Wood B vein", woodCost);
  const stoneA = addDemoDeposit(state, 0, STONE, stonePool, "Stone A vein", stoneCost);
  const stoneB = addDemoDeposit(state, 0, STONE, stonePool, "Stone B vein", stoneCost);

  // Starting stockpile: enough to build one wood + one stone extractor (BUILD_COST each),
  // leaving a remainder the next builds must wait for the new extractors to top back up.
  grantResource(state, 0, woodPool, STARTING_STOCK);
  grantResource(state, 0, stonePool, STARTING_STOCK);

  const iron = addIronTier(state, 0);

  return {
    state,
    warehouses: [
      { id: woodPool, label: "Wood" },
      { id: stonePool, label: "Stone" },
      ...iron.warehouses,
    ],
    deposits: [woodA, woodB, stoneA, stoneB, ...iron.deposits],
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
    );
    return true;
  } catch {
    return false; // insufficient stock on the island — retry once resources have accrued
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
  } catch {
    return false; // insufficient stock on the island — retry once resources have accrued
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
  advance(state, state.epoch + offlineElapsedSeconds(nowMs, state.wallTime));
  let world: DemoWorld = {
    state,
    warehouses: saved.warehouses,
    deposits: saved.deposits,
    converterSites: saved.converterSites ?? [], // absent on a pre-iron-tier (v1) save
    // max: a save from a newer app keeps its higher version, so re-saving on this stale
    // bundle never downgrades it into re-running the newer app's steps later.
    contentVersion: Math.max(savedVersion, WORLD_CONTENT_VERSION),
  };
  // Content upgrades run after offline catch-up (design decision 3): new structures are
  // wired at the restore-time epoch via commands, so they never retroactively produce
  // across the offline gap. A save at (or past) the current version runs no steps. A
  // failing step logs and degrades to missing content — a content gap is recoverable,
  // quarantining (= resetting) a working save is not.
  for (const step of WORLD_UPGRADES.slice(savedVersion - 1)) {
    try {
      world = step(world, world.state.epoch);
    } catch (error) {
      console.warn("World content upgrade step failed; skipping it.", error);
    }
  }
  return world;
}
