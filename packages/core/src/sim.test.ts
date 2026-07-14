import { describe, expect, it } from "vitest";

import { getWarehouse } from "./components/warehouse.ts";
import { serializeState, type SaveDocument } from "./serialize.ts";
import {
  addDeposit,
  addExtractor,
  addWarehouse,
  advance,
  depositMultiplier,
  depositRemainingAt,
  extractorEffectiveRate,
  setWarehousePullRate,
  warehouseAmountAt,
  warehouseOutflowRate,
} from "./sim.ts";
import { createSimState, type SimState } from "./state.ts";

function toyChain(): {
  state: SimState;
  warehouseId: ReturnType<typeof addWarehouse>;
  extractorId: ReturnType<typeof addExtractor>;
} {
  const state = createSimState(42, 0);
  const warehouseId = addWarehouse(state, 0, 100);
  // Pure-floor deposit at multiplier 1: a plain perpetual producer.
  const depositId = addDeposit(state, 0, [], 1);
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
    const warehouseId = addWarehouse(state, 0, 10_000);
    const depositId = addDeposit(
      state,
      0,
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
    const warehouseId = addWarehouse(state, 0, 50);
    const depositId = addDeposit(state, 0, [{ amount: 100, multiplier: 1 }], 0);
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
    expect(() => addDeposit(state, 0, [{ amount: 0, multiplier: 1 }], 1)).toThrow(/amount/);
    expect(() => addDeposit(state, 0, [{ amount: Number.NaN, multiplier: 1 }], 1)).toThrow(
      /amount/,
    );
    expect(() => addDeposit(state, 0, [{ amount: 10, multiplier: -1 }], 1)).toThrow(/multiplier/);
    expect(() => addDeposit(state, 0, [], Number.POSITIVE_INFINITY)).toThrow(/floor/);
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
    const warehouseId = addWarehouse(state, 0, 500);
    const depositId = addDeposit(
      state,
      0,
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
});
