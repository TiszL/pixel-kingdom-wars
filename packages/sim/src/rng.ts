/**
 * rng.ts — mulberry32 PRNG with 32-bit unsigned state.
 *
 * The sim's ONLY randomness source (ARCHITECTURE §6). Every draw is a pure
 * function of the seed and the draw order, so identical (snapshot, orders,
 * seed) inputs replay bit-identically on any JS engine: the generator uses
 * only 32-bit integer ops (imul, xor, shifts), which are exact everywhere.
 */

export interface Rng {
  /** Next raw 32-bit unsigned integer. */
  nextU32(): number;
  /**
   * Integer in [0, maxExclusive). maxExclusive must be a positive integer.
   * Modulo reduction: the bias is ~maxExclusive/2^32 — negligible for game
   * ranges, and irrelevant to determinism.
   */
  nextInt(maxExclusive: number): number;
  /** Pick one element of a non-empty array. */
  nextPick<T>(items: readonly T[]): T;
}

/** Standard mulberry32, state kept as u32 via `>>> 0`. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;

  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`rng.nextInt: maxExclusive must be a positive integer, got ${maxExclusive}`);
    }
    return nextU32() % maxExclusive;
  };

  const nextPick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError('rng.nextPick: empty array');
    return items[nextInt(items.length)] as T;
  };

  return { nextU32, nextInt, nextPick };
}
