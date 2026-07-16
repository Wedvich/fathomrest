import type { Id } from "../ids.ts";
import type { ResourceType } from "../resource.ts";
import type { SimState } from "../state.ts";

// Piecewise regime between events (ADR-0001 §2: saturation is a regime, not an
// oscillation). "tracking" follows the closed form; pinned regimes hold the boundary
// value with producers/consumers throttled, generating no event churn.
export const WAREHOUSE_REGIMES = ["tracking", "pinned-full", "pinned-empty"] as const;
export type WarehouseRegime = (typeof WAREHOUSE_REGIMES)[number];

export interface Warehouse {
  // The single resource this warehouse stores; incoming extractors and routes must match
  // it (sim.ts: addExtractor, addRoute). Opaque tag, compared only for equality.
  resource: ResourceType;
  capacity: number;
  // Closed-form anchor: amount(t) = anchorAmount + netRate * (t - anchorTime), clamped
  // to [0, capacity]. Always evaluated from the anchor, never accumulated incrementally
  // (docs/browser-performance.md: float determinism).
  anchorAmount: number;
  anchorTime: number;
  netRate: number;
  // Total nominal extractor rate into this warehouse (excludes route inflow). Cached on
  // every regime re-derivation so rate queries stay allocation-free
  // (docs/browser-performance.md: query hot path).
  inflow: number;
  // Consumer demand; actual outflow is throttled to inflow while pinned-empty.
  pullRate: number;
  // Water-fill levels from the flow solver, applied in the query hot path. While
  // pinned-full, each uncapped producer's realized rate is nominal * inflowThrottle;
  // while pinned-empty, the sink's realized rate is pullRate * outflowThrottle. Both are
  // 1 outside the corresponding pinned regime.
  inflowThrottle: number;
  outflowThrottle: number;
  regime: WarehouseRegime;
  // Bumped on every regime re-derivation; scheduled events carry a snapshot, and a
  // mismatch marks the event stale (lazy deletion).
  eventSeq: number;
}

export function createWarehouse(
  resource: ResourceType,
  capacity: number,
  anchorTime: number,
): Warehouse {
  return {
    resource,
    capacity,
    anchorAmount: 0,
    anchorTime,
    netRate: 0,
    inflow: 0,
    pullRate: 0,
    inflowThrottle: 1,
    outflowThrottle: 1,
    regime: "tracking",
    eventSeq: 0,
  };
}

export function getWarehouse(state: SimState, id: Id): Warehouse {
  const warehouse = state.warehouses.get(id);
  if (warehouse === undefined) {
    throw new Error(`no warehouse ${id}`);
  }
  return warehouse;
}

export function setWarehouse(state: SimState, id: Id, warehouse: Warehouse): void {
  state.warehouses.set(id, warehouse);
}

export function forEachWarehouse(
  state: SimState,
  fn: (id: Id, warehouse: Warehouse) => void,
): void {
  for (const [id, warehouse] of state.warehouses) {
    fn(id, warehouse);
  }
}

export function warehouseIds(state: SimState): Id[] {
  return [...state.warehouses.keys()];
}
