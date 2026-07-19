import {
  canAffordBuild,
  depositMultiplier,
  depositRemainingAt,
  forEachResearch,
  getDeposit,
  getWarehouse,
  islandXpAt,
  warehouseAmountAt,
  warehouseOutflowRate,
  type Id,
  type IslandId,
  type Research,
  type ResearchNodeId,
  type ResourceType,
} from "@fathomrest/core";
import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { useEffect, useRef } from "react";

import { displayCeil, displayFloor } from "./sim/display.ts";
import type { SimSession } from "./sim/session.ts";
import {
  buildConverter,
  buildExtractor,
  buyNode,
  canBuyNode,
  cancelResearch,
  collectCompletedResearch,
  isConverterBuilt,
  isExtractorBuilt,
  islandLevel,
  islandLevelCeilXp,
  islandLevelFloorXp,
  isNodeBranchLocked,
  isNodeResearchLocked,
  isResearchActive,
  isResearched,
  nextStorageTier,
  nodeNeedsStorage,
  type ResearchNode,
  researchConsumedGiven,
  startResearch,
  type StorageTier,
  upgradeStorage,
  worldIslands,
  worldSkillNodes,
} from "./sim/world.ts";
import { preloadUiFonts } from "./ui/fonts.ts";

const WIDTH = 480;
const ROW_HEIGHT = 72;
const BAR_HEIGHT = 28;
const PADDING = 24;

