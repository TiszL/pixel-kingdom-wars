import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { MiningContributionRequestSchema, matchMiningContributionEnvelope, type MiningContributionRequest, type MiningContributionEnvelope } from '@shardkeep/shared/miningContributionApi';
import { requestUnpaidOriginal } from '../api';
import { miningContributionRefusalDefinitive } from './journal';

/** The original response is validated and durably retained before a stale live
 * view is rejected. Only the controller's explicit confirmation calls POST. */
export function miningContributionOriginal(input: {
  wallet: string; request: MiningContributionRequest; method: 'GET' | 'POST'; firstAttempt: boolean;
  isCurrent: () => boolean;
  retainAccepted: (proof: Extract<MiningContributionEnvelope, { status: 'accepted' }>) => Promise<void>;
  retainRefusal: (refusal: { status: number; code: string }) => Promise<void>;
}): Promise<MiningContributionEnvelope> {
  const request = MiningContributionRequestSchema.parse(input.request);
  if (input.method === 'GET' && input.firstAttempt) throw new Error('Recovery cannot be a contribution attempt.');
  return requestUnpaidOriginal({ method: input.method,
    path: input.method === 'GET' ? `/mining/contributions/by-key/${request.idempotencyKey}` : '/mining/contributions',
    ...(input.method === 'POST' ? { body: request } : {}),
    isCurrent: input.isCurrent, timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
    observe: async (status, raw) => {
      if (status >= 200 && status < 300) {
        const proof = matchMiningContributionEnvelope(raw, input.wallet, request);
        if (proof.status === 'accepted' && (Date.parse(proof.receipt.createdAt) > Date.parse(proof.serverNow)
          || proof.settlement && Date.parse(proof.settlement.settledAt) > Date.parse(proof.serverNow))) throw new Error('Contribution evidence is ahead of its observation.');
        if (input.method === 'POST' && proof.status !== 'accepted') throw new Error('The response did not prove contribution acceptance.');
        if (proof.status === 'accepted') await input.retainAccepted(proof);
        return proof;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !('error' in raw)
        || !raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error)) throw new Error('Invalid original error envelope.');
      const error = raw.error as Record<string, unknown>;
      if (Object.keys(error).some(key => !['code', 'message'].includes(key)) || typeof error.code !== 'string'
        || typeof error.message !== 'string' || !error.message) throw new Error('Invalid original refusal.');
      if (input.method === 'POST' && input.firstAttempt && miningContributionRefusalDefinitive(status, error.code))
        await input.retainRefusal({ status, code: error.code });
      return undefined;
    },
  });
}
