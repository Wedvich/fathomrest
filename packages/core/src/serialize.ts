import type { Extractor } from "./components/extractor.ts";
import { WAREHOUSE_REGIMES, type Warehouse } from "./components/warehouse.ts";
import {
  allEvents,
  createEventQueue,
  EVENT_KIND_PRIORITY,
  pushEvent,
  type SimEvent,
} from "./events.ts";
import type { Id } from "./ids.ts";
import type { PrngState } from "./prng.ts";
import { isStaleEvent } from "./sim.ts";
import type { SimState } from "./state.ts";

// Canonical wire format (docs/browser-performance.md): Map tables as [id, component]
// entry arrays, events as a sorted list. One codec for export, import, and future cloud
// sync — the schema never forks.

const SAVE_VERSION = 1;

export type TableEntries<T> = [Id, T][];

export interface SaveDocument {
  version: number;
  epoch: number;
  wallTime: number;
  nextId: number;
  prng: PrngState;
  events: SimEvent[];
  extractors: TableEntries<Extractor>;
  warehouses: TableEntries<Warehouse>;
}

// Tables and events are copied in both directions so a save document never aliases
// live state.

export function tableToEntries<T extends object>(table: ReadonlyMap<Id, T>): TableEntries<T> {
  const entries: TableEntries<T> = [];
  for (const [id, component] of table) {
    entries.push([id, { ...component }]);
  }
  return entries;
}

export function entriesToTable<T extends object>(
  entries: readonly (readonly [Id, T])[],
): Map<Id, T> {
  const table = new Map<Id, T>();
  for (const [id, component] of entries) {
    table.set(id, { ...component });
  }
  return table;
}

export function serializeState(state: SimState): SaveDocument {
  return {
    version: SAVE_VERSION,
    epoch: state.epoch,
    wallTime: state.wallTime,
    nextId: state.nextId,
    prng: { ...state.prng },
    // Stale events are dropped: they are already dead to the sim, and filtering them
    // makes the document canonical (equal states serialize identically).
    events: allEvents(state.events)
      .filter((event) => !isStaleEvent(state, event))
      .map((event) => ({ ...event })),
    extractors: tableToEntries(state.extractors),
    warehouses: tableToEntries(state.warehouses),
  };
}

// Imported JSON is untrusted — the SaveDocument type may lie at runtime. Everything is
// checked at the import boundary so a corrupt document fails here instead of as NaN
// amounts or a missing-id throw deep inside a later advance().

function invalid(detail: string): Error {
  return new Error(`invalid save document: ${detail}`);
}

function checkFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${field} must be a finite number`);
  }
}

function checkTable<T extends object>(
  entries: TableEntries<T>,
  field: string,
  checkComponent: (component: T, at: string) => void,
): Set<number> {
  if (!Array.isArray(entries)) {
    throw invalid(`${field} must be an array`);
  }
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw invalid(`${field} entries must be [id, component] pairs`);
    }
    const [id, component] = entry;
    checkFinite(id, `${field} id`);
    if (ids.has(id)) {
      throw invalid(`${field} id ${id} duplicated`);
    }
    if (component === null || typeof component !== "object") {
      throw invalid(`${field}[${id}] must be an object`);
    }
    checkComponent(component, `${field}[${id}]`);
    ids.add(id);
  }
  return ids;
}

function validateDocument(doc: SaveDocument): void {
  checkFinite(doc.epoch, "epoch");
  checkFinite(doc.wallTime, "wallTime");
  checkFinite(doc.nextId, "nextId");
  if (doc.prng === null || typeof doc.prng !== "object") {
    throw invalid("prng must be an object");
  }
  checkFinite(doc.prng.a, "prng.a");
  checkFinite(doc.prng.b, "prng.b");
  checkFinite(doc.prng.c, "prng.c");
  checkFinite(doc.prng.d, "prng.d");
  const warehouseIds = checkTable(doc.warehouses, "warehouses", (warehouse, at) => {
    checkFinite(warehouse.capacity, `${at}.capacity`);
    checkFinite(warehouse.anchorAmount, `${at}.anchorAmount`);
    checkFinite(warehouse.anchorTime, `${at}.anchorTime`);
    checkFinite(warehouse.netRate, `${at}.netRate`);
    checkFinite(warehouse.inflow, `${at}.inflow`);
    checkFinite(warehouse.pullRate, `${at}.pullRate`);
    checkFinite(warehouse.eventSeq, `${at}.eventSeq`);
    if (!WAREHOUSE_REGIMES.includes(warehouse.regime)) {
      throw invalid(`${at}.regime must be one of ${WAREHOUSE_REGIMES.join(", ")}`);
    }
  });
  checkTable(doc.extractors, "extractors", (extractor, at) => {
    checkFinite(extractor.rate, `${at}.rate`);
    checkFinite(extractor.warehouseId, `${at}.warehouseId`);
    if (!warehouseIds.has(extractor.warehouseId)) {
      throw invalid(`${at}.warehouseId ${extractor.warehouseId} has no warehouse`);
    }
  });
  if (!Array.isArray(doc.events)) {
    throw invalid("events must be an array");
  }
  for (const event of doc.events) {
    if (event === null || typeof event !== "object") {
      throw invalid("events entries must be objects");
    }
    checkFinite(event.time, "event.time");
    checkFinite(event.seq, "event.seq");
    if (!(event.kind in EVENT_KIND_PRIORITY)) {
      throw invalid(`event.kind ${String(event.kind)} is not an event kind`);
    }
    // Both current kinds target a warehouse (sim.ts dispatch); a dangling entityId
    // would throw from getWarehouse inside advance() and serializeState().
    checkFinite(event.entityId, "event.entityId");
    if (!warehouseIds.has(event.entityId)) {
      throw invalid(`event.entityId ${event.entityId} has no warehouse`);
    }
  }
}

export function deserializeState(doc: SaveDocument): SimState {
  if (doc === null || typeof doc !== "object") {
    throw invalid("not an object");
  }
  if (doc.version !== SAVE_VERSION) {
    throw new Error(`unsupported save version ${doc.version}`);
  }
  validateDocument(doc);
  const events = createEventQueue();
  for (const event of doc.events) {
    pushEvent(events, { ...event });
  }
  return {
    epoch: doc.epoch,
    wallTime: doc.wallTime,
    nextId: doc.nextId,
    prng: { ...doc.prng },
    events,
    extractors: entriesToTable(doc.extractors),
    warehouses: entriesToTable(doc.warehouses),
  };
}
