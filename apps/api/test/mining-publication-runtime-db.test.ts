/** the content pipeline-queued integration gate. AUTHORED, NOT EXECUTED in the MS-S lane.
 * Uses real disposable PostgreSQL migrations/custody/outbox/settlement/projection.
 * Only external RPC is a serialized local chain fixture; the existing fixture
 * generates and signs with throwaway keys, so execution requires the content pipeline's exact
 * DB/fixture/signing admission. No live RPC, operator key, or activation is used.
 *
 * This fixture's synthetic genesis intentionally cannot enter the devnet-only
 * runtime scanner. Actual scanner SQL/owner/keyset coverage remains a separate
 * gate requiring a properly composed devnet-identity fixture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { buildMiningAllocationTree, encodeMiningAllocationLeaf, encodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import type { MiningContributionLine } from '@shardkeep/shared/miningContribution';
import { createMiningPublicationFixture } from '../../../packages/chain/src/testFixtures/miningPublication';
import { withFundedMiningReplayFixture as baseFixture, type FundedReplayFixture } from './fixtures/fundedMiningReplay';
import { createDb } from '../src/db/client';
import { createMiningPublicationOutbox } from '../src/mining/publicationOutbox';
import { createMiningPublicationReconciler, type MiningPublicationTransport } from '../src/mining/publicationReconcile';
import { createMiningClaimEntitlementReader, projectMiningClaimEntitlements } from '../src/mining/claimEntitlement';
import { loadAuditedMiningPrior } from '../src/mining/publicationHistory';
import { readMiningContribution } from '../src/game/miningContributions';

const fixture: typeof baseFixture = (run, options = {}) => baseFixture(run, { ...options, publicationClock: true });

const baskets = (): { free: MiningContributionLine[]; paid: MiningContributionLine[] } => ({
  free: [{ resourceId: 'forge_ingot', quantity: '1' }, { resourceId: 'heartwood_logs', quantity: '20' }, { resourceId: 'shards', quantity: '200' }],
  paid: [{ resourceId: 'forge_ingot', quantity: '1' }, { resourceId: 'heartwood_logs', quantity: '40' }, { resourceId: 'shards', quantity: '700' }],
});

async function signedResource(f: FundedReplayFixture) {
  const stage = await f.stageResources('2020-01-01', baskets());
  const prepared = await stage.prepare(stage.request);
  if (prepared.status !== 'prepared') throw Error('Fixture requires an actual useful resource publication');
  const request = { epochId: prepared.epochId, attemptKey: prepared.attemptKey };
  const original = await createMiningBackingSnapshotReader(stage.backing.reader, stage.backing.trust)();
  const outbox = createMiningPublicationOutbox(f.conn.db, { reader: stage.backing.reader, trust: stage.backing.trust });
  await outbox.reserveSigning(request);
  const p = prepared.publication;
  const chain = await createMiningPublicationFixture('legacy', {
    signer: f.signer, identity: stage.backing.trust, genesisHash: stage.backing.trust.expectedGenesisHash,
    programData: stage.backing.programData, intentBytes: Buffer.from(prepared.intentHex, 'hex'),
    priorFrontier: original.config, vaultBefore: original.vaultAmount, reserveBefore: original.reserveAmount,
    publicationSlot: original.slot + 1,
    args: { sequence: BigInt(p.sequence), day: BigInt(p.day), kind: 0,
      root: Buffer.from(p.root, 'hex'), totalCumulative: BigInt(p.total), leafCount: p.leafCount,
      budgetGross: BigInt(p.budgetGross), freeGross: BigInt(p.freeGross), deedGross: BigInt(p.deedGross),
      sourceHash: Buffer.from(prepared.sourceHash, 'hex'), taxCommitment: Buffer.from(p.taxCommitment, 'hex'), taxVersion: p.taxVersion },
  });
  const signed = await outbox.acceptSigned({ ...request, signedTransaction: chain.request.signedTransaction });
  let landed = false;
  const getTransaction = chain.reader.getTransaction;
  chain.reader.getTransaction = vi.fn(async signature => landed
    ? getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }) : null);
  const transport = {
    getGenesisHash: vi.fn<MiningPublicationTransport['getGenesisHash']>(async () => stage.backing.trust.expectedGenesisHash),
    getSignatureStatuses: vi.fn<MiningPublicationTransport['getSignatureStatuses']>(async () => ({ context: { slot: original.slot + 20 }, value: [null] })),
    getBlockHeight: vi.fn<MiningPublicationTransport['getBlockHeight']>(async () => p.lastValidBlockHeight),
    sendRawTransaction: vi.fn<MiningPublicationTransport['sendRawTransaction']>(async () => chain.request.signature),
  };
  const sources = { backing: { reader: stage.backing.reader, trust: stage.backing.trust },
    settlement: { reader: chain.reader, trust: chain.trusted }, transport: () => transport };
  const make = (domain?: 'resources') => createMiningPublicationReconciler(f.conn.db, { ...sources, ...(domain ? { domain } : {}) });
  const terminals = () => f.conn.sql`select receipt_id,outcome,epoch_id,shards_txn_id,settled_at from mining_contribution_terminals where epoch_id=${request.epochId} order by receipt_id`;
  return { stage, prepared, request, chain, signed, outbox, transport, make, terminals, land: () => { landed = true; } };
}

afterEach(() => vi.unstubAllEnvs());

describe('resource publication runtime real SQL gate', () => {
  it('R1: omitted domain holds a signed resource original without sending or returning its basket', async () => fixture(async f => {
    const h = await signedResource(f);
    const originals = await f.conn.sql`select receipt_id,resource_id,quantity from mining_contribution_lines order by receipt_id,resource_id`;
    const pending = await f.conn.sql`select base_id,resource_id,available,mining_pending from resource_stocks order by base_id,resource_id`;
    expect(originals).toHaveLength(6);
    expect(pending).toHaveLength(2);
    expect(pending.every(row => BigInt(row.mining_pending) > 0n)).toBe(true);
    expect(await h.make()(h.request)).toMatchObject({ status: 'held', reason: 'SETTLEMENT_HELD', signature: h.chain.request.signature });
    expect(h.transport.getGenesisHash).not.toHaveBeenCalled();
    expect(h.transport.sendRawTransaction).not.toHaveBeenCalled();
    expect(await h.terminals()).toHaveLength(0);
    expect(await f.conn.sql`select receipt_id,resource_id,quantity from mining_contribution_lines order by receipt_id,resource_id`).toEqual(originals);
    expect(await f.conn.sql`select base_id,resource_id,available,mining_pending from resource_stocks order by base_id,resource_id`).toEqual(pending);
    expect(await h.outbox.get(h.request.epochId)).toEqual(h.signed);
  }), 180_000);

  it('R2: explicit resources sends only bytes already committed in SQL and leaves acknowledgement unsettled', async () => fixture(async f => {
    const h = await signedResource(f);
    h.transport.sendRawTransaction.mockImplementation(async wire => {
      const [saved] = await f.conn.sql`select signature,encode(signed_transaction,'hex') wire from mining_publication_signed_wires where epoch_id=${h.request.epochId}`;
      expect(saved).toEqual({ signature: h.chain.request.signature, wire: Buffer.from(wire).toString('hex') });
      expect(Buffer.from(wire)).toEqual(Buffer.from(h.chain.request.signedTransaction));
      expect(await h.terminals()).toHaveLength(0);
      return h.chain.request.signature;
    });
    expect(await h.make('resources')(h.request)).toMatchObject({ status: 'submitted', signature: h.chain.request.signature, publicationFinalized: false });
    expect(h.transport.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(h.transport.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false, maxRetries: 0, preflightCommitment: 'finalized' });
    expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(0);
    expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_headers`).toHaveLength(0);
    expect(await h.terminals()).toHaveLength(0);
  }), 180_000);

  it('R3: finalized original settles once while paused and a fresh connection recovers an atomic failed projection', async () => fixture(async f => {
    const h = await signedResource(f);
    expect(await h.make('resources')(h.request)).toMatchObject({ status: 'submitted' });
    h.land(); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    const result = await h.make('resources')(h.request);
    expect(result.status).toBe('settled');
    if (result.status !== 'settled' || !('contributions' in result.settlement)) throw Error('Real resource settlement required');
    const expected = JSON.parse(h.prepared.manifestJson).contributions;
    expect(result.settlement.contributions).toEqual(expected);
    expect(result.settlement.contributions).toHaveLength(2);
    expect(result.settlement.contributions.every(row => row.outcome === 'consumed')).toBe(true);
    const terminalRows = await h.terminals(); expect(terminalRows).toHaveLength(2);
    const stocks = await f.conn.sql`select base_id,resource_id,available,mining_pending from resource_stocks order by base_id,resource_id`;
    expect(stocks).toHaveLength(2);
    expect(stocks.every(row => row.mining_pending === '0')).toBe(true);
    expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions where epoch_id=${h.request.epochId}`).toHaveLength(0);
    expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_headers`).toHaveLength(0);
    for (const original of [h.stage.free, h.stage.paid]) {
      const wallet = original === h.stage.free ? f.wallet : f.buyer;
      expect((await readMiningContribution(f.conn.db, wallet, original.command.idempotencyKey)).settlement?.outcome).toBe('consumed');
    }

    // An actual deferred commit failure must leave neither a header nor any
    // partial leaf, while the already committed settlement remains recoverable.
    await f.conn.sql.unsafe(`create function fixture_mss_projection_failure() returns trigger language plpgsql as $$ begin raise exception 'FIXTURE_MSS_PROJECTION'; end $$;
      create constraint trigger fixture_mss_projection_failure after insert on mining_claim_entitlement_leaves deferrable initially deferred for each row execute function fixture_mss_projection_failure()`);
    try {
      await expect(projectMiningClaimEntitlements(f.conn.db, { epochId: h.request.epochId })).rejects.toThrow('FIXTURE_MSS_PROJECTION');
      expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_headers`).toHaveLength(0);
      expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_leaves`).toHaveLength(0);
    } finally {
      await f.conn.sql.unsafe('drop trigger fixture_mss_projection_failure on mining_claim_entitlement_leaves; drop function fixture_mss_projection_failure()');
    }

    const restarted = createDb(f.url.toString(), { max: 1 });
    try {
      const header = await projectMiningClaimEntitlements(restarted.db, { epochId: h.request.epochId });
      expect(header).toMatchObject({ root: h.prepared.publication.root, totalCumulative: h.prepared.publication.total,
        leafCount: h.prepared.publication.leafCount, publicationSignature: h.chain.request.signature });
      const audited = await loadAuditedMiningPrior(restarted.db, { ...f.identity,
        reserveOwner: h.chain.trusted.reserveOwner.toBase58(), reviewedDeploymentSlot: h.chain.trusted.reviewedDeploymentSlot,
        reviewedProgramDataSha256: h.chain.trusted.reviewedProgramDataSha256, sequence: h.prepared.publication.sequence });
      const tree = buildMiningAllocationTree(audited.declaration.leaves);
      const leaves = await restarted.sql`select wallet,leaf_index,encode(leaf_bytes,'hex') leaf,encode(proof_bytes,'hex') proof from mining_claim_entitlement_leaves where epoch_id=${h.request.epochId} order by leaf_index`;
      expect(leaves).toEqual(tree.leaves.map((leaf, leaf_index) => ({ wallet: leaf.wallet, leaf_index,
        leaf: Buffer.from(encodeMiningAllocationLeaf(leaf)).toString('hex'), proof: Buffer.from(encodeMiningAllocationProof(tree.proof(leaf_index))).toString('hex') })));
      for (const wallet of [f.wallet, f.buyer]) expect((await createMiningClaimEntitlementReader(restarted.db, f.identity)(wallet)).kind).toBe('entitlement');
      expect(await projectMiningClaimEntitlements(restarted.db, { epochId: h.request.epochId })).toEqual(header);
    } finally { await restarted.sql.end(); }
    h.chain.reader.getGenesisHash = async () => { throw Error('Saved settlement recovery must not call RPC'); };
    expect(await h.make('resources')(h.request)).toEqual(result);
    expect(h.transport.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await h.terminals()).toEqual(terminalRows);
    expect(await f.conn.sql`select base_id,resource_id,available,mining_pending from resource_stocks order by base_id,resource_id`).toEqual(stocks);
    expect(await f.conn.sql`select epoch_id from mining_publication_settlements where epoch_id=${h.request.epochId}`).toHaveLength(1);
  }), 180_000);
});
