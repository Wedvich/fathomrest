import { forEachConverter, getConverter } from "./components/converter.ts";
import { getDeposit } from "./components/deposit.ts";
import { forEachExtractor } from "./components/extractor.ts";
import { forEachRoute, getRoute } from "./components/route.ts";
import { forEachWarehouse, getWarehouse } from "./components/warehouse.ts";
import type { Id } from "./ids.ts";
import type { SimState } from "./state.ts";

// Root-cause solver queries — the sim's own account of WHY a pool is jammed or starved.
// Every jam surface renders these chains; the UI never infers causality (design handoff:
// "the sim core is the source of truth for jam/starvation causality").
//
// Everything here is a pure read over solver outputs that are stepwise-constant between
// events (regimes, throttles, realized transfer flows — settled by solveTransfers and
// persisted through saves), so like other rate queries these take no t. The chain walks
// retrace the solver's influence waves: backpressure travels upstream (a full pool
// throttles its incoming edges), so a jam's cause lies DOWNstream through its blocked
// outgoing edges; starvation travels downstream, so its cause lies UPstream. A blocked
// edge (flow < cap) always has a pinned far end — with the near pool saturated the near
// allowance stays at cap, so only the far end can have squeezed it — which is what makes
// the walk sound without re-running the solver.
//
// These are triage queries (tooltips, log rows, welcome-back dialog), invoked on events
// or coarse UI ticks — NOT the per-frame query hot path — so they may allocate. The
// boolean flags (isWarehouseJammed/Starved) are allocation-free and frame-safe.

export type TransferKind = "route" | "converter";

// The transfer edge (route or converter) that carried the blockage from a step's pool to
// the next pool in the chain.
export interface JamVia {
  readonly transferKind: TransferKind;
  readonly transferId: Id;
}

export interface JamChainStep {
  readonly warehouseId: Id;
  // Homogeneous along a chain: a jam walk only visits jammed pools, a starvation walk
  // only starved ones (a blocked edge's far end is pinned the same way).
  readonly kind: "pool-full" | "pool-empty";
  // Edge from the PREVIOUS step's pool to this one; null on the first (symptom) step.
  readonly via: JamVia | null;
}

// The true bottleneck classes (DESIGN.md economy: "find the true bottleneck — a route
// cap, a closed sink, or a dry deposit — not just any full warehouse").
export type JamRootKind =
  // Full root pool with zero outbound demand: no consumers, nothing to raise.
  | "closed-sink"
  // Full root pool whose consumers run at full allowance but below inflow.
  | "outflow-deficit"
  // Binding at-cap edges at the root pool — raising those caps is the fix.
  | "transfer-capped"
  // Empty root pool with nothing feeding it at all.
  | "no-producer"
  // Empty root pool whose feeding deposits sit in the floor (trickle) regime.
  | "dry-deposit"
  // Empty root pool whose producers run unthrottled but below demand.
  | "inflow-deficit";

export interface JamRoot {
  readonly kind: JamRootKind;
  readonly warehouseId: Id;
  // At-cap edges binding at the root (outgoing for a jam, incoming for a starvation) —
  // the "raise cap" fix targets. Non-empty iff kind is "transfer-capped".
  readonly cappedTransferIds: readonly Id[];
  // Floor-regime deposits feeding the root pool. Non-empty iff kind is "dry-deposit".
  readonly dryDepositIds: readonly Id[];
}

export interface JamChain {
  // Symptom first, root pool last. When a pool has several blocked edges the walk
  // follows the first in solver edge order (routes before converters, table order) —
  // deterministic; the parallel causes surface as their own listJams entries.
  readonly steps: readonly JamChainStep[];
  readonly root: JamRoot;
}

// A jam is a full pool actually blocking its producers. pinned-full alone is not enough:
// a pool at cap whose outflow matches inflow throttles nothing (water level 1) — that is
// "at cap", not jammed.
export function isWarehouseJammed(state: SimState, id: Id): boolean {
  const warehouse = getWarehouse(state, id);
  return warehouse.regime === "pinned-full" && warehouse.inflowThrottle < 1;
}

