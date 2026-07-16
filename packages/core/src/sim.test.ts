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
  buildExtractor,
  converterDraw,
  converterFeed,
  depositMultiplier,
  depositRemainingAt,
  extractorEffectiveRate,
  routeFlow,
  setRouteCap,
  setWarehousePullRate,
  warehouseAmountAt,
  warehouseOutflowRate,
} from "./sim.ts";
import { createSimState, type SimState } from "./state.ts";

// Single shared type for the many single-resource scenarios; type-match cases below use
// their own distinct tags.
const R = resourceType("stuff");
const I = islandId("here");

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
    const dest = addWarehouse(state, 0, R, I, 1_000);
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
    const dest = addWarehouse(state, 0, R, I, 50);
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
    const dest = addWarehouse(state, 0, R, I, 100);
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
    const q = addWarehouse(state, 0, R, I, 100);
    const hub = addWarehouse(state, 0, R, I, 50);
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
    const b = addWarehouse(state, 0, R, I, 100);
    const c = addWarehouse(state, 0, R, I, 100);
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
    const b = addWarehouse(state, 0, R, I, 100);
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
    const oreDest = addWarehouse(state, 0, ore, I, 1_000);
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
    const oreC = addWarehouse(state, 0, ore, I, 100);
    addConverter(state, 0, oreA, ingotB, 2, 0.5);
    addConverter(state, 0, ingotB, oreC, 2, 1);
    // Closing the loop with either edge kind is rejected before any mutation.
    expect(() => addRoute(state, 0, oreC, oreA, 5)).toThrow(/cycle/);
    expect(() => addConverter(state, 0, ingotB, oreA, 1, 1)).toThrow(/cycle/);
  });

  it("rejects same-type endpoints, self-loops, and bad caps/ratios at the boundary", () => {
    const state = createSimState(42, 0);
    const a = addWarehouse(state, 0, ore, I, 100);
    const b = addWarehouse(state, 0, ore, I, 100);
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

describe("resource-costed building", () => {
  const ore = resourceType("ore");
  const stone = resourceType("stone");
  const home = islandId("home");
  const other = islandId("other");

  // Two ore warehouses on the home island, seeded to 40 and 20 by t=10, plus an empty stone
  // quarry to build onto. Returns the pieces the build scenarios assert against.
  function homeIsland(): {
    state: SimState;
    oreA: ReturnType<typeof addWarehouse>;
    oreB: ReturnType<typeof addWarehouse>;
    stoneDeposit: ReturnType<typeof addDeposit>;
    quarry: ReturnType<typeof addWarehouse>;
  } {
    const state = createSimState(42, 0);
    const oreDeposit = addDeposit(state, 0, ore, [], 1);
    const oreA = addWarehouse(state, 0, ore, home, 1_000);
    const oreB = addWarehouse(state, 0, ore, home, 1_000);
    addExtractor(state, 0, 4, oreDeposit, oreA); // 40 by t=10
    addExtractor(state, 0, 2, oreDeposit, oreB); // 20 by t=10
    const stoneDeposit = addDeposit(state, 0, stone, [], 1);
    const quarry = addWarehouse(state, 0, stone, home, 100);
    return { state, oreA, oreB, stoneDeposit, quarry };
  }

  it("debits the cost across same-island warehouses in proportion to their stock", () => {
    const { state, oreA, oreB, stoneDeposit, quarry } = homeIsland();
    buildExtractor(state, 10, new Map([[ore, 30]]), 5, stoneDeposit, quarry);
    // 40:20 split of a 30 charge -> 20 and 10 drawn; the new extractor then produces stone.
    expect(warehouseAmountAt(state, oreA, 10)).toBeCloseTo(20, 9);
    expect(warehouseAmountAt(state, oreB, 10)).toBeCloseTo(10, 9);
    expect(warehouseAmountAt(state, quarry, 20)).toBeCloseTo(50, 9);
  });

  it("rejects an unaffordable build without touching any stock (atomic)", () => {
    const { state, oreA, oreB, stoneDeposit, quarry } = homeIsland();
    expect(() => buildExtractor(state, 10, new Map([[ore, 100]]), 5, stoneDeposit, quarry)).toThrow(
      /insufficient/,
    );
    expect(warehouseAmountAt(state, oreA, 10)).toBeCloseTo(40, 9);
    expect(warehouseAmountAt(state, oreB, 10)).toBeCloseTo(20, 9);
    expect(warehouseAmountAt(state, quarry, 20)).toBe(0); // no producer was wired
  });

  it("cannot pay from another island's warehouse", () => {
    const { state, stoneDeposit, quarry } = homeIsland();
    // A vault brimming with ore on a different island is unreachable by the home build.
    const otherDeposit = addDeposit(state, 0, ore, [], 1);
    const vault = addWarehouse(state, 0, ore, other, 10_000);
    addExtractor(state, 0, 100, otherDeposit, vault); // 1000 ore by t=10, all off-island
    expect(() => buildExtractor(state, 10, new Map([[ore, 100]]), 5, stoneDeposit, quarry)).toThrow(
      /insufficient/,
    );
    expect(warehouseAmountAt(state, vault, 10)).toBeCloseTo(1_000, 9);
  });

  it("does not debit an affordable resource when another in the cost falls short", () => {
    const { state, oreA, oreB, stoneDeposit, quarry } = homeIsland();
    // ore (30 <= 60) is affordable, stone (100) is not: the whole command must roll back.
    const cost = new Map([
      [ore, 30],
      [stone, 100],
    ]);
    expect(() => buildExtractor(state, 10, cost, 5, stoneDeposit, quarry)).toThrow(/insufficient/);
    expect(warehouseAmountAt(state, oreA, 10)).toBeCloseTo(40, 9);
    expect(warehouseAmountAt(state, oreB, 10)).toBeCloseTo(20, 9);
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
    const b = addWarehouse(state, 0, R, I, 300);
    const c = addWarehouse(state, 0, R, I, 500);
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
