import { randomUUID } from 'node:crypto';
import { and, eq, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  baseBattleRecords, baseProfiles, bases, baseSlots, pveCamps, raidReplayTimelines, raids, shields,
  valleys,
} from '../src/db/schema';
import {
  applyBasePvpTrophies, consumeBasePurchasedEnergy, getSelectedBaseProfile,
} from '../src/game/baseProfiles';
import {
  assertBaseShieldExtendable, breakBaseShieldOnAttack, grantBaseDefenseShield,
  grantBaseShieldExtension,
} from '../src/game/baseShields';
import {
  getBaseBattleHistory, getBaseBattleReplay,
  getParticipantBattleHistory, getParticipantBattleReplay, recordBaseBattle,
} from '../src/game/baseBattleHistory';
import { persistReplayTimeline } from '../src/game/raidReplayArchive';
import { connectTestDb, createTestPlayer } from './helpers';
import type { DbOrTx } from '../src/db/client';

const conn = connectTestDb();
const db = conn.db;

async function deedBase(wallet: string, slot: number) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    status: 'active',
    landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id, active: true });
  return base!;
}

async function resolvedRaid(attacker: { wallet: string; id: string }, defender: { wallet: string; id: string }) {
  const [raid] = await db.insert(raids).values({
    attackerWallet: attacker.wallet,
    attackerBaseId: attacker.id,
    defenderWallet: defender.wallet,
    defenderBaseId: defender.id,
    seed: 7n,
    snapshot: { buildings: [], surplusShards: 999_999 },
    armySnapshot: { troops: [] },
    orders: { deploys: [] },
    ordersDeadlineAt: new Date('2026-08-12T00:01:00.000Z'),
    status: 'resolved',
    events: [],
    result: {
      stars: 2,
      destructionPct: 71,
      keepDestroyed: true,
      lootShards: 1250,
      attackerTrophyDelta: 12,
      defenderTrophyDelta: -12,
    },
    simVersion: 9,
    resolvedAt: new Date('2026-08-12T00:02:00.000Z'),
  }).returning();
  await persistReplayTimeline(db, raid!.id, {
    snapshot: raid!.snapshot,
    armySnapshot: raid!.armySnapshot,
    orders: raid!.orders,
    seed: Number(raid!.seed),
    simVersion: raid!.simVersion,
    events: [],
    result: raid!.result,
  }, 0);
  return raid!;
}

let pveSite = 900_000_000;

async function resolvedSoloRaid(
  tx: DbOrTx, attacker: { wallet: string; id: string }, mode: 'pve' | 'campaign',
) {
  let pveCampId: string | undefined;
  if (mode === 'pve') {
    const [valley] = await tx.insert(valleys).values({
      name: `History Valley ${pveSite}`,
      siteId: pveSite++,
    }).returning();
    const [camp] = await tx.insert(pveCamps).values({
      valleyId: valley!.id,
      x: 4,
      y: 5,
      tier: 3,
      snapshot: { buildings: [] },
      lootKeep: 77n,
    }).returning();
    pveCampId = camp!.id;
  }
  const [raid] = await tx.insert(raids).values({
    attackerWallet: attacker.wallet,
    attackerBaseId: attacker.id,
    ...(pveCampId ? { pveCampId } : { campaignStage: 17 }),
    seed: 11n,
    snapshot: { buildings: [], surplusShards: 123_456 },
    armySnapshot: { troops: [] },
    orders: { deploys: [] },
    ordersDeadlineAt: new Date('2026-08-12T03:01:00.000Z'),
    status: 'resolved',
    events: [],
    result: {
      stars: 3,
      destructionPct: 100,
      keepDestroyed: true,
      lootShards: mode === 'pve' ? 77 : 300,
      attackerTrophyDelta: 0,
      defenderTrophyDelta: 0,
    },
    simVersion: 9,
    resolvedAt: new Date('2026-08-12T03:02:00.000Z'),
  }).returning();
  await persistReplayTimeline(tx, raid!.id, {
    snapshot: raid!.snapshot,
    armySnapshot: raid!.armySnapshot,
    orders: raid!.orders,
    seed: Number(raid!.seed),
    simVersion: raid!.simVersion,
    events: [],
    result: raid!.result,
  }, 0);
  await recordBaseBattle(tx, {
    raidId: raid!.id,
    attackerBaseId: attacker.id,
    attackerOwnerWallet: attacker.wallet,
    stars: 3,
    destructionPct: 100,
    lootShards: mode === 'campaign' ? 300n : 0n,
    createdAt: new Date(mode === 'pve' ? '2026-08-12T03:00:00.000Z' : '2026-08-12T04:00:00.000Z'),
  });
  return raid!;
}

