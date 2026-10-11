import { HarvesterSourceEnvelopeSchema, HarvesterViewSchema, harvesterPolicyV1,
  type HarvesterEvent, type HarvesterSourceSummary, type HarvesterView } from '@shardkeep/shared/harvesterApi';
import { PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES } from '@shardkeep/shared/phaseEResources';
import { splitResourceEarnings } from '@shardkeep/shared/phaseEResourceTax';
import { parseHarvesterCommand, type HarvesterIdentity, type HarvesterProof } from './journal';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: HarvesterIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const now = '2026-09-22T12:00:00.000Z';
export const policy = harvesterPolicyV1();
const after = (seconds: number) => new Date(Date.parse(now) + seconds * 1_000).toISOString();
export const facility = () => ({ baseId: id(1), harvesterId: id(3), completedBuildJobId: id(4), harvesterCompletedAt: now });
export function head(baseId = id(1), expired = false): HarvesterSourceSummary {
  return { sourceId: id(8), baseId, harvesterId: id(9), policyVersion: policy.policyVersion,
    realmId: 'crownlands', resourceId: 'crown_iron_ore', admittedAt: after(-policy.maxLeaseSec * (expired ? 2 : 1)),
    leaseExpiresAt: after(expired ? -policy.maxLeaseSec : policy.cadenceSec) };
}
export function command(replacedSource: HarvesterSourceSummary | null = null, key = id(2)) {
  return parseHarvesterCommand({ request: { idempotencyKey: key, baseId: id(1), harvesterId: id(3),
    expectedSourceId: replacedSource?.sourceId ?? null, policyVersion: policy.policyVersion },
    facility: facility(), realmId: 'crownlands', policy, replacedSource });
}
export const start = command();
export const view = (walletSource: HarvesterSourceSummary | null = null): HarvesterView => HarvesterViewSchema.parse({ wallet: identity.wallet,
  baseId: id(1), serverNow: now, features: { harvesters: { version: 1, receipts: 1 } }, acceptingSelections: true,
  home: { source: 'free_policy_preview', version: 1, realmId: 'crownlands' }, facilities: [facility()],
  source: walletSource?.baseId === id(1) ? walletSource : null, walletSource, policy,
  rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '0', reserved: '0', total: '0' })) });
export type SettlementOptions = { events?: number; closed?: boolean; stopAfter?: number; capped?: boolean; carry?: string };
/** Synthetic fixture only. All policy amounts come from the canonical snapshot;
 * allocation uses the shared pure helper, never a second client economy formula. */
export function proof(original = start, accepted = false, options: SettlementOptions = {}): HarvesterProof {
  if (!accepted) return HarvesterSourceEnvelopeSchema.parse({ wallet: identity.wallet, idempotencyKey: original.request.idempotencyKey,
    serverNow: now, status: 'unknown', originalReceipt: null, settlement: null });
  const terms = original.policy, count = options.events ?? 0;
  const resourceId = PHASE_E_RAW_RESOURCE_IDS.find(id => PHASE_E_RAW_RESOURCES[id].realmId === original.realmId)!;
  const events: HarvesterEvent[] = []; let carry = BigInt(options.carry ?? '0');
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const earnedAt = after(ordinal * terms.cadenceSec), split = splitResourceEarnings(options.capped ? 0n : BigInt(terms.grossPerCadence), carry);
    events.push({ sourceId: original.request.idempotencyKey, ordinal, walletSequence: String(ordinal), resourceId,
      policyVersion: terms.policyVersion, earnedAt, settledAt: earnedAt, utcDay: `${earnedAt.slice(0, 10)}T00:00:00.000Z`,
      grossQuantity: String(split.gross), netQuantity: String(split.net), islandPoolQuantity: String(split.tax),
      taxPolicyVersion: terms.taxPolicyVersion, taxBasisPoints: terms.taxBasisPoints, islandPoolBps: terms.islandPoolBps,
      carryBefore: String(carry), carryAfter: String(split.nextCarry) });
    carry = split.nextCarry;
  }
  const cutoffAt = after((options.stopAfter ?? count) * terms.cadenceSec);
  return HarvesterSourceEnvelopeSchema.parse({ wallet: identity.wallet, idempotencyKey: original.request.idempotencyKey,
    serverNow: after(Math.max(count, options.stopAfter ?? 0) * terms.cadenceSec), status: 'accepted',
    originalReceipt: { wallet: identity.wallet, request: original.request, source: { sourceId: original.request.idempotencyKey,
      ...original.facility, policyVersion: terms.policyVersion, realmId: original.realmId, resourceId, admittedAt: now,
      leaseExpiresAt: after(terms.maxLeaseSec), term: { termId: id(6), termHash: 'a'.repeat(64), startsAt: now,
        endsAt: after(terms.maxLeaseSec * 2) }, terms } },
    settlement: { events, closure: options.closed ? { sourceId: original.request.idempotencyKey,
      reason: options.stopAfter === undefined ? 'replacement' : 'custody_change', cutoffAt, processedOrdinal: count } : null,
      custodyStop: options.stopAfter === undefined ? null : { sourceId: original.request.idempotencyKey, cutoffAt, checkedAt: now, auditHash: 'b'.repeat(64) } } });
}
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