// Mirror: an empty pool actually throttling its consumers below their demand.
export function isWarehouseStarved(state: SimState, id: Id): boolean {
  const warehouse = getWarehouse(state, id);
  return warehouse.regime === "pinned-empty" && warehouse.outflowThrottle < 1;
}

type EdgeDirection = "out" | "in";

interface BlockedEdge {
  readonly via: JamVia;
  readonly nextId: Id;
}

// First blocked edge (flow < cap) touching the pool in solver edge order (routes before
// converters, table order), or null. "out" matches outgoing edges and yields the
// destination (a pinned-full pool — backpressure); "in" matches incoming edges and
// yields the source (a pinned-empty pool — starvation).
function firstBlockedEdge(
  state: SimState,
  warehouseId: Id,
  direction: EdgeDirection,
): BlockedEdge | null {
  let found: BlockedEdge | null = null;
  forEachRoute(state, (id, route) => {
    const [endId, farId] =
      direction === "out" ? [route.srcId, route.dstId] : [route.dstId, route.srcId];
    if (found === null && endId === warehouseId && route.flow < route.cap) {
      found = { via: { transferKind: "route", transferId: id }, nextId: farId };
    }
  });
  if (found !== null) {
    return found;
  }
  forEachConverter(state, (id, converter) => {
    const [endId, farId] =
      direction === "out" ? [converter.srcId, converter.dstId] : [converter.dstId, converter.srcId];
    if (found === null && endId === warehouseId && converter.flow < converter.cap) {
      found = { via: { transferKind: "converter", transferId: id }, nextId: farId };
    }
  });
  return found;
}

// At-cap edges touching the root pool (outgoing when full, incoming when empty), solver
// edge order. A cap-0 edge counts: a closed valve is a binding cap, and raising it drains.
function cappedEdges(state: SimState, warehouseId: Id, direction: EdgeDirection): Id[] {
  const capped: Id[] = [];
  forEachRoute(state, (id, route) => {
    const endId = direction === "out" ? route.srcId : route.dstId;
    if (endId === warehouseId && route.flow >= route.cap) {
      capped.push(id);
    }
  });
  forEachConverter(state, (id, converter) => {
    const endId = direction === "out" ? converter.srcId : converter.dstId;
    if (endId === warehouseId && converter.flow >= converter.cap) {
      capped.push(id);
    }
  });
  return capped;
}

function classifyFullRoot(state: SimState, warehouseId: Id): JamRoot {
  const capped = cappedEdges(state, warehouseId, "out");
  if (capped.length > 0) {
    return { kind: "transfer-capped", warehouseId, cappedTransferIds: capped, dryDepositIds: [] };
  }
  const kind = getWarehouse(state, warehouseId).pullRate > 0 ? "outflow-deficit" : "closed-sink";
  return { kind, warehouseId, cappedTransferIds: [], dryDepositIds: [] };
}

function classifyEmptyRoot(state: SimState, warehouseId: Id): JamRoot {
  // At the root every incoming edge is at cap (a blocked one would have continued the
  // walk), so any incoming edge at all means the caps are the binding constraint.
  const capped = cappedEdges(state, warehouseId, "in");
  if (capped.length > 0) {
    return { kind: "transfer-capped", warehouseId, cappedTransferIds: capped, dryDepositIds: [] };
  }
  let extractorCount = 0;
  const dry: Id[] = [];
  forEachExtractor(state, (_id, extractor) => {
    if (extractor.warehouseId !== warehouseId) {
      return;
    }
    extractorCount += 1;
    const deposit = getDeposit(state, extractor.depositId);
    // Dry means the rich phase ran out — a zero-tier deposit (authored as a pure
    // perpetual trickle) never had one, so it can't "run dry".
    if (
      deposit.tiers.length > 0 &&
      deposit.tierIndex >= deposit.tiers.length &&
      !dry.includes(extractor.depositId)
    ) {
      dry.push(extractor.depositId);
    }
  });
  if (extractorCount === 0) {
    return { kind: "no-producer", warehouseId, cappedTransferIds: [], dryDepositIds: [] };
  }
  if (dry.length > 0) {
    return { kind: "dry-deposit", warehouseId, cappedTransferIds: [], dryDepositIds: dry };
  }
  return { kind: "inflow-deficit", warehouseId, cappedTransferIds: [], dryDepositIds: [] };
}