afterAll(async () => conn.sql.end());

describe.sequential('deed-native profiles', () => {
  it('isolates trophies, energy and league state between two bases of one wallet', async () => {
    // (keep_skin left this fixture with the M23 a8 skin removal — the column
    // is dead; league carries the same "profile state follows the deed" pin.)
    const owner = await createTestPlayer(db);
    const opponent = await createTestPlayer(db);
    const first = await deedBase(owner.wallet, 1);
    const second = await deedBase(owner.wallet, 2);
    const defender = await deedBase(opponent.wallet, 1);
    await db.insert(baseProfiles).values([
      { baseId: first.id, trophies: 100, purchasedEnergy: 2, league: 'silver' },
      { baseId: second.id, trophies: 900, purchasedEnergy: 5, league: 'gold' },
      { baseId: defender.id, trophies: 100 },
    ]);

    await db.transaction(async (tx) => {
      expect(await consumeBasePurchasedEnergy(tx, first.id)).toBe(1);
      await applyBasePvpTrophies(tx, first.id, defender.id, 1, new Date('2026-08-12T01:00:00Z'));
    });

    const a = await getSelectedBaseProfile(db, owner.wallet, first.id);
    const b = await getSelectedBaseProfile(db, owner.wallet, second.id);
    expect(a).toMatchObject({ purchasedEnergy: 1, league: 'silver' });
    expect(a.trophies).toBeGreaterThan(100);
    expect(b).toMatchObject({ trophies: 900, purchasedEnergy: 5, league: 'gold' });
  });
});

