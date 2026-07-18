// Design tokens from docs/design_handoff_fathomrest_ui/README.md (§Design Tokens).
// Single hex source: React styles consume the strings, Pixi consumes them through
// pixiColor(). Scope rules (handoff "hard rules"): island-scoped surfaces use the
// parchment ramp; global scope (knowledge, research) is violet-only; rust means
// blocked and nothing else; symptoms are amber.

/** Parchment ramp — island-scoped surfaces (dock, cards, skill tree, sea chart). */
export const parchment = {
  sailcloth: "#f4ecd9",
  base: "#e8dcc3",
  agedFold: "#dfd2b2",
  deckShadow: "#cbbf9e",
  brassEdge: "#a08a5f",
  driftwood: "#7a6a4c",
  heartwood: "#5a4a30",
  ink: "#3a2f1f",
  card: "#efe4c9",
  cardMuted: "#e9dec4",
} as const;

/** Ocean chrome ramp — HUD bar, canvas surround, dark overlays. */
export const ocean = {
  abyss: "#0d1d23",
  deepWater: "#14282f",
  harborSlate: "#1a323c",
  shoal: "#22414d",
  tideLine: "#39525c",
  tideLineDeep: "#2c4a56",
  tideLineHi: "#3d5a66",
  mist: "#7d949c",
  foam: "#9db4bc",
  moonlight: "#dfe8e5",
} as const;

/** Ship's brass — primary actions, home marker. */
export const brass = {
  base: "#c9a856",
  hi: "#d8b96a",
  deep: "#8a744a",
  onDark: "#e3cd8a",
} as const;

/** Current — flowing, XP, positive structure. */
export const current = {
  base: "#3d7a8c",
  light: "#58a3b5",
  pale: "#8fc7d6",
  ink: "#2a5c6b",
} as const;

/** Jam rust — blocked/full ONLY; never reuse for anything else. */
export const rust = {
  base: "#b5563d",
  light: "#e0846a",
  deep: "#7e3423",
  onParchment: "#a04a33",
  tintBg: "#eecfc3",
  tintBgAlt: "#f0ded1",
  tintBorder: "#cf8f79",
} as const;

/** Amber — symptoms, warnings, trickle floors (root causes stay rust). */
export const amber = {
  base: "#c98a3d",
  light: "#e8b56a",
  ink: "#8c6b3d",
} as const;

/** Moss — flowing rates, affordable ✓. */
export const moss = {
  base: "#527a3b",
  light: "#9fc48f",
} as const;

/** Scholar violet — GLOBAL scope only (knowledge, research). */
export const violet = {
  core: "#5c4f96",
  mid: "#8d7fc4",
  light: "#b3a6e0",
  pale: "#cfc4ef",
  bg: "#221c3d",
  bgDeep: "#1b1731",
  bgDeepest: "#141126",
  border: "#322a55",
  borderMid: "#4a3f7a",
  borderHi: "#6a5c9e",
} as const;

/** Placeholder resource chips: rounded square, white monogram (knowledge: circle,
    violet radial — see hard rule 1). Keyed by the resourceType ids in world.ts. */
export const resourceChips = {
  wood: { color: "#8a6b3f", monogram: "W" },
  stone: { color: "#8c8c86", monogram: "S" },
  "iron-ore": { color: "#7a8a99", monogram: "Fe" },
  "iron-ingot": { color: "#5f7d8c", monogram: "Ig" },
  knowledge: { color: violet.core, monogram: "K" },
} as const;

export const radii = {
  bar: 3,
  chip: 4,
  button: 5,
  card: 6,
  panel: 8,
  pill: 12,
} as const;

/** Bar heights by context (px). */
export const barHeights = {
  dock: 13,
  table: 9,
  deposit: 7,
  micro: 5,
} as const;

/** Heading/flavor face — always white-space:nowrap per the handoff. */
export const headingFont = '"Caveat Brush", "Comic Sans MS", cursive';
/** Body/data face — data text pairs with font-variant-numeric:tabular-nums. */
export const bodyFont = '"Playpen Sans", "Comic Sans MS", sans-serif';

/** "#rrggbb" → 0xrrggbb for Pixi fills/strokes. */
export function pixiColor(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}
