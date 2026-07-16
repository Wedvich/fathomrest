import type { Id } from "../ids.ts";
import type { ResourceType } from "../resource.ts";
import type { SimState } from "../state.ts";

// A rich phase decaying to a perpetual trickle (DESIGN.md economy). The "curve" is
// stepped richness tiers — ADR-0001 §2 forbids rate-on-level feedback, and steps keep
// crossing times arithmetic-closed (docs/browser-performance.md: float determinism).
export interface DepositTier {
  // Units extractable while this tier is active; crossing to the next tier is an event.
  readonly amount: number;
  // Scales the draw rate of every extractor on this deposit while the tier is active.
  readonly multiplier: number;
}

export interface Deposit {
  // The resource this deposit yields; extractors on it must feed a warehouse of the same
  // type (sim.ts: addExtractor). Opaque tag, compared only for equality.
  resource: ResourceType;
  tiers: readonly DepositTier[];
  // Index into tiers; tiers.length means the floor regime (infinite, floorMultiplier).
  tierIndex: number;
  floorMultiplier: number;
  // Closed-form anchor for the CURRENT tier: remaining(t) = anchorRemaining -
  // depletionRate * (t - anchorTime), clamped to >= 0. Pinned at 0 in the floor regime.
  anchorRemaining: number;
  anchorTime: number;
  // Sum of actual (throttle-adjusted) extractor draws; cached at derive time so
  // queries stay allocation-free. 0 in the floor regime.
  depletionRate: number;
  // Bumped on every re-derivation; a scheduled crossing with a stale seq is dead.
  eventSeq: number;
}

// All creation goes through the factory so every instance has one shape
// (docs/browser-performance.md: stable shapes). Tiers are copied — callers keep no
// mutable handle into the component.
export function createDeposit(
  resource: ResourceType,
  tiers: readonly DepositTier[],
  floorMultiplier: number,
  anchorTime: number,
): Deposit {
  const first = tiers[0];
  return {
    resource,
    tiers: tiers.map((tier) => ({ amount: tier.amount, multiplier: tier.multiplier })),
    tierIndex: 0,
    floorMultiplier,
    anchorRemaining: first === undefined ? 0 : first.amount,
    anchorTime,
    depletionRate: 0,
    eventSeq: 0,
  };
}

// Table accessors — the only way core code touches the deposit table. Iteration order
// is owned here (Map insertion order), keeping replay deterministic
// (docs/browser-performance.md: table access boundary).
export function getDeposit(state: SimState, id: Id): Deposit {
  const deposit = state.deposits.get(id);
  if (deposit === undefined) {
    throw new Error(`no deposit ${id}`);
  }
  return deposit;
}

export function setDeposit(state: SimState, id: Id, deposit: Deposit): void {
  state.deposits.set(id, deposit);
}

export function forEachDeposit(state: SimState, fn: (id: Id, deposit: Deposit) => void): void {
  for (const [id, deposit] of state.deposits) {
    fn(id, deposit);
  }
}

export function depositIds(state: SimState): Id[] {
  return [...state.deposits.keys()];
}
