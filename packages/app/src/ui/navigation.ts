import { createContext, useContext } from "react";

// The deep-link primitive: a way to open a specific overlay from anywhere in the
// tree, not just the HUD buttons that trigger it today. Phase 1's harbormaster's-log
// action rows and phase 2's welcome-back-dialog fix buttons both need this ("Fix
// buttons deep-link... navigate to the bottleneck" — design handoff §2). Kept to just
// the overlay for now — there is one island and no jam-log rows yet to link from;
// add a focus target (island/pool/building) to DeepLink when one of those lands.
export type OverlayKind = "research" | "island-plan" | "map";

export interface DeepLink {
  overlay: OverlayKind;
}

export interface Navigation {
  readonly activeOverlay: OverlayKind | null;
  navigate(link: DeepLink): void;
  close(): void;
}

export const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext);
  if (nav === null) throw new Error("useNavigation called outside NavigationContext.Provider");
  return nav;
}
