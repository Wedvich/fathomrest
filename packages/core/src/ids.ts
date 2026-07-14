// Branded entity id: a plain number at runtime (serializes as-is), unforgeable in types.
declare const ID_BRAND: unique symbol;

export type Id = number & { readonly [ID_BRAND]: true };

// Mint site for rehydrating ids from a save document; live allocation goes through
// allocId in state.ts.
export function idFromNumber(value: number): Id {
  return value as Id;
}
