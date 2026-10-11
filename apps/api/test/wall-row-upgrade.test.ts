/** A whole-row confirmation buys exactly that contiguous row once, never a
 * cheaper subset or an extra level after a lost response. */
import { randomUUID } from 'node:crypto';
import { UPGRADE_COSTS } from '@shardkeep/shared';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, baseQuestProgress, quests, buildings, builderJobs, ledgerEntries, ledgerTransactions } from '../src/db/schema';
import { MAX_LEVEL, quoteWallRowUpgrade, upgradeWallRow } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';
const conn = connectTestDb();
const db = conn.db;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
async function fixture(levels = [1, 1, 1], keepLevel = 5, balance = 100_000n) {
  const player = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: player.wallet, status: 'active', keepLevel }).returning();
  await db.insert(baseSlots).values({ wallet: player.wallet, slot: 1, baseId: base!.id });
  const walls = await db.insert(buildings).values(levels.map((level, i) => ({
    playerWallet: player.wallet, baseId: base!.id, type: 'wall' as const, level, tx: 10 + i, ty: 10,
  }))).returning();
  if (balance > 0n) await rewardBaseShards(db, base!.id, balance, 'test.wall.fund', randomUUID());
  const quote = () => quoteWallRowUpgrade(db, player.wallet, walls[0]!.id, base!.id);
  const buy = (quoteId: string, key = randomUUID()) => upgradeWallRow(db, player.wallet, walls[0]!.id, quoteId, key, base!.id);
  const read = () => db.select().from(buildings).where(eq(buildings.baseId, base!.id)).orderBy(buildings.tx);
  return { player, base: base!, walls, quote, buy, read, balance };
}
describe.sequential('quoted whole-row wall upgrades', () => {
  it('upgrades mixed tiers one level, excludes capped/Keep-gated walls, and balances one exact purchase', async () => {
    const f = await fixture([1, 3, 5, MAX_LEVEL.wall!]);
    const quote = await f.quote();
    expect(quote.walls.map((w) => [w.level, w.targetLevel, w.excluded]).sort((a, b) => Number(a[0]) - Number(b[0])))
      .toEqual([[1, 2, null], [3, 4, null], [5, null, 'keep_level'], [MAX_LEVEL.wall!, null, 'max_level']]);
    const expected = UPGRADE_COSTS.wall[0]! + UPGRADE_COSTS.wall[2]!;
    expect(quote.totalCostShards).toBe(expected);
    await f.buy(quote.quoteId);
    expect((await f.read()).map((w) => w.level)).toEqual([2, 4, 5, MAX_LEVEL.wall!]);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance - BigInt(expected));
    const receipts = await db.select().from(ledgerTransactions).where(like(ledgerTransactions.idempotencyKey, `wall-row:${f.player.wallet}:%`));
    expect(receipts).toHaveLength(1);
    const [sum] = await db.select({ amount: sql<string>`sum(${ledgerEntries.delta})` }).from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, receipts[0]!.id));
    expect(BigInt(sum!.amount)).toBe(0n);
  });
  it('duplicate concurrent requests and a lost-response replay return one receipt without buying another tier', async () => {
    const f = await fixture(); const quote = await f.quote(); const key = randomUUID();
    const results = await Promise.all([f.buy(quote.quoteId, key), f.buy(quote.quoteId, key)]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await f.buy(quote.quoteId, key)).toMatchObject({ duplicate: true, costShards: quote.totalCostShards });
    expect((await f.read()).map((w) => w.level)).toEqual([2, 2, 2]);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance - BigInt(quote.totalCostShards));
    await expect(f.buy((await f.quote()).quoteId, key)).rejects.toMatchObject({ code: 'WALL_ROW_KEY_REUSED' });
  });
  it('credits normal per-wall upgrade progress once and never auto-claims rewards', async () => {
    const f = await fixture([2, 2, 2]); const quote = await f.quote(); const key = randomUUID();
    await f.buy(quote.quoteId, key); await f.buy(quote.quoteId, key);
    const progress = await db.select({ code: quests.templateCode, progress: baseQuestProgress.progress, claimed: baseQuestProgress.claimedAt })
      .from(baseQuestProgress).innerJoin(quests, eq(quests.id, baseQuestProgress.questId))
      .where(eq(baseQuestProgress.baseId, f.base.id));
    for (const code of ['upgrade_any', 'upgrade_2_buildings', 'upgrade_to_level_3']) {
      const row = progress.find((p) => p.code === code);
      // Existing quest targets cap counters; a batch must satisfy them without paying a claim.
      expect(row?.progress).toBeGreaterThan(0); expect(row?.progress).toBeLessThanOrEqual(3);
      expect(row?.claimed).toBeNull();
    }
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance - BigInt(quote.totalCostShards));
  });
  it('rolls back the debit and every updated wall when a later database write fails', async () => {
    const f = await fixture(); const quote = await f.quote(); const key = randomUUID();
    const last = quote.walls.at(-1)!.id;
    // A scoped real database failure occurs after the first wall update and ledger posting.
    await db.execute(sql.raw(`CREATE FUNCTION test_wall_row_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${last}'::uuid AND NEW.level <> OLD.level THEN RAISE EXCEPTION 'test wall persistence failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw('CREATE TRIGGER test_wall_row_fail BEFORE UPDATE ON buildings FOR EACH ROW EXECUTE FUNCTION test_wall_row_fail()'));
    try { await expect(f.buy(quote.quoteId, key)).rejects.toThrow(); }
    finally {
      await db.execute(sql.raw('DROP TRIGGER test_wall_row_fail ON buildings'));
      await db.execute(sql.raw('DROP FUNCTION test_wall_row_fail()'));
    }
    expect((await f.read()).map((w) => w.level)).toEqual([1, 1, 1]);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `wall-row:${f.player.wallet}:${key}`))).toHaveLength(0);
    // The failed transaction did not poison its durable idempotency key.
    expect(await f.buy(quote.quoteId, key)).toMatchObject({ duplicate: false });
  });
  it('different concurrent keys cannot buy a second unconfirmed level', async () => {
    const f = await fixture(); const quote = await f.quote();
    const results = await Promise.allSettled([f.buy(quote.quoteId), f.buy(quote.quoteId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'WALL_ROW_QUOTE_CHANGED' } });
    expect((await f.read()).map((w) => w.level)).toEqual([2, 2, 2]);
  });
  it('insufficient funds never buys the affordable prefix and leaves all levels unchanged', async () => {
    const f = await fixture([1, 1, 1], 5, BigInt(UPGRADE_COSTS.wall[0]!)); const quote = await f.quote();
    expect(quote.canAfford).toBe(false);
    await expect(f.buy(quote.quoteId)).rejects.toMatchObject({ code: 'WALL_ROW_FUNDS_CHANGED' });
    expect((await f.read()).map((w) => w.level)).toEqual([1, 1, 1]);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance);
  });
  it('a moved neighbour changes the quoted row and cannot silently shrink the purchase', async () => {
    const f = await fixture(); const quote = await f.quote();
    await db.update(buildings).set({ ty: 11 }).where(eq(buildings.id, f.walls[1]!.id));
    await expect(f.buy(quote.quoteId)).rejects.toMatchObject({ code: 'WALL_ROW_QUOTE_CHANGED', details: { quote: { totalCostShards: UPGRADE_COSTS.wall[0] } } });
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance);
    expect((await f.read()).map((w) => w.level)).toEqual([1, 1, 1]);
  });
  it('excludes busy walls explicitly and rejects an all-unavailable row without a debit', async () => {
    const f = await fixture([1]);
    await db.insert(builderJobs).values({ playerWallet: f.player.wallet, baseId: f.base.id,
      buildingId: f.walls[0]!.id, kind: 'upgrade', startedAt: new Date(), finishesAt: new Date(Date.now() + 60_000) });
    const quote = await f.quote(); expect(quote.walls[0]).toMatchObject({ excluded: 'busy', targetLevel: null });
    await expect(f.buy(quote.quoteId)).rejects.toMatchObject({ code: 'WALL_ROW_UNAVAILABLE' });
    expect(await getBaseShardBalance(db, f.base.id)).toBe(f.balance);
  });
  it('ownership transfer invalidates an unspent quote and even a copied prior receipt', async () => {
    const f = await fixture(); const quote = await f.quote(); const key = randomUUID();
    await f.buy(quote.quoteId, key);
    const buyer = await createTestPlayer(db);
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.base.id));
    await expect(f.buy(quote.quoteId, key)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(f.quote()).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect((await f.read()).map((w) => w.level)).toEqual([2, 2, 2]);
  });
  it('a selected wall on another owned base cannot be quoted through this base scope', async () => {
    const f = await fixture(); const other = await fixture();
    await expect(quoteWallRowUpgrade(db, f.player.wallet, other.walls[0]!.id, f.base.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await db.select().from(ledgerTransactions).where(and(like(ledgerTransactions.idempotencyKey, `wall-row:${f.player.wallet}:%`)))).toHaveLength(0);
  });
});
