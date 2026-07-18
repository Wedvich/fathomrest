// Display rounding for analytic quantities (ADR-0001): amounts are closed-form
// floats, so a logical 2 can sit at 1.9999999999 — the epsilon absorbs that float
// error. Direction is the spend-safety convention: floor stock/progress (never show
// a resource the player can't spend), ceil remainders (never show a deposit as
// empty while it still has remainder).

const EPSILON = 1e-9;

/** Floor a stock/progress amount for display. */
export function displayFloor(amount: number): number {
  return Math.floor(amount + EPSILON);
}

/** Ceil a remainder for display. */
export function displayCeil(amount: number): number {
  return Math.ceil(amount - EPSILON);
}
