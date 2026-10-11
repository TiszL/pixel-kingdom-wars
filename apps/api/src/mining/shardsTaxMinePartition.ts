import { mineUnitCompletion } from './shardsTaxMineProduction';
export interface MineWholeUnitPartition {
  firstUnit: bigint; lastUnit: bigint; firstAtMs: bigint; lastAtMs: bigint;
  gross: bigint; covered: boolean; legacy?: boolean;
}

/** Partition an already-authoritative, capped projectMineFill gain. This never
 * computes a new production amount or resets the original fractional clock. */
export function partitionMineWholeUnits(input: {
  anchorMs: bigint; quota: bigint; dayMs: bigint; gross: bigint;
  term: { startsAtMs: bigint; endsAtMs: bigint } | null;
  /** Immutable policy boundary: units completing exactly here are new earnings. */
  legacyBeforeMs?: bigint;
  remainder?: bigint | undefined;
}): Readonly<MineWholeUnitPartition>[] {
  const { anchorMs, quota, dayMs, gross, term } = input;
  const remainder = input.remainder ?? 0n;
  if (gross < 0n || quota < 0n || dayMs <= 0n || remainder < 0n || remainder >= dayMs || (gross > 0n && quota === 0n))
    throw new Error('Invalid original Mine projection');
  if (!gross) return [];
  const completedBefore = (at: bigint) => {
    const elapsed = at - anchorMs - 1n;
    return elapsed < 0n ? 0n : (remainder + elapsed * quota) / dayMs;
  };
  const clamp = (n: bigint) => n < 0n ? 0n : n > gross ? gross : n;
  const first = term ? clamp(completedBefore(term.startsAtMs)) : gross;
  const last = term ? clamp(completedBefore(term.endsAtMs)) : gross;
  if (term && term.endsAtMs <= term.startsAtMs) throw new Error('Invalid original term');
  const ranges = term ? [[0n, first, false], [first, last, true], [last, gross, false]] as const
    : [[0n, gross, false]] as const;
  const completion = (unit: bigint) => mineUnitCompletion(anchorMs, quota, dayMs, unit, remainder);
  const legacyEnd = input.legacyBeforeMs === undefined ? null
    : clamp(completedBefore(input.legacyBeforeMs));
  return ranges.flatMap(([a, b, covered]) => {
    // Split by original unit ordinal, never a new clock anchored at cutover.
    const slices = legacyEnd !== null && legacyEnd > a && legacyEnd < b
      ? [[a, legacyEnd], [legacyEnd, b]] : [[a, b]];
    return slices.filter(([from, to]) => to! > from!).map(([from, to]) => {
      const first = from!, last = to!, legacy = legacyEnd !== null && last <= legacyEnd;
      const part = { firstUnit: first + 1n, lastUnit: last, firstAtMs: completion(first + 1n),
        lastAtMs: completion(last), gross: last - first, covered: covered && !legacy };
      return Object.freeze(legacyEnd === null ? part : { ...part, legacy });
    });
  });
}
