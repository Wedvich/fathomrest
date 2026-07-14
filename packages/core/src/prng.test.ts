import { describe, expect, it } from "vitest";

import { createPrng, nextFloat01, nextU32 } from "./prng.ts";

describe("prng", () => {
  it("reproduces the same sequence from the same seed", () => {
    const a = createPrng(42);
    const b = createPrng(42);
    for (let i = 0; i < 1000; i += 1) {
      expect(nextU32(a)).toBe(nextU32(b));
    }
  });

  it("produces different sequences from different seeds", () => {
    const a = createPrng(1);
    const b = createPrng(2);
    const draws = Array.from({ length: 8 }, () => [nextU32(a), nextU32(b)]);
    expect(draws.some(([x, y]) => x !== y)).toBe(true);
  });

  it("keeps floats in [0, 1)", () => {
    const prng = createPrng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = nextFloat01(prng);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("resumes identically from a copied state snapshot", () => {
    const original = createPrng(99);
    for (let i = 0; i < 5; i += 1) {
      nextU32(original);
    }
    const resumed = { ...original };
    for (let i = 0; i < 100; i += 1) {
      expect(nextU32(resumed)).toBe(nextU32(original));
    }
  });
});
