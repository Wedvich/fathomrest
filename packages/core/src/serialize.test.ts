import { describe, expect, it } from "vitest";

import { offlineElapsedSeconds } from "./clock.ts";
import { idFromNumber } from "./ids.ts";
import { deserializeState, entriesToTable, serializeState, tableToEntries } from "./serialize.ts";
import {
  addExtractor,
  addWarehouse,
  advance,
  setWarehousePullRate,
  warehouseAmountAt,
} from "./sim.ts";
import { createSimState, type SimState } from "./state.ts";

function midFlightState(): { state: SimState; warehouseId: ReturnType<typeof addWarehouse> } {
  const state = createSimState(11, 1_000);
  const warehouseId = addWarehouse(state, 100);
  addExtractor(state, 2, warehouseId);
  setWarehousePullRate(state, warehouseId, 0.5);
  advance(state, 20); // mid-fill, crossing event still pending
  return { state, warehouseId };
}

describe("serializer", () => {
  it("round-trips the Map tables through entry arrays", () => {
    const table = new Map([
      [idFromNumber(1), { rate: 2, warehouseId: idFromNumber(9) }],
      [idFromNumber(3), { rate: 5, warehouseId: idFromNumber(9) }],
    ]);
    const restored = entriesToTable(tableToEntries(table));
    expect(restored).toStrictEqual(table);
    expect([...restored.keys()]).toEqual([...table.keys()]);
  });

  it("copies components so the document never aliases live state", () => {
    const { state, warehouseId } = midFlightState();
    const doc = serializeState(state);
    advance(state, 500); // fires the fill event, mutates live components
    const entry = doc.warehouses.find(([id]) => id === warehouseId);
    expect(entry?.[1].regime).toBe("tracking");
  });

  it("restores a save that behaves bit-identically to the original", () => {
    const { state, warehouseId } = midFlightState();
    const restored = deserializeState(serializeState(state));
    advance(state, 1_000);
    advance(restored, 1_000);
    expect(warehouseAmountAt(restored, warehouseId, 1_000)).toBe(
      warehouseAmountAt(state, warehouseId, 1_000),
    );
    expect(serializeState(restored)).toStrictEqual(serializeState(state));
  });

  it("supports the offline catch-up flow: load, elapse, advance", () => {
    const { state, warehouseId } = midFlightState();
    state.wallTime = 5_000; // app re-stamps the anchor at save time
    const doc = serializeState(state);
    const restored = deserializeState(doc);
    const elapsed = offlineElapsedSeconds(65_000, restored.wallTime);
    expect(elapsed).toBe(60);
    advance(restored, restored.epoch + elapsed);
    expect(warehouseAmountAt(restored, warehouseId, restored.epoch)).toBe(100); // filled at 66.67s
  });

  it("rejects an unsupported save version", () => {
    const doc = serializeState(midFlightState().state);
    expect(() => deserializeState({ ...doc, version: 999 })).toThrow(/save version/);
  });
});
