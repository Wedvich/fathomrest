import {
  addDeposit,
  addWarehouse,
  advance,
  applyExtractionMultiplier,
  applyRefinementMultiplier,
  canAffordBuild,
  buildConverter as buildConverterCmd,
  buildExtractor as buildExtractorCmd,
  clearResearch as clearResearchCmd,
  createSimState,
  deserializeState,
  forEachConverter,
  forEachExtractor,
  forEachResearch,
  forEachWarehouse,
  getDeposit,
  getWarehouse,
  grantResource,
  islandXpAt,
  isIslandRegistered,
  registerIsland,
  InsufficientStockError,
  offlineElapsedSeconds,
  islandId,
  researchConsumedAt,
  researchNodeId,
  resourceType,
  serializeState,
  startResearch as startResearchCmd,
  upgradeIslandCapacity as upgradeIslandCapacityCmd,
  type Id,
  type IslandId,
  type ResearchNodeId,
  type ResourceType,
  type SaveDocument,
  type SimState,
} from "@fathomrest/core";

// Placeholder archipelago scene. Built entirely through the core command surface at
// t=0, so the ticker just advances forward from epoch 0. Pure core calls — no
// React/Pixi here (core stays UI-agnostic).
export interface DemoWorld {
  state: SimState;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly Deposit[];
  converterSites: readonly ConverterSite[];
  // The research tree (static app content; DESIGN.md Progression/Research). Not persisted —
  // reattached from RESEARCH_NODES on create/restore.
  researchNodes: readonly ResearchNode[];
  // The global knowledge pool the active node drains, or undefined when the knowledge tier
  // isn't present yet (a pre-knowledge save whose v2->v3 upgrade step hasn't landed). Research
  // is offered only when defined.
  knowledgePoolId: Id | undefined;
  // Preserved absolute knowledge consumed per INACTIVE node (nodeId -> consumed). The ACTIVE
  // node's live progress lives in core (the Research drain), never here — start/settle move a
  // node between the two, so there is one source of truth at any instant. A node is
  // "researched" once its stored value reaches its cost. Mutated in place by the research
  // commands; persisted as entries.
  researchProgress: Map<ResearchNodeId, number>;
  // Content revision this world is at — WORLD_CONTENT_VERSION after createDemoWorld or a
  // fully-upgraded restore; lower when an upgrade step failed (the version is stamped per
  // successful step, so the next restore retries the failed one); higher when a newer app
  // wrote the loaded save. snapshotWorld stamps this (never a lower constant), so a stale
  // service-worker-pinned bundle can't downgrade a newer save's version and trick it into
  // re-running the newer app's steps.
  contentVersion: number;
  // Skill nodes bought on this world (DESIGN.md: island specialization). App-side bookkeeping
  // for UI + prereq/exclusivity gating; the mechanical effect (the island extraction
  // multiplier) lives in core state. Only buyNode writes it, so the two never drift. The
  // property is reassigned (never mutated in place) on each purchase, keeping it immutable-by
  // -value like the other envelope arrays.
  purchasedNodes: readonly string[];
}

// A deposit and everything the app needs to offer it as a build site: the core deposit id,
// the resource pool an extractor would fill (shared by every deposit of the same resource on
// the island — one pool per (island, resource)), and the build price/rate. This unifies
// "deposit" and "build site" — a deposit IS the thing you build an extractor on. Whether a
// deposit is worked is re-derivable from core state (an extractor wired to it), but the
// deposit->pool pairing and price are not, so they are carried and persisted. `cost` is serializable entries (a Map is built when the
// core command is called) matching what the core buildExtractor cost vector expects.
export interface Deposit {
  readonly id: Id;
  readonly warehouseId: Id;
  readonly label: string;
  readonly resource: ResourceType;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly rate: number;
  // The island whose stockpile funds building this deposit's extractor — the site's island. For a
  // same-island pool this equals getWarehouse(warehouseId).islandId; it differs only when the output
  // pool is global-scoped (a knowledge observatory sits on and is paid from home while filling the
  // global knowledge pool). Always present at runtime; pre-knowledge saves lack it, so
  // restoreWorld backfills it from the pool (SavedDeposit).
  readonly payIslandId: IslandId;
}

// A buildable converter (refinement recipe) and everything the app needs to offer it as a
// build site: the source pool it draws from, the destination pool it fills with the refined
// type, the build price, and the converter's own cap/ratio. Unlike a Deposit, no core id is
// carried — the converter doesn't exist until built; "built" is re-derived by matching a live
// converter's (src, dst) pair (isConverterBuilt), so it survives a save round-trip without a
// flag. That makes the (src, dst) pair the site's identity: at most ONE site per pool pair —
// a second recipe on the same pair would flip "built" for both, so it needs a real site id
// first. Both pools sit on one island (buildConverter is single-island), which is the island
// the cost is charged against. `cost` is serializable entries matching the core cost vector.
export interface ConverterSite {
  readonly srcWarehouseId: Id;
  readonly dstWarehouseId: Id;
  readonly label: string;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly cap: number;
  readonly ratio: number;
}

// Deposit as persisted: payIslandId is absent on pre-knowledge saves (it always equalled the
// pool's island then), so restoreWorld backfills it before the world is built.
export type SavedDeposit = Omit<Deposit, "payIslandId"> & { readonly payIslandId?: IslandId };

// App-level save envelope: the canonical core document plus the UI view model (warehouse
// labels, deposit build-sites, converter build-sites) the core doesn't carry. Persisted as-is
// (persistence.ts). Kept separate from the core SaveDocument so the sim's serialization never
// depends on presentation.
export interface SavedWorld {
  doc: SaveDocument;
  warehouses: readonly { id: Id; label: string }[];
  deposits: readonly SavedDeposit[];
  // Absent on a pre-iron-tier save (contentVersion 1); restoreWorld defaults it to [] before
  // the upgrade step injects the iron refinery.
  converterSites?: readonly ConverterSite[];
  // Preserved consumed per inactive research node (the active node's progress rides in the core
  // doc's research table). Absent on a pre-research save; restoreWorld defaults it to empty.
  researchProgress?: readonly (readonly [ResearchNodeId, number])[];
  // App content revision this envelope was written at. Absent on a pre-versioning save
  // (treated as 1). Bumped whenever a WORLD_UPGRADES step is added, so restoreWorld can
  // raise older saves to current.
  contentVersion?: number;
  // Absent on a pre-skill-tree (contentVersion < 4) save; restoreWorld defaults it to [] before
  // the upgrade step registers the island's XP.
  purchasedNodes?: readonly string[];
}

