import { randomUUID } from 'node:crypto';
import { TRAINING_SCHEDULE } from '@shardkeep/shared';
import { attributionFixture } from './gemsAttribution';
export const completedAt = '2035-01-01T02:00:00.000Z';
export function sinkUseFixture() {
 const f = attributionFixture(); f.origin(100n, 'grant'); f.origin(200n); f.clock('2035-01-01T02:00:00.000999Z');
 const baseId = randomUUID();
 const add = (kind: 'builder' | 'training' | 'research' | 'hero-upgrade' | 'hero-recovery' | 'mine', amount = 25n) => {
  const fact = f.spend(amount), key = randomUUID();
  const source = fact.source as { transaction: { key: string; type: string; metadata: Record<string, unknown> } };
  let type = '', ledgerKey = '', extra: Record<string, unknown> = {};
  if (kind === 'builder') {
   const jobId = randomUUID(), buildingId = randomUUID();
   const request = { jobId, baseId, idempotencyKey: key, expectedCurrency: 'GEMS', consent: { version: 1, kind: 'upgrade', buildingId, obstacleId: null, startedAt: '2035-01-01T01:00:00.000Z', finishesAt: '2035-01-01T03:00:00.000Z', maxCostKeep: '100' } };
   type = 'build.speedup'; ledgerKey = `speedup:${f.wallet}:${key}`;
   extra = { jobId, remSec: 3600, builderJobSpeedup: { version: 1, request, result: { jobId, kind: 'upgrade', buildingId, obstacleId: null, completedAt } } };
  } else if (kind === 'training') {
   const row = { id: randomUUID(), startedAt: '2035-01-01T01:00:00.000Z', finishesAt: '2035-01-01T03:00:00.000Z' };
   const request = { baseId, idempotencyKey: key, expectedCurrency: 'GEMS', consent: { version: TRAINING_SCHEDULE.version, queue: [row], maxCostKeep: '100' } };
   type = 'train.speedup'; ledgerKey = `tspeedup:${baseId}:${key}`; extra = { rows: 1, remSec: 3600, trainingFinish: { version: 1, request, result: { completedAt, paidRows: [{ ...row, troop: 'giant' }], completed: [{ troop: 'giant', count: 1 }] } } };
  } else if (kind === 'research') {
   const request = { troop: 'giant', baseId, idempotencyKey: key, expectedCurrency: 'GEMS', currentLevel: 1, toLevel: 2, finishesAt: '2035-01-01T03:00:00.000Z', episodeId: randomUUID(), maxCostKeep: '100' };
   type = 'research.speedup'; ledgerKey = `rspeedup:${baseId}:${key}`; extra = { troop: 'giant', toLevel: 2, remSec: 3600, researchSpeedup: { version: 1, request } };
  } else if (kind === 'hero-upgrade') {
   type = 'hero.upgrade'; ledgerKey = `heroup:${f.wallet}:${baseId}:vex:${key}`; extra = { hero: 'vex', from: 1, to: 2 };
  } else if (kind === 'hero-recovery') {
   type = 'hero.recovery.speedup'; ledgerKey = `herorecover:${f.wallet}:${baseId}:vex:${key}`; extra = { hero: 'vex', remainingSec: 3600, recoveryUntil: '2035-01-01T03:00:00.000Z' };
  } else {
   const request = { type: 'mine', tx: 11, ty: 8, baseId, idempotencyKey: key, expectedCurrency: 'GEMS', mineConsent: { version: 1, mineIndex: 1, maxCostKeep: '100' } };
   type = 'build.mine'; ledgerKey = `build:${f.wallet}:${key}`; extra = { type: 'mine', tx: 11, ty: 8, mineIndex: 1, minePurchase: { version: 1, request } };
  }
  source.transaction.type = type; source.transaction.key = ledgerKey; source.transaction.metadata = { wallet: f.wallet, currency: 'GEMS', baseId, ...extra }; return { fact, source, key };
 };
 return { ...f, baseId, add };
}
