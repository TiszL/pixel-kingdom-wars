import { FORGE_INGOT } from '@shardkeep/shared';
import type { WorkshopView } from '@shardkeep/shared/workshop';
import type { WorkshopCommand, WorkshopIdentity } from './journal';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: WorkshopIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: '11111111111111111111111111111111' };
export const start: Extract<WorkshopCommand, { kind: 'start' }> = { kind: 'start', request: { baseId: id(1), idempotencyKey: 'original-start-key', ingots: 1, recipeVersion: 1 } };
export const collect: Extract<WorkshopCommand, { kind: 'collect' }> = { kind: 'collect', baseId: id(1), jobId: id(2), request: { idempotencyKey: 'original-collect-key' } };
export const now = '2026-09-21T12:00:00.000Z';
export const view = (): WorkshopView => ({ features: { workshop: { version: 1, receipts: 1, allowance: 1 } }, acceptingJobs: true, level: 1, recipeVersion: 1,
  shardsPerIngot: FORGE_INGOT.shardsPerIngot, batch: { size: 1, max: FORGE_INGOT.batch.max }, secPerIngot: FORGE_INGOT.refineSecPerIngot,
  inventory: { baseId: id(1), held: 1, pending: 1 }, allowance: { version: 1, scope: 'free_wallet', day: '2026-09-21T00:00:00.000Z', resetsAt: '2026-09-22T00:00:00.000Z', capacityUnits: 2,
    daily: { cap: 6, used: 2, remaining: 4 }, holding: { held: 3, pending: 2, listed: 0, reserved: 0, cap: 14, remaining: 9 } },
  dailyRefineCap: 6, refinedToday: 1, holding: { held: 1, listed: 0, reserved: 0, inProgress: 1, cap: 14 }, capacity: 2,
  jobs: [{ jobId: id(2), ingots: 1, shards: String(FORGE_INGOT.shardsPerIngot), recipeVersion: 1, workshopLevel: 1, capacityScopeAtStart: null,
    startedAt: '2026-09-21T00:00:00.000Z', readyAt: '2026-09-21T00:01:00.000Z', ready: true, collectedAt: null }], serverNow: now });
export function proof(command: WorkshopCommand, accepted = false) {
  const common = { wallet: identity.wallet, idempotencyKey: command.request.idempotencyKey, status: accepted ? 'accepted' : 'unknown', serverNow: now };
  const receipt = command.kind === 'start' ? { version: 1, status: 'accepted', wallet: identity.wallet, baseId: id(1), jobId: id(2), ingots: 1,
    shardsCharged: String(FORGE_INGOT.shardsPerIngot), recipeVersion: 1, workshopLevelAtStart: 1, capacityScopeAtStart: 'free_wallet',
    startedAt: view().jobs[0]!.startedAt, readyAt: view().jobs[0]!.readyAt, receiptId: id(3), acceptedAt: view().jobs[0]!.startedAt }
    : { version: 1, status: 'accepted', wallet: identity.wallet, baseId: id(1), jobId: id(2), receiptId: id(2), ingotsCredited: 1, collectedAt: now };
  return { ...common, receipt: accepted ? receipt : null };
}
