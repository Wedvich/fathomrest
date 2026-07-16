import {
  createConverter,
  forEachConverter,
  getConverter,
  setConverter,
} from "./components/converter.ts";
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
import type { IslandId } from "./island.ts";
import type { ResourceType } from "./resource.ts";
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
//      extractor inflow — both are inputs the transfer solver reads as constants.
//   2. solveTransfers: settle every transfer flow (routes ∪ converters), each
//      warehouse's transfer in/out totals and throttle levels, and the regime of
//      saturated (pinned) warehouses. Transfers make a warehouse's net rate depend on
//      its neighbours' regimes, so this is a fixed point over the transfer DAG (see
//      solveTransfers).
//   3. Schedule crossings: with transfer flows settled, each warehouse's net rate is a
//      constant and its fill/empty time is closed-form (scheduleWarehouse).
//   4. Deposit depletion reads the (transfer-aware) extractor throttles from phase 2.
// Rates are stepwise-constant between events. Global (not targeted) re-derivation is
// O(entities) per event/command; revisit only if a profile ever shows it.
function deriveAll(state: SimState): void {
  const t = state.epoch;
  forEachWarehouse(state, (id, warehouse) => {
    reanchorWarehouse(warehouse, t);
    warehouse.inflow = totalInflow(state, id);
  });
  const { transferInflow, transferOutflow } = solveTransfers(state);
  forEachWarehouse(state, (id, warehouse) => {
    scheduleWarehouse(
      state,
      id,
      warehouse,
      transferInflow.get(id) ?? 0,
      transferOutflow.get(id) ?? 0,
    );
  });
  forEachDeposit(state, (id, deposit) => {
    reanchorDeposit(deposit, t);
    deriveDepositDepletion(state, id, deposit);
  });
}

// Derive-time only: scans the extractor table for the nominal (pre-throttle) producer
// rate into a warehouse. Queries read the cached warehouse.inflow instead (query(t) must
// not allocate or scan). Transfer inflow is settled separately by solveTransfers.
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

// A transfer edge is the solver's unified view of a route or a converter: both couple a
// source and a destination warehouse. `ratio` is destination units produced per source
// unit drawn — exactly 1 for routes, so route math is bit-identical to a route-only
// solver (x·1 and x/1 are exact). The allowances srcCap/dstCap are ALWAYS held in
// source units; ratio conversion happens only at the destination-side water-fill
// (multiply going in, divide coming out).
interface TransferEdge {
  srcId: Id;
  dstId: Id;
  // Maximum draw from the source, source units (a route's cap / a converter's cap).
  cap: number;
  // Destination units per source unit (1 for routes, a converter's ratio > 0).
  ratio: number;
  // Current allowances, both in source units: srcCap set by the forward sweep of a
  // supply-limited source, dstCap by the backward sweep of a demand-limited destination.
  // Both start optimistic at cap. draw = min(srcCap, dstCap); feed = draw · ratio.
  srcCap: number;
  dstCap: number;
  // Backing component (Route or Converter) for the cached-flow writeback.
  component: { flow: number };
}

