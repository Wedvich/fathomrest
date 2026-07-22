import { useEffect, useRef } from "react";

import { bodyFont, headingFont, parchment, violet } from "./tokens.ts";

// Shared full-screen overlay chrome (design handoff §5b navigation model): a native
// <dialog> in the top layer — background inert, focus trapped and restored, Esc handled
// natively (cancel → close → onClose). showModal is open-guarded because StrictMode
// re-runs the effect; the ✕ routes through close() so the close event stays the single
// unmount path. Tone picks the scope language: violet = global (research), parchment =
// island-scoped (island plan / map) — hard rule 1.
export function OverlayFrame({
  title,
  scope,
  tone,
  onClose,
  headerRight,
  children,
}: {
  title: string;
  scope: string;
  tone: "violet" | "parchment";
  onClose: () => void;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const dark = tone === "violet";
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: "none",
        display: "flex",
        flexDirection: "column",
        background: dark
          ? `radial-gradient(circle at 50% 40%, ${violet.bg}, ${violet.bgDeepest})`
          : `linear-gradient(${parchment.sailcloth}, ${parchment.base})`,
        color: dark ? violet.pale : parchment.ink,
        fontFamily: bodyFont,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: "none",
          padding: "12px 18px",
          borderBottom: `1px solid ${dark ? violet.border : parchment.brassEdge}`,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: headingFont,
            fontWeight: 400,
            fontSize: 20,
            whiteSpace: "nowrap",
            color: dark ? violet.pale : parchment.ink,
          }}
        >
          {title}
        </h2>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 1.2,
            color: dark ? violet.mid : parchment.driftwood,
          }}
        >
          {scope}
        </span>
        <span style={{ flex: 1 }} />
        {headerRight}
        <button
          type="button"
          title="Close"
          onClick={() => ref.current?.close()}
          style={{
            background: "transparent",
            border: `1px solid ${dark ? violet.borderHi : parchment.brassEdge}`,
            borderRadius: 5,
            color: dark ? violet.pale : parchment.ink,
            fontSize: 14,
            width: 28,
            height: 28,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 24 }}>{children}</div>
    </dialog>
  );
}