const EXTRACTOR_RATE = 1; // units/s an extractor produces once built
const WAREHOUSE_CAP = 100;
const STARTING_STOCK = 30; // seeded into each resource's pool at t=0
const BUILD_COST = 20; // paid in the *other* resource
// Iron builds (extractor and refinery) each cost this much wood AND stone. Deliberately above
// STARTING_STOCK: the seeded 30/30 can never fund an iron build, so the wood/stone extractors
// (the only income) must be running first — otherwise building the refinery first would strand
// the bootstrap at 10/10 with zero income (permanent soft-lock).
const IRON_BUILD_COST = 40;

// Demo world resources and its single starting island — module-level so createDemoWorld and
// the iron-tier upgrade step build identical content from one source.
const HOME: IslandId = islandId("home");
const WOOD = resourceType("wood");
const STONE = resourceType("stone");
const IRON_ORE = resourceType("iron-ore");
const IRON_INGOT = resourceType("iron-ingot");
// Iron refinery tuning (placeholder, DESIGN.md vertical slice): draws CONVERTER_CAP iron-ore/s
// and produces CONVERTER_RATIO iron-ingot per iron-ore.
const CONVERTER_CAP = 2;
const CONVERTER_RATIO = 0.5;

const KNOWLEDGE = resourceType("knowledge");
// Knowledge is the first GLOBAL-scoped resource (DESIGN.md Progression/Knowledge): a single
// shared pool with its own cap, not an island pool. It lives on a distinguished GLOBAL scope so
// (a) future islands' observatories all feed one pool and (b) its cap stays out of the island
// storage ladder — upgradeIslandCapacity is per-island; knowledge's cap is research-gated later.
const GLOBAL: IslandId = islandId("global");
const KNOWLEDGE_CAP = 100; // placeholder; raised by research later, never by the storage ladder
// The tier-0 observatory is cost-gated only (wood/stone), above STARTING_STOCK like the iron
// builds so the base economy must already be running (DESIGN.md: the bootstrap into research).
const OBSERVATORY_COST = 40;

// Research drains knowledge continuously at one global base rate (DESIGN.md Progression/Research:
// duration = cost / rate when the pool keeps up). Placeholder tuning; raised later by research
// itself (research/meta unlocks). At 1/s a 60-knowledge node takes 60s fully fed, and stalls to
// the observatory's income when the pool runs dry.
const RESEARCH_DRAIN_RATE = 1;

// One node of the (flat, for now) research tree: an absolute knowledge cost to complete. Part 2
// is the drain MECHANIC only — completing a node marks it researched with no gameplay effect yet;
// the unlock effects (storage gate, queue depth, economy modifiers) land in part 3 (DESIGN.md
// unlock categories). Costs span the knowledge cap so the slice exercises a quick node, a
// mid node, and one that needs the pool near full.
export interface ResearchNode {
  readonly id: ResearchNodeId;
  readonly label: string;
  readonly cost: number;
}

const RESEARCH_NODES: readonly ResearchNode[] = [
  { id: researchNodeId("survey-cache"), label: "Survey Cache", cost: 40 },
  { id: researchNodeId("reinforced-holds"), label: "Reinforced Holds", cost: 60 },
  { id: researchNodeId("tidal-almanac"), label: "Tidal Almanac", cost: 100 },
];

const RESEARCH_NODES_BY_ID: ReadonlyMap<ResearchNodeId, ResearchNode> = new Map(
  RESEARCH_NODES.map((node) => [node.id, node]),
);

// True for the distinguished global scope: its pools sit outside every per-island system —
// the storage ladder today, island XP later. Island-enumerating features must filter through
// this predicate rather than re-deriving the exclusion.
export function isGlobalScope(island: IslandId): boolean {
  return island === GLOBAL;
}

// ── Island skill tree (DESIGN.md: island specialization) ──────────────────────────────────
// App-authored node content over the core IslandProgress primitive (throughput-fed XP
// accumulator + extraction/refinement multipliers). A shared TRUNK of instant, level- and
// cost-gated nodes whose effect is an island extraction multiplier ("nodes are the multiplier",
// DESIGN.md), then an EXCLUSIVE junction into an Extraction or a Refinement branch: the junction
// nodes gate on a completed research node (researchRequired) AND on branch exclusivity — buying
// into one branch locks the other for good (nodeUnlocked). Gating stays one-way research -> island.
// A node's branch also selects its effect: extraction/trunk scale the island's extraction
// multiplier, refinement scales its refinement (converter-yield) multiplier (buyNode).
export interface SkillNode {
  readonly id: string;
  readonly island: IslandId;
  readonly branch: "trunk" | "extraction" | "refinement";
  readonly label: string;
  // Minimum island level (from XP) before the node may be bought; stockpiles gate whether it's
  // affordable now (DESIGN.md: levels gate WHEN, cost gates WHETHER).
  readonly levelRequired: number;
  readonly cost: readonly (readonly [ResourceType, number])[];
  readonly prerequisites: readonly string[];
  // Factor multiplied into the island's extraction (trunk/extraction) or refinement (refinement)
  // multiplier on purchase, per branch.
  readonly effectFactor: number;
  // Junction nodes stay locked until this research node is completed (one-way research -> island).
  readonly researchRequired?: ResearchNodeId;
}

// XP required to REACH each level (index 0 = level 1 at 0 XP). islandLevel counts thresholds at
// or below the XP, so it returns 1..THRESHOLDS.length. Placeholder tuning (DESIGN.md slice).
const XP_LEVEL_THRESHOLDS: readonly number[] = [0, 20, 60, 140, 260, 440, 680, 1000];

export function islandLevel(xp: number): number {
  let level = 0;
  for (const threshold of XP_LEVEL_THRESHOLDS) {
    if (xp < threshold) break;
    level += 1;
  }
  return level;
}

// XP floor of `level` (the threshold at which it begins); 0 at level 1.
export function islandLevelFloorXp(level: number): number {
  return XP_LEVEL_THRESHOLDS[level - 1] ?? 0;
}

// XP at which `level` ends (the next level's threshold), or undefined at max level.
export function islandLevelCeilXp(level: number): number | undefined {
  return XP_LEVEL_THRESHOLDS[level];
}

