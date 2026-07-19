import { describe, expect, it } from "vitest";

import { getWarehouse } from "./components/warehouse.ts";
import { islandId } from "./island.ts";
import {
  converterStatus,
  isWarehouseJammed,
  isWarehouseStarved,
  listJams,
  routeStatus,
  warehouseJamChain,
} from "./jam.ts";
import { resourceType } from "./resource.ts";
import {
  addConverter,
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  advance,
  converterDraw,
  grantResource,
  setWarehousePullRate,
} from "./sim.ts";
import { createSimState, type SimState } from "./state.ts";

const R = resourceType("stuff");
const PLANK = resourceType("plank");
const I = islandId("here");
const J = islandId("there");

// Pool fed by a plain perpetual producer (pure-floor deposit at multiplier 1).
function fedPool(state: SimState, rate: number, capacity: number, island = I) {
  const warehouseId = addWarehouse(state, 0, R, island, capacity);
  const depositId = addDeposit(state, 0, R, [], 1);
  addExtractor(state, 0, rate, depositId, warehouseId);
  return warehouseId;
}

describe("single-pool roots", () => {
  it("classifies a full pool with a slow consumer as outflow-deficit", () => {
    const state = createSimState(42, 0);
    const pool = fedPool(state, 2, 100);
    setWarehousePullRate(state, 0, pool, 0.5);
    advance(state, 100); // fills at 100 / 1.5
    expect(isWarehouseJammed(state, pool)).toBe(true);
    const chain = warehouseJamChain(state, pool);
    expect(chain?.steps).toEqual([{ warehouseId: pool, kind: "pool-full", via: null }]);
    expect(chain?.root).toEqual({
      kind: "outflow-deficit",
      warehouseId: pool,
      cappedTransferIds: [],
      dryDepositIds: [],
    });
  });

  it("classifies a full pool with no consumers at all as closed-sink", () => {
    const state = createSimState(42, 0);
    const pool = fedPool(state, 2, 100);
    advance(state, 60);
    expect(warehouseJamChain(state, pool)?.root.kind).toBe("closed-sink");
  });

  it("does not call a balanced pool at cap a jam", () => {
    const state = createSimState(42, 0);
    const pool = fedPool(state, 2, 100);
    setWarehousePullRate(state, 0, pool, 2);
    grantResource(state, 0, pool, 100);
    expect(getWarehouse(state, pool).regime).toBe("pinned-full");
    expect(isWarehouseJammed(state, pool)).toBe(false);
    expect(warehouseJamChain(state, pool)).toBeNull();
  });

  it("reports no chain for a tracking pool", () => {
    const state = createSimState(42, 0);
    const pool = fedPool(state, 2, 100);
    setWarehousePullRate(state, 0, pool, 1);
    advance(state, 10);
    expect(warehouseJamChain(state, pool)).toBeNull();
  });
});

describe("backpressure across a route", () => {
  function jammedPair(): {
    state: SimState;
    src: ReturnType<typeof addWarehouse>;
    dst: ReturnType<typeof addWarehouse>;
    route: ReturnType<typeof addRoute>;
  } {
    const state = createSimState(42, 0);
    const src = fedPool(state, 2, 100, I);
    const dst = addWarehouse(state, 0, R, J, 50);
    const route = addRoute(state, 0, src, dst, 5);
    // dst has no consumer: it fills at t=25, backpressure then fills src by t=75.
    advance(state, 200);
    return { state, src, dst, route };
  }

  it("walks the chain from the symptom pool to the closed-sink root", () => {
    const { state, src, dst, route } = jammedPair();
    expect(isWarehouseJammed(state, src)).toBe(true);
    expect(isWarehouseJammed(state, dst)).toBe(true);
    const chain = warehouseJamChain(state, src);
    expect(chain?.steps).toEqual([
      { warehouseId: src, kind: "pool-full", via: null },
      { warehouseId: dst, kind: "pool-full", via: { transferKind: "route", transferId: route } },
    ]);
    expect(chain?.root.kind).toBe("closed-sink");
    expect(chain?.root.warehouseId).toBe(dst);
  });

  it("names the true cause on the route and orders roots before symptoms", () => {
    const { state, src, dst, route } = jammedPair();
    expect(routeStatus(state, route)).toEqual({
      kind: "blocked-destination",
      causeWarehouseId: dst,
    });
    expect(listJams(state).map((entry) => [entry.warehouseId, entry.isRoot])).toEqual([
      [dst, true],
      [src, false],
    ]);
  });
});

