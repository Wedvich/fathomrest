import type { IslandId } from "@fathomrest/core";
import { Fragment } from "react";

import { costChips, poolRowViews, type CostChip } from "../sim/dock.ts";
import {
  buyNode,
  canBuyNode,
  islandXpView,
  isNodeBranchLocked,
  isNodeResearchLocked,
  nodeNeedsStorage,
  worldSkillNodes,
  type SkillNode,
} from "../sim/world.ts";
import { CostChipView } from "./CostChips.tsx";
import { useSimSession, useSimTick } from "./SimSessionProvider.tsx";
import { OverlayFrame } from "./OverlayFrame.tsx";
import { brass, current, headingFont, moss, parchment, radii, rust, violet } from "./tokens.ts";

// Island skill tree — "surveyor's plan" (design handoff §3c). Full parchment, the opposite
// of research's violet. Shared trunk → research-gated EXCLUSIVE junction → two branches;
// levels gate WHEN, stockpiles gate WHETHER. Every gate reason comes from the core-backed
// world predicates (isNodeBranchLocked / isNodeResearchLocked / nodeNeedsStorage), never
// re-derived here.

type SkillStatus =
  | "owned"
  | "buyable"
  | "branch-locked"
  | "research-locked"
  | "needs-storage"
  | "level-locked"
  | "locked";

function effectLabel(node: SkillNode): string {
  const pct = Math.round((node.effectFactor - 1) * 100);
  return `+${pct}% ${node.branch === "refinement" ? "refinement yield" : "extraction"}`;
}

const cardBase: React.CSSProperties = {
  width: 210,
  padding: 12,
  borderRadius: radii.card,
  background: parchment.card,
  fontSize: 13,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: parchment.driftwood,
};

const stem: React.CSSProperties = {
  width: 2,
  height: 18,
  margin: "0 auto",
  background: parchment.brassEdge,
};

export function IslandPlanOverlay({
  island,
  onClose,
}: {
  island: IslandId;
  onClose: () => void;
}): React.JSX.Element {
  const session = useSimSession();
  useSimTick();

  const world = session?.world ?? null;
  const t = session?.now() ?? 0;
  const xp = world === null ? null : islandXpView(world, island, t);
  const title = island.charAt(0).toUpperCase() + island.slice(1);
  const jammed = world !== null && poolRowViews(world, island, t).some((r) => r.jammed);

  const researchLabelById = new Map(
    (world?.researchNodes ?? []).map((n) => [n.id, n.label] as const),
  );

  const nodes = world === null ? [] : worldSkillNodes(world).filter((n) => n.island === island);
  const trunk = nodes.filter((n) => n.branch === "trunk");
  const junction = nodes.filter((n) => n.researchRequired !== undefined);
  const extraction = nodes.filter(
    (n) => n.branch === "extraction" && n.researchRequired === undefined,
  );
  const refinement = nodes.filter(
    (n) => n.branch === "refinement" && n.researchRequired === undefined,
  );

  const status = (node: SkillNode): SkillStatus => {
    if (world === null) return "locked";
    if (world.purchasedNodes.includes(node.id)) return "owned";
    if (isNodeBranchLocked(world, node)) return "branch-locked";
    if (isNodeResearchLocked(world, node)) return "research-locked";
    if (nodeNeedsStorage(world, node)) return "needs-storage";
    if (canBuyNode(world, node.id, t)) return "buyable";
    if ((xp?.level ?? 0) < node.levelRequired) return "level-locked";
    return "locked";
  };

  const buy = (node: SkillNode): void => {
    session?.command((tt) => buyNode(session.world, node.id, tt));
  };

  const xpBar = (): React.ReactNode => {
    if (xp === null) return null;
    const span = xp.nextLevelXp === undefined ? 0 : xp.nextLevelXp - xp.currentLevelXp;
    const frac = span <= 0 ? 1 : Math.max(0, Math.min(1, (xp.xp - xp.currentLevelXp) / span));
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 160,
            height: 8,
            borderRadius: radii.bar,
            background: parchment.agedFold,
            border: `1px solid ${parchment.deckShadow}`,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              width: `${frac * 100}%`,
              height: "100%",
              background: `linear-gradient(${current.base}, ${current.light})`,
            }}
          />
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, whiteSpace: "nowrap" }}>
          {xp.nextLevelXp === undefined
            ? "XP max"
            : `XP ${Math.floor(xp.xp - xp.currentLevelXp)}/${span}`}
        </span>
        {jammed && (
          <span style={{ color: rust.onParchment, fontSize: 12, whiteSpace: "nowrap" }}>
            ⏸ paused
          </span>
        )}
      </span>
    );
  };

  return (
    <OverlayFrame
      title={`${title} — Island plan`}
      scope={`PER-ISLAND · Lv ${xp?.level ?? 0}`}
      tone="parchment"
      onClose={onClose}
      headerRight={xpBar()}
    >
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <p style={{ ...sectionLabel, margin: "0 0 12px" }}>Trunk · nodes cost island stock</p>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
          {trunk.map((node) => (
            <SkillCard
              key={node.id}
              node={node}
              status={status(node)}
              chips={world === null ? [] : costChips(world, island, node.cost, t)}
              level={xp?.level ?? 0}
              researchLabel={
                node.researchRequired ? researchLabelById.get(node.researchRequired) : undefined
              }
              onBuy={() => buy(node)}
            />
          ))}
        </div>

        <div style={stem} />

        <JunctionBlock>
          {junction.map((node, i) => (
            <Fragment key={node.id}>
              {i > 0 && (
                <span style={{ fontFamily: headingFont, fontSize: 20, color: parchment.driftwood }}>
                  or
                </span>
              )}
              <SkillCard
                node={node}
                status={status(node)}
                chips={world === null ? [] : costChips(world, island, node.cost, t)}
                level={xp?.level ?? 0}
                researchLabel={
                  node.researchRequired ? researchLabelById.get(node.researchRequired) : undefined
                }
                onBuy={() => buy(node)}
                commit
              />
            </Fragment>
          ))}
        </JunctionBlock>

        <div style={stem} />

        <div
          style={{
            display: "flex",
            gap: 28,
            alignItems: "flex-start",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <BranchColumn
            label="Extraction"
            locked={extraction.some((n) => status(n) === "branch-locked")}
          >
            {extraction.map((node) => (
              <SkillCard
                key={node.id}
                node={node}
                status={status(node)}
                chips={world === null ? [] : costChips(world, island, node.cost, t)}
                level={xp?.level ?? 0}
                onBuy={() => buy(node)}
              />
            ))}
          </BranchColumn>
          <BranchColumn
            label="Refinement"
            locked={refinement.some((n) => status(n) === "branch-locked")}
          >
            {refinement.map((node) => (
              <SkillCard
                key={node.id}
                node={node}
                status={status(node)}
                chips={world === null ? [] : costChips(world, island, node.cost, t)}
                level={xp?.level ?? 0}
                onBuy={() => buy(node)}
              />
            ))}
          </BranchColumn>
        </div>
      </div>
    </OverlayFrame>
  );
}

function JunctionBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        position: "relative",
        maxWidth: 640,
        padding: "26px 20px 16px",
        border: `2px solid ${parchment.brassEdge}`,
        borderRadius: radii.card,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: -12,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "2px 10px",
          borderRadius: radii.pill,
          background: parchment.heartwood,
          color: parchment.sailcloth,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.8,
          whiteSpace: "nowrap",
        }}
      >
        EXCLUSIVE JUNCTION — PICK ONE, PERMANENT
      </span>
      <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
      <p
        style={{ margin: "12px 0 0", textAlign: "center", fontSize: 11.5, color: rust.onParchment }}
      >
        ⚠ a wrong pick costs one island, not the save
      </p>
    </div>
  );
}

