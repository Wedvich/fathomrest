import { describe, expect, it } from "vitest";

import { getWarehouse } from "./components/warehouse.ts";
import { islandId } from "./island.ts";
import { resourceType } from "./resource.ts";
import { serializeState, type SaveDocument } from "./serialize.ts";
import {
  addConverter,
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  advance,
  buildConverter,
  buildExtractor,
  canAffordBuild,
  converterDraw,
  converterFeed,
  depositMultiplier,
  depositRemainingAt,
  extractorEffectiveRate,
  grantResource,
  InsufficientStockError,
  routeFlow,
  setRouteCap,
  setWarehousePullRate,
  upgradeIslandCapacity,
  warehouseAmountAt,
  warehouseOutflowRate,
} from "./sim.ts";
import { createSimState, type SimState } from "./state.ts";

// Single shared type for the many single-resource scenarios; type-match cases below use
// their own distinct tags.
const R = resourceType("stuff");
// One warehouse per (island, resource) is a core invariant, so scenarios that need two+
// same-resource warehouses (routes, hubs, chains) place each on its own island. The transfer
// solver ignores island tags, so this is purely how fixtures satisfy the invariant.
const I = islandId("here");
const J = islandId("there");
const K = islandId("yonder");

function toyChain(): {
  state: SimState;
  warehouseId: ReturnType<typeof addWarehouse>;
  extractorId: ReturnType<typeof addExtractor>;
} {
  const state = createSimState(42, 0);
  const warehouseId = addWarehouse(state, 0, R, I, 100);
  // Pure-floor deposit at multiplier 1: a plain perpetual producer.
  const depositId = addDeposit(state, 0, R, [], 1);
  const extractorId = addExtractor(state, 0, 2, depositId, warehouseId);
  setWarehousePullRate(state, 0, warehouseId, 0.5);
  return { state, warehouseId, extractorId };
}

