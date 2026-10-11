import type { ClanCommandReceipt } from '@shardkeep/shared/clanCommands';
import type { BasesDto } from '../api';
import type { ClanIdentity, ClanIntent } from './journal';
export const identity: ClanIdentity = { api: 'https://game.example/api', wallet: '1'.repeat(32), cluster: 'devnet' };
export const key = '00000000-0000-4000-8000-000000000001';
export const baseA = '00000000-0000-4000-8000-000000000002';
export const baseB = '00000000-0000-4000-8000-000000000003';
export const clanId = '00000000-0000-4000-8000-000000000004';
export const target = '2'.repeat(32);
export const intent = (kind: 'leave' | 'kick' = 'leave'): ClanIntent => kind === 'leave'
  ? { kind, clanName: 'Original Clan', request: { idempotencyKey: key, clanId, baseId: baseA } }
  : { kind, clanName: 'Original Clan', request: { idempotencyKey: key, clanId, wallet: target } };
export const receipt = (kind: 'leave' | 'kick' = 'leave'): ClanCommandReceipt => ({ version: 1, actor: identity.wallet, idempotencyKey: key, kind, clanId,
  baseId: kind === 'leave' ? baseA : null, target: kind === 'kick' ? target : null, state: kind === 'leave' ? 'disbanded' : 'kicked',
  payoutShards: kind === 'leave' ? '456' : '0', ledgerTransactionId: kind === 'leave' ? baseB : null, refusalCode: null, createdAt: '2026-09-13T00:00:00Z' });
export const status = (proof: ClanCommandReceipt | null = null, requestKey = key) => ({ version: 1, wallet: identity.wallet, idempotencyKey: requestKey, receipt: proof });
export const directory = (): BasesDto => ({ enabled: true, maxActive: 5, nextLandPurchaseKind: 'deed', capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
  bases: [baseA, baseB].map((id, i) => ({ id, deedAssetId: target, status: 'active', keepLevel: 3, builders: 1, expansions: 0, landPaidAt: '2026-09-12T00:00:00Z', slot: i === 0 ? 1 : 2, earthCell: null, countryA3: null })) });
export const mine = () => ({ clan: { id: clanId, name: 'Original Clan', leaderWallet: identity.wallet, roster: [{ wallet: identity.wallet }] } });
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