// Resolve every transfer flow (routes ∪ converters) and each warehouse's regime at the
// current (frozen) amounts.
//
// A transfer edge is a consumer of its source and a producer for its destination, so a
// warehouse's net rate depends on its neighbours' regimes. With amounts frozen, a
// warehouse can only constrain flow when *saturated*: an interior warehouse (0 < amount
// < cap) is transparent; amount == cap is pinned-full (demand-limited, DL) when it would
// overflow and throttles its incoming edges (backpressure — travels upstream); amount
// == 0 is pinned-empty (supply-limited, SL) when it would starve and throttles its
// outgoing edges (starvation — travels downstream). A warehouse cannot be both (cap >
// 0), so the two influence waves never reflect and the iteration cannot oscillate; it
// converges in <= 2·N alternating sweeps over the transfer DAG (proof in ADR-0001 §route
// solver — a converter is just a ratio-scaled edge; a positive constant ratio preserves
// the water-fill's monotonicity, so the bound is unchanged). Cycles are rejected at the
// command and import boundaries, so the topological order always exists; a null here
// means one slipped past — a loud canary, never hit on valid input. SWEEP_GUARD is the
// analogous canary on sweep count. Every sum is taken in table order, the edge order is
// fixed (routes first, then converters, each in table order), and sweeps run in
// topological order (ties by table order) so replay stays bit-identical
// (docs/browser-performance.md: determinism).
//
// Returns each warehouse's realized transfer inflow/outflow totals — intra-derive
// scratch consumed by scheduleWarehouse in the same deriveAll, not cached on the
// warehouse. Inflow is in the destination's units (converter feed = draw · ratio);
// outflow is in the source's units (draw).
function solveTransfers(state: SimState): {
  transferInflow: Map<Id, number>;
  transferOutflow: Map<Id, number>;
} {
  const ids: Id[] = [];
  const incoming = new Map<Id, TransferEdge[]>();
  const outgoing = new Map<Id, TransferEdge[]>();
  forEachWarehouse(state, (id) => {
    ids.push(id);
    incoming.set(id, []);
    outgoing.set(id, []);
  });
  const edgeList: TransferEdge[] = [];
  forEachRoute(state, (_id, route) => {
    edgeList.push({
      srcId: route.srcId,
      dstId: route.dstId,
      cap: route.cap,
      ratio: 1,
      srcCap: route.cap,
      dstCap: route.cap,
      component: route,
    });
  });
  forEachConverter(state, (_id, converter) => {
    edgeList.push({
      srcId: converter.srcId,
      dstId: converter.dstId,
      cap: converter.cap,
      ratio: converter.ratio,
      srcCap: converter.cap,
      dstCap: converter.cap,
      component: converter,
    });
  });
  const graphEdges: [Id, Id][] = [];
  for (const edge of edgeList) {
    outgoing.get(edge.srcId)?.push(edge);
    incoming.get(edge.dstId)?.push(edge);
    graphEdges.push([edge.srcId, edge.dstId]);
  }
  const order = topoSort(ids, graphEdges);
  if (order === null) {
    throw new Error("transfer graph has a cycle — solver invariant violated");
  }
  const reverseOrder = [...order].reverse();

  // Realized draw from the source (source units); the destination receives draw · ratio.
  const drawOf = (edge: TransferEdge): number => Math.min(edge.srcCap, edge.dstCap);

  const weights: number[] = [];
  const ceilings: number[] = [];
  const alloc: number[] = [];
  const prevDraw = edgeList.map(drawOf);

  const sweepGuard = 4 * (ids.length + 1);
  let converged = false;
  for (let pass = 0; pass < sweepGuard && !converged; pass += 1) {
    forEachWarehouse(state, (_id, warehouse) => {
      warehouse.regime = "tracking";
      warehouse.inflowThrottle = 1;
      warehouse.outflowThrottle = 1;
    });

    // Forward sweep (sources first): a supply-limited source throttles its outgoing
    // consumers (sink + outgoing edges) to what it can actually supply. Every quantity
    // here is in this warehouse's units: incoming feed is draw · ratio; outgoing
    // allowances are already source units.
    for (const id of order) {
      const warehouse = getWarehouse(state, id);
      if (warehouse.anchorAmount > 0) {
        continue; // only an empty warehouse can be supply-limited
      }
      const outs = outgoing.get(id) ?? [];
      let grossIn = warehouse.inflow;
      for (const edge of incoming.get(id) ?? []) {
        grossIn += drawOf(edge) * edge.ratio;
      }
      let desiredOut = warehouse.pullRate;
      for (const edge of outs) {
        desiredOut += edge.dstCap;
      }
      if (desiredOut < grossIn) {
        for (const edge of outs) {
          edge.srcCap = edge.cap;
        }
        continue; // not supply-limited: outgoing edges bounded only by their dest
      }
      weights[0] = warehouse.pullRate;
      ceilings[0] = warehouse.pullRate;
      for (const [i, edge] of outs.entries()) {
        weights[i + 1] = edge.cap;
        ceilings[i + 1] = edge.dstCap;
      }
      weights.length = outs.length + 1;
      ceilings.length = outs.length + 1;
      warehouse.outflowThrottle = allocateCapped(grossIn, weights, ceilings, alloc);
      warehouse.regime = "pinned-empty";
      for (const [i, edge] of outs.entries()) {
        edge.srcCap = alloc[i + 1] ?? 0;
      }
    }

    // Backward sweep (sinks first): a demand-limited destination throttles its incoming
    // producers (extractor pool + incoming edges) to what it can actually accept. Every
    // quantity here is in this warehouse's (destination) units: incoming allowances
    // scale by ratio going into the water-fill and the granted allowance divides by
    // ratio coming out — the only place ratio conversion happens.
    for (const id of reverseOrder) {
      const warehouse = getWarehouse(state, id);
      if (warehouse.anchorAmount < warehouse.capacity) {
        continue; // only a full warehouse can be demand-limited
      }
      const ins = incoming.get(id) ?? [];
      let grossOut = warehouse.pullRate;
      for (const edge of outgoing.get(id) ?? []) {
        grossOut += drawOf(edge);
      }
      let desiredIn = warehouse.inflow;
      for (const edge of ins) {
        desiredIn += edge.srcCap * edge.ratio;
      }
      if (desiredIn < grossOut) {
        for (const edge of ins) {
          edge.dstCap = edge.cap;
        }
        continue; // not demand-limited: incoming edges bounded only by their source
      }
      weights[0] = warehouse.inflow;
      ceilings[0] = warehouse.inflow;
      for (const [i, edge] of ins.entries()) {
        weights[i + 1] = edge.cap * edge.ratio;
        ceilings[i + 1] = edge.srcCap * edge.ratio;
      }
      weights.length = ins.length + 1;
      ceilings.length = ins.length + 1;
      warehouse.inflowThrottle = allocateCapped(grossOut, weights, ceilings, alloc);
      warehouse.regime = "pinned-full";
      for (const [i, edge] of ins.entries()) {
        edge.dstCap = (alloc[i + 1] ?? 0) / edge.ratio;
      }
    }

    converged = true;
    for (const [i, edge] of edgeList.entries()) {
      const draw = drawOf(edge);
      if (draw !== prevDraw[i]) {
        converged = false;
      }
      prevDraw[i] = draw;
    }
  }
  if (!converged) {
    throw new Error(`transfer solver did not converge in ${sweepGuard} sweeps`);
  }

  const transferInflow = new Map<Id, number>();
  const transferOutflow = new Map<Id, number>();
  for (const id of ids) {
    transferInflow.set(id, 0);
    transferOutflow.set(id, 0);
  }
  for (const edge of edgeList) {
    const draw = drawOf(edge);
    edge.component.flow = draw;
    transferInflow.set(edge.dstId, (transferInflow.get(edge.dstId) ?? 0) + draw * edge.ratio);
    transferOutflow.set(edge.srcId, (transferOutflow.get(edge.srcId) ?? 0) + draw);
  }
  return { transferInflow, transferOutflow };
}

