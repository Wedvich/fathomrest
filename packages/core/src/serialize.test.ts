import { describe, expect, it } from "vitest";

import { offlineElapsedSeconds } from "./clock.ts";
import { getDeposit } from "./components/deposit.ts";
import { getWarehouse } from "./components/warehouse.ts";
import { peekEvent } from "./events.ts";
import { idFromNumber } from "./ids.ts";
import { islandId } from "./island.ts";
import { resourceType } from "./resource.ts";
import {
  deserializeState,
  entriesToTable,
  serializeState,
  tableToEntries,
  type SaveDocument,
} from "./serialize.ts";
import {
  addConverter,
  applyExtractionMultiplier,
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  advance,
  converterDraw,
  converterFeed,
  routeFlow,
  setWarehousePullRate,
  grantIslandXp,
  islandXpAt,
  registerIsland,
  warehouseAmountAt,
} from "./sim.ts";
import { createSimState, type SimState } from "./state.ts";

const R = resourceType("stuff");
// One warehouse per (island, resource): route fixtures put source and destination on distinct
// islands so two same-typed warehouses can coexist (the solver ignores island tags).
const I = islandId("here");
const J = islandId("there");

function midFlightState(): {
  state: SimState;
  warehouseId: ReturnType<typeof addWarehouse>;
  depositId: ReturnType<typeof addDeposit>;
} {
  const state = createSimState(11, 1_000);
  const warehouseId = addWarehouse(state, 0, R, I, 100);
  // Tier large enough that the crossing stays pending through every test horizon.
  const depositId = addDeposit(state, 0, R, [{ amount: 1_000, multiplier: 1 }], 0.25);
  addExtractor(state, 0, 2, depositId, warehouseId);
  setWarehousePullRate(state, 0, warehouseId, 0.5);
  advance(state, 20); // mid-fill, mid-tier; both crossing events still pending
  return { state, warehouseId, depositId };
}

