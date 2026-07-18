import type { IslandId } from "../island.ts";
import type { SimState } from "../state.ts";

// Per-island progression state (DESIGN.md: island specialization). Two parts:
//   - A throughput-fed XP accumulator. Closed-form like a warehouse: xp(t) = xpAnchor +
//     xpRate * (t - xpAnchorTime). xpRate is the island's realized production rate, re-derived
//     every deriveAll (sim.ts: islandThroughput) so it tracks jams and rate changes. XP never
//     schedules its own event — it has no cap and no crossing, so it monotonically integrates
//     the rate that other events already re-anchor it at. Lump grants (expedition/milestone
//     XP) re-anchor then bump xpAnchor, exactly like grantResource on a warehouse.
//   - Skill-node modifiers. extractionMultiplier scales every extractor on the island
//     (sim.ts: extractorEffectiveRate) — the "nodes are the multiplier" lever. 1 is the
//     identity (a freshly registered island).
// Keyed by IslandId (islands are app-authored content tags, not core entities), so this table
// is Map<IslandId, IslandProgress> rather than the usual Map<Id, T>. An island has XP only
// once registered (sim.ts: registerIsland); the global knowledge scope is never registered.
export interface IslandProgress {
  xpAnchor: number;
  xpAnchorTime: number;
  xpRate: number;
  extractionMultiplier: number;
}

export function createIslandProgress(anchorTime: number): IslandProgress {
  return {
    xpAnchor: 0,
    xpAnchorTime: anchorTime,
    xpRate: 0,
    extractionMultiplier: 1,
  };
}

export function isIslandRegistered(state: SimState, island: IslandId): boolean {
  return state.islandProgress.has(island);
}

export function getIslandProgress(state: SimState, island: IslandId): IslandProgress {
  const progress = state.islandProgress.get(island);
  if (progress === undefined) {
    throw new Error(`no island progress for ${island}`);
  }
  return progress;
}

export function setIslandProgress(
  state: SimState,
  island: IslandId,
  progress: IslandProgress,
): void {
  state.islandProgress.set(island, progress);
}

export function forEachIslandProgress(
  state: SimState,
  fn: (island: IslandId, progress: IslandProgress) => void,
): void {
  for (const [island, progress] of state.islandProgress) {
    fn(island, progress);
  }
}

export function islandProgressIds(state: SimState): IslandId[] {
  return [...state.islandProgress.keys()];
}
