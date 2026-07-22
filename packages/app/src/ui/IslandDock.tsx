import type { IslandId } from "@fathomrest/core";

import {
  buildCardViews,
  depositCardViews,
  poolRowViews,
  type BuildCardView,
  type CostChip,
  type DepositCardView,
  type PoolRowView,
} from "../sim/dock.ts";
import { displayCeil, displayFloor } from "../sim/display.ts";
import type { SimSession } from "../sim/session.ts";
import { islandXpView } from "../sim/world.ts";
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
  violet,
} from "./tokens.ts";

// Right dock (design handoff §1a): the island's economy as React panels — parchment
// surface, island-scoped (never violet — hard rule 1). Live numbers ride the coarse
// tick (≥250 ms); the Pixi ticker keeps the sim advanced, so a plain read at now() is
// exact (closed-form, clamped) — this panel never advances the sim itself.
//
// Sections: island header, WAREHOUSE POOLS, DEPOSITS, BUILD. Build actions go through
// session.command (persists + notifies only when the command acted). Skill nodes and
// research stay out of the dock — they belong to their own overlays (hard rule 5).

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

function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const cardStyle: React.CSSProperties = {
  padding: 10,
  marginBottom: 10,
  borderRadius: radii.card,
  background: parchment.card,
  border: `1px solid ${parchment.deckShadow}`,
};

function DepositCard({ card }: { card: DepositCardView }): React.JSX.Element {
  const frac = card.total > 0 ? Math.max(0, Math.min(1, card.remaining / card.total)) : 0;
  const chip = resourceChip(card.resource);
  return (
    <li style={{ ...cardStyle, listStyle: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{card.label}</span>
        <span
          style={{
            padding: "0 5px",
            borderRadius: radii.chip,
            background: parchment.heartwood,
            color: parchment.sailcloth,
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          ×{card.multiplier}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ ...tabular, fontSize: 12, color: parchment.heartwood }}>
          {displayCeil(card.remaining)} / {card.total}
        </span>
      </div>
      <div
        style={{
          height: barHeights.deposit,
          marginTop: 5,
          borderRadius: radii.bar,
          border: `1px solid ${parchment.deckShadow}`,
          background: parchment.agedFold,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${frac * 100}%`, height: "100%", background: chip.color }} />
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: parchment.driftwood }}>
        {card.paused && <span style={{ color: rust.onParchment }}>⏸ paused by jam · </span>}
        {card.nextStep === null
          ? `at floor ×${card.floorMultiplier}`
          : `→ ×${card.nextStep.multiplier} after ${displayCeil(card.nextStep.after)} more · floor ×${card.floorMultiplier}`}
      </div>
    </li>
  );
}

function CostChipView({ chip }: { chip: CostChip }): React.JSX.Element {
  const affordable = chip.affordable;
  return (
    <span
      style={{
        ...tabular,
        padding: "1px 6px",
        borderRadius: radii.chip,
        fontSize: 11,
        whiteSpace: "nowrap",
        fontWeight: affordable ? 400 : 700,
        background: affordable ? parchment.agedFold : rust.tintBg,
        border: `1px solid ${affordable ? parchment.deckShadow : rust.tintBorder}`,
        color: affordable ? parchment.ink : rust.onParchment,
      }}
    >
      {affordable
        ? `${chip.amount} ${chip.resource.replace("-", " ")} ✓`
        : `${chip.amount} — need ${displayCeil(chip.shortfall)}`}
    </span>
  );
}

function BuildCard({
  card,
  onBuild,
}: {
  card: BuildCardView;
  onBuild: () => void;
}): React.JSX.Element {
  const { affordable } = card;
  return (
    <li
      style={{
        ...cardStyle,
        listStyle: "none",
        background: affordable ? parchment.card : parchment.cardMuted,
        border: `1px solid ${affordable ? parchment.brassEdge : parchment.deckShadow}`,
        borderStyle: affordable ? "solid" : "dashed",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: radii.chip,
            background: `repeating-linear-gradient(45deg, ${parchment.deckShadow}, ${parchment.deckShadow} 3px, ${parchment.agedFold} 3px, ${parchment.agedFold} 6px)`,
            flex: "none",
          }}
          aria-hidden="true"
        />
        <span style={{ fontWeight: 700, fontSize: 13 }}>{card.name}</span>
        {card.feedsGlobal && (
          <span
            style={{
              padding: "0 5px",
              borderRadius: radii.chip,
              background: violet.bg,
              color: violet.pale,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: 0.4,
            }}
          >
            → GLOBAL K
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
        {card.costs.map((chip) => (
          <CostChipView key={chip.resource} chip={chip} />
        ))}
      </div>
      {!affordable && card.etaSeconds !== null && (
        <div style={{ fontSize: 11, color: moss.base, marginBottom: 6 }}>
          affordable in ~{formatDuration(card.etaSeconds)} at current rate
        </div>
      )}
      <button
        type="button"
        disabled={!affordable}
        onClick={onBuild}
        style={{
          width: "100%",
          padding: "5px 0",
          borderRadius: radii.button,
          fontFamily: bodyFont,
          fontWeight: 700,
          fontSize: 12.5,
          cursor: affordable ? "pointer" : "default",
          border: "none",
          background: affordable ? brass.base : parchment.deckShadow,
          color: affordable ? parchment.ink : parchment.driftwood,
        }}
      >
        Build
      </button>
    </li>
  );
}

export function IslandDock({
  session,
  island,
}: {
  session: SimSession;
  island: IslandId;
}): React.JSX.Element {
  useSimTick();
  const t = session.now();
  const rows = poolRowViews(session.world, island, t);
  const deposits = depositCardViews(session.world, island, t);
  const builds = buildCardViews(session.world, island, t);
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
      {deposits.length > 0 && (
        <section style={{ padding: "0 16px 14px" }}>
          <h3 style={sectionLabelStyle}>Deposits</h3>
          <ul style={{ margin: 0, padding: 0 }}>
            {deposits.map((card) => (
              <DepositCard key={card.id} card={card} />
            ))}
          </ul>
        </section>
      )}
      {builds.length > 0 && (
        <section style={{ padding: "0 16px 16px" }}>
          <h3 style={sectionLabelStyle}>Build</h3>
          <ul style={{ margin: 0, padding: 0 }}>
            {builds.map((card) => (
              <BuildCard key={card.key} card={card} onBuild={() => session.command(card.run)} />
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
