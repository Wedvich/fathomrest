// @fathomrest/core — headless simulation engine (ADR-0001). Pure TS, no UI deps;
// event-driven analytic core: advance(t) applies due events, queries evaluate closed
// forms at exact time t.
//
// Only the command/query/serialize surface is public. Mutating internals (table
// setters, event queue ops, PRNG steppers) stay package-private: going around the
// command layer skips eventSeq invalidation and breaks replay determinism.

export type { Id } from "./ids.ts";
export { resourceType, type ResourceType } from "./resource.ts";
export { islandId, type IslandId } from "./island.ts";
export type { PrngState } from "./prng.ts";
export { offlineElapsedSeconds } from "./clock.ts";
export type { EventKind, EventQueue, SimEvent } from "./events.ts";
export { createSimState, type SimState } from "./state.ts";
export {
  converterIds,
  forEachConverter,
  getConverter,
  type Converter,
} from "./components/converter.ts";
export {
  depositIds,
  forEachDeposit,
  getDeposit,
  type Deposit,
  type DepositTier,
} from "./components/deposit.ts";
export {
  extractorIds,
  forEachExtractor,
  getExtractor,
  type Extractor,
} from "./components/extractor.ts";
export { forEachRoute, getRoute, routeIds, type Route } from "./components/route.ts";
export {
  forEachWarehouse,
  getWarehouse,
  warehouseIds,
  type Warehouse,
  type WarehouseRegime,
} from "./components/warehouse.ts";
export {
  addConverter,
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  advance,
  buildConverter,
  buildExtractor,
  canAffordBuild,
  converterDraw,
  converterFeed,
  depositMultiplier,
  depositRemainingAt,
  extractorEffectiveRate,
  grantResource,
  InsufficientStockError,
  routeFlow,
  setRouteCap,
  setWarehousePullRate,
  upgradeIslandCapacity,
  warehouseAmountAt,
  warehouseOutflowRate,
} from "./sim.ts";
export {
  deserializeState,
  serializeState,
  type SaveDocument,
  type TableEntries,
} from "./serialize.ts";
