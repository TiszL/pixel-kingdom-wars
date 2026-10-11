/** Optional native confirmations: constrain the authoritative action, never price it. */
import { TROOP_LEVELING } from '@shardkeep/shared';
import { z } from 'zod';
import { HttpError } from '../lib/errors';

const Level = z.number().int().min(1).max(TROOP_LEVELING.maxLevel);
const Amount = z.string().max(32).regex(/^(0|[1-9][0-9]*)$/);
export const ResearchStartConsentSchema = z.object({
  currentLevel: Level,
  maxCostShards: Amount,
}).strict();
export const ResearchEpisodeConsentSchema = z.object({
  currentLevel: Level,
  toLevel: Level,
  finishesAt: z.iso.datetime({ offset: true }),
  episodeId: z.uuid().nullable(),
}).strict();
export const ResearchFinishConsentSchema = ResearchEpisodeConsentSchema.extend({
  maxCostKeep: Amount,
});
export type ResearchStartConsent = z.infer<typeof ResearchStartConsentSchema>;
export type ResearchEpisodeConsent = z.infer<typeof ResearchEpisodeConsentSchema>;
export type ResearchFinishConsent = z.infer<typeof ResearchFinishConsentSchema>;

function stale(): never {
  throw new HttpError(409, 'research changed since confirmation — refresh the forge', 'RESEARCH_CONSENT_STALE');
}
export function assertResearchLevel(current: number, consent?: ResearchStartConsent): void {
  if (consent && consent.currentLevel !== current) stale();
}
export function assertResearchEpisode(row: {
  level: number; researchingToLevel: number | null; finishesAt: Date | null; debitLedgerTxnId: string | null;
} | undefined, consent?: ResearchEpisodeConsent): void {
  if (consent && (!row || row.level !== consent.currentLevel
    || row.researchingToLevel !== consent.toLevel
    || row.debitLedgerTxnId !== consent.episodeId
    || row.finishesAt?.getTime() !== Date.parse(consent.finishesAt))) stale();
}
export function assertResearchPrice(cost: bigint, ceiling?: string): void {
  if (ceiling !== undefined && cost > BigInt(ceiling)) {
    throw new HttpError(409, 'research price exceeds confirmation — refresh the forge', 'RESEARCH_PRICE_CHANGED');
  }
}