describe("serializer", () => {
  it("round-trips the Map tables through entry arrays", () => {
    const table = new Map([
      [idFromNumber(1), { rate: 2, depositId: idFromNumber(7), warehouseId: idFromNumber(9) }],
      [idFromNumber(3), { rate: 5, depositId: idFromNumber(7), warehouseId: idFromNumber(9) }],
    ]);
    const restored = entriesToTable(tableToEntries(table));
    expect(restored).toStrictEqual(table);
    expect([...restored.keys()]).toEqual([...table.keys()]);
  });

  it("copies components and events so the document never aliases live state", () => {
    const { state, warehouseId, depositId } = midFlightState();
    const pending = peekEvent(state.events);
    const doc = serializeState(state);
    expect(doc.events[0]).not.toBe(pending);
    // Nested tier arrays are deep-copied, not shared references.
    const depositEntry = doc.deposits.find(([id]) => id === depositId);
    expect(depositEntry?.[1].tiers).not.toBe(getDeposit(state, depositId).tiers);
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

  it("rejects an event referencing a missing entity", () => {
    const doc = serializeState(midFlightState().state);
    const events = doc.events.map((event) => ({ ...event, entityId: idFromNumber(999) }));
    expect(() => deserializeState({ ...doc, events })).toThrow(/entityId/);
  });

  it("rejects an extractor referencing a missing deposit", () => {
    const doc = serializeState(midFlightState().state);
    const extractors = doc.extractors.map(([id, extractor]): (typeof doc.extractors)[number] => [
      id,
      { ...extractor, depositId: idFromNumber(999) },
    ]);
    expect(() => deserializeState({ ...doc, extractors })).toThrow(/depositId/);
  });

  it("rejects a deposit with an out-of-range or fractional tier index", () => {
    const doc = serializeState(midFlightState().state);
    for (const tierIndex of [-1, 0.5, 2]) {
      const deposits = doc.deposits.map(([id, deposit]): (typeof doc.deposits)[number] => [
        id,
        { ...deposit, tierIndex },
      ]);
      expect(() => deserializeState({ ...doc, deposits })).toThrow(/tierIndex/);
    }
  });

  it("round-trips a route network and re-derives identical flows", () => {
    const state = createSimState(5, 0);
    const source = addWarehouse(state, 0, R, I, 100);
    const dest = addWarehouse(state, 0, R, J, 100);
    const deposit = addDeposit(state, 0, R, [], 1);
    addExtractor(state, 0, 5, deposit, source);
    const route = addRoute(state, 0, source, dest, 3);
    advance(state, 10);

    const restored = deserializeState(serializeState(state));
    expect(routeFlow(restored, route)).toBe(routeFlow(state, route));
    expect(serializeState(restored)).toStrictEqual(serializeState(state));
  });

  function routeDoc(): SaveDocument {
    const state = createSimState(5, 0);
    const source = addWarehouse(state, 0, R, I, 100);
    const dest = addWarehouse(state, 0, R, J, 100);
    addRoute(state, 0, source, dest, 3);
    return serializeState(state);
  }

  it("rejects a route referencing a missing warehouse", () => {
    const doc = routeDoc();
    const routes = doc.routes.map(([id, route]): (typeof doc.routes)[number] => [
      id,
      { ...route, dstId: idFromNumber(999) },
    ]);
    expect(() => deserializeState({ ...doc, routes })).toThrow(/dstId/);
  });

  it("rejects a self-loop route", () => {
    const doc = routeDoc();
    const routes = doc.routes.map(([id, route]): (typeof doc.routes)[number] => [
      id,
      { ...route, dstId: route.srcId },
    ]);
    expect(() => deserializeState({ ...doc, routes })).toThrow(/differ/);
  });

  it("rejects a cyclic imported route graph", () => {
    const doc = routeDoc();
    const [firstEntry] = doc.routes;
    if (firstEntry === undefined) {
      throw new Error("routeDoc should produce one route");
    }
    const [, route] = firstEntry;
    // Add the reverse edge to close a 2-cycle.
    const reverse: (typeof doc.routes)[number] = [
      idFromNumber(500),
      { ...route, srcId: route.dstId, dstId: route.srcId },
    ];
    const routes = [...doc.routes, reverse];
    expect(() => deserializeState({ ...doc, routes })).toThrow(/cycle/);
  });

  it("rejects a negative route cap", () => {
    const doc = routeDoc();
    const routes = doc.routes.map(([id, route]): (typeof doc.routes)[number] => [
      id,
      { ...route, cap: -5 },
    ]);
    expect(() => deserializeState({ ...doc, routes })).toThrow(/cap/);
  });

  it("rejects a non-positive warehouse capacity", () => {
    const doc = serializeState(midFlightState().state);
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] => [
      id,
      { ...warehouse, capacity: -10 },
    ]);
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/capacity/);
  });

  it("rejects a negative warehouse pull rate", () => {
    const doc = serializeState(midFlightState().state);
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] => [
      id,
      { ...warehouse, pullRate: -1 },
    ]);
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/pullRate/);
  });

  it("rejects a warehouse amount outside [0, capacity]", () => {
    const doc = serializeState(midFlightState().state);
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] => [
      id,
      { ...warehouse, anchorAmount: warehouse.capacity + 1 },
    ]);
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/anchorAmount/);
  });

  it("rejects a negative extractor rate", () => {
    const doc = serializeState(midFlightState().state);
    const extractors = doc.extractors.map(([id, extractor]): (typeof doc.extractors)[number] => [
      id,
      { ...extractor, rate: -2 },
    ]);
    expect(() => deserializeState({ ...doc, extractors })).toThrow(/rate/);
  });

  it("rejects a warehouse with an empty resource tag", () => {
    const doc = serializeState(midFlightState().state);
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] => [
      id,
      { ...warehouse, resource: resourceType("") },
    ]);
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/resource/);
  });

  it("preserves the warehouse island tag across a round-trip", () => {
    const { state, warehouseId } = midFlightState();
    const restored = deserializeState(serializeState(state));
    expect(getWarehouse(restored, warehouseId).islandId).toBe("here");
  });

  it("migrates a v1 save by backfilling the warehouse island tag", () => {
    const doc = serializeState(midFlightState().state);
    // A pre-islandId (v1) document: older version, warehouses lacking the tag.
    const v1 = {
      ...doc,
      version: 1,
      warehouses: doc.warehouses.map(([id, warehouse]) => {
        const { islandId: _omit, ...rest } = warehouse;
        return [id, rest];
      }),
    } as unknown as SaveDocument;
    const restored = deserializeState(v1);
    // Loads without throwing; every warehouse lands on the default island, and the upgraded
    // document reports the current version.
    const reserialized = serializeState(restored);
    expect(reserialized.version).toBe(serializeState(midFlightState().state).version);
    for (const [, warehouse] of reserialized.warehouses) {
      expect(warehouse.islandId).toBe("island-1");
    }
  });

  it("rejects a routed v1 save: the island backfill collides with the pool invariant", () => {
    const doc = routeDoc();
    const v1 = {
      ...doc,
      version: 1,
      warehouses: doc.warehouses.map(([id, warehouse]) => {
        const { islandId: _omit, ...rest } = warehouse;
        return [id, rest];
      }),
    } as unknown as SaveDocument;
    // Both route endpoints store one resource; backfilled onto the default island they violate
    // the one-pool invariant, so the import rejects and the app quarantines (ADR-0001).
    expect(() => deserializeState(v1)).toThrow(/duplicate/);
  });

  it("rejects a warehouse with an empty island tag", () => {
    const doc = serializeState(midFlightState().state);
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] => [
      id,
      { ...warehouse, islandId: islandId("") },
    ]);
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/islandId/);
  });

  it("rejects two warehouses sharing an island and resource (the pool invariant)", () => {
    // routeDoc's source/dest are the same resource on distinct islands; collapsing both onto
    // island I makes them a duplicate (I, stuff) pair, which import must reject.
    const doc = routeDoc();
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] => [
      id,
      { ...warehouse, islandId: I },
    ]);
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/duplicate/);
  });

  it("rejects an extractor whose deposit and warehouse resources differ", () => {
    const doc = serializeState(midFlightState().state);
    const deposits = doc.deposits.map(([id, deposit]): (typeof doc.deposits)[number] => [
      id,
      { ...deposit, resource: resourceType("other") },
    ]);
    expect(() => deserializeState({ ...doc, deposits })).toThrow(/resources must match/);
  });

  it("rejects a route between differently typed warehouses", () => {
    const doc = routeDoc();
    const [first] = doc.routes;
    if (first === undefined) {
      throw new Error("routeDoc should produce one route");
    }
    const [, route] = first;
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] =>
      id === route.srcId
        ? [id, { ...warehouse, resource: resourceType("other") }]
        : [id, warehouse],
    );
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/resources must match/);
  });

  function converterState(): {
    state: SimState;
    converter: ReturnType<typeof addConverter>;
  } {
    const state = createSimState(5, 0);
    const source = addWarehouse(state, 0, R, I, 100);
    // On a separate island so the same-type rejection test can retype dest to R without also
    // tripping the (island, resource) pool invariant.
    const dest = addWarehouse(state, 0, resourceType("refined"), J, 100);
    const deposit = addDeposit(state, 0, R, [], 1);
    addExtractor(state, 0, 5, deposit, source);
    const converter = addConverter(state, 0, source, dest, 4, 0.5);
    advance(state, 10);
    return { state, converter };
  }

  it("round-trips a converter and re-derives identical draw and feed", () => {
    const { state, converter } = converterState();
    const restored = deserializeState(serializeState(state));
    expect(converterDraw(restored, converter)).toBe(converterDraw(state, converter));
    expect(converterFeed(restored, converter)).toBe(converterFeed(state, converter));
    expect(serializeState(restored)).toStrictEqual(serializeState(state));
  });

  it("rejects converter documents violating the import invariants", () => {
    const doc = serializeState(converterState().state);
    const patched = (patch: object): SaveDocument => ({
      ...doc,
      converters: doc.converters.map(([id, converter]): (typeof doc.converters)[number] => [
        id,
        { ...converter, ...patch },
      ]),
    });
    expect(() => deserializeState(patched({ ratio: 0 }))).toThrow(/ratio/);
    expect(() => deserializeState(patched({ ratio: -1 }))).toThrow(/ratio/);
    expect(() => deserializeState(patched({ cap: -1 }))).toThrow(/cap/);
    expect(() => deserializeState(patched({ srcId: idFromNumber(999) }))).toThrow(/srcId/);
    expect(() => deserializeState(patched({ dstId: idFromNumber(999) }))).toThrow(/dstId/);
  });

  it("rejects a converter whose endpoints share an id or a resource", () => {
    const doc = serializeState(converterState().state);
    const [entry] = doc.converters;
    if (entry === undefined) {
      throw new Error("converterState should produce one converter");
    }
    const [, converter] = entry;
    const selfLoop = doc.converters.map(([id, c]): (typeof doc.converters)[number] => [
      id,
      { ...c, dstId: c.srcId },
    ]);
    expect(() => deserializeState({ ...doc, converters: selfLoop })).toThrow(/differ/);
    // Retype the destination to match the source: refinement must change type.
    const warehouses = doc.warehouses.map(([id, warehouse]): (typeof doc.warehouses)[number] =>
      id === converter.dstId ? [id, { ...warehouse, resource: R }] : [id, warehouse],
    );
    expect(() => deserializeState({ ...doc, warehouses })).toThrow(/resources must differ/);
  });

  it("rejects a combined route+converter cycle on import", () => {
    const state = createSimState(5, 0);
    const a = addWarehouse(state, 0, R, I, 100);
    const b = addWarehouse(state, 0, R, J, 100);
    const c = addWarehouse(state, 0, resourceType("refined"), I, 100);
    addRoute(state, 0, a, b, 3);
    addConverter(state, 0, b, c, 2, 0.5);
    const doc = serializeState(state);
    // Hand-add a converter closing the loop: route A->B, converter B->C, converter C->A.
    const closing: (typeof doc.converters)[number] = [
      idFromNumber(500),
      { srcId: c, dstId: a, cap: 1, ratio: 2, flow: 0 },
    ];
    expect(() => deserializeState({ ...doc, converters: [...doc.converters, closing] })).toThrow(
      /cycle/,
    );
  });

  it("migrates a v2 save by backfilling an empty converter table, preserving idle progress", () => {
    const { state } = midFlightState();
    const doc = serializeState(state);
    const { converters: _omit, ...rest } = doc;
    const v2 = { ...rest, version: 2 } as SaveDocument;
    const restored = deserializeState(v2);
    advance(restored, 1_000);
    advance(state, 1_000);
    expect(serializeState(restored)).toStrictEqual(serializeState(state));
  });

  it("rejects a structurally truncated document", () => {
    // Parsed JSON asserted to the wire type — exactly how a real import arrives; the
    // runtime validator, not the annotation, is the boundary.
    const version = serializeState(midFlightState().state).version;
    const doc = JSON.parse(`{"version":${version}}`) as SaveDocument;
    expect(() => deserializeState(doc)).toThrow(/invalid save document/);
  });
});