describe("toy chain", () => {
  it("fills linearly while tracking", () => {
    const { state, warehouseId } = toyChain();
    // Net rate 2 - 0.5 = 1.5; query is pure and works ahead of advance().
    expect(warehouseAmountAt(state, warehouseId, 40)).toBe(60);
    advance(state, 40);
    expect(getWarehouse(state, warehouseId).regime).toBe("tracking");
    expect(warehouseAmountAt(state, warehouseId, 40)).toBe(60);
  });

  it("enters the saturation regime at the fill event and throttles the producer", () => {
    const { state, warehouseId, extractorId } = toyChain();
    advance(state, 100); // fill event at 100 / 1.5 = 66.67s
    const warehouse = getWarehouse(state, warehouseId);
    expect(warehouse.regime).toBe("pinned-full");
    expect(warehouseAmountAt(state, warehouseId, 100)).toBe(100);
    // Producer throttled to the consumer's pull rate; no event churn while pinned.
    expect(extractorEffectiveRate(state, extractorId)).toBe(0.5);
    expect(state.events.size).toBe(0);
  });

  it("drains out of saturation when pull exceeds inflow, then pins empty", () => {
    const { state, warehouseId, extractorId } = toyChain();
    advance(state, 100);
    setWarehousePullRate(state, 100, warehouseId, 3); // net -1 from a full 100
    expect(getWarehouse(state, warehouseId).regime).toBe("tracking");
    expect(warehouseAmountAt(state, warehouseId, 150)).toBe(50);
    advance(state, 300); // empty event at 100 + 100/1 = 200s
    const warehouse = getWarehouse(state, warehouseId);
    expect(warehouse.regime).toBe("pinned-empty");
    expect(warehouseAmountAt(state, warehouseId, 300)).toBe(0);
    // Consumer throttled to inflow while starved; producer runs free.
    expect(warehouseOutflowRate(state, warehouseId)).toBe(2);
    expect(extractorEffectiveRate(state, extractorId)).toBe(2);
  });

  it("invalidates a scheduled crossing when a command changes the rates", () => {
    const { state, warehouseId } = toyChain();
    setWarehousePullRate(state, 30, warehouseId, 2); // amount 45, net 0: crossing never happens
    expect(state.epoch).toBe(30); // the command advanced to its own time first
    advance(state, 1_000_000);
    const warehouse = getWarehouse(state, warehouseId);
    expect(warehouse.regime).toBe("tracking");
    expect(warehouseAmountAt(state, warehouseId, 1_000_000)).toBe(45);
  });

  it("rejects a non-finite advance time instead of draining the queue", () => {
    const { state, warehouseId } = toyChain();
    expect(() => advance(state, Number.NaN)).toThrow(/finite/);
    expect(() => advance(state, Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(getWarehouse(state, warehouseId).regime).toBe("tracking");
    expect(state.epoch).toBe(0);
  });
});

describe("deposits", () => {
  it("steps extraction down through richness tiers to the floor trickle", () => {
    const state = createSimState(42, 0);
    const warehouseId = addWarehouse(state, 0, R, I, 10_000);
    const depositId = addDeposit(
      state,
      0,
      R,
      [
        { amount: 100, multiplier: 2 },
        { amount: 100, multiplier: 1 },
      ],
      0.25,
    );
    const extractorId = addExtractor(state, 0, 2, depositId, warehouseId);

    // Tier 1: draw 2 * 2 = 4/s; 100 units last until t=25.
    expect(extractorEffectiveRate(state, extractorId)).toBe(4);
    expect(depositRemainingAt(state, depositId, 0)).toBe(200);
    expect(depositRemainingAt(state, depositId, 10)).toBe(160);

    advance(state, 25);
    // Tier 2: draw 2/s; 100 more units last until t=75.
    expect(depositMultiplier(state, depositId)).toBe(1);
    expect(extractorEffectiveRate(state, extractorId)).toBe(2);
    expect(warehouseAmountAt(state, warehouseId, 25)).toBe(100);

    advance(state, 75);
    // Floor: perpetual trickle at 2 * 0.25 = 0.5/s, nothing left to deplete.
    expect(depositMultiplier(state, depositId)).toBe(0.25);
    expect(depositRemainingAt(state, depositId, 75)).toBe(0);
    expect(warehouseAmountAt(state, warehouseId, 75)).toBe(200);

    advance(state, 100);
    expect(warehouseAmountAt(state, warehouseId, 100)).toBe(212.5);
    // Only the (distant) warehouse fill is still live; stale reschedules linger in the
    // heap until popped, so count through the serializer's canonical filter.
    expect(serializeState(state).events.map((event) => event.kind)).toEqual(["warehouse-full"]);
  });

  it("pauses depletion while the warehouse is pinned full and resumes on pull", () => {
    const state = createSimState(42, 0);
    const warehouseId = addWarehouse(state, 0, R, I, 50);
    const depositId = addDeposit(state, 0, R, [{ amount: 100, multiplier: 1 }], 0);
    const extractorId = addExtractor(state, 0, 2, depositId, warehouseId);

    // Fills at t=25 with 50 deposit units left; pull is 0, so depletion pauses.
    advance(state, 500);
    expect(getWarehouse(state, warehouseId).regime).toBe("pinned-full");
    expect(extractorEffectiveRate(state, extractorId)).toBe(0);
    expect(depositRemainingAt(state, depositId, 500)).toBe(50);
    expect(state.events.size).toBe(0); // paused world schedules nothing

    // Consumer pull resumes the throttled draw at 0.5/s: floor at t=600.
    setWarehousePullRate(state, 500, warehouseId, 0.5);
    advance(state, 600);
    expect(depositMultiplier(state, depositId)).toBe(0);
    expect(depositRemainingAt(state, depositId, 600)).toBe(0);

    // Floor multiplier 0: inflow dies, the warehouse drains 50 units by t=700.
    expect(warehouseAmountAt(state, warehouseId, 650)).toBe(25);
    advance(state, 700);
    expect(getWarehouse(state, warehouseId).regime).toBe("pinned-empty");
    expect(warehouseOutflowRate(state, warehouseId)).toBe(0);
  });

  it("rejects malformed tier tables at the command boundary", () => {
    const state = createSimState(42, 0);
    expect(() => addDeposit(state, 0, R, [{ amount: 0, multiplier: 1 }], 1)).toThrow(/amount/);
    expect(() => addDeposit(state, 0, R, [{ amount: Number.NaN, multiplier: 1 }], 1)).toThrow(
      /amount/,
    );
    expect(() => addDeposit(state, 0, R, [{ amount: 10, multiplier: -1 }], 1)).toThrow(
      /multiplier/,
    );
    expect(() => addDeposit(state, 0, R, [], Number.POSITIVE_INFINITY)).toThrow(/floor/);
  });
});

describe("routes", () => {
  it("carries an instant rate-capped flow between warehouses", () => {
    const state = createSimState(42, 0);
    const source = addWarehouse(state, 0, R, I, 1_000);
    const dest = addWarehouse(state, 0, R, J, 1_000);
    const deposit = addDeposit(state, 0, R, [], 1);
    addExtractor(state, 0, 5, deposit, source); // source inflow 5/s
    const route = addRoute(state, 0, source, dest, 3); // cap below inflow, so runs at cap

    expect(routeFlow(state, route)).toBe(3);
    // Source keeps 5 - 3 = 2/s; dest receives the full 3/s.
    expect(warehouseAmountAt(state, source, 10)).toBe(20);
    expect(warehouseAmountAt(state, dest, 10)).toBe(30);
    advance(state, 10);
    expect(routeFlow(state, route)).toBe(3);
  });

  it("backs up the source when the destination jams (backpressure travels upstream)", () => {
    const state = createSimState(42, 0);
    const source = addWarehouse(state, 0, R, I, 100);
    const dest = addWarehouse(state, 0, R, J, 50);
    const deposit = addDeposit(state, 0, R, [], 1);
    const extractor = addExtractor(state, 0, 20, deposit, source); // ample supply
    const route = addRoute(state, 0, source, dest, 10);
    // dest has no consumer, so it fills at the route rate 10/s and jams at t=5.

    advance(state, 6);
    expect(getWarehouse(state, dest).regime).toBe("pinned-full");
    expect(warehouseAmountAt(state, dest, 6)).toBe(50);
    // Backpressure: the jammed dest accepts nothing, so the route stops drawing.
    expect(routeFlow(state, route)).toBe(0);
    // The source now keeps its whole 20/s: 50 by t=5, then +20 for the last second.
    expect(getWarehouse(state, source).regime).toBe("tracking");
    expect(warehouseAmountAt(state, source, 6)).toBe(70);
    expect(extractorEffectiveRate(state, extractor)).toBe(20);
  });

  it("supply-limits the route when the source runs dry (starvation travels downstream)", () => {
    const state = createSimState(42, 0);
    const source = addWarehouse(state, 0, R, I, 100);
    const dest = addWarehouse(state, 0, R, J, 100);
    const deposit = addDeposit(state, 0, R, [], 1);
    addExtractor(state, 0, 3, deposit, source); // trickle: below the route cap
    const route = addRoute(state, 0, source, dest, 10);
    setWarehousePullRate(state, 0, dest, 5); // wants more than the route can supply

    advance(state, 100);
    // Source is starved: the route carries only what the source produces.
    expect(getWarehouse(state, source).regime).toBe("pinned-empty");
    expect(routeFlow(state, route)).toBe(3);
    // Dest is starved in turn: its consumer is throttled to the arriving 3/s.
    expect(getWarehouse(state, dest).regime).toBe("pinned-empty");
    expect(warehouseOutflowRate(state, dest)).toBe(3);
    expect(warehouseAmountAt(state, source, 100)).toBe(0);
    expect(warehouseAmountAt(state, dest, 100)).toBe(0);
  });

  it("splits a demand-limited hub across incoming routes, reflowing a starved one", () => {
    // P is well-supplied, Q is a trickle; both feed hub D which can only accept its pull.
    const state = createSimState(42, 0);
    const p = addWarehouse(state, 0, R, I, 100);
    const q = addWarehouse(state, 0, R, J, 100);
    const hub = addWarehouse(state, 0, R, K, 50);
    const deposit = addDeposit(state, 0, R, [], 1);
    addExtractor(state, 0, 20, deposit, p); // P can push its full route cap
    addExtractor(state, 0, 1, deposit, q); // Q is supply-limited to 1/s
    const fromP = addRoute(state, 0, p, hub, 10);
    const fromQ = addRoute(state, 0, q, hub, 10);
    setWarehousePullRate(state, 0, hub, 3); // hub accepts only 3/s once full

    advance(state, 10_000);
    expect(getWarehouse(state, hub).regime).toBe("pinned-full");
    // Q delivers its whole trickle (1); the unclaimed acceptance reflows to P (2) — not a
    // flat proportional 1.5/1.5, which Q could not sustain.
    expect(routeFlow(state, fromQ)).toBe(1);
    expect(routeFlow(state, fromP)).toBe(2);
    expect(getWarehouse(state, q).regime).toBe("pinned-empty"); // trickle source starved
    expect(getWarehouse(state, p).regime).toBe("pinned-full"); // backed up by the hub
  });

  it("un-jams a saturated chain within a single command (cascade resolves in one derive)", () => {
    // A -> B -> C, sink at C. With C closed, the whole chain jams full.
    const state = createSimState(42, 0);
    const a = addWarehouse(state, 0, R, I, 100);
    const b = addWarehouse(state, 0, R, J, 100);
    const c = addWarehouse(state, 0, R, K, 100);
    const deposit = addDeposit(state, 0, R, [], 1);
    const extractor = addExtractor(state, 0, 50, deposit, a);
    const ab = addRoute(state, 0, a, b, 20);
    const bc = addRoute(state, 0, b, c, 20);

    advance(state, 10_000); // everything fills and jams
    expect(getWarehouse(state, a).regime).toBe("pinned-full");
    expect(getWarehouse(state, b).regime).toBe("pinned-full");
    expect(getWarehouse(state, c).regime).toBe("pinned-full");
    expect(routeFlow(state, ab)).toBe(0);
    expect(routeFlow(state, bc)).toBe(0);

    // One command opens C's sink; the un-jam must propagate C -> B -> A in this derive.
    setWarehousePullRate(state, 10_000, c, 5);
    expect(routeFlow(state, bc)).toBe(5);
    expect(routeFlow(state, ab)).toBe(5);
    expect(extractorEffectiveRate(state, extractor)).toBe(5);
    // Net zero everywhere: the chain stays full but now flows steadily.
    expect(getWarehouse(state, a).regime).toBe("pinned-full");
    expect(getWarehouse(state, b).regime).toBe("pinned-full");
    expect(getWarehouse(state, c).regime).toBe("pinned-full");
  });

  it("rejects self-loops and cycles at the command boundary", () => {
    const state = createSimState(42, 0);
    const a = addWarehouse(state, 0, R, I, 100);
    const b = addWarehouse(state, 0, R, J, 100);
    expect(() => addRoute(state, 0, a, a, 5)).toThrow(/differ/);
    addRoute(state, 0, a, b, 5);
    expect(() => addRoute(state, 0, b, a, 5)).toThrow(/cycle/);
    expect(() => addRoute(state, 0, a, b, Number.NaN)).toThrow(/cap/);
    expect(() => addRoute(state, 0, a, b, -1)).toThrow(/cap/);
  });
});

describe("converters", () => {
  const ore = resourceType("ore");
  const ingot = resourceType("ingot");

  // Ample ore supply feeding a converter into an ingot warehouse; scenarios adjust
  // pulls to force each regime.
  function refinery(): {
    state: SimState;
    source: ReturnType<typeof addWarehouse>;
    dest: ReturnType<typeof addWarehouse>;
    converter: ReturnType<typeof addConverter>;
  } {
    const state = createSimState(42, 0);
    const source = addWarehouse(state, 0, ore, I, 1_000);
    const dest = addWarehouse(state, 0, ingot, I, 100);
    const deposit = addDeposit(state, 0, ore, [], 1);
    addExtractor(state, 0, 5, deposit, source);
    const converter = addConverter(state, 0, source, dest, 4, 0.5);
    return { state, source, dest, converter };
  }

  it("draws at cap and produces at draw · ratio when unconstrained", () => {
    const { state, source, dest, converter } = refinery();
    expect(converterDraw(state, converter)).toBe(4); // cap-limited below the 5/s supply
    expect(converterFeed(state, converter)).toBe(2);
    // Source keeps 5 - 4 = 1 ore/s; dest gains 2 ingots/s.
    expect(warehouseAmountAt(state, source, 10)).toBe(10);
    expect(warehouseAmountAt(state, dest, 10)).toBe(20);
    advance(state, 10);
    expect(converterDraw(state, converter)).toBe(4);
  });

  it("throttles the draw in source units when the destination jams", () => {
    const { state, source, dest, converter } = refinery();
    setWarehousePullRate(state, 0, dest, 1); // ingots leave slower than the 2/s feed
    advance(state, 200); // dest nets +1/s and pins full at t=100
    expect(getWarehouse(state, dest).regime).toBe("pinned-full");
    // Acceptance is 1 ingot/s, so the draw backs off to 1 / ratio = 2 ore/s.
    expect(converterFeed(state, converter)).toBe(1);
    expect(converterDraw(state, converter)).toBe(2);
    // Backpressure lands in the source's own units: it now keeps 5 - 2 = 3 ore/s.
    expect(warehouseAmountAt(state, source, 200)).toBe(400);
  });

  it("water-fills a starved source between a route and a converter", () => {
    const state = createSimState(42, 0);
    const source = addWarehouse(state, 0, ore, I, 100);
    const oreDest = addWarehouse(state, 0, ore, J, 1_000);
    const ingotDest = addWarehouse(state, 0, ingot, I, 1_000);
    const deposit = addDeposit(state, 0, ore, [], 1);
    addExtractor(state, 0, 3, deposit, source); // trickle below the combined demand of 6
    const route = addRoute(state, 0, source, oreDest, 4);
    const converter = addConverter(state, 0, source, ingotDest, 2, 0.5);
    advance(state, 100);
    expect(getWarehouse(state, source).regime).toBe("pinned-empty");
    // Water level 3/6: each consumer gets half its desire, in its own source units.
    expect(routeFlow(state, route)).toBe(2);
    expect(converterDraw(state, converter)).toBe(1);
    expect(converterFeed(state, converter)).toBe(0.5);
  });

  it("rejects a cross-type cycle over the combined transfer graph", () => {
    const state = createSimState(42, 0);
    const oreA = addWarehouse(state, 0, ore, I, 100);
    const ingotB = addWarehouse(state, 0, ingot, I, 100);
    const oreC = addWarehouse(state, 0, ore, J, 100);
    addConverter(state, 0, oreA, ingotB, 2, 0.5);
    addConverter(state, 0, ingotB, oreC, 2, 1);
    // Closing the loop with either edge kind is rejected before any mutation.
    expect(() => addRoute(state, 0, oreC, oreA, 5)).toThrow(/cycle/);
    expect(() => addConverter(state, 0, ingotB, oreA, 1, 1)).toThrow(/cycle/);
  });

  it("rejects same-type endpoints, self-loops, and bad caps/ratios at the boundary", () => {
    const state = createSimState(42, 0);
    const a = addWarehouse(state, 0, ore, I, 100);
    const b = addWarehouse(state, 0, ore, J, 100);
    const c = addWarehouse(state, 0, ingot, I, 100);
    expect(() => addConverter(state, 0, a, b, 2, 0.5)).toThrow(/must differ/);
    expect(() => addConverter(state, 0, a, a, 2, 0.5)).toThrow(/must differ/);
    expect(() => addConverter(state, 0, a, c, -1, 0.5)).toThrow(/cap/);
    expect(() => addConverter(state, 0, a, c, Number.NaN, 0.5)).toThrow(/cap/);
    expect(() => addConverter(state, 0, a, c, 2, 0)).toThrow(/ratio/);
    expect(() => addConverter(state, 0, a, c, 2, -2)).toThrow(/ratio/);
    expect(() => addConverter(state, 0, a, c, 2, Number.POSITIVE_INFINITY)).toThrow(/ratio/);
  });
});

describe("resource typing", () => {
  it("rejects an extractor whose deposit and warehouse types differ", () => {
    const state = createSimState(42, 0);
    const oreWarehouse = addWarehouse(state, 0, resourceType("ore"), I, 100);
    const stoneDeposit = addDeposit(state, 0, resourceType("stone"), [], 1);
    expect(() => addExtractor(state, 0, 2, stoneDeposit, oreWarehouse)).toThrow(
      /resource mismatch/,
    );
  });

  it("rejects a route between differently typed warehouses", () => {
    const state = createSimState(42, 0);
    const oreWarehouse = addWarehouse(state, 0, resourceType("ore"), I, 100);
    const stoneWarehouse = addWarehouse(state, 0, resourceType("stone"), I, 100);
    expect(() => addRoute(state, 0, oreWarehouse, stoneWarehouse, 5)).toThrow(/resource mismatch/);
  });
});

describe("one pool per island per resource", () => {
  it("rejects a second warehouse for the same island and resource", () => {
    const state = createSimState(1, 0);
    addWarehouse(state, 0, R, I, 100);
    expect(() => addWarehouse(state, 0, R, I, 100)).toThrow(/already has a/);
    // A different resource on the same island, or the same resource on another island, is fine.
    addWarehouse(state, 0, resourceType("other"), I, 100);
    addWarehouse(state, 0, R, J, 100);
  });

  it("sums multiple extractors of a resource into the island's single pool", () => {
    const state = createSimState(1, 0);
    const pool = addWarehouse(state, 0, R, I, 1_000);
    // Two veins, one pool: rates add (4 + 2), the one bar fills faster instead of forking.
    const veinA = addDeposit(state, 0, R, [], 1);
    const veinB = addDeposit(state, 0, R, [], 1);
    addExtractor(state, 0, 4, veinA, pool);
    addExtractor(state, 0, 2, veinB, pool);
    advance(state, 10);
    expect(warehouseAmountAt(state, pool, 10)).toBeCloseTo(60, 9);
  });

  it("rejects an empty resource tag at the command boundary", () => {
    const state = createSimState(1, 0);
    // Mirrors the import boundary's checkTag: a state the core accepts must round-trip.
    expect(() => addWarehouse(state, 0, resourceType(""), I, 100)).toThrow(/resource/);
    expect(() => addDeposit(state, 0, resourceType(""), [], 1)).toThrow(/resource/);
  });
});

describe("resource-costed building", () => {
  const ore = resourceType("ore");
  const stone = resourceType("stone");
  const home = islandId("home");
  const other = islandId("other");

  // The home island's single ore pool (one per (island, resource)), seeded to 60 by t=10, plus
  // an empty stone quarry to build onto. Returns the pieces the build scenarios assert against.
  function homeIsland(): {
    state: SimState;
    orePool: ReturnType<typeof addWarehouse>;
    stoneDeposit: ReturnType<typeof addDeposit>;
    quarry: ReturnType<typeof addWarehouse>;
  } {
    const state = createSimState(42, 0);
    const oreDeposit = addDeposit(state, 0, ore, [], 1);
    const orePool = addWarehouse(state, 0, ore, home, 1_000);
    addExtractor(state, 0, 6, oreDeposit, orePool); // 60 by t=10
    const stoneDeposit = addDeposit(state, 0, stone, [], 1);
    const quarry = addWarehouse(state, 0, stone, home, 100);
    return { state, orePool, stoneDeposit, quarry };
  }

  it("debits the build cost from the island's single resource pool", () => {
    const { state, orePool, stoneDeposit, quarry } = homeIsland();
    buildExtractor(state, 10, new Map([[ore, 30]]), 5, stoneDeposit, quarry, home);
    // 60 ore at t=10, less the 30 charge -> 30 left; the new extractor then produces stone.
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(30, 9);
    expect(warehouseAmountAt(state, quarry, 20)).toBeCloseTo(50, 9);
  });

  it("rejects an unaffordable build without touching any stock (atomic)", () => {
    const { state, orePool, stoneDeposit, quarry } = homeIsland();
    expect(() =>
      buildExtractor(state, 10, new Map([[ore, 100]]), 5, stoneDeposit, quarry, home),
    ).toThrow(/insufficient/);
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(60, 9);
    expect(warehouseAmountAt(state, quarry, 20)).toBe(0); // no producer was wired
  });

  it("cannot pay from another island's warehouse", () => {
    const { state, stoneDeposit, quarry } = homeIsland();
    // A vault brimming with ore on a different island is unreachable by the home build.
    const otherDeposit = addDeposit(state, 0, ore, [], 1);
    const vault = addWarehouse(state, 0, ore, other, 10_000);
    addExtractor(state, 0, 100, otherDeposit, vault); // 1000 ore by t=10, all off-island
    expect(() =>
      buildExtractor(state, 10, new Map([[ore, 100]]), 5, stoneDeposit, quarry, home),
    ).toThrow(/insufficient/);
    expect(warehouseAmountAt(state, vault, 10)).toBeCloseTo(1_000, 9);
  });

  it("charges the build-site island, not the output pool's island", () => {
    // A knowledge-style observatory: the output pool sits off the home island (a global scope),
    // but the wood/stone cost is paid from home, where the structure is built.
    const state = createSimState(42, 0);
    const oreDeposit = addDeposit(state, 0, ore, [], 1);
    const orePool = addWarehouse(state, 0, ore, home, 1_000);
    addExtractor(state, 0, 6, oreDeposit, orePool); // 60 ore on home by t=10
    const offDeposit = addDeposit(state, 0, stone, [], 1);
    const offPool = addWarehouse(state, 0, stone, other, 100);
    buildExtractor(state, 10, new Map([[ore, 30]]), 5, offDeposit, offPool, home);
    // Paid from home's ore pool (60 -> 30) while the producer fills the off-home pool.
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(30, 9);
    expect(warehouseAmountAt(state, offPool, 20)).toBeCloseTo(50, 9);
  });

  it("treats a build island with no pool for a cost resource as miswired content, not a shortfall", () => {
    const { state, orePool, stoneDeposit, quarry } = homeIsland();
    // `other` holds no ore pool at all: the cost can never be paid there. That must NOT be the
    // benign InsufficientStockError callers catch-and-retry — it would soft-lock silently.
    expect(() =>
      buildExtractor(state, 10, new Map([[ore, 30]]), 5, stoneDeposit, quarry, other),
    ).toThrow(/no ore pool on island other/);
    let thrown: unknown;
    try {
      buildExtractor(state, 10, new Map([[ore, 30]]), 5, stoneDeposit, quarry, other);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(InsufficientStockError);
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(60, 9); // nothing debited
  });

  it("does not debit an affordable resource when another in the cost falls short", () => {
    const { state, orePool, stoneDeposit, quarry } = homeIsland();
    // ore (30 <= 60) is affordable, stone (100) is not: the whole command must roll back.
    const cost = new Map([
      [ore, 30],
      [stone, 100],
    ]);
    expect(() => buildExtractor(state, 10, cost, 5, stoneDeposit, quarry, home)).toThrow(
      /insufficient/,
    );
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(60, 9);
  });
});

describe("resource-costed converter builds", () => {
  const ore = resourceType("ore");
  const ingot = resourceType("ingot");
  const home = islandId("home");
  const other = islandId("other");

  // Home island: an ore pool fed at 6/s (60 by t=10) to both pay the build and feed the
  // converter, plus an empty ingot pool to refine into.
  function refineryIsland(): {
    state: SimState;
    orePool: ReturnType<typeof addWarehouse>;
    ingotPool: ReturnType<typeof addWarehouse>;
  } {
    const state = createSimState(42, 0);
    const oreDeposit = addDeposit(state, 0, ore, [], 1);
    const orePool = addWarehouse(state, 0, ore, home, 1_000);
    addExtractor(state, 0, 6, oreDeposit, orePool); // 60 by t=10
    const ingotPool = addWarehouse(state, 0, ingot, home, 1_000);
    return { state, orePool, ingotPool };
  }

  it("debits the build cost from the island pool and wires the refining converter", () => {
    const { state, orePool, ingotPool } = refineryIsland();
    buildConverter(state, 10, new Map([[ore, 20]]), orePool, ingotPool, 4, 0.5);
    // 60 ore at t=10, less the 20 charge -> 40 left; the converter then draws 4 ore/s and feeds
    // 4·0.5 = 2 ingot/s, while the extractor keeps adding 6 ore/s (net +2 ore/s in the pool).
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(40, 9);
    expect(warehouseAmountAt(state, ingotPool, 20)).toBeCloseTo(20, 9);
    expect(warehouseAmountAt(state, orePool, 20)).toBeCloseTo(60, 9);
  });

  it("rejects endpoints on different islands without touching stock (atomic)", () => {
    const { state, orePool } = refineryIsland();
    const offIsland = addWarehouse(state, 0, ingot, other, 1_000);
    expect(() =>
      buildConverter(state, 10, new Map([[ore, 20]]), orePool, offIsland, 4, 0.5),
    ).toThrow(/share an island/);
    expect(warehouseAmountAt(state, orePool, 10)).toBeCloseTo(60, 9);
  });

  it("throws InsufficientStockError when the island can't cover the cost", () => {
    const { state, orePool, ingotPool } = refineryIsland();
    // t=0: the extractor hasn't produced yet, so the 20-ore charge is uncoverable. The typed
    // error is what lets callers treat only this failure as retryable.
    expect(() =>
      buildConverter(state, 0, new Map([[ore, 20]]), orePool, ingotPool, 4, 0.5),
    ).toThrow(InsufficientStockError);
  });
});

describe("storage capacity upgrade", () => {
  const ingot = resourceType("ingot");
  const ore = resourceType("ore");
  const wood = resourceType("wood");
  const home = islandId("home");
  const other = islandId("other");

  // Home island with three pools: an ingot pool capped at 100 and fed 10/s (full and pinned by
  // t=10), an empty ore pool at 100, and a wood pool (cap 1_000) seeded to 200 to pay the upgrade.
  // Plus a same-resource pool on ANOTHER island that the home upgrade must leave alone.
  function islandFixture(): {
    state: SimState;
    ingotPool: ReturnType<typeof addWarehouse>;
    orePool: ReturnType<typeof addWarehouse>;
    woodPool: ReturnType<typeof addWarehouse>;
    offPool: ReturnType<typeof addWarehouse>;
  } {
    const state = createSimState(42, 0);
    const ingotDeposit = addDeposit(state, 0, ingot, [], 1);
    const ingotPool = addWarehouse(state, 0, ingot, home, 100);
    addExtractor(state, 0, 10, ingotDeposit, ingotPool); // full at t=10, then pinned
    const orePool = addWarehouse(state, 0, ore, home, 100);
    const woodPool = addWarehouse(state, 0, wood, home, 1_000);
    grantResource(state, 0, woodPool, 200);
    const offPool = addWarehouse(state, 0, ingot, other, 100);
    return { state, ingotPool, orePool, woodPool, offPool };
  }

  it("raises every pool on the island, debits once, and unpins a jammed pool", () => {
    const { state, ingotPool, orePool, woodPool, offPool } = islandFixture();
    // Pinned full at cap 100 — no headroom for the 10/s producer.
    expect(warehouseAmountAt(state, ingotPool, 20)).toBeCloseTo(100, 9);

    upgradeIslandCapacity(state, 20, new Map([[wood, 80]]), home, 250);

    // Every home pool rises to 250, except the wood pool already above it (raise-only, untouched).
    expect(getWarehouse(state, ingotPool).capacity).toBe(250);
    expect(getWarehouse(state, orePool).capacity).toBe(250);
    expect(getWarehouse(state, woodPool).capacity).toBe(1_000);
    expect(getWarehouse(state, offPool).capacity).toBe(100); // other island untouched
    // The cost is debited exactly once from the island: 200 - 80 = 120.
    expect(warehouseAmountAt(state, woodPool, 20)).toBeCloseTo(120, 9);
    // The 100 held ingot is preserved, then fills again at 10/s toward the new 250 cap.
    expect(warehouseAmountAt(state, ingotPool, 30)).toBeCloseTo(200, 9);
    expect(warehouseAmountAt(state, ingotPool, 40)).toBeCloseTo(250, 9); // re-pinned at the new cap
  });

  it("throws InsufficientStockError and leaves every cap and stock untouched when unaffordable", () => {
    const { state, ingotPool, orePool, woodPool } = islandFixture();
    expect(() => upgradeIslandCapacity(state, 20, new Map([[wood, 500]]), home, 250)).toThrow(
      InsufficientStockError,
    );
    expect(getWarehouse(state, ingotPool).capacity).toBe(100);
    expect(getWarehouse(state, orePool).capacity).toBe(100);
    expect(warehouseAmountAt(state, woodPool, 20)).toBeCloseTo(200, 9);
  });

  it("rejects a non-positive or non-finite capacity before charging anything", () => {
    const { state, ingotPool, woodPool } = islandFixture();
    for (const bad of [0, -1, Number.NaN, Infinity]) {
      expect(() => upgradeIslandCapacity(state, 20, new Map([[wood, 10]]), home, bad)).toThrow(
        /capacity must be finite and > 0/,
      );
    }
    expect(getWarehouse(state, ingotPool).capacity).toBe(100);
    expect(warehouseAmountAt(state, woodPool, 20)).toBeCloseTo(200, 9);
  });
});

// The wood/stone bootstrap loop the app boots into (packages/app/src/sim/world.ts): a seeded
// stockpile, no extractors, and cross-resource build costs that gate later builds behind
// accumulation.
describe("granted stockpile bootstrap", () => {
  const wood = resourceType("wood");
  const stone = resourceType("stone");
  const home = islandId("home");

  // Two wood + two stone deposits sharing one Wood pool and one Stone pool on the home island
  // (one per (island, resource), mirroring createDemoWorld). Both pools seeded to 30. Nothing
  // is producing yet.
  function bootstrap(): {
    state: SimState;
    woodPool: ReturnType<typeof addWarehouse>;
    stonePool: ReturnType<typeof addWarehouse>;
    woodDepositB: ReturnType<typeof addDeposit>;
    stoneDepositA: ReturnType<typeof addDeposit>;
  } {
    const state = createSimState(1, 0);
    addDeposit(state, 0, wood, [], 1); // wood deposit A (unworked)
    const woodDepositB = addDeposit(state, 0, wood, [], 1);
    const stoneDepositA = addDeposit(state, 0, stone, [], 1);
    addDeposit(state, 0, stone, [], 1); // stone deposit B (unworked)
    const woodPool = addWarehouse(state, 0, wood, home, 100);
    const stonePool = addWarehouse(state, 0, stone, home, 100);
    grantResource(state, 0, woodPool, 30);
    grantResource(state, 0, stonePool, 30);
    return { state, woodPool, stonePool, woodDepositB, stoneDepositA };
  }

  it("seeds the stockpile with no producer and reflects it in canAffordBuild", () => {
    const { state, woodPool, stonePool } = bootstrap();
    expect(warehouseAmountAt(state, woodPool, 0)).toBeCloseTo(30, 9);
    expect(warehouseAmountAt(state, stonePool, 0)).toBeCloseTo(30, 9);
    // No producer: the seed does not grow over time.
    expect(warehouseAmountAt(state, woodPool, 1_000)).toBeCloseTo(30, 9);
    // A stone extractor costs 20 wood — affordable now, but 40 wood is not.
    expect(canAffordBuild(state, 0, home, new Map([[wood, 20]]))).toBe(true);
    expect(canAffordBuild(state, 0, home, new Map([[wood, 40]]))).toBe(false);
  });

  it("gates the third build behind accumulation from the first two", () => {
    const { state, woodPool, stonePool, woodDepositB, stoneDepositA } = bootstrap();
    // Build both starters at t=0: stone extractor costs 20 wood, wood extractor costs 20 stone.
    buildExtractor(state, 0, new Map([[wood, 20]]), 1, stoneDepositA, stonePool, home);
    buildExtractor(state, 0, new Map([[stone, 20]]), 1, woodDepositB, woodPool, home);
    // 30 - 20 = 10 in each pool; both new extractors now produce 1/s into their pool.
    expect(warehouseAmountAt(state, woodPool, 0)).toBeCloseTo(10, 9);
    expect(warehouseAmountAt(state, stonePool, 0)).toBeCloseTo(10, 9);
    // A further wood extractor costs 20 stone: not yet affordable, only 10 stone on the island.
    expect(canAffordBuild(state, 0, home, new Map([[stone, 20]]))).toBe(false);
    // The stone pool accrues 1/s from t=0; by t=10 it holds 20 stone and the build unlocks.
    advance(state, 10);
    expect(warehouseAmountAt(state, stonePool, 10)).toBeCloseTo(20, 9);
    expect(canAffordBuild(state, 10, home, new Map([[stone, 20]]))).toBe(true);
    // Sanity: the wood pool (fed by the earlier build) is filling too — 10 left after the debit
    // plus 1/s from the wood extractor -> 20 by t=10.
    expect(warehouseAmountAt(state, woodPool, 10)).toBeCloseTo(20, 9);
  });

  it("clamps a grant at the warehouse capacity", () => {
    const state = createSimState(1, 0);
    const wh = addWarehouse(state, 0, wood, home, 100);
    grantResource(state, 0, wh, 80);
    grantResource(state, 0, wh, 50); // would reach 130; capped at 100
    expect(warehouseAmountAt(state, wh, 0)).toBeCloseTo(100, 9);
  });

  it("rejects a negative or non-finite grant", () => {
    const state = createSimState(1, 0);
    const wh = addWarehouse(state, 0, wood, home, 100);
    expect(() => grantResource(state, 0, wh, -5)).toThrow(/must be finite and >= 0/);
    expect(() => grantResource(state, 0, wh, Number.NaN)).toThrow(/must be finite and >= 0/);
  });
});

describe("determinism", () => {
  const TOTAL_SPAN = 3 * 86_400;

  // Same 3-day span, same mid-run commands at exact times — only the advance()
  // granularity differs. Bit-identical final state is the load-bearing invariant
  // (ADR-0001 §5, §8, consequences). The deposit tiers interleave crossings with the
  // command-driven regime flips.
  function runScenario(stepCount: number): SaveDocument {
    const state = createSimState(7, 0);
    const warehouseId = addWarehouse(state, 0, R, I, 500);
    const depositId = addDeposit(
      state,
      0,
      R,
      [
        { amount: 60_000, multiplier: 1.5 },
        { amount: 90_000, multiplier: 0.75 },
      ],
      0.25,
    );
    addExtractor(state, 0, 3, depositId, warehouseId);
    setWarehousePullRate(state, 0, warehouseId, 1);
    const commands: readonly (readonly [number, number])[] = [
      [40_000, 5], // drain toward empty
      [90_000, 0.25], // refill toward full
      [200_000, 3], // drain again
    ];
    let nextCommand = 0;
    const advanceTo = (t: number): void => {
      for (; nextCommand < commands.length; nextCommand += 1) {
        const command = commands[nextCommand];
        if (command === undefined || command[0] > t) {
          break;
        }
        setWarehousePullRate(state, command[0], warehouseId, command[1]);
      }
      advance(state, t);
    };
    for (let i = 1; i <= stepCount; i += 1) {
      advanceTo((i * TOTAL_SPAN) / stepCount);
    }
    return serializeState(state);
  }

  it("one 3-day advance is bit-identical to thousands of small advances", () => {
    const single = runScenario(1);
    expect(runScenario(10_000)).toStrictEqual(single);
    // Uneven step boundaries hit different intermediate times; result must not care.
    expect(runScenario(3_333)).toStrictEqual(single);
  });

  // A transfer network (fan-out A->B, A->C, chain B->C, and a converter tail C->refined)
  // with regime flips and a route re-cap over the span. The solver runs at every
  // event/command epoch, so a coupled graph must still replay bit-identically across
  // advance granularities.
  function runRouteScenario(stepCount: number): SaveDocument {
    const state = createSimState(13, 0);
    const a = addWarehouse(state, 0, R, I, 400);
    const b = addWarehouse(state, 0, R, J, 300);
    const c = addWarehouse(state, 0, R, K, 500);
    const refined = addWarehouse(state, 0, resourceType("refined"), I, 250);
    const deposit = addDeposit(state, 0, R, [{ amount: 50_000, multiplier: 2 }], 0.5);
    addExtractor(state, 0, 4, deposit, a);
    const ab = addRoute(state, 0, a, b, 3);
    addRoute(state, 0, a, c, 2); // fan-out from A
    addRoute(state, 0, b, c, 2); // and a chain into C
    addConverter(state, 0, c, refined, 1.5, 0.5); // refinement tail off C (cross-type)
    setWarehousePullRate(state, 0, c, 1);
    setWarehousePullRate(state, 0, refined, 0.25);
    const commands: readonly (readonly [number, () => void])[] = [
      [30_000, (): void => setWarehousePullRate(state, 30_000, c, 6)], // open C's sink
      [80_000, (): void => setRouteCap(state, 80_000, ab, 8)], // widen A->B
      [150_000, (): void => setWarehousePullRate(state, 150_000, b, 4)], // drain B
    ];
    let nextCommand = 0;
    const advanceTo = (t: number): void => {
      for (; nextCommand < commands.length; nextCommand += 1) {
        const command = commands[nextCommand];
        if (command === undefined || command[0] > t) {
          break;
        }
        command[1]();
      }
      advance(state, t);
    };
    for (let i = 1; i <= stepCount; i += 1) {
      advanceTo((i * TOTAL_SPAN) / stepCount);
    }
    return serializeState(state);
  }

  it("replays a coupled transfer network bit-identically across advance granularities", () => {
    const single = runRouteScenario(1);
    expect(runRouteScenario(10_000)).toStrictEqual(single);
    expect(runRouteScenario(3_333)).toStrictEqual(single);
  });
});
