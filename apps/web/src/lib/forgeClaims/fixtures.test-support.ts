import type { ForgeClaimReceipt, ForgeClaimStatusSchema } from '@shardkeep/shared/forgeClaims';
import type { BasesDto } from '../api';
import type { ForgeClaimIdentity, ForgeClaimIntent } from './journal';
export const identity: ForgeClaimIdentity = { api: 'https://game.example/api', wallet: '11111111111111111111111111111111', cluster: 'devnet' };
export const target = '22222222222222222222222222222222';
export const key = '00000000-0000-4000-8000-000000000001';
export const baseA = '00000000-0000-4000-8000-000000000002';
export const baseB = '00000000-0000-4000-8000-000000000003';
export const ledger = '00000000-0000-4000-8000-000000000004';
export const intent = (day: string | null = null, baseId: string | null = baseA, idempotencyKey = key): ForgeClaimIntent => ({ request: { idempotencyKey, baseId, day } });
export const receipt = (day: string | null = null, baseId: string | null = baseA, empty = false): ForgeClaimReceipt => ({
  version: 1, actor: identity.wallet, idempotencyKey: key, baseId, day, createdAt: '2026-09-13T00:00:00.000Z',
  result: { claimed: empty ? [] : [{ day: day ?? '2026-09-11', keep: '777', ledgerTransactionId: ledger }], totalKeep: empty ? '0' : '777', remaining: 0 },
});
export const status = (r: ForgeClaimReceipt | null = null, enabled = true, idempotencyKey = key): ReturnType<typeof ForgeClaimStatusSchema.parse> => ({ version: 1, wallet: identity.wallet, idempotencyKey, enabled, receipt: r });
export const directory = (): BasesDto => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [
  { id: baseA, status: 'active', slot: 1 }, { id: baseB, status: 'active', slot: 2 },
] } as BasesDto);
export const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
