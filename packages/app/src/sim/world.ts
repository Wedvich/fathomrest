import {
  addDeposit,
  addExtractor,
  addRoute,
  addWarehouse,
  createSimState,
  setWarehousePullRate,
  type Id,
  type SimState,
} from "@fathomrest/core";

// Placeholder archipelago scene until save-loading exists. Built entirely through the
// core command surface at t=0, so the ticker just advances forward from epoch 0.
// Pure core calls — no React/Pixi here (core stays UI-agnostic).
export interface DemoWorld {
  state: SimState;
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
