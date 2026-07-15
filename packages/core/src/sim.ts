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
import { createRoute, forEachRoute, getRoute, setRoute } from "./components/route.ts";
import {
  createWarehouse,
  getWarehouse,
  setWarehouse,
  forEachWarehouse,
  warehouseIds,
  type Warehouse,
} from "./components/warehouse.ts";
import { peekEvent, popEvent, pushEvent, type SimEvent } from "./events.ts";
import { topoSort } from "./graph.ts";
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
// and command. Phases in dependency order:
//   1. Re-anchor every warehouse to now (freeze its amount) and cache its nominal
//      extractor inflow — both are inputs the route solver reads as constants.
//   2. solveRoutes: settle every route flow, each warehouse's route in/out totals and
//      throttle levels, and the regime of saturated (pinned) warehouses. Routes make a
//      warehouse's net rate depend on its neighbours' regimes, so this is a fixed point
//      over the route DAG (see solveRoutes).
//   3. Schedule crossings: with route flows settled, each warehouse's net rate is a
//      constant and its fill/empty time is closed-form (scheduleWarehouse).
//   4. Deposit depletion reads the (route-aware) extractor throttles from phase 2.
// Rates are stepwise-constant between events. Global (not targeted) re-derivation is
// O(entities) per event/command; revisit only if a profile ever shows it.
function deriveAll(state: SimState): void {
  const t = state.epoch;
  forEachWarehouse(state, (id, warehouse) => {
    reanchorWarehouse(warehouse, t);
    warehouse.inflow = totalInflow(state, id);
  });
  const { routeInflow, routeOutflow } = solveRoutes(state);
  forEachWarehouse(state, (id, warehouse) => {
    scheduleWarehouse(state, id, warehouse, routeInflow.get(id) ?? 0, routeOutflow.get(id) ?? 0);
  });
  forEachDeposit(state, (id, deposit) => {
    reanchorDeposit(deposit, t);
    deriveDepositDepletion(state, id, deposit);
  });
}

// Derive-time only: scans the extractor table for the nominal (pre-throttle) producer
// rate into a warehouse. Queries read the cached warehouse.inflow instead (query(t) must
// not allocate or scan). Route inflow is settled separately by solveRoutes.
function totalInflow(state: SimState, warehouseId: Id): number {
  let inflow = 0;
  forEachExtractor(state, (_id, extractor) => {
    if (extractor.warehouseId === warehouseId) {
      inflow += extractor.rate * currentMultiplier(getDeposit(state, extractor.depositId));
    }
  });
  return inflow;
}

// Capped proportional water-filling — the atomic split used two mirror ways: a
// pinned-full warehouse distributes an acceptance budget over its incoming producers,
// and a pinned-empty warehouse distributes a supply budget over its outgoing consumers.
// Each competitor i has a weight g_i (its nominal desire — a route's cap, the extractor
// pool's nominal, the sink's pullRate) and an independent ceiling u_i <= g_i (the far
// end's current allowance; u_i = g_i for extractors/sink, which have no far end). Solve
// alloc_i = min(u_i, level * g_i) with Σ alloc_i = budget for the unique water level.
//
// As `level` rises from 0, Σ min(u_i, level*g_i) is continuous, non-decreasing and
// piecewise-linear, so one `level` hits the budget (budget <= Σ u_i holds at every call
// site — a node only enters the pinned branch when its budget cannot cover total
// demand). Each round pins every competitor whose ceiling binds at the current level and
// recomputes; removing a below-average-ratio mass only raises `level`, so a pinned
// competitor had ratio <= the survivors' final level — no false or missed pins, no sort.
// Terminates in <= competitors+1 rounds; only + − × ÷ and exact comparisons (no epsilon).
// Writes each alloc into `out` and returns the final water level (a throttle in [0, 1]).
function allocateCapped(
  budget: number,
  weights: readonly number[],
  ceilings: readonly number[],
  out: number[],
): number {
  const n = weights.length;
  const pinned: boolean[] = [];
  for (let i = 0; i < n; i += 1) {
    pinned[i] = false;
    out[i] = 0;
  }
  let remaining = budget;
  let level = 1;
  for (let round = 0; round <= n; round += 1) {
    let activeWeight = 0;
    for (let i = 0; i < n; i += 1) {
      if (!pinned[i]) {
        activeWeight += weights[i] ?? 0;
      }
    }
    if (activeWeight <= 0) {
      return level; // no unpinned demand left (all pinned at ceiling, or nothing to split)
    }
    level = remaining / activeWeight;
    let pinnedAny = false;
    for (let i = 0; i < n; i += 1) {
      if (!pinned[i] && level * (weights[i] ?? 0) >= (ceilings[i] ?? 0)) {
        pinned[i] = true;
        out[i] = ceilings[i] ?? 0;
        remaining -= ceilings[i] ?? 0;
        pinnedAny = true;
      }
    }
    if (!pinnedAny) {
      for (let i = 0; i < n; i += 1) {
        if (!pinned[i]) {
          out[i] = level * (weights[i] ?? 0);
        }
      }
      return level;
    }
  }
  return level; // unreachable: each round pins >=1 competitor or returns
}

