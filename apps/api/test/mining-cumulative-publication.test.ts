import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { loadAuditedMiningPrior, loadAuditedMiningPriorForBacking } from '../src/mining/publicationHistory';
import { withCumulativeFreePublicationFixture as fixture } from './fixtures/cumulativeFreePublication';

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
type Stage = Awaited<ReturnType<Fixture['stageDay']>>;
const historyIdentity = (f: Fixture) => ({ ...f.identity, keepMint: f.backing.trust.keepMint.toBase58(),
  reserveOwner: f.backing.trust.reserveOwner.toBase58(), reviewedDeploymentSlot: f.backing.trust.reviewedDeploymentSlot,
  reviewedProgramDataSha256: f.backing.trust.reviewedProgramDataSha256 });
async function held(f: Fixture, stage: Stage) {
  const [r] = await f.conn.sql`select
    (select count(*)::int from mining_publication_attempts where epoch_id=${stage.request.epochId}) attempts,
    (select count(*)::int from mining_publication_settlements where epoch_id=${stage.request.epochId}) settlements,
    (select count(*)::int from mining_ingot_dispositions where epoch_id=${stage.request.epochId}) dispositions`;
  expect(r).toEqual({ attempts: 0, settlements: 0, dispositions: 0 });
  const [stock] = await f.conn.sql`select qty from mining_ingot_reservations where id=${stage.reservation.receipt.id}`;
  expect(stock?.qty).toBe(stage.reservation.receipt.ingots);
}