// Trunk costs stay <= the base warehouse cap (100) so the trunk is buyable without a storage
// upgrade, and above STARTING_STOCK (30) so the base economy must be running. Branch-depth
// costs deliberately climb the storage ladder (120+ needs tier 1, 300 needs tier 2) — node
// costs coupled to storage progression is accepted in DESIGN.md. Refinement rungs are paid
// partly in iron (the branch's own output funds its upgrades); their iron components stay under
// the base cap, but their wood/stone components still gate on a storage upgrade like extraction.
// A content test asserts every cost fits under the top storage tier, so none is unbuyable-forever.
const HOME_SKILL_TREE: readonly SkillNode[] = [
  {
    id: "home-efficient-tools",
    island: HOME,
    branch: "trunk",
    label: "Efficient Tools",
    levelRequired: 2,
    cost: [
      [WOOD, 40],
      [STONE, 40],
    ],
    prerequisites: [],
    effectFactor: 1.15,
  },
  {
    id: "home-sharper-edges",
    island: HOME,
    branch: "trunk",
    label: "Sharper Edges",
    levelRequired: 3,
    cost: [
      [WOOD, 60],
      [STONE, 60],
    ],
    prerequisites: ["home-efficient-tools"],
    effectFactor: 1.15,
  },
  {
    id: "home-quarry-discipline",
    island: HOME,
    branch: "trunk",
    label: "Quarry Discipline",
    levelRequired: 4,
    cost: [
      [WOOD, 80],
      [STONE, 80],
    ],
    prerequisites: ["home-sharper-edges"],
    effectFactor: 1.2,
  },
  {
    id: "home-extraction-mastery",
    island: HOME,
    branch: "extraction",
    label: "Extraction Mastery",
    levelRequired: 5,
    cost: [
      [WOOD, 90],
      [STONE, 90],
    ],
    prerequisites: ["home-quarry-discipline"],
    effectFactor: 1.3,
    researchRequired: researchNodeId("tidal-almanac"),
  },
  {
    id: "home-refinement-mastery",
    island: HOME,
    branch: "refinement",
    label: "Refinement Mastery",
    levelRequired: 5,
    cost: [
      [WOOD, 90],
      [STONE, 90],
    ],
    prerequisites: ["home-quarry-discipline"],
    effectFactor: 1.1,
    researchRequired: researchNodeId("tidal-almanac"),
  },
  // Extraction branch depth: throughput multipliers past the junction (the deposit-longevity
  // sub-path waits for a longevity effect type). Linear chain, one node per level rung.
  {
    id: "home-deep-veins",
    island: HOME,
    branch: "extraction",
    label: "Deep Veins",
    levelRequired: 6,
    cost: [
      [WOOD, 120],
      [STONE, 120],
    ],
    prerequisites: ["home-extraction-mastery"],
    effectFactor: 1.2,
  },
  {
    id: "home-cliffside-hoists",
    island: HOME,
    branch: "extraction",
    label: "Cliffside Hoists",
    levelRequired: 7,
    cost: [
      [WOOD, 180],
      [STONE, 180],
    ],
    prerequisites: ["home-deep-veins"],
    effectFactor: 1.2,
  },
  {
    id: "home-tide-driven-dredgers",
    island: HOME,
    branch: "extraction",
    label: "Tide-Driven Dredgers",
    levelRequired: 8,
    cost: [
      [WOOD, 300],
      [STONE, 300],
    ],
    prerequisites: ["home-cliffside-hoists"],
    effectFactor: 1.25,
  },
  // Refinement branch depth: converter-yield multipliers. Their product must keep the effective
  // converter yield below 1 ingot per ore, so refinement never mints mass — enforced behaviorally
  // by the "never mints mass" scenario test (feed < draw), not by an arithmetic comment that rots.
  {
    id: "home-hotter-furnaces",
    island: HOME,
    branch: "refinement",
    label: "Hotter Furnaces",
    levelRequired: 6,
    cost: [
      [STONE, 120],
      [IRON_ORE, 40],
    ],
    prerequisites: ["home-refinement-mastery"],
    effectFactor: 1.1,
  },
  {
    id: "home-bellows-crews",
    island: HOME,
    branch: "refinement",
    label: "Bellows Crews",
    levelRequired: 7,
    cost: [
      [WOOD, 180],
      [IRON_INGOT, 60],
    ],
    prerequisites: ["home-hotter-furnaces"],
    effectFactor: 1.15,
  },
  {
    id: "home-master-smelters",
    island: HOME,
    branch: "refinement",
    label: "Master Smelters",
    levelRequired: 8,
    cost: [
      [IRON_ORE, 90],
      [IRON_INGOT, 90],
    ],
    prerequisites: ["home-bellows-crews"],
    effectFactor: 1.2,
  },
];

const SKILL_NODES: ReadonlyMap<string, SkillNode> = new Map(
  HOME_SKILL_TREE.map((node) => [node.id, node]),
);

// Per-node cost maps, prebuilt once. canBuyNode is polled every frame by the skill-node buttons,
// so it must not allocate on the frame loop (perf doc) — it reads these instead of rebuilding a
// Map from node.cost each call.
const SKILL_NODE_COSTS: ReadonlyMap<string, ReadonlyMap<ResourceType, number>> = new Map(
  HOME_SKILL_TREE.map((node) => [node.id, new Map(node.cost)]),
);

// The global knowledge pool an active research node drains, derived from core state (the KNOWLEDGE
// warehouse on the GLOBAL scope). undefined when the knowledge tier isn't present yet (a save whose
// v2->v3 upgrade step hasn't landed), which hides the research UI rather than crashing it.
function findKnowledgePool(state: SimState): Id | undefined {
  let found: Id | undefined;
  forEachWarehouse(state, (id, warehouse) => {
    if (warehouse.resource === KNOWLEDGE && isGlobalScope(warehouse.islandId)) found = id;
  });
  return found;
}

// One rung of the storage-upgrade ladder: raise a pool's capacity to `capacity` for `cost`.
export interface StorageTier {
  readonly capacity: number;
  readonly cost: readonly (readonly [ResourceType, number])[];
}

