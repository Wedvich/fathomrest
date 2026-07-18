import type { Id } from "../ids.ts";
import type { ResearchNodeId } from "../researchNode.ts";
import type { SimState } from "../state.ts";

// The single active research drain (DESIGN.md Progression/Research): a Factorio-style
// continuous drain on a knowledge pool. At most one exists at a time — the queue starts at
// depth 0 (a single active slot); enqueued nodes are app-level content and only the active
// node draws the pool. Modelled as the same closed form as an extractor→pool→drain chain:
// this node OWNS the pool's pullRate (drainRate while active, 0 once complete), so the
// warehouse's existing empty-throttle machinery makes an empty pool STALL the drain (never
// fail) at the pool's income rate, online and offline through one code path.
export interface Research {
  // Opaque content tag naming the node being researched — passthrough for the app to
  // re-associate the drain with its authored node after a save round-trip; the core never
  // interprets it.
  nodeId: ResearchNodeId;
  // The knowledge pool this node drains. It carries the drain through its pullRate and has
  // no other consumer, so warehouseOutflowRate(warehouseId) IS this node's realized draw
  // (sim.ts: startResearch, deriveResearch, the research-complete handler).
  warehouseId: Id;
  // Knowledge per second drawn while the pool keeps up: the global base drain rate (one
  // tunable knob, app-authored). node duration = cost / drainRate when fed.
  drainRate: number;
  // Absolute knowledge consumed to complete. Progress is the absolute `consumed`, not a
  // fraction, so rebalancing `cost` can never strand progress (clamped to cost at load,
  // serialize.ts). Complete at consumed >= cost.
  cost: number;
  // Closed-form anchor: consumed(t) = anchorConsumed + consumeRate * (t - anchorTime),
  // clamped to [0, cost]. consumeRate is the pool's realized (throttled) outflow, cached at
  // derive time; never accumulated incrementally (docs/browser-performance.md: determinism).
  anchorConsumed: number;
  anchorTime: number;
  consumeRate: number;
  // Bumped on every re-derivation; a scheduled research-complete carrying a stale seq is
  // dead (lazy deletion, like warehouse/deposit crossings).
  eventSeq: number;
}

// All creation goes through the factory so every instance has one shape
// (docs/browser-performance.md: stable shapes).
export function createResearch(
  nodeId: ResearchNodeId,
  warehouseId: Id,
  drainRate: number,
  cost: number,
  anchorConsumed: number,
  anchorTime: number,
): Research {
  return {
    nodeId,
    warehouseId,
    drainRate,
    cost,
    anchorConsumed,
    anchorTime,
    consumeRate: 0,
    eventSeq: 0,
  };
}

// Table accessors — the only way core code touches the research table. Iteration order is
// owned here (Map insertion order), keeping replay deterministic
// (docs/browser-performance.md: table access boundary).
export function getResearch(state: SimState, id: Id): Research {
  const research = state.research.get(id);
  if (research === undefined) {
    throw new Error(`no research ${id}`);
  }
  return research;
}

export function setResearch(state: SimState, id: Id, research: Research): void {
  state.research.set(id, research);
}

export function forEachResearch(state: SimState, fn: (id: Id, research: Research) => void): void {
  for (const [id, research] of state.research) {
    fn(id, research);
  }
}

export function researchIds(state: SimState): Id[] {
  return [...state.research.keys()];
}
