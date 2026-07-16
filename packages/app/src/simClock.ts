// App-side sim-second clock. performance.now() drives smooth per-frame time but can
// freeze during OS-level tab suspension (Safari); Date.now() keeps counting but can
// jump when the user's clock changes. now() runs purely off the monotonic clock;
// reanchor() — call on visibility-return and persisted pageshow, per
// docs/browser-performance.md §lifecycle — folds in wall-clock time the monotonic
// clock missed, and never moves sim time backward.

// Below this, monotonic/wall divergence is treated as jitter, not suspension. Anchors
// stay put on a skipped reanchor, so repeated small freezes still accumulate against
// the original anchor and fold in once they cross the threshold.
const REANCHOR_THRESHOLD_S = 1;

export interface SimClock {
  /** Sim seconds since creation. Monotonic. */
  now(): number;
  /** Fold in wall-clock time lost to suspension; no-op below the jitter threshold. */
  reanchor(): void;
}

export function createSimClock(): SimClock {
  let simAtAnchor = 0;
  let perfAtAnchor = performance.now();
  let wallAtAnchor = Date.now();

  return {
    now(): number {
      return simAtAnchor + (performance.now() - perfAtAnchor) / 1000;
    },
    reanchor(): void {
      const perfNow = performance.now();
      const wallNow = Date.now();
      const perfDelta = (perfNow - perfAtAnchor) / 1000;
      // Wall time that elapsed while the monotonic clock was frozen. Clamped at zero
      // so a user clock set backward can never rewind sim time.
      const lost = Math.max(0, (wallNow - wallAtAnchor) / 1000 - perfDelta);
      if (lost < REANCHOR_THRESHOLD_S) return;
      simAtAnchor += perfDelta + lost;
      perfAtAnchor = perfNow;
      wallAtAnchor = wallNow;
    },
  };
}