describe("route cap bottleneck", () => {
  it("blames the binding cap from both sides", () => {
    const state = createSimState(42, 0);
    const src = fedPool(state, 5, 100, I);
    const dst = addWarehouse(state, 0, R, J, 50);
    const route = addRoute(state, 0, src, dst, 1);
    setWarehousePullRate(state, 0, dst, 3);
    advance(state, 100); // src fills at net 4/s; dst never rises above empty
    expect(isWarehouseJammed(state, src)).toBe(true);
    expect(isWarehouseStarved(state, dst)).toBe(true);
    const srcChain = warehouseJamChain(state, src);
    expect(srcChain?.steps).toHaveLength(1);
    expect(srcChain?.root.kind).toBe("transfer-capped");
    expect(srcChain?.root.cappedTransferIds).toEqual([route]);
    const dstChain = warehouseJamChain(state, dst);
    expect(dstChain?.steps).toHaveLength(1);
    expect(dstChain?.root.kind).toBe("transfer-capped");
    expect(dstChain?.root.cappedTransferIds).toEqual([route]);
    // The route itself runs at cap — it is the bottleneck, not a symptom.
    expect(routeStatus(state, route).kind).toBe("flowing");
  });
});

describe("starvation across a route", () => {
  it("walks upstream to a no-producer root and names the starved source", () => {
    const state = createSimState(42, 0);
    const src = addWarehouse(state, 0, R, I, 100);
    const dst = addWarehouse(state, 0, R, J, 50);
    const route = addRoute(state, 0, src, dst, 2);
    setWarehousePullRate(state, 0, dst, 1);
    advance(state, 10);
    expect(isWarehouseStarved(state, dst)).toBe(true);
    const chain = warehouseJamChain(state, dst);
    expect(chain?.steps).toEqual([
      { warehouseId: dst, kind: "pool-empty", via: null },
      { warehouseId: src, kind: "pool-empty", via: { transferKind: "route", transferId: route } },
    ]);
    expect(chain?.root.kind).toBe("no-producer");
    expect(routeStatus(state, route)).toEqual({ kind: "starved-source", causeWarehouseId: src });
  });
});

describe("converter in the chain", () => {
  it("carries the blockage through the converter to the full destination", () => {
    const state = createSimState(42, 0);
    const wood = fedPool(state, 2, 100, I);
    const planks = addWarehouse(state, 0, PLANK, I, 10);
    const converter = addConverter(state, 0, wood, planks, 1, 1);
    // planks fill at t=10; wood then fills on full inflow by t=55.
    advance(state, 150);
    expect(isWarehouseJammed(state, wood)).toBe(true);
    const chain = warehouseJamChain(state, wood);
    expect(chain?.steps).toEqual([
      { warehouseId: wood, kind: "pool-full", via: null },
      {
        warehouseId: planks,
        kind: "pool-full",
        via: { transferKind: "converter", transferId: converter },
      },
    ]);
    expect(chain?.root.kind).toBe("closed-sink");
    expect(converterStatus(state, converter)).toEqual({
      kind: "blocked-destination",
      causeWarehouseId: planks,
    });
  });
});

describe("dry deposit", () => {
  it("blames the floor-regime deposit for a starved pool", () => {
    const state = createSimState(42, 0);
    const pool = addWarehouse(state, 0, R, I, 100);
    const deposit = addDeposit(state, 0, R, [{ amount: 10, multiplier: 1 }], 0.25);
    addExtractor(state, 0, 2, deposit, pool);
    setWarehousePullRate(state, 0, pool, 1);
    // Tier drains by t=5; the 0.5/s floor trickle then loses to the 1/s pull — empty at 15.
    advance(state, 30);
    expect(isWarehouseStarved(state, pool)).toBe(true);
    const chain = warehouseJamChain(state, pool);
    expect(chain?.steps).toHaveLength(1);
    expect(chain?.root.kind).toBe("dry-deposit");
    expect(chain?.root.dryDepositIds).toEqual([deposit]);
  });
});

