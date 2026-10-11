/**
 * Stable deed-economy pins for wallet-wide clans.
 *
 * Membership remains one row per wallet. Every SHARDS movement and every
 * competitive number must nevertheless resolve through a concrete paid deed,
 * so owning a second deed can never merge balances or double-count strength.
 */
import { CLANS } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  baseProfiles, baseRaidLocks, bases, baseSlots, clans, players, raids,
} from '../src/db/schema';
import {
  clanChestInvariantHolds, createClan, getMyClan, joinClan, leaveClan, listClans,
  settleClanChests,
} from '../src/game/clans';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import {
  bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction,
} from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const previousMultiBase = process.env['MULTI_BASE_ENABLED'];
let serial = 0;
const key = (label: string): string => `clan-base:${label}:${++serial}`;
const name = (): string => `Deed Clan ${++serial}`;
const tag = (): string => `D${(++serial).toString(36).toUpperCase()}`;

function context(baseId: string): StableBaseMutationContext {
  return { baseId, assertAuthority: async () => undefined };
}

async function deedWallet(
  specs: Array<{ slot: number; keepLevel: number; trophies: number }>,
) {
  const player = await createTestPlayer(db);
  const result = [];
  for (const spec of specs) {
    const [base] = await db.insert(bases).values({
      ownerWallet: player.wallet,
      status: 'active',
      keepLevel: spec.keepLevel,
      landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
    }).returning();
    await db.insert(baseSlots).values({
      wallet: player.wallet, slot: spec.slot, baseId: base!.id, active: true,
    });
    await db.insert(baseProfiles).values({ baseId: base!.id, trophies: spec.trophies });
    await rewardBaseShards(db, base!.id, 50_000n, 'test.clan-base.fund', key('fund'));
    result.push(base!);
  }
  return { ...player, bases: result };
}

async function seedChest(clanId: string, amount: bigint): Promise<void> {
  const sys = await bootstrapSystemAccounts(db);
  await postTransaction(db, {
    idempotencyKey: key('seed-chest'),
    type: 'test.clan-base.seed',
    entries: [
      { account: sys.shard_genesis, delta: -amount },
      { account: sys.clan_chest, delta: amount },
    ],
  });
  await db.update(clans).set({ chestShards: amount }).where(eq(clans.id, clanId));
}

beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
});
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (previousMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = previousMultiBase;
  await conn.sql.end();
});

