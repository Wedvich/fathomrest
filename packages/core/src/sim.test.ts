import { describe, expect, it } from "vitest";

import { getWarehouse } from "./components/warehouse.ts";
import { serializeState, type SaveDocument } from "./serialize.ts";
import {
  addExtractor,
  addWarehouse,
  advance,
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
  const extractorId = addExtractor(state, 0, 2, warehouseId);
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

describe("determinism", () => {
  const TOTAL_SPAN = 3 * 86_400;

  // Same 3-day span, same mid-run commands at exact times — only the advance()
  // granularity differs. Bit-identical final state is the load-bearing invariant
  // (ADR-0001 §5, §8, consequences).
  function runScenario(stepCount: number): SaveDocument {
    const state = createSimState(7, 0);
    const warehouseId = addWarehouse(state, 0, 500);
    addExtractor(state, 0, 3, warehouseId);
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
