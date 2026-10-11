/**
 * Shield rows and the public valley cache have different commit boundaries.
 * A cache miss while a shield transaction is open can only see the OLD row;
 * the operation must therefore evict once more after COMMIT, or that stale
 * snapshot survives for WORLD.mapCacheSec.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, plots } from '../src/db/schema';
import {
  breakBaseShieldOnAttack, invalidateShieldMapValley, shieldMapValleyId,
} from '../src/game/baseShields';
import { grantWarzoneShield } from '../src/game/warzoneShield';
import { getMapChunk } from '../src/game/world';
import { resetMapCache } from '../src/lib/mapCache';
import {
  connectTestDb, createTestPlayer, createTestValley, seedPlot,
} from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];

async function publicBase() {
  const owner = await createTestPlayer(db);
  const valley = await createTestValley(db, { name: `SHIELD CACHE ${Date.now()}` });
  const [base] = await db.insert(bases).values({
    ownerWallet: owner.wallet,
    status: 'active',
    landPaidAt: new Date('2026-01-01T00:00:00Z'),
  }).returning({ id: bases.id });
  await db.insert(baseSlots).values({
    wallet: owner.wallet, slot: 1, baseId: base!.id, active: true,
  });
  await seedPlot(db, {
    valleyId: valley.id, x: 11, y: 9, playerWallet: owner.wallet, baseId: base!.id,
  });
  const [plot] = await db.select({ earthCell: plots.earthCell }).from(plots)
    .where(eq(plots.baseId, base!.id));
  const read = (now: Date) => getMapChunk(db, owner.wallet, {
    baseId: base!.id,
    valleyId: valley.id,
    x0: 0,
    y0: 0,
    x1: 24,
    y1: 19,
  }, now);
  return { owner, valley, base: base!, plot: plot!, read };
}

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

beforeAll(() => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
});

afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  resetMapCache();
  await conn.sql.end();
});

describe('shield map cache commit ordering', () => {
  it('evicts a stale unshielded snapshot only after a shield grant commits', async () => {
    const fixture = await publicBase();
    const now = new Date();
    const changed = latch();
    const finish = latch();

    const mutation = db.transaction(async (tx) => {
      await grantWarzoneShield(
        tx, fixture.owner.wallet, now, fixture.base.id,
        { deferMapInvalidation: true },
      );
      const valleyId = await shieldMapValleyId(tx, fixture.owner.wallet, fixture.base.id);
      changed.release();
      await finish.wait;
      return valleyId;
    });
    await Promise.race([changed.wait, mutation]);

    // Reproduce an unrelated cold miss while PostgreSQL still exposes the old
    // committed row to other sessions: it repopulates `shielded: false`.
    resetMapCache();
    expect((await fixture.read(now)).markers[0]).toMatchObject({ shielded: false });

    finish.release();
    invalidateShieldMapValley(await mutation);
    expect((await fixture.read(now)).markers[0]).toMatchObject({ shielded: true });
  });

  it('evicts a stale shielded snapshot only after a shield break commits', async () => {
    const fixture = await publicBase();
    const now = new Date();
    await grantWarzoneShield(db, fixture.owner.wallet, now, fixture.base.id);
    const changed = latch();
    const finish = latch();

    const mutation = db.transaction(async (tx) => {
      await breakBaseShieldOnAttack(
        tx, fixture.owner.wallet, fixture.base.id,
        { deferMapInvalidation: true },
      );
      const valleyId = await shieldMapValleyId(tx, fixture.owner.wallet, fixture.base.id);
      changed.release();
      await finish.wait;
      return valleyId;
    });
    await Promise.race([changed.wait, mutation]);

    resetMapCache();
    expect((await fixture.read(now)).markers[0]).toMatchObject({ shielded: true });

    finish.release();
    invalidateShieldMapValley(await mutation);
    expect((await fixture.read(now)).markers[0]).toMatchObject({ shielded: false });
  });
});
