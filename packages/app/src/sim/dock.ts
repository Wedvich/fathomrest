// Right-dock view models (design handoff §1a). Pure presentation selectors over the
// loaded world: they translate the core's tables and jam-solver output into the exact
// shape the React dock renders, so the component never infers economy state itself
// (the sim core is the source of truth for jam causality — handoff constraint).

import {
  canAffordBuild,
  converterDraw,
  depositMultiplier,
  depositRemainingAt,
  forEachConverter,
  getDeposit,
  getWarehouse,
  isWarehouseJammed,
  listJams,
  warehouseAmountAt,
  warehouseJamChain,
  type Id,
  type IslandId,
  type JamRootKind,
  type ResourceType,
} from "@fathomrest/core";

import {
  buildConverter,
  buildExtractor,
  isConverterBuilt,
  isExtractorBuilt,
  isGlobalScope,
  nextStorageTier,
  upgradeStorage,
  type DemoWorld,
} from "./world.ts";

type CostEntries = readonly (readonly [ResourceType, number])[];

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

// The (island, resource) pool id — one warehouse per pair (world.ts invariant), so the
// first match is the pool. Build costs are charged against these.
function islandPoolId(world: DemoWorld, island: IslandId, resource: ResourceType): Id | undefined {
  for (const wh of world.warehouses) {
    const core = getWarehouse(world.state, wh.id);
    if (core.islandId === island && core.resource === resource) return wh.id;
  }
  return undefined;
}

// The next (lower) richness step a decaying deposit will fall to, and when.
export interface DepositNextStep {
  readonly multiplier: number;
  readonly after: number; // units still extractable in the current tier before the step
  readonly etaSeconds: number | null; // null when nothing is depleting the deposit
}

export interface DepositCardView {
  readonly id: Id;
  readonly label: string;
  readonly resource: ResourceType;
  readonly multiplier: number; // current richness ×
  readonly remaining: number; // raw; caller ceils (sim/display.ts)
  readonly total: number; // full rich reserve (sum of tiers; excludes the infinite floor)
  readonly floorMultiplier: number;
  readonly paused: boolean; // target pool jammed, so extraction is throttled off
  readonly nextStep: DepositNextStep | null; // null once in the floor regime
}

// One card per deposit whose pool is on the island (an off-island pool means a global
// observatory — surfaced in BUILD instead, not here).
export function depositCardViews(world: DemoWorld, island: IslandId, t: number): DepositCardView[] {
  const state = world.state;
  const cards: DepositCardView[] = [];
  for (const dep of world.deposits) {
    const pool = getWarehouse(state, dep.warehouseId);
    if (pool.islandId !== island) continue;
    const core = getDeposit(state, dep.id);
    const total = core.tiers.reduce((sum, tier) => sum + tier.amount, 0);
    const laterTiers = core.tiers
      .slice(core.tierIndex + 1)
      .reduce((sum, tier) => sum + tier.amount, 0);
    const remaining = depositRemainingAt(state, dep.id, t);
    const inTier = Math.max(0, remaining - laterTiers);

    let nextStep: DepositNextStep | null = null;
    if (core.tierIndex < core.tiers.length) {
      const next = core.tiers[core.tierIndex + 1];
      nextStep = {
        multiplier: next?.multiplier ?? core.floorMultiplier,
        after: inTier,
        etaSeconds: core.depletionRate > 0 ? inTier / core.depletionRate : null,
      };
    }

    cards.push({
      id: dep.id,
      label: dep.label,
      resource: dep.resource,
      multiplier: depositMultiplier(state, dep.id),
      remaining,
      total,
      floorMultiplier: core.floorMultiplier,
      paused: isWarehouseJammed(state, dep.warehouseId),
      nextStep,
    });
  }
  return cards;
}

export interface CostChip {
  readonly resource: ResourceType;
  readonly amount: number;
  readonly have: number; // raw current stock on the pay island; caller floors
  readonly affordable: boolean;
  readonly shortfall: number; // amount − have, 0 when affordable
}

export interface BuildCardView {
  readonly key: string;
  readonly name: string;
  readonly costs: readonly CostChip[];
  readonly affordable: boolean;
  readonly etaSeconds: number | null; // time to afford at current rates; null if unattainable
  readonly feedsGlobal: boolean; // → GLOBAL K suffix (a knowledge-pool build site)
  readonly run: (t: number) => boolean; // the core command; drive via session.command
}

