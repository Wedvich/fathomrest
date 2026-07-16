import {
  addConverter,
  addDeposit,
  addExtractor,
  buildExtractor as buildExtractorCmd,
  addRoute,
  addWarehouse,
  advance,
  createSimState,
  deserializeState,
  forEachExtractor,
  offlineElapsedSeconds,
  islandId,
  resourceType,
  serializeState,
  setWarehousePullRate,
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
  deposits: readonly { id: Id; label: string }[];
  buildSite: BuildSite;
  // Content revision this world is at — WORLD_CONTENT_VERSION after createDemoWorld or
  // an upgraded restore, higher when a newer app wrote the loaded save. snapshotWorld
  // stamps this (never a lower constant), so a stale service-worker-pinned bundle can't
  // downgrade a newer save's version and trick it into re-running upgrade steps.
  contentVersion: number;
}

// The unworked deposit + its idle warehouse the player builds an extractor onto (the
// first-interaction loop test). App-level metadata: the target warehouse has no producer
// until built, so it can't be re-derived from core state — it is carried and persisted.
export interface BuildSite {
  readonly depositId: Id;
  readonly warehouseId: Id;
}

// App-level save envelope: the canonical core document plus the UI view model (warehouse
// labels) the core doesn't carry. Persisted as-is (persistence.ts). Kept separate from
// the core SaveDocument so the sim's serialization never depends on presentation.
export interface SavedWorld {
  doc: SaveDocument;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly { id: Id; label: string }[];
  buildSite: BuildSite;
  // App content revision this envelope was written at. Absent on a pre-versioning save
  // (treated as 1). Bumped whenever a WORLD_UPGRADES step is added, so restoreWorld can
  // raise older saves to current.
  contentVersion?: number;
}

export function createDemoWorld(seed: number, wallTimeMs: number): DemoWorld {
  const state = createSimState(seed, wallTimeMs);

  // Three resource types exercise typing end-to-end: the ore chain (Pier -> Depot route)
  // stays ore; the Quarry build site is stone; the Foundry holds ingots refined from the
  // Depot's ore. A route or extractor crossing types is rejected by the core (sim.ts).
  const ore = resourceType("ore");
  const stone = resourceType("stone");
  const ingot = resourceType("ingot");
  // Single starting island: all three warehouses share it, so a build here can spend ore
  // shipped in from the Pier/Depot but never stock parked on another island.
  const home = islandId("home");

  // Rich vein that depletes to a lean perpetual floor.
  const oreDeposit = addDeposit(state, 0, ore, [{ amount: 500, multiplier: 2 }], 0.5);

  const pierWarehouse = addWarehouse(state, 0, ore, home, 100);
  const depotWarehouse = addWarehouse(state, 0, ore, home, 200);

  addExtractor(state, 0, 5, oreDeposit, pierWarehouse);

  // Unworked vein + its idle warehouse: no extractor until the player builds one, so the
  // Quarry row sits at zero until the Build command wires a producer (buildExtractor).
  const graniteDeposit = addDeposit(state, 0, stone, [{ amount: 500, multiplier: 2 }], 0.5);
  const quarryWarehouse = addWarehouse(state, 0, stone, home, 100);

  // Pier drains a little locally and ships the surplus up the route to the depot.
  setWarehousePullRate(state, 0, pierWarehouse, 3);
  addRoute(state, 0, pierWarehouse, depotWarehouse, 4);

  // Refinement slice: a converter smelts the Depot's ore into Foundry ingots — draws up
  // to 2 ore/s, produces 1 ingot/s (ratio 0.5).
  const foundryWarehouse = addWarehouse(state, 0, ingot, home, 100);
  addConverter(state, 0, depotWarehouse, foundryWarehouse, 2, 0.5);

  return {
    state,
    warehouses: [
      { id: pierWarehouse, label: "Pier" },
      { id: depotWarehouse, label: "Depot" },
      { id: quarryWarehouse, label: "Quarry" },
      { id: foundryWarehouse, label: "Foundry" },
    ],
    deposits: [
      { id: oreDeposit, label: "Ore vein" },
      { id: graniteDeposit, label: "Granite vein" },
    ],
    buildSite: { depositId: graniteDeposit, warehouseId: quarryWarehouse },
    contentVersion: WORLD_CONTENT_VERSION,
  };
}

