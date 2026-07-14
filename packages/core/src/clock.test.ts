import { describe, expect, it } from "vitest";

import { offlineElapsedSeconds } from "./clock.ts";

describe("clock", () => {
  it("converts a forward wall-clock gap to seconds", () => {
    expect(offlineElapsedSeconds(90_000, 30_000)).toBe(60);
  });

  it("clamps a rolled-back wall clock to zero", () => {
    expect(offlineElapsedSeconds(30_000, 90_000)).toBe(0);
  });
});