// Set net rate and schedule the next crossing, trusting the regime and transfer totals
// the solver already settled. Callers must have re-anchored the warehouse and run
// solveTransfers first, passing that warehouse's realized transfer in/out totals. Pins
// hold their boundary value and generate no event churn.
function scheduleWarehouse(
  state: SimState,
  id: Id,
  warehouse: Warehouse,
  transferInflow: number,
  transferOutflow: number,
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
  const net = warehouse.inflow + transferInflow - warehouse.pullRate - transferOutflow;
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

// Realized converter consumption from its source, in source (A) units.
export function converterDraw(state: SimState, id: Id): number {
  return getConverter(state, id).flow;
}

// Realized converter production into its destination, in destination (B) units.
export function converterFeed(state: SimState, id: Id): number {
  const converter = getConverter(state, id);
  return converter.flow * converter.ratio;
}

// Commands (ADR-0001 implementation notes): validate -> advance to the command time ->
// mutate -> re-derive rates -> reschedule. Taking t and advancing internally makes
// "commands land at the current time" a mechanism, not a caller convention.
// Version bump + save are app-layer concerns once the UI binding exists.

export function addWarehouse(
  state: SimState,
  t: number,
  resource: ResourceType,
  island: IslandId,
  capacity: number,
): Id {
  if (island.length === 0) {
    throw new Error("warehouse island must be a non-empty tag");
  }
  if (!(capacity > 0)) {
    throw new Error(`warehouse capacity must be > 0, got ${capacity}`);
  }
  advance(state, t);
  const id = allocId(state);
  setWarehouse(state, id, createWarehouse(resource, island, capacity, state.epoch));
  deriveAll(state);
  return id;
}

// Add `amount` of stock straight into a warehouse at t, capped at its capacity — the way a
// world seeds a starting stockpile (no producer required) and, later, how one-off rewards
// land. Same validate -> advance -> mutate -> derive shape as the other commands; reads the
// holding at t and re-anchors at t so the following deriveAll continues from the granted
// level. Excess above capacity is dropped, mirroring how a filled warehouse jams.
export function grantResource(state: SimState, t: number, warehouseId: Id, amount: number): void {
  if (!Number.isFinite(amount) || !(amount >= 0)) {
    throw new Error(`grant amount must be finite and >= 0, got ${amount}`);
  }
  const warehouse = getWarehouse(state, warehouseId); // validates the target exists
  advance(state, t);
  warehouse.anchorAmount = Math.min(warehouse.capacity, clampedAmount(warehouse, t) + amount);
  warehouse.anchorTime = t;
  deriveAll(state);
}

// tiers may be empty: a pure-floor deposit is a plain perpetual producer.
export function addDeposit(
  state: SimState,
  t: number,
  resource: ResourceType,
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
  setDeposit(state, id, createDeposit(resource, tiers, floorMultiplier, state.epoch));
  deriveAll(state);
  return id;
}

// Shared extractor wiring validation: rate sign, both endpoints exist, and the deposit's
// resource matches the warehouse's (the solver ignores types, so a mismatch must be caught
// here). Returns the target warehouse for callers that need it (buildExtractor reads its
// island for the cost debit).
function checkExtractorWiring(
  state: SimState,
  rate: number,
  depositId: Id,
  warehouseId: Id,
): Warehouse {
  if (!(rate >= 0)) {
    throw new Error(`extractor rate must be >= 0, got ${rate}`);
  }
  const deposit = getDeposit(state, depositId); // validates the source exists
  const warehouse = getWarehouse(state, warehouseId); // validates the target exists
  if (deposit.resource !== warehouse.resource) {
    throw new Error(
      `extractor resource mismatch: deposit yields ${deposit.resource}, warehouse stores ${warehouse.resource}`,
    );
  }
  return warehouse;
}

export function addExtractor(
  state: SimState,
  t: number,
  rate: number,
  depositId: Id,
  warehouseId: Id,
): Id {
  checkExtractorWiring(state, rate, depositId, warehouseId);
  advance(state, t);
  const id = allocId(state);
  setExtractor(state, id, createExtractor(rate, depositId, warehouseId));
  deriveAll(state);
  return id;
}

type Payer = { warehouse: Warehouse; available: number };

// Every warehouse on `island` storing `resource`, with each one's clamped amount at t and
// their sum. Shared by debitCost (which spends it) and canAffordBuild (which only checks the
// total), so the affordability rule and the debit can never drift apart. Table order
// (forEachWarehouse) keeps replay bit-identical (docs/browser-performance.md).
function islandPayers(
  state: SimState,
  t: number,
  island: IslandId,
  resource: ResourceType,
): { payers: Payer[]; total: number } {
  const payers: Payer[] = [];
  let total = 0;
  forEachWarehouse(state, (_id, warehouse) => {
    if (warehouse.islandId === island && warehouse.resource === resource) {
      const available = clampedAmount(warehouse, t);
      payers.push({ warehouse, available });
      total += available;
    }
  });
  return { payers, total };
}

// Debit a build cost from one island's stock. For each resource in the cost vector, spread
// the charge across every warehouse on the build site's island that stores it, in
// proportion to each one's current holding. Affordability is checked for the WHOLE vector
// before any warehouse is touched, so a shortfall on one resource can't half-charge the
// player. Reads amounts at t (callers advance to t first) and leaves each payer re-anchored
// at t for the following deriveAll. Iterates in table order (forEachWarehouse) and cost in
// its Map insertion order, so replay stays bit-identical (docs/browser-performance.md).
function debitCost(
  state: SimState,
  t: number,
  island: IslandId,
  cost: ReadonlyMap<ResourceType, number>,
): void {
  const plans: { payers: Payer[]; amount: number; total: number }[] = [];
  for (const [resource, amount] of cost) {
    if (!Number.isFinite(amount) || !(amount >= 0)) {
      throw new Error(`build cost for ${resource} must be finite and >= 0, got ${amount}`);
    }
    if (amount === 0) {
      continue;
    }
    const { payers, total } = islandPayers(state, t, island, resource);
    if (total < amount) {
      throw new Error(
        `insufficient ${resource} on island ${island}: need ${amount}, have ${total}`,
      );
    }
    plans.push({ payers, amount, total });
  }
  // Every resource affordable — debit proportionally. share_i = amount * available_i / total
  // <= available_i (amount <= total), so no warehouse is ever driven negative.
  for (const { payers, amount, total } of plans) {
    for (const { warehouse, available } of payers) {
      warehouse.anchorAmount = available - (amount * available) / total;
      warehouse.anchorTime = t;
    }
  }
}

// Read-only affordability check mirroring debitCost's whole-vector precondition: true iff
// every resource in `cost` is fully covered by stock on `island` at t. Advances and mutates
// nothing — callers (the build UI) advance to t first, same query contract as
// warehouseAmountAt. Uses the same per-resource island sum as debitCost (islandPayers), so a
// button that reports "affordable" can never be refused by the subsequent build.
export function canAffordBuild(
  state: SimState,
  t: number,
  island: IslandId,
  cost: ReadonlyMap<ResourceType, number>,
): boolean {
  for (const [resource, amount] of cost) {
    if (!Number.isFinite(amount) || !(amount >= 0)) {
      return false;
    }
    if (amount === 0) {
      continue;
    }
    if (islandPayers(state, t, island, resource).total < amount) {
      return false;
    }
  }
  return true;
}

// Player build command: pay `cost` from the build site's island, then place the extractor,
// atomically. Same validate -> advance -> mutate -> derive shape as addExtractor, but the
// resources leave stock and the producer appears in one command at t. Cost is charged only
// against the target warehouse's island (island.ts) — stock on other islands is untouchable.
export function buildExtractor(
  state: SimState,
  t: number,
  cost: ReadonlyMap<ResourceType, number>,
  rate: number,
  depositId: Id,
  warehouseId: Id,
): Id {
  const warehouse = checkExtractorWiring(state, rate, depositId, warehouseId);
  advance(state, t);
  debitCost(state, t, warehouse.islandId, cost);
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
    throw new Error(`transfer cap must be finite and >= 0, got ${cap}`);
  }
}

