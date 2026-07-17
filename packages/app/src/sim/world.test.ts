import {
  addDeposit,
  addWarehouse,
  advance,
  createSimState,
  grantResource,
  islandId,
  resourceType,
  type ResourceType,
  serializeState,
  warehouseAmountAt,
} from "@fathomrest/core";
import { describe, expect, it } from "vitest";

import {
  buildConverter,
  buildExtractor,
  createDemoWorld,
  type DemoWorld,
  isConverterBuilt,
  isExtractorBuilt,
  restoreWorld,
  type SavedWorld,
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
// createDemoWorld's deposits are [Wood A, Wood B, Stone A, Stone B], each vein feeding its
// resource's single pool (one per (island, resource)); each pool is seeded to 30. A wood
// extractor costs 20 stone and vice versa; extractor rate 1 * the rich tier's multiplier 2 =
// 2 units/s produced once built.
describe("wood/stone build bootstrap", () => {
  it("boots with a seeded stockpile and no extractors", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, woodB, stoneA } = namedDeposits(world);

    advance(world.state, 60);

    for (const dep of world.deposits) expect(isExtractorBuilt(world, dep.id)).toBe(false);
    // Both wood veins point at the one Wood pool; it holds exactly the stockpile (no producer
    // grows it), likewise the Stone pool.
    expect(woodB.warehouseId).toBe(woodA.warehouseId);
    expect(warehouseAmountAt(world.state, woodA.warehouseId, 60)).toBeCloseTo(30, 9);
    expect(warehouseAmountAt(world.state, stoneA.warehouseId, 60)).toBeCloseTo(30, 9);
    expect(snapshotWorld(world).contentVersion).toBe(WORLD_CONTENT_VERSION);
  });

  it("debits the cross-resource and starts income from the command time", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(world);

    advance(world.state, 10);
    expect(buildExtractor(world, woodA.id, 10)).toBe(true);

    expect(isExtractorBuilt(world, woodA.id)).toBe(true);
    // The wood extractor is paid in stone: the island's Stone pool (30) drops to 10.
    expect(warehouseAmountAt(world.state, stoneA.warehouseId, 10)).toBeCloseTo(10, 9);
    // Wood pool: 30 seeded + 2/s from the t=10 build -> 50 by t=20.
    expect(warehouseAmountAt(world.state, woodA.warehouseId, 20)).toBeCloseTo(50, 9);
  });

  it("gates a later build until the running extractors have replenished stock", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, woodB, stoneA } = namedDeposits(world);

    // Both wood deposits cost 20 stone each; only 30 stone is stocked at t=0.
    expect(buildExtractor(world, woodA.id, 0)).toBe(true); // stone 30 -> 10
    expect(buildExtractor(world, woodB.id, 0)).toBe(false); // 10 stone left: unaffordable

    // Build a stone extractor (costs 20 wood, from the Wood pool's 30) so stone accrues again.
    expect(buildExtractor(world, stoneA.id, 0)).toBe(true); // Stone pool now gains 2/s
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

// The content-version framework plus the one-time reset that discards pre-pivot ore/ingot
// saves. Real app restore path, no mocks.
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

// A pre-iron (contentVersion 1) envelope as the wood/stone-only app wrote it: wood + stone pools
// and their four deposits, no iron tier, no converterSites. Built through the core surface so the
// upgrade step restores against a genuine older save rather than a doctored fresh one.
function woodStoneV1Save(): SavedWorld {
  const state = createSimState(1, 0);
  const home = islandId("home");
  const wood = resourceType("wood");
  const stone = resourceType("stone");
  const woodPool = addWarehouse(state, 0, wood, home, 100);
  const stonePool = addWarehouse(state, 0, stone, home, 100);
  const woodCost: readonly (readonly [ResourceType, number])[] = [[stone, 20]];
  const stoneCost: readonly (readonly [ResourceType, number])[] = [[wood, 20]];
  const vein = (
    resource: ResourceType,
    warehouseId: ReturnType<typeof addWarehouse>,
    label: string,
    cost: readonly (readonly [ResourceType, number])[],
  ) => ({
    id: addDeposit(state, 0, resource, [{ amount: 500, multiplier: 2 }], 0.5),
    warehouseId,
    label,
    resource,
    cost,
    rate: 1,
  });
  const deposits = [
    vein(wood, woodPool, "Wood A vein", woodCost),
    vein(wood, woodPool, "Wood B vein", woodCost),
    vein(stone, stonePool, "Stone A vein", stoneCost),
    vein(stone, stonePool, "Stone B vein", stoneCost),
  ];
  grantResource(state, 0, woodPool, 30);
  grantResource(state, 0, stonePool, 30);
  state.wallTime = 0;
  return {
    doc: serializeState(state),
    warehouses: [
      { id: woodPool, label: "Wood" },
      { id: stonePool, label: "Stone" },
    ],
    deposits,
    contentVersion: 1,
  };
}

