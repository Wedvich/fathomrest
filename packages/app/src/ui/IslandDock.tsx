import type { IslandId } from "@fathomrest/core";

import { poolRowViews, type PoolRowView } from "../sim/dock.ts";
import { displayFloor } from "../sim/display.ts";
import { islandXpView } from "../sim/world.ts";
import type { SimSession } from "../sim/session.ts";
import { useSimTick } from "./SimSessionProvider.tsx";
import {
  amber,
  barHeights,
  bodyFont,
  brass,
  headingFont,
  moss,
  parchment,
  radii,
  resourceChip,
  rust,
} from "./tokens.ts";

// Right dock (design handoff §1a): the island's economy as React panels — parchment
// surface, island-scoped (never violet — hard rule 1). Live numbers ride the coarse
// tick (≥250 ms); the Pixi ticker keeps the sim advanced, so a plain read at now() is
// exact (closed-form, clamped) — this panel never advances the sim itself.
//
// This pass ships the island header + WAREHOUSE POOLS. DEPOSITS and BUILD land next
// (see the section stubs below) as the temp Pixi readout's cards migrate here.

const DOCK_WIDTH = 352;

const dockStyle: React.CSSProperties = {
  flex: "none",
  width: DOCK_WIDTH,
  height: "100%",
  overflowY: "auto",
  background: `linear-gradient(${parchment.sailcloth}, ${parchment.base})`,
  borderLeft: `3px solid #0d1d23`,
  boxShadow: `inset 3px 0 0 ${parchment.brassEdge}`,
  color: parchment.ink,
  fontFamily: bodyFont,
};

const sectionLabelStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: parchment.driftwood,
};

const tabular: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

function IslandHeader({
  session,
  island,
}: {
  session: SimSession;
  island: IslandId;
}): React.JSX.Element {
  const xp = islandXpView(session.world, island, session.now());
  const rows = poolRowViews(session.world, island, session.now());
  const jammed = rows.some((r) => r.jammed);
  const title = island.charAt(0).toUpperCase() + island.slice(1);
  return (
    <header
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "14px 16px",
        borderBottom: `1px solid ${parchment.deckShadow}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: headingFont,
            fontWeight: 400,
            fontSize: 19,
            whiteSpace: "nowrap",
            color: parchment.ink,
          }}
        >
          {title}
        </h2>
        <div style={{ ...sectionLabelStyle, margin: "2px 0 0" }}>
          {title.toUpperCase()} ISLAND · Lv {xp.level}
        </div>
      </div>
      <span style={{ flex: 1 }} />
      <span
        style={{
          ...tabular,
          fontSize: 12,
          color: jammed ? rust.onParchment : parchment.driftwood,
          whiteSpace: "nowrap",
        }}
      >
        {jammed ? "XP paused ⏸" : xpText(xp.xp, xp.currentLevelXp, xp.nextLevelXp)}
      </span>
    </header>
  );
}

function xpText(xp: number, floor: number, ceil: number | undefined): string {
  if (ceil === undefined) return "XP max";
  return `XP ${displayFloor(xp - floor)}/${ceil - floor}`;
}

function rateSign(rounded: number): string {
  if (rounded > 0) return "+";
  if (rounded < 0) return "−";
  return "±";
}

function formatRate(rate: number): string {
  const rounded = Math.round(rate * 10) / 10;
  return `${rateSign(rounded)}${Math.abs(rounded).toFixed(1)}/s`;
}

function PoolRow({ row }: { row: PoolRowView }): React.JSX.Element {
  const chip = resourceChip(row.resource);
  const frac = row.capacity > 0 ? Math.max(0, Math.min(1, row.amount / row.capacity)) : 0;
  return (
    <li style={{ listStyle: "none", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 17,
            height: 17,
            borderRadius: radii.chip,
            background: chip.color,
            color: "#fff",
            fontSize: 9,
            fontWeight: 700,
            flex: "none",
          }}
        >
          {chip.monogram}
        </span>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{row.label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ ...tabular, fontSize: 12.5, color: parchment.heartwood }}>
          {displayFloor(row.amount)} / {row.capacity}
        </span>
        {row.jammed ? (
          <span
            style={{
              padding: "1px 6px",
              borderRadius: radii.chip,
              background: rust.base,
              color: "#fff",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0.4,
            }}
          >
            JAM
          </span>
        ) : (
          <span style={{ ...tabular, fontSize: 12, color: rateColor(row.netRate) }}>
            {formatRate(row.netRate)}
          </span>
        )}
      </div>
      <div
        style={{
          position: "relative",
          height: barHeights.dock,
          marginTop: 5,
          borderRadius: radii.bar,
          border: `1px solid ${brass.deep}`,
          background: parchment.agedFold,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${frac * 100}%`,
            height: "100%",
            background: `linear-gradient(${chip.color}, ${shade(chip.color)})`,
          }}
        />
        {row.jammed && (
          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              width: 3,
              height: "100%",
              background: rust.base,
            }}
          />
        )}
      </div>
      {row.block !== null && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: rust.onParchment }}>
          {row.block.isRoot ? (
            <>
              <RootTag /> {row.block.reason}
            </>
          ) : (
            <>accumulation blocked · caused by {row.block.rootLabel}</>
          )}
        </div>
      )}
      {row.outflows.map((edge, i) => (
        <div key={i} style={{ marginTop: 3, fontSize: 11.5, color: parchment.driftwood }}>
          {formatRate(-edge.rate)} → {edge.converterLabel} (
          {edge.producedResource.replace("-", " ")})
        </div>
      ))}
    </li>
  );
}

function RootTag(): React.JSX.Element {
  return (
    <span
      style={{
        padding: "0 4px",
        borderRadius: radii.chip,
        background: rust.tintBg,
        border: `1px solid ${rust.tintBorder}`,
        color: rust.onParchment,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: 0.4,
      }}
    >
      ROOT
    </span>
  );
}

function rateColor(rate: number): string {
  if (rate > 0) return moss.base;
  if (rate < 0) return amber.ink;
  return parchment.driftwood;
}

// Darken a #rrggbb by a fixed factor for the bar's vertical gradient foot.
function shade(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * 0.78);
  const g = Math.round(((n >> 8) & 0xff) * 0.78);
  const b = Math.round((n & 0xff) * 0.78);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function IslandDock({
  session,
  island,
}: {
  session: SimSession;
  island: IslandId;
}): React.JSX.Element {
  useSimTick();
  const rows = poolRowViews(session.world, island, session.now());
  return (
    <aside style={dockStyle} aria-label="Island economy">
      <IslandHeader session={session} island={island} />
      <section style={{ padding: "14px 16px" }}>
        <h3 style={sectionLabelStyle}>Warehouse pools</h3>
        <ul style={{ margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <PoolRow key={row.id} row={row} />
          ))}
        </ul>
      </section>
      {/* DEPOSITS and BUILD sections land next — deposit cards + build cards with cost
          chips migrate here from the temp Pixi readout's controls. */}
    </aside>
  );
}
