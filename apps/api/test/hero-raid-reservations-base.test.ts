/**
 * D-035 hero commitments belong to the stable deed. These tests pin the two
 * economic identities independently: same wallet/different bases is legal;
 * same base (or one legacy wallet) remains a hard concurrency conflict.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bases, heroRaidReservations, raids } from '../src/db/schema';
import {
  pendingHeroReservationRaidIds,
  releaseRaidHeroes,
  reservedRaidHeroes,
  reserveRaidHeroes,
} from '../src/game/heroRaidReservations';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

async function baseOf(wallet: string) {
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  return base!;
}

async function raidOf(wallet: string, baseId?: string) {
  const [raid] = await db.insert(raids).values({
    attackerWallet: wallet,
    ...(baseId ? { attackerBaseId: baseId } : {}),
    seed: 1n,
    snapshot: {},
    armySnapshot: {},
    ordersDeadlineAt: new Date('2099-01-01T00:00:00.000Z'),
  }).returning();
  return raid!;
}

async function rejectedPgCode(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

afterAll(async () => { await conn.sql.end(); });

describe.sequential('stable hero raid reservations', () => {
  it('allows the same wallet hero on two deeds but rejects a second raid from one deed', async () => {
    const owner = await createTestPlayer(db);
    const [a, b] = await Promise.all([baseOf(owner.wallet), baseOf(owner.wallet)]);
    const [raidA, raidB, duplicateA] = await Promise.all([
      raidOf(owner.wallet, a.id), raidOf(owner.wallet, b.id), raidOf(owner.wallet, a.id),
    ]);

    await reserveRaidHeroes(db, raidA, ['vex']);
    await reserveRaidHeroes(db, raidB, ['vex']);
    await expect(reserveRaidHeroes(db, duplicateA, ['vex']))
      .rejects.toMatchObject({ statusCode: 409, code: 'HERO_ALREADY_COMMITTED' });

    expect(await reservedRaidHeroes(db, raidA)).toEqual(['vex']);
    expect(await reservedRaidHeroes(db, raidB)).toEqual(['vex']);
    const pending = await pendingHeroReservationRaidIds(db, owner.wallet);
    expect(pending).toEqual(expect.arrayContaining([raidA.id, raidB.id]));
  });

  it('keeps a base reservation attached through transfer and ignores a mismatched identity', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const [a, b] = await Promise.all([baseOf(seller.wallet), baseOf(seller.wallet)]);
    const raid = await raidOf(seller.wallet, a.id);
    await reserveRaidHeroes(db, raid, ['vex']);

    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, a.id));
    expect(await reservedRaidHeroes(db, raid)).toEqual(['vex']);

    // The XOR shape alone is insufficient authority: a reservation naming the
    // wrong deed for this immutable raid must not enter resume/submit results.
    await db.update(heroRaidReservations).set({ baseId: b.id }).where(and(
      eq(heroRaidReservations.raidId, raid.id), eq(heroRaidReservations.hero, 'vex'),
    ));
    expect(await reservedRaidHeroes(db, raid)).toEqual([]);
    expect(await pendingHeroReservationRaidIds(db, seller.wallet)).not.toContain(raid.id);
  });

  it('retains the fenced flag-off wallet identity and releases either arm by raid id', async () => {
    const owner = await createTestPlayer(db);
    const [first, second] = await Promise.all([raidOf(owner.wallet), raidOf(owner.wallet)]);
    await reserveRaidHeroes(db, first, ['theodor']);
    await expect(reserveRaidHeroes(db, second, ['theodor']))
      .rejects.toMatchObject({ statusCode: 409, code: 'HERO_ALREADY_COMMITTED' });
    await releaseRaidHeroes(db, [first.id]);
    await reserveRaidHeroes(db, second, ['theodor']);
    expect(await reservedRaidHeroes(db, second)).toEqual(['theodor']);
  });

  it('enforces exactly one owner arm at the database boundary', async () => {
    const owner = await createTestPlayer(db);
    const [base, otherBase] = await Promise.all([baseOf(owner.wallet), baseOf(owner.wallet)]);
    const raid = await raidOf(owner.wallet, base.id);

    expect(await rejectedPgCode(db.insert(heroRaidReservations).values({
      playerWallet: owner.wallet, baseId: base.id, hero: 'vex', raidId: raid.id,
    }))).toBe('23514');
    expect(await rejectedPgCode(db.insert(heroRaidReservations).values({
      hero: 'vex', raidId: raid.id,
    }))).toBe('23514');

    await reserveRaidHeroes(db, raid, ['vex']);
    expect(await rejectedPgCode(db.insert(heroRaidReservations).values({
      baseId: otherBase.id, hero: 'vex', raidId: raid.id,
    }))).toBe('23505');
    expect(await rejectedPgCode(db.insert(heroRaidReservations).values({
      baseId: base.id, hero: 'theodor', raidId: '00000000-0000-4000-8000-000000000000',
    }))).toBe('23503');

    // Rewritten 2026-10-10 (D153.225, migration 0280): this used to delete the
    // raid and expect the reservation to cascade away. Every raid now owns an
    // immutable bound-cosmetic capture (FK, delete-guarded), so raid history
    // cannot be deleted at all: the delete is refused and the reservation
    // survives intact instead of being orphaned. The FK itself still cascades,
    // so the reservation can never outlive its raid if that rule is relaxed.
    expect(await rejectedPgCode(db.delete(raids).where(eq(raids.id, raid.id)))).toBe('23503');
    expect(await db.select({ raidId: heroRaidReservations.raidId }).from(heroRaidReservations)
      .where(eq(heroRaidReservations.raidId, raid.id))).toEqual([{ raidId: raid.id }]);
    const [fk] = await conn.sql<{ action: string }[]>`
      SELECT confdeltype AS action FROM pg_constraint
      WHERE conrelid = 'public.hero_raid_reservations'::regclass
        AND confrelid = 'public.raids'::regclass AND contype = 'f'`;
    expect(fk?.action).toBe('c');
  });
});