// The iron refinement tier as scenarios: a fresh world exposes it, the extractor->refinery chain
// refines iron-ore into iron-ingot, and it survives the restore path. Drives the real core
// commands through the world layer, no mocks.
describe("iron refinement tier", () => {
  const ironOre = resourceType("iron-ore");

  function poolId(world: DemoWorld, label: string): ReturnType<typeof addWarehouse> {
    const warehouse = world.warehouses.find((w) => w.label === label);
    if (!warehouse) throw new Error(`no warehouse labelled ${label}`);
    return warehouse.id;
  }

  it("a fresh world offers iron-ore deposits, iron pools, and a refinery site", () => {
    const world = createDemoWorld(1, 0);
    expect(world.warehouses.map((w) => w.label)).toEqual([
      "Wood",
      "Stone",
      "Iron Ore",
      "Iron Ingot",
    ]);
    expect(world.deposits.filter((d) => d.resource === ironOre)).toHaveLength(2);
    expect(world.converterSites).toHaveLength(1);
  });

  it("builds the chain: extractor feeds ore, refinery refines it at draw·ratio", () => {
    const world = createDemoWorld(1, 0);
    const ironOrePool = poolId(world, "Iron Ore");
    const ironIngotPool = poolId(world, "Iron Ingot");
    const oreVein = world.deposits.find((d) => d.label === "Iron Ore A vein");
    const [site] = world.converterSites;
    if (!oreVein || !site) throw new Error("iron content missing");
    // Both iron builds cost 20 wood + 20 stone; grant a surplus so the tier isn't gated by the
    // wood/stone economy here (that gating is covered by the bootstrap scenarios above).
    grantResource(world.state, 0, poolId(world, "Wood"), 100);
    grantResource(world.state, 0, poolId(world, "Stone"), 100);
    expect(buildExtractor(world, oreVein.id, 0)).toBe(true); // iron-ore now +2/s
    // 20 iron-ore by t=10; build the refinery then — cap 2/s, ratio 0.5 -> 1 ingot/s.
    expect(warehouseAmountAt(world.state, ironOrePool, 10)).toBeCloseTo(20, 9);
    expect(buildConverter(world, site, 10)).toBe(true);
    // t=20: 1 ingot/s for 10s; iron-ore holds at 20 (2 produced - 2 drawn per second).
    expect(warehouseAmountAt(world.state, ironIngotPool, 20)).toBeCloseTo(10, 9);
    expect(warehouseAmountAt(world.state, ironOrePool, 20)).toBeCloseTo(20, 9);
  });

  it("is idempotent per refinery and survives a save round-trip", () => {
    const world = createDemoWorld(1, 0);
    const [site] = world.converterSites;
    if (!site) throw new Error("iron refinery site missing");
    grantResource(world.state, 0, poolId(world, "Wood"), 100);
    grantResource(world.state, 0, poolId(world, "Stone"), 100);
    expect(buildConverter(world, site, 0)).toBe(true);
    expect(buildConverter(world, site, 5)).toBe(false); // already built
    world.state.wallTime = 0;

    const restored = restoreWorld(structuredClone(snapshotWorld(world)), 0);
    expect(isConverterBuilt(restored, site.srcWarehouseId, site.dstWarehouseId)).toBe(true);
    expect(restored.converterSites).toEqual(world.converterSites);
  });
});

describe("iron-tier content upgrade", () => {
  it("layers the iron tier onto a pre-iron (v1) wood/stone save", () => {
    const restored = restoreWorld(woodStoneV1Save(), 0);
    // Raised to current and the iron content injected through the same commands as a fresh world.
    expect(snapshotWorld(restored).contentVersion).toBe(WORLD_CONTENT_VERSION);
    expect(restored.warehouses.map((w) => w.label)).toEqual([
      "Wood",
      "Stone",
      "Iron Ore",
      "Iron Ingot",
    ]);
    expect(restored.deposits.filter((d) => d.resource === resourceType("iron-ore"))).toHaveLength(
      2,
    );
    expect(restored.converterSites).toHaveLength(1);
  });
});
