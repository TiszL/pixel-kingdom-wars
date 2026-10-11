/** Owner-admitted quantities retain their state; display text never establishes spend admission. */
export type HudResourceAmount =
  | { readonly status: 'loading' | 'absent' | 'unavailable' }
  | { readonly status: 'known'; readonly value: string; readonly decimals: number; readonly unit: 'BASE_UNITS' | 'DECIMAL' };

/**
 * Native HudResourceAmount grammar bounds (129fa866), shared by drawer and Home readouts.
 * These are parser limits, never gameplay quantities. Amounts remain strings throughout:
 * no balance reads, floating point, rounding, locale parsing or scientific notation.
 */
export function hudAmountText(amount: HudResourceAmount): string {
  if (amount.status === 'absent') return '—';
  if (amount.status !== 'known') return '…';
  const { value, decimals, unit } = amount;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || value.length < 1 || value.length > 256) return '…';
  let whole: string;
  let fraction: string;
  if (unit === 'BASE_UNITS') {
    if (!matchesWhole(/^(?:0|[1-9][0-9]*)$/, value)) return '…';
    const split = value.length - decimals;
    whole = split > 0 ? value.slice(0, split) : '0';
    fraction = split > 0 ? value.slice(split) : '0'.repeat(-split) + value;
  } else if (unit === 'DECIMAL') {
    if (!matchesWhole(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, value)) return '…';
    const parts = value.split('.');
    whole = parts[0]!;
    fraction = parts[1] ?? '';
    if (fraction.length > decimals) return '…';
  } else return '…';
  fraction = fraction.replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/** Require whole-input equality to preserve the native quantity grammar. */
function matchesWhole(pattern: RegExp, value: string): boolean {
  return pattern.exec(value)?.[0] === value;
}