describe("balanced boundary pools (phantom-jam regression)", () => {
  it("does not flag pools whose throttled inflow exactly matches their drain", () => {
    const state = createSimState(42, 0);
    const src = fedPool(state, 1, 100, I); // pull 0: a pure relay source
    const dst = addWarehouse(state, 0, R, J, 50);
    addRoute(state, 0, src, dst, 10);
    setWarehousePullRate(state, 0, dst, 1);
    grantResource(state, 0, dst, 50);
    advance(state, 20);
    // dst sits at cap in exact balance (route delivers src's whole 1/s, pull drains 1/s):
    // pinned regimes, but nothing is denied anything — no jam, no starvation.
    expect(getWarehouse(state, dst).regime).toBe("pinned-full");
    expect(isWarehouseJammed(state, dst)).toBe(false);
    expect(warehouseJamChain(state, dst)).toBeNull();
    expect(getWarehouse(state, src).regime).toBe("pinned-empty");
    expect(isWarehouseStarved(state, src)).toBe(false);
    expect(warehouseJamChain(state, src)).toBeNull();
  });
});

describe("zero-tier deposits (dry-deposit regression)", () => {
  it("classifies a starved pool fed by a perpetual trickle as inflow-deficit, not dry", () => {
    const state = createSimState(42, 0);
    const pool = fedPool(state, 1, 100); // zero-tier deposit: never rich, never dry
    setWarehousePullRate(state, 0, pool, 3);
    advance(state, 10);
    expect(isWarehouseStarved(state, pool)).toBe(true);
    const chain = warehouseJamChain(state, pool);
    expect(chain?.root.kind).toBe("inflow-deficit");
    expect(chain?.root.dryDepositIds).toEqual([]);
  });
});

describe("converter at cap with decimal ratio (ulp regression)", () => {
  it("keeps a fully-granted converter reading exactly at cap through the ratio round-trip", () => {
    const state = createSimState(42, 0);
    const wood = fedPool(state, 2, 100, I);
    const planks = addWarehouse(state, 0, PLANK, I, 10);
    const converter = addConverter(state, 0, wood, planks, 0.7, 0.1);
    // Balance planks exactly at the converter's feed rate, at cap — the boundary where
    // (cap·ratio)/ratio used to round an ulp under cap and read as blocked.
    setWarehousePullRate(state, 0, planks, 0.7 * 0.1);
    grantResource(state, 0, planks, 10);
    advance(state, 100); // wood fills at net 1.3/s
    expect(converterDraw(state, converter)).toBe(0.7);
    expect(converterStatus(state, converter).kind).toBe("flowing");
    expect(isWarehouseJammed(state, planks)).toBe(false);
    expect(isWarehouseJammed(state, wood)).toBe(true);
    const chain = warehouseJamChain(state, wood);
    expect(chain?.steps).toHaveLength(1);
    expect(chain?.root.kind).toBe("transfer-capped");
    expect(chain?.root.cappedTransferIds).toEqual([converter]);
  });
});

describe("cap-0 edges", () => {
  it("reports a closed valve as shut and classifies it as the binding cap", () => {
    const state = createSimState(42, 0);
    const src = fedPool(state, 1, 50, I);
    const dst = addWarehouse(state, 0, R, J, 50);
    const route = addRoute(state, 0, src, dst, 0);
    setWarehousePullRate(state, 0, dst, 1);
    advance(state, 100); // src fills behind the closed valve
    expect(routeStatus(state, route)).toEqual({ kind: "shut", causeWarehouseId: null });
    expect(isWarehouseJammed(state, src)).toBe(true);
    const chain = warehouseJamChain(state, src);
    expect(chain?.steps).toHaveLength(1);
    expect(chain?.root.kind).toBe("transfer-capped");
    expect(chain?.root.cappedTransferIds).toEqual([route]);
  });
});
