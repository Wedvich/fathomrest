import { getWarehouse, warehouseAmountAt, type IslandId } from "@fathomrest/core";
import { useEffect, useRef, useState } from "react";

import { resetSave } from "../persistence.ts";
import { PixiReadout } from "../PixiReadout.tsx";
import { displayFloor } from "../sim/display.ts";
import { worldIslands } from "../sim/world.ts";
import { UpdatePrompt } from "../UpdatePrompt.tsx";
import { useSimSession, useSimTick } from "./SimSessionProvider.tsx";
import { bodyFont, brass, headingFont, ocean, parchment, violet } from "./tokens.ts";

// App shell (design handoff 1a/5b): top HUD bar over a canvas region, with the
// research / island-plan / map surfaces as full-screen overlays (Esc or ✕ closes).
// The overlays are token-styled scaffolds — real content lands in later phases; what
// ships here is the navigation model and the HUD chrome.

type OverlayKind = "research" | "island-plan" | "map";

const OVERLAYS: Record<
  OverlayKind,
  { title: string; scope: string; tone: "violet" | "parchment" }
> = {
  research: { title: "Research", scope: "GLOBAL · CUMULATIVE", tone: "violet" },
  "island-plan": { title: "Island plan", scope: "PER-ISLAND", tone: "parchment" },
  map: { title: "Archipelago", scope: "CAPTAIN'S CHART", tone: "parchment" },
};

const hudStyle: React.CSSProperties = {
  display: "flex",
  flex: "none",
  alignItems: "center",
  gap: 12,
  height: 52,
  padding: "0 14px",
  background: `linear-gradient(${ocean.shoal}, ${ocean.harborSlate})`,
  borderBottom: `2px solid ${ocean.abyss}`,
  color: ocean.moonlight,
};

const crestStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: "50%",
  border: `2px solid ${brass.base}`,
  background: ocean.deepWater,
  flex: "none",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: headingFont,
  fontWeight: 400,
  fontSize: 17,
  whiteSpace: "nowrap",
  color: brass.onDark,
};

const hudButtonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  fontSize: 15,
  background: ocean.harborSlate,
  border: `1px solid ${ocean.tideLine}`,
  borderRadius: 5,
  color: ocean.moonlight,
};

const knowledgePillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 10px 3px 4px",
  borderRadius: 12,
  background: violet.bg,
  border: `1px solid ${violet.borderHi}`,
  color: violet.pale,
  fontSize: 12,
};

const knowledgeIconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 17,
  height: 17,
  borderRadius: "50%",
  background: `radial-gradient(circle at 35% 30%, ${violet.light}, ${violet.core})`,
  color: "#fff",
  fontSize: 10,
  fontWeight: 700,
};

async function handleReset(): Promise<void> {
  await resetSave();
  location.reload();
}

// Placeholder display name: island ids are lowercase slugs ("home") until islands carry names.
function islandTitle(island: IslandId): string {
  return island.charAt(0).toUpperCase() + island.slice(1);
}

// Global Knowledge pill (violet + round icon per hard rule 1) — the first React
// readout on the coarse-tick path, proving the sim-view layer.
function KnowledgePill(): React.JSX.Element | null {
  const session = useSimSession();
  useSimTick();
  if (session === null) return null;
  const poolId = session.world.knowledgePoolId;
  if (poolId === undefined) return null;
  // Pure read: renders must not advance the sim (StrictMode/concurrent renders can
  // re-run or discard). warehouseAmountAt is closed-form and clamped, so reading at
  // now() without an advance is exact; the Pixi ticker owns advancing.
  const t = session.now();
  const amount = displayFloor(warehouseAmountAt(session.world.state, poolId, t));
  const capacity = getWarehouse(session.world.state, poolId).capacity;
  return (
    <span style={knowledgePillStyle}>
      <span style={knowledgeIconStyle}>K</span>
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {amount} / {capacity}
      </span>
    </span>
  );
}

function OverlayScaffold({
  kind,
  onClose,
}: {
  kind: OverlayKind;
  onClose: () => void;
}): React.JSX.Element {
  const spec = OVERLAYS[kind];
  const dark = spec.tone === "violet";
  const ref = useRef<HTMLDialogElement>(null);
  // showModal(): top layer, background inert (no Tab-behind), focus moved in and
  // restored to the opener on close, Esc handled natively (cancel → close → onClose).
  // Open-guarded because StrictMode re-runs the effect and showModal throws on an
  // already-open dialog; the ✕ button goes through close() so the close event stays
  // the single unmount path.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: "none",
        display: "flex",
        flexDirection: "column",
        background: dark
          ? `radial-gradient(circle at 50% 40%, ${violet.bg}, ${violet.bgDeepest})`
          : `linear-gradient(${parchment.sailcloth}, ${parchment.base})`,
        color: dark ? violet.pale : parchment.ink,
        fontFamily: bodyFont,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 18px",
          borderBottom: `1px solid ${dark ? violet.border : parchment.brassEdge}`,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: headingFont,
            fontWeight: 400,
            fontSize: 20,
            whiteSpace: "nowrap",
          }}
        >
          {spec.title}
        </h2>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2 }}>{spec.scope}</span>
        <span style={{ flex: 1 }} />
        <button type="button" title="Close" onClick={() => ref.current?.close()}>
          ✕
        </button>
      </header>
      <p style={{ margin: 24, opacity: 0.7 }}>Scaffold — content lands in a later phase.</p>
    </dialog>
  );
}

export function AppShell(): React.JSX.Element {
  const session = useSimSession();
  // Selected island is UI-local state (design handoff). Until the map/island view lands there
  // is nothing to select with, so it derives to the world's first island.
  const selectedIsland = session === null ? undefined : worldIslands(session.world)[0];
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);

  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: ocean.deepWater,
        fontFamily: bodyFont,
      }}
    >
      <header style={hudStyle}>
        <span style={crestStyle} aria-hidden="true" />
        {selectedIsland !== undefined && <h1 style={titleStyle}>{islandTitle(selectedIsland)}</h1>}
        <span style={{ flex: 1 }} />
        <KnowledgePill />
        <button
          type="button"
          style={hudButtonStyle}
          title="Research"
          aria-label="Open research"
          onClick={() => setOverlay("research")}
        >
          ⚗
        </button>
        {/* Opens from the island header once the island view lands (phase 1);
            HUD placement is temporary. */}
        <button
          type="button"
          style={hudButtonStyle}
          title="Island plan"
          aria-label="Open island plan"
          onClick={() => setOverlay("island-plan")}
        >
          📜
        </button>
        <button
          type="button"
          style={hudButtonStyle}
          title="Archipelago map"
          aria-label="Open archipelago map"
          onClick={() => setOverlay("map")}
        >
          🗺
        </button>
        <button type="button" title="Reset save" onClick={() => void handleReset()}>
          Reset
        </button>
      </header>
      {/* The page never scrolls (it's a game, not a document): the shell is a fixed 100dvh
          column and overflow stays inside <main>. The temp Pixi readout is taller than the
          viewport, so <main> scrolls internally until the real canvas region replaces it. */}
      <main style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24 }}>
        {session === null ? (
          <p style={{ color: ocean.foam }}>Loading…</p>
        ) : (
          <PixiReadout session={session} />
        )}
      </main>
      {overlay !== null && <OverlayScaffold kind={overlay} onClose={() => setOverlay(null)} />}
      <UpdatePrompt />
    </div>
  );
}
