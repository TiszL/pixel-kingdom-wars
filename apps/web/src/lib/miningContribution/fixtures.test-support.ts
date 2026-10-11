import { PHASE_E_MINING_CONTRIBUTION_V2 as POLICY } from '@shardkeep/shared';
import { MINING_CONTRIBUTION_RESOURCE_IDS, miningResourceUnitValue, valueMiningContribution } from '@shardkeep/shared/miningContribution';
import type { MiningContributionView } from '@shardkeep/shared/miningContributionApi';
import type { MiningContributionCommand, MiningContributionIdentity, MiningContributionProof } from './journal';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: MiningContributionIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const now = '2026-09-29T12:00:00.000Z';
export function command(quantity = '1', key = id(2)): MiningContributionCommand {
  return { request: { baseId: id(1), idempotencyKey: key, policyVersion: POLICY.version, expectedDay: now.slice(0, 10), lines: [{ resourceId: 'frost_quartz', quantity }] } };
}
export const start = command();
export const view = (): MiningContributionView => ({ wallet: identity.wallet, baseId: id(1), policyVersion: POLICY.version, day: now.slice(0, 10), serverNow: now,
  acceptingContributions: true, pool: 'free', dailyCapValue: String(POLICY.freeValuePerWalletDay), committedValue: '0', remainingValue: String(POLICY.freeValuePerWalletDay), developmentReady: true,
  resources: MINING_CONTRIBUTION_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '10000', unitValue: String(miningResourceUnitValue(resourceId, POLICY.version)) })),
  consistency: { windowDays: POLICY.consistencyWindowDays, bonusPerQualifiedDayBps: POLICY.consistencyBonusPerDayBps, maximumBonusBps: POLICY.consistencyWindowDays * POLICY.consistencyBonusPerDayBps } });
export function proof(original = start, accepted = false, settled = false): MiningContributionProof {
  const common = { wallet: identity.wallet, idempotencyKey: original.request.idempotencyKey, serverNow: now };
  const valued = valueMiningContribution(original.request.lines, original.request.policyVersion);
  return accepted ? { ...common, status: 'accepted', receipt: { id: original.request.idempotencyKey, epochId: id(3), wallet: identity.wallet,
    request: original.request, day: original.request.expectedDay, lines: [...valued.lines], totalValue: valued.totalValue, createdAt: now },
    settlement: settled ? { outcome: 'consumed', settledAt: now } : null } : { ...common, status: 'unknown', receipt: null, settlement: null };
}
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
