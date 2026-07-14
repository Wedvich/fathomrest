import {
  createDeposit,
  forEachDeposit,
  getDeposit,
  setDeposit,
  type Deposit,
  type DepositTier,
} from "./components/deposit.ts";
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
  forEachWarehouse,
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
    // Handlers re-derive the world at the event's own time; epoch must already be
    // there so re-anchoring never evaluates backwards.
    if (next.time > state.epoch) {
      state.epoch = next.time;
    }
    handleEvent(state, next);
  }
  if (t > state.epoch) {
    state.epoch = t;
  }
}

export function isStaleEvent(state: SimState, event: SimEvent): boolean {
  const liveSeq =
    event.kind === "deposit-tier-depleted"
      ? getDeposit(state, event.entityId).eventSeq
      : getWarehouse(state, event.entityId).eventSeq;
  return liveSeq !== event.seq;
}

function handleEvent(state: SimState, event: SimEvent): void {
  // Pin the anchor to the exact boundary value, never the re-evaluated closed form —
  // an ulp of undershoot there would reschedule the same crossing forever.
  if (event.kind === "deposit-tier-depleted") {
    const deposit = getDeposit(state, event.entityId);
    deposit.tierIndex += 1;
    const nextTier = deposit.tiers[deposit.tierIndex];
    deposit.anchorRemaining = nextTier === undefined ? 0 : nextTier.amount;
    deposit.anchorTime = event.time;
  } else {
    const warehouse = getWarehouse(state, event.entityId);
    warehouse.anchorTime = event.time;
    warehouse.anchorAmount = event.kind === "warehouse-full" ? warehouse.capacity : 0;
  }
  deriveAll(state);
}

// Full re-derivation at the current epoch — the single choke point after every event
// and command. Two phases, in dependency order: warehouse regimes read only deposit
// tier multipliers (stepwise, unchanged by re-anchoring); deposit depletion reads the
// warehouse regimes derived in phase 1. Rates are stepwise-constant between events, so
// one pass reaches the fixed point — no iteration. Global (not targeted) re-derivation
// is O(entities) at event/command time only; revisit if entity counts ever make it
// show up in a profile (routes will want targeted downstream invalidation anyway).
function deriveAll(state: SimState): void {
  const t = state.epoch;
  forEachWarehouse(state, (id, warehouse) => {
    reanchorWarehouse(warehouse, t);
    deriveWarehouseRegime(state, id, warehouse);
  });
  forEachDeposit(state, (id, deposit) => {
    reanchorDeposit(deposit, t);
    deriveDepositDepletion(state, id, deposit);
  });
}