describe.sequential('base-scoped shields', () => {
  it('breaks only the attacking deed and records 48h for every one-star-or-better defense', async () => {
    const owner = await createTestPlayer(db);
    const first = await deedBase(owner.wallet, 1);
    const second = await deedBase(owner.wallet, 2);
    const now = new Date('2026-08-12T10:00:00.000Z');
    await db.insert(shields).values([
      { playerWallet: owner.wallet, baseId: first.id, source: 'loss', expiresAt: new Date(now.getTime() + 3_600_000) },
      { playerWallet: owner.wallet, baseId: second.id, source: 'loss', expiresAt: new Date(now.getTime() + 3_600_000) },
    ]);
    expect(await breakBaseShieldOnAttack(db, owner.wallet, first.id)).toBe(1);
    expect(await db.select().from(shields).where(eq(shields.baseId, first.id))).toHaveLength(0);
    expect(await db.select().from(shields).where(eq(shields.baseId, second.id))).toHaveLength(1);

    expect((await grantBaseDefenseShield(db, owner.wallet, first.id, 0, now)).expiresAt).toBeNull();
    const duringWarzone = await grantBaseDefenseShield(db, owner.wallet, first.id, 1, now);
    expect(duringWarzone.expiresAt).toEqual(new Date(now.getTime() + 48 * 3_600_000));
    const granted = await grantBaseDefenseShield(db, owner.wallet, first.id, 1, now);
    expect(granted.expiresAt?.toISOString()).toBe('2026-08-14T10:00:00.000Z');
  });

  it('allows +12h at exactly 36h remaining, refuses one millisecond above, and caps at 48h', async () => {
    const owner = await createTestPlayer(db);
    const base = await deedBase(owner.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');
    const [shield] = await db.insert(shields).values({
      playerWallet: owner.wallet,
      baseId: base.id,
      source: 'loss',
      expiresAt: new Date(now.getTime() + 36 * 3_600_000 + 1),
    }).returning();
    const warzoneExpiry = new Date(now.getTime() + 72 * 3_600_000);
    const [warzone] = await db.insert(shields).values({
      playerWallet: owner.wallet,
      baseId: base.id,
      source: 'warzone',
      expiresAt: warzoneExpiry,
    }).returning();
    await expect(assertBaseShieldExtendable(db, owner.wallet, base.id, now))
      .rejects.toThrow(/1d 12h remaining or less/);
    await db.update(shields).set({ expiresAt: new Date(now.getTime() + 36 * 3_600_000) })
      .where(eq(shields.id, shield!.id));
    await expect(assertBaseShieldExtendable(db, owner.wallet, base.id, now)).resolves.toBeUndefined();
    const extended = await grantBaseShieldExtension(db, owner.wallet, base.id, now);
    expect(extended).toMatchObject({ granted: true });
    expect(extended.expiresAt?.toISOString()).toBe('2026-08-14T10:00:00.000Z');
    expect((await db.select().from(shields).where(eq(shields.id, warzone!.id)))[0])
      .toMatchObject({ source: 'warzone', expiresAt: warzoneExpiry });
  });

  it('never lets a delayed base-scoped ordinary credit mutate the remaining warzone row', async () => {
    const owner = await createTestPlayer(db);
    const base = await deedBase(owner.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');
    const warzoneExpiry = new Date(now.getTime() + 72 * 3_600_000);
    const [warzone] = await db.insert(shields).values({
      playerWallet: owner.wallet,
      baseId: base.id,
      source: 'warzone',
      expiresAt: warzoneExpiry,
    }).returning();

    await expect(assertBaseShieldExtendable(db, owner.wallet, base.id, now))
      .rejects.toThrow(/no active shield/);

    const [ordinary] = await db.insert(shields).values({
      playerWallet: owner.wallet,
      baseId: base.id,
      source: 'loss',
      expiresAt: new Date(now.getTime() + 30 * 3_600_000),
    }).returning();
    await expect(assertBaseShieldExtendable(db, owner.wallet, base.id, now))
      .resolves.toBeUndefined();
    // Represents the deed attacking after payment broadcast but before credit.
    await db.delete(shields).where(eq(shields.id, ordinary!.id));
    expect(await grantBaseShieldExtension(db, owner.wallet, base.id, now))
      .toEqual({ expiresAt: null, granted: false });
    expect((await db.select().from(shields).where(eq(shields.id, warzone!.id)))[0])
      .toMatchObject({ source: 'warzone', expiresAt: warzoneExpiry });
  });

  it('makes an inherited shield obey the deed owner instead of its legacy wallet shadow', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await deedBase(seller.wallet, 1);
    const now = new Date('2026-08-12T10:00:00.000Z');
    await db.insert(shields).values({
      playerWallet: seller.wallet,
      baseId: base.id,
      source: 'loss',
      expiresAt: new Date(now.getTime() + 36 * 3_600_000),
    });
    await db.transaction(async (tx) => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, base.id));
      await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, base.id));
      await tx.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: base.id, active: true });
    });

    await expect(assertBaseShieldExtendable(db, seller.wallet, base.id, now))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(assertBaseShieldExtendable(db, buyer.wallet, base.id, now))
      .resolves.toBeUndefined();
    expect(await breakBaseShieldOnAttack(db, buyer.wallet, base.id)).toBe(1);
  });
});

