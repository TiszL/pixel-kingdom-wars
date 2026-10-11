/** Real DB + exact signed legacy messages + serialized finalized account/tx ABI. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { decodeMiningAllocationLeaf, decodeMiningAllocationProof, verifyMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { sessions } from '../src/db/schema';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createMiningClaimEntitlementReader, createMiningClaimEntitlementHistoryReader } from '../src/mining/claimEntitlement';
import { createMiningClaimReader } from '../src/mining/claimStatus';
import { acceptMiningClaimSigned } from '../src/mining/claimSignedStore';
import { withCumulativeMiningClaimFixture as fixture } from './fixtures/cumulativeMiningClaim';
import { TEST_CONFIG } from './helpers';

afterEach(() => vi.unstubAllEnvs());

describe('successive funded mining claims', () => {
  it('pays the first entitlement and only its next-day increment while retaining the inactive wallet in the full root', async () => fixture(async f => {
    const first = await f.firstClaim(), prior = await createMiningClaimEntitlementReader(f.conn.db, f.identity)(f.buyer);
    expect(prior.kind).toBe('entitlement'); if (prior.kind !== 'entitlement') throw Error('Inactive wallet had day-one earnings');
    const second = await f.nextClaim(), latest = await createMiningClaimEntitlementReader(f.conn.db, f.identity)(f.buyer);
    expect(latest.kind).toBe('entitlement'); if (latest.kind !== 'entitlement') throw Error('Inactive rights disappeared');
    expect(latest.leaf).toEqual({ ...prior.leaf, sequence: '2' });
    expect(verifyMiningAllocationProof(decodeMiningAllocationLeaf(Buffer.from(latest.leafHex, 'hex')),
      decodeMiningAllocationProof(Buffer.from(latest.proofHex, 'hex')), Buffer.from(latest.header.root, 'hex'), BigInt(latest.header.totalCumulative))).toBe(true);
    const leaf = decodeMiningAllocationLeaf(Buffer.from(second.preparedClaim.leafHex, 'hex'));
    expect(first.payment).toBeGreaterThan(0n); expect(second.payment).toBeGreaterThan(0n);
    expect(second.payment).toBe(leaf.cumulativeKeep - first.payment);
    expect(second.payment).toBe(BigInt(second.publication.prepared.publication.playerNet));
    expect(second.payment).toBeLessThan(leaf.cumulativeKeep);
    expect(second.preparedClaim).toMatchObject({ header: { sequence: '2' }, needsAta: false, needsMinerRecords: false, rentLamports: '0' });
    expect(second.quote.rentSpaces).toEqual([]); expect(second.preparedClaim.transactions.map(t => t.kind)).toEqual(['claim']);
    expect(second.publication.original.config.totalClaimed).toBe(first.payment);
    expect(second.publication.original.vaultAmount).toBe(first.postSnapshot.backing.vaultAmount);
    expect(second.postSnapshot.backing.config.totalClaimed).toBe(first.payment + second.payment);
    expect(second.postSnapshot.claimantAta.balanceBaseUnits).toBe(leaf.cumulativeKeep);
    expect(second.postSnapshot.backing.reserveAmount).toBe(second.bank.before.backing.reserveAmount);
    expect(second.postSnapshot.backing.config.taxPaid).toBe(0n);
    expect(await createMiningClaimReader(f.conn.db, { reader: second.receiptReader, trust: second.bank.trust }).status(f.wallet))
      .toMatchObject({ state: 'claimed', sequence: '2', amountBaseUnits: '0', alreadyClaimedBaseUnits: String(leaf.cumulativeKeep) });
    expect(await first.recover()).toEqual(first.settlement); expect(await first.recoverPreparation()).toEqual(first.preparedClaim);
    expect(await createMiningClaimEntitlementHistoryReader(f.conn.db, f.identity, '1')(f.buyer)).toEqual(prior);
    const stock = await f.conn.sql`select reservation_id,consumed_qty,returned_qty from mining_ingot_dispositions order by reservation_id`;
    expect(stock).toHaveLength(3); expect(stock.reduce((sum, r) => sum + r.consumed_qty, 0)).toBe(3);
    expect(await second.settle()).toEqual(second.settlement); expect(await first.settle()).toEqual(first.settlement);
    expect(await f.conn.sql`select reservation_id,consumed_qty,returned_qty from mining_ingot_dispositions order by reservation_id`).toEqual(stock);
    expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(2);
  }), 120_000);

  it('keeps original success and failed-attempt GETs private and RPC-free after the latest root advances and mining pauses', async () => fixture(async f => {
    const first = await f.firstClaim({ failedAttemptFirst: true }), failure = first.earlierFailure;
    expect(failure).not.toBeNull(); if (!failure) throw Error('Expected genuine finalized failed attempt');
    expect(failure.failure.receipt).toMatchObject({ outcome: 'failed', sequence: '1', paymentAuthorized: false });
    expect(failure.failure.receipt).not.toHaveProperty('paidKeepBaseUnits');
    expect(first.tx.meta!.preBalances[0]).toBe(failure.tx.meta!.postBalances[0]);
    expect(first.tx.meta!.postBalances[0]).toBe(first.tx.meta!.preBalances[0]! - Number(first.preparedClaim.totalLamports));
    const second = await f.nextClaim();
    expect(failure.signed.signature).not.toBe(first.signed.signature);
    for (const reader of [first.bank.reader, first.receiptReader, second.bank.reader, second.receiptReader]) reader.getGenesisHash = async () => { throw Error('Historical GET touched RPC'); };
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    const restarted = createDb(f.url.toString());
    const cookie = async (wallet: string) => {
      const [session] = await f.conn.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    };
    const auth = await cookie(f.wallet), foreign = await cookie(f.buyer), app = await buildApp(TEST_CONFIG, restarted.db);
    try {
      for (const [record, state, amount] of [[first, 'settled', String(first.payment)], [failure, 'failed', null]] as const) {
        const result = await app.inject({ url: `/claims/mining/${record.preparedClaim.claimId}`, cookies: auth });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json()).toMatchObject({ state, landing: state === 'settled' ? 'finalized' : 'failed', signature: record.signed.signature, settledBaseUnits: amount });
        const preparation = await app.inject({ url: `/claims/mining/prepare/by-key/${record.preparedClaim.idempotencyKey}`, cookies: auth });
        expect(preparation.json()).toMatchObject({ status: 'prepared', receipt: { claimId: record.preparedClaim.claimId, rootSequence: '1' } });
        const invisible = await app.inject({ url: `/claims/mining/${record.preparedClaim.claimId}`, cookies: foreign });
        expect(invisible.json()).toMatchObject({ state: 'unknown', signature: null, settledBaseUnits: null });
      }
      expect(await first.recover()).toEqual(first.settlement); expect(await failure.recover()).toEqual(failure.failure);
      expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(2);
      expect(await f.conn.sql`select claim_id from mining_claim_failures`).toHaveLength(1);
    } finally { await app.close(); await restarted.sql.end(); }
  }), 120_000);

  it('exposes fresh sequence-two admission before any preparation or signed persistence, then verifies exactly the client-saved wire', async () => fixture(async f => {
    await f.firstClaim(); const stage = await f.nextAdmission();
    expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(1);
    expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
    const idempotencyKey = randomUUID(), prepared = await stage.service.prepare(f.wallet, { idempotencyKey });
    const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(prepared.transactions[0]!.messageHex, 'hex'))); tx.sign([stage.claimantSigner]);
    const wire = tx.serialize(), saved = await acceptMiningClaimSigned(f.conn.db, { wallet: f.wallet, claimId: prepared.claimId, signedTransaction: wire });
    const completed = await stage.completeClientClaim(idempotencyKey);
    expect(completed.preparedClaim).toEqual(prepared); expect(completed.signed).toEqual(saved);
    expect(Buffer.from(completed.wire)).toEqual(Buffer.from(wire)); expect(completed.settlement.signature).toBe(saved.signature);
    expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(2);
    expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(2);
  }), 120_000);
});
