import type { ResearchSpeedupIntent } from '@shardkeep/shared/researchSpeedup';
import type { ResearchSpeedupIdentity } from './journal';
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: ResearchSpeedupIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const research: ResearchSpeedupIntent = { troop: 'giant', baseId: id(1), idempotencyKey: 'original-research-key', expectedCurrency: 'GEMS', maxCostKeep: '100', currentLevel: 1, toLevel: 2, finishesAt: '2026-09-21T12:00:00.000Z', episodeId: id(3) };
/** A same-troop/deadline restart remains another immutable debit episode. */
export const restarted: ResearchSpeedupIntent = { ...research, episodeId: id(4) };
export function proof(intent: ResearchSpeedupIntent, accepted = false) {
  if (!accepted) return { version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey };
  return { version: 1, status: 'accepted', wallet: identity.wallet, receiptId: id(2), acceptedAt: '2026-09-21T11:00:00.000Z',
    funding: { currency: intent.expectedCurrency, amount: '90' }, request: intent,
    result: { troop: intent.troop, fromLevel: intent.currentLevel, toLevel: intent.toLevel } };
}
