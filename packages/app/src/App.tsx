import {
  addDeposit,
  addExtractor,
  addWarehouse,
  createSimState,
  warehouseAmountAt,
} from "@fathomrest/core";

// Placeholder proof that the app consumes the sim core. The real rAF ->
// advance(t)/query(t) wiring lands once the core surface stabilizes (TODO.md).
const state = createSimState(1, Date.now());
const warehouseId = addWarehouse(state, 0, 100);
const depositId = addDeposit(state, 0, [], 1);
addExtractor(state, 0, 2, depositId, warehouseId);

export function App(): React.JSX.Element {
  return (
    <main>
      <h1>Fathomrest</h1>
      <p>Core linked. Toy warehouse at t=30s: {warehouseAmountAt(state, warehouseId, 30)}</p>
    </main>
  );
}
