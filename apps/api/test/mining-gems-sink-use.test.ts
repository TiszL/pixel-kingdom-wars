import { createHash, randomUUID } from 'node:crypto';
import { speedupCostKeep } from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import { deriveGemsSinkUseEvidence, readGemsSinkUseEvidence } from '../src/mining/gemsSinkUseEvidence';
import { convertKeepToGems } from '../src/game/gems';
import { fundGemsRewardBudget, grantGems } from '../src/game/gemsGrants';
import { postTransaction } from '../src/ledger';
import { researchSpeedup } from '../src/game/army';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { withGemsFlow } from './fixtures/gemsFlow';
import { sinkUseFixture } from './fixtures/gemsSinkUse';
describe('copied irreversible Gems sink-use evidence', () => {
 it('joins six modern immutable effect contracts to their exact payments and FIFO segments', () => {
  const f = sinkUseFixture(); for (const kind of ['builder', 'training', 'research', 'hero-upgrade', 'hero-recovery', 'mine'] as const) f.add(kind);
  const evidence = deriveGemsSinkUseEvidence(f.evidence); expect(evidence.verified.map(v => v.kind)).toEqual(['builder-finish', 'training-finish', 'research-finish', 'hero-upgrade', 'hero-recovery', 'additional-mine-placement']); expect(evidence.unresolved).toEqual([]);
  expect(evidence.verified[0]?.consumed[0]).toMatchObject({ originClass: 'grant', amount: '25' }); expect(evidence.verified[4]?.consumed[0]).toMatchObject({ originClass: 'custodial-conversion', amount: '25' });
  expect(evidence.verified.every(v => v.baseId === f.baseId && v.observedAt === '2035-01-01T02:00:00.000999Z' && v.effectiveObservedAt === '2035-01-01T02:00:00.000999Z')).toBe(true);
  expect(evidence).toMatchObject({ usefulChainCreditAuthorized: false, scoringAuthorized: false, allocationReady: false, publicationAuthorized: false });
 });
 it.each(['builder', 'training', 'research', 'mine'] as const)('keeps a %s receipt with conflicting original base unresolved', kind => {
  const f = sinkUseFixture(), p = f.add(kind); p.source.transaction.metadata['baseId'] = randomUUID(); const e = deriveGemsSinkUseEvidence(f.evidence); expect(e.verified).toEqual([]); expect(e.unresolved[0]?.reason).toBe('legacy-or-malformed-receipt');
 });
 it.each(['job', 'target', 'episode', 'currency', 'ceiling', 'remSec'] as const)('refuses builder %s conflict without using current job state', field => {
  const f = sinkUseFixture(), p = f.add('builder'); const m = p.source.transaction.metadata as { builderJobSpeedup: { request: { expectedCurrency: string; consent: { maxCostKeep: string; finishesAt: string } }; result: { jobId: string; buildingId: string } }; remSec: number };
  if (field === 'job') m.builderJobSpeedup.result.jobId = randomUUID(); else if (field === 'target') m.builderJobSpeedup.result.buildingId = randomUUID(); else if (field === 'episode') m.builderJobSpeedup.request.consent.finishesAt = '2035-01-01T01:00:00.000Z'; else if (field === 'currency') m.builderJobSpeedup.request.expectedCurrency = 'KEEP'; else if (field === 'ceiling') m.builderJobSpeedup.request.consent.maxCostKeep = '1'; else m.remSec = 1;
  expect(deriveGemsSinkUseEvidence(f.evidence).verified).toEqual([]);
 });
 it('does not call acquisitions, unrefunded buffs or absent recruitment-command evidence irreversible use', () => {
  const f = sinkUseFixture();
  for (const type of ['item.buy', 'raid.buffs', 'hero.recruit', 'some.new.sink']) { const p = f.add('hero-upgrade'); p.source.transaction.type = type; }
  const e = deriveGemsSinkUseEvidence(f.evidence); expect(e.verified).toEqual([]); expect(e.unresolved.map(u => u.reason)).toEqual(['acquisition-only', 'terminal-effect-unproven', 'recruitment-command-unavailable', 'unsupported-sink']);
 });
 it.each(['builderJobSpeedup', 'trainingFinish', 'researchSpeedup', 'recoveryUntil', 'minePurchase'] as const)('never invents legacy %s proof from a paid label', field => {
  const kind = ({ builderJobSpeedup: 'builder', trainingFinish: 'training', researchSpeedup: 'research', recoveryUntil: 'hero-recovery', minePurchase: 'mine' } as const)[field];
  const f = sinkUseFixture(), p = f.add(kind); delete p.source.transaction.metadata[field]; expect(deriveGemsSinkUseEvidence(f.evidence).verified).toEqual([]);
 });
 it('refuses underlying mutated/unknown provenance before classifying any effect', () => {
  const f = sinkUseFixture(); f.add('research'); f.evidence.hasSourceMutations = true; expect(() => deriveGemsSinkUseEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });
 it('does not promote wallet ledger origin segments to finalized chain proof', () => {
  const f = sinkUseFixture(); f.spend(300n, { excluded: true }); f.origin(100n, 'wallet-conversion-ledger'); f.add('research'); const e = deriveGemsSinkUseEvidence(f.evidence); expect(e.verified[0]?.consumed[0]?.requiresDepositVerification).toBe(true); expect(e.usefulChainCreditAuthorized).toBe(false);
 });
 it('calls the ordinary research producer, proves its paid completion and preserves the earlier copied cutoff after deletion', async () => withGemsFlow(async f => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); const cost = BigInt(speedupCostKeep(3600)), granted = cost / 2n;
  await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.budget', entries: [{ account: f.sys.keep_genesis, delta: -granted }, { account: f.sys.emission_pool, delta: granted }] }); await fundGemsRewardBudget(f.conn.db, granted, randomUUID()); await grantGems(f.conn.db, { wallet: f.wallet, gems: granted, reason: 'dev' }); await convertKeepToGems(f.conn.db, f.wallet, cost, randomUUID());
  const now = new Date('2035-01-01T02:00:00.000Z'), finishesAt = new Date(now.getTime() + 3600000), key = randomUUID();
  await f.conn.sql`insert into troop_research(player_wallet,troop,level,researching_to_level,finishes_at) values(${f.wallet},'giant',1,2,${finishesAt.toISOString()})`;
  await f.clock('2035-01-01T02:00:00.000999Z'); const result = await withClientCurrencyContext({ currency: undefined, expectedCurrency: 'GEMS' }, () => researchSpeedup(f.conn.db, f.wallet, 'giant', key, now, undefined, { currentLevel: 1, toLevel: 2, finishesAt: finishesAt.toISOString(), episodeId: null, maxCostKeep: cost.toString() }));
  expect(result).toMatchObject({ cost, troop: 'giant', toLevel: 2 }); expect((await f.conn.sql`select level,researching_to_level from troop_research where player_wallet=${f.wallet}`)[0]).toMatchObject({ level: 2, researching_to_level: null });
  await f.close(); const prior = await readGemsSinkUseEvidence(f.conn.db, { wallet: f.wallet, day: '2035-01-01' }); expect(prior.verified).toHaveLength(1); expect(prior.verified[0]).toMatchObject({ kind: 'research-finish', amount: cost.toString(), effect: { troop: 'giant', fromLevel: 1, toLevel: 2 }, consumed: [{ originClass: 'grant', amount: granted.toString() }, { originClass: 'custodial-conversion', amount: (cost - granted).toString() }] });
  // Owner edit with plain DELETEs and no trigger paused: 0267 made them silent no-ops, so the later day still
  // resolved instead of losing its source; 0302 (K-night-E1) makes them real, which the length check below proves.
  const id = prior.verified[0]!.transactionId; await f.conn.sql.begin(async tx => { await tx`delete from ledger_entries where txn_id=${id}`; await tx`delete from ledger_transactions where id=${id}`; });
  expect(await f.conn.sql`select id from ledger_transactions where id=${id}`).toHaveLength(0); await f.conn.sql`delete from troop_research where player_wallet=${f.wallet}`;
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); expect(await readGemsSinkUseEvidence(f.conn.db, { wallet: f.wallet, day: '2035-01-01' })).toEqual(prior); await f.clock('2035-01-03T00:00:00Z'); await expect(readGemsSinkUseEvidence(f.conn.db, { wallet: f.wallet, day: '2035-01-02' })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
 }), 30000);
 it('refuses duplicate immutable job effects instead of crediting two paid receipts for one completion', () => {
  const f = sinkUseFixture(), first = f.add('builder'), second = f.add('builder');
  const firstMeta = first.source.transaction.metadata as { jobId: string; builderJobSpeedup: unknown };
  const secondMeta = second.source.transaction.metadata as { jobId: string; builderJobSpeedup: { request: { idempotencyKey: string } } };
  secondMeta.jobId = firstMeta.jobId; secondMeta.builderJobSpeedup = structuredClone(firstMeta.builderJobSpeedup) as typeof secondMeta.builderJobSpeedup;
  secondMeta.builderJobSpeedup.request.idempotencyKey = second.key;
  expect(() => deriveGemsSinkUseEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });

 it('preserves raw cutoff timestamps for unresolved spending on the original observation day', () => {
  const f = sinkUseFixture(), receipt = f.add('research');
  receipt.source.transaction.type = 'some.new.sink';
  const row = deriveGemsSinkUseEvidence(f.evidence).unresolved[0]!;
  expect(row.observedAt).toBe('2035-01-01T02:00:00.000999Z');
  expect(row.effectiveObservedAt).toBe('2035-01-01T02:00:00.000999Z');
  expect(row.reason).toBe('unsupported-sink');
 });

 it('binds the source digest to the exact bounded ordered evidence used by provenance and effect verification', () => {
  const f = sinkUseFixture(), receipt = f.add('research'), original = JSON.stringify(f.evidence);
  const expected = createHash('sha256').update(original).digest('hex'); const first = deriveGemsSinkUseEvidence(f.evidence);
  expect(first.sourceDigest).toBe(expected); expect(JSON.stringify(f.evidence)).toBe(original);
  receipt.source.transaction.metadata['unknownField'] = 'different copied source'; const second = deriveGemsSinkUseEvidence(f.evidence);
  expect(second.sourceDigest).toBe(createHash('sha256').update(JSON.stringify(f.evidence)).digest('hex')); expect(second.sourceDigest).not.toBe(first.sourceDigest);
 });

});