describe('complete cumulative free publication custody', () => {
  it('settles three real days, preserves the inactive player, carries rounding and spends each ingot only once', async () => fixture(async f => {
    const first = await f.first();
    const prior = await loadAuditedMiningPrior(f.conn.db, { ...historyIdentity(f), sequence: '1' });
    const inactive = prior.declaration.leaves.find(l => l.wallet === f.buyer)!.cumulativeKeep;
    const continuing = prior.declaration.leaves.find(l => l.wallet === f.wallet)!.cumulativeKeep;
    expect(inactive).toBeGreaterThan(0n); expect(continuing).toBeGreaterThan(0n);
    expect(first.reservation.signed).toBeNull(); expect(first.signed.signed?.signedTransactionHex).toBe(Buffer.from(first.chain.request.signedTransaction).toString('hex'));
    expect(first.settlement.dispositions).toHaveLength(2);

    const secondDay = await f.stageDay('2020-01-02', { quantity: 3, claimedAdvance: 1n, taxPaidAdvance: 1n });
    const bank = await createMiningBackingSnapshotReader(secondDay.backing.reader, secondDay.backing.trust)();
    const retained = await loadAuditedMiningPriorForBacking(f.conn.db, bank);
    expect(retained.reference).toEqual(prior.reference);
    expect(bank.playerOutstanding).toBe(prior.frontier.totalPublishedHighwater - 1n);
    expect(bank.taxOutstanding).toBe(prior.frontier.taxHighwater - 1n);
    expect(bank.vaultAmount).toBe(first.chain.afterTokenBalance.vaultAfter - 2n + secondDay.topUp);
    expect(bank.availableBudget).toBe(bank.vaultAmount - bank.playerOutstanding - bank.taxOutstanding);
    const second = await secondDay.publish();
    const secondHistory = await loadAuditedMiningPrior(f.conn.db, { ...historyIdentity(f), sequence: '2' });
    expect(secondHistory.declaration.leaves).toHaveLength(2);
    expect(secondHistory.declaration.leaves.find(l => l.wallet === f.buyer)).toMatchObject({ cumulativeKeep: inactive, sequence: 2n });
    expect(secondHistory.declaration.leaves.find(l => l.wallet === f.wallet)).toMatchObject({ cumulativeKeep: continuing + BigInt(second.prepared.publication.playerNet), sequence: 2n });
    expect(second.settlement.dispositions).toEqual([expect.objectContaining({ actorWallet: f.wallet, consumed: 2, returned: 1 })]);
    const m2 = JSON.parse(second.prepared.manifestJson);
    expect(m2.participants.map((p: { wallet: string }) => p.wallet)).toEqual([f.wallet]);
    expect(m2.previousPublication).toEqual(prior.reference);
    expect(second.prepared.publication.splitStart).toBe(first.prepared.publication.splitEnd);
    expect(second.prepared.publication.splitEnd).not.toBe(0);

    const thirdDay = await f.stageDay('2020-01-03', { claimedAdvance: 1n });
    const third = await thirdDay.publish();
    const final = await loadAuditedMiningPrior(f.conn.db, { ...historyIdentity(f), sequence: '3' });
    expect(final.declaration.leaves.find(l => l.wallet === f.buyer)).toMatchObject({ cumulativeKeep: inactive, sequence: 3n });
    expect(final.declaration.leaves.find(l => l.wallet === f.wallet)).toMatchObject({
      cumulativeKeep: continuing + BigInt(second.prepared.publication.playerNet) + BigInt(third.prepared.publication.playerNet),
      cumulativeRenown: 0n, cumulativeDays: 0n, sequence: 3n });
    expect(third.prepared.publication.splitStart).toBe(second.prepared.publication.splitEnd);
    expect(third.chain.nextFrontier.totalClaimed).toBe(2n); expect(third.chain.nextFrontier.taxPaid).toBe(1n);
    expect(third.chain.afterTokenBalance.vaultAfter).toBe(second.chain.afterTokenBalance.vaultAfter - 1n - BigInt(third.prepared.publication.recycle));
    expect(third.chain.afterTokenBalance.reserveAfter).toBe(first.original.reserveAmount + final.frontier.recycledTotal);
    expect(await second.settle()).toEqual(second.settlement); expect(await third.settle()).toEqual(third.settlement);
    const [counts] = await f.conn.sql`select count(*)::int count,sum(consumed_qty)::int consumed,sum(returned_qty)::int returned from mining_ingot_dispositions`;
    expect(counts).toEqual({ count: 4, consumed: 5, returned: 1 });
    const [inventory] = await f.conn.sql`select qty from base_items where base_id=${f.baseId} and item_id='forge_ingot'`;
    expect(inventory?.qty).toBe(1);

    process.env.PHASE_E_MINING_ENABLED = 'false';
    for (const source of [first.chain.reader, second.chain.reader, third.chain.reader, thirdDay.backing.reader]) source.getGenesisHash = async () => { throw Error('Historical recovery must not read RPC'); };
    expect(await getPreparedMiningPublication(f.conn.db, second.prepared.epochId)).toEqual(second.prepared);
    expect(await getPreparedMiningPublication(f.conn.db, third.prepared.epochId)).toEqual(third.prepared);
    expect(await third.settle()).toEqual(third.settlement);
  }), 120_000);

  it('refuses stale or fabricated current frontiers before pinning or consuming the next day', async () => fixture(async f => {
    await f.first(); const stage = await f.stageDay('2020-01-02');
    const expected = stage.backing.model.total_published_highwater;
    stage.backing.model.total_published_highwater = expected + 1n; await stage.backing.config();
    await expect(stage.prepare(stage.request)).rejects.toMatchObject({ code: 'PRIOR_PUBLICATION_UNAVAILABLE' });
    await held(f, stage);
    stage.backing.model.total_published_highwater = expected;
    stage.backing.model.latest_sequence = 2n; await stage.backing.config();
    await expect(stage.prepare(stage.request)).rejects.toMatchObject({ code: 'PRIOR_PUBLICATION_UNAVAILABLE' });
    await held(f, stage);
  }), 120_000);

  it('holds real stock when current evidence is unavailable and rejects caller-supplied historical substitutions', async () => fixture(async f => {
    await f.first(); const stage = await f.stageDay('2020-01-02');
    const original = stage.backing.reader.getMultipleAccountsInfoAndContext;
    stage.backing.reader.getMultipleAccountsInfoAndContext = async () => { throw Error('Provider unavailable'); };
    await expect(stage.prepare(stage.request)).rejects.toMatchObject({ code: 'PUBLICATION_SOURCE_UNAVAILABLE' });
    await held(f, stage); stage.backing.reader.getMultipleAccountsInfoAndContext = original;
    const prior = await loadAuditedMiningPrior(f.conn.db, { ...historyIdentity(f), sequence: '1' });
    await expect(loadAuditedMiningPrior(f.conn.db, { ...historyIdentity(f), sequence: '1',
      expectedReference: { ...prior.reference, epochId: randomUUID() } })).rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
    await expect(stage.prepare({ ...stage.request, previousPublication: prior })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await held(f, stage);
    expect((await stage.publish()).settlement.dispositions[0]).toMatchObject({ actorWallet: f.wallet, consumed: 1, returned: 0 });
  }), 120_000);
});