// Content upgrades: each step raises a restored world from content version index+1 to
// index+2 using core commands at the current epoch, and appends any new envelope view
// models (warehouse/deposit labels the core doesn't carry). restoreWorld gates them by
// contentVersion, so a step normally runs once — but saves written by the very commit
// that introduced a step's content predate the version stamp, so every step must also
// be idempotent: skip when its content is already present. WORLD_CONTENT_VERSION is
// derived from the list — adding a step bumps the version by construction.
// createDemoWorld builds at the current version already.
const WORLD_UPGRADES: readonly ((world: DemoWorld, t: number) => DemoWorld)[] = [
  upgradeV1AddFoundry,
];
export const WORLD_CONTENT_VERSION = WORLD_UPGRADES.length + 1;

// v1 -> v2: backfill the refinement slice (commit 82bdbc0) onto pre-refinement saves —
// an ingot Foundry warehouse fed by a converter smelting the Depot's ore, mirroring
// createDemoWorld. If the Depot label is missing (hand-edited save) the converter wiring
// is skipped but the version still advances: a cosmetic content gap must never throw the
// restore into the quarantine path.
function upgradeV1AddFoundry(world: DemoWorld, t: number): DemoWorld {
  // A save written by the refinement commit itself (pre-versioning) already carries the
  // Foundry — re-running the step must not duplicate it.
  if (world.warehouses.some((w) => w.label === "Foundry")) return world;
  const foundry = addWarehouse(world.state, t, resourceType("ingot"), islandId("home"), 100);
  const depot = world.warehouses.find((w) => w.label === "Depot");
  if (depot !== undefined) {
    addConverter(world.state, t, depot.id, foundry, 2, 0.5);
  }
  return {
    ...world,
    warehouses: [...world.warehouses, { id: foundry, label: "Foundry" }],
  };
}

export function snapshotWorld(world: DemoWorld): SavedWorld {
  return {
    doc: serializeState(world.state),
    warehouses: world.warehouses,
    deposits: world.deposits,
    buildSite: world.buildSite,
    contentVersion: world.contentVersion,
  };
}

// Nominal draw of the extractor the player builds at the build site.
const BUILD_EXTRACTOR_RATE = 5;

// Placeholder build price: the stone extractor is paid for in ore, drawn proportionally from
// every ore warehouse on the build site's island (Pier + Depot). Real prices arrive with the
// economy pass.
const BUILD_EXTRACTOR_COST: ReadonlyMap<ResourceType, number> = new Map([
  [resourceType("ore"), 20],
]);

export function isExtractorBuilt(world: DemoWorld): boolean {
  let built = false;
  forEachExtractor(world.state, (_id, extractor) => {
    if (extractor.depositId === world.buildSite.depositId) built = true;
  });
  return built;
}

// The first player command: place an extractor on the build site's deposit at sim time t,
// paying BUILD_EXTRACTOR_COST from the island's ore stock (core buildExtractor advances to t,
// debits, then wires the producer, so income begins exactly at t). Idempotent; returns false
// if already built or the cost can't be met yet (placeholder for an affordability-gated
// button — the real UI will disable Build until the island can pay).
export function buildExtractor(world: DemoWorld, t: number): boolean {
  if (isExtractorBuilt(world)) return false;
  try {
    buildExtractorCmd(
      world.state,
      t,
      BUILD_EXTRACTOR_COST,
      BUILD_EXTRACTOR_RATE,
      world.buildSite.depositId,
      world.buildSite.warehouseId,
    );
    return true;
  } catch {
    return false; // insufficient stock on the island — retry once ore has accrued
  }
}

// Rebuild a world from a save, folding the wall-clock gap since save into sim time
// (offline catch-up, ADR-0001 §4). The saved (epoch, wallTime) pair stays a valid anchor
// afterward — the next save re-stamps wallTime — so wallTime is left as-is here.
export function restoreWorld(saved: SavedWorld, nowMs: number): DemoWorld {
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
    buildSite: saved.buildSite,
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
