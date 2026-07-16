import type { Deposit, DepositTier } from "./components/deposit.ts";
import type { Extractor } from "./components/extractor.ts";
import type { Route } from "./components/route.ts";
import { WAREHOUSE_REGIMES, type Warehouse } from "./components/warehouse.ts";
import {
  allEvents,
  createEventQueue,
  EVENT_KIND_PRIORITY,
  pushEvent,
  type SimEvent,
} from "./events.ts";
import { topoSort } from "./graph.ts";
import type { Id } from "./ids.ts";
import type { PrngState } from "./prng.ts";
import type { ResourceType } from "./resource.ts";
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
  deposits: TableEntries<Deposit>;
  routes: TableEntries<Route>;
}

// Tables and events are copied in both directions so a save document never aliases
// live state. Components with nested data (deposit tiers) pass a deep copier.

function shallowCopy<T extends object>(component: T): T {
  return { ...component };
}

function copyDeposit(deposit: Deposit): Deposit {
  return {
    ...deposit,
    tiers: deposit.tiers.map((tier): DepositTier => ({ ...tier })),
  };
}

export function tableToEntries<T extends object>(
  table: ReadonlyMap<Id, T>,
  copy: (component: T) => T = shallowCopy,
): TableEntries<T> {
  const entries: TableEntries<T> = [];
  for (const [id, component] of table) {
    entries.push([id, copy(component)]);
  }
  return entries;
}

