import type { Id, IslandId } from "@fathomrest/core";
import { useEffect, useState } from "react";

import { resetSave } from "../persistence.ts";
import { PixiReadout } from "../PixiReadout.tsx";
import { worldIslands } from "../sim/world.ts";
import { UpdatePrompt } from "../UpdatePrompt.tsx";
import { HarbormasterLog } from "./HarbormasterLog.tsx";
import { IslandDock } from "./IslandDock.tsx";
import { IslandPlanOverlay } from "./IslandPlanOverlay.tsx";
import { KnowledgePill } from "./KnowledgePill.tsx";
import { NavigationContext, useNavigation, type OverlayKind } from "./navigation.ts";
import { OverlayFrame } from "./OverlayFrame.tsx";
import { ResearchOverlay } from "./ResearchOverlay.tsx";
import { useSimSession } from "./SimSessionProvider.tsx";
import { bodyFont, brass, headingFont, ocean } from "./tokens.ts";

// App shell (design handoff 1a/5b): top HUD bar over a canvas region + right dock, with
// the research / island-plan / map surfaces as full-screen overlays (Esc or ✕ closes).
// Research and island-plan render real content; the map stays a scaffold (phase 5).

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

async function handleReset(): Promise<void> {
  await resetSave();
  location.reload();
}

// Placeholder display name: island ids are lowercase slugs ("home") until islands carry names.
function islandTitle(island: IslandId): string {
  return island.charAt(0).toUpperCase() + island.slice(1);
}

function MapScaffold({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <OverlayFrame title="Archipelago" scope="CAPTAIN'S CHART" tone="parchment" onClose={onClose}>
      <p style={{ opacity: 0.7 }}>Scaffold — the captain's chart lands in a later phase.</p>
    </OverlayFrame>
  );
}

function HudNav(): React.JSX.Element {
  const nav = useNavigation();
  return (
    <>
      <button
        type="button"
        style={hudButtonStyle}
        title="Research"
        aria-label="Open research"
        onClick={() => nav.navigate({ overlay: "research" })}
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
        onClick={() => nav.navigate({ overlay: "island-plan" })}
      >
        📜
      </button>
      <button
        type="button"
        style={hudButtonStyle}
        title="Archipelago map"
        aria-label="Open archipelago map"
        onClick={() => nav.navigate({ overlay: "map" })}
      >
        🗺
      </button>
    </>
  );
}

function OverlayHost({ island }: { island: IslandId | undefined }): React.JSX.Element | null {
  const nav = useNavigation();
  const overlay = nav.activeOverlay;
  if (overlay === null) return null;
  const close = (): void => nav.close();
  if (overlay === "research") return <ResearchOverlay onClose={close} />;
  if (overlay === "island-plan") {
    return island === undefined ? null : <IslandPlanOverlay island={island} onClose={close} />;
  }
  return <MapScaffold onClose={close} />;
}

export function AppShell(): React.JSX.Element {
  const session = useSimSession();
  // Selected island is UI-local state (design handoff). Until the map/island view lands there
  // is nothing to select with, so it derives to the world's first island.
  const selectedIsland = session === null ? undefined : worldIslands(session.world)[0];
  const [activeOverlay, setActiveOverlay] = useState<OverlayKind | null>(null);
  // Transient deep-link focus target: a log "Fix" sets it, the dock pulses/scrolls to it,
  // then it self-clears so a later re-focus of the same pool re-triggers the effect.
  const [focusPool, setFocusPool] = useState<Id | null>(null);
  useEffect(() => {
    if (focusPool === null) return;
    const id = window.setTimeout(() => setFocusPool(null), 2500);
    return () => window.clearTimeout(id);
  }, [focusPool]);

  return (
    <NavigationContext.Provider
      value={{
        activeOverlay,
        navigate: (link) => setActiveOverlay(link.overlay),
        close: () => setActiveOverlay(null),
        focusPool,
        focus: (poolId) => {
          setActiveOverlay(null);
          setFocusPool(poolId);
        },
      }}
    >
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
          {selectedIsland !== undefined && (
            <h1 style={titleStyle}>{islandTitle(selectedIsland)}</h1>
          )}
          <span style={{ flex: 1 }} />
          <KnowledgePill />
          <HudNav />
          <button type="button" title="Reset save" onClick={() => void handleReset()}>
            Reset
          </button>
        </header>
        {/* The page never scrolls (it's a game, not a document): the shell is a fixed 100dvh
            column and overflow stays inside <main>. <main> is a row — the canvas region on the
            left (the temp Pixi readout, still taller than the viewport so it scrolls internally)
            and the parchment island dock pinned right (design handoff §1a). The readout swaps
            for the real island scene once it needs to fill the region. */}
        <main style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          {session === null ? (
            <p style={{ color: ocean.foam, padding: 24 }}>Loading…</p>
          ) : (
            <>
              {/* Canvas region: a non-scrolling relative frame so the harbormaster's log
                  floats over the canvas, with the temp readout scrolling inside it. */}
              <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: 24 }}>
                  <PixiReadout session={session} />
                </div>
                <HarbormasterLog />
              </div>
              {selectedIsland !== undefined && (
                <IslandDock session={session} island={selectedIsland} />
              )}
            </>
          )}
        </main>
        <OverlayHost island={selectedIsland} />
        <UpdatePrompt />
      </div>
    </NavigationContext.Provider>
  );
}
