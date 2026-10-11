/** Actual disposable DB source/settlement bridge. Only upstream historical
 * Core/Seeker transport remains serialized fixture evidence; backing and the
 * original publication receipt use the owned validator's actual RPC. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import type { MiningPublicationReader } from '@shardkeep/chain/mining-publication';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import { fixture as deedBank } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createMiningZeroWinnerTermFixture } from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { createFundedMiningPublicationPreparer } from '../../src/mining/fundedMiningAllocation';
import { getPreparedMiningPublication, type PreparedMiningPublication } from '../../src/mining/publicationPreparation';
import { createMiningPublicationOutbox } from '../../src/mining/publicationOutbox';
import { createMiningPublicationSettlement } from '../../src/mining/publicationSettlement';
import { projectMiningClaimEntitlements, createMiningClaimEntitlementReader } from '../../src/mining/claimEntitlement';
import type { withFundedMiningFixture } from './fundedMining';
import type { FundedMiningProgramBridge, FundedMiningProgramContext } from '../../../../programs/mining-local-funded';
type Fixture = Parameters<Parameters<typeof withFundedMiningFixture>[0]>[0];
const day = '2020-01-01';
export function createFundedMiningProgramBridge(f: Fixture): FundedMiningProgramBridge {
  let context: FundedMiningProgramContext | undefined, prepared: PreparedMiningPublication | undefined;
  let reader: MiningPublicationReader | undefined, outbox: ReturnType<typeof createMiningPublicationOutbox> | undefined;
  let request: { epochId: string; attemptKey: string } | undefined;
  return {
    async prepare(live) {
      assert(!context, 'Only one source publication belongs to this fixture'); context = live;
      const endpoint = new URL(live.connection.rpcEndpoint);
      assert.equal(endpoint.hostname, '127.0.0.1'); assert.equal(endpoint.protocol, 'http:');
      assert.equal(await live.connection.getGenesisHash(), live.trust.expectedGenesisHash);
      const stock = await f.admit(day), bank = stock.bank;
      // Regenerate upstream fixture transport for A before capturing any source
      // manifest. These are explicitly NOT actual local Core/Seeker executions.
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
          const bank = await live.connection.getMultipleAccountsInfoAndContext(addresses, options);
          return { context: bank.context, value: bank.value.map((account: AccountInfo<Buffer> | null, index: number) => account === null
            ? null : { ...account, address: addresses[index]! }) };
        },
      };
      const input = { epochId: stock.free.receipt.epochId, day, policyVersion: 1 as const, attemptKey: randomUUID() };
      request = { epochId: input.epochId, attemptKey: input.attemptKey };
      const prepare = createFundedMiningPublicationPreparer(f.conn.db, {
        sources: { qualification, backing: { reader, trust: live.trust }, tax: { connect: term.connect, policy: term.policy } },
        signer: live.publisher, blockhashSource: () => live.connection,
      });
      const result = await prepare(input); assert.equal(result.status, 'prepared');
      if (result.status !== 'prepared') throw Error('Actual source allocation did not prepare');
      prepared = result;
      assert.deepEqual(await prepare(input), result, 'Preparation replay must retain exact original intent');
      assert.deepEqual(await getPreparedMiningPublication(f.conn.db, result.epochId), result);
      assert.equal(result.publication.leafCount, 2);
      assert(BigInt(result.publication.freeGross) > 0n && BigInt(result.publication.deedGross) > 0n);
      assert.equal(result.publication.taxVersion, 1, 'Explicit original zero-winner tax hold');
      const manifest = JSON.parse(result.manifestJson);
      assert.equal(manifest.version, 3); assert.equal(manifest.scope, 'ordinary-paid-and-deedless-v1');
      assert.deepEqual(manifest.awards.map((award: { wallet: string }) => award.wallet).sort(), [f.wallet, f.buyer].sort());
      assert.equal(manifest.funding.source.genesisHash, live.trust.expectedGenesisHash);
      assert.equal((await f.conn.sql`select 1 from mining_ingot_dispositions where epoch_id=${result.epochId}`).length, 0);
      outbox = createMiningPublicationOutbox(f.conn.db, { reader, trust: live.trust });
      await outbox.reserveSigning(request);
      return result;
    },
    async acceptSigned(wire) {
      assert(outbox && request); await outbox.acceptSigned({ ...request, signedTransaction: wire });
      const admitted = await outbox.admitBroadcast(request);
      assert(Buffer.from(admitted.signedTransaction).equals(Buffer.from(wire)), 'Only original persisted signed wire can broadcast');
    },
    async settle(signature, wire) {
      assert(context && reader && prepared && request);
      assert.equal(await context.connection.getGenesisHash(), context.trust.expectedGenesisHash);
      const settle = createMiningPublicationSettlement(f.conn.db, { reader, trust: context.trust });
      const input = { ...request, signature, signedTransaction: wire }, settlement = await settle(input);
      assert.equal(settlement.receipt['sourceHash'], prepared.sourceHash);
      assert.equal(settlement.dispositions.length, 2);
      for (const disposition of settlement.dispositions) {
        assert.equal(disposition.consumed, 1); assert.equal(disposition.returned, 0);
      }
      const projection = await projectMiningClaimEntitlements(f.conn.db, { epochId: prepared.epochId });
      assert.deepEqual(await settle(input), settlement, 'Finalized replay cannot consume stock again');
      assert.deepEqual(await projectMiningClaimEntitlements(f.conn.db, { epochId: prepared.epochId }), projection);
      const rows = await f.conn.sql`select reservation_id,consumed_qty,returned_qty from mining_ingot_dispositions where epoch_id=${prepared.epochId} order by reservation_id`;
      assert.equal(rows.length, 2);
      const read = createMiningClaimEntitlementReader(f.conn.db, {
        genesisHash: context.trust.expectedGenesisHash, programId: context.trust.programId.toBase58(),
        configAddress: miningConfigPda(context.trust.programId).toBase58(),
      });
      const claims = [];
      for (const wallet of [f.wallet, f.buyer]) {
        const earned = await read(wallet); assert.equal(earned.kind, 'entitlement');
        if (earned.kind !== 'entitlement') throw Error('Missing source-derived claim entitlement');
        assert.equal(earned.leaf.cumulativeRenown, '1'); assert.equal(earned.leaf.cumulativeDays, '1');
        assert(BigInt(earned.leaf.cumulativeKeep) > 0n);
        claims.push({ wallet, leafHex: earned.leafHex, proofHex: earned.proofHex });
      }
      return { sourceHash: prepared.sourceHash, dbReplayStable: true, claims,
        evidence: { sourcePremise: 'Serialized upstream deed and zero-winner Seeker history; actual DB custody/allocation and actual A publication',
          prepared, settlement, projection, dispositions: rows } };
    },
  };
}
