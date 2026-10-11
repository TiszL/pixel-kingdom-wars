import type { TrainingFreeFinishOffer } from '@shardkeep/shared';

export interface PendingFreeFinish {
  wallet: string;
  baseId: string | null;
  idempotencyKey: string;
  freeOffer: TrainingFreeFinishOffer['offer'];
  consent: TrainingFreeFinishOffer['consent'];
}
const key = (wallet: string): string => `pkw:training-free-finish:${wallet}`;

/** Keep the exact zero-cost request through response loss or a wallet handoff.
 * Storage failures stop the request before transport, just like batch training. */
export function readFreeFinish(wallet: string): PendingFreeFinish | null {
  const raw = localStorage.getItem(key(wallet));
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingFreeFinish;
  if (value.wallet !== wallet || typeof value.idempotencyKey !== 'string' || !value.idempotencyKey
    || (value.baseId !== null && typeof value.baseId !== 'string') || value.freeOffer !== 'first_troops'
    || value.consent?.version !== 2 || value.consent.maxCostKeep !== '0' || !Array.isArray(value.consent.queue)) {
    throw new Error('Saved free training request could not be read. Refresh before finishing training.');
  }
  return value;
}
export function saveFreeFinish(value: PendingFreeFinish): void {
  localStorage.setItem(key(value.wallet), JSON.stringify(value));
}
export function clearFreeFinish(value: PendingFreeFinish): void {
  if (readFreeFinish(value.wallet)?.idempotencyKey === value.idempotencyKey) localStorage.removeItem(key(value.wallet));
}
export function verifyFreeFinish(raw: unknown, request: PendingFreeFinish): void {
  const result = raw as { cost?: unknown; completed?: Array<{ troop?: unknown; count?: unknown }> } | null;
  if (result?.cost !== '0' || !Array.isArray(result.completed) || !result.completed.length
    || result.completed.some((row) => typeof row.troop !== 'string' || !Number.isSafeInteger(row.count) || Number(row.count) <= 0)
    || result.completed.reduce((total, row) => total + Number(row.count), 0) > request.consent.queue.length) {
    throw new Error('Free finish confirmation is incomplete. Check the original request before finishing again.');
  }
}
