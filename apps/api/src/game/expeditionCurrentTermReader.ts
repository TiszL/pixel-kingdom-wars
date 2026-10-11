/** Server-only current-round bridge: genuine chain discovery and verification
 * happen before game locks. A configured fixed round is never substituted.
 * A prefetched observation is usable for one admission attempt, never a shared
 * cache or reusable permission token. No route/default reader is activated here. */
import { readFinalizedCurrentSeekerTerm, type ReviewedSeekerSourcePolicy, type SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { parseExpeditionTermObservation, type ExpeditionTermReader } from './expeditionTerms';
import { mapVerifiedSeekerTermSnapshot, seekerTermInteger } from './expeditionTermMapping';

export async function prefetchCurrentExpeditionTermReader(
  connect: (signal: AbortSignal) => SeekerTermRpc, reviewedPolicy: ReviewedSeekerSourcePolicy,
): Promise<ExpeditionTermReader> {
  // Capture source identity before awaiting; neither a changed caller object nor
  // a different returned source may rename the admitted observation.
  const expected = { genesis: reviewedPolicy.genesisHash.toBase58(), program: reviewedPolicy.programId.toBase58(),
    config: reviewedPolicy.config.toBase58() };
  const result = await readFinalizedCurrentSeekerTerm(connect, reviewedPolicy);
  const observation = parseExpeditionTermObservation({
    snapshot: mapVerifiedSeekerTermSnapshot(result, { ...expected, round: seekerTermInteger(result.source.round) }),
    finality: { commitment: result.finality.commitment, contextSlot: seekerTermInteger(result.finality.contextSlot),
      observedAt: result.finality.observedAt },
  }, result.finality.observedAt);
  let consumed = false;
  return Object.freeze({ async readOperatingTerm(dispatchAt: string) {
    if (consumed) throw new Error('Prefetched expedition term already consumed');
    // Even an invalid clock or stale attempt consumes this private request's
    // proof. Retrying requires a new prefetch, never another RPC under locks.
    consumed = true;
    const checked = parseExpeditionTermObservation(observation, dispatchAt);
    if (Date.parse(dispatchAt) - Date.parse(checked.finality.observedAt) > PHASE_E_SEEKER_AUCTION.observationMaxAgeMs)
      throw new Error('Prefetched expedition term observation is stale');
    return checked;
  } });
}
