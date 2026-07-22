import { jamLogEntries, type JamLogEntry } from "../sim/dock.ts";
import { useSimSession, useSimTick } from "./SimSessionProvider.tsx";
import { useNavigation } from "./navigation.ts";
import { amber, brass, bodyFont, headingFont, ocean, radii, rust } from "./tokens.ts";

// Harbormaster's log (design handoff §1a): a dark translucent panel floating at the
// bottom-left of the canvas, listing every jammed/starved pool root-cause-first. It
// renders the core solver's ordering and classification directly (hard rule 2/4); each
// row's action deep-links to the root pool the dock then highlights. Hidden when the
// economy is running clean — nothing to report.

const panelStyle: React.CSSProperties = {
  position: "absolute",
  left: 16,
  bottom: 16,
  width: 390,
  maxWidth: "calc(100% - 32px)",
  padding: "10px 12px",
  borderRadius: radii.panel,
  background: "rgba(16,28,34,0.92)",
  border: `1px solid ${ocean.tideLine}`,
  color: ocean.foam,
  fontFamily: bodyFont,
  boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
};

function summary(entries: readonly JamLogEntry[]): string {
  const jams = entries.filter((e) => e.full).length;
  const starved = entries.length - jams;
  const parts: string[] = [];
  if (jams > 0) parts.push(`${jams} jam${jams === 1 ? "" : "s"}`);
  if (starved > 0) parts.push(`${starved} starved`);
  return parts.join(" · ");
}

function LogRow({ entry, onFix }: { entry: JamLogEntry; onFix: () => void }): React.JSX.Element {
  return (
    <li
      style={{
        listStyle: "none",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 0",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          flex: "none",
          background: entry.isRoot ? rust.light : amber.base,
        }}
        aria-hidden="true"
      />
      <span style={{ fontSize: 12.5, minWidth: 0 }}>
        <strong>{entry.subject}</strong> {entry.full ? "jammed" : "starved"} — {entry.detail}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onFix}
        style={{
          flex: "none",
          padding: "2px 9px",
          borderRadius: radii.button,
          background: "transparent",
          border: `1px solid ${brass.base}`,
          color: brass.onDark,
          fontFamily: bodyFont,
          fontSize: 11.5,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {entry.isRoot ? "Fix" : "View"}
      </button>
    </li>
  );
}

export function HarbormasterLog(): React.JSX.Element | null {
  const session = useSimSession();
  const nav = useNavigation();
  useSimTick();
  if (session === null) return null;
  const entries = jamLogEntries(session.world);
  if (entries.length === 0) return null;
  return (
    <aside style={panelStyle} aria-label="Harbormaster's log">
      <header style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: headingFont,
            fontWeight: 400,
            fontSize: 14,
            whiteSpace: "nowrap",
            color: brass.onDark,
          }}
        >
          Harbormaster's log
        </h2>
        <span style={{ fontSize: 11, color: ocean.mist }}>{summary(entries)}</span>
      </header>
      <ul style={{ margin: 0, padding: 0 }}>
        {entries.map((entry) => (
          <LogRow key={entry.poolId} entry={entry} onFix={() => nav.focus(entry.focusPoolId)} />
        ))}
      </ul>
    </aside>
  );
}
