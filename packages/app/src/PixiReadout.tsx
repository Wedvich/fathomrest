import {
  advance,
  canAffordBuild,
  depositMultiplier,
  depositRemainingAt,
  getDeposit,
  getWarehouse,
  warehouseAmountAt,
  warehouseOutflowRate,
  type IslandId,
  type ResourceType,
} from "@fathomrest/core";
import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { useEffect, useRef } from "react";

import {
  ensurePersistentStorage,
  loadSavedWorld,
  quarantineCorruptSave,
  readSaveBreadcrumb,
  writeSavedWorld,
} from "./persistence.ts";
import {
  buildExtractor,
  createDemoWorld,
  type DemoWorld,
  isExtractorBuilt,
  restoreWorld,
  type SavedWorld,
  snapshotWorld,
} from "./sim/world.ts";
import { createSimClock } from "./simClock.ts";

const WIDTH = 480;
const ROW_HEIGHT = 72;
const BAR_HEIGHT = 28;
const PADDING = 24;

// Autosave cadence. Elapsed time is reconstructed from the saved (epoch, wallTime) anchor
// on load, so this need not be tight for time-tracking — it bounds how much player state
// (once commands mutate the world) a crash could lose. Lifecycle events (hidden/pagehide)
// save too, but teardown-time saves are unreliable: WebKit drops ones needing an async
// open hop (persistence.ts holds one long-lived connection to dodge that), and Firefox
// aborts even a synchronous pagehide put. This interval and save-on-command are the
// writes that always land.
const AUTOSAVE_INTERVAL_MS = 15_000;

