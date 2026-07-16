import type { Id } from "../ids.ts";
import type { SimState } from "../state.ts";

// Refinement: consume resource A from the source warehouse, produce resource B into the
// destination (DESIGN.md economy: "changing type is refinement's job, never a route's").
// To the flow solver a converter is a route-like transfer edge whose destination side is
// scaled by `ratio` (sim.ts: solveTransfers); it joins routes in one combined DAG, with
// self-loops, cycles, and SAME-type endpoints rejected at the command (addConverter) and
// import (serialize.ts) boundaries — a same-type converter would be a lossy/gainy route
// bypassing route conservation.
export interface Converter {
  srcId: Id;
  dstId: Id;
  // Player-set maximum consumption rate from the source, in source (A) units.
  cap: number;
  // Destination (B) units produced per source (A) unit consumed; finite and > 0.
  ratio: number;
  // Cached realized draw from the source in [0, cap], A-units (feed = flow * ratio); a
  // derive output, read allocation-free by query(t)
  // (docs/browser-performance.md: query hot path). Never accumulated incrementally.
  flow: number;
}

// All creation goes through the factory so every instance has one shape
// (docs/browser-performance.md: stable shapes).
export function createConverter(srcId: Id, dstId: Id, cap: number, ratio: number): Converter {
  return { srcId, dstId, cap, ratio, flow: 0 };
}

// Table accessors — the only way core code touches the converter table. Iteration order
// is owned here (Map insertion order), keeping replay deterministic
// (docs/browser-performance.md: table access boundary).
export function getConverter(state: SimState, id: Id): Converter {
  const converter = state.converters.get(id);
  if (converter === undefined) {
    throw new Error(`no converter ${id}`);
  }
  return converter;
}

export function setConverter(state: SimState, id: Id, converter: Converter): void {
  state.converters.set(id, converter);
}

export function forEachConverter(
  state: SimState,
  fn: (id: Id, converter: Converter) => void,
): void {
  for (const [id, converter] of state.converters) {
    fn(id, converter);
  }
}

export function converterIds(state: SimState): Id[] {
  return [...state.converters.keys()];
}