// Resolve every route flow and each warehouse's regime at the current (frozen) amounts.
//
// A route is a consumer of its source and a producer for its destination, so a
// warehouse's net rate depends on its neighbours' regimes. With amounts frozen, a
// warehouse can only constrain flow when *saturated*: an interior warehouse (0 < amount
// < cap) is transparent; amount == cap is pinned-full (demand-limited, DL) when it would
// overflow and throttles its incoming routes (backpressure — travels upstream); amount
// == 0 is pinned-empty (supply-limited, SL) when it would starve and throttles its
// outgoing routes (starvation — travels downstream). A warehouse cannot be both (cap >
// 0), so the two influence waves never reflect and the iteration cannot oscillate; it
// converges in <= 2·N alternating sweeps over the route DAG (proof in ADR-0001 §route
// solver / design notes). Cycles are rejected at the command and import boundaries, so
// the topological order always exists; a null here means one slipped past — a loud canary,
// never hit on valid input. SWEEP_GUARD is the analogous canary on sweep count. Every sum
// is taken in table order and sweeps run in topological order (ties by table order) so
// replay stays bit-identical (docs/browser-performance.md: determinism).
//
// Returns each warehouse's realized route inflow/outflow totals — intra-derive scratch
// consumed by scheduleWarehouse in the same deriveAll, not cached on the warehouse.
function solveRoutes(state: SimState): {
  routeInflow: Map<Id, number>;
  routeOutflow: Map<Id, number>;
} {
  const ids: Id[] = [];
  const incoming = new Map<Id, Id[]>();
  const outgoing = new Map<Id, Id[]>();
  forEachWarehouse(state, (id) => {
    ids.push(id);
    incoming.set(id, []);
    outgoing.set(id, []);
  });
  const edges: [Id, Id][] = [];
  forEachRoute(state, (id, route) => {
    outgoing.get(route.srcId)?.push(id);
    incoming.get(route.dstId)?.push(id);
    edges.push([route.srcId, route.dstId]);
  });
  const order = topoSort(ids, edges);
  if (order === null) {
    throw new Error("route graph has a cycle — solver invariant violated");
  }
  const reverseOrder = [...order].reverse();

  // Each route's flow is min(srcCap, dstCap): the source's current allowance (set by the
  // forward sweep of an SL source) and the destination's current allowance (set by the
  // backward sweep of a DL destination). Both start optimistic at the route's cap.
  const srcCap = new Map<Id, number>();
  const dstCap = new Map<Id, number>();
  forEachRoute(state, (id, route) => {
    srcCap.set(id, route.cap);
    dstCap.set(id, route.cap);
  });
  const flowOf = (routeId: Id): number =>
    Math.min(srcCap.get(routeId) ?? 0, dstCap.get(routeId) ?? 0);

  const weights: number[] = [];
  const ceilings: number[] = [];
  const alloc: number[] = [];
  const prevFlow = new Map<Id, number>();
  forEachRoute(state, (id) => prevFlow.set(id, flowOf(id)));

  const sweepGuard = 4 * (ids.length + 1);
  let converged = false;
  for (let pass = 0; pass < sweepGuard && !converged; pass += 1) {
    forEachWarehouse(state, (_id, warehouse) => {
      warehouse.regime = "tracking";
      warehouse.inflowThrottle = 1;
      warehouse.outflowThrottle = 1;
    });

    // Forward sweep (sources first): a supply-limited source throttles its outgoing
    // consumers (sink + outgoing routes) to what it can actually supply.
    for (const id of order) {
      const warehouse = getWarehouse(state, id);
      if (warehouse.anchorAmount > 0) {
        continue; // only an empty warehouse can be supply-limited
      }
      const outs = outgoing.get(id) ?? [];
      let grossIn = warehouse.inflow;
      for (const routeId of incoming.get(id) ?? []) {
        grossIn += flowOf(routeId);
      }
      let desiredOut = warehouse.pullRate;
      for (const routeId of outs) {
        desiredOut += dstCap.get(routeId) ?? 0;
      }
      if (desiredOut < grossIn) {
        for (const routeId of outs) {
          srcCap.set(routeId, getRoute(state, routeId).cap);
        }
        continue; // not supply-limited: outgoing routes bounded only by their dest
      }
      weights[0] = warehouse.pullRate;
      ceilings[0] = warehouse.pullRate;
      for (const [i, routeId] of outs.entries()) {
        weights[i + 1] = getRoute(state, routeId).cap;
        ceilings[i + 1] = dstCap.get(routeId) ?? 0;
      }
      weights.length = outs.length + 1;
      ceilings.length = outs.length + 1;
      warehouse.outflowThrottle = allocateCapped(grossIn, weights, ceilings, alloc);
      warehouse.regime = "pinned-empty";
      for (const [i, routeId] of outs.entries()) {
        srcCap.set(routeId, alloc[i + 1] ?? 0);
      }
    }

    // Backward sweep (sinks first): a demand-limited destination throttles its incoming
    // producers (extractor pool + incoming routes) to what it can actually accept.
    for (const id of reverseOrder) {
      const warehouse = getWarehouse(state, id);
      if (warehouse.anchorAmount < warehouse.capacity) {
        continue; // only a full warehouse can be demand-limited
      }
      const ins = incoming.get(id) ?? [];
      let grossOut = warehouse.pullRate;
      for (const routeId of outgoing.get(id) ?? []) {
        grossOut += flowOf(routeId);
      }
      let desiredIn = warehouse.inflow;
      for (const routeId of ins) {
        desiredIn += srcCap.get(routeId) ?? 0;
      }
      if (desiredIn < grossOut) {
        for (const routeId of ins) {
          dstCap.set(routeId, getRoute(state, routeId).cap);
        }
        continue; // not demand-limited: incoming routes bounded only by their source
      }
      weights[0] = warehouse.inflow;
      ceilings[0] = warehouse.inflow;
      for (const [i, routeId] of ins.entries()) {
        weights[i + 1] = getRoute(state, routeId).cap;
        ceilings[i + 1] = srcCap.get(routeId) ?? 0;
      }
      weights.length = ins.length + 1;
      ceilings.length = ins.length + 1;
      warehouse.inflowThrottle = allocateCapped(grossOut, weights, ceilings, alloc);
      warehouse.regime = "pinned-full";
      for (const [i, routeId] of ins.entries()) {
        dstCap.set(routeId, alloc[i + 1] ?? 0);
      }
    }

    converged = true;
    forEachRoute(state, (id) => {
      const flow = flowOf(id);
      if (flow !== prevFlow.get(id)) {
        converged = false;
      }
      prevFlow.set(id, flow);
    });
  }
  if (!converged) {
    throw new Error(`route solver did not converge in ${sweepGuard} sweeps`);
  }

  const routeInflow = new Map<Id, number>();
  const routeOutflow = new Map<Id, number>();
  for (const id of ids) {
    routeInflow.set(id, 0);
    routeOutflow.set(id, 0);
  }
  forEachRoute(state, (id, route) => {
    route.flow = flowOf(id);
    routeInflow.set(route.dstId, (routeInflow.get(route.dstId) ?? 0) + route.flow);
    routeOutflow.set(route.srcId, (routeOutflow.get(route.srcId) ?? 0) + route.flow);
  });
  return { routeInflow, routeOutflow };
}

