import { TOKEN } from '@shardkeep/shared';

/** The token model's absolute whole-KEEP ceiling. The current devnet mint is
 * smaller, but no legitimate wallet can transfer more than its chain balance. */
export const MAX_KEEP_DEPOSIT = BigInt(TOKEN.totalSupply);

/** Mobile-friendly input normalization. Commas/spaces are accepted on paste;
 * any other character is rejected without corrupting the controlled field. */
export function normalizeKeepDepositInput(raw: string): string | null {
  const compact = raw.replace(/[\s,]/g, '');
  if (!/^\d*$/.test(compact)) return null;
  return compact.replace(/^0+(?=\d)/, '');
}

export function parseKeepDepositAmount(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  const amount = BigInt(raw);
  return amount >= 1n && amount <= MAX_KEEP_DEPOSIT ? amount : null;
}

/** Add an optional shortcut without ever crossing the same authoritative UI
 * bound used by typed/pasted values. Empty input behaves as zero. */
export function addKeepDepositAmount(raw: string, delta: bigint): string | null {
  const current = raw === '' ? 0n : parseKeepDepositAmount(raw);
  if (current === null || delta <= 0n) return null;
  const next = current + delta;
  return next <= MAX_KEEP_DEPOSIT ? next.toString() : null;
}

export function formatWholeKeep(amount: bigint): string {
  return amount.toLocaleString('en-US');
}