function BranchColumn({
  label,
  locked,
  children,
}: {
  label: string;
  locked: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        opacity: locked ? 0.55 : 1,
      }}
    >
      <span style={{ ...sectionLabel, color: locked ? parchment.driftwood : current.ink }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function lockNote(status: SkillStatus, node: SkillNode, researchLabel: string | undefined): string {
  switch (status) {
    case "branch-locked":
      return "the other branch is chosen";
    case "research-locked":
      return `🔒 research: ${researchLabel ?? "required"}`;
    case "needs-storage":
      return "needs bigger storage";
    case "level-locked":
      return `needs level ${node.levelRequired}`;
    default:
      return "";
  }
}

function cardBorder(status: SkillStatus): string {
  if (status === "buyable") return `2px solid ${brass.base}`;
  if (status === "owned") return `1px solid ${brass.deep}`;
  return `2px dashed ${parchment.deckShadow}`;
}

function cardOpacity(status: SkillStatus): number {
  if (status === "owned") return 0.8;
  if (status === "buyable") return 1;
  return 0.62;
}

function SkillCard({
  node,
  status,
  chips,
  level,
  researchLabel,
  onBuy,
  commit = false,
}: {
  node: SkillNode;
  status: SkillStatus;
  chips: readonly CostChip[];
  level: number;
  researchLabel?: string | undefined;
  onBuy: () => void;
  commit?: boolean;
}): React.JSX.Element {
  const owned = status === "owned";
  const buyable = status === "buyable";
  const note = lockNote(status, node, researchLabel);
  const levelMet = level >= node.levelRequired;
  return (
    <div
      style={{
        ...cardBase,
        opacity: cardOpacity(status),
        border: cardBorder(status),
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <strong style={{ fontSize: 13 }}>{node.label}</strong>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            whiteSpace: "nowrap",
            color: levelMet ? moss.base : parchment.driftwood,
          }}
        >
          Lv {node.levelRequired} {levelMet ? "✓" : ""}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: current.ink, margin: "3px 0 8px" }}>
        {effectLabel(node)}
      </div>

      {owned ? (
        <div style={{ fontSize: 12, color: moss.base, fontWeight: 700 }}>✓ owned</div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
            {chips.map((chip) => (
              <CostChipView key={chip.resource} chip={chip} />
            ))}
          </div>
          {note !== "" && (
            <div
              style={{
                marginBottom: 8,
                fontSize: 11,
                fontWeight: 700,
                color: status === "research-locked" ? violet.core : parchment.driftwood,
              }}
            >
              {note}
            </div>
          )}
          <button
            type="button"
            disabled={!buyable}
            onClick={onBuy}
            style={{
              width: "100%",
              padding: "5px 0",
              borderRadius: radii.button,
              border: "none",
              fontWeight: 700,
              fontSize: 12.5,
              cursor: buyable ? "pointer" : "default",
              background: buyable ? brass.base : parchment.deckShadow,
              color: buyable ? parchment.ink : parchment.driftwood,
            }}
          >
            {commit ? "Commit" : "Buy"}
          </button>
        </>
      )}
    </div>
  );
}
