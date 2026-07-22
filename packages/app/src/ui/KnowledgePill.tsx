import { getWarehouse, warehouseAmountAt } from "@fathomrest/core";

import { displayFloor } from "../sim/display.ts";
import { useSimSession, useSimTick } from "./SimSessionProvider.tsx";
import { violet } from "./tokens.ts";

const pillStyle: React.CSSProperties = {
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

const iconStyle: React.CSSProperties = {
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

// Global Knowledge pill (violet + round icon per hard rule 1) — the shared readout used
// in the HUD and the research overlay header. Coarse-tick driven; a pure read at now()
// (the Pixi ticker owns advancing). Null until the knowledge tier exists.
export function KnowledgePill(): React.JSX.Element | null {
  const session = useSimSession();
  useSimTick();
  if (session === null) return null;
  const poolId = session.world.knowledgePoolId;
  if (poolId === undefined) return null;
  const t = session.now();
  const amount = displayFloor(warehouseAmountAt(session.world.state, poolId, t));
  const capacity = getWarehouse(session.world.state, poolId).capacity;
  return (
    <span style={pillStyle}>
      <span style={iconStyle}>K</span>
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {amount} / {capacity}
      </span>
    </span>
  );
}