// Set net rate and schedule the next crossing, trusting the regime and route totals the
// solver already settled. Callers must have re-anchored the warehouse and run solveRoutes
// first, passing that warehouse's realized route in/out totals. Pins hold their boundary
// value and generate no event churn.
function scheduleWarehouse(
  state: SimState,
  id: Id,
  warehouse: Warehouse,
  routeInflow: number,
  routeOutflow: number,
): void {
  warehouse.eventSeq += 1; // invalidates any scheduled crossing for this warehouse
  if (warehouse.regime === "pinned-full") {
    warehouse.anchorAmount = warehouse.capacity;
    warehouse.netRate = 0;
    return;
  }
  if (warehouse.regime === "pinned-empty") {
    warehouse.anchorAmount = 0;
    warehouse.netRate = 0;
    return;
  }
  const net = warehouse.inflow + routeInflow - warehouse.pullRate - routeOutflow;
  warehouse.netRate = net;
  const amount = warehouse.anchorAmount;
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
  // Producers share the acceptance budget by the water level the solver settled; with no
  // routes this reduces to the old pullRate/inflow proportional throttle.
  return nominal * warehouse.inflowThrottle;
}

export function warehouseOutflowRate(state: SimState, id: Id): number {
  const warehouse = getWarehouse(state, id);
  if (warehouse.regime !== "pinned-empty") {
    return warehouse.pullRate;
  }
  // Sink throttled by the water level the solver settled; with no routes this reduces to
  // the old min(pullRate, inflow).
  return warehouse.pullRate * warehouse.outflowThrottle;
}

