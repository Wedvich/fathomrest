import { advance, warehouseAmountAt } from "@fathomrest/core";
import { describe, expect, it } from "vitest";

import {
  buildExtractor,
  createDemoWorld,
  type DemoWorld,
  isExtractorBuilt,
  restoreWorld,
  snapshotWorld,
  WORLD_CONTENT_VERSION,
} from "./world.ts";

// The demo world's deposits are ordered [Wood A, Wood B, Stone A, Stone B]; name them (and
// assert the shape) so the scenarios below read clearly under strict index checking.
function namedDeposits(world: DemoWorld): {
  woodA: DemoWorld["deposits"][number];
  woodB: DemoWorld["deposits"][number];
  stoneA: DemoWorld["deposits"][number];
  stoneB: DemoWorld["deposits"][number];
} {
  const [woodA, woodB, stoneA, stoneB] = world.deposits;
  if (!woodA || !woodB || !stoneA || !stoneB) throw new Error("demo world deposit shape changed");
  return { woodA, woodB, stoneA, stoneB };
}

// The wood/stone bootstrap as scenarios: the world boots with a seeded stockpile and no
// extractors, building spends the cross-resource and starts income at the command time, and
// the mutation survives a save/reload round-trip (structuredClone stands in for IndexedDB's
// structured clone, mirroring persistence.ts). Drives the real core commands, no mocks.
//
// createDemoWorld's deposits are [Wood A, Wood B, Stone A, Stone B]; only the "A" warehouses
// are seeded (30 each). A wood extractor costs 20 stone and vice versa; extractor rate 1 * the
// rich tier's multiplier 2 = 2 units/s produced once built.
describe("wood/stone build bootstrap", () => {
  it("boots with a seeded stockpile and no extractors", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, woodB, stoneA } = namedDeposits(world);

    advance(world.state, 60);

    for (const dep of world.deposits) expect(isExtractorBuilt(world, dep.id)).toBe(false);
    // Seeded warehouses hold exactly the stockpile (no producer grows it); unseeded hold 0.
    expect(warehouseAmountAt(world.state, woodA.warehouseId, 60)).toBeCloseTo(30, 9);
    expect(warehouseAmountAt(world.state, stoneA.warehouseId, 60)).toBeCloseTo(30, 9);
    expect(warehouseAmountAt(world.state, woodB.warehouseId, 60)).toBe(0);
    expect(snapshotWorld(world).contentVersion).toBe(WORLD_CONTENT_VERSION);
  });

  it("debits the cross-resource and starts income from the command time", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(world);

    advance(world.state, 10);
    expect(buildExtractor(world, woodA.id, 10)).toBe(true);

    expect(isExtractorBuilt(world, woodA.id)).toBe(true);
    // The wood extractor is paid in stone: the island's only stone (stoneA, 30) drops to 10.
    expect(warehouseAmountAt(world.state, stoneA.warehouseId, 10)).toBeCloseTo(10, 9);
    // woodA warehouse: 30 seeded + 2/s from the t=10 build -> 50 by t=20.
    expect(warehouseAmountAt(world.state, woodA.warehouseId, 20)).toBeCloseTo(50, 9);
  });

  it("gates a later build until the running extractors have replenished stock", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, woodB, stoneA } = namedDeposits(world);

    // Both wood deposits cost 20 stone each; only 30 stone is stocked at t=0.
    expect(buildExtractor(world, woodA.id, 0)).toBe(true); // stone 30 -> 10
    expect(buildExtractor(world, woodB.id, 0)).toBe(false); // 10 stone left: unaffordable

    // Build a stone extractor (costs 20 wood, from woodA's 30) so stone starts accruing again.
    expect(buildExtractor(world, stoneA.id, 0)).toBe(true); // stoneA now produces 2/s
    // stone: 10 + 2/s -> 20 by t=5, so the second wood extractor unlocks.
    advance(world.state, 5);
    expect(warehouseAmountAt(world.state, stoneA.warehouseId, 5)).toBeCloseTo(20, 9);
    expect(buildExtractor(world, woodB.id, 5)).toBe(true);
  });

  it("is idempotent — a second build on the same deposit is refused", () => {
    const world = createDemoWorld(1, 0);
    const { woodA } = namedDeposits(world);

    expect(buildExtractor(world, woodA.id, 5)).toBe(true);
    expect(buildExtractor(world, woodA.id, 10)).toBe(false);
  });

  it("survives a save/reload round-trip", () => {
    const world = createDemoWorld(1, 0);
    const { woodA } = namedDeposits(world);

    advance(world.state, 5);
    buildExtractor(world, woodA.id, 5);
    world.state.wallTime = 0;

    const saved = structuredClone(snapshotWorld(world));
    const restored = restoreWorld(saved, 0); // now == wallTime: no offline gap

    expect(isExtractorBuilt(restored, woodA.id)).toBe(true);
    expect(restored.deposits).toEqual(world.deposits);
    // woodA: 30 seeded + 2/s since t=5 -> 50 by t=15.
    advance(restored.state, 15);
    expect(warehouseAmountAt(restored.state, woodA.warehouseId, 15)).toBeCloseTo(50, 9);
  });
});

// The content-version framework is retained (WORLD_UPGRADES is empty after the pivot) plus the
// one-time reset that discards pre-pivot ore/ingot saves. Real app restore path, no mocks.
describe("restore versioning and the one-time reset", () => {
  it("rejects a legacy ore/ingot envelope so the caller quarantines it", () => {
    // Pre-pivot saves carried a singular `buildSite`; the wood/stone envelope never does, so
    // its presence is the discriminator restoreWorld throws on.
    const legacy = {
      ...structuredClone(snapshotWorld(createDemoWorld(1, 0))),
      buildSite: { depositId: "x", warehouseId: "y" },
    };
    expect(() => restoreWorld(legacy, 0)).toThrow(/legacy/);
  });

  it("leaves a current-version save untouched", () => {
    const saved = structuredClone(snapshotWorld(createDemoWorld(1, 0)));
    const restored = restoreWorld(saved, 0);

    expect(restored.warehouses).toEqual(saved.warehouses);
    expect(restored.deposits).toEqual(saved.deposits);
    expect(snapshotWorld(restored).contentVersion).toBe(WORLD_CONTENT_VERSION);
  });

  it("rejects a corrupt contentVersion instead of silently resetting", () => {
    for (const bad of [0, -1e15, 1.5, Number.NaN]) {
      const saved = {
        ...structuredClone(snapshotWorld(createDemoWorld(1, 0))),
        contentVersion: bad,
      };
      expect(() => restoreWorld(saved, 0)).toThrow(/contentVersion/);
    }
  });

  it("never stamps a save below the version a newer app wrote", () => {
    // Stale service-worker-pinned bundle loading a future save: the re-snapshot keeps the
    // higher version so the newer app won't re-run its steps on content already there.
    const saved = { ...structuredClone(snapshotWorld(createDemoWorld(1, 0))), contentVersion: 99 };
    const restored = restoreWorld(saved, 0);

    expect(restored.deposits).toEqual(saved.deposits);
    expect(snapshotWorld(restored).contentVersion).toBe(99);
  });
});
