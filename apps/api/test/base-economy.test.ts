/**
 * Deed SHARDS must follow stable base identity, and the legacy cutover must be
 * append-only + idempotent. A raw balance rewrite here would let a deployment
 * mint, erase, or duplicate live player funds without an auditable ledger row.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  accounts, baseEconomyBackfills, baseQuestProgress, bases, ledgerEntries,
  ledgerTransactions, questProgress, quests,
} from '../src/db/schema';
import {
  BASE_ECONOMY_CUTOVER_KEY_PREFIX, BASE_FORGE_CUTOVER_KEY_PREFIX,
  completeBaseEconomyBackfill,
  getBaseShardBalance,
  rewardBaseShards,
  spendBaseShards,
} from '../src/game/baseEconomy';
import { rewardShards } from '../src/game/spend';
import { utcDay } from '../src/game/emission';
import { ensureQuests } from '../src/game/quests';
import {
  bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount, postTransaction,
} from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

afterAll(async () => { await conn.sql.end(); });

async function deedOwner() {
  const player = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({
    ownerWallet: player.wallet,
    status: 'active',
    keepLevel: 1,
  }).returning();
  return { ...player, baseId: base!.id };
}

describe.sequential('deed-owned SHARDS', () => {
  it('rewards and spends only the selected deed account', async () => {
    const owner = await deedOwner();
    const [other] = await db.insert(bases).values({
      ownerWallet: owner.wallet, status: 'active', keepLevel: 1,
    }).returning();
    await rewardBaseShards(db, owner.baseId, 500n, 'test.base_reward', randomUUID());
    await rewardBaseShards(db, other!.id, 90n, 'test.base_reward', randomUUID());
    await spendBaseShards(db, owner.baseId, 125n, 'test.base_spend', randomUUID());

    expect(await getBaseShardBalance(db, owner.baseId)).toBe(375n);
    expect(await getBaseShardBalance(db, other!.id)).toBe(90n);
    const wallet = await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards');
    expect(wallet.balance).toBe(0n);
  });

  it('attributes an idempotent SHARD spend quest only to the deed that paid', async () => {
    const owner = await deedOwner();
    const day = utcDay(new Date());
    await ensureQuests(db, day);
    let [spendQuest] = await db.select().from(quests).where(and(
      eq(quests.scope, 'daily'),
      eq(quests.activeOn, day),
      eq(quests.templateCode, 'spend_200'),
    ));
    if (!spendQuest) {
      [spendQuest] = await db.insert(quests).values({
        scope: 'daily', templateCode: 'spend_200', target: 200,
        rewardKeep: 15n, activeOn: day,
      }).returning();
    }

    await rewardBaseShards(db, owner.baseId, 500n, 'test.base_reward', randomUUID());
    const key = randomUUID();
    await spendBaseShards(db, owner.baseId, 125n, 'test.base_spend', key);
    await spendBaseShards(db, owner.baseId, 125n, 'test.base_spend', key);

    const [deedProgress] = await db.select().from(baseQuestProgress).where(and(
      eq(baseQuestProgress.questId, spendQuest!.id),
      eq(baseQuestProgress.baseId, owner.baseId),
    ));
    expect(deedProgress?.progress).toBe(125);
    expect(await db.select().from(questProgress).where(and(
      eq(questProgress.questId, spendQuest!.id),
      eq(questProgress.playerWallet, owner.wallet),
    ))).toHaveLength(0);
  });

  it('moves a positive legacy wallet balance exactly once under concurrent retries', async () => {
    const owner = await deedOwner();
    await rewardShards(db, owner.wallet, 2_500n, 'test.legacy_fund', randomUUID());
    const source = await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards');
    const destination = await getOrCreateBaseAccount(db, owner.baseId, 'base_shards');
    const forgeSource = (await bootstrapSystemAccounts(db)).forge_escrow;
    const forgeDestination = await getOrCreateBaseAccount(db, owner.baseId, 'base_forge_escrow');
    await db.insert(baseEconomyBackfills).values({
      legacyWallet: owner.wallet,
      primaryBaseId: owner.baseId,
      sourceShardAccountId: source.id,
      destinationShardAccountId: destination.id,
      legacyShardBalance: 2_500n,
      sourceForgeEscrowAccountId: forgeSource,
      destinationForgeEscrowAccountId: forgeDestination.id,
    });

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      completeBaseEconomyBackfill(db, owner.wallet)));
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(await getBaseShardBalance(db, owner.baseId)).toBe(2_500n);
    expect((await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards')).balance).toBe(0n);

    const key = `${BASE_ECONOMY_CUTOVER_KEY_PREFIX}${owner.wallet}`;
    const txns = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    expect(txns).toHaveLength(1);
    const entries = await db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, txns[0]!.id));
    expect(entries.map((entry) => [entry.accountId, entry.delta])).toEqual(expect.arrayContaining([
      [source.id, -2_500n], [destination.id, 2_500n],
    ]));
    const [row] = await db.select().from(baseEconomyBackfills)
      .where(eq(baseEconomyBackfills.legacyWallet, owner.wallet));
    expect(row).toMatchObject({ ledgerStatus: 'complete', ledgerTransferTxnId: txns[0]!.id });
  });

  it('completes an empty legacy balance without fabricating a zero-value transaction', async () => {
    const owner = await deedOwner();
    const destination = await getOrCreateBaseAccount(db, owner.baseId, 'base_shards');
    const forgeSource = (await bootstrapSystemAccounts(db)).forge_escrow;
    const forgeDestination = await getOrCreateBaseAccount(db, owner.baseId, 'base_forge_escrow');
    await db.insert(baseEconomyBackfills).values({
      legacyWallet: owner.wallet,
      primaryBaseId: owner.baseId,
      destinationShardAccountId: destination.id,
      legacyShardBalance: 0n,
      sourceForgeEscrowAccountId: forgeSource,
      destinationForgeEscrowAccountId: forgeDestination.id,
    });

    await expect(completeBaseEconomyBackfill(db, owner.wallet)).resolves.toEqual({
      baseId: owner.baseId, amount: 0n, transactionId: null,
    });
    const [row] = await db.select().from(baseEconomyBackfills)
      .where(eq(baseEconomyBackfills.legacyWallet, owner.wallet));
    expect(row!.ledgerStatus).toBe('complete');
    expect(row!.ledgerTransferTxnId).toBeNull();
    expect(await db.select().from(accounts).where(eq(accounts.id, destination.id)))
      .toMatchObject([{ balance: 0n }]);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey,
      `${BASE_ECONOMY_CUTOVER_KEY_PREFIX}${owner.wallet}`,
    ))).toHaveLength(0);
  });

  it('moves open legacy Forge backing into the deed escrow through the ledger', async () => {
    const owner = await deedOwner();
    const sys = await bootstrapSystemAccounts(db);
    await postTransaction(db, {
      idempotencyKey: `test.forge-cutover-fund:${owner.wallet}`,
      type: 'test.forge_cutover_fund',
      entries: [
        { account: sys.shard_genesis, delta: -300n },
        { account: sys.forge_escrow, delta: 300n },
      ],
    });
    const destination = await getOrCreateBaseAccount(db, owner.baseId, 'base_shards');
    const forgeDestination = await getOrCreateBaseAccount(db, owner.baseId, 'base_forge_escrow');
    await db.insert(baseEconomyBackfills).values({
      legacyWallet: owner.wallet,
      primaryBaseId: owner.baseId,
      destinationShardAccountId: destination.id,
      legacyShardBalance: 0n,
      sourceForgeEscrowAccountId: sys.forge_escrow,
      destinationForgeEscrowAccountId: forgeDestination.id,
      legacyForgeEscrowShards: 300n,
    });

    await completeBaseEconomyBackfill(db, owner.wallet);

    const [deedEscrow] = await db.select().from(accounts)
      .where(eq(accounts.id, forgeDestination.id));
    expect(deedEscrow!.balance).toBe(300n);
    const key = `${BASE_FORGE_CUTOVER_KEY_PREFIX}${owner.wallet}`;
    const [txn] = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    expect(txn).toBeDefined();
    const entries = await db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, txn!.id));
    expect(entries.map((entry) => [entry.accountId, entry.delta])).toEqual(expect.arrayContaining([
      [sys.forge_escrow, -300n], [forgeDestination.id, 300n],
    ]));
  });
});