export function routeFlow(state: SimState, id: Id): number {
  return getRoute(state, id).flow;
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

function checkCap(cap: number): void {
  if (!Number.isFinite(cap) || !(cap >= 0)) {
    throw new Error(`route cap must be finite and >= 0, got ${cap}`);
  }
}

// Routes stay a DAG (solveRoutes relies on it): reject self-loops and any edge that would
// close a cycle at the command boundary, so the solver never faces circulating flow. The
// proposed edge plus the existing routes must still topologically sort.
export function addRoute(state: SimState, t: number, srcId: Id, dstId: Id, cap: number): Id {
  if (srcId === dstId) {
    throw new Error(`route source and destination must differ, got ${srcId}`);
  }
  checkCap(cap);
  getWarehouse(state, srcId); // validates the source exists
  getWarehouse(state, dstId); // validates the destination exists
  const edges: [Id, Id][] = [[srcId, dstId]];
  forEachRoute(state, (_id, route) => edges.push([route.srcId, route.dstId]));
  if (topoSort(warehouseIds(state), edges) === null) {
    throw new Error(`route ${srcId}->${dstId} would create a cycle`);
  }
  advance(state, t);
  const id = allocId(state);
  setRoute(state, id, createRoute(srcId, dstId, cap));
  deriveAll(state);
  return id;
}

export function setRouteCap(state: SimState, t: number, id: Id, cap: number): void {
  checkCap(cap);
  const route = getRoute(state, id);
  advance(state, t);
  route.cap = cap;
  deriveAll(state);
}