// The island-warehouse upgrade ladder (placeholder tuning, DESIGN.md vertical slice): each rung
// raises every pool on an island to `capacity` from the WAREHOUSE_CAP base, paid in wood/stone
// like every other build. Storage is island-level, so one rung lifts all the island's caps
// together (including the wood/stone cost pools). The current rung isn't stored — it's derived
// from the island's live pool caps (core is source of truth, like isExtractorBuilt), so it
// round-trips without a persisted index; the next offered rung is the first above what the
// island holds now. Each rung's cost stays under the previous rung's cap so it's reachable once
// the one before it is bought (DESIGN.md: build costs coupled to storage progression).
const STORAGE_TIERS: readonly StorageTier[] = [
  {
    capacity: 250,
    cost: [
      [WOOD, 40],
      [STONE, 40],
    ],
  },
  {
    capacity: 500,
    cost: [
      [WOOD, 150],
      [STONE, 150],
    ],
  },
  {
    capacity: 1000,
    cost: [
      [WOOD, 350],
      [STONE, 350],
    ],
  },
];

// The rich vein every demo deposit shares: a 500-unit tier at ×2 depleting to a 0.5 perpetual
// floor (mirrors the earlier placeholder).
function addDemoDeposit(
  state: SimState,
  t: number,
  resource: ResourceType,
  warehouseId: Id,
  label: string,
  cost: readonly (readonly [ResourceType, number])[],
  payIslandId: IslandId,
): Deposit {
  const id = addDeposit(state, t, resource, [{ amount: 500, multiplier: 2 }], 0.5);
  return { id, warehouseId, label, resource, cost, rate: EXTRACTOR_RATE, payIslandId };
}

// The cap a NEW pool takes when a content step lands it on an existing island: the island's
// current storage rung (min cap across its pools, matching nextStorageTier's derivation). A
// content tier added to an already-upgraded save then arrives at the island's rung instead of
// resetting the ladder to rung 1 and re-charging rungs the player already bought. Base cap on an
// island with no pools yet (fresh world).
function islandStorageCap(state: SimState, island: IslandId): number {
  let cap = Infinity;
  forEachWarehouse(state, (_id, warehouse) => {
    if (warehouse.islandId === island) cap = Math.min(cap, warehouse.capacity);
  });
  return cap === Infinity ? WAREHOUSE_CAP : cap;
}

// The iron refinement tier layered on the wood/stone base: an iron-ore pool worked by two
// cost-gated deposits, an iron-ingot pool, and a refinery converter site (iron-ore -> iron-ingot,
// paid in wood/stone). Built at epoch t through the core surface and returned as envelope view
// models. Shared by createDemoWorld (t=0) and the v1->v2 upgrade step, so a fresh world and an
// upgraded save get identical iron content.
function addIronTier(
  state: SimState,
  t: number,
): {
  warehouses: { id: Id; label: string }[];
  deposits: Deposit[];
  converterSites: ConverterSite[];
} {
  const poolCap = islandStorageCap(state, HOME);
  const ironOrePool = addWarehouse(state, t, IRON_ORE, HOME, poolCap);
  const ironIngotPool = addWarehouse(state, t, IRON_INGOT, HOME, poolCap);
  // Iron-ore extractors and the refinery are both paid in wood/stone (IRON_BUILD_COST each,
  // above the seeded stock), gating the tier behind a base-economy surplus.
  const ironCost: readonly (readonly [ResourceType, number])[] = [
    [WOOD, IRON_BUILD_COST],
    [STONE, IRON_BUILD_COST],
  ];
  return {
    warehouses: [
      { id: ironOrePool, label: "Iron Ore" },
      { id: ironIngotPool, label: "Iron Ingot" },
    ],
    deposits: [
      addDemoDeposit(state, t, IRON_ORE, ironOrePool, "Iron Ore A vein", ironCost, HOME),
      addDemoDeposit(state, t, IRON_ORE, ironOrePool, "Iron Ore B vein", ironCost, HOME),
    ],
    converterSites: [
      {
        srcWarehouseId: ironOrePool,
        dstWarehouseId: ironIngotPool,
        label: "Iron Refinery",
        cost: ironCost,
        cap: CONVERTER_CAP,
        ratio: CONVERTER_RATIO,
      },
    ],
  };
}

// The knowledge tier layered on the wood/stone base (DESIGN.md Progression): a global-scoped
// knowledge pool worked by a cost-gated observatory on the home island. Built through the core
// surface at epoch t; shared by createDemoWorld (t=0) and the v2->v3 upgrade step so a fresh world
// and an upgraded save get identical knowledge content. No converterSites — knowledge is extracted,
// not refined (goods->knowledge labs are a later addition).
function addKnowledgeTier(
  state: SimState,
  t: number,
): {
  warehouses: { id: Id; label: string }[];
  deposits: Deposit[];
} {
  // The pool sits on GLOBAL with its own cap (not islandStorageCap): global scope is outside the
  // island storage ladder, so it never seeds from or advances an island's rung.
  const knowledgePool = addWarehouse(state, t, KNOWLEDGE, GLOBAL, KNOWLEDGE_CAP);
  const observatoryCost: readonly (readonly [ResourceType, number])[] = [
    [WOOD, OBSERVATORY_COST],
    [STONE, OBSERVATORY_COST],
  ];
  // Site island is HOME (where the observatory is built and paid); the output pool is GLOBAL.
  return {
    warehouses: [{ id: knowledgePool, label: "Knowledge" }],
    deposits: [
      addDemoDeposit(
        state,
        t,
        KNOWLEDGE,
        knowledgePool,
        "Knowledge deposit",
        observatoryCost,
        HOME,
      ),
    ],
  };
}

