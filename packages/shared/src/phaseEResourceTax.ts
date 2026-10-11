/** D-150 resource/SHARDS earnings arithmetic only. No source classification,
 * earning authority, term/beneficiary selection, stock credit or persistence. */
import { PHASE_E_POLICY } from './constants';
import { RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';

const denominator = BigInt(PHASE_E_POLICY.basisPoints);
const islandPoolBps = BigInt(PHASE_E_POLICY.taxes.resources.islandPoolBps);

export interface ResourceEarningsSplit {
  readonly gross: bigint;
  readonly net: bigint;
  readonly tax: bigint;
  /** Unpaid fractional numerator, not whole resources or an additional credit. */
  readonly nextCarry: bigint;
}

/** Split one already-authorized new earning into player net and island tax.
 * The caller must serialize and save carry with the source's one-time receipt
 * and both amounts atomically. Carry lineage/ownership and cross-term attribution
 * remain caller policy; never reset it on collection or pay it as a second unit.
 * Bigint-only inputs deliberately reject wire strings/Numbers instead of coercing
 * them. Intermediate multiplication may exceed int64; persisted whole quantities
 * remain bounded by gross. Zero gross and exact whole-tax yields preserve carry. */
export function splitResourceEarnings(gross: bigint, priorCarry: bigint): ResourceEarningsSplit {
  if (typeof gross !== 'bigint') throw new TypeError('Resource gross must be a bigint');
  if (gross < 0n || gross > RAW_RESOURCE_STORAGE_MAX)
    throw new RangeError('Resource gross must be a nonnegative signed-int64 quantity');
  if (typeof priorCarry !== 'bigint') throw new TypeError('Resource tax carry must be a bigint');
  if (priorCarry < 0n || priorCarry >= denominator)
    throw new RangeError('Resource tax carry must be a numerator remainder within basisPoints');

  const numerator = gross * islandPoolBps + priorCarry;
  const tax = numerator / denominator;
  return { gross, net: gross - tax, tax, nextCarry: numerator % denominator };
}
