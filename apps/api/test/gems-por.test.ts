/**
 * Proof-of-reserves and the weekly Merkle snapshot ignore Gems (D-152 G-2).
 *
 * WHY: /api/por publishes what custodial KEEP we OWE players. Gems are a
 * closed, non-withdrawable in-game currency — nobody can ever redeem them for
 * KEEP — so counting them would overstate the liability, while a Gems-aware
 * change that accidentally counted `player_gems` as a KEEP leaf would publish
 * a false custody claim. Converting KEEP into Gems must therefore LOWER the
 * KEEP liability by exactly the KEEP recycled, and Gems activity afterwards
 * must not move it at all.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { merkleLeaves } from '../src/db/schema';
import { convertGemsToShards, convertKeepToGems } from '../src/game/gems';
import { spendGems } from '../src/game/spend';
import { buildWeeklySnapshot, checkReserves } from '../src/money/snapshot';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const k = () => randomUUID();
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
const liability = async () => (await checkReserves(db, async () => 10n ** 12n)).liabilityKeep;

describe('Gems are not a KEEP liability', () => {
  it('KEEP → Gems lowers the liability by the recycled KEEP; Gems activity never moves it', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 1_000n, 'test.fund', k());
    const before = await liability();
    await convertKeepToGems(db, wallet, 400n, k());
    const afterConvert = await liability();
    expect(before - afterConvert).toBe(400n);
    await spendGems(db, wallet, 50n, 'test.sink', `por:${wallet}:spend`);
    await convertGemsToShards(db, wallet, 100n, k());
    expect(await liability()).toBe(afterConvert);
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_gems')).balance).toBe(250n);
  });

  it('the weekly snapshot leaf is the custodial KEEP balance only, never Gems', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 900n, 'test.fund', k());
    await convertKeepToGems(db, wallet, 300n, k());
    // A far-future epoch so an earlier suite's snapshot of the current epoch
    // cannot answer `alreadyExisted` with stale leaves.
    const snap = await buildWeeklySnapshot(db, new Date('2041-01-07T00:00:00Z'));
    const leaves = await db.select().from(merkleLeaves)
      .where(eq(merkleLeaves.epoch, snap.epoch)).orderBy(asc(merkleLeaves.leafIndex));
    const mine = leaves.filter((l) => l.wallet === wallet);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.amount).toBe(600n);
  });
});