export function createDemoWorld(seed: number, wallTimeMs: number): DemoWorld {
  const state = createSimState(seed, wallTimeMs);

  // Cross-dependency: a wood extractor is paid in stone and vice versa, so the first builds
  // spend the starting stockpile and later ones must wait for the extractors already running
  // to replenish it. All numbers here are placeholder tuning (DESIGN.md vertical slice).
  const woodCost: readonly (readonly [ResourceType, number])[] = [[STONE, BUILD_COST]];
  const stoneCost: readonly (readonly [ResourceType, number])[] = [[WOOD, BUILD_COST]];

  // One pool per (island, resource) — a single Wood pool and a single Stone pool (core
  // invariant, sim.ts addWarehouse). Every extractor of a resource feeds its one pool, so two
  // wood veins make the Wood bar fill twice as fast rather than filling two separate bars.
  const woodPool = addWarehouse(state, 0, WOOD, HOME, WAREHOUSE_CAP);
  const stonePool = addWarehouse(state, 0, STONE, HOME, WAREHOUSE_CAP);

  // Two deposits per resource, all unworked (no extractor), each feeding its resource's shared
  // pool. Building the first of each is affordable from the starting stockpile; the others gate
  // behind accumulation.
  const woodA = addDemoDeposit(state, 0, WOOD, woodPool, "Wood A vein", woodCost, HOME);
  const woodB = addDemoDeposit(state, 0, WOOD, woodPool, "Wood B vein", woodCost, HOME);
  const stoneA = addDemoDeposit(state, 0, STONE, stonePool, "Stone A vein", stoneCost, HOME);
  const stoneB = addDemoDeposit(state, 0, STONE, stonePool, "Stone B vein", stoneCost, HOME);

  // Starting stockpile: enough to build one wood + one stone extractor (BUILD_COST each),
  // leaving a remainder the next builds must wait for the new extractors to top back up.
  grantResource(state, 0, woodPool, STARTING_STOCK);
  grantResource(state, 0, stonePool, STARTING_STOCK);

  const iron = addIronTier(state, 0);
  const knowledge = addKnowledgeTier(state, 0);

  // Register HOME's progression so it accrues XP and can carry skill nodes. GLOBAL (knowledge)
  // is deliberately never registered — it stays outside every per-island system.
  registerIsland(state, 0, HOME);

  return {
    state,
    warehouses: [
      { id: woodPool, label: "Wood" },
      { id: stonePool, label: "Stone" },
      ...iron.warehouses,
      ...knowledge.warehouses,
    ],
    deposits: [woodA, woodB, stoneA, stoneB, ...iron.deposits, ...knowledge.deposits],
    converterSites: iron.converterSites,
    purchasedNodes: [],
    researchNodes: RESEARCH_NODES,
    knowledgePoolId: findKnowledgePool(state),
    researchProgress: new Map(),
    contentVersion: WORLD_CONTENT_VERSION,
  };
}

// Content upgrades: each step raises a restored world from content version index+1 to
// index+2 using core commands at the current epoch, and appends any new envelope view models
// the core doesn't carry. restoreWorld gates them by contentVersion. WORLD_CONTENT_VERSION is
// derived from the list — adding a step bumps the version by construction, and createDemoWorld
// builds at the current version already.
const WORLD_UPGRADES: readonly ((world: DemoWorld, t: number) => DemoWorld)[] = [
  // v1 -> v2: layer the iron refinement tier onto a pre-iron wood/stone save. Injected through
  // the same core commands createDemoWorld uses, at the restore-time epoch, so the new pools and
  // deposits never retroactively produce across the offline gap.
  (world, t): DemoWorld => {
    const iron = addIronTier(world.state, t);
    return {
      ...world,
      warehouses: [...world.warehouses, ...iron.warehouses],
      deposits: [...world.deposits, ...iron.deposits],
      converterSites: [...world.converterSites, ...iron.converterSites],
    };
  },
  // v2 -> v3: layer the global knowledge tier onto a wood/stone+iron save. Same core commands as
  // createDemoWorld, at the restore-time epoch, so the pool and deposit never retroactively produce
  // across the offline gap.
  (world, t): DemoWorld => {
    const knowledge = addKnowledgeTier(world.state, t);
    return {
      ...world,
      warehouses: [...world.warehouses, ...knowledge.warehouses],
      deposits: [...world.deposits, ...knowledge.deposits],
    };
  },
  // v3 -> v4: register HOME's island progression on a wood/stone+iron+knowledge save, so it
  // starts accruing XP at the restore-time epoch (no retroactive XP across the offline gap).
  // Adds no envelope view models — the skill tree is content-constant (HOME_SKILL_TREE).
  (world, t): DemoWorld => {
    // Idempotent: a v3 doc predates island XP, so it normally carries no HOME progression — but
    // guard on the core state rather than assume, so a save whose envelope/doc versions ever
    // drift can't make registerIsland throw "already registered" and brick the restore.
    if (!isIslandRegistered(world.state, HOME)) registerIsland(world.state, t, HOME);
    return world;
  },
];
export const WORLD_CONTENT_VERSION = WORLD_UPGRADES.length + 1;

export function snapshotWorld(world: DemoWorld): SavedWorld {
  return {
    doc: serializeState(world.state),
    warehouses: world.warehouses,
    deposits: world.deposits,
    converterSites: world.converterSites,
    purchasedNodes: world.purchasedNodes,
    // Inactive-node progress; the active node rides in doc's research table.
    researchProgress: [...world.researchProgress],
    contentVersion: world.contentVersion,
  };
}

// Whether an extractor has already been built on this deposit — the source of truth is core
// state (a producer wired to the deposit), so it survives a save round-trip without a flag.
export function isExtractorBuilt(world: DemoWorld, depositId: Id): boolean {
  let built = false;
  forEachExtractor(world.state, (_id, extractor) => {
    if (extractor.depositId === depositId) built = true;
  });
  return built;
}

// Whether the refinery on this (src, dst) pool pair has already been built — source of truth is
// a live converter in core state, so it survives a save round-trip without a flag.
export function isConverterBuilt(world: DemoWorld, srcId: Id, dstId: Id): boolean {
  let built = false;
  forEachConverter(world.state, (_id, converter) => {
    if (converter.srcId === srcId && converter.dstId === dstId) built = true;
  });
  return built;
}

