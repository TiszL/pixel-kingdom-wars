/** Web boundary around the unchanged native parity port. Kotlin Int cannot be
 * NaN/fractional, but JavaScript values can. Rejected values never reach a helper
 * that can return an enabled action. Exact transport quantities remain strings
 * in SmeltAdapter and do not pass through these presentation-count helpers. */
import { quoteArmStart, smeltPrimaryCommand } from './GoldForgeLogic';
import type { SmeltState } from './goldForgeModel';
import type { CommandUi } from '../types';

// Platform type bound, not an economy cap. Keep the native Int32 representation.
const INT32_MAX = 2 ** 31 - 1;
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= INT32_MAX;
}

/** Null is invalid, never an empty basket. The sum must also fit the UI's Int32. */
export function validatedBasketCount(tiles: readonly { chosen: unknown }[]): number | null {
  let total = 0;
  for (const tile of tiles) {
    if (!count(tile.chosen) || tile.chosen > INT32_MAX - total) return null;
    total += tile.chosen;
  }
  return total;
}

export function validatedSmeltCommand(state: SmeltState, items: unknown,
  payoutIn: string | null = null, reason: string | null = null): CommandUi {
  if (!count(items)) {
    // Use a known-valid empty count only to obtain the shared command structure.
    return { ...smeltPrimaryCommand('CHOOSING', 0), state: 'DISABLED', sub: null,
      reason: 'Check the basket quantities.' };
  }
  return smeltPrimaryCommand(state, items, payoutIn, reason);
}

/** Null prevents the consumer from arming. No local clock read or guessed time.
 * The owner still owns the quote identity and must recheck it at confirmation. */
export function normalizeSpendArmedAt(value: { quotedAtMs: number; armedAtMs?: number }): number | null {
  const armed = value.armedAtMs ?? value.quotedAtMs;
  if (!Number.isSafeInteger(value.quotedAtMs) || value.quotedAtMs < 0
    || !Number.isSafeInteger(armed) || armed < 0) return null;
  return quoteArmStart(armed, value.quotedAtMs);
}
