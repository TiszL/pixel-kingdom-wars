/**
 * Economy dashboard classification proof. An owned migrated database isolates
 * pooled before/after values from other suites while writes use READ COMMITTED,
 * as required by the source guards. Every fixture posting is also rolled back.
 */
import { randomUUID } from 'node:crypto';
import { ECONOMY } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, players } from '../src/db/schema';
import { getEconomyStats } from '../src/game/economy';
import {
  bootstrapEconomyAllocations, bootstrapSystemAccounts,
  getOrCreateBaseAccount, getOrCreatePlayerAccount, postTransaction,
} from '../src/ledger';
import { randomWallet } from './helpers';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

const conn = resourceClaimsDatabase();
const db = conn.db;

beforeAll(async () => {
  await conn.setup();
  await bootstrapEconomyAllocations(db);
}, 120_000);
afterAll(async () => { await conn.close(); });

class RollbackFixture extends Error {}

describe('economy stats currency accounting', () => {
  it('separates KEEP pool flows from mine/cache/starter/top-up/conversion SHARDS', async () => {
    await expect(db.transaction(async (tx) => {
      const wallet = randomWallet();
      await tx.insert(players).values({ wallet });
      const sys = await bootstrapSystemAccounts(tx);
      const keep = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
      const shards = await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
      const [base] = await tx.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
      const baseShards = await getOrCreateBaseAccount(tx, base!.id, 'base_shards');
      const baseForge = await getOrCreateBaseAccount(tx, base!.id, 'base_forge_escrow');
      const key = (suffix: string): string => `test:economy:${randomUUID()}:${suffix}`;
      const postShards = (type: string, amount: bigint) => postTransaction(tx, {
        idempotencyKey: key(type), type,
        entries: [
          { account: sys.shard_genesis, delta: -amount },
          { account: shards.id, delta: amount },
        ],
      });

      // Seed only the fixture player's KEEP before the baseline. It is not an
      // emission_pool flow and therefore cannot contaminate the classification.
      await postTransaction(tx, {
        idempotencyKey: key('keep-seed'), type: 'test.economy.keep_seed',
        entries: [
          { account: sys.keep_genesis, delta: -7n },
          { account: keep.id, delta: 7n },
        ],
      });
      const before = await getEconomyStats(tx);
      // Quests pay SHARDS, so the public/current economy surface must not revive
      // the retired quest KEEP allocation even while its ledger history remains.
      expect(before.pool).not.toHaveProperty('questBucket');
      expect(before.pool).not.toHaveProperty('questBucketInitial');

      await postShards('mine.collect', 10n);
      await postShards('cache.claim', 20n);
      await postShards('base.starter_grant', 2_000n);
      await postShards('base.starter_topup', 1_500n);
      const convertedShards = 7n * BigInt(ECONOMY.shardsPerKeep);
      await postTransaction(tx, {
        idempotencyKey: key('forge-keep'), type: 'forge.convert',
        entries: [
          { account: keep.id, delta: -7n },
          { account: sys.emission_pool, delta: 7n },
        ],
      });
      await postShards('forge.convert', convertedShards);
      await postTransaction(tx, {
        idempotencyKey: key('deed-shards'), type: 'test.economy.deed_shards',
        entries: [
          { account: sys.shard_genesis, delta: -13n },
          { account: baseShards.id, delta: 13n },
        ],
      });
      await postTransaction(tx, {
        idempotencyKey: key('deed-forge'), type: 'test.economy.deed_forge',
        entries: [
          { account: baseShards.id, delta: -5n },
          { account: baseForge.id, delta: 5n },
        ],
      });
      await postTransaction(tx, {
        idempotencyKey: key('forge-allocate'), type: 'forge.allocate',
        entries: [
          { account: sys.emission_pool, delta: -11n },
          { account: sys.forge_payout_escrow, delta: 11n },
        ],
      });
      await postTransaction(tx, {
        idempotencyKey: key('forge-expire'), type: 'forge.expire',
        entries: [
          { account: sys.forge_payout_escrow, delta: -3n },
          { account: sys.emission_pool, delta: 3n },
        ],
      });

      const after = await getEconomyStats(tx);
      const diff = (a: string, b: string): bigint => BigInt(a) - BigInt(b);
      expect(diff(after.keepFlows.recycledTotal, before.keepFlows.recycledTotal)).toBe(7n);
      expect(diff(after.keepFlows.emittedTotal, before.keepFlows.emittedTotal)).toBe(11n);
      expect(diff(after.keepFlows.emittedToday, before.keepFlows.emittedToday)).toBe(11n);
      expect(diff(after.keepFlows.expiredReturnedTotal, before.keepFlows.expiredReturnedTotal)).toBe(3n);
      expect(diff(after.health.netEmissionDrain, before.health.netEmissionDrain)).toBe(1n);

      expect(diff(after.shards.flows.minedTotal, before.shards.flows.minedTotal)).toBe(10n);
      expect(diff(after.shards.flows.minedToday, before.shards.flows.minedToday)).toBe(10n);
      expect(diff(after.shards.flows.cacheClaimedTotal, before.shards.flows.cacheClaimedTotal)).toBe(20n);
      expect(diff(after.shards.flows.starterGrantedTotal, before.shards.flows.starterGrantedTotal)).toBe(3_500n);
      expect(diff(after.shards.flows.convertedTotal, before.shards.flows.convertedTotal)).toBe(convertedShards);
      expect(diff(after.shards.flows.issuedTotal, before.shards.flows.issuedTotal))
        .toBe(3_543n + convertedShards);
      expect(diff(after.shards.flows.otherIssuedTotal, before.shards.flows.otherIssuedTotal)).toBe(13n);
      expect(diff(after.shards.deedBalances, before.shards.deedBalances)).toBe(8n);
      expect(diff(after.shards.deedForgeEscrow, before.shards.deedForgeEscrow)).toBe(5n);
      expect(diff(after.shards.circulating, before.shards.circulating))
        .toBe(3_543n + convertedShards - 5n);

      throw new RollbackFixture();
    }, { isolationLevel: 'read committed' })).rejects.toBeInstanceOf(RollbackFixture);
  });
});
