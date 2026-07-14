// @fathomrest/core — headless simulation engine (ADR-0001). Pure TS, no UI deps;
// event-driven analytic core: advance(t) applies due events, queries evaluate closed
// forms at exact time t.

export { idFromNumber, type Id } from "./ids.ts";
export { createPrng, nextFloat01, nextU32, type PrngState } from "./prng.ts";
export { offlineElapsedSeconds } from "./clock.ts";
export {
  allEvents,
  compareEvents,
  createEventQueue,
  EVENT_KIND_PRIORITY,
  peekEvent,
  popEvent,
  pushEvent,
  type EventKind,
  type EventQueue,
  type SimEvent,
} from "./events.ts";
export { allocId, createSimState, type SimState } from "./state.ts";
export {
  createExtractor,
  extractorIds,
  forEachExtractor,
  getExtractor,
  setExtractor,
  type Extractor,
} from "./components/extractor.ts";
export {
  createWarehouse,
  forEachWarehouse,
  getWarehouse,
  setWarehouse,
  warehouseIds,
  type Warehouse,
  type WarehouseRegime,
} from "./components/warehouse.ts";
export {
  addExtractor,
  addWarehouse,
  advance,
  extractorEffectiveRate,
  isStaleEvent,
  setWarehousePullRate,
  warehouseAmountAt,
  warehouseOutflowRate,
} from "./sim.ts";
export {
  deserializeState,
  entriesToTable,
  serializeState,
  tableToEntries,
  type SaveDocument,
  type TableEntries,
} from "./serialize.ts";