describe.sequential('permanent deed battle history', () => {
  it('uses a stable cursor and never mixes two bases owned by one wallet', async () => {
    const owner = await createTestPlayer(db);
    const enemy = await createTestPlayer(db);
    const first = await deedBase(owner.wallet, 1);
    const second = await deedBase(owner.wallet, 2);
    const defender = await deedBase(enemy.wallet, 1);
    for (let i = 0; i < 3; i++) {
      const raid = await resolvedRaid({ wallet: owner.wallet, id: first.id }, { wallet: enemy.wallet, id: defender.id });
      await recordBaseBattle(db, {
        raidId: raid.id,
        attackerBaseId: first.id,
        defenderBaseId: defender.id,
        attackerOwnerWallet: owner.wallet,
        defenderOwnerWallet: enemy.wallet,
        stars: 2,
        destructionPct: 60 + i,
        lootShards: BigInt(100 + i),
        createdAt: new Date(`2026-08-12T0${i}:00:00.000Z`),
      });
    }
    const page1 = await getBaseBattleHistory(db, owner.wallet, first.id, { limit: 2 });
    expect(page1.battles).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await getBaseBattleHistory(db, owner.wallet, first.id, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.battles).toHaveLength(1);
    expect(new Set([...page1.battles, ...page2.battles].map((r) => r.raidId)).size).toBe(3);
    expect((await getBaseBattleHistory(db, owner.wallet, second.id)).battles).toEqual([]);

    // WHY: a deed page and a wallet participant page use independent cursors.
    // Selling the base later must not collapse the owner's full history back to
    // the legacy twenty-row window.
    const participant1 = await getParticipantBattleHistory(db, owner.wallet, { limit: 2 });
    const participant2 = await getParticipantBattleHistory(db, owner.wallet, {
      limit: 2,
      cursor: participant1.nextCursor!,
    });
    expect(participant1.battles).toHaveLength(2);
    expect(participant2.battles).toHaveLength(1);
    expect(new Set([...participant1.battles, ...participant2.battles].map((r) => r.raidId)).size)
      .toBe(3);
  });

  it('transfers metadata/replay with the deed but redacts exact loot from the buyer', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const enemy = await createTestPlayer(db);
    const sold = await deedBase(seller.wallet, 1);
    const defender = await deedBase(enemy.wallet, 1);
    const raid = await resolvedRaid({ wallet: seller.wallet, id: sold.id }, { wallet: enemy.wallet, id: defender.id });
    await recordBaseBattle(db, {
      raidId: raid.id,
      attackerBaseId: sold.id,
      defenderBaseId: defender.id,
      attackerOwnerWallet: seller.wallet,
      defenderOwnerWallet: enemy.wallet,
      stars: 2,
      destructionPct: 71,
      lootShards: 1_250n,
      createdAt: new Date('2026-08-12T02:00:00.000Z'),
    });
    const beforeSale = await getBaseBattleHistory(db, seller.wallet, sold.id);
    expect(beforeSale.battles[0]).toMatchObject({ lootDeltaShards: '1250', lootRedacted: false });

    await db.transaction(async (tx) => {
      await tx.delete(baseSlots).where(and(eq(baseSlots.wallet, seller.wallet), eq(baseSlots.baseId, sold.id)));
      await tx.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, sold.id));
      await tx.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: sold.id, active: true });
    });
    await expect(getBaseBattleHistory(db, seller.wallet, sold.id)).rejects.toMatchObject({ statusCode: 404 });
    const inherited = await getBaseBattleHistory(db, buyer.wallet, sold.id);
    expect(inherited.battles[0]).toMatchObject({
      lootDeltaShards: null,
      lootRedacted: true,
      opponent: { wallet: enemy.wallet },
      stars: 2,
      destructionPct: 71,
    });
    const replay = await getBaseBattleReplay(db, buyer.wallet, sold.id, raid.id);
    expect(replay.result).toMatchObject({ lootShards: null, lootRedacted: true });
    expect(replay.snapshot).not.toHaveProperty('surplusShards');
    expect(replay.timeline).toMatchObject({ integrityVerified: true });
    expect(replay.timeline).not.toHaveProperty('data');
    expect(JSON.stringify(replay)).not.toContain('999999');
    expect(JSON.stringify(replay)).not.toContain('1250');

    // WHY: transfer changes deed authority, not the immutable identity of who
    // actually fought. The seller keeps exact private access; the buyer inherits
    // a redacted deed copy but cannot call themselves a prior participant.
    const sellerHistory = await getParticipantBattleHistory(db, seller.wallet);
    expect(sellerHistory.battles[0]).toMatchObject({
      baseId: sold.id,
      raidId: raid.id,
      settledAmount: '1250',
      settledCurrency: 'SHARDS',
      lootRedacted: false,
    });
    const sellerReplay = await getParticipantBattleReplay(db, seller.wallet, raid.id);
    expect(sellerReplay.result).toMatchObject({ lootShards: 1250, lootRedacted: false });
    expect(sellerReplay.timeline).toMatchObject({ integrityVerified: true });
    expect((await getParticipantBattleHistory(db, buyer.wallet)).battles
      .some((row) => row.raidId === raid.id)).toBe(false);
    await expect(getParticipantBattleReplay(db, buyer.wallet, raid.id))
      .rejects.toMatchObject({ statusCode: 404 });

    const [archive] = await db.select().from(raidReplayTimelines)
      .where(eq(raidReplayTimelines.raidId, raid.id));
    const corrupted = Buffer.from(archive!.timeline);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    await db.update(raidReplayTimelines).set({ timeline: corrupted })
      .where(eq(raidReplayTimelines.raidId, raid.id));
    await expect(getBaseBattleReplay(db, buyer.wallet, sold.id, raid.id))
      .rejects.toMatchObject({ statusCode: 409 });

    const outsider = await createTestPlayer(db);
    const outsiderBase = await deedBase(outsider.wallet, 1);
    await expect(getBaseBattleReplay(db, outsider.wallet, outsiderBase.id, raid.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(getParticipantBattleReplay(db, outsider.wallet, raid.id))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await db.select().from(baseBattleRecords).where(eq(baseBattleRecords.baseId, sold.id)))
      .toHaveLength(1);
  });

  it('records PvE and campaign as truthful attacker-only history with private verified replays', async () => {
    const owner = await createTestPlayer(db);
    const base = await deedBase(owner.wallet, 1);
    // Keep the synthetic off-map PvE camp invisible to concurrently-running map
    // suites. The production rows are permanent; this fixture is deliberately
    // rolled back only after proving both archive paths inside the transaction.
    await expect(db.transaction(async (tx) => {
      const pve = await resolvedSoloRaid(tx, { wallet: owner.wallet, id: base.id }, 'pve');
      const campaign = await resolvedSoloRaid(tx, { wallet: owner.wallet, id: base.id }, 'campaign');

      const history = await getParticipantBattleHistory(tx, owner.wallet);
      const pveRow = history.battles.find((row) => row.raidId === pve.id);
      const campaignRow = history.battles.find((row) => row.raidId === campaign.id);
      expect(pveRow).toMatchObject({
        role: 'attacker', mode: 'pve', opponentLabel: 'PVE CAMP',
        opponent: null, settledAmount: '77', settledCurrency: 'KEEP',
      });
      expect(campaignRow).toMatchObject({
        role: 'attacker', mode: 'campaign', opponentLabel: 'CAMPAIGN STAGE 17',
        opponent: null, settledAmount: '300', settledCurrency: 'SHARDS',
      });
      await expect(getParticipantBattleReplay(tx, owner.wallet, pve.id))
        .resolves.toMatchObject({ id: pve.id, timeline: { integrityVerified: true } });
      await expect(getParticipantBattleReplay(tx, owner.wallet, campaign.id))
        .resolves.toMatchObject({ id: campaign.id, timeline: { integrityVerified: true } });
      tx.rollback();
    })).rejects.toBeInstanceOf(TransactionRollbackError);
  });
});
