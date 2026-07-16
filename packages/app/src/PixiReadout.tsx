import { advance, warehouseAmountAt, warehouseOutflowRate, getWarehouse } from "@fathomrest/core";
import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { useEffect, useRef } from "react";

import { createDemoWorld } from "./sim/world.ts";
import { createSimClock } from "./simClock.ts";

const WIDTH = 480;
const ROW_HEIGHT = 72;
const BAR_HEIGHT = 28;
const PADDING = 24;

// Placeholder Pixi readout: owns the sim clock and drives advance(t)/query(t) off Pixi's
// ticker (itself rAF-based). The React tree stays static; all animation lives in the
// ticker, so there is no per-frame React re-render. Sim time comes from simClock:
// monotonic between frames, re-anchored against the wall clock on visibility-return and
// persisted pageshow, so time lost to OS-level tab suspension (Safari) is caught up in
// one advance() — per docs/browser-performance.md §lifecycle / ADR-0001 §4.
export function PixiReadout(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    const app = new Application();
    // Set only once init resolves — the destroy gate. app.renderer is `undefined` (not
    // null) pre-init, so destroying on it would tear down a half-built app and then
    // Pixi's second destroy() throws on the double free.
    let live: Application | null = null;

    const world = createDemoWorld(1, Date.now());

    const clock = createSimClock();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") clock.reanchor();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) clock.reanchor();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);

    void app
      .init({
        width: WIDTH,
        height: PADDING * 2 + ROW_HEIGHT * world.warehouses.length,
        background: 0x0e1a24,
        antialias: true,
        resolution: window.devicePixelRatio,
        autoDensity: true,
      })
      .then(() => {
        // StrictMode runs the effect twice in dev; the first pass may have been torn
        // down before init resolved. Bail without touching the DOM.
        if (disposed) {
          app.destroy(true);
          return;
        }
        host.appendChild(app.canvas);
        live = app;

        const barWidth = WIDTH - PADDING * 2;
        const rows = world.warehouses.map((wh, i) => {
          const y = PADDING + i * ROW_HEIGHT;
          const row = new Container();
          row.y = y;

          const label = new Text({
            text: wh.label,
            style: { fill: 0xcfe6f2, fontSize: 15, fontFamily: "monospace" },
          });
          const readout = new Text({
            text: "",
            style: { fill: 0x8fb2c4, fontSize: 12, fontFamily: "monospace" },
          });
          readout.x = 90;
          const track = new Graphics().roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0x14303f);
          track.y = 24;
          // Plain rect Sprite, not Graphics: width is set every tick to reflect frac, and
          // a Sprite resize is a cheap transform (no geometry rebuild/GPU re-upload) vs.
          // Graphics' clear()+redraw. A static rounded-rect mask restores the track's
          // corner rounding without putting Graphics back in the frame path.
          const fill = new Sprite(Texture.WHITE);
          fill.tint = 0x3fa7d6;
          fill.y = 24;
          fill.height = BAR_HEIGHT;
          const corners = new Graphics().roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0xffffff);
          corners.y = 24;
          fill.mask = corners;

          row.addChild(track, fill, corners, label, readout);
          app.stage.addChild(row);

          const capacity = getWarehouse(world.state, wh.id).capacity;
          return {
            id: wh.id,
            capacity,
            fill,
            readout,
            lastAmount: NaN,
            lastOut: NaN,
            lastFrac: NaN,
          };
        });

        const tick = (): void => {
          const t = clock.now();
          advance(world.state, t);
          // Indexed loop: iterator protocol allocates per step on JSC (perf doc, frame loop).
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row === undefined) continue;
            const amount = warehouseAmountAt(world.state, row.id, t);
            const frac = row.capacity > 0 ? amount / row.capacity : 0;
            if (frac !== row.lastFrac) {
              row.lastFrac = frac;
              row.fill.width = Math.max(1, barWidth * frac);
            }
            const out = warehouseOutflowRate(world.state, row.id);
            const roundedAmount = Math.round(amount * 10) / 10;
            const roundedOut = Math.round(out * 10) / 10;
            if (roundedAmount !== row.lastAmount || roundedOut !== row.lastOut) {
              row.lastAmount = roundedAmount;
              row.lastOut = roundedOut;
              row.readout.text = `${roundedAmount.toFixed(1)} / ${row.capacity}  (−${roundedOut.toFixed(1)}/s)`;
            }
          }
        };
        tick();
        app.ticker.add(tick);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        host.textContent = `Pixi init failed: ${String(error)}`;
      });

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      // Only destroy a fully-initialized app; if init hasn't resolved, the disposed
      // guard destroys it once when it does. app.ticker.remove(tick) is unnecessary —
      // destroy() tears down the app's own ticker (sharedTicker: false by default).
      if (live !== null) live.destroy(true);
    };
  }, []);

  return <div ref={hostRef} />;
}
