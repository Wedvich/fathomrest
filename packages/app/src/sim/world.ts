import {
  addDeposit,
  addWarehouse,
  advance,
  buildExtractor as buildExtractorCmd,
  createSimState,
  deserializeState,
  forEachExtractor,
  grantResource,
  offlineElapsedSeconds,
  islandId,
  resourceType,
  serializeState,
  type Id,
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
  // Content revision this world is at — WORLD_CONTENT_VERSION after createDemoWorld or
  // an upgraded restore, higher when a newer app wrote the loaded save. snapshotWorld
  // stamps this (never a lower constant), so a stale service-worker-pinned bundle can't
  // downgrade a newer save's version and trick it into re-running upgrade steps.
  contentVersion: number;
}

// A deposit and everything the app needs to offer it as a build site: the core deposit id,
// the (initially producer-less) warehouse an extractor would fill, and the build price/rate.
// This unifies "deposit" and "build site" — a deposit IS the thing you build an extractor on.
// The warehouse has no producer until built, so this pairing can't be re-derived from core
// state; it is carried and persisted. `cost` is serializable entries (a Map is built when the
// core command is called) matching what the core buildExtractor cost vector expects.
export interface Deposit {
  readonly id: Id;
  readonly warehouseId: Id;
  readonly label: string;
  readonly resource: ResourceType;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly rate: number;
}

// App-level save envelope: the canonical core document plus the UI view model (warehouse
// labels, deposit build-sites) the core doesn't carry. Persisted as-is (persistence.ts). Kept
// separate from the core SaveDocument so the sim's serialization never depends on presentation.
export interface SavedWorld {
  doc: SaveDocument;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly Deposit[];
  // App content revision this envelope was written at. Absent on a pre-versioning save
  // (treated as 1). Bumped whenever a WORLD_UPGRADES step is added, so restoreWorld can
  // raise older saves to current.
  contentVersion?: number;
}

const EXTRACTOR_RATE = 1; // units/s an extractor produces once built
const WAREHOUSE_CAP = 100;
const STARTING_STOCK = 30; // seeded into each resource's "A" warehouse at t=0
const BUILD_COST = 20; // paid in the *other* resource

export function createDemoWorld(seed: number, wallTimeMs: number): DemoWorld {
  const state = createSimState(seed, wallTimeMs);

  // Tier-0 economy: wood and stone. Refinement (an ore->ingot tier) is deferred — it returns
  // later as a tier layered on these, per DESIGN.md.
  const wood = resourceType("wood");
  const stone = resourceType("stone");
  // Single starting island: every warehouse shares it, so a build spends only local stock.
  const home = islandId("home");

  // Cross-dependency: a wood extractor is paid in stone and vice versa, so the first builds
  // spend the starting stockpile and later ones must wait for the extractors already running
  // to replenish it. All numbers here are placeholder tuning (DESIGN.md vertical slice).
  const woodCost: readonly (readonly [ResourceType, number])[] = [[stone, BUILD_COST]];
  const stoneCost: readonly (readonly [ResourceType, number])[] = [[wood, BUILD_COST]];

  const makeDeposit = (
    resource: ResourceType,
    label: string,
    cost: readonly (readonly [ResourceType, number])[],
  ): Deposit => {
    // Rich vein depleting to a lean perpetual floor (mirrors the earlier placeholder).
    const id = addDeposit(state, 0, resource, [{ amount: 500, multiplier: 2 }], 0.5);
    const warehouseId = addWarehouse(state, 0, resource, home, WAREHOUSE_CAP);
    return { id, warehouseId, label, resource, cost, rate: EXTRACTOR_RATE };
  };

  // Two deposits per resource, all unworked (no extractor). Building the first of each is
  // affordable from the starting stockpile; the others gate behind accumulation.
  const woodA = makeDeposit(wood, "Wood A vein", woodCost);
  const woodB = makeDeposit(wood, "Wood B vein", woodCost);
  const stoneA = makeDeposit(stone, "Stone A vein", stoneCost);
  const stoneB = makeDeposit(stone, "Stone B vein", stoneCost);

  // Starting stockpile: enough to build one wood + one stone extractor (BUILD_COST each),
  // leaving a remainder the next builds must wait for the new extractors to top back up.
  grantResource(state, 0, woodA.warehouseId, STARTING_STOCK);
  grantResource(state, 0, stoneA.warehouseId, STARTING_STOCK);

  return {
    state,
    warehouses: [
      { id: woodA.warehouseId, label: "Wood A" },
      { id: woodB.warehouseId, label: "Wood B" },
      { id: stoneA.warehouseId, label: "Stone A" },
      { id: stoneB.warehouseId, label: "Stone B" },
    ],
    deposits: [woodA, woodB, stoneA, stoneB],
    contentVersion: WORLD_CONTENT_VERSION,
  };
}

// Content upgrades: each step raises a restored world from content version index+1 to
// index+2 using core commands at the current epoch, and appends any new envelope view models
// the core doesn't carry. restoreWorld gates them by contentVersion. WORLD_CONTENT_VERSION is
// derived from the list — adding a step bumps the version by construction, and createDemoWorld
// builds at the current version already. The list is empty after the wood/stone pivot (the old
// ore/ingot upgrade step targeted a world that no longer exists); the next demo-world content
// change adds the first new step.
const WORLD_UPGRADES: readonly ((world: DemoWorld, t: number) => DemoWorld)[] = [];
export const WORLD_CONTENT_VERSION = WORLD_UPGRADES.length + 1;

export function snapshotWorld(world: DemoWorld): SavedWorld {
  return {
    doc: serializeState(world.state),
    warehouses: world.warehouses,
    deposits: world.deposits,
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
