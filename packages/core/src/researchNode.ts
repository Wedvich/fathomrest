// Branded research-node tag: like ResourceType/IslandId, a plain string at runtime
// (serializes as-is), unforgeable in types. The core carries it as an opaque passthrough on
// the active research drain so the app can re-associate the drain with its authored node
// after a save round-trip — the core never interprets it (the research tree is app content,
// DESIGN.md Progression/Research). Validity (non-empty) is enforced at the command and
// import boundaries, like Id.
declare const RESEARCH_NODE_BRAND: unique symbol;

export type ResearchNodeId = string & { readonly [RESEARCH_NODE_BRAND]: true };

// Mint site for tagging a string as a research-node id; the same cast rehydrates one from a
// save document.
export function researchNodeId(value: string): ResearchNodeId {
  return value as ResearchNodeId;
}