// Transfers (routes ∪ converters) stay one combined DAG (solveTransfers relies on it):
// reject self-loops and any edge that would close a cycle at the command boundary, so
// the solver never faces circulating flow. The proposed edge plus every existing
// transfer edge must still topologically sort.
function assertTransfersAcyclic(state: SimState, srcId: Id, dstId: Id, kind: string): void {
  const edges: [Id, Id][] = [[srcId, dstId]];
  forEachRoute(state, (_id, route) => edges.push([route.srcId, route.dstId]));
  forEachConverter(state, (_id, converter) => edges.push([converter.srcId, converter.dstId]));
  if (topoSort(warehouseIds(state), edges) === null) {
    throw new Error(`${kind} ${srcId}->${dstId} would create a cycle`);
  }
}

export function addRoute(state: SimState, t: number, srcId: Id, dstId: Id, cap: number): Id {
  if (srcId === dstId) {
    throw new Error(`route source and destination must differ, got ${srcId}`);
  }
  checkCap(cap);
  const src = getWarehouse(state, srcId); // validates the source exists
  const dst = getWarehouse(state, dstId); // validates the destination exists
  if (src.resource !== dst.resource) {
    throw new Error(
      `route resource mismatch: source stores ${src.resource}, destination stores ${dst.resource}`,
    );
  }
  assertTransfersAcyclic(state, srcId, dstId, "route");
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

// Refinement command: wire a converter that consumes the source's resource and produces
// the destination's. The endpoint resources must DIFFER — a same-type "converter" would
// be a lossy/gainy route bypassing route conservation (DESIGN.md: changing type is
// refinement's job, never a route's). Same validate -> advance -> mutate -> deriveAll
// shape as addRoute; rides the same combined transfer DAG.
export function addConverter(
  state: SimState,
  t: number,
  srcId: Id,
  dstId: Id,
  cap: number,
  ratio: number,
): Id {
  if (srcId === dstId) {
    throw new Error(`converter source and destination must differ, got ${srcId}`);
  }
  checkCap(cap);
  if (!Number.isFinite(ratio) || !(ratio > 0)) {
    throw new Error(`converter ratio must be finite and > 0, got ${ratio}`);
  }
  const src = getWarehouse(state, srcId); // validates the source exists
  const dst = getWarehouse(state, dstId); // validates the destination exists
  if (src.resource === dst.resource) {
    throw new Error(
      `converter source and destination resources must differ, both store ${src.resource}`,
    );
  }
  assertTransfersAcyclic(state, srcId, dstId, "converter");
  advance(state, t);
  const id = allocId(state);
  setConverter(state, id, createConverter(srcId, dstId, cap, ratio));
  deriveAll(state);
  return id;
}
