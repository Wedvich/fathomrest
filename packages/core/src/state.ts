import type { Converter } from "./components/converter.ts";
import type { Deposit } from "./components/deposit.ts";
import type { Extractor } from "./components/extractor.ts";
import type { Route } from "./components/route.ts";
import type { Warehouse } from "./components/warehouse.ts";
import { createEventQueue, type EventQueue } from "./events.ts";
import { idFromNumber, type Id } from "./ids.ts";
import { createPrng, type PrngState } from "./prng.ts";

// The full simulation document (ADR-0001 §3, §5, §8): component tables + PRNG state +
// scheduled events + clocks. This shape IS the serialization shape — everything needed
// to re-derive the world is here, and nothing else is.
export interface SimState {
  // Sim seconds since save epoch; advanced only by advance().
  epoch: number;
  // Wall-clock anchor (ms). The app re-stamps this at save time; at load,
  // offlineElapsedSeconds(now, wallTime) gives the gap to advance across.
  wallTime: number;
  // Monotonic id allocator; ids are never reused.
  nextId: number;
  prng: PrngState;
  events: EventQueue;
  extractors: Map<Id, Extractor>;
  warehouses: Map<Id, Warehouse>;
  deposits: Map<Id, Deposit>;
  routes: Map<Id, Route>;
  converters: Map<Id, Converter>;
}

export function createSimState(seed: number, wallTimeMs: number): SimState {
  return {
    epoch: 0,
    wallTime: wallTimeMs,
    nextId: 1,
    prng: createPrng(seed),
    events: createEventQueue(),
    extractors: new Map(),
    warehouses: new Map(),
    deposits: new Map(),
    routes: new Map(),
    converters: new Map(),
  };
}

export function allocId(state: SimState): Id {
  const id = idFromNumber(state.nextId);
  state.nextId += 1;
  return id;
}
