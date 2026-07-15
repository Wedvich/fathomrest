import type { Id } from "../ids.ts";
import type { SimState } from "../state.ts";

// Instant rate-capped flow between two warehouses (DESIGN.md economy: "D pulls from S,
// up to X/sec"). A route is simultaneously a consumer of its source and a producer for
// its destination, so it couples the two warehouses' regimes (sim.ts: solveRoutes).
// Routes are constrained to a DAG — cycles are rejected at the command boundary
// (addRoute) and on import (serialize.ts) so the flow solver stays a bounded, acyclic
// propagation rather than a differential loop (ADR-0001 §Consequences: the one-way door).
export interface Route {
  srcId: Id;
  dstId: Id;
  // Player-set maximum flow rate.
  cap: number;
  // Cached realized flow in [0, cap]; a derive output, read allocation-free by query(t)
  // (docs/browser-performance.md: query hot path). Never accumulated incrementally.
  flow: number;
}

// All creation goes through the factory so every instance has one shape
// (docs/browser-performance.md: stable shapes).
export function createRoute(srcId: Id, dstId: Id, cap: number): Route {
  return { srcId, dstId, cap, flow: 0 };
}

// Table accessors — the only way core code touches the route table. Iteration order is
// owned here (Map insertion order), keeping replay deterministic
// (docs/browser-performance.md: table access boundary).
export function getRoute(state: SimState, id: Id): Route {
  const route = state.routes.get(id);
  if (route === undefined) {
    throw new Error(`no route ${id}`);
  }
  return route;
}

export function setRoute(state: SimState, id: Id, route: Route): void {
  state.routes.set(id, route);
}

export function forEachRoute(state: SimState, fn: (id: Id, route: Route) => void): void {
  for (const [id, route] of state.routes) {
    fn(id, route);
  }
}

export function routeIds(state: SimState): Id[] {
  return [...state.routes.keys()];
}
