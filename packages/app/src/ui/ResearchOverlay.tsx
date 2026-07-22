import {
  cancelResearch,
  isResearchActive,
  isResearched,
  researchConsumed,
  startResearch,
  type ResearchNode,
} from "../sim/world.ts";
import { displayFloor } from "../sim/display.ts";
import { KnowledgePill } from "./KnowledgePill.tsx";
import { OverlayFrame } from "./OverlayFrame.tsx";
import { useSimSession, useSimTick } from "./SimSessionProvider.tsx";
import { brass, moss, radii, violet } from "./tokens.ts";

// Research panel — "star chart" (design handoff §3a). Entirely in the global scholar-violet
// language (hard rule 1) so it can never be confused with island UI. This is the reduced
// state set the TODO calls for — researched / researching / startable — no queue machinery
// yet (queue depth 0→1 is future core work). Research is a drain with no upfront cost, so a
// node is always startable; the active node drains the global knowledge pool, and starting
// another swaps to it (banking the outgoing node's progress).

type ResearchStatus = "researched" | "researching" | "paused" | "idle";

function statusOf(
  world: NonNullable<ReturnType<typeof useSimSession>>["world"],
  node: ResearchNode,
  consumed: number,
): ResearchStatus {
  if (isResearched(world, node)) return "researched";
  if (isResearchActive(world, node)) return "researching";
  return consumed > 0 ? "paused" : "idle";
}

const STATUS_TAG: Record<ResearchStatus, string> = {
  researched: "researched",
  researching: "researching ⏱",
  paused: "paused · banked",
  idle: "not started",
};

export function ResearchOverlay({ onClose }: { onClose: () => void }): React.JSX.Element {
  const session = useSimSession();
  useSimTick();
  const world = session?.world ?? null;
  const t = session?.now() ?? 0;
  const nodes = world === null || world.knowledgePoolId === undefined ? [] : world.researchNodes;

  return (
    <OverlayFrame
      title="Research"
      scope="GLOBAL · CUMULATIVE"
      tone="violet"
      onClose={onClose}
      headerRight={<KnowledgePill />}
    >
      {world === null || world.knowledgePoolId === undefined ? (
        <p style={{ opacity: 0.7 }}>
          No knowledge pool yet — build an observatory to begin charting research.
        </p>
      ) : (
        <div
          style={{
            maxWidth: 520,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {nodes.map((node) => {
            const consumed = researchConsumed(world, node, t);
            const status = statusOf(world, node, consumed);
            return (
              <ResearchCard
                key={node.id}
                node={node}
                consumed={consumed}
                status={status}
                onAction={() =>
                  session?.command((tt) =>
                    isResearchActive(world, node)
                      ? cancelResearch(world, tt)
                      : startResearch(world, node, tt),
                  )
                }
              />
            );
          })}
        </div>
      )}
    </OverlayFrame>
  );
}

function cardBorderColor(status: ResearchStatus): string {
  if (status === "researched") return violet.mid;
  if (status === "researching") return violet.light;
  return violet.border;
}

function ResearchCard({
  node,
  consumed,
  status,
  onAction,
}: {
  node: ResearchNode;
  consumed: number;
  status: ResearchStatus;
  onAction: () => void;
}): React.JSX.Element {
  const frac = node.cost > 0 ? Math.max(0, Math.min(1, consumed / node.cost)) : 0;
  const researched = status === "researched";
  const active = status === "researching";
  const borderColor = cardBorderColor(status);
  return (
    <div
      style={{
        padding: 14,
        borderRadius: radii.card,
        background: violet.bg,
        border: `${active ? 2 : 1}px solid ${borderColor}`,
        opacity: researched ? 0.75 : 1,
        boxShadow: active ? `0 0 12px ${violet.borderHi}` : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 15, color: violet.pale }}>{node.label}</strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: researched ? moss.light : violet.mid }}>
          {researched ? "✓ " : ""}
          {STATUS_TAG[status]}
        </span>
      </div>
      <div
        style={{
          height: 6,
          margin: "10px 0 8px",
          borderRadius: radii.bar,
          background: violet.bgDeep,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${frac * 100}%`,
            height: "100%",
            background: `linear-gradient(90deg, ${violet.mid}, ${violet.light})`,
          }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, color: violet.mid }}>
          {displayFloor(consumed)} / {node.cost} knowledge
        </span>
        <span style={{ flex: 1 }} />
        {!researched && (
          <button
            type="button"
            onClick={onAction}
            style={{
              padding: "4px 14px",
              borderRadius: radii.button,
              border: active ? `1px solid ${violet.borderHi}` : "none",
              fontWeight: 700,
              fontSize: 12.5,
              cursor: "pointer",
              background: active ? "transparent" : brass.base,
              color: active ? violet.pale : "#2a2140",
            }}
          >
            {active ? "Cancel" : "Research"}
          </button>
        )}
      </div>
    </div>
  );
}
