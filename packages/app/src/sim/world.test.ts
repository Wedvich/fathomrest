import { advance, warehouseAmountAt } from "@fathomrest/core";
import { describe, expect, it } from "vitest";

import {
  buildExtractor,
  createDemoWorld,
  isExtractorBuilt,
  restoreWorld,
  snapshotWorld,
} from "./world.ts";

// The first-interaction loop test as a scenario: the build site is idle until the player
// builds, building starts income at the command time, and the mutation survives a
// save/reload round-trip (structuredClone stands in for IndexedDB's structured clone,
// mirroring persistence.ts). Drives the real core commands, no mocks.
describe("build-extractor interaction", () => {
  it("quarry stays idle until an extractor is built", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    advance(world.state, 60);

    expect(isExtractorBuilt(world)).toBe(false);
    expect(warehouseAmountAt(world.state, quarry, 60)).toBe(0);
  });

  it("building starts income from the command time", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    advance(world.state, 20);
    buildExtractor(world, 20);

    expect(isExtractorBuilt(world)).toBe(true);
    // rate 5 * tier multiplier 2 = 10/s, 10s elapsed since the t=20 build.
    expect(warehouseAmountAt(world.state, quarry, 30)).toBeCloseTo(100, 9);
  });

  it("is idempotent — a second build does not add a second extractor", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    buildExtractor(world, 10);
    buildExtractor(world, 20);

    // A duplicate producer would double the draw; capacity is 100, so 10/s fills in 10s.
    expect(warehouseAmountAt(world.state, quarry, 30)).toBeCloseTo(100, 9);
  });

  it("survives a save/reload round-trip", () => {
    const world = createDemoWorld(1, 0);
    const quarry = world.buildSite.warehouseId;

    advance(world.state, 15);
    buildExtractor(world, 15);
    world.state.wallTime = 0;

    const saved = structuredClone(snapshotWorld(world));
    const restored = restoreWorld(saved, 0); // now == wallTime: no offline gap

    expect(isExtractorBuilt(restored)).toBe(true);
    expect(restored.deposits).toEqual(world.deposits);
    advance(restored.state, 20);
    expect(warehouseAmountAt(restored.state, quarry, 20)).toBeCloseTo(50, 9);
  });
});
