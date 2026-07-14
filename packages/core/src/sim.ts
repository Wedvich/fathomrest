import {
  createExtractor,
  forEachExtractor,
  getExtractor,
  setExtractor,
} from "./components/extractor.ts";
import {
  createWarehouse,
  getWarehouse,
  setWarehouse,
  type Warehouse,
} from "./components/warehouse.ts";
import { peekEvent, popEvent, pushEvent, type SimEvent } from "./events.ts";
import type { Id } from "./ids.ts";
import { allocId, type SimState } from "./state.ts";

// advance(t): pop and apply every event due <= t, rescheduling as regimes change.
// Mutates state; usually a per-frame no-op. Never moves epoch backwards.
export function advance(state: SimState, t: number): void {
  // NaN satisfies neither the loop exit nor the epoch bump below — every queued event
  // would fire prematurely. Fail loudly, like the command validators.
  if (!Number.isFinite(t)) {
    throw new Error(`advance time must be finite, got ${t}`);
  }
  for (;;) {
    const next = peekEvent(state.events);
    if (next === null || next.time > t) {
      break;
    }
    popEvent(state.events);
    if (isStaleEvent(state, next)) {
      continue;
    }
    handleEvent(state, next);
  }
  if (t > state.epoch) {
    state.epoch = t;
  }
}

// Both current event kinds are warehouse regime crossings; revisit this dispatch when
// other tables gain event kinds.
export function isStaleEvent(state: SimState, event: SimEvent): boolean {
  return getWarehouse(state, event.entityId).eventSeq !== event.seq;
}

function handleEvent(state: SimState, event: SimEvent): void {
  const warehouse = getWarehouse(state, event.entityId);
  // Pin the anchor to the exact boundary value, never the re-evaluated closed form —
  // an ulp of undershoot there would reschedule the same crossing forever.
  warehouse.anchorTime = event.time;
  warehouse.anchorAmount = event.kind === "warehouse-full" ? warehouse.capacity : 0;
  deriveWarehouseRegime(state, event.entityId, warehouse);
}

// Derive-time only: scans the extractor table. Queries read the cached
// warehouse.inflow instead (query(t) must not allocate or scan).
function totalInflow(state: SimState, warehouseId: Id): number {
  let inflow = 0;
  forEachExtractor(state, (_id, extractor) => {
    if (extractor.warehouseId === warehouseId) {
      inflow += extractor.rate;
    }
  });
  return inflow;
}

// Recompute regime, net rate, and the next crossing event. Callers must have
// re-anchored the warehouse at the current time first.
function deriveWarehouseRegime(state: SimState, id: Id, warehouse: Warehouse): void {
  warehouse.eventSeq += 1; // invalidates any scheduled crossing for this warehouse
  warehouse.inflow = totalInflow(state, id);
  const net = warehouse.inflow - warehouse.pullRate;
  const amount = warehouse.anchorAmount;
  if (amount >= warehouse.capacity && net >= 0) {
    // Saturation: amount pinned at cap, producers throttled to consumer pull.
    warehouse.regime = "pinned-full";
    warehouse.anchorAmount = warehouse.capacity;
    warehouse.netRate = 0;
    return;
  }
  if (amount <= 0 && net <= 0) {
    // Starvation: amount pinned at 0, consumer throttled to inflow.
    warehouse.regime = "pinned-empty";
    warehouse.anchorAmount = 0;
    warehouse.netRate = 0;
    return;
  }
  warehouse.regime = "tracking";
  warehouse.netRate = net;
  if (net > 0) {
    pushEvent(state.events, {
      time: warehouse.anchorTime + (warehouse.capacity - amount) / net,
      kind: "warehouse-full",
      entityId: id,
      seq: warehouse.eventSeq,
    });
  } else if (net < 0) {
    pushEvent(state.events, {
      time: warehouse.anchorTime + amount / -net,
      kind: "warehouse-empty",
      entityId: id,
      seq: warehouse.eventSeq,
    });
  }
}

function clampedAmount(warehouse: Warehouse, t: number): number {
  const raw = warehouse.anchorAmount + warehouse.netRate * (t - warehouse.anchorTime);
  return Math.min(warehouse.capacity, Math.max(0, raw));
}

function reanchorWarehouse(warehouse: Warehouse, t: number): void {
  warehouse.anchorAmount = clampedAmount(warehouse, t);
  warehouse.anchorTime = t;
}

// query(t) — pure reads, never mutate, no allocation (ADR-0001 §1).

export function warehouseAmountAt(state: SimState, id: Id, t: number): number {
  return clampedAmount(getWarehouse(state, id), t);
}

// Rates are stepwise-constant between events, so rate queries take no t.

export function extractorEffectiveRate(state: SimState, id: Id): number {
  const extractor = getExtractor(state, id);
  const warehouse = getWarehouse(state, extractor.warehouseId);
  if (warehouse.regime !== "pinned-full") {
    return extractor.rate;
  }
  // Producers share the consumer's pull proportionally while saturated.
  const inflow = warehouse.inflow;
  return inflow <= 0 ? 0 : extractor.rate * (warehouse.pullRate / inflow);
}

export function warehouseOutflowRate(state: SimState, id: Id): number {
  const warehouse = getWarehouse(state, id);
  if (warehouse.regime !== "pinned-empty") {
    return warehouse.pullRate;
  }
  return Math.min(warehouse.pullRate, warehouse.inflow);
}

// Commands (ADR-0001 implementation notes): validate -> advance to the command time ->
// mutate -> re-derive rates -> reschedule. Taking t and advancing internally makes
// "commands land at the current time" a mechanism, not a caller convention.
// Version bump + save are app-layer concerns once the UI binding exists.

export function addWarehouse(state: SimState, t: number, capacity: number): Id {
  if (!(capacity > 0)) {
    throw new Error(`warehouse capacity must be > 0, got ${capacity}`);
  }
  advance(state, t);
  const id = allocId(state);
  const warehouse = createWarehouse(capacity, state.epoch);
  setWarehouse(state, id, warehouse);
  deriveWarehouseRegime(state, id, warehouse);
  return id;
}

export function addExtractor(state: SimState, t: number, rate: number, warehouseId: Id): Id {
  if (!(rate >= 0)) {
    throw new Error(`extractor rate must be >= 0, got ${rate}`);
  }
  const warehouse = getWarehouse(state, warehouseId); // validates the target exists
  advance(state, t);
  const id = allocId(state);
  setExtractor(state, id, createExtractor(rate, warehouseId));
  reanchorWarehouse(warehouse, state.epoch);
  deriveWarehouseRegime(state, warehouseId, warehouse);
  return id;
}

export function setWarehousePullRate(state: SimState, t: number, id: Id, pullRate: number): void {
  if (!(pullRate >= 0)) {
    throw new Error(`pull rate must be >= 0, got ${pullRate}`);
  }
  const warehouse = getWarehouse(state, id);
  advance(state, t);
  reanchorWarehouse(warehouse, state.epoch);
  warehouse.pullRate = pullRate;
  deriveWarehouseRegime(state, id, warehouse);
}
