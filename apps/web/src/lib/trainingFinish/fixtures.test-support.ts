import type { TrainingFinishIntent } from '@shardkeep/shared/trainingFinish';
import type { TrainingFinishIdentity } from './journal';
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: TrainingFinishIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const training: TrainingFinishIntent = { baseId: id(1), idempotencyKey: 'original-training-key', expectedCurrency: 'GEMS',
  consent: { version: 2, maxCostKeep: '100', queue: [
    { id: id(3), startedAt: '2026-09-21T11:00:00.000Z', finishesAt: '2026-09-21T12:00:00.000Z' },
    { id: id(4), startedAt: '2026-09-21T12:00:00.000Z', finishesAt: '2026-09-21T13:00:00.000Z' },
  ] } };
export const restarted: TrainingFinishIntent = { ...training, consent: { ...training.consent, queue: training.consent.queue.map((row, index) => ({ ...row, id: id(6 + index) })) } };
export function proof(intent: TrainingFinishIntent, accepted = false) {
  if (!accepted) return { version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey };
  return { version: 1, status: 'accepted', wallet: identity.wallet, receiptId: id(2), acceptedAt: '2026-09-21T11:00:00.000Z',
    funding: { currency: intent.expectedCurrency, amount: '90' }, request: intent,
    result: { completedAt: '2026-09-21T11:00:00.000Z', paidRows: intent.consent.queue.map(row => ({ ...row, troop: 'bowman' })), completed: [{ troop: 'bowman', count: intent.consent.queue.length }] } };
}