describe.sequential('stable clan deed economy', () => {
  it('founds from only the explicitly selected deed and refuses a raided deed before debit', async () => {
    const owner = await deedWallet([
      { slot: 1, keepLevel: 3, trophies: 100 },
      { slot: 2, keepLevel: 7, trophies: 800 },
    ]);
    const [first, second] = owner.bases;
    const walletBefore = (await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance;
    const firstBefore = await getBaseShardBalance(db, first!.id);
    const secondBefore = await getBaseShardBalance(db, second!.id);

    await createClan(
      db, owner.wallet, { name: name(), tag: tag() }, key('create'), context(second!.id),
    );
    expect(await getBaseShardBalance(db, first!.id)).toBe(firstBefore);
    expect(await getBaseShardBalance(db, second!.id))
      .toBe(secondBefore - BigInt(CLANS.createCostShards));
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance)
      .toBe(walletBefore);

    const locked = await deedWallet([{ slot: 1, keepLevel: 3, trophies: 0 }]);
    const attacker = await deedWallet([{ slot: 1, keepLevel: 3, trophies: 0 }]);
    const [raid] = await db.insert(raids).values({
      attackerWallet: attacker.wallet,
      attackerBaseId: attacker.bases[0]!.id,
      defenderWallet: locked.wallet,
      defenderBaseId: locked.bases[0]!.id,
      seed: 11n,
      snapshot: {},
      armySnapshot: {},
      simVersion: 9,
      ordersDeadlineAt: new Date(Date.now() + 60_000),
    }).returning();
    await db.insert(baseRaidLocks).values({
      baseId: locked.bases[0]!.id,
      raidId: raid!.id,
      expiresAt: new Date(Date.now() + 120_000),
    });
    const lockedBefore = await getBaseShardBalance(db, locked.bases[0]!.id);
    await expect(createClan(
      db, locked.wallet, { name: name(), tag: tag() }, key('locked-create'),
      context(locked.bases[0]!.id),
    )).rejects.toMatchObject({ statusCode: 423, code: 'BASE_BEING_RAIDED' });
    expect(await getBaseShardBalance(db, locked.bases[0]!.id)).toBe(lockedBefore);
  });

  it('credits a dissolved chest only to the leader deed selected for that mutation', async () => {
    const leader = await deedWallet([
      { slot: 1, keepLevel: 2, trophies: 10 },
      { slot: 2, keepLevel: 6, trophies: 20 },
    ]);
    const [first, second] = leader.bases;
    const clan = await createClan(
      db, leader.wallet, { name: name(), tag: tag() }, key('create'), context(first!.id),
    );
    await seedChest(clan.id, 777n);
    const firstBefore = await getBaseShardBalance(db, first!.id);
    const secondBefore = await getBaseShardBalance(db, second!.id);
    const walletBefore = (await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards')).balance;

    await leaveClan(db, leader.wallet, context(second!.id));
    expect(await getBaseShardBalance(db, first!.id)).toBe(firstBefore);
    expect(await getBaseShardBalance(db, second!.id)).toBe(secondBefore + 777n);
    expect((await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards')).balance)
      .toBe(walletBefore);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });

  it('settles one share per wallet into its deterministic lowest active paid slot', async () => {
    const leader = await deedWallet([
      { slot: 2, keepLevel: 8, trophies: 800 },
      { slot: 1, keepLevel: 4, trophies: 400 },
    ]);
    const member = await deedWallet([
      { slot: 2, keepLevel: 7, trophies: 700 },
      { slot: 1, keepLevel: 3, trophies: 300 },
    ]);
    const clan = await createClan(
      db, leader.wallet, { name: name(), tag: tag() }, key('create'), context(leader.bases[0]!.id),
    );
    await joinClan(db, member.wallet, clan.id);
    await seedChest(clan.id, 1001n);
    const before = await Promise.all([
      ...leader.bases.map((base) => getBaseShardBalance(db, base.id)),
      ...member.bases.map((base) => getBaseShardBalance(db, base.id)),
    ]);
    const leaderWalletBefore = (await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards')).balance;
    const memberWalletBefore = (await getOrCreatePlayerAccount(db, member.wallet, 'player_shards')).balance;

    await settleClanChests(db, key('week'));
    // Fixtures are inserted slot 2 then slot 1: index 1/3 are the recipients.
    expect(await getBaseShardBalance(db, leader.bases[0]!.id)).toBe(before[0]);
    expect(await getBaseShardBalance(db, leader.bases[1]!.id)).toBe(before[1]! + 500n);
    expect(await getBaseShardBalance(db, member.bases[0]!.id)).toBe(before[2]);
    expect(await getBaseShardBalance(db, member.bases[1]!.id)).toBe(before[3]! + 500n);
    expect((await getOrCreatePlayerAccount(db, leader.wallet, 'player_shards')).balance)
      .toBe(leaderWalletBefore);
    expect((await getOrCreatePlayerAccount(db, member.wallet, 'player_shards')).balance)
      .toBe(memberWalletBefore);
    const [after] = await db.select().from(clans).where(eq(clans.id, clan.id));
    expect(after!.chestShards).toBe(1n);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });

  it('uses each wallet strongest paid deed once for roster and leaderboard strength', async () => {
    const leader = await deedWallet([
      { slot: 1, keepLevel: 4, trophies: 100 },
      { slot: 2, keepLevel: 8, trophies: 900 },
    ]);
    const member = await deedWallet([{ slot: 1, keepLevel: 6, trophies: 300 }]);
    await db.update(players).set({ keepLevel: 20, trophies: 999_999 })
      .where(eq(players.wallet, leader.wallet));
    const clan = await createClan(
      db, leader.wallet, { name: name(), tag: tag() }, key('create'), context(leader.bases[0]!.id),
    );
    await joinClan(db, member.wallet, clan.id);

    const mine = await getMyClan(db, leader.wallet);
    const leaderRow = mine.clan!.roster.find((row) => row.wallet === leader.wallet);
    expect(leaderRow).toMatchObject({ keepLevel: 8, trophies: 900 });
    const listed = (await listClans(db)).clans.find((row) => row.id === clan.id);
    expect(listed).toMatchObject({ members: 2, trophies: 1200 });
  });
});
