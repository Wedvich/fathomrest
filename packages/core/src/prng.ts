// sfc32 — deterministic, arithmetic/bit-ops only (exact in every engine), state is four
// plain numbers so it serializes as-is in the save document. The only randomness source
// in the core; Math.random is banned here (ADR-0001 §5).

export interface PrngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

export function createPrng(seed: number): PrngState {
  const prng: PrngState = {
    a: 0x9e3779b9 ^ (seed >>> 0),
    b: 0x243f6a88,
    c: 0xb7e15162,
    d: (seed >>> 0) | 1,
  };
  // Discard warm-up outputs so nearby seeds decorrelate.
  for (let i = 0; i < 12; i += 1) {
    nextU32(prng);
  }
  return prng;
}

export function nextU32(prng: PrngState): number {
  const t = (((prng.a + prng.b) | 0) + prng.d) | 0;
  prng.d = (prng.d + 1) | 0;
  prng.a = prng.b ^ (prng.b >>> 9);
  prng.b = (prng.c + (prng.c << 3)) | 0;
  prng.c = (((prng.c << 21) | (prng.c >>> 11)) + t) | 0;
  return t >>> 0;
}

// Uniform in [0, 1): 32 bits over 2^32 — exact division, engine-independent.
export function nextFloat01(prng: PrngState): number {
  return nextU32(prng) / 4294967296;
}