describe("island progression serialization", () => {
  const buildWithIsland = (): SimState => {
    const state = createSimState(7, 0);
    const wh = addWarehouse(state, 0, R, I, 1_000_000);
    const dep = addDeposit(state, 0, R, [], 1);
    registerIsland(state, 0, I);
    addExtractor(state, 0, 2, dep, wh);
    applyExtractionMultiplier(state, 5, new Map(), I, 1.5); // cost-free node effect
    grantIslandXp(state, 8, I, 40);
    advance(state, 30);
    return state;
  };

  it("round-trips island XP and the extraction multiplier", () => {
    const state = buildWithIsland();
    const doc = serializeState(state);
    const restored = deserializeState(doc);
    // The accumulator restores to the same closed form, and the document reserializes identically.
    expect(islandXpAt(restored, I, 30)).toBeCloseTo(islandXpAt(state, I, 30), 9);
    expect(serializeState(restored)).toStrictEqual(doc);
  });

  it("migrates a v3 save by backfilling an empty island-progress table", () => {
    // A pre-island-XP (v3) document: current shape minus islandProgress, older version.
    const doc = serializeState(midFlightState().state);
    const { islandProgress: _omit, ...rest } = doc;
    const v3 = { ...rest, version: 3 } as SaveDocument;
    const restored = deserializeState(v3);
    // Loads without throwing; no islands registered, and the upgraded document reports current.
    expect([...restored.islandProgress.keys()]).toHaveLength(0);
    expect(serializeState(restored).version).toBe(serializeState(midFlightState().state).version);
  });

  it("rejects an island-progress entry with a negative multiplier", () => {
    const doc = serializeState(buildWithIsland());
    const islandProgress = doc.islandProgress.map(([island, p]): [typeof island, typeof p] => [
      island,
      { ...p, extractionMultiplier: -1 },
    ]);
    expect(() => deserializeState({ ...doc, islandProgress })).toThrow(/extractionMultiplier/);
  });
});
