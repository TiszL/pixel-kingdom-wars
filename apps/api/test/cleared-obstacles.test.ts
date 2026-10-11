/** `GET /base` `clearedObstacles[]` (docs/REALM-KIT-PLAN.md E-11, D-173). WHY: the
 * realm kit draws a felled tree as a stump for OBSTACLE_REMNANT_DAYS, so the client
 * needs the rows the player actually cleared — and only those: a base emptied
 * wholesale (abandon, transfer, ops retirement) never grew stumps, the tombstone
 * is shared, and a remnant list that repeated it would litter a fresh plot. */
import { OBSTACLES, OBSTACLE_REMNANT_DAYS } from '@shardkeep/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bases, builderJobs, obstacles } from '../src/db/schema';
import { clearObstacle, completeDueJobs, ensureStartingBase, getBaseState } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `cleared-${++key}-${Math.random().toString(36).slice(2)}`;
const DAY = 86_400_000;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
afterEach(()=>vi.unstubAllEnvs());

async function readyBase() {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await ensureWalletBaseIdentity(db, p.wallet);
  const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, p.wallet));
  await rewardBaseShards(db, base!.id, 100_000n, 'test.fund.base-shards', k());
  return { wallet: p.wallet, baseId: base!.id };
}
const inClaim = (o: { tx: number; ty: number }) => o.tx >= 8 && o.tx < 22 && o.ty >= 8 && o.ty < 22;

describe('GET /base clearedObstacles', () => {
  it('lists a player-cleared obstacle as a remnant with its sprite, tile and clear time, then forgets it after OBSTACLE_REMNANT_DAYS', async () => {
    const { wallet, baseId } = await readyBase();
    const t0 = new Date();
    const before = await getBaseState(db, wallet, t0, baseId);
    expect(before.clearedObstacles).toEqual([]);
    const target = before.obstacles.find(inClaim)!;
    expect(target).toBeDefined();
    const tier = Object.values(OBSTACLES.tiers).find((t) => (t.kinds as readonly string[]).includes(target.spriteKey))!;
    await clearObstacle(db, wallet, target.id, k(), t0, baseId);
    // Still standing while the builder works: no remnant yet, no double listing.
    const working = await getBaseState(db, wallet, new Date(t0.getTime() + 1000), baseId);
    expect(working.obstacles.some((o) => o.id === target.id)).toBe(true);
    expect(working.clearedObstacles).toEqual([]);
    const rewardBefore = await getBaseShardBalance(db, baseId);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const done = new Date(t0.getTime() + tier.clearSec * 1000 + 1000);
    const cleared = await getBaseState(db, wallet, done, baseId);
    expect(cleared.obstacles.some((o) => o.id === target.id)).toBe(false);
    expect(cleared.clearedObstacles).toEqual([{ spriteKey: target.spriteKey, tx: target.tx, ty: target.ty, clearedAt: done }]);
    // The remnant carries no economy: the reward was paid once by the job, and the DTO exposes no id to act on.
    expect(Object.keys(cleared.clearedObstacles[0]!).sort()).toEqual(['clearedAt', 'spriteKey', 'tx', 'ty']);
    const paid = await getBaseShardBalance(db, baseId);
    expect(paid-rewardBefore).toBe(BigInt(OBSTACLES.clearRewardShards));
    const lastDay = await getBaseState(db, wallet, new Date(done.getTime() + OBSTACLE_REMNANT_DAYS * DAY - 1000), baseId);
    expect(lastDay.clearedObstacles).toHaveLength(1);
    const gone = await getBaseState(db, wallet, new Date(done.getTime() + OBSTACLE_REMNANT_DAYS * DAY + 1000), baseId);
    expect(gone.clearedObstacles).toEqual([]);
    expect(await getBaseShardBalance(db, baseId)).toBe(paid);
  });

  it('lists nothing for rows tombstoned without a completed clear job (abandon/transfer/retirement semantics)', async () => {
    const { wallet, baseId } = await readyBase();
    const now = new Date();
    const state = await getBaseState(db, wallet, now, baseId);
    const [a, b] = state.obstacles.filter(inClaim);
    expect(a && b).toBeTruthy();
    // Wholesale tombstone, exactly what abandonFreeBase / transferBase / retireScriptedDeedBases write.
    await db.update(obstacles).set({ clearedAt: now }).where(and(eq(obstacles.id, a!.id), isNull(obstacles.clearedAt)));
    // A clear job that never completed (a builder still on it) is not a remnant either.
    await clearObstacle(db, wallet, b!.id, k(), now, baseId);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.obstacleId, b!.id)))[0]?.completedAt).toBeNull();
    const after = await getBaseState(db, wallet, new Date(now.getTime() + 1000), baseId);
    expect(after.obstacles.some((o) => o.id === a!.id)).toBe(false);
    expect(after.clearedObstacles).toEqual([]);
    // Once the builder finishes, only that one row becomes a remnant.
    await completeDueJobs(db, wallet, new Date(now.getTime() + 11 * 60_000), baseId);
    const finished = await getBaseState(db, wallet, new Date(now.getTime() + 11 * 60_000), baseId);
    expect(finished.clearedObstacles.map((o) => [o.tx, o.ty])).toEqual([[b!.tx, b!.ty]]);
  });
});
