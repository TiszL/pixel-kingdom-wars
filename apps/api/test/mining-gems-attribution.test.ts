import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { postTransaction } from '../src/ledger';
import { convertKeepToGems, convertGemsToShards } from '../src/game/gems';
import { fundGemsRewardBudget, grantGems } from '../src/game/gemsGrants';
import { spendGems } from '../src/game/spend';
import { refundUnstartedLiveBuffs } from '../src/game/liveRaids';
import { attributeGemsFlowEvidence, readGemsFlowAttribution } from '../src/mining/gemsFlowAttribution';
import { attributionFixture } from './fixtures/gemsAttribution';
import { withGemsFlow } from './fixtures/gemsFlow';

function source(fact: ReturnType<ReturnType<typeof attributionFixture>['spend']>) {
 return fact.source as { entry: { delta: string }; transaction: { id: string; key: string; type: string; metadata: Record<string, unknown> } };
}
describe('FIFO Gems provenance without useful-use authority', () => {
 it('consumes 100 granted then 200 converted Gems in FIFO order and retains per-origin composition', () => {
  const f = attributionFixture(), grant = f.origin(100n, 'grant'), converted = f.origin(200n); const debit = f.spend(150n);
  const a = attributeGemsFlowEvidence(f.evidence); expect(a.debits[0]).toMatchObject({ eventId: debit.id, amount: '150', candidateConvertedGems: { custodial: '50', walletLedger: '0' }, consumed: [{ originEventId: grant.id, originClass: 'grant', amount: '100' }, { originEventId: converted.id, originClass: 'custodial-conversion', amount: '50' }] });
  expect(a.currentLots).toMatchObject([{ originEventId: converted.id, amount: '150' }]); expect(a.balanceGems).toBe('150'); expect(a.usefulChainCreditAuthorized).toBe(false); expect(a.allocationReady).toBe(false);
 });
 it('uses every excluded conversion to deplete provenance before later candidate spends', () => {
  const f = attributionFixture(); f.origin(100n); f.origin(200n, 'grant'); f.spend(80n, { excluded: true }); f.spend(50n);
  const a = attributeGemsFlowEvidence(f.evidence); expect(a.debits[0]?.candidateConvertedGems).toEqual({ custodial: '0', walletLedger: '0' }); expect(a.debits[1]?.candidateConvertedGems).toEqual({ custodial: '20', walletLedger: '0' }); expect(a.currentLots).toMatchObject([{ originClass: 'grant', amount: '170' }]);
 });
 it('requeues exactly the original mixed composition at refund time and cancels that original candidate', () => {
  const f = attributionFixture(); f.origin(100n, 'grant'); const origin = f.origin(200n); const spent = f.spend(150n, { raidId: randomUUID() }); f.spend(50n, { excluded: true });
  f.clock('2035-01-02T00:00:00.000000Z'); const refunded = f.refund(spent); f.spend(130n); const a = attributeGemsFlowEvidence(f.evidence);
  expect(a.debits[0]).toMatchObject({ refundedByEventId: refunded.id, candidateConvertedGems: { custodial: '0', walletLedger: '0' } }); expect(a.debits[2]?.candidateConvertedGems).toEqual({ custodial: '100', walletLedger: '0' });
  expect(a.currentLots).toMatchObject([{ originClass: 'grant', amount: '70', availableEventId: refunded.id }, { originEventId: origin.id, originClass: 'custodial-conversion', amount: '50', availableEventId: refunded.id }]); expect(a.refunds[0]?.originalDebitEventId).toBe(spent.id);
 });
 it('keeps wallet ledger origins distinct and explicitly pending deposit verification', () => {
  const f = attributionFixture(); f.origin(100n, 'wallet-conversion-ledger'); f.spend(40n); const a = attributeGemsFlowEvidence(f.evidence);
  expect(a.debits[0]?.candidateConvertedGems).toEqual({ custodial: '0', walletLedger: '40' }); expect(a.debits[0]?.consumed[0]).toMatchObject({ originClass: 'wallet-conversion-ledger', requiresDepositVerification: true }); expect(a.currentLots[0]?.requiresDepositVerification).toBe(true); expect(a.usefulChainCreditAuthorized).toBe(false);
 });
 it.each(['hasSourceMutations', 'hasUnclassified'] as const)('refuses %s rather than returning zero credit', key => {
  const f = attributionFixture(); f.origin(100n); f.evidence[key] = true; expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });
 it.each(['unclassified', 'source-mutation'] as const)('refuses an individual %s row even when summary flags falsely say complete', classification => {
  const f = attributionFixture(); f.origin(100n).classification = classification; expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });
 it('refuses retirement-labelled metadata presented as a known conversion', () => {
  const f = attributionFixture(); source(f.origin(100n)).transaction.type = 'gems.late_credit'; expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });
 it.each(['refundOf', 'originalKey', 'wallet', 'raidId', 'buff', 'currency'])('refuses forged refund %s despite a valid two-leg credit', field => {
  const f = attributionFixture(); f.origin(100n); const original = f.spend(50n, { raidId: randomUUID() }); const refund = f.refund(original); source(refund).transaction.metadata[field] = 'forged';
  expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'REFUND_UNAVAILABLE' }));
 });
 it('refuses a generic refund label or alternate originalTxnId reference', () => {
  const f = attributionFixture(); f.origin(100n); const original = f.spend(50n, { raidId: randomUUID() }); const refund = f.refund(original); source(refund).transaction.metadata = { originalTxnId: original.transactionId };
  expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'REFUND_UNAVAILABLE' }));
  source(refund).transaction.type = 'other.system_refund'; expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'REFUND_UNAVAILABLE' }));
 });
 it('refuses two distinct refunds of one debit and wrong refund account/amount mirrors', () => {
  const f = attributionFixture(); f.origin(100n); const original = f.spend(50n, { raidId: randomUUID() }); f.refund(original); const duplicate = f.refund(original);
  expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'REFUND_UNAVAILABLE' }));
  f.evidence.facts.pop(); f.evidence.netGems = '100'; const r = f.evidence.facts.at(-1)!; const receipt = r.receipt as Array<{ accountId: string; delta: string }>; receipt[1]!.accountId = randomUUID();
  expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'REFUND_UNAVAILABLE' })); expect(duplicate.id).not.toBe(r.id);
 });
 it('rejects missing balance, underflow, duplicate identities and an out-of-order history', () => {
  const f = attributionFixture(); const origin = f.origin(100n); f.spend(50n); const good = f.snapshot();
  f.evidence.netGems = '51'; expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'BALANCE_MISMATCH' }));
  f.evidence.netGems = '50'; f.evidence.facts.splice(1, 1); expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'BALANCE_MISMATCH' }));
  good.facts.push(structuredClone(origin)); expect(() => attributeGemsFlowEvidence(good)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
  const reversed = attributionFixture(); reversed.origin(50n); reversed.spend(10n); reversed.evidence.facts.reverse(); expect(() => attributeGemsFlowEvidence(reversed.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });
 it('keeps amounts above Number precision exact and refuses oversized signed ledger amounts', () => {
  const f = attributionFixture(); f.origin(9007199254740993n); f.spend(9007199254740991n); expect(attributeGemsFlowEvidence(f.evidence).balanceGems).toBe('2');
  const tooLarge = attributionFixture(); tooLarge.origin(9223372036854775808n); expect(() => attributeGemsFlowEvidence(tooLarge.evidence)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNAVAILABLE' }));
 });
 it('bounds input facts and metadata before decoding', () => {
  const f = attributionFixture(); const o = f.origin(10n); f.evidence.facts = Array(10001).fill(o); expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
  const large = attributionFixture(); source(large.origin(10n)).transaction.metadata['payload'] = 'x'.repeat(1048577); expect(() => attributeGemsFlowEvidence(large.evidence)).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
 });
 it('does not mutate input or let a later refund rewrite an earlier-cutoff result', () => {
  const f = attributionFixture(); f.origin(100n); const spent = f.spend(50n, { raidId: randomUUID() }), earlier = f.snapshot(); earlier.day = '2035-01-01'; const before = attributeGemsFlowEvidence(earlier), copy = structuredClone(earlier);
  f.clock('2035-01-02T00:00:00.000000Z'); f.refund(spent); expect(attributeGemsFlowEvidence(f.evidence).debits[0]?.candidateConvertedGems.custodial).toBe('0'); expect(attributeGemsFlowEvidence(earlier)).toEqual(before); expect(earlier).toEqual(copy); expect(before.debits[0]?.candidateConvertedGems.custodial).toBe('50');
 });
 it('replays real grant/conversion/debit/SHARDS and the ordinary buff refund helper across days, including pause', async () => withGemsFlow(async f => {
  await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.budget', entries: [{ account: f.sys.keep_genesis, delta: -100n }, { account: f.sys.emission_pool, delta: 100n }] }); await fundGemsRewardBudget(f.conn.db, 100n, randomUUID()); await grantGems(f.conn.db, { wallet: f.wallet, gems: 100n, reason: 'dev' });
  await convertKeepToGems(f.conn.db, f.wallet, 200n, randomUUID()); const raidId = randomUUID();
  await f.conn.sql`insert into raids(id,attacker_wallet,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status) values(${raidId},${f.wallet},1,1,'{}','{}','{}','2035-01-03','pending_orders')`;
  await f.conn.sql`insert into raid_commands(raid_id,sequence,client_command_id,kind,payload,server_offset_ms,payload_hash) values(${raidId},1,${randomUUID()},'buff','{"buff":"warhorn"}',0,'fixture')`;
  await spendGems(f.conn.db, f.wallet, 150n, 'raid.buffs', `raid:${raidId}:live-buff:warhorn`, { raidId, buff: 'warhorn', live: true }); await convertGemsToShards(f.conn.db, f.wallet, 50n, randomUUID());
  await f.clock('2035-01-02T00:00:00Z'); const prior = await readGemsFlowAttribution(f.conn.db, { wallet: f.wallet, day: '2035-01-01' }); expect(prior.debits[0]?.candidateConvertedGems.custodial).toBe('50');
  expect(await refundUnstartedLiveBuffs(f.conn.db, raidId, f.wallet)).toBe(1); expect(await refundUnstartedLiveBuffs(f.conn.db, raidId, f.wallet)).toBe(1);
  await spendGems(f.conn.db, f.wallet, 130n, 'build.speedup', randomUUID(), { jobId: randomUUID() }); await f.clock('2035-01-03T00:00:00Z');
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); const after = await readGemsFlowAttribution(f.conn.db, { wallet: f.wallet, day: '2035-01-02' }); expect(after.balanceGems).toBe('120'); expect(after.refunds).toHaveLength(1); expect(after.debits[2]?.candidateConvertedGems.custodial).toBe('100'); expect(await readGemsFlowAttribution(f.conn.db, { wallet: f.wallet, day: '2035-01-01' })).toEqual(prior);
 }), 30000);
 it('refuses quadratic refund composition growth at a bounded segment budget instead of truncating lots', () => {
  const f = attributionFixture(); for (let i = 0; i < 1000; i++) f.origin(1n, 'grant');
  for (let i = 0; i < 51; i++) { const spent = f.spend(1000n, { raidId: randomUUID() }); f.refund(spent); }
  expect(() => attributeGemsFlowEvidence(f.evidence)).toThrowError(expect.objectContaining({ code: 'TOO_LARGE' }));
 });

});
