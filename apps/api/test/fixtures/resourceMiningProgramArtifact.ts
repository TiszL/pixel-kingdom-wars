/** Native SQL baskets -> canonical manifest5 -> actual validator publication.
 * Historical Core/Seeker facts remain explicit serialized upstream fixtures;
 * backing, signed publication and finality use the owned validator's real RPC. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { FORGE_INGOT, PHASE_E_MINING_CONTRIBUTION_V2 as POLICY } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { ORDINARY_REFINED_IDS } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { valueMiningContribution, type MiningContributionLine } from '@shardkeep/shared/miningContribution';
import type { MiningPublicationReader } from '@shardkeep/chain/mining-publication';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import { fixture as deedBank } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createMiningZeroWinnerTermFixture } from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { createResourceMiningPublicationPreparer } from '../../src/mining/fundedMiningAllocation';
import { miningCanonical, miningDigest } from '../../src/mining/fundedMiningAudit';
import { getResourceMiningPublicationAttempt } from '../../src/mining/resourcePublicationCustody';
import { getPreparedMiningPublication, type PreparedMiningPublication } from '../../src/mining/publicationPreparation';
import { createMiningPublicationOutbox } from '../../src/mining/publicationOutbox';
import { createResourceMiningPublicationSettlement } from '../../src/mining/publicationSettlement';
import { projectMiningClaimEntitlements, createMiningClaimEntitlementReader } from '../../src/mining/claimEntitlement';
import { readMiningContribution, reserveMiningContribution } from '../../src/game/miningContributions';
import { getBaseShardBalance } from '../../src/game/baseEconomy';
import type { ResourceMiningManifest } from '../../src/mining/resourceMiningAudit';
import type { FundedReplayFixture } from './fundedMiningReplay';
import type { FundedMiningProgramBridge, FundedMiningProgramContext } from '../../../../programs/mining-local-funded';

const day = '2020-01-01';
function baskets(): { free: MiningContributionLine[]; paid: MiningContributionLine[] } {
  const free: MiningContributionLine[] = [{ resourceId: 'forge_ingot', quantity: '1' },
    { resourceId: 'heartwood_logs', quantity: '10' }, { resourceId: 'frostglass', quantity: '1' }];
  const remaining = BigInt(POLICY.freeValuePerWalletDay) - BigInt(valueMiningContribution(free, POLICY.version).totalValue);
  assert(remaining > 0n); free.push({ resourceId: 'shards', quantity: String(remaining) });
  return { free, paid: [{ resourceId: 'forge_ingot', quantity: '1' },
    { resourceId: 'shards', quantity: String(BigInt(FORGE_INGOT.capacity.deedMaxUnits + 1) * BigInt(POLICY.valuePerIngot)) },
    ...PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: '20' })),
    ...ORDINARY_REFINED_IDS.map(resourceId => ({ resourceId, quantity: '8' })), { resourceId: 'navigation_kit', quantity: '2' }] };
}

export function createResourceMiningProgramBridge(f: FundedReplayFixture): FundedMiningProgramBridge {
  let context: FundedMiningProgramContext | undefined, prepared: PreparedMiningPublication | undefined;
  let reader: MiningPublicationReader | undefined, outbox: ReturnType<typeof createMiningPublicationOutbox> | undefined;
  let request: { epochId: string; attemptKey: string } | undefined;
  let stock: Awaited<ReturnType<FundedReplayFixture['stageResources']>> | undefined;
  let manifest: ResourceMiningManifest | undefined;
  return {
    async prepare(live) {
      assert(!context, 'Only one resource source publication belongs to this fixture'); context = live;
      const endpoint = new URL(live.connection.rpcEndpoint);
      assert.equal(endpoint.hostname, '127.0.0.1'); assert.equal(endpoint.protocol, 'http:');
      assert.equal(await live.connection.getGenesisHash(), live.trust.expectedGenesisHash);
      stock = await f.stageResources(day, baskets());
      assert.equal(stock.free.envelope.receipt!.totalValue, String(POLICY.freeValuePerWalletDay));
      assert(BigInt(stock.paid.envelope.receipt!.totalValue) > BigInt(FORGE_INGOT.capacity.deedMaxUnits) * BigInt(POLICY.valuePerIngot));
      const freeShards = await getBaseShardBalance(f.conn.db, f.baseId);
      await assert.rejects(reserveMiningContribution(f.conn.db, f.wallet,
        { ...stock.free.command, idempotencyKey: randomUUID(), lines: [{ resourceId: 'shards', quantity: '1' }] },
        f.context, { clock: () => new Date(day + 'T13:01:00Z') }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MINING_FREE_CAP_EXCEEDED');
      assert.equal(await getBaseShardBalance(f.conn.db, f.baseId), freeShards, 'Rejected free overflow cannot debit stock');
      assert.equal((await f.conn.sql`select id from mining_contribution_receipts where epoch_id=${stock.request.epochId}`).length, 2);
      const bank = stock.stock.bank;
      // Bind serialized upstream history to A before capturing the native source.
      // This does not claim an actual local Core mint or historical Seeker auction.
      const qualification = {
        collection: bank.input.collection, expectedGenesisHash: live.trust.expectedGenesisHash,
        source: () => {
          const q = deedBank(bank.transactions, [{ id: new PublicKey(f.assetId), owner: new PublicKey(f.buyer) }]);
          q.reader.getGenesisHash.mockResolvedValue(live.trust.expectedGenesisHash);
          q.reader.getBlockTime.mockImplementation(slot => bank.reader.getBlockTime(slot));
          q.reader.getBlockSignatures.mockImplementation(slot => bank.reader.getBlockSignatures(slot));
          return q.reader as unknown as DeedMiningWalletReader;
        },
      };
      const term = await createMiningZeroWinnerTermFixture({ day,
        genesisHash: new PublicKey(live.trust.expectedGenesisHash), programId: new PublicKey(live.trust.programId.toBase58()),
        programData: Buffer.from(live.programData), programDataAddress: new PublicKey(live.programDataAddress.toBase58()),
        upgradeAuthority: new PublicKey(live.upgradeAuthority.toBase58()),
      });
      reader = {
        getGenesisHash: () => live.connection.getGenesisHash(),
        getSlot: commitment => live.connection.getSlot(commitment),
        getTransaction: (signature, options) => live.connection.getTransaction(signature, options),
        async getMultipleAccountsInfoAndContext(addresses, options) {
          const result = await live.connection.getMultipleAccountsInfoAndContext(addresses, options);
          return { context: result.context, value: result.value.map((account: AccountInfo<Buffer> | null, index: number) => account === null
            ? null : { ...account, address: addresses[index]! }) };
        },
      };
      const input = { epochId: stock.request.epochId, day, policyVersion: POLICY.version, attemptKey: randomUUID() };
      request = { epochId: input.epochId, attemptKey: input.attemptKey };
      const prepare = createResourceMiningPublicationPreparer(f.conn.db, {
        sources: { qualification, backing: { reader, trust: live.trust }, tax: { connect: term.connect, policy: term.policy } },
        signer: live.publisher, blockhashSource: () => live.connection,
      });
      const result = await prepare(input); assert.equal(result.status, 'prepared');
      if (result.status !== 'prepared') throw Error('Actual resource allocation did not prepare');
      prepared = result;
      assert.deepEqual(await prepare(input), result, 'Preparation replay retains the exact original resource intent');
      assert.deepEqual(await getPreparedMiningPublication(f.conn.db, result.epochId), result);
      assert.equal(result.publication.leafCount, 2);
      assert(BigInt(result.publication.freeGross) > 0n && BigInt(result.publication.deedGross) > 0n);
      assert.equal(result.publication.taxVersion, 1, 'Explicit original zero-winner tax hold');
      manifest = JSON.parse(result.manifestJson) as ResourceMiningManifest;
      assert.equal(manifest.version, 5); assert.equal(manifest.scope, 'ordinary-resource-mining-v2');
      assert.equal(manifest.input.policyVersion, POLICY.version); assert.equal(manifest.epoch.key, `resource-mining-v2:${day}`);
      assert.equal(miningCanonical(manifest), result.manifestJson); assert.equal(miningDigest(result.manifestJson), result.sourceHash);
      assert.equal(manifest.funding.source.genesisHash, live.trust.expectedGenesisHash);
      assert.equal(Object.hasOwn(manifest, 'reservations'), false); assert.equal(Object.hasOwn(manifest.epoch, 'reservations'), false);
      const attempt = await getResourceMiningPublicationAttempt(f.conn.db, result.epochId); assert(attempt);
      assert.deepEqual(attempt.contributions, manifest.epoch.contributions);
      assert.equal(attempt.contributionSetSha256, miningDigest(miningCanonical(attempt.contributions)));
      assert.equal(attempt.contributionSetSha256, manifest.epoch.contributionSetSha256);
      assert.equal(attempt.contributionCount, 2);
      assert.equal(attempt.reservedValue, String(BigInt(stock.free.envelope.receipt!.totalValue) + BigInt(stock.paid.envelope.receipt!.totalValue)));
      const paid = manifest.participants.find(row => row.wallet === f.buyer), free = manifest.participants.find(row => row.wallet === f.wallet);
      assert(paid && free); assert.equal(paid.capacityValue, null); assert.equal(paid.eligibleValue, stock.paid.envelope.receipt!.totalValue);
      assert.equal(free.capacityValue, String(POLICY.freeValuePerWalletDay)); assert.equal(free.eligibleValue, free.capacityValue);
      for (const row of manifest.participants) assert.equal(Object.hasOwn(row, 'reservedUnits'), false);
      assert.deepEqual(manifest.contributions.map(row => row.id).sort(), [stock.free.command.idempotencyKey, stock.paid.command.idempotencyKey].sort());
      assert(manifest.contributions.every(row => row.outcome === 'consumed'));
      assert.equal((await f.conn.sql`select id from mining_ingot_reservations where epoch_id=${result.epochId}`).length, 0);
      assert.equal((await f.conn.sql`select receipt_id from mining_contribution_terminals`).length, 0);
      outbox = createMiningPublicationOutbox(f.conn.db, { reader, trust: live.trust });
      await outbox.reserveSigning(request);
      return result;
    },
    async acceptSigned(wire) {
      assert(outbox && request); await outbox.acceptSigned({ ...request, signedTransaction: wire });
      const admitted = await outbox.admitBroadcast(request);
      assert(Buffer.from(admitted.signedTransaction).equals(Buffer.from(wire)), 'Only the original persisted signed resource wire can broadcast');
    },
    async settle(signature, wire) {
      assert(context && reader && prepared && request && stock && manifest);
      assert.equal(await context.connection.getGenesisHash(), context.trust.expectedGenesisHash);
      const settle = createResourceMiningPublicationSettlement(f.conn.db, { reader, trust: context.trust });
      const input = { ...request, signature, signedTransaction: wire }, settlement = await settle(input);
      assert.equal(settlement.receipt['sourceHash'], prepared.sourceHash);
      assert.deepEqual(settlement.contributions, manifest.contributions);
      for (const original of [stock.free, stock.paid]) {
        const terminal = settlement.contributions.find(row => row.id === original.command.idempotencyKey); assert(terminal);
        assert.equal(terminal.outcome, 'consumed'); assert.deepEqual(terminal.lines, original.envelope.receipt!.lines);
        assert.equal(terminal.totalValue, original.envelope.receipt!.totalValue);
      }
      const projection = await projectMiningClaimEntitlements(f.conn.db, { epochId: prepared.epochId });
      const inventory = async () => ({
        raw: await f.conn.sql`select base_id,resource_id,available::text,mining_pending::text from resource_stocks order by base_id,resource_id`,
        crafted: await f.conn.sql`select base_id,item_id,available::text,mining_pending::text from crafting_stocks order by base_id,item_id`,
        ingots: await f.conn.sql`select base_id,qty from base_items where item_id='forge_ingot' order by base_id`,
        shards: [String(await getBaseShardBalance(f.conn.db, f.baseId)), String(await getBaseShardBalance(f.conn.db, f.paidBaseId))],
      });
      const beforeReplay = await inventory();
      for (const row of [...beforeReplay.raw, ...beforeReplay.crafted]) { assert.equal(row.available, '0'); assert.equal(row.mining_pending, '0'); }
      assert(beforeReplay.ingots.every(row => row.qty === 0));
      assert.deepEqual(await settle(input), settlement, 'Finalized replay cannot consume native stock twice');
      assert.deepEqual(await projectMiningClaimEntitlements(f.conn.db, { epochId: prepared.epochId }), projection);
      assert.deepEqual(await inventory(), beforeReplay, 'Recovery cannot grant or debit stock');
      const rows = await f.conn.sql`select t.receipt_id,t.outcome from mining_contribution_terminals t join mining_contribution_receipts r on r.id=t.receipt_id where r.epoch_id=${prepared.epochId} order by t.receipt_id`;
      assert.equal(rows.length, 2); assert(rows.every(row => row.outcome === 'consumed'));
      for (const [wallet, original] of [[f.wallet, stock.free], [f.buyer, stock.paid]] as const) {
        const recovered = await readMiningContribution(f.conn.db, wallet, original.command.idempotencyKey);
        assert.deepEqual(recovered.receipt, original.envelope.receipt); assert.equal(recovered.settlement?.outcome, 'consumed');
      }
      const read = createMiningClaimEntitlementReader(f.conn.db, {
        genesisHash: context.trust.expectedGenesisHash, programId: context.trust.programId.toBase58(),
        configAddress: miningConfigPda(context.trust.programId).toBase58(),
      });
      const claims = [];
      for (const wallet of [f.wallet, f.buyer]) {
        const earned = await read(wallet); assert.equal(earned.kind, 'entitlement');
        if (earned.kind !== 'entitlement') throw Error('Missing native-source claim entitlement');
        assert.equal(earned.leaf.cumulativeRenown, '1'); assert.equal(earned.leaf.cumulativeDays, '1');
        assert(BigInt(earned.leaf.cumulativeKeep) > 0n);
        claims.push({ wallet, leafHex: earned.leafHex, proofHex: earned.proofHex });
      }
      return { sourceHash: prepared.sourceHash, dbReplayStable: true, claims,
        evidence: { sourcePremise: 'Serialized upstream deed and zero-winner Seeker history; explicit raw/refined opening stock, real Workshop ingots, native SQL custody/allocation and actual A publication',
          prepared, settlement, projection, nativeTerminals: rows, settledInventory: beforeReplay } };
    },
  };
}