// Placeholder Pixi scene: draws the readout bars and drives advance(t)/query(t) off
// Pixi's ticker (itself rAF-based). The React tree stays static; all animation lives
// in the ticker, so there is no per-frame React re-render. The sim clock, world
// loading, and persistence live in the SimSession (sim/session.ts) — this component
// only draws the world it is handed and issues commands through session.command,
// which persists and notifies React subscribers on every acted command.
export function PixiReadout({ session }: { session: SimSession }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  // The build buttons (one per deposit) are created imperatively inside the effect once the
  // world loads, so the React tree stays static and the frame loop can toggle their disabled
  // state without a re-render (see the ticker below).
  const controlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const controls = controlsRef.current;
    if (host === null || controls === null) return;

    let disposed = false;
    const app = new Application();
    // Set only once init resolves — the destroy gate. app.renderer is `undefined` (not
    // null) pre-init, so destroying on it would tear down a half-built app and then
    // Pixi's second destroy() throws on the double free.
    let live: Application | null = null;

    const world = session.world;

    void (async () => {
      // Decode the UI faces before the first Pixi Text is built (see ui/fonts.ts);
      // a load failure is non-fatal — the fontFamily fallbacks still render.
      try {
        await preloadUiFonts();
      } catch (error) {
        console.error("Failed to preload UI fonts; falling back.", error);
      }
      if (disposed) return;

      // Research is offered only once the knowledge pool exists (a pre-knowledge save whose
      // content upgrade hasn't landed hides the whole section rather than showing dead rows).
      const researchNodes: readonly ResearchNode[] =
        world.knowledgePoolId === undefined ? [] : world.researchNodes;

      await app.init({
        width: WIDTH,
        height:
          PADDING * 2 +
          ROW_HEIGHT *
            (world.warehouses.length +
              world.deposits.length +
              worldIslands(world).length +
              researchNodes.length),
        background: 0x0e1a24,
        antialias: true,
        resolution: window.devicePixelRatio,
        autoDensity: true,
      });
      // StrictMode runs the effect twice in dev; the first pass may have been torn down
      // before init resolved. Bail without touching the DOM.
      if (disposed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      live = app;

      const barWidth = WIDTH - PADDING * 2;

      // One bar per node. A warehouse bar fills toward capacity (blue); a deposit bar drains
      // its reserve toward the floor (amber). Each row owns an update(t) closure that memoizes
      // its last frac/text, so the frame loop only touches Pixi when a value actually moved.
      type Row = { update: (t: number) => void };
      const rows: Row[] = [];

      const makeBar = (
        label: string,
        index: number,
        tint: number,
      ): { fill: Sprite; readout: Text } => {
        const row = new Container();
        row.x = PADDING;
        row.y = PADDING + index * ROW_HEIGHT;
        const labelText = new Text({
          text: label,
          style: { fill: 0xcfe6f2, fontSize: 16, fontFamily: '"Coming Soon", monospace' },
        });
        const readout = new Text({
          text: "",
          style: { fill: 0x8fb2c4, fontSize: 16, fontFamily: '"Coming Soon", monospace' },
        });
        // Right-align to the bar's right edge; label stays left-aligned at x=0.
        readout.anchor.set(1, 0);
        readout.x = barWidth;
        const track = new Graphics().roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0x14303f);
        track.y = 24;
        // Plain rect Sprite, not Graphics: width is set every tick to reflect frac, and a
        // Sprite resize is a cheap transform (no geometry rebuild/GPU re-upload) vs. Graphics'
        // clear()+redraw. A static rounded-rect mask restores the track's corner rounding
        // without putting Graphics back in the frame path.
        const fill = new Sprite(Texture.WHITE);
        fill.tint = tint;
        fill.y = 24;
        fill.height = BAR_HEIGHT;
        const corners = new Graphics().roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0xffffff);
        corners.y = 24;
        fill.mask = corners;
        row.addChild(track, fill, corners, labelText, readout);
        app.stage.addChild(row);
        return { fill, readout };
      };

      const setFrac = (fill: Sprite, frac: number): void => {
        fill.width = Math.max(1, barWidth * frac);
      };

      world.warehouses.forEach((wh, i) => {
        const { fill, readout } = makeBar(wh.label, i, 0x3fa7d6);
        // Hold the component reference: commands mutate its fields in place (capacity is raised
        // by a storage upgrade), so reading warehouse.capacity each tick picks that up without a
        // per-frame Map lookup.
        const warehouse = getWarehouse(world.state, wh.id);
        let lastFrac = NaN;
        let lastAmount = NaN;
        let lastOut = NaN;
        let lastCapacity = NaN;
        rows.push({
          update: (t): void => {
            const capacity = warehouse.capacity;
            const amount = warehouseAmountAt(world.state, wh.id, t);
            const frac = capacity > 0 ? amount / capacity : 0;
            if (frac !== lastFrac) {
              lastFrac = frac;
              setFrac(fill, frac);
            }
            const out = warehouseOutflowRate(world.state, wh.id);
            const roundedAmount = displayFloor(amount);
            const roundedOut = Math.round(out * 10) / 10;
            if (
              roundedAmount !== lastAmount ||
              roundedOut !== lastOut ||
              capacity !== lastCapacity
            ) {
              lastAmount = roundedAmount;
              lastOut = roundedOut;
              lastCapacity = capacity;
              readout.text = `${roundedAmount} / ${capacity}  (−${roundedOut.toFixed(1)}/s)`;
            }
          },
        });
      });

      world.deposits.forEach((dep, i) => {
        const { fill, readout } = makeBar(dep.label, world.warehouses.length + i, 0xd6a13f);
        // Reserve above the floor = sum of tier amounts; tier amounts never mutate, so this is
        // a stable bar denominator captured once.
        let reserve = 0;
        for (const tier of getDeposit(world.state, dep.id).tiers) reserve += tier.amount;
        let lastFrac = NaN;
        let lastRemaining = NaN;
        let lastMult = NaN;
        rows.push({
          update: (t): void => {
            const remaining = depositRemainingAt(world.state, dep.id, t);
            const frac = reserve > 0 ? remaining / reserve : 0;
            if (frac !== lastFrac) {
              lastFrac = frac;
              setFrac(fill, frac);
            }
            const mult = depositMultiplier(world.state, dep.id);
            const roundedRemaining = displayCeil(remaining);
            if (roundedRemaining !== lastRemaining || mult !== lastMult) {
              lastRemaining = roundedRemaining;
              lastMult = mult;
              readout.text = `${roundedRemaining} / ${reserve}  (×${mult})`;
            }
          },
        });
      });

      // Island XP bars: one per island with a skill tree (registered islands). Shows progress
      // within the current level; a distinct tint from warehouses (blue) and deposits (amber).
      const islandRowBase = world.warehouses.length + world.deposits.length;
      worldIslands(world).forEach((island, i) => {
        const { fill, readout } = makeBar(`${island} XP`, islandRowBase + i, 0x9b7fd6);
        let lastFrac = NaN;
        let lastText = "";
        rows.push({
          // Reads scalars directly (no per-frame IslandXpView allocation — perf doc). Both the
          // bar fill and the label measure progress WITHIN the current level, so they agree.
          update: (t): void => {
            const xp = islandXpAt(world.state, island, t);
            const level = islandLevel(xp);
            const floor = islandLevelFloorXp(level);
            const ceil = islandLevelCeilXp(level);
            const span = ceil === undefined ? 0 : ceil - floor;
            const frac = span <= 0 ? 1 : Math.max(0, Math.min(1, (xp - floor) / span));
            if (frac !== lastFrac) {
              lastFrac = frac;
              setFrac(fill, frac);
            }
            const text =
              ceil === undefined
                ? `Lvl ${level} (max)`
                : `Lvl ${level} · ${Math.floor(xp - floor)} / ${span} XP`;
            if (text !== lastText) {
              lastText = text;
              readout.text = text;
            }
          },
        });
      });

      // The single active research drain, refreshed once per frame (single slot, so a hoisted
      // scan closure with no per-frame allocation — perf doc: the frame loop must not allocate).
      // The research rows and buttons read these instead of re-scanning core per node.
      let activeResearchId: Id | null = null;
      let activeResearchNodeId: ResearchNodeId | null = null;
      const scanActiveResearch = (id: Id, research: Research): void => {
        activeResearchId = id;
        activeResearchNodeId = research.nodeId;
      };

      // A research node's consumed at t, via the shared world reader fed this frame's hoisted active
      // scan (no allocation, no core rescan per node). One rule, defined in world.ts.
      const nodeConsumed = (node: ResearchNode, t: number): number =>
        researchConsumedGiven(world, node, activeResearchId, activeResearchNodeId, t);

      // Research rows sit after the island XP bars; a distinct tint (teal) from islands (purple).
      const researchRowBase = islandRowBase + worldIslands(world).length;
      researchNodes.forEach((node, i) => {
        const { fill, readout } = makeBar(`⚑ ${node.label}`, researchRowBase + i, 0x5fc4b0);
        let lastFrac = NaN;
        let lastConsumed = NaN;
        let lastStatus = "";
        rows.push({
          update: (t): void => {
            const consumed = nodeConsumed(node, t);
            const frac = node.cost > 0 ? consumed / node.cost : 0;
            if (frac !== lastFrac) {
              lastFrac = frac;
              setFrac(fill, frac);
            }
            const active = activeResearchNodeId === node.id;
            const roundedConsumed = displayFloor(consumed);
            let status = "";
            if (active) status = "researching";
            else if (consumed >= node.cost) status = "researched";
            else if (consumed > 0) status = "paused";
            if (roundedConsumed !== lastConsumed || status !== lastStatus) {
              lastConsumed = roundedConsumed;
              lastStatus = status;
              const suffix = status === "" ? "" : `  (${status})`;
              readout.text = `${roundedConsumed} / ${node.cost}${suffix}`;
            }
          },
        });
      });

      // Build buttons, created imperatively so the React tree stays static and the frame loop
      // can drive each button's disabled state without a re-render. Each caches its cost Map
      // and island once (the frame loop must not allocate — perf doc) and rewrites its own
      // label/disabled only when the underlying state actually changes.
      type BuildButton = { update: (t: number) => void };
      const buttons: BuildButton[] = [];
      controls.textContent = ""; // StrictMode re-run: drop any buttons the prior pass appended
      const formatCost = (cost: readonly (readonly [ResourceType, number])[]): string =>
        cost.map(([resource, amount]) => `${amount} ${resource}`).join(", ");
      const addBuildButton = (spec: {
        cost: readonly (readonly [ResourceType, number])[];
        payIslandId: IslandId; // the build-site island whose stock the cost is charged against
        builtLabel: string;
        buildLabel: string;
        isBuilt: () => boolean;
        build: (t: number) => boolean;
      }): void => {
        const el = document.createElement("button");
        el.type = "button";
        const costMap = new Map<ResourceType, number>(spec.cost);
        const island: IslandId = spec.payIslandId;
        el.addEventListener("click", () => {
          // session.command persists only when the build actually happened; a rejected
          // build (unaffordable) leaves state untouched, so there is nothing to save.
          session.command(spec.build);
        });
        controls.appendChild(el);
        let lastBuilt: boolean | null = null;
        let lastEnabled: boolean | null = null;
        buttons.push({
          update: (t): void => {
            const isBuilt = spec.isBuilt();
            const enabled = !isBuilt && canAffordBuild(world.state, t, island, costMap);
            if (isBuilt !== lastBuilt) {
              lastBuilt = isBuilt;
              el.textContent = isBuilt ? spec.builtLabel : spec.buildLabel;
            }
            if (enabled !== lastEnabled) {
              lastEnabled = enabled;
              el.disabled = !enabled;
            }
          },
        });
      };
      for (const dep of world.deposits) {
        addBuildButton({
          cost: dep.cost,
          payIslandId: dep.payIslandId,
          builtLabel: `${dep.label} — extractor built`,
          buildLabel: `Build extractor · ${dep.label} (${formatCost(dep.cost)})`,
          isBuilt: () => isExtractorBuilt(world, dep.id),
          build: (t) => buildExtractor(world, dep.id, t),
        });
      }
      // The refinery is charged from its source pool's island (both pools share one —
      // buildConverter is single-island). Site labels name the structure ("Iron Refinery"),
      // so the build verb stays generic — no hardcoded structure noun for future site kinds.
      for (const site of world.converterSites) {
        addBuildButton({
          cost: site.cost,
          payIslandId: getWarehouse(world.state, site.srcWarehouseId).islandId,
          builtLabel: `${site.label} — built`,
          buildLabel: `Build ${site.label} (${formatCost(site.cost)})`,
          isBuilt: () => isConverterBuilt(world, site.srcWarehouseId, site.dstWarehouseId),
          build: (t) => buildConverter(world, site, t),
        });
      }

      // Storage upgrade buttons: one per ISLAND (storage is island-level — one upgrade lifts every
      // pool's cap together), distinct from the binary build buttons because the ladder is
      // multi-tier — the label and cost change with each purchase and end at "maxed".
      // nextStorageTier returns a stable STORAGE_TIERS element (undefined once maxed), so a
      // reference compare is the dirty check: the label and cost Map are rebuilt only when the
      // tier changes (after an upgrade), not per frame (perf doc: the frame loop must not
      // allocate).
      for (const island of worldIslands(world)) {
        const el = document.createElement("button");
        el.type = "button";
        el.addEventListener("click", () => {
          session.command((t) => upgradeStorage(world, island, t));
        });
        controls.appendChild(el);
        let lastTier: StorageTier | undefined | null = null; // null: no frame rendered yet
        let costMap = new Map<ResourceType, number>();
        let lastEnabled: boolean | null = null;
        buttons.push({
          update: (t): void => {
            const tier = nextStorageTier(world, island);
            if (tier !== lastTier) {
              lastTier = tier;
              if (tier === undefined) {
                el.textContent = `${island} storage maxed`;
              } else {
                costMap = new Map(tier.cost);
                el.textContent = `Upgrade ${island} storage → ${tier.capacity} (${formatCost(tier.cost)})`;
              }
            }
            const enabled = tier !== undefined && canAffordBuild(world.state, t, island, costMap);
            if (enabled !== lastEnabled) {
              lastEnabled = enabled;
              el.disabled = !enabled;
            }
          },
        });
      }

      // Skill-node buttons (DESIGN.md: island specialization). Like the build buttons but gated on
      // island level + prerequisites (canBuyNode), not just affordability. Junction nodes can flip
      // between locked and buyable within a session (research completing, the opposite branch being
      // chosen), so every node takes a per-frame update — the label carries the current lock reason.
      for (const node of worldSkillNodes(world)) {
        const el = document.createElement("button");
        el.type = "button";
        const costText = formatCost(node.cost);
        const otherBranch = node.branch === "extraction" ? "Refinement" : "Extraction";
        el.addEventListener("click", () => {
          session.command((t) => buyNode(world, node.id, t));
        });
        controls.appendChild(el);
        let lastLabel: string | null = null;
        let lastDisabled: boolean | null = null;
        buttons.push({
          update: (t): void => {
            const owned = world.purchasedNodes.includes(node.id);
            const enabled = !owned && canBuyNode(world, node.id, t);
            let label: string;
            if (owned) {
              label = `${node.label} — owned`;
            } else if (isNodeBranchLocked(world, node)) {
              label = `🔒 ${node.label} — ${otherBranch} branch chosen`;
            } else if (isNodeResearchLocked(world, node)) {
              label = `🔒 ${node.label} · Lvl ${node.levelRequired} — research required`;
            } else if (nodeNeedsStorage(world, node)) {
              label = `🔒 ${node.label} · Lvl ${node.levelRequired} — needs bigger storage`;
            } else {
              label = `Skill: ${node.label} · Lvl ${node.levelRequired} (${costText})`;
            }
            if (label !== lastLabel) {
              lastLabel = label;
              el.textContent = label;
            }
            const disabled = !enabled;
            if (disabled !== lastDisabled) {
              lastDisabled = disabled;
              el.disabled = disabled;
            }
          },
        });
      }

      // Research buttons: one per node. Research is a drain with no upfront cost (DESIGN.md), so
      // there is no affordability gate — a node is always startable (an empty pool just stalls it).
      // Clicking the active node cancels it; clicking another node swaps to it (banking the
      // outgoing node's progress). The active-state decision reads core at click time, not the
      // per-frame scan, so it can't act on a stale frame.
      for (const node of researchNodes) {
        const el = document.createElement("button");
        el.type = "button";
        el.addEventListener("click", () => {
          session.command((t) =>
            isResearchActive(world, node)
              ? cancelResearch(world, t)
              : startResearch(world, node, t),
          );
        });
        controls.appendChild(el);
        let lastLabel: string | null = null;
        let lastDisabled: boolean | null = null;
        buttons.push({
          update: (): void => {
            const researched = isResearched(world, node);
            const active = activeResearchNodeId === node.id;
            let label = `Research ${node.label} (${node.cost} knowledge)`;
            if (researched) label = `${node.label} — researched`;
            else if (active) label = `Cancel — ${node.label}`;
            if (label !== lastLabel) {
              lastLabel = label;
              el.textContent = label;
            }
            const disabled = researched;
            if (disabled !== lastDisabled) {
              lastDisabled = disabled;
              el.disabled = disabled;
            }
          },
        });
      }

      const collect = (t: number): boolean => collectCompletedResearch(world, t);
      const tick = (): void => {
        // Bank a node that finished this frame (online or across an offline jump) before
        // rendering, so its bar reads "researched" the same frame the drain crossed cost;
        // session.command persists and notifies subscribers when that happens; the
        // returned t is the single authoritative sim time for this frame's reads.
        const t = session.command(collect);
        // Refresh the active-research scan for this frame's row/button reads (no per-node rescan).
        activeResearchId = null;
        activeResearchNodeId = null;
        forEachResearch(world.state, scanActiveResearch);
        // Indexed loop: iterator protocol allocates per step on JSC (perf doc, frame loop).
        for (let i = 0; i < rows.length; i++) {
          rows[i]?.update(t);
        }
        for (let i = 0; i < buttons.length; i++) {
          buttons[i]?.update(t);
        }
      };
      tick();
      app.ticker.add(tick);
    })().catch((error: unknown) => {
      if (disposed) return;
      host.textContent = `Pixi init failed: ${String(error)}`;
    });

    return () => {
      disposed = true;
      controls.textContent = ""; // drop the imperatively-created build buttons
      // Only destroy a fully-initialized app; if init hasn't resolved, the disposed
      // guard destroys it once when it does. app.ticker.remove(tick) is unnecessary —
      // destroy() tears down the app's own ticker (sharedTicker: false by default).
      if (live !== null) live.destroy(true);
    };
  }, [session]);

  return (
    <div>
      <div ref={hostRef} />
      <div ref={controlsRef} />
    </div>
  );
}
