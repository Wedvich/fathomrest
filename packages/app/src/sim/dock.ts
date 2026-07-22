// Right-dock view models (design handoff §1a). Pure presentation selectors over the
// loaded world: they translate the core's tables and jam-solver output into the exact
// shape the React dock renders, so the component never infers economy state itself
// (the sim core is the source of truth for jam causality — handoff constraint).

import {
  converterDraw,
  forEachConverter,
  getWarehouse,
  isWarehouseJammed,
  warehouseJamChain,
  type Id,
  type IslandId,
  type JamRootKind,
  type ResourceType,
  warehouseAmountAt,
} from "@fathomrest/core";

import type { DemoWorld } from "./world.ts";

// Outflow leg from a pool into a converter — the driftwood sub-line `−0.2/s → Refinery
// (iron ingot)`. Routes are excluded until inter-island transport lands (buildRoute).
export interface OutflowEdge {
  readonly rate: number; // source-units/s drawn from this pool right now
  readonly converterLabel: string;
  readonly producedResource: ResourceType;
}

// Why a jammed pool is blocked, as classified by the core solver. `isRoot` marks the
// pool as the bottleneck itself (ROOT treatment); otherwise it is a downstream symptom
// whose cause is the pool named by `rootLabel`.
export interface PoolBlock {
  readonly isRoot: boolean;
  readonly reason: string;
  readonly rootLabel: string;
}

export interface PoolRowView {
  readonly id: Id;
  readonly resource: ResourceType;
  readonly label: string;
  readonly amount: number; // raw float; caller rounds for display (sim/display.ts)
  readonly capacity: number;
  readonly netRate: number; // net accumulation into the pool (sign carries direction)
  readonly jammed: boolean;
  readonly block: PoolBlock | null; // non-null only when jammed
  readonly outflows: readonly OutflowEdge[];
}

// One-line cause per root class (DESIGN.md economy bottleneck taxonomy). Exhaustive over
// JamRootKind — a new kind is a compile error here, forcing a copy decision.
function jamRootReason(kind: JamRootKind): string {
  switch (kind) {
    case "closed-sink":
      return "no consumer draws from this pool";
    case "outflow-deficit":
      return "consumers can't keep up with inflow";
    case "transfer-capped":
      return "outflow capped — raise the transfer cap";
    case "no-producer":
      return "nothing is feeding this pool";
    case "dry-deposit":
      return "the feeding deposit is in its trickle floor";
    case "inflow-deficit":
      return "producers are running below demand";
  }
}

function outflowEdges(world: DemoWorld, poolId: Id): OutflowEdge[] {
  const state = world.state;
  const edges: OutflowEdge[] = [];
  forEachConverter(state, (id, converter) => {
    if (converter.srcId !== poolId) return;
    const site = world.converterSites.find(
      (s) => s.srcWarehouseId === converter.srcId && s.dstWarehouseId === converter.dstId,
    );
    edges.push({
      rate: converterDraw(state, id),
      converterLabel: site?.label ?? "converter",
      producedResource: getWarehouse(state, converter.dstId).resource,
    });
  });
  return edges;
}

// One pool row per warehouse on the island (the global knowledge pool sits on the
// "global" island, so island filtering already excludes it — hard rule 1).
export function poolRowViews(world: DemoWorld, island: IslandId, t: number): PoolRowView[] {
  const state = world.state;
  const labelById = new Map(world.warehouses.map((w) => [w.id, w.label] as const));
  const rows: PoolRowView[] = [];
  for (const wh of world.warehouses) {
    const core = getWarehouse(state, wh.id);
    if (core.islandId !== island) continue;
    const jammed = isWarehouseJammed(state, wh.id);
    let block: PoolBlock | null = null;
    if (jammed) {
      const chain = warehouseJamChain(state, wh.id);
      if (chain !== null) {
        const rootId = chain.root.warehouseId;
        block = {
          isRoot: rootId === wh.id,
          reason: jamRootReason(chain.root.kind),
          rootLabel: labelById.get(rootId) ?? "another pool",
        };
      }
    }
    rows.push({
      id: wh.id,
      resource: core.resource,
      label: wh.label,
      amount: warehouseAmountAt(state, wh.id, t),
      capacity: core.capacity,
      netRate: core.netRate,
      jammed,
      block,
      outflows: outflowEdges(world, wh.id),
    });
  }
  return rows;
}
