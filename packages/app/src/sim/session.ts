// The sim session: owns the loaded world, the sim clock, and the persistence
// lifecycle. Extracted from PixiReadout so the React shell and the Pixi scene share
// one clock and one command path — the Pixi frame loop draws imperatively, React
// panels read event-driven + coarse timer (≥250 ms, docs/browser-performance.md),
// and both mutate only through command().

import { advance } from "@fathomrest/core";

import {
  ensurePersistentStorage,
  loadSavedWorld,
  quarantineCorruptSave,
  readSaveBreadcrumb,
  writeSavedWorld,
} from "../persistence.ts";
import { createSimClock } from "../simClock.ts";
import {
  createDemoWorld,
  restoreWorld,
  snapshotWorld,
  type DemoWorld,
  type SavedWorld,
} from "./world.ts";

// Autosave cadence. Elapsed time is reconstructed from the saved (epoch, wallTime) anchor
// on load, so this need not be tight for time-tracking — it bounds how much player state
// a crash could lose. Lifecycle events (hidden/pagehide) save too, but teardown-time
// saves are unreliable: WebKit drops ones needing an async open hop (persistence.ts holds
// one long-lived connection to dodge that), and Firefox aborts even a synchronous
// pagehide put. This interval and save-on-command are the writes that always land.
const AUTOSAVE_INTERVAL_MS = 15_000;

export interface SimSession {
  readonly world: DemoWorld;
  /** Canonical current sim time: the loaded save's epoch + sim seconds since creation. */
  now(): number;
  /** Advance the sim to now() and return that t — the t all query reads must use. */
  advanceToNow(): number;
  /** Persist at current sim time. No-op when persistence is disabled (failed load). */
  requestSave(): void;
  /**
   * Run a command at now() and return that t. When the command acted (returned
   * true), persist at that same t and notify subscribers; a rejected command
   * leaves state untouched, so neither happens.
   */
  command(run: (t: number) => boolean): number;
  /** Change feed for React reads: fires after every acted command. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Remove lifecycle listeners and the autosave interval. Does not save. */
  dispose(): void;
}

// Loads the world from IndexedDB (with offline catch-up) or creates a fresh demo
// world, then wires the lifecycle saves: visibility-hidden, pagehide, and a periodic
// backstop. Sim time comes from simClock: monotonic between frames, re-anchored
// against the wall clock on visibility-return and persisted pageshow, so time lost to
// OS-level tab suspension (Safari) is caught up in one advance() — per
// docs/browser-performance.md §lifecycle / ADR-0001 §4.
export async function createSimSession(): Promise<SimSession> {
  ensurePersistentStorage();

  const clock = createSimClock();

  // Set once the world is loaded; the lifecycle listeners below are save no-ops until
  // then. They are installed BEFORE the async load so a suspension during the load
  // still reanchors the clock on return.
  let saveNow: (() => void) | null = null;

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      clock.reanchor();
    } else {
      saveNow?.();
    }
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) clock.reanchor();
  };
  const onPageHide = (): void => saveNow?.();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
  const autosave = window.setInterval(() => saveNow?.(), AUTOSAVE_INTERVAL_MS);

  const removeLifecycle = (): void => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("pagehide", onPageHide);
    window.clearInterval(autosave);
  };

  try {
    // A failed read (e.g. Safari's transient "connection lost" right after navigation —
    // persistence.ts retries once before giving up) is NOT the same as "no save exists".
    // Treating it as such and then autosaving the resulting fresh world clobbers the
    // real save a few seconds later — this was the "save resets every 2-10 refreshes"
    // bug. On a genuine read failure this session runs in-memory with persistence
    // disabled instead, leaving the existing save alone for the next reload to retry.
    let saved: SavedWorld | null = null;
    let persistenceDisabled = false;
    try {
      saved = await loadSavedWorld();
    } catch (error) {
      persistenceDisabled = true;
      console.error("Failed to load saved world; continuing without persistence.", error);
    }
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
    // forward-migrates older documents (e.g. v1 saves gain the islandId field), so a
    // routine schema bump preserves idle progress rather than resetting it.
    let world: DemoWorld | null = null;
    if (saved !== null) {
      try {
        if (!("deposits" in saved))
          throw new Error("save predates the deposits/buildSite envelope");
        world = restoreWorld(saved, Date.now());
      } catch (error) {
        // Unrestorable save: quarantined (not destroyed) for post-mortem, and the main
        // slot cleared so the epoch guard accepts the fresh world's saves (ADR-0001 §8).
        console.error("Saved world failed to restore; quarantining it and starting fresh.", error);
        void quarantineCorruptSave(saved).catch((qError: unknown) => {
          console.error("Failed to quarantine the corrupt save.", qError);
        });
      }
    }
    // Const rebinding: closures below must see DemoWorld, not the `let … | null`.
    const loaded = world ?? createDemoWorld(1, Date.now());
    // Canonical current sim time is epochAtStart + clock.now(): clock.now() grows from 0
    // at creation, epochAtStart carries any epoch a loaded save already advanced to.
    const epochAtStart = loaded.state.epoch;

    const now = (): number => epochAtStart + clock.now();
    const advanceToNow = (): number => {
      const t = now();
      advance(loaded.state, t);
      return t;
    };

    // Persist the world as-is; callers must already have advanced state to the time
    // being persisted, so save-on-command lands at exactly the command's t.
    const persist = (): void => {
      if (persistenceDisabled) return;
      loaded.state.wallTime = Date.now();
      void writeSavedWorld(snapshotWorld(loaded)).catch((error: unknown) => {
        console.error("Failed to save world.", error);
      });
    };
    const requestSave = (): void => {
      advanceToNow();
      persist();
    };
    saveNow = requestSave;

    const listeners = new Set<() => void>();

    return {
      world: loaded,
      now,
      advanceToNow,
      requestSave,
      command(run: (t: number) => boolean): number {
        const t = advanceToNow();
        if (run(t)) {
          persist();
          for (const listener of listeners) listener();
        }
        return t;
      },
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose(): void {
        removeLifecycle();
        listeners.clear();
      },
    };
  } catch (error) {
    removeLifecycle(); // don't leak lifecycle listeners when creation itself fails
    throw error;
  }
}
