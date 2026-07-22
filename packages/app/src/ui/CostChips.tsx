import type { CostChip } from "../sim/dock.ts";
import { displayCeil } from "../sim/display.ts";
import { parchment, radii, rust } from "./tokens.ts";

// One cost chip on a parchment surface (design handoff §1a build cards, §3c skill nodes):
// affordable reads `40 wood ✓` on aged fold; unaffordable states the shortfall in rust
// (`120 — need 32`) — hard rule 6. Shared by the dock's build cards and the island plan's
// skill-node cards so the affordable/short treatment can't drift between the two.
export function CostChipView({ chip }: { chip: CostChip }): React.JSX.Element {
  const { affordable } = chip;
  return (
    <span
      style={{
        fontVariantNumeric: "tabular-nums",
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
