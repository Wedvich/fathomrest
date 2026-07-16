import {
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  advance,
  createSimState,
  islandId,
  resourceType,
  serializeState,
  setWarehousePullRate,
  warehouseAmountAt,
} from "@fathomrest/core";
import { describe, expect, it } from "vitest";

import {
  buildExtractor,
  createDemoWorld,
  isExtractorBuilt,
  restoreWorld,
  snapshotWorld,
  WORLD_CONTENT_VERSION,
  type SavedWorld,
} from "./world.ts";

// The first-interaction loop test as a scenario: the build site is idle until the player
// builds, building starts income at the command time, and the mutation survives a
// save/reload round-trip (structuredClone stands in for IndexedDB's structured clone,
// mirroring persistence.ts). Drives the real core commands, no mocks.
describe("build-extractor interaction", () => {
  it("quarry stays idle until an extractor is built", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    advance(world.state, 60);

    expect(isExtractorBuilt(world)).toBe(false);
    expect(warehouseAmountAt(world.state, quarry, 60)).toBe(0);
  });

  it("building starts income from the command time", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    advance(world.state, 20);
    buildExtractor(world, 20);

    expect(isExtractorBuilt(world)).toBe(true);
    // rate 5 * tier multiplier 2 = 10/s, 10s elapsed since the t=20 build.
    expect(warehouseAmountAt(world.state, quarry, 30)).toBeCloseTo(100, 9);
  });

  it("is idempotent — a second build does not add a second extractor", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    buildExtractor(world, 10);
    buildExtractor(world, 20);

    // A duplicate producer would double the draw; capacity is 100, so 10/s fills in 10s.
    expect(warehouseAmountAt(world.state, quarry, 30)).toBeCloseTo(100, 9);
  });

  it("survives a save/reload round-trip", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    advance(world.state, 15);
    buildExtractor(world, 15);
    world.state.wallTime = 0;

    const saved = structuredClone(snapshotWorld(world));
    const restored = restoreWorld(saved, 0); // now == wallTime: no offline gap

    expect(isExtractorBuilt(restored)).toBe(true);
    expect(restored.deposits).toEqual(world.deposits);
    advance(restored.state, 20);
    expect(warehouseAmountAt(restored.state, quarry, 20)).toBeCloseTo(50, 9);
  });
});

