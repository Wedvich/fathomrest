import { advance, warehouseAmountAt, warehouseOutflowRate, getWarehouse } from "@fathomrest/core";
import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { useEffect, useRef } from "react";

import { createDemoWorld } from "./sim/world.ts";

const WIDTH = 480;
const ROW_HEIGHT = 72;
const BAR_HEIGHT = 28;
const PADDING = 24;

// Placeholder Pixi readout: owns the sim clock and drives advance(t)/query(t) off Pixi's
// ticker (itself rAF-based). The React tree stays static; all animation lives in the
// ticker, so there is no per-frame React re-render. Sim time derives from
// performance.now(), which does NOT advance during OS-level tab suspension — under
// Safari suspension this demo clock can drift rather than catch up. Real wall-clock
// re-anchoring (pageshow/visibilitychange) lands with the persistence work, which needs
// the same wallTime/epoch model.
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

        const perfOrigin = performance.now();

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
          const track = new Graphics();
          track.y = 24;
          // Plain rect Sprite, not Graphics: width is set every tick to reflect frac, and
          // a Sprite resize is a cheap transform (no geometry rebuild/GPU re-upload) vs.
          // Graphics' clear()+redraw. Loses the track's rounded corners on the fill only.
          const fill = new Sprite(Texture.WHITE);
          fill.tint = 0x3fa7d6;
          fill.y = 24;
          fill.height = BAR_HEIGHT;

          row.addChild(track, fill, label, readout);
          app.stage.addChild(row);

          const capacity = getWarehouse(world.state, wh.id).capacity;
          return {
            ...wh,
            capacity,
            fill,
            readout,
            track,
            lastAmount: NaN,
            lastOut: NaN,
            lastFrac: NaN,
          };
        });

        const barWidth = WIDTH - PADDING * 2;
        for (const row of rows) {
          row.track.roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0x14303f);
        }

        const tick = (): void => {
          const t = (performance.now() - perfOrigin) / 1000;
          advance(world.state, t);
          for (const row of rows) {
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
      // Only destroy a fully-initialized app; if init hasn't resolved, the disposed
      // guard destroys it once when it does. app.ticker.remove(tick) is unnecessary —
      // destroy() tears down the app's own ticker (sharedTicker: false by default).
      if (live !== null) live.destroy(true);
    };
  }, []);

  return <div ref={hostRef} />;
}
