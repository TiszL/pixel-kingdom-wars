import { HERO_KEYS } from '@shardkeep/shared';
import type { HeroProgressionIntent } from '@shardkeep/shared/heroProgression';
import type { HeroProgressionIdentity } from './journal';
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: HeroProgressionIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const upgrade: HeroProgressionIntent = { kind: 'upgrade', hero: HERO_KEYS[0], baseId: id(1), idempotencyKey: 'original-hero-key', expectedCurrency: 'GEMS', maxCostKeep: '100', expectedLevel: 1 };
export const recovery: HeroProgressionIntent = { kind: 'recovery', hero: HERO_KEYS[0], baseId: id(1), idempotencyKey: 'original-hero-key', expectedCurrency: 'GEMS', maxCostKeep: '100', recoveryUntil: '2026-09-21T12:00:00.000Z' };
export function proof(intent: HeroProgressionIntent, accepted = false) {
  if (!accepted) return { version: 1, status: 'unknown', idempotencyKey: intent.idempotencyKey };
  return { version: 1, status: 'accepted', wallet: identity.wallet, baseId: intent.baseId, receiptId: id(2), acceptedAt: '2026-09-21T11:00:00.000Z',
    funding: { currency: intent.expectedCurrency, amount: '90' },
    request: { hero: intent.hero, ...(intent.baseId ? { baseId: intent.baseId } : {}), idempotencyKey: intent.idempotencyKey, maxCostKeep: intent.maxCostKeep,
      ...(intent.kind === 'upgrade' ? { expectedLevel: intent.expectedLevel } : { recoveryUntil: intent.recoveryUntil }) },
    result: intent.kind === 'upgrade' ? { fromLevel: intent.expectedLevel, toLevel: intent.expectedLevel + 1 } : { recoveryUntil: intent.recoveryUntil } };
}
