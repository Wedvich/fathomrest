import { afterEach, describe, expect, it, vi } from "vitest";

import { createSimClock } from "./simClock.ts";

// Drive both clocks by hand: perf = monotonic (freezes during suspension),
// wall = Date.now() (keeps counting, can jump backward).
function mockClocks(): { setPerf: (ms: number) => void; setWall: (ms: number) => void } {
  let perf = 0;
  let wall = 0;
  vi.spyOn(performance, "now").mockImplementation(() => perf);
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  return {
    setPerf: (ms) => {
      perf = ms;
    },
    setWall: (ms) => {
      wall = ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("simClock", () => {
  it("tracks the monotonic clock between reanchors", () => {
    const clocks = mockClocks();
    const clock = createSimClock();
    clocks.setPerf(2500);
    clocks.setWall(2500);
    expect(clock.now()).toBe(2.5);
  });

  it("folds suspended wall time in on reanchor", () => {
    const clocks = mockClocks();
    const clock = createSimClock();
    // 10s of real time, of which the monotonic clock saw only 3s (7s suspension).
    clocks.setPerf(3000);
    clocks.setWall(10_000);
    clock.reanchor();
    expect(clock.now()).toBe(10);
    // Time keeps flowing off the monotonic clock from the new anchor.
    clocks.setPerf(4000);
    expect(clock.now()).toBe(11);
  });

  it("ignores sub-threshold jitter but accumulates repeated small freezes", () => {
    const clocks = mockClocks();
    const clock = createSimClock();
    // 0.6s lost — below the 1s threshold, no jump.
    clocks.setPerf(1000);
    clocks.setWall(1600);
    clock.reanchor();
    expect(clock.now()).toBe(1);
    // Another 0.6s lost. Anchors didn't move, so total lost (1.2s) now folds in.
    clocks.setPerf(2000);
    clocks.setWall(3200);
    clock.reanchor();
    expect(clock.now()).toBe(3.2);
  });

  it("never rewinds when the wall clock is set backward", () => {
    const clocks = mockClocks();
    const clock = createSimClock();
    clocks.setPerf(5000);
    clocks.setWall(-3_600_000); // user sets clock back an hour
    clock.reanchor();
    expect(clock.now()).toBe(5);
  });
});
