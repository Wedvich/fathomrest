// Pure clock math (ADR-0001 §4). The core owns no timers — the app reads Date.now() /
// performance.now() and passes values in.

// Offline gap at load or visibility-return, clamped so a rolled-back wall clock never
// advances the sim backwards.
export function offlineElapsedSeconds(nowMs: number, savedWallTimeMs: number): number {
  return Math.max(0, (nowMs - savedWallTimeMs) / 1000);
}