// Seconds until every cost resource is affordable at its pool's current net rate. null
// when any shortfall sits on a pool that isn't filling (rate ≤ 0) — the ETA line is then
// suppressed rather than shown as "never".
function affordabilityEta(
  world: DemoWorld,
  island: IslandId,
  cost: CostEntries,
  t: number,
): number | null {
  const state = world.state;
  let maxEta = 0;
  for (const [resource, amount] of cost) {
    if (amount <= 0) continue;
    const poolId = islandPoolId(world, island, resource);
    if (poolId === undefined) return null;
    const have = warehouseAmountAt(state, poolId, t);
    if (have >= amount) continue;
    const netRate = getWarehouse(state, poolId).netRate;
    if (netRate <= 0) return null;
    maxEta = Math.max(maxEta, (amount - have) / netRate);
  }
  return maxEta;
}

function buildCard(
  world: DemoWorld,
  island: IslandId,
  t: number,
  spec: {
    key: string;
    name: string;
    cost: CostEntries;
    feedsGlobal: boolean;
    run: (t: number) => boolean;
  },
): BuildCardView {
  const state = world.state;
  const costs: CostChip[] = spec.cost.map(([resource, amount]) => {
    const poolId = islandPoolId(world, island, resource);
    const have = poolId === undefined ? 0 : warehouseAmountAt(state, poolId, t);
    return {
      resource,
      amount,
      have,
      affordable: have >= amount,
      shortfall: Math.max(0, amount - have),
    };
  });
  const affordable = canAffordBuild(state, t, island, new Map(spec.cost));
  return {
    key: spec.key,
    name: spec.name,
    costs,
    affordable,
    etaSeconds: affordable ? null : affordabilityEta(world, island, spec.cost, t),
    feedsGlobal: spec.feedsGlobal,
    run: spec.run,
  };
}

// Buildable structures on the island: unbuilt extractors (incl. the global observatory,
// which is paid from here), unbuilt converters sited here, and the next storage rung.
// Skill nodes and research are their own overlays (parchment plan / violet star chart),
// never the dock — hard rule 5.
export function buildCardViews(world: DemoWorld, island: IslandId, t: number): BuildCardView[] {
  const state = world.state;
  const cards: BuildCardView[] = [];

  for (const dep of world.deposits) {
    if (dep.payIslandId !== island) continue;
    if (isExtractorBuilt(world, dep.id)) continue;
    cards.push(
      buildCard(world, island, t, {
        key: `extractor:${dep.id}`,
        name: dep.label,
        cost: dep.cost,
        feedsGlobal: isGlobalScope(getWarehouse(state, dep.warehouseId).islandId),
        run: (tt) => buildExtractor(world, dep.id, tt),
      }),
    );
  }

  for (const site of world.converterSites) {
    if (getWarehouse(state, site.srcWarehouseId).islandId !== island) continue;
    if (isConverterBuilt(world, site.srcWarehouseId, site.dstWarehouseId)) continue;
    cards.push(
      buildCard(world, island, t, {
        key: `converter:${site.srcWarehouseId}:${site.dstWarehouseId}`,
        name: site.label,
        cost: site.cost,
        feedsGlobal: isGlobalScope(getWarehouse(state, site.dstWarehouseId).islandId),
        run: (tt) => buildConverter(world, site, tt),
      }),
    );
  }

  const tier = nextStorageTier(world, island);
  if (tier !== undefined) {
    cards.push(
      buildCard(world, island, t, {
        key: "storage",
        name: `Storage → ${tier.capacity}`,
        cost: tier.cost,
        feedsGlobal: false,
        run: (tt) => upgradeStorage(world, island, tt),
      }),
    );
  }

  return cards;
}

// Harbormaster's-log row (design handoff §1a). One per jammed/starved pool, roots first
// (listJams already orders them). A root IS the bottleneck (rust severity); a symptom
// points at its root by name (amber). `focusPoolId` is always the root — the fix target
// the action deep-links to, even from a downstream symptom row.
export interface JamLogEntry {
  readonly poolId: Id; // the jammed/starved pool this row is about (row key)
  readonly isRoot: boolean;
  readonly full: boolean; // true = pool-full (jam), false = pool-empty (starved)
  readonly subject: string; // pool label
  readonly detail: string; // root reason, or "caused by <root>"
  readonly focusPoolId: Id; // deep-link target (the root pool)
}

export function jamLogEntries(world: DemoWorld): JamLogEntry[] {
  const state = world.state;
  const labelById = new Map(world.warehouses.map((w) => [w.id, w.label] as const));
  return listJams(state).map((entry) => {
    const root = entry.chain.root;
    return {
      poolId: entry.warehouseId,
      isRoot: entry.isRoot,
      full: entry.kind === "pool-full",
      subject: labelById.get(entry.warehouseId) ?? "A pool",
      detail: entry.isRoot
        ? jamRootReason(root.kind)
        : `caused by ${labelById.get(root.warehouseId) ?? "another pool"}`,
      focusPoolId: root.warehouseId,
    };
  });
}
