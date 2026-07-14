import type { Id } from "../ids.ts";
import type { SimState } from "../state.ts";

// Toy-chain producer: pushes `rate` units/s into its warehouse. Exists only to exercise
// the engine plumbing (TODO.md); real mechanics replace it once the spine is green.
export interface Extractor {
  rate: number;
  warehouseId: Id;
}

// All creation goes through the factory so every instance has one shape
// (docs/browser-performance.md: stable shapes).
export function createExtractor(rate: number, warehouseId: Id): Extractor {
  return { rate, warehouseId };
}

// Table accessors — the only way core code touches the extractor table. Iteration order
// is owned here (Map insertion order), keeping replay deterministic
// (docs/browser-performance.md: table access boundary).
export function getExtractor(state: SimState, id: Id): Extractor {
  const extractor = state.extractors.get(id);
  if (extractor === undefined) {
    throw new Error(`no extractor ${id}`);
  }
  return extractor;
}

export function setExtractor(state: SimState, id: Id, extractor: Extractor): void {
  state.extractors.set(id, extractor);
}

export function forEachExtractor(
  state: SimState,
  fn: (id: Id, extractor: Extractor) => void,
): void {
  for (const [id, extractor] of state.extractors) {
    fn(id, extractor);
  }
}

export function extractorIds(state: SimState): Id[] {
  return [...state.extractors.keys()];
}
