import type { Extractor } from "./components/extractor.ts";
import type { Warehouse } from "./components/warehouse.ts";
import { allEvents, createEventQueue, pushEvent, type SimEvent } from "./events.ts";
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

// Components are copied on both directions so a save document never aliases live state.

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
    events: allEvents(state.events).filter((event) => !isStaleEvent(state, event)),
    extractors: tableToEntries(state.extractors),
    warehouses: tableToEntries(state.warehouses),
  };
}

export function deserializeState(doc: SaveDocument): SimState {
  // Type says number, but imported JSON is untrusted — guard at runtime.
  if (doc.version !== SAVE_VERSION) {
    throw new Error(`unsupported save version ${doc.version}`);
  }
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