export function entriesToTable<T extends object>(
  entries: readonly (readonly [Id, T])[],
  copy: (component: T) => T = shallowCopy,
): Map<Id, T> {
  const table = new Map<Id, T>();
  for (const [id, component] of entries) {
    table.set(id, copy(component));
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
    deposits: tableToEntries(state.deposits, copyDeposit),
    routes: tableToEntries(state.routes),
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

// Sign/range mirrors of the command-boundary validators (sim.ts). Without them a
// hand-edited save with e.g. a negative cap or capacity imports cleanly and then feeds the
// solver reversed flows or a warehouse whose amount clamps to a negative floor forever.
function checkNonNegative(value: number, field: string): void {
  checkFinite(value, field);
  if (value < 0) {
    throw invalid(`${field} must be >= 0`);
  }
}

function checkPositive(value: number, field: string): void {
  checkFinite(value, field);
  if (!(value > 0)) {
    throw invalid(`${field} must be > 0`);
  }
}

// Resource tags are opaque strings; the sim compares them for equality (route/extractor
// type-match), so an empty or non-string tag is a corrupt document.
function checkResource(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${field} must be a non-empty string`);
  }
}

function checkTable<T extends object>(
  entries: TableEntries<T>,
  field: string,
  checkComponent: (component: T, at: string, id: number) => void,
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
    checkComponent(component, `${field}[${id}]`, id);
    ids.add(id);
  }
  return ids;
}

// The solver requires an acyclic route graph. Reuse the same iterative Kahn sort the
// solver and command boundary use (graph.ts) — no recursion, so a deep hand-edited chain
// can't overflow the stack. A null result means the edges contain a cycle.
function checkRoutesAcyclic(routes: TableEntries<Route>): void {
  const nodes = new Set<Id>();
  const edges: [Id, Id][] = [];
  for (const [, route] of routes) {
    nodes.add(route.srcId);
    nodes.add(route.dstId);
    edges.push([route.srcId, route.dstId]);
  }
  if (topoSort([...nodes], edges) === null) {
    throw invalid("routes form a cycle");
  }
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
  const warehouseResource = new Map<number, ResourceType>();
  const warehouseIds = checkTable(doc.warehouses, "warehouses", (warehouse, at, id) => {
    checkResource(warehouse.resource, `${at}.resource`);
    warehouseResource.set(id, warehouse.resource);
    checkPositive(warehouse.capacity, `${at}.capacity`);
    checkFinite(warehouse.anchorAmount, `${at}.anchorAmount`);
    if (warehouse.anchorAmount < 0 || warehouse.anchorAmount > warehouse.capacity) {
      throw invalid(`${at}.anchorAmount must be in [0, capacity]`);
    }
    checkFinite(warehouse.anchorTime, `${at}.anchorTime`);
    checkFinite(warehouse.netRate, `${at}.netRate`);
    checkFinite(warehouse.inflow, `${at}.inflow`);
    checkNonNegative(warehouse.pullRate, `${at}.pullRate`);
    checkFinite(warehouse.inflowThrottle, `${at}.inflowThrottle`);
    checkFinite(warehouse.outflowThrottle, `${at}.outflowThrottle`);
    checkFinite(warehouse.eventSeq, `${at}.eventSeq`);
    if (!WAREHOUSE_REGIMES.includes(warehouse.regime)) {
      throw invalid(`${at}.regime must be one of ${WAREHOUSE_REGIMES.join(", ")}`);
    }
  });
  const depositResource = new Map<number, ResourceType>();
  const depositIds = checkTable(doc.deposits, "deposits", (deposit, at, id) => {
    checkResource(deposit.resource, `${at}.resource`);
    depositResource.set(id, deposit.resource);
    if (!Array.isArray(deposit.tiers)) {
      throw invalid(`${at}.tiers must be an array`);
    }
    for (const [index, tier] of deposit.tiers.entries()) {
      if (tier === null || typeof tier !== "object") {
        throw invalid(`${at}.tiers[${index}] must be an object`);
      }
      checkFinite(tier.amount, `${at}.tiers[${index}].amount`);
      checkFinite(tier.multiplier, `${at}.tiers[${index}].multiplier`);
    }
    checkFinite(deposit.tierIndex, `${at}.tierIndex`);
    // A non-integer or out-of-range index would evaluate the floor regime against a
    // tier that half-exists; the sim indexes tiers[tierIndex] directly.
    if (
      !Number.isInteger(deposit.tierIndex) ||
      deposit.tierIndex < 0 ||
      deposit.tierIndex > deposit.tiers.length
    ) {
      throw invalid(`${at}.tierIndex must be an integer in [0, tiers.length]`);
    }
    checkFinite(deposit.floorMultiplier, `${at}.floorMultiplier`);
    checkFinite(deposit.anchorRemaining, `${at}.anchorRemaining`);
    checkFinite(deposit.anchorTime, `${at}.anchorTime`);
    checkFinite(deposit.depletionRate, `${at}.depletionRate`);
    checkFinite(deposit.eventSeq, `${at}.eventSeq`);
  });
  checkTable(doc.extractors, "extractors", (extractor, at) => {
    checkNonNegative(extractor.rate, `${at}.rate`);
    checkFinite(extractor.depositId, `${at}.depositId`);
    if (!depositIds.has(extractor.depositId)) {
      throw invalid(`${at}.depositId ${extractor.depositId} has no deposit`);
    }
    checkFinite(extractor.warehouseId, `${at}.warehouseId`);
    if (!warehouseIds.has(extractor.warehouseId)) {
      throw invalid(`${at}.warehouseId ${extractor.warehouseId} has no warehouse`);
    }
    // Mirror addExtractor's type-match: an ore extractor feeding a stone warehouse is a
    // corrupt document (the solver ignores types, so this never throws deep in advance).
    if (depositResource.get(extractor.depositId) !== warehouseResource.get(extractor.warehouseId)) {
      throw invalid(`${at} deposit and warehouse resources must match`);
    }
  });
  checkTable(doc.routes, "routes", (route, at) => {
    checkFinite(route.srcId, `${at}.srcId`);
    if (!warehouseIds.has(route.srcId)) {
      throw invalid(`${at}.srcId ${route.srcId} has no warehouse`);
    }
    checkFinite(route.dstId, `${at}.dstId`);
    if (!warehouseIds.has(route.dstId)) {
      throw invalid(`${at}.dstId ${route.dstId} has no warehouse`);
    }
    if (route.srcId === route.dstId) {
      throw invalid(`${at} source and destination must differ`);
    }
    // Mirror addRoute's type-match: a route can only move one resource between same-typed
    // warehouses.
    if (warehouseResource.get(route.srcId) !== warehouseResource.get(route.dstId)) {
      throw invalid(`${at} source and destination resources must match`);
    }
    checkNonNegative(route.cap, `${at}.cap`);
    checkNonNegative(route.flow, `${at}.flow`);
  });
  // The solver's convergence bound rests on an acyclic route graph; a hand-edited save
  // with a cycle would otherwise throw deep inside a later advance(). Reject it here.
  checkRoutesAcyclic(doc.routes);
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
    // Dangling entityIds would throw from a table getter inside a later advance() or
    // serializeState(); each kind targets its owning table (sim.ts dispatch).
    checkFinite(event.entityId, "event.entityId");
    const ownerIds = event.kind === "deposit-tier-depleted" ? depositIds : warehouseIds;
    if (!ownerIds.has(event.entityId)) {
      throw invalid(
        `event.entityId ${event.entityId} has no ${event.kind === "deposit-tier-depleted" ? "deposit" : "warehouse"}`,
      );
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
    deposits: entriesToTable(doc.deposits, copyDeposit),
    routes: entriesToTable(doc.routes),
  };
}