function walkChain(state: SimState, startId: Id, kind: "pool-full" | "pool-empty"): JamChain {
  const steps: JamChainStep[] = [];
  let currentId = startId;
  let via: JamVia | null = null;
  // Transfers form a DAG (enforced at command/import boundaries) and each hop moves one
  // direction through it, so the walk is bounded by the pool count; overrunning it means
  // a cycle slipped past — the same loud canary as the solver's.
  for (let guard = 0; guard <= state.warehouses.size; guard += 1) {
    steps.push({ warehouseId: currentId, kind, via });
    const blocked = firstBlockedEdge(state, currentId, kind === "pool-full" ? "out" : "in");
    if (blocked === null) {
      const root =
        kind === "pool-full"
          ? classifyFullRoot(state, currentId)
          : classifyEmptyRoot(state, currentId);
      return { steps, root };
    }
    currentId = blocked.nextId;
    via = blocked.via;
  }
  throw new Error("jam chain exceeded pool count — transfer DAG invariant violated");
}

// The causality chain for a saturated pool: symptom-first steps ending at the root pool,
// plus the root's bottleneck classification. Null when the pool throttles nothing.
export function warehouseJamChain(state: SimState, id: Id): JamChain | null {
  if (isWarehouseJammed(state, id)) {
    return walkChain(state, id, "pool-full");
  }
  if (isWarehouseStarved(state, id)) {
    return walkChain(state, id, "pool-empty");
  }
  return null;
}

export interface TransferStatus {
  readonly kind: "flowing" | "shut" | "starved-source" | "blocked-destination";
  // The pinned pool throttling the edge — the entry point for warehouseJamChain, so the
  // surface can name the true cause. Null while flowing or shut. When both ends are pinned
  // the source is reported (deterministic pick; the destination jam surfaces on its own
  // pool) — known limitation: the binding end isn't persisted by the solver yet.
  readonly causeWarehouseId: Id | null;
}

function edgeStatus(
  state: SimState,
  srcId: Id,
  dstId: Id,
  cap: number,
  flow: number,
): TransferStatus {
  if (cap === 0) {
    // A closed valve: consistent with cappedEdges counting cap-0 edges as binding — the
    // fix (raise the cap) is the edge's own, not a pinned pool's.
    return { kind: "shut", causeWarehouseId: null };
  }
  if (flow >= cap) {
    return { kind: "flowing", causeWarehouseId: null };
  }
  // flow < cap means a pinned end squeezed the edge's allowance — no third possibility.
  if (getWarehouse(state, srcId).regime === "pinned-empty") {
    return { kind: "starved-source", causeWarehouseId: srcId };
  }
  return { kind: "blocked-destination", causeWarehouseId: dstId };
}

export function routeStatus(state: SimState, id: Id): TransferStatus {
  const route = getRoute(state, id);
  return edgeStatus(state, route.srcId, route.dstId, route.cap, route.flow);
}

export function converterStatus(state: SimState, id: Id): TransferStatus {
  const converter = getConverter(state, id);
  return edgeStatus(state, converter.srcId, converter.dstId, converter.cap, converter.flow);
}

export interface JamEntry {
  readonly warehouseId: Id;
  readonly kind: "pool-full" | "pool-empty";
  readonly chain: JamChain;
  // A root entry is its own bottleneck (single-step chain); symptoms reference their root
  // through chain.root.
  readonly isRoot: boolean;
}

// Every jammed or starved pool with its chain — root causes first, then symptoms, table
// order within each group (design handoff: log rows and triage lists order roots first).
export function listJams(state: SimState): JamEntry[] {
  const roots: JamEntry[] = [];
  const symptoms: JamEntry[] = [];
  forEachWarehouse(state, (id) => {
    const chain = warehouseJamChain(state, id);
    const first = chain?.steps[0];
    if (chain === null || first === undefined) {
      return;
    }
    const isRoot = chain.steps.length === 1;
    const entry: JamEntry = { warehouseId: id, kind: first.kind, chain, isRoot };
    (isRoot ? roots : symptoms).push(entry);
  });
  return [...roots, ...symptoms];
}
