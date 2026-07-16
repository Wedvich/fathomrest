// Branded island-grouping tag: like ResourceType, a plain string at runtime (serializes
// as-is), unforgeable in types. The core is content-agnostic — it stores the tag and
// compares it for equality (same-island cost debit) but knows nothing of island geometry,
// slots, or adjacency. Islands are authored content in the app layer (DESIGN.md:
// procedural islands); the core carries only the opaque grouping, keeping it dep-free.
declare const ISLAND_BRAND: unique symbol;

export type IslandId = string & { readonly [ISLAND_BRAND]: true };

// Mint site for tagging a string as an island id; the same cast rehydrates one from a save
// document. Validity (non-empty) is enforced at the command and import boundaries, like
// ResourceType.
export function islandId(value: string): IslandId {
  return value as IslandId;
}
