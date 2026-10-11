import { RAID_RULES } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/game/army', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game/army')>();
  return {
    ...actual,
    consumeArmy: async () => { throw new Error('injected post-sim transaction failure'); },
  };
});

import { army, ledgerTransactions, players, raids } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { createRaid, getRaidEnergy, submitOrders } from '../src/game/raids';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { rewardShards } from '../src/game/spend';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let sequence = 0;
const key = () => `resolution-fail-${++sequence}`;
const shardBalance = async (wallet: string) =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;

async function player(withArmy: boolean) {
  const row = await createTestPlayer(db);
  await ensureStartingBase(db, row.wallet);
  await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, row.wallet));
  if (withArmy) {
    await rewardShards(db, row.wallet, 100_000n, 'test.resolution-failure', key());
    await db.insert(army).values({ playerWallet: row.wallet, troop: 'highlander', count: 1 });
  }
  return row;
}

beforeAll(async () => bootstrapSystemAccounts(db));
afterAll(async () => conn.sql.end());

describe('post-simulation infrastructure failure', () => {
  it('marks accepted work durably, then stale expiry refunds energy and ante exactly once', async () => {
    const attacker = await player(true);
    const defender = await player(false);
    const before = await shardBalance(attacker.wallet);
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
    });

    await expect(submitOrders(db, attacker.wallet, raid.id, {
      deploys: [{ troop: 'highlander', tx: 6, ty: 14, tMs: 0 }],
      idempotencyKey: key(),
    })).rejects.toThrow(/injected post-sim transaction failure/);
    const [pending] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(pending).toMatchObject({
      status: 'pending_orders',
      simulationLeaseToken: null,
    });
    expect(pending!.simulationSystemAttemptedAt).not.toBeNull();
    expect(await shardBalance(attacker.wallet)).toBeLessThan(before);

    const sweepAt = new Date();
    await db.update(raids).set({
      ordersDeadlineAt: new Date(
        sweepAt.getTime() - RAID_RULES.batchOrdersGraceSec * 1_000 - 1_000,
      ),
    })
      .where(eq(raids.id, raid.id));
    await getRaidEnergy(db, attacker.wallet, sweepAt);
    const [expired] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(expired).toMatchObject({ status: 'expired', simulationSystemAttemptedAt: null });
    expect(await shardBalance(attacker.wallet)).toBe(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(1);
    await getRaidEnergy(db, attacker.wallet, new Date(sweepAt.getTime() + 1_000));
    expect(await shardBalance(attacker.wallet)).toBe(before);
  });
});
