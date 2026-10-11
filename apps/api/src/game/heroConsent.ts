/** A native confirmation constrains one observed hero state, never supplies its price. */
import { HERO_LEVELING } from '@shardkeep/shared';
import { z } from 'zod';
import { HttpError } from '../lib/errors';

export const HeroLevelSchema = z.number().int().min(1).max(HERO_LEVELING.maxLevel);
export const HeroKeepAmountSchema = z.string().max(32).regex(/^(0|[1-9][0-9]*)$/);
export const HeroUpgradeConsentSchema = z.object({
  expectedLevel: HeroLevelSchema,
  maxCostKeep: HeroKeepAmountSchema,
}).strict();
export const HeroRecoveryConsentSchema = z.object({
  recoveryUntil: z.iso.datetime({ offset: true }),
  maxCostKeep: HeroKeepAmountSchema,
}).strict();
export type HeroUpgradeConsent = z.infer<typeof HeroUpgradeConsentSchema>;
export type HeroRecoveryConsent = z.infer<typeof HeroRecoveryConsentSchema>;

export function assertHeroLevel(current: number, consent?: HeroUpgradeConsent): void {
  if (consent && consent.expectedLevel !== current) stale();
}
export function assertHeroRecovery(recoveryUntil: Date | null | undefined, consent?: HeroRecoveryConsent): void {
  if (consent && recoveryUntil?.getTime() !== Date.parse(consent.recoveryUntil)) stale();
}
export function assertHeroPrice(cost: bigint, ceiling?: string): void {
  if (ceiling !== undefined && cost > BigInt(ceiling)) {
    throw new HttpError(409, 'hero price exceeds confirmation — refresh the roster', 'HERO_PRICE_CHANGED');
  }
}
function stale(): never {
  throw new HttpError(409, 'hero changed since confirmation — refresh the roster', 'HERO_CONSENT_STALE');
}