// Content upgrades on restore: a pre-refinement save (no Foundry, no converter, no
// contentVersion field) gains the refinement slice when loaded — exactly once, and
// without touching a save already at the current version. Real core commands + the app
// restore path, no mocks.
describe("content upgrades on restore", () => {
  // A save shaped like the pre-refinement world (state before commit 82bdbc0): three
  // warehouses, no converter, and no contentVersion field (optional in SavedWorld, so
  // the literal types directly). Built through the core commands the old createDemoWorld
  // used.
  function preRefinementSave(): SavedWorld {
    const state = createSimState(1, 0);
    const ore = resourceType("ore");
    const stone = resourceType("stone");
    const home = islandId("home");

    const oreDeposit = addDeposit(state, 0, ore, [{ amount: 500, multiplier: 2 }], 0.5);
    const pier = addWarehouse(state, 0, ore, home, 100);
    const depot = addWarehouse(state, 0, ore, home, 200);
    addExtractor(state, 0, 5, oreDeposit, pier);
    const granite = addDeposit(state, 0, stone, [{ amount: 500, multiplier: 2 }], 0.5);
    const quarry = addWarehouse(state, 0, stone, home, 100);
    setWarehousePullRate(state, 0, pier, 3);
    addRoute(state, 0, pier, depot, 4);
    state.wallTime = 0;

    return {
      doc: serializeState(state),
      warehouses: [
        { id: pier, label: "Pier" },
        { id: depot, label: "Depot" },
        { id: quarry, label: "Quarry" },
      ],
      deposits: [
        { id: oreDeposit, label: "Ore vein" },
        { id: granite, label: "Granite vein" },
      ],
      buildSite: { depositId: granite, warehouseId: quarry },
    }; // no contentVersion: a pre-refinement save predates the field
  }

  it("backfills the Foundry and a producing converter onto a pre-refinement save", () => {
    const restored = restoreWorld(preRefinementSave(), 0); // now == wallTime: no offline gap

    const foundry = restored.warehouses.find((w) => w.label === "Foundry");
    expect(foundry).toBeDefined();
    if (foundry === undefined) throw new Error("Foundry not backfilled");

    // The converter smelts the Depot's ore into ingots: the Foundry, empty at restore,
    // fills over time. Assert it produces and keeps producing.
    expect(warehouseAmountAt(restored.state, foundry.id, 0)).toBe(0);
    advance(restored.state, 30);
    const at30 = warehouseAmountAt(restored.state, foundry.id, 30);
    advance(restored.state, 60);
    const at60 = warehouseAmountAt(restored.state, foundry.id, 60);
    expect(at30).toBeGreaterThan(0);
    expect(at60).toBeGreaterThan(at30);

    // Re-snapshotting stamps the current content version + exactly one converter.
    const snap = snapshotWorld(restored);
    expect(snap.contentVersion).toBe(WORLD_CONTENT_VERSION);
    expect(snap.doc.converters).toHaveLength(1);
  });

  it("is idempotent across a restore -> snapshot -> restore round-trip", () => {
    const first = snapshotWorld(restoreWorld(preRefinementSave(), 0));
    const second = snapshotWorld(restoreWorld(structuredClone(first), 0));

    // The second restore is already at the current version, so no step runs again.
    expect(second.warehouses.filter((w) => w.label === "Foundry")).toHaveLength(1);
    expect(second.doc.converters).toHaveLength(1);
  });

  it("leaves a current-version save untouched", () => {
    const saved = structuredClone(snapshotWorld(createDemoWorld(1, 0)));
    const restored = restoreWorld(saved, 0);

    // No upgrade step should run: warehouse/deposit view models are unchanged.
    expect(restored.warehouses).toEqual(saved.warehouses);
    expect(restored.deposits).toEqual(saved.deposits);
    expect(snapshotWorld(restored).doc.converters).toHaveLength(1);
  });

  it("does not duplicate the Foundry when a version-stamp-less save already has one", () => {
    // Saves written by the refinement commit itself carry the Foundry + converter in the
    // doc but no contentVersion field. The v1 step must detect the content and no-op.
    const saved = structuredClone(snapshotWorld(createDemoWorld(1, 0)));
    delete saved.contentVersion;

    const restored = restoreWorld(saved, 0);

    expect(restored.warehouses.filter((w) => w.label === "Foundry")).toHaveLength(1);
    expect(snapshotWorld(restored).doc.converters).toHaveLength(1);
  });

  it("rejects a corrupt contentVersion instead of misapplying upgrades", () => {
    for (const bad of [0, -1e15, 1.5, Number.NaN]) {
      const saved = { ...snapshotWorld(createDemoWorld(1, 0)), contentVersion: bad };
      expect(() => restoreWorld(structuredClone(saved), 0)).toThrow(/contentVersion/);
    }
  });

  it("never stamps a save below the version a newer app wrote", () => {
    // Stale service-worker-pinned bundle loading a future save: no steps run, and the
    // re-snapshot keeps the higher version so the newer app won't re-run its steps on
    // content that is already there.
    const saved = {
      ...structuredClone(snapshotWorld(createDemoWorld(1, 0))),
      contentVersion: 99,
    };
    const restored = restoreWorld(saved, 0);

    expect(restored.warehouses).toEqual(saved.warehouses);
    expect(snapshotWorld(restored).contentVersion).toBe(99);
  });

  it("skips a step's wiring instead of quarantining when its command fails", () => {
    // Hand-edited save: the "Depot"-labeled warehouse stores ingots, so the backfill's
    // addConverter rejects same-resource endpoints. Restore must survive with the wiring
    // skipped — a throw here would send a working save into the quarantine path.
    const state = createSimState(1, 0);
    const ore = resourceType("ore");
    const deposit = addDeposit(state, 0, ore, [{ amount: 500, multiplier: 2 }], 0.5);
    const depot = addWarehouse(state, 0, resourceType("ingot"), islandId("home"), 100);
    state.wallTime = 0;
    const saved: SavedWorld = {
      doc: serializeState(state),
      warehouses: [{ id: depot, label: "Depot" }],
      deposits: [{ id: deposit, label: "Ore vein" }],
      buildSite: { depositId: deposit, warehouseId: depot },
    };

    const restored = restoreWorld(saved, 0);

    expect(snapshotWorld(restored).doc.converters).toHaveLength(0);
    expect(snapshotWorld(restored).contentVersion).toBe(WORLD_CONTENT_VERSION);
  });
});