// Derive-time only: scans the extractor table. Queries read the cached
// warehouse.inflow instead (query(t) must not allocate or scan).
function totalInflow(state: SimState, warehouseId: Id): number {
  let inflow = 0;
  forEachExtractor(state, (_id, extractor) => {
    if (extractor.warehouseId === warehouseId) {
      inflow += extractor.rate * currentMultiplier(getDeposit(state, extractor.depositId));
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

// Recompute the deposit's draw and the next tier crossing. Callers must have derived
// warehouse regimes (throttles) first and re-anchored the deposit at the current time.
function deriveDepositDepletion(state: SimState, id: Id, deposit: Deposit): void {
  deposit.eventSeq += 1; // invalidates any scheduled crossing for this deposit
  if (deposit.tierIndex >= deposit.tiers.length) {
    // Floor regime: infinite trickle, nothing left to deplete or schedule.
    deposit.depletionRate = 0;
    return;
  }
  let rate = 0;
  forEachExtractor(state, (extractorId, extractor) => {
    if (extractor.depositId === id) {
      rate += extractorEffectiveRate(state, extractorId);
    }
  });
  deposit.depletionRate = rate;
  if (rate > 0) {
    pushEvent(state.events, {
      time: deposit.anchorTime + deposit.anchorRemaining / rate,
      kind: "deposit-tier-depleted",
      entityId: id,
      seq: deposit.eventSeq,
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

function remainingInTier(deposit: Deposit, t: number): number {
  const raw = deposit.anchorRemaining - deposit.depletionRate * (t - deposit.anchorTime);
  return Math.max(0, raw);
}

function reanchorDeposit(deposit: Deposit, t: number): void {
  deposit.anchorRemaining = remainingInTier(deposit, t);
  deposit.anchorTime = t;
}

function currentMultiplier(deposit: Deposit): number {
  const tier = deposit.tiers[deposit.tierIndex];
  return tier === undefined ? deposit.floorMultiplier : tier.multiplier;
}

// query(t) — pure reads, never mutate, no allocation (ADR-0001 §1).

export function warehouseAmountAt(state: SimState, id: Id, t: number): number {
  return clampedAmount(getWarehouse(state, id), t);
}

// Total units left before the floor: the live tier's closed form plus untouched later
// tiers. Small indexed loop, no allocation.
export function depositRemainingAt(state: SimState, id: Id, t: number): number {
  const deposit = getDeposit(state, id);
  let remaining = remainingInTier(deposit, t);
  for (let i = deposit.tierIndex + 1; i < deposit.tiers.length; i += 1) {
    const tier = deposit.tiers[i];
    if (tier !== undefined) {
      remaining += tier.amount;
    }
  }
  return remaining;
}

// Rates are stepwise-constant between events, so rate queries take no t.

export function depositMultiplier(state: SimState, id: Id): number {
  return currentMultiplier(getDeposit(state, id));
}

export function extractorEffectiveRate(state: SimState, id: Id): number {
  const extractor = getExtractor(state, id);
  const nominal = extractor.rate * currentMultiplier(getDeposit(state, extractor.depositId));
  const warehouse = getWarehouse(state, extractor.warehouseId);
  if (warehouse.regime !== "pinned-full") {
    return nominal;
  }
  // Producers share the consumer's pull proportionally while saturated.
  const inflow = warehouse.inflow;
  return inflow <= 0 ? 0 : nominal * (warehouse.pullRate / inflow);
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
  setWarehouse(state, id, createWarehouse(capacity, state.epoch));
  deriveAll(state);
  return id;
}

// tiers may be empty: a pure-floor deposit is a plain perpetual producer.
export function addDeposit(
  state: SimState,
  t: number,
  tiers: readonly DepositTier[],
  floorMultiplier: number,
): Id {
  for (const tier of tiers) {
    if (!Number.isFinite(tier.amount) || !(tier.amount > 0)) {
      throw new Error(`deposit tier amount must be finite and > 0, got ${tier.amount}`);
    }
    if (!Number.isFinite(tier.multiplier) || !(tier.multiplier >= 0)) {
      throw new Error(`deposit tier multiplier must be finite and >= 0, got ${tier.multiplier}`);
    }
  }
  if (!Number.isFinite(floorMultiplier) || !(floorMultiplier >= 0)) {
    throw new Error(`deposit floor multiplier must be finite and >= 0, got ${floorMultiplier}`);
  }
  advance(state, t);
  const id = allocId(state);
  setDeposit(state, id, createDeposit(tiers, floorMultiplier, state.epoch));
  deriveAll(state);
  return id;
}

export function addExtractor(
  state: SimState,
  t: number,
  rate: number,
  depositId: Id,
  warehouseId: Id,
): Id {
  if (!(rate >= 0)) {
    throw new Error(`extractor rate must be >= 0, got ${rate}`);
  }
  getDeposit(state, depositId); // validates the source exists
  getWarehouse(state, warehouseId); // validates the target exists
  advance(state, t);
  const id = allocId(state);
  setExtractor(state, id, createExtractor(rate, depositId, warehouseId));
  deriveAll(state);
  return id;
}

export function setWarehousePullRate(state: SimState, t: number, id: Id, pullRate: number): void {
  if (!(pullRate >= 0)) {
    throw new Error(`pull rate must be >= 0, got ${pullRate}`);
  }
  const warehouse = getWarehouse(state, id);
  advance(state, t);
  // deriveAll re-anchors with the OLD cached netRate before recomputing against the
  // new pull, so mutating first is safe.
  warehouse.pullRate = pullRate;
  deriveAll(state);
}
