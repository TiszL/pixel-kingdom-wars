import { gemsCommand, type GemsIntent } from './contracts';
import type { GemsIdentity } from './journal';
export const identity: GemsIdentity = { api: 'https://game.example/api', wallet: 'wallet-a', cluster: 'devnet' };
export const key = '00000000-0000-4000-8000-000000000001', base = '00000000-0000-4000-8000-000000000002';
export const intent = (kind: GemsIntent['kind'] = 'gems-from-keep'): GemsIntent => kind === 'gems-from-keep' ? { kind, idempotencyKey: key, keep: '10' }
  : kind === 'gems-to-shards' ? { kind, idempotencyKey: key, gems: '10', baseId: base } : { kind, idempotencyKey: key, taskId: 'first-task' };
export const overview = () => ({ features: { gems: { version: 1, receipts: 1, exactConsent: 1 } }, gems: '100', sources: ['ledger-keep'], minConvertKeep: 1, maxConvertKeepPerTx: 1000,
  gemsPerKeep: 2, shardsPerGem: 2, tasks: [{ id: 'first-task', gems: 10, claimed: false }], serverNow: '2026-09-21T00:00:00.000Z' });
export const inner = (i: GemsIntent): Record<string, unknown> => ({ version: 1, status: 'accepted', wallet: identity.wallet,
  receiptId: '00000000-0000-4000-8000-000000000003', acceptedAt: '2026-09-21T00:00:00.000Z',
  request: i.kind === 'gems-task-claim' ? { ...gemsCommand(i).body, taskId: i.taskId } : gemsCommand(i).body,
  ...(i.kind === 'gems-task-claim' ? { taskId: i.taskId } : { funding: { currency: i.kind === 'gems-from-keep' ? 'KEEP' : 'GEMS', amount: '10' } }),
  ...(i.kind === 'gems-to-shards' ? { baseId: i.baseId } : {}),
  result: i.kind === 'gems-to-shards' ? { shards: '20', rate: 2 } : i.kind === 'gems-from-keep' ? { gems: '20', rate: 2 } : { gems: '10' },
});
export const envelope = (i: GemsIntent, receipt: Record<string, unknown> | null) => i.kind === 'gems-to-shards' ? receipt ?? { version: 1, status: 'unknown', idempotencyKey: i.idempotencyKey }
  : { wallet: identity.wallet, idempotencyKey: i.idempotencyKey, status: receipt ? 'accepted' : 'unknown', receipt, serverNow: '2026-09-21T00:00:00.000Z' };
export const proof = (i: GemsIntent) => envelope(i, inner(i));
