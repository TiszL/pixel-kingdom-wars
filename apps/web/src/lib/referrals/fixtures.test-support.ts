import type { ReferralStatusV1, ReferralUseV1Response } from '@shardkeep/shared/referrals';
import type { ReferralIdentity } from './journal';
export const identity: ReferralIdentity = { api: 'https://game.example/api', wallet: '1'.repeat(32), cluster: 'devnet' };
export const relationship = { id: '00000000-0000-4000-8000-000000000001', refereeWallet: identity.wallet, referrerWallet: '2'.repeat(32), createdAt: '2026-09-13T00:00:00.000Z' };
export const status = (bound = false): ReferralStatusV1 => ({ version: 1, wallet: identity.wallet, relationship: bound ? relationship : null });
export const response = (outcome: ReferralUseV1Response['outcome'] = 'applied', submittedCode = 'KEEP-ABCDE'): ReferralUseV1Response => ({ version: 1, wallet: identity.wallet, submittedCode, outcome, relationship });
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
