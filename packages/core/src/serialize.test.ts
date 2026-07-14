import { describe, expect, it } from "vitest";

import { offlineElapsedSeconds } from "./clock.ts";
import { peekEvent } from "./events.ts";
import { idFromNumber } from "./ids.ts";
import {
  deserializeState,
  entriesToTable,
  serializeState,
  tableToEntries,
  type SaveDocument,
} from "./serialize.ts";
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
  const warehouseId = addWarehouse(state, 0, 100);
  addExtractor(state, 0, 2, warehouseId);
  setWarehousePullRate(state, 0, warehouseId, 0.5);
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

  it("copies components and events so the document never aliases live state", () => {
    const { state, warehouseId } = midFlightState();
    const pending = peekEvent(state.events);
    const doc = serializeState(state);
    expect(doc.events[0]).not.toBe(pending);
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

  it("rejects non-finite numbers on an imported document", () => {
    const doc = serializeState(midFlightState().state);
    expect(() => deserializeState({ ...doc, wallTime: Number.NaN })).toThrow(/wallTime/);
  });

  it("rejects an event referencing a missing warehouse", () => {
    const doc = serializeState(midFlightState().state);
    const events = doc.events.map((event) => ({ ...event, entityId: idFromNumber(999) }));
    expect(() => deserializeState({ ...doc, events })).toThrow(/entityId/);
  });

  it("rejects a structurally truncated document", () => {
    // Parsed JSON asserted to the wire type — exactly how a real import arrives; the
    // runtime validator, not the annotation, is the boundary.
    const doc = JSON.parse('{"version":1}') as SaveDocument;
    expect(() => deserializeState(doc)).toThrow(/invalid save document/);
  });
});
