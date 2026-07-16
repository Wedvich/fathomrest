import {
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  advance,
  createSimState,
  deserializeState,
  offlineElapsedSeconds,
  serializeState,
  setWarehousePullRate,
  type Id,
  type SaveDocument,
  type SimState,
} from "@fathomrest/core";

// Placeholder archipelago scene. Built entirely through the core command surface at
// t=0, so the ticker just advances forward from epoch 0. Pure core calls — no
// React/Pixi here (core stays UI-agnostic).
export interface DemoWorld {
  state: SimState;
  warehouses: readonly { id: Id; label: string }[];
}

// App-level save envelope: the canonical core document plus the UI view model (warehouse
// labels) the core doesn't carry. Persisted as-is (persistence.ts). Kept separate from
// the core SaveDocument so the sim's serialization never depends on presentation.
export interface SavedWorld {
  doc: SaveDocument;
  warehouses: readonly { id: Id; label: string }[];
}

export function createDemoWorld(seed: number, wallTimeMs: number): DemoWorld {
  const state = createSimState(seed, wallTimeMs);

  // Rich vein that depletes to a lean perpetual floor.
  const oreDeposit = addDeposit(state, 0, [{ amount: 500, multiplier: 2 }], 0.5);

  const pierWarehouse = addWarehouse(state, 0, 100);
  const depotWarehouse = addWarehouse(state, 0, 200);

  addExtractor(state, 0, 5, oreDeposit, pierWarehouse);

  // Pier drains a little locally and ships the surplus up the route to the depot.
  setWarehousePullRate(state, 0, pierWarehouse, 3);
  addRoute(state, 0, pierWarehouse, depotWarehouse, 4);

  return {
    state,
    warehouses: [
      { id: pierWarehouse, label: "Pier" },
      { id: depotWarehouse, label: "Depot" },
    ],
  };
}

export function snapshotWorld(world: DemoWorld): SavedWorld {
  return { doc: serializeState(world.state), warehouses: world.warehouses };
}

// Rebuild a world from a save, folding the wall-clock gap since save into sim time
// (offline catch-up, ADR-0001 §4). The saved (epoch, wallTime) pair stays a valid anchor
// afterward — the next save re-stamps wallTime — so wallTime is left as-is here.
export function restoreWorld(saved: SavedWorld, nowMs: number): DemoWorld {
  const state = deserializeState(saved.doc);
  advance(state, state.epoch + offlineElapsedSeconds(nowMs, state.wallTime));
  return { state, warehouses: saved.warehouses };
}