// Build an extractor on a deposit at sim time t, paying its cost from the island's stock (core
// buildExtractor advances to t, debits, then wires the producer, so income begins exactly at t).
// Idempotent per deposit; returns false if already built, unknown, or the cost can't be met yet
// (the UI disables the button until canAffordBuild — this is the backstop).
export function buildExtractor(world: DemoWorld, depositId: Id, t: number): boolean {
  const deposit = world.deposits.find((d) => d.id === depositId);
  if (deposit === undefined || isExtractorBuilt(world, depositId)) return false;
  try {
    buildExtractorCmd(
      world.state,
      t,
      new Map(deposit.cost),
      deposit.rate,
      deposit.id,
      deposit.warehouseId,
      deposit.payIslandId,
    );
    return true;
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
}

// Build the refinery converter for a site at sim time t, paying its cost from the island's stock
// (core buildConverter advances to t, debits, then wires the converter, so refining begins at t).
// Idempotent per (src, dst) pair; returns false if already built or the cost can't be met yet
// (the UI disables the button until canAffordBuild — this is the backstop).
export function buildConverter(world: DemoWorld, site: ConverterSite, t: number): boolean {
  if (isConverterBuilt(world, site.srcWarehouseId, site.dstWarehouseId)) return false;
  try {
    buildConverterCmd(
      world.state,
      t,
      new Map(site.cost),
      site.srcWarehouseId,
      site.dstWarehouseId,
      site.cap,
      site.ratio,
    );
    return true;
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
}

// The distinct islands present in the world, derived from the pools (core is source of truth).
// One island = one upgradable warehouse (storage is island-level, not per resource pool).
export function worldIslands(world: DemoWorld): readonly IslandId[] {
  const seen = new Set<IslandId>();
  for (const wh of world.warehouses) {
    // The GLOBAL scope (knowledge) has no island storage ladder — its cap is research-gated, not
    // raised by upgradeIslandCapacity — so it never yields a storage-upgrade button.
    const island = getWarehouse(world.state, wh.id).islandId;
    if (!isGlobalScope(island)) seen.add(island);
  }
  return [...seen];
}

// The next storage upgrade an island can buy, or undefined at max tier. Derived from the island's
// live pool caps (core is source of truth), so it survives a round-trip without a persisted index:
// the first ladder rung above the island's smallest pool cap (min, so a lagging pool — e.g. one a
// later content tier added at the base cap — is pulled up before the ladder advances).
export function nextStorageTier(world: DemoWorld, island: IslandId): StorageTier | undefined {
  let currentCap = Infinity;
  // Called per frame from the storage-button update — indexed loops, no closures
  // (browser-performance.md: the frame loop must not allocate).
  for (let i = 0; i < world.warehouses.length; i++) {
    const wh = world.warehouses[i];
    if (wh === undefined) continue;
    const warehouse = getWarehouse(world.state, wh.id);
    if (warehouse.islandId === island) currentCap = Math.min(currentCap, warehouse.capacity);
  }
  if (currentCap === Infinity) return undefined; // no pools on this island
  for (let i = 0; i < STORAGE_TIERS.length; i++) {
    const tier = STORAGE_TIERS[i];
    if (tier !== undefined && tier.capacity > currentCap) return tier;
  }
  return undefined;
}

// Upgrade an island's storage to its next tier at sim time t, paying the tier cost from that
// island (core upgradeIslandCapacity advances to t, debits once, then raises every island pool's
// cap in one command). Returns false if already at max tier or the cost can't be met yet (the UI
// disables the button until canAffordBuild — this is the backstop).
export function upgradeStorage(world: DemoWorld, island: IslandId, t: number): boolean {
  const tier = nextStorageTier(world, island);
  if (tier === undefined) return false;
  try {
    upgradeIslandCapacityCmd(world.state, t, new Map(tier.cost), island, tier.capacity);
    return true;
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
}

// The skill nodes offered for a world (its registered islands). All demo nodes sit on HOME.
export function worldSkillNodes(world: DemoWorld): readonly SkillNode[] {
  const islands = new Set(worldIslands(world));
  return HOME_SKILL_TREE.filter((node) => islands.has(node.island));
}

// A view of an island's XP for the readout: current XP, level, and the [current, next) level
// thresholds (nextLevelXp is undefined at max level).
export interface IslandXpView {
  readonly xp: number;
  readonly level: number;
  readonly currentLevelXp: number;
  readonly nextLevelXp: number | undefined;
}

export function islandXpView(world: DemoWorld, island: IslandId, t: number): IslandXpView {
  const xp = islandXpAt(world.state, island, t);
  const level = islandLevel(xp);
  return {
    xp,
    level,
    currentLevelXp: islandLevelFloorXp(level),
    nextLevelXp: islandLevelCeilXp(level),
  };
}

// Whether the node's branch is locked out because the player has already committed to the OPPOSITE
// specialization branch ON THIS ISLAND (the exclusive junction is per-island — it locks an
// island's identity, DESIGN.md; a choice on one island never gates another). Trunk nodes belong to
// no branch and are never branch-locked. Exposed for the UI's lock-reason label.
export function isNodeBranchLocked(world: DemoWorld, node: SkillNode): boolean {
  if (node.branch === "trunk") return false;
  const opposite = node.branch === "extraction" ? "refinement" : "extraction";
  return world.purchasedNodes.some((id) => {
    const owned = SKILL_NODES.get(id);
    return owned?.island === node.island && owned.branch === opposite;
  });
}

// Whether the node is still gated by an unfinished research prerequisite (one-way research ->
// island). Nodes with no researchRequired are never research-locked; an unknown id reads locked
// (defensive — a miswired gate must not silently open). Exposed for the UI's lock-reason label.
export function isNodeResearchLocked(world: DemoWorld, node: SkillNode): boolean {
  if (node.researchRequired === undefined) return false;
  const research = RESEARCH_NODES_BY_ID.get(node.researchRequired);
  return research === undefined || !isResearched(world, research);
}

// Whether the node's cost can never be met at the island's CURRENT storage cap — a storage upgrade,
// not more accumulation, is the fix. Branch-depth costs deliberately exceed the base cap, so this
// is a distinct lock reason the base economy alone can't clear (before branch depth every node fit
// under the base cap). Independent of level/research/branch gates; exposed for the UI's lock-reason
// label so an eligible-but-over-cap node reads "needs storage" rather than a silent grey button.
export function nodeNeedsStorage(world: DemoWorld, node: SkillNode): boolean {
  const cap = islandStorageCap(world.state, node.island);
  return node.cost.some(([, amount]) => amount > cap);
}

// Shared purchasability guard (the non-cost half): research gate, branch exclusivity, known island
// level, prerequisites, ownership. buyNode and canBuyNode share it so their rules can't drift.
function nodeUnlocked(world: DemoWorld, node: SkillNode, t: number): boolean {
  if (isNodeResearchLocked(world, node)) return false;
  if (isNodeBranchLocked(world, node)) return false;
  if (world.purchasedNodes.includes(node.id)) return false;
  for (const prereq of node.prerequisites) {
    if (!world.purchasedNodes.includes(prereq)) return false;
  }
  return islandLevel(islandXpAt(world.state, node.island, t)) >= node.levelRequired;
}

// Whether a node can be bought right now (unlocked + affordable). Mirrors buyNode's guard so a
// button reporting "buyable" can't be refused, except a race the save-on-command absorbs.
export function canBuyNode(world: DemoWorld, nodeId: string, t: number): boolean {
  const node = SKILL_NODES.get(nodeId);
  const cost = SKILL_NODE_COSTS.get(nodeId);
  if (node === undefined || cost === undefined || !nodeUnlocked(world, node, t)) return false;
  return canAffordBuild(world.state, t, node.island, cost);
}

// Buy a skill node at sim time t: apply its branch effect (core: atomic debit + effect) and record
// it owned — extraction/trunk scale the island's extraction multiplier, refinement its refinement
// (converter-yield) multiplier. Idempotent per node; returns false if it can't be bought yet
// (gated, unaffordable, ...) — the UI disables the button until canBuyNode, this is the backstop.
export function buyNode(world: DemoWorld, nodeId: string, t: number): boolean {
  const node = SKILL_NODES.get(nodeId);
  const cost = SKILL_NODE_COSTS.get(nodeId);
  if (node === undefined || cost === undefined || !nodeUnlocked(world, node, t)) return false;
  const applyEffect =
    node.branch === "refinement" ? applyRefinementMultiplier : applyExtractionMultiplier;
  try {
    applyEffect(world.state, t, cost, node.island, node.effectFactor);
  } catch (error) {
    if (error instanceof InsufficientStockError) return false; // retry once stock accrues
    throw error; // wiring/content bug — never mistake it for "can't afford yet"
  }
  world.purchasedNodes = [...world.purchasedNodes, nodeId];
  return true;
}

// Rebuild a world from a save, folding the wall-clock gap since save into sim time
// (offline catch-up, ADR-0001 §4). The saved (epoch, wallTime) pair stays a valid anchor
// afterward — the next save re-stamps wallTime — so wallTime is left as-is here.
export function restoreWorld(saved: SavedWorld, nowMs: number): DemoWorld {
  // One-time reset: legacy ore/ingot envelopes carried a singular `buildSite`; the wood/stone
  // envelope never does, so its presence marks a pre-pivot save. Throw so the caller quarantines
  // it and boots a fresh world — a blessed exception to the no-reset rule, since the discarded
  // content was pre-release placeholder (DESIGN.md).
  if ("buildSite" in saved) {
    throw new Error("legacy ore/ingot save format; discarding for the wood/stone world");
  }
  // contentVersion crosses an untrusted boundary (IndexedDB today, export/import later).
  // A malformed value must fail loud into the caller's quarantine path — a negative
  // number would otherwise walk the whole numeric range, a fractional one silently skip
  // steps and then get stamped current, losing the content forever.
  const savedVersion = saved.contentVersion ?? 1; // absent: save predates versioning
  if (!Number.isSafeInteger(savedVersion) || savedVersion < 1) {
    throw new Error(`invalid save contentVersion: ${String(saved.contentVersion)}`);
  }
  const state = deserializeState(saved.doc);
  // The envelope's view models cross the same untrusted boundary: every core id they carry
  // must resolve in the deserialized state, or we fail loud into the caller's quarantine path
  // now — a dangling id would otherwise crash the readout on every reload with the bad save
  // still in place.
  const islands = new Set<IslandId>();
  forEachWarehouse(state, (_id, warehouse) => islands.add(warehouse.islandId));
  const deposits: Deposit[] = saved.deposits.map((deposit) => {
    getDeposit(state, deposit.id);
    const pool = getWarehouse(state, deposit.warehouseId);
    // A carried payIslandId must name an island the doc holds — a bogus one would not crash,
    // just leave the build forever "unaffordable" (silent soft-lock), so fail loud here instead.
    if (deposit.payIslandId !== undefined && !islands.has(deposit.payIslandId)) {
      throw new Error(`no island ${deposit.payIslandId} for deposit ${deposit.id}`);
    }
    // Backfill for pre-knowledge saves: payIslandId always equalled the pool's island then.
    return { ...deposit, payIslandId: deposit.payIslandId ?? pool.islandId };
  });
  for (const site of saved.converterSites ?? []) {
    getWarehouse(state, site.srcWarehouseId);
    getWarehouse(state, site.dstWarehouseId);
  }
  // Restore owned skill nodes, filtered to nodes this build knows. Dropping an unknown id (a
  // save from a newer app on a stale bundle) is safe and non-destructive: the mechanical effect
  // lives in core state (islandProgress.extractionMultiplier), so the id list is only UI/gating
  // bookkeeping. Failing loud here would quarantine an otherwise-valid newer save.
  const rawNodes: readonly unknown[] = Array.isArray(saved.purchasedNodes)
    ? saved.purchasedNodes
    : [];
  const purchasedNodes: string[] = [];
  for (const nodeId of rawNodes) {
    if (typeof nodeId === "string" && SKILL_NODES.has(nodeId)) purchasedNodes.push(nodeId);
    else console.warn(`Dropping unknown skill node ${String(nodeId)} from restored save.`);
  }
  advance(state, state.epoch + offlineElapsedSeconds(nowMs, state.wallTime));
  let world: DemoWorld = {
    state,
    warehouses: saved.warehouses,
    deposits,
    converterSites: saved.converterSites ?? [], // absent on a pre-iron-tier (v1) save
    purchasedNodes,
    researchNodes: RESEARCH_NODES,
    knowledgePoolId: undefined, // re-derived after upgrades (the v2->v3 step may add the pool)
    researchProgress: reconstructResearchProgress(state, saved.researchProgress),
    contentVersion: savedVersion,
  };
  // Content upgrades run after offline catch-up (design decision 3): new structures are
  // wired at the restore-time epoch via commands, so they never retroactively produce
  // across the offline gap. A save at (or past) the current version runs no steps, so a
  // newer app's save keeps its higher version — re-saving on this stale bundle never
  // downgrades it into re-running the newer app's steps later. The version is stamped per
  // SUCCESSFUL step: a failing step logs, keeps the version where it was, and skips the
  // remaining steps (they assume its content), so the next restore retries — a content gap
  // is recoverable, quarantining (= resetting) a working save is not.
  const steps = WORLD_UPGRADES.slice(savedVersion - 1);
  for (const [index, step] of steps.entries()) {
    try {
      world = { ...step(world, world.state.epoch), contentVersion: savedVersion + index + 1 };
    } catch (error) {
      console.warn("World content upgrade step failed; retrying on the next restore.", error);
      break;
    }
  }
  // Derive the knowledge pool now that any v2->v3 upgrade has landed, and drop an active drain
  // whose node this app no longer defines (removed content) so its slot frees instead of
  // wedging the UI on an unknown node.
  const finalized: DemoWorld = { ...world, knowledgePoolId: findKnowledgePool(world.state) };
  dropUnknownActiveResearch(finalized);
  return finalized;
}

// Rebuild the inactive-node progress map from a save, dropping what can't be trusted rather than
// quarantining the whole save (progress is additive app state — losing one node's progress beats
// resetting a working world). Skips entries for nodes this app no longer defines and the currently
// ACTIVE node (its live progress rides in core, the single source of truth), and clamps each value
// into [0, cost] so a lowered-cost rebalance reads as researched instead of stranding progress.
function reconstructResearchProgress(
  state: SimState,
  saved: readonly (readonly [ResearchNodeId, number])[] | undefined,
): Map<ResearchNodeId, number> {
  const progress = new Map<ResearchNodeId, number>();
  if (saved === undefined) return progress;
  const activeNodeId = activeResearchEntry(state)?.nodeId;
  for (const entry of saved) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [nodeId, consumed] = entry;
    const node = RESEARCH_NODES.find((n) => n.id === nodeId);
    if (node === undefined || nodeId === activeNodeId) continue;
    if (typeof consumed !== "number" || !Number.isFinite(consumed)) continue;
    progress.set(node.id, Math.min(node.cost, Math.max(0, consumed)));
  }
  return progress;
}

// Clear an active core drain whose node this app no longer defines (content removed since the
// save). The consumed knowledge is forfeit — acceptable for deleted content — and the slot frees.
function dropUnknownActiveResearch(world: DemoWorld): void {
  forEachResearch(world.state, (id, research) => {
    if (!RESEARCH_NODES.some((n) => n.id === research.nodeId)) {
      clearResearchCmd(world.state, world.state.epoch, id);
    }
  });
}

// The single active drain, as {core id, node tag}, or undefined — the one place the core research
// table (≤1 entry, single slot) is read into app terms. Everything else routes through this so
// "which node is active" has one definition.
function activeResearchEntry(state: SimState): { id: Id; nodeId: ResearchNodeId } | undefined {
  let entry: { id: Id; nodeId: ResearchNodeId } | undefined;
  forEachResearch(state, (id, research) => {
    entry = { id, nodeId: research.nodeId };
  });
  return entry;
}

// Whether this node is the one currently draining the pool.
export function isResearchActive(world: DemoWorld, node: ResearchNode): boolean {
  return activeResearchEntry(world.state)?.nodeId === node.id;
}

// Whether this node is finished — its preserved consumed has reached cost. The active node reads
// as researched only once collected (collectCompletedResearch moves it into the progress map at
// cost), so a node mid-drain is never "researched" here.
export function isResearched(world: DemoWorld, node: ResearchNode): boolean {
  return (world.researchProgress.get(node.id) ?? 0) >= node.cost;
}

// Absolute knowledge a node has consumed at t GIVEN the already-resolved active drain (its core id
// and node tag, or null when nothing is active): the live core value while this node is the active
// drain, otherwise its preserved progress (0 if untouched). The single definition of that rule —
// both the public researchConsumed and PixiReadout's per-frame reader route through it, so the two
// can't drift. Takes the active handle as primitives, so the frame loop passes its hoisted
// once-per-frame scan without allocating (perf doc).
export function researchConsumedGiven(
  world: DemoWorld,
  node: ResearchNode,
  activeId: Id | null,
  activeNodeId: ResearchNodeId | null,
  t: number,
): number {
  if (activeNodeId === node.id && activeId !== null) {
    return researchConsumedAt(world.state, activeId, t);
  }
  return world.researchProgress.get(node.id) ?? 0;
}

// Absolute knowledge this node has consumed at t. Resolves the active drain itself (one map read);
// callers already holding a per-frame scan use researchConsumedGiven directly.
export function researchConsumed(world: DemoWorld, node: ResearchNode, t: number): number {
  const active = activeResearchEntry(world.state);
  return researchConsumedGiven(world, node, active?.id ?? null, active?.nodeId ?? null, t);
}

// Start (or resume) draining knowledge into `node` at sim time t. Single active slot: if another
// node is draining, this SWAPS — the outgoing node's live consumed is banked into the progress map
// (free cancel, no decay) before the new node starts from its own preserved progress. Returns false
// when there is no knowledge pool yet, the node is already researched, or it is already the active
// drain (all no-ops). The core command begins the drain exactly at t.
export function startResearch(world: DemoWorld, node: ResearchNode, t: number): boolean {
  if (world.knowledgePoolId === undefined) return false;
  if (isResearched(world, node)) return false;
  const active = activeResearchEntry(world.state);
  if (active !== undefined) {
    if (active.nodeId === node.id) return false;
    world.researchProgress.set(active.nodeId, clearResearchCmd(world.state, t, active.id));
  }
  const startingConsumed = world.researchProgress.get(node.id) ?? 0;
  startResearchCmd(
    world.state,
    t,
    node.id,
    world.knowledgePoolId,
    RESEARCH_DRAIN_RATE,
    node.cost,
    startingConsumed,
  );
  world.researchProgress.delete(node.id); // its progress now lives in core (single source of truth)
  return true;
}

// Cancel the active drain at t, banking its consumed into the progress map (resume later where it
// left off). Returns false when nothing is active.
export function cancelResearch(world: DemoWorld, t: number): boolean {
  const active = activeResearchEntry(world.state);
  if (active === undefined) return false;
  world.researchProgress.set(active.nodeId, clearResearchCmd(world.state, t, active.id));
  return true;
}

// Collect the active node if it has reached cost at t: free the slot and record it researched
// (stored consumed == cost). Called every frame so a node that completes online — or across an
// offline jump — is banked the moment the drain crosses its cost. Returns whether it collected
// (the caller saves on true).
export function collectCompletedResearch(world: DemoWorld, t: number): boolean {
  const active = activeResearchEntry(world.state);
  if (active === undefined) return false;
  const node = world.researchNodes.find((n) => n.id === active.nodeId);
  if (node === undefined) return false; // unknown node (restore drops these); nothing to collect
  if (researchConsumedAt(world.state, active.id, t) < node.cost) return false;
  world.researchProgress.set(active.nodeId, clearResearchCmd(world.state, t, active.id));
  return true;
}