// Placeholder Pixi readout: owns the sim clock and drives advance(t)/query(t) off Pixi's
// ticker (itself rAF-based). The React tree stays static; all animation lives in the
// ticker, so there is no per-frame React re-render. Sim time comes from simClock:
// monotonic between frames, re-anchored against the wall clock on visibility-return and
// persisted pageshow, so time lost to OS-level tab suspension (Safari) is caught up in
// one advance() — per docs/browser-performance.md §lifecycle / ADR-0001 §4.
//
// The world is loaded from IndexedDB when a save exists (with offline catch-up), else a
// fresh demo world; it is saved on visibility-hidden, pagehide, and a periodic backstop.
export function PixiReadout(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  // The build buttons (one per deposit) are created imperatively inside the effect once the
  // world loads, so the React tree stays static and the frame loop can toggle their disabled
  // state without a re-render (see the ticker below).
  const controlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const controls = controlsRef.current;
    if (host === null || controls === null) return;

    ensurePersistentStorage();

    let disposed = false;
    const app = new Application();
    // Set only once init resolves — the destroy gate. app.renderer is `undefined` (not
    // null) pre-init, so destroying on it would tear down a half-built app and then
    // Pixi's second destroy() throws on the double free.
    let live: Application | null = null;

    const clock = createSimClock();

    // Set once the world is loaded; lifecycle listeners registered below are no-ops until
    // then. Persists the world at its current sim time and re-stamps the wall-clock anchor.
    let requestSave: (() => void) | null = null;

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        clock.reanchor();
      } else {
        requestSave?.();
      }
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) clock.reanchor();
    };
    const onPageHide = (): void => requestSave?.();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);
    const autosave = window.setInterval(() => requestSave?.(), AUTOSAVE_INTERVAL_MS);

    void (async () => {
      // A failed read (e.g. Safari's transient "connection lost" right after
      // navigation — persistence.ts retries once before giving up) is NOT the same as
      // "no save exists". Treating it as such and then autosaving the resulting fresh
      // world clobbers the real save a few seconds later — this was the "save resets
      // every 2-10 refreshes" bug. On a genuine read failure this session runs
      // in-memory with persistence disabled instead, leaving the existing save alone
      // for the next reload to retry.
      let saved: SavedWorld | null = null;
      let persistenceDisabled = false;
      try {
        saved = await loadSavedWorld();
      } catch (error) {
        persistenceDisabled = true;
        console.error("Failed to load saved world; continuing without persistence.", error);
      }
      if (disposed) return;
      // An absent save when the breadcrumb says one existed means the database was lost
      // outside the app (eviction, corruption, a privacy setting clearing site data) —
      // log it so a reset in the wild is attributable.
      if (saved === null && !persistenceDisabled) {
        const crumb = readSaveBreadcrumb();
        if (crumb !== null) {
          console.error(
            `No save found, but one existed (epoch ${crumb.epoch}, saved ${new Date(crumb.wallTime).toISOString()}) — storage was cleared outside the app.`,
          );
        }
      }
      // Schema guard: fall back to a fresh world only if the save is absent, predates the
      // envelope's view models (deposits/buildSite), or is unmigratable. Core deserialize
      // forward-migrates older documents (e.g. v1 saves gain the islandId field), so a routine
      // schema bump preserves idle progress rather than resetting it.
      let world: DemoWorld | null = null;
      if (saved !== null) {
        try {
          if (!("deposits" in saved))
            throw new Error("save predates the deposits/buildSite envelope");
          world = restoreWorld(saved, Date.now());
        } catch (error) {
          // Unrestorable save: quarantined (not destroyed) for post-mortem, and the main
          // slot cleared so the epoch guard accepts the fresh world's saves (ADR-0001 §8).
          console.error(
            "Saved world failed to restore; quarantining it and starting fresh.",
            error,
          );
          void quarantineCorruptSave(saved).catch((qError: unknown) => {
            console.error("Failed to quarantine the corrupt save.", qError);
          });
        }
      }
      world ??= createDemoWorld(1, Date.now());
      // Canonical current sim time is epochAtStart + clock.now(): clock.now() grows from 0
      // at mount, epochAtStart carries any epoch a loaded save already advanced to.
      const epochAtStart = world.state.epoch;

      requestSave = (): void => {
        if (persistenceDisabled) return;
        advance(world.state, epochAtStart + clock.now());
        world.state.wallTime = Date.now();
        void writeSavedWorld(snapshotWorld(world)).catch((error: unknown) => {
          console.error("Failed to save world.", error);
        });
      };

      // Pixi v8 Text renders through the browser font system and won't re-layout when a
      // face loads later, so ensure "Coming Soon" is decoded before the first Text is built;
      // otherwise the first frame draws in the monospace fallback. A load failure is
      // non-fatal — the fallback in fontFamily still renders.
      try {
        await document.fonts.load('16px "Coming Soon"');
      } catch (error) {
        console.error("Failed to load the Coming Soon font; falling back.", error);
      }
      if (disposed) return;

      await app.init({
        width: WIDTH,
        height: PADDING * 2 + ROW_HEIGHT * (world.warehouses.length + world.deposits.length),
        background: 0x0e1a24,
        antialias: true,
        resolution: window.devicePixelRatio,
        autoDensity: true,
      });
      // StrictMode runs the effect twice in dev; the first pass may have been torn down
      // before init resolved. Bail without touching the DOM.
      if (disposed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      live = app;

      const barWidth = WIDTH - PADDING * 2;

      // One bar per node. A warehouse bar fills toward capacity (blue); a deposit bar drains
      // its reserve toward the floor (amber). Each row owns an update(t) closure that memoizes
      // its last frac/text, so the frame loop only touches Pixi when a value actually moved.
      type Row = { update: (t: number) => void };
      const rows: Row[] = [];

      const makeBar = (
        label: string,
        index: number,
        tint: number,
      ): { fill: Sprite; readout: Text } => {
        const row = new Container();
        row.x = PADDING;
        row.y = PADDING + index * ROW_HEIGHT;
        const labelText = new Text({
          text: label,
          style: { fill: 0xcfe6f2, fontSize: 16, fontFamily: '"Coming Soon", monospace' },
        });
        const readout = new Text({
          text: "",
          style: { fill: 0x8fb2c4, fontSize: 16, fontFamily: '"Coming Soon", monospace' },
        });
        // Right-align to the bar's right edge; label stays left-aligned at x=0.
        readout.anchor.set(1, 0);
        readout.x = barWidth;
        const track = new Graphics().roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0x14303f);
        track.y = 24;
        // Plain rect Sprite, not Graphics: width is set every tick to reflect frac, and a
        // Sprite resize is a cheap transform (no geometry rebuild/GPU re-upload) vs. Graphics'
        // clear()+redraw. A static rounded-rect mask restores the track's corner rounding
        // without putting Graphics back in the frame path.
        const fill = new Sprite(Texture.WHITE);
        fill.tint = tint;
        fill.y = 24;
        fill.height = BAR_HEIGHT;
        const corners = new Graphics().roundRect(0, 0, barWidth, BAR_HEIGHT, 4).fill(0xffffff);
        corners.y = 24;
        fill.mask = corners;
        row.addChild(track, fill, corners, labelText, readout);
        app.stage.addChild(row);
        return { fill, readout };
      };

      const setFrac = (fill: Sprite, frac: number): void => {
        fill.width = Math.max(1, barWidth * frac);
      };

      world.warehouses.forEach((wh, i) => {
        const { fill, readout } = makeBar(wh.label, i, 0x3fa7d6);
        const capacity = getWarehouse(world.state, wh.id).capacity;
        let lastFrac = NaN;
        let lastAmount = NaN;
        let lastOut = NaN;
        rows.push({
          update: (t): void => {
            const amount = warehouseAmountAt(world.state, wh.id, t);
            const frac = capacity > 0 ? amount / capacity : 0;
            if (frac !== lastFrac) {
              lastFrac = frac;
              setFrac(fill, frac);
            }
            const out = warehouseOutflowRate(world.state, wh.id);
            // Floor stock, ceil deposits: never show a resource the player can't spend, never
            // show a deposit as empty while it still has remainder. Epsilon absorbs analytic
            // float error so a logical 2 at 1.9999999999 doesn't floor to 1.
            const roundedAmount = Math.floor(amount + 1e-9);
            const roundedOut = Math.round(out * 10) / 10;
            if (roundedAmount !== lastAmount || roundedOut !== lastOut) {
              lastAmount = roundedAmount;
              lastOut = roundedOut;
              readout.text = `${roundedAmount} / ${capacity}  (−${roundedOut.toFixed(1)}/s)`;
            }
          },
        });
      });

      world.deposits.forEach((dep, i) => {
        const { fill, readout } = makeBar(dep.label, world.warehouses.length + i, 0xd6a13f);
        // Reserve above the floor = sum of tier amounts; tier amounts never mutate, so this is
        // a stable bar denominator captured once.
        let reserve = 0;
        for (const tier of getDeposit(world.state, dep.id).tiers) reserve += tier.amount;
        let lastFrac = NaN;
        let lastRemaining = NaN;
        let lastMult = NaN;
        rows.push({
          update: (t): void => {
            const remaining = depositRemainingAt(world.state, dep.id, t);
            const frac = reserve > 0 ? remaining / reserve : 0;
            if (frac !== lastFrac) {
              lastFrac = frac;
              setFrac(fill, frac);
            }
            const mult = depositMultiplier(world.state, dep.id);
            const roundedRemaining = Math.ceil(remaining - 1e-9);
            if (roundedRemaining !== lastRemaining || mult !== lastMult) {
              lastRemaining = roundedRemaining;
              lastMult = mult;
              readout.text = `${roundedRemaining} / ${reserve}  (×${mult})`;
            }
          },
        });
      });

      // One build button per deposit, created imperatively so the React tree stays static and
      // the frame loop can drive each button's disabled state without a re-render. Each caches
      // its cost Map and island once (the frame loop must not allocate — perf doc) and rewrites
      // its own label/disabled only when the underlying state actually changes.
      type BuildButton = { update: (t: number) => void };
      const buttons: BuildButton[] = [];
      controls.textContent = ""; // StrictMode re-run: drop any buttons the prior pass appended
      for (const dep of world.deposits) {
        const el = document.createElement("button");
        el.type = "button";
        const costMap = new Map<ResourceType, number>(dep.cost);
        const island: IslandId = getWarehouse(world.state, dep.warehouseId).islandId;
        const costLabel = dep.cost.map(([resource, amount]) => `${amount} ${resource}`).join(", ");
        el.addEventListener("click", () => {
          // Save-on-command: persist only when the build actually happened; a rejected build
          // (unaffordable) leaves state untouched, so there is nothing to save.
          if (buildExtractor(world, dep.id, epochAtStart + clock.now())) requestSave?.();
        });
        controls.appendChild(el);
        let lastBuilt: boolean | null = null;
        let lastEnabled: boolean | null = null;
        buttons.push({
          update: (t): void => {
            const isBuilt = isExtractorBuilt(world, dep.id);
            const enabled = !isBuilt && canAffordBuild(world.state, t, island, costMap);
            if (isBuilt !== lastBuilt) {
              lastBuilt = isBuilt;
              el.textContent = isBuilt
                ? `${dep.label} — extractor built`
                : `Build extractor · ${dep.label} (${costLabel})`;
            }
            if (enabled !== lastEnabled) {
              lastEnabled = enabled;
              el.disabled = !enabled;
            }
          },
        });
      }

      const tick = (): void => {
        const t = epochAtStart + clock.now();
        advance(world.state, t);
        // Indexed loop: iterator protocol allocates per step on JSC (perf doc, frame loop).
        for (let i = 0; i < rows.length; i++) {
          rows[i]?.update(t);
        }
        for (let i = 0; i < buttons.length; i++) {
          buttons[i]?.update(t);
        }
      };
      tick();
      app.ticker.add(tick);
    })().catch((error: unknown) => {
      if (disposed) return;
      host.textContent = `Pixi init failed: ${String(error)}`;
    });

    return () => {
      disposed = true;
      controls.textContent = ""; // drop the imperatively-created build buttons
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(autosave);
      // Only destroy a fully-initialized app; if init hasn't resolved, the disposed
      // guard destroys it once when it does. app.ticker.remove(tick) is unnecessary —
      // destroy() tears down the app's own ticker (sharedTicker: false by default).
      if (live !== null) live.destroy(true);
    };
  }, []);

  return (
    <div>
      <div ref={hostRef} />
      <div ref={controlsRef} />
    </div>
  );
}
