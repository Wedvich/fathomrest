import {
  addDeposit,
  addWarehouse,
  advance,
  createSimState,
  deserializeState,
  getWarehouse,
  grantIslandXp,
  grantResource,
  islandExtractionMultiplier,
  islandId,
  islandRefinementMultiplier,
  researchNodeId,
  resourceType,
  type ResourceType,
  serializeState,
  warehouseAmountAt,
} from "@fathomrest/core";
import { describe, expect, it, vi } from "vitest";

import {
  buildConverter,
  buildExtractor,
  buyNode,
  canBuyNode,
  cancelResearch,
  collectCompletedResearch,
  createDemoWorld,
  type DemoWorld,
  isConverterBuilt,
  isExtractorBuilt,
  islandXpView,
  isNodeBranchLocked,
  isResearchActive,
  isResearched,
  nextStorageTier,
  researchConsumed,
  type ResearchNode,
  restoreWorld,
  type SavedWorld,
  snapshotWorld,
  startResearch,
  upgradeStorage,
  WORLD_CONTENT_VERSION,
  worldIslands,
  worldSkillNodes,
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

// The tiered island-warehouse upgrade: storage is island-level, so one upgrade lifts every pool's
// cap together. The current rung is derived from the island's live core caps (no persisted index),
// so it advances after a purchase and survives a round-trip. Drives the real core upgrade command,
// no mocks.
describe("storage capacity upgrade", () => {
  const HOME = islandId("home");

  it("lifts every island pool's cap together, advances the ladder, and survives a round-trip", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(world);

    // Build both base extractors so wood and stone each accrue 2/s (wood 30->10 paying stone's
    // build, stone 30->10 paying wood's).
    expect(buildExtractor(world, woodA.id, 0)).toBe(true);
    expect(buildExtractor(world, stoneA.id, 0)).toBe(true);

    // Tier 1 (cap 250) costs 40 wood + 40 stone; from 10 each at 2/s that's affordable by t=15.
    expect(nextStorageTier(world, HOME)?.capacity).toBe(250);
    expect(upgradeStorage(world, HOME, 10)).toBe(false); // only 30 each at t=10
    advance(world.state, 15);
    expect(upgradeStorage(world, HOME, 15)).toBe(true);

    // ONE upgrade raised every HOME pool (wood, stone, iron-ore, iron-ingot) together.
    for (const wh of world.warehouses) {
      const warehouse = getWarehouse(world.state, wh.id);
      if (warehouse.islandId !== HOME) continue; // global knowledge pool is off the island ladder
      expect(warehouse.capacity).toBe(250);
    }
    // The global-scoped knowledge pool is NOT on the island storage ladder, so a home upgrade
    // leaves its cap at the base (its cap is research-gated later).
    const knowledgeWh = world.warehouses.find((w) => w.label === "Knowledge");
    expect(knowledgeWh && getWarehouse(world.state, knowledgeWh.id).capacity).toBe(100);
    expect(nextStorageTier(world, HOME)?.capacity).toBe(500); // ladder advanced past tier 1

    world.state.wallTime = 0;
    const restored = restoreWorld(structuredClone(snapshotWorld(world)), 0);
    for (const wh of restored.warehouses) {
      const warehouse = getWarehouse(restored.state, wh.id);
      if (warehouse.islandId !== HOME) continue; // global knowledge pool is off the island ladder
      expect(warehouse.capacity).toBe(250);
    }
    expect(nextStorageTier(restored, HOME)?.capacity).toBe(500); // derived, not persisted
  });

  it("walks the ladder to the top and then refuses further upgrades", () => {
    const world = createDemoWorld(1, 0);
    const [woodWh, stoneWh] = world.warehouses;
    if (!woodWh || !stoneWh) throw new Error("demo warehouse shape changed");

    // A single island upgrade lifts all caps together, so no per-pool lockstep is needed — just
    // flood the wood/stone cost pools before each rung (grants clamp to the current cap).
    for (const target of [250, 500, 1_000]) {
      grantResource(world.state, 0, woodWh.id, 2_000);
      grantResource(world.state, 0, stoneWh.id, 2_000);
      expect(upgradeStorage(world, HOME, 0)).toBe(true);
      for (const wh of world.warehouses) {
        const warehouse = getWarehouse(world.state, wh.id);
        if (warehouse.islandId !== HOME) continue; // global knowledge pool is off the island ladder
        expect(warehouse.capacity).toBe(target);
      }
    }

    expect(nextStorageTier(world, HOME)).toBeUndefined();
    expect(upgradeStorage(world, HOME, 0)).toBe(false); // maxed: nothing to buy
  });

  it("seeds content-step pools at the island's current rung instead of resetting the ladder", () => {
    // A v1 (pre-iron) save whose island storage sits at 250: the iron upgrade step's new pools
    // arrive at the island's rung (islandStorageCap), so the ladder offers 500 next rather than
    // dropping back to rung 1 and re-charging rungs the player already bought.
    const restored = restoreWorld(woodStoneV1Save(250), 0);
    for (const wh of restored.warehouses) {
      const warehouse = getWarehouse(restored.state, wh.id);
      if (warehouse.islandId !== HOME) continue; // global knowledge pool seeds at its own base cap
      expect(warehouse.capacity).toBe(250);
    }
    expect(nextStorageTier(restored, HOME)?.capacity).toBe(500);
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
function woodStoneV1Save(poolCap = 100): SavedWorld {
  const state = createSimState(1, 0);
  const home = islandId("home");
  const wood = resourceType("wood");
  const stone = resourceType("stone");
  const woodPool = addWarehouse(state, 0, wood, home, poolCap);
  const stonePool = addWarehouse(state, 0, stone, home, poolCap);
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
      "Knowledge",
    ]);
    expect(world.deposits.filter((d) => d.resource === ironOre)).toHaveLength(2);
    expect(world.converterSites).toHaveLength(1);
  });

  it("gates iron builds behind accumulation: the seeded stock can't fund them", () => {
    const world = createDemoWorld(1, 0);
    const [site] = world.converterSites;
    const oreVein = world.deposits.find((d) => d.label === "Iron Ore A vein");
    const woodVein = world.deposits.find((d) => d.label === "Wood A vein");
    if (!site || !oreVein || !woodVein) throw new Error("demo content missing");
    // The 30/30 seed covers a base extractor but not an iron build, so the refinery can never
    // be built first and strand the bootstrap with no wood/stone income (the t=0 soft-lock).
    expect(buildConverter(world, site, 0)).toBe(false);
    expect(buildExtractor(world, oreVein.id, 0)).toBe(false);
    expect(buildExtractor(world, woodVein.id, 0)).toBe(true);
  });

  it("propagates a miswired site instead of reporting it as unaffordable", () => {
    const world = createDemoWorld(1, 0);
    grantResource(world.state, 0, poolId(world, "Wood"), 100);
    grantResource(world.state, 0, poolId(world, "Stone"), 100);
    const [site] = world.converterSites;
    if (!site) throw new Error("iron refinery site missing");
    // A doctored site whose destination sits on another island: the world wrapper must let the
    // core's structural rejection escape rather than translate it to "can't afford yet".
    const offIsland = addWarehouse(
      world.state,
      0,
      resourceType("iron-ingot"),
      islandId("elsewhere"),
      100,
    );
    expect(() => buildConverter(world, { ...site, dstWarehouseId: offIsland }, 0)).toThrow(
      /share an island/,
    );
  });

  it("builds the chain: extractor feeds ore, refinery refines it at draw·ratio", () => {
    const world = createDemoWorld(1, 0);
    const ironOrePool = poolId(world, "Iron Ore");
    const ironIngotPool = poolId(world, "Iron Ingot");
    const oreVein = world.deposits.find((d) => d.label === "Iron Ore A vein");
    const [site] = world.converterSites;
    if (!oreVein || !site) throw new Error("iron content missing");
    // Both iron builds cost 40 wood + 40 stone; grant a surplus so the tier isn't gated by the
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
      "Knowledge",
    ]);
    expect(restored.deposits.filter((d) => d.resource === resourceType("iron-ore"))).toHaveLength(
      2,
    );
    expect(restored.converterSites).toHaveLength(1);
  });

  it("keeps a failed upgrade step retryable instead of stamping the version current", () => {
    // Sabotage: the v1 doc already holds a home iron-ore pool, so addIronTier trips the
    // one-pool-per-(island, resource) invariant and the v1->v2 step throws.
    const save = woodStoneV1Save();
    const state = deserializeState(save.doc);
    addWarehouse(state, 0, resourceType("iron-ore"), islandId("home"), 100);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restored = restoreWorld({ ...save, doc: serializeState(state) }, 0);
      // Version held at 1 (not max'd to current) and no partial iron content: the next
      // restore retries the step rather than skipping it forever.
      expect(warn).toHaveBeenCalledOnce();
      expect(snapshotWorld(restored).contentVersion).toBe(1);
      expect(restored.converterSites).toHaveLength(0);
      expect(restored.warehouses.map((w) => w.label)).toEqual(["Wood", "Stone"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("envelope reference validation", () => {
  it("rejects a save whose converter site references a pool the doc doesn't hold", () => {
    const world = createDemoWorld(1, 0);
    world.state.wallTime = 0;
    const snap = structuredClone(snapshotWorld(world));
    // An id allocated only after the snapshot was taken — no entity in the saved doc holds it.
    const missing = addWarehouse(world.state, 0, resourceType("copper"), islandId("home"), 1);
    const [site] = snap.converterSites ?? [];
    if (!site) throw new Error("iron refinery site missing");
    const tampered: SavedWorld = {
      ...snap,
      converterSites: [{ ...site, srcWarehouseId: missing }],
    };
    // Fails loud in restoreWorld so the caller quarantines the save, instead of the readout
    // crashing on the dangling id every reload.
    expect(() => restoreWorld(tampered, 0)).toThrow(/no warehouse/);
  });

  it("rejects a save whose deposit names a pay island the doc doesn't hold", () => {
    const world = createDemoWorld(1, 0);
    world.state.wallTime = 0;
    const snap = structuredClone(snapshotWorld(world));
    const [woodA, ...rest] = snap.deposits;
    if (!woodA) throw new Error("wood deposit missing");
    // A corrupt pay island wouldn't crash — it would leave the build forever "unaffordable"
    // (a silent soft-lock), so restoreWorld must fail loud into quarantine instead.
    const tampered: SavedWorld = {
      ...snap,
      deposits: [{ ...woodA, payIslandId: islandId("hom") }, ...rest],
    };
    expect(() => restoreWorld(tampered, 0)).toThrow(/no island/);
  });
});

// The knowledge tier as a scenario (DESIGN.md Progression/Knowledge): a global-scoped pool fed by
// a cost-gated observatory on the home island. Drives the real core commands, no mocks.
describe("knowledge tier", () => {
  const HOME = islandId("home");
  const GLOBAL = islandId("global");
  const KNOWLEDGE = resourceType("knowledge");

  function knowledgeDeposit(world: DemoWorld): DemoWorld["deposits"][number] {
    const deposit = world.deposits.find((d) => d.resource === KNOWLEDGE);
    if (!deposit) throw new Error("no knowledge deposit in the demo world");
    return deposit;
  }

  function knowledgePoolId(world: DemoWorld): ReturnType<typeof addWarehouse> {
    const warehouse = world.warehouses.find((w) => w.label === "Knowledge");
    if (!warehouse) throw new Error("no knowledge pool in the demo world");
    return warehouse.id;
  }

  it("puts the knowledge pool on the global scope, off the island storage ladder", () => {
    const world = createDemoWorld(1, 0);
    expect(getWarehouse(world.state, knowledgePoolId(world)).islandId).toBe(GLOBAL);
    // The global scope yields no storage-upgrade island — its cap is research-gated, not laddered.
    expect(worldIslands(world)).toEqual([HOME]);
  });

  it("gates the observatory behind the base economy, then accrues knowledge into the global pool", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(world);
    const observatory = knowledgeDeposit(world);
    const knowledgePool = knowledgePoolId(world);

    // The seeded 30/30 can't fund the 40/40 observatory: the base extractors must run first.
    expect(buildExtractor(world, observatory.id, 0)).toBe(false);

    // Start wood + stone income (each 2/s from a 10-unit base after the cross-resource builds),
    // then wait for both home pools to clear the 40 wood + 40 stone cost.
    expect(buildExtractor(world, woodA.id, 0)).toBe(true);
    expect(buildExtractor(world, stoneA.id, 0)).toBe(true);
    expect(buildExtractor(world, observatory.id, 10)).toBe(false); // 10 + 2*10 = 30 each, short of 40
    expect(buildExtractor(world, observatory.id, 15)).toBe(true); // 40 each: paid from home stock

    // Knowledge now accrues into the global pool at rate 1 * the tier multiplier 2.
    expect(warehouseAmountAt(world.state, knowledgePool, 20)).toBeCloseTo(10, 9);
    // A full pool jams (DESIGN.md: a "come spend me" prompt) — the cap holds, never overfills.
    expect(warehouseAmountAt(world.state, knowledgePool, 1_000)).toBeCloseTo(100, 9);
  });

  it("injects the knowledge tier onto an iron-era save through offline-safe content upgrade", () => {
    // A fresh world minus the knowledge tier stands in for a pre-knowledge save: strip the global
    // pool + deposit and drop the content version, then restore. The upgrade step must re-inject
    // them via core commands at the restore epoch (no retroactive production across the gap).
    const fresh = createDemoWorld(1, 0);
    const saved = structuredClone(snapshotWorld(fresh));
    const priorVersion = 2; // iron-era: before knowledge (v2→v3) and the skill tree (v3→v4)
    const preKnowledge: SavedWorld = {
      ...saved,
      warehouses: saved.warehouses.filter((w) => w.label !== "Knowledge"),
      // Strip payIslandId too: a genuine v2 save predates the field, so restore must backfill it.
      deposits: saved.deposits
        .filter((d) => d.resource !== KNOWLEDGE)
        .map(({ payIslandId: _payIslandId, ...deposit }) => deposit),
      contentVersion: priorVersion,
      doc: {
        ...saved.doc,
        warehouses: saved.doc.warehouses.filter(([, w]) => w.resource !== KNOWLEDGE),
        deposits: saved.doc.deposits.filter(([, d]) => d.resource !== KNOWLEDGE),
        // A genuine iron-era (v2) doc predates the island-XP schema; drop it so the v3→v4 upgrade
        // step registers HOME cleanly (the fixture derives from createDemoWorld, which registers it).
        islandProgress: [],
      },
    };

    const restored = restoreWorld(preKnowledge, 0);
    expect(snapshotWorld(restored).contentVersion).toBe(WORLD_CONTENT_VERSION);
    expect(getWarehouse(restored.state, knowledgePoolId(restored)).islandId).toBe(GLOBAL);
    expect(restored.deposits.filter((d) => d.resource === KNOWLEDGE)).toHaveLength(1);
    // Backfilled: every pre-knowledge deposit funds from its pool's island again.
    for (const deposit of restored.deposits) expect(deposit.payIslandId).toBe(HOME);
  });
});

// The island skill tree (DESIGN.md: island specialization) as scenarios: HOME accrues XP from
// its extraction throughput, trunk nodes gate on level (XP) + cost and apply an island
// extraction multiplier that persists in core state, and the research-gated junction stays
// locked. Drives the real core commands through the world API, no mocks.
describe("island skill tree", () => {
  const HOME = islandId("home");

  it("gates a trunk node behind XP level and cost, applies its multiplier, and persists", () => {
    const world = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(world);
    // Build both base extractors: HOME now produces 4/s (2 wood + 2 stone), accruing XP; each
    // build pays the cross-resource, leaving both pools at 10.
    expect(buildExtractor(world, woodA.id, 0)).toBe(true);
    expect(buildExtractor(world, stoneA.id, 0)).toBe(true);

    const nodeId = "home-efficient-tools"; // level 2, costs 40 wood + 40 stone, 1.15x
    // At t=0 the island is level 1 (0 XP) — locked regardless of stock.
    expect(islandXpView(world, HOME, 0).level).toBe(1);
    expect(canBuyNode(world, nodeId, 0)).toBe(false);
    expect(buyNode(world, nodeId, 0)).toBe(false);

    // By t=15: XP is 4*15 = 60 (level 3 >= 2) and both pools have refilled to 40 (10 + 2*15).
    advance(world.state, 15);
    expect(islandXpView(world, HOME, 15).level).toBeGreaterThanOrEqual(2);
    expect(canBuyNode(world, nodeId, 15)).toBe(true);

    expect(buyNode(world, nodeId, 15)).toBe(true);
    expect(world.purchasedNodes).toContain(nodeId);
    // Cost paid: the Wood pool 40 -> 0 at t=15.
    expect(warehouseAmountAt(world.state, woodA.warehouseId, 15)).toBeCloseTo(0, 9);
    // Production accelerates island-wide: the wood extractor now yields 2 * 1.15 = 2.3/s.
    expect(warehouseAmountAt(world.state, woodA.warehouseId, 16)).toBeCloseTo(2.3, 9);
    // Idempotent: a second buy is refused.
    expect(buyNode(world, nodeId, 16)).toBe(false);

    // The multiplier lives in core state, so it survives a save/reload.
    world.state.wallTime = 0;
    const restored = restoreWorld(structuredClone(snapshotWorld(world)), 0);
    expect(restored.purchasedNodes).toContain(nodeId);
    expect(islandExtractionMultiplier(restored.state, HOME)).toBeCloseTo(1.15, 9);
  });

  // A world with the whole trunk owned, XP maxed and stock topped up, so the ONLY thing gating the
  // junction is the research + exclusivity rules. Junction nodes are level 5, prereq quarry-discipline.
  function junctionReady(): { world: DemoWorld; top: () => void } {
    const world = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(world);
    expect(buildExtractor(world, woodA.id, 0)).toBe(true);
    expect(buildExtractor(world, stoneA.id, 0)).toBe(true);
    grantIslandXp(world.state, 0, HOME, 1000); // force max level
    const top = (): void => {
      grantResource(world.state, 0, woodA.warehouseId, 100);
      grantResource(world.state, 0, stoneA.warehouseId, 100);
    };
    for (const trunkId of [
      "home-efficient-tools",
      "home-sharper-edges",
      "home-quarry-discipline",
    ]) {
      top();
      expect(buyNode(world, trunkId, 0)).toBe(true);
    }
    top();
    return { world, top };
  }

  const markResearched = (world: DemoWorld, id: string, cost: number): void => {
    world.researchProgress.set(researchNodeId(id), cost);
  };

  it("keeps the junction locked until its research completes, then unlocks it", () => {
    const { world } = junctionReady();
    // Trunk owned, XP maxed, stock full: the only remaining blocker is the (incomplete) research.
    for (const junctionId of ["home-extraction-mastery", "home-refinement-mastery"]) {
      expect(canBuyNode(world, junctionId, 0)).toBe(false);
      expect(buyNode(world, junctionId, 0)).toBe(false);
    }
    // Complete the gating research (Tidal Almanac): the junction becomes buyable.
    markResearched(world, "tidal-almanac", 100);
    expect(canBuyNode(world, "home-extraction-mastery", 0)).toBe(true);
    expect(canBuyNode(world, "home-refinement-mastery", 0)).toBe(true);
  });

  it("makes the junction exclusive — picking one branch locks the other for good", () => {
    const { world } = junctionReady();
    markResearched(world, "tidal-almanac", 100);
    // Commit to Extraction: its multiplier lifts, and the Refinement branch locks out.
    expect(buyNode(world, "home-extraction-mastery", 0)).toBe(true);
    expect(islandExtractionMultiplier(world.state, HOME)).toBeCloseTo(1.15 * 1.15 * 1.2 * 1.3, 9);
    const refinement = worldSkillNodes(world).find((n) => n.id === "home-refinement-mastery");
    if (!refinement) throw new Error("no refinement node");
    expect(isNodeBranchLocked(world, refinement)).toBe(true);
    expect(canBuyNode(world, "home-refinement-mastery", 0)).toBe(false);
    expect(buyNode(world, "home-refinement-mastery", 0)).toBe(false);
  });

  it("drives the refinement branch through the refinement multiplier, not extraction", () => {
    const { world } = junctionReady();
    markResearched(world, "tidal-almanac", 100);
    const extractionBefore = islandExtractionMultiplier(world.state, HOME);
    expect(buyNode(world, "home-refinement-mastery", 0)).toBe(true);
    // The refinement node lifts the refinement multiplier (converter yield) and leaves extraction alone.
    expect(islandRefinementMultiplier(world.state, HOME)).toBeCloseTo(1.1, 9);
    expect(islandExtractionMultiplier(world.state, HOME)).toBeCloseTo(extractionBefore, 9);
    // ...and now Extraction is the locked-out branch.
    expect(canBuyNode(world, "home-extraction-mastery", 0)).toBe(false);
  });

  it("registers HOME's XP on a pre-skill-tree (v3) save at the restore epoch, no retroactive XP", () => {
    const fresh = createDemoWorld(1, 0);
    const { woodA, stoneA } = namedDeposits(fresh);
    expect(buildExtractor(fresh, woodA.id, 0)).toBe(true);
    expect(buildExtractor(fresh, stoneA.id, 0)).toBe(true);
    advance(fresh.state, 40);
    fresh.state.wallTime = 0;

    // Downgrade to a knowledge-era (v3) save: strip islandProgress (a v3 doc predates island XP)
    // and label the envelope v3, so restore must register HOME via the upgrade step.
    const snap = structuredClone(snapshotWorld(fresh));
    const v3: SavedWorld = {
      ...snap,
      contentVersion: 3,
      doc: { ...snap.doc, islandProgress: [] },
    };

    const restored = restoreWorld(v3, 0); // now == wallTime: no offline gap
    expect(snapshotWorld(restored).contentVersion).toBe(WORLD_CONTENT_VERSION);
    // Registration happens at the restore epoch, AFTER catch-up: the 40s of pre-restore extraction
    // is not retroactively credited.
    const epoch = restored.state.epoch;
    expect(islandXpView(restored, HOME, epoch).xp).toBeCloseTo(0, 9);
    // But XP accrues going forward — the extractors are still running.
    advance(restored.state, epoch + 10);
    expect(islandXpView(restored, HOME, restored.state.epoch).xp).toBeGreaterThan(0);
  });
});

// Research as a scenario (DESIGN.md Progression/Research): the knowledge pool the observatory
// fills is drained by an active research node — a continuous drain with preserved per-node
// progress and a free swap. Drives the real core commands through the world layer, no mocks.
describe("research drain", () => {
  const KNOWLEDGE = resourceType("knowledge");

  // A demo world with wood + stone + observatory income running, so knowledge accrues into the
  // global pool (2/s) and the research nodes have something to drain. Observatory affordable by
  // t=15 (40 wood + 40 stone from a 2/s base), matching the knowledge-tier scenario.
  function fundedWorld(): DemoWorld {
    const world = createDemoWorld(1, 0);
    world.state.wallTime = 0;
    const { woodA, stoneA } = namedDeposits(world);
    const observatory = world.deposits.find((d) => d.resource === KNOWLEDGE);
    if (!observatory) throw new Error("no observatory deposit");
    buildExtractor(world, woodA.id, 0);
    buildExtractor(world, stoneA.id, 0);
    if (!buildExtractor(world, observatory.id, 15))
      throw new Error("observatory should be funded by t=15");
    return world;
  }

  function node(world: DemoWorld, id: string): ResearchNode {
    const found = world.researchNodes.find((n) => n.id === id);
    if (!found) throw new Error(`no research node ${id}`);
    return found;
  }

  it("a fresh world exposes the research tree with nothing active or researched", () => {
    const world = createDemoWorld(1, 0);
    expect(world.researchNodes.length).toBeGreaterThan(0);
    expect(world.knowledgePoolId).toBeDefined();
    for (const n of world.researchNodes) {
      expect(isResearched(world, n)).toBe(false);
      expect(isResearchActive(world, n)).toBe(false);
    }
  });

  it("drains knowledge into the active node, then banks it as researched on completion", () => {
    const world = fundedWorld();
    const survey = node(world, "survey-cache"); // cost 40 at drain 1/s
    expect(startResearch(world, survey, 20)).toBe(true);
    expect(isResearchActive(world, survey)).toBe(true);
    // Inflow 2 > drain 1, so the pool never starves: consumed climbs a steady 1/s from t=20.
    advance(world.state, 40);
    expect(researchConsumed(world, survey, 40)).toBeCloseTo(20, 9);
    // Past completion (start + cost = t=60): collecting the finished node frees the slot and
    // records it researched.
    advance(world.state, 60);
    expect(collectCompletedResearch(world, 60)).toBe(true);
    expect(isResearched(world, survey)).toBe(true);
    expect(isResearchActive(world, survey)).toBe(false);
    // A researched node can't be restarted, and collecting again is a no-op.
    expect(startResearch(world, survey, 61)).toBe(false);
    expect(collectCompletedResearch(world, 61)).toBe(false);
  });

  it("swaps the active node freely and resumes each where it was left", () => {
    const world = fundedWorld();
    const survey = node(world, "survey-cache");
    const holds = node(world, "reinforced-holds");
    startResearch(world, survey, 20);
    advance(world.state, 30); // survey consumed ~10
    // Swap to holds: survey's progress is banked, holds starts fresh.
    expect(startResearch(world, holds, 30)).toBe(true);
    expect(isResearchActive(world, holds)).toBe(true);
    expect(researchConsumed(world, survey, 30)).toBeCloseTo(10, 9); // preserved off-slot
    advance(world.state, 40); // holds consumed ~10
    // Swap back to survey: it resumes from ~10, not zero.
    expect(startResearch(world, survey, 40)).toBe(true);
    expect(researchConsumed(world, holds, 40)).toBeCloseTo(10, 9); // holds now preserved off-slot
    advance(world.state, 45);
    expect(researchConsumed(world, survey, 45)).toBeCloseTo(15, 9); // 10 banked + 5s at 1/s
  });

  it("preserves an in-flight drain and its progress across a save round-trip", () => {
    const world = fundedWorld();
    const survey = node(world, "survey-cache");
    startResearch(world, survey, 20);
    advance(world.state, 40);
    const before = researchConsumed(world, survey, 40);
    const restored = restoreWorld(structuredClone(snapshotWorld(world)), 0);
    expect(isResearchActive(restored, survey)).toBe(true);
    expect(researchConsumed(restored, survey, 40)).toBeCloseTo(before, 9);
    // A paused node's banked progress round-trips too: cancel, save, restore, resume.
    expect(cancelResearch(restored, 40)).toBe(true);
    const paused = restoreWorld(structuredClone(snapshotWorld(restored)), 0);
    expect(isResearchActive(paused, survey)).toBe(false);
    expect(researchConsumed(paused, survey, 40)).toBeCloseTo(before, 9);
  });
});
