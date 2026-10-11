/**
 * GET /base `defences` (D-099, owner 2026-09-02: "no notification that you
 * have been raided"). The HUD's RAIDED chip counts these rows against a
 * device-local seen stamp and REVENGE attacks the attacker they name, so the
 * shape must be: the selected deed's DEFENCES only, newest first, capped by
 * BATTLE_HISTORY.hudRecentDefences, with `lastAt` equal to the newest row or
 * null — and the deedless starter must get the empty shape, never a
 * wallet-keyed guess.
 */
import { BATTLE_HISTORY } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, players, raids } from '../src/db/schema';
import { ensureStartingBase, getBaseState } from '../src/game/base';
import { recordBaseBattle } from '../src/game/baseBattleHistory';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

async function deedBase(wallet: string, slot: number) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    status: 'active',
    landPaidAt: new Date('2026-09-01T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id, active: true });
  return base!;
}

async function resolvedPvpRaid(
  attacker: { wallet: string; id: string }, defender: { wallet: string; id: string },
) {
  const [raid] = await db.insert(raids).values({
    attackerWallet: attacker.wallet,
    attackerBaseId: attacker.id,
    defenderWallet: defender.wallet,
    defenderBaseId: defender.id,
    seed: 7n,
    snapshot: { buildings: [] },
    armySnapshot: { troops: [] },
    orders: { deploys: [] },
    ordersDeadlineAt: new Date('2026-09-01T00:01:00.000Z'),
    status: 'resolved',
    events: [],
    result: {
      stars: 1, destructionPct: 55, keepDestroyed: false, lootShards: 10,
      attackerTrophyDelta: 5, defenderTrophyDelta: -5,
    },
    simVersion: 11,
    resolvedAt: new Date('2026-09-01T00:02:00.000Z'),
  }).returning();
  return raid!;
}

afterAll(async () => conn.sql.end());

describe.sequential('GET /base defences', () => {
  it('lists only the deed’s defences, newest first, capped, naming the attacker', async () => {
    const attacker = await createTestPlayer(db);
    const defender = await createTestPlayer(db);
    await db.update(players).set({ name: 'BLACKBEARD' }).where(eq(players.wallet, attacker.wallet));
    const attackerBase = await deedBase(attacker.wallet, 1);
    const defenderBase = await deedBase(defender.wallet, 1);
    const cap = BATTLE_HISTORY.hudRecentDefences;

    // cap + 1 defences one minute apart, inserted OLDEST LAST so an insertion
    // order that happened to match the expected order could not pass by luck.
    const stamps = Array.from({ length: cap + 1 }, (_, i) => (
      new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString()
    ));
    const raidIdsByStamp = new Map<string, string>();
    for (const stamp of [...stamps].reverse()) {
      const raid = await resolvedPvpRaid(
        { wallet: attacker.wallet, id: attackerBase.id },
        { wallet: defender.wallet, id: defenderBase.id },
      );
      raidIdsByStamp.set(stamp, raid.id);
      await recordBaseBattle(db, {
        raidId: raid.id,
        attackerBaseId: attackerBase.id,
        defenderBaseId: defenderBase.id,
        attackerOwnerWallet: attacker.wallet,
        defenderOwnerWallet: defender.wallet,
        stars: 1,
        destructionPct: 55,
        lootShards: 10n,
        createdAt: new Date(stamp),
      });
    }
    // The defender also ATTACKED once: an attacker-role row on its own deed
    // must never count as being raided.
    const counter = await resolvedPvpRaid(
      { wallet: defender.wallet, id: defenderBase.id },
      { wallet: attacker.wallet, id: attackerBase.id },
    );
    await recordBaseBattle(db, {
      raidId: counter.id,
      attackerBaseId: defenderBase.id,
      defenderBaseId: attackerBase.id,
      attackerOwnerWallet: defender.wallet,
      defenderOwnerWallet: attacker.wallet,
      stars: 3,
      destructionPct: 100,
      lootShards: 99n,
      createdAt: new Date('2026-09-01T23:00:00.000Z'),
    });

    const state = await getBaseState(db, defender.wallet, new Date('2026-09-02T00:00:00.000Z'), defenderBase.id);
    const expected = [...stamps].reverse().slice(0, cap);
    expect(state.defences.recent.map((row) => row.createdAt)).toEqual(expected);
    expect(state.defences.lastAt).toBe(expected[0]);
    expect(state.defences.recent).toHaveLength(cap);
    expect(state.defences.recent[0]).toEqual({
      raidId: raidIdsByStamp.get(expected[0]!),
      createdAt: expected[0],
      attackerBaseId: attackerBase.id,
      attackerWallet: attacker.wallet,
      attackerName: 'BLACKBEARD',
      stars: 1,
      destructionPct: 55,
    });
    expect(state.defences.recent.some((row) => row.raidId === counter.id)).toBe(false);
    // Nothing monetary rides on the HUD payload: loot stays on the raid log.
    expect(Object.keys(state.defences.recent[0]!)).not.toContain('lootDeltaShards');
  });

  it('is empty for a deed that only attacked and for the deedless starter', async () => {
    const attacker = await createTestPlayer(db);
    const victim = await createTestPlayer(db);
    const attackerBase = await deedBase(attacker.wallet, 1);
    const victimBase = await deedBase(victim.wallet, 1);
    const raid = await resolvedPvpRaid(
      { wallet: attacker.wallet, id: attackerBase.id },
      { wallet: victim.wallet, id: victimBase.id },
    );
    await recordBaseBattle(db, {
      raidId: raid.id,
      attackerBaseId: attackerBase.id,
      defenderBaseId: victimBase.id,
      attackerOwnerWallet: attacker.wallet,
      defenderOwnerWallet: victim.wallet,
      stars: 2,
      destructionPct: 70,
      lootShards: 40n,
    });

    const attackerState = await getBaseState(db, attacker.wallet, new Date(), attackerBase.id);
    expect(attackerState.defences).toEqual({ lastAt: null, recent: [] });

    // Legacy/deedless read: no stable base id → no deed history to consult.
    const starter = await createTestPlayer(db);
    await ensureStartingBase(db, starter.wallet);
    const deedless = await getBaseState(db, starter.wallet);
    expect(deedless.baseId).toBeNull();
    expect(deedless.defences).toEqual({ lastAt: null, recent: [] });
  });
});
