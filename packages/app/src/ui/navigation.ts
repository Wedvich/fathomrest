import type { Id } from "@fathomrest/core";
import { createContext, useContext } from "react";

// The deep-link primitive: a way to open a specific overlay — or focus a specific
// entity in the island view — from anywhere in the tree, not just the HUD buttons.
// The harbormaster's-log fix actions and phase 2's welcome-back-dialog fix buttons
// both need this ("Fix buttons deep-link... navigate to the bottleneck" — handoff §2).
export type OverlayKind = "research" | "island-plan" | "map";

export interface DeepLink {
  overlay: OverlayKind;
}

export interface Navigation {
  readonly activeOverlay: OverlayKind | null;
  navigate(link: DeepLink): void;
  close(): void;
  // The pool the island view should highlight/scroll to (a jam-fix target), or null.
  // Transient — set by focus(), auto-cleared so the highlight is a one-shot pulse.
  readonly focusPool: Id | null;
  focus(poolId: Id): void;
}

export const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext);
  if (nav === null) throw new Error("useNavigation called outside NavigationContext.Provider");
  return nav;
}
