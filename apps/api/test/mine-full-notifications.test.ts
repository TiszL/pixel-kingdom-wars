/** M34 Mine-full push: exact copy/links, durable cycle claims, batching,
 * consent/history suppression, priority, cap, and concurrent sweeps. */
import { randomUUID } from 'node:crypto';
import { getMiningQuota, NOTIFICATIONS } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  baseRaidLocks, bases, baseSlots, buildings, builderJobs, mailMessages, mineAccrualStates,
  pushEvents, pushSubscriptions, nativePushSubscriptions, raids,
} from '../src/db/schema';
import {
  claimDueMineFullGroups, classifyMineFullNotificationBootstrap,
  mineFullPayload, mineFullRef, sweepDueNotifications,
} from '../src/notifications';
import type { PushPayload, PushTransport } from '../src/notifications';
import { transferStableBase } from '../src/game/baseOwnership';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

afterAll(async () => { await conn.sql.end(); });

async function addSubscription(wallet: string, enabledAt: Date) {
  const [row] = await db.insert(pushSubscriptions).values({
    wallet,
    endpoint: `https://fcm.googleapis.com/fcm/send/mine/${randomUUID()}`,
    p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url'),
    auth: Buffer.alloc(16, 8).toString('base64url'),
    enabledAt,
  }).returning();
  return row!;
}

async function addDeed(wallet: string, slot: number, keepLevel = 1) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    status: 'active',
    keepLevel,
    landPaidAt: new Date('2030-01-01T00:00:00.000Z'),
    deedAssetId: `deed-${randomUUID()}`,
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id, active: true });
  return base!;
}

async function addFullMine(
  wallet: string, baseId: string, fullAt: Date, level = 1, cycle = 0,
  bootstrapPending = false,
) {
  const [mine] = await db.insert(buildings).values({
    playerWallet: wallet, baseId, type: 'mine', level, tx: level, ty: level,
  }).returning();
  const quota = getMiningQuota(1, [level], 0);
  await db.insert(mineAccrualStates).values({
    mineBuildingId: mine!.id,
    accruedShards: 0n,
    lastAccrualAt: new Date(fullAt.getTime() - 86_400_000),
    fullNotificationCycle: cycle,
    fullNotificationCheckAt: fullAt,
    fullNotificationBootstrapPending: bootstrapPending,
  });
  return { mine: mine!, quota };
}

describe.sequential('Mine-full push claims', () => {
  it('shares the physical Mine cycle with native-only consent and holds it while FCM is paused', async () => {
    const fullAt = new Date('2044-01-02T03:04:05.000Z');
    const player = await createTestPlayer(db);
    const base = await addDeed(player.wallet, 1);
    const { mine } = await addFullMine(player.wallet, base.id, fullAt);
    const bindingId = randomUUID();
    await db.insert(nativePushSubscriptions).values({
      wallet: player.wallet, token: `test:${randomUUID()}`, bindingId,
      packageName: 'gg.pixelkingdomwars.twa', enabledAt: new Date(fullAt.getTime() - 1000),
    });
    const now = new Date(fullAt.getTime() + NOTIFICATIONS.batchWindowMs);
    const paused = await sweepDueNotifications(db, async () => { throw new Error('no web consent'); }, now,
      { mineFullEnabled: true });
    expect(paused).toMatchObject({ claimed: 0, held: 1 });
    expect(await db.select().from(pushEvents).where(eq(pushEvents.refId, mineFullRef(mine.id, 0)))).toHaveLength(0);
    const deliveries: Array<{ bindingId: string; kind: string; url: string }> = [];
    const active = await sweepDueNotifications(db, null, now, {
      mineFullEnabled: true, fcmTransport: async (_target, payload) => { deliveries.push(payload); },
    });
    expect(active).toMatchObject({ claimed: 1, sent: 1 });
    expect(deliveries).toEqual([expect.objectContaining({ bindingId, kind: 'mine_full', url: '/?screen=base' })]);
    expect((await sweepDueNotifications(db, null, now, {
      mineFullEnabled: true, fcmTransport: async () => { throw new Error('must not retry'); },
    })).claimed).toBe(0);
  });

  it('pins the exact copy, dedupe reference, and one-/multi-base deep links', () => {
    expect(mineFullRef('00000000-0000-0000-0000-000000000001', 7))
      .toBe('mine:00000000-0000-0000-0000-000000000001:cycle:7');
    expect(mineFullPayload(1, false)).toEqual({
      kind: 'mine_full', title: 'MINES FULL — COLLECT NOW', tag: 'mine_full',
      body: 'Your Mine is full. Collect SHARDS to grow stronger or forge KEEP before rivals strike.',
      url: '/?screen=base',
    });
    expect(mineFullPayload(3, true)).toEqual({
      kind: 'mine_full', title: 'MINES FULL — COLLECT NOW', tag: 'mine_full',
      body: '3 Mines are full. Collect SHARDS to grow stronger or forge KEEP before rivals strike.',
      url: '/?screen=bases',
    });
  });

  it('resumably suppresses legacy-full buffers while scheduling partial buffers exactly', async () => {
    const boundary = new Date();
    const player = await createTestPlayer(db);
    const base = await addDeed(player.wallet, 1);
    const legacyFullAt = new Date(boundary.getTime() - 60_000);
    const partialFullAt = new Date(boundary.getTime() + 12 * 3_600_000);
    const full = await addFullMine(player.wallet, base.id, legacyFullAt, 1, 4, true);
    const partial = await addFullMine(player.wallet, base.id, partialFullAt, 1, 9, true);
    await db.update(mineAccrualStates).set({ fullNotificationCheckAt: null }).where(and(
      eq(mineAccrualStates.mineBuildingId, full.mine.id),
      eq(mineAccrualStates.fullNotificationBootstrapPending, true),
    ));
    await db.update(mineAccrualStates).set({ fullNotificationCheckAt: null }).where(and(
      eq(mineAccrualStates.mineBuildingId, partial.mine.id),
      eq(mineAccrualStates.fullNotificationBootstrapPending, true),
    ));

    const first = await classifyMineFullNotificationBootstrap(db);
    expect(first).toMatchObject({ classified: 2, suppressed: 1, scheduled: 1 });
    const [fullState] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, full.mine.id));
    const [partialState] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, partial.mine.id));
    expect(fullState).toMatchObject({
      fullNotificationBootstrapPending: false,
      fullNotificationCheckAt: null,
      fullNotificationCycle: 4,
    });
    expect(partialState).toMatchObject({
      fullNotificationBootstrapPending: false,
      fullNotificationCheckAt: partialFullAt,
      fullNotificationCycle: 9,
    });
    expect((await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, mineFullRef(full.mine.id, 4)),
    )))[0]).toMatchObject({ wallet: player.wallet, outcome: 'suppressed' });
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, mineFullRef(partial.mine.id, 9)),
    ))).toHaveLength(0);

    // A later tick or worker restart sees no bootstrap work and cannot alter
    // the durable suppression or the partial Mine's legitimate future due row.
    expect(await classifyMineFullNotificationBootstrap(db)).toMatchObject({
      scanned: 0, classified: 0, suppressed: 0, scheduled: 0,
    });
    const [afterRestart] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, partial.mine.id));
    expect(afterRestart!.fullNotificationCheckAt).toEqual(partialFullAt);
  });

  it('serializes concurrent bootstrap retries and preserves an existing ledger outcome', async () => {
    const boundary = new Date(Date.now() - 60_000);
    const player = await createTestPlayer(db);
    const base = await addDeed(player.wallet, 1);
    const { mine } = await addFullMine(player.wallet, base.id, boundary, 1, 13, true);
    await db.update(mineAccrualStates).set({ fullNotificationCheckAt: null })
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    const refId = mineFullRef(mine.id, 13);
    const originalAt = new Date('2030-01-02T03:04:05.000Z');
    const deliveryId = randomUUID();
    await db.insert(pushEvents).values({
      kind: 'mine_full', refId, wallet: player.wallet, createdAt: originalAt,
      sentAt: originalAt, deliveryId, outcome: 'sent',
    });

    const results = await Promise.all([
      classifyMineFullNotificationBootstrap(db),
      classifyMineFullNotificationBootstrap(db),
    ]);
    expect(results.reduce((sum, result) => sum + result.classified, 0)).toBe(1);
    const [event] = await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, refId),
    ));
    expect(event).toMatchObject({ outcome: 'sent', deliveryId, createdAt: originalAt });
    const [state] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(state).toMatchObject({
      fullNotificationBootstrapPending: false,
      fullNotificationCheckAt: null,
      fullNotificationCycle: 13,
    });
  });

  it.each(['before discovery', 'during discovery'] as const)(
    'does not let a full page of Mines raid-locked %s starve later bootstrap work', async (when) => {
    const player = await createTestPlayer(db);
    const orderedBases = [await addDeed(player.wallet, 1), await addDeed(player.wallet, 2)]
      .sort((a, b) => a.id.localeCompare(b.id));
    const locked = orderedBases[0]!, available = orderedBases[1]!;
    const fullAt = new Date(Date.now() - 60_000);
    // Synthetic pending rows isolate pagination from placement caps: they
    // represent an entire discovery page blocked behind one durable raid.
    for (let i = 0; i < NOTIFICATIONS.mineBootstrapBatchSize; i++) {
      await addFullMine(player.wallet, locked.id, fullAt, 1, 0, true);
    }
    const later = await addFullMine(player.wallet, available.id, fullAt, 1, 0, true);
    const [raid] = await db.insert(raids).values({
      attackerWallet: player.wallet, defenderWallet: player.wallet,
      attackerBaseId: available.id, defenderBaseId: locked.id,
      seed: 1n, snapshot: { buildings: [] }, armySnapshot: { troops: [] },
      ordersDeadlineAt: new Date(Date.now() + 60_000), status: 'pending_orders',
    }).returning();
    const lock = async (): Promise<void> => {
      await db.insert(baseRaidLocks).values({
        baseId: locked.id, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000),
      });
    };
    if (when === 'during discovery') {
      expect(await classifyMineFullNotificationBootstrap(db, { afterDiscovery: lock })).toMatchObject({
        scanned: NOTIFICATIONS.mineBootstrapBatchSize,
        held: NOTIFICATIONS.mineBootstrapBatchSize,
        classified: 0,
      });
    } else await lock();
    const first = await classifyMineFullNotificationBootstrap(db);
    expect(first).toMatchObject({ scanned: 1, classified: 1, suppressed: 1 });
    const [laterState] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, later.mine.id));
    expect(laterState!.fullNotificationBootstrapPending).toBe(false);
    // Do not "solve" starvation by classifying reserved buffers or forgetting
    // their pending state. Once this exact lock clears they must be revisited.
    await db.delete(baseRaidLocks).where(eq(baseRaidLocks.baseId, locked.id));
    expect(await classifyMineFullNotificationBootstrap(db)).toMatchObject({
      scanned: NOTIFICATIONS.mineBootstrapBatchSize,
      classified: NOTIFICATIONS.mineBootstrapBatchSize,
      suppressed: NOTIFICATIONS.mineBootstrapBatchSize,
    });
    // The raid row stays: since D153.225 (0280) every raid owns an immutable
    // bound-cosmetic capture, so raid history cannot be deleted. Its wallets are
    // unique to this test and it has no live state, so no sweep can pick it up.
  });

  it('leaves a discovered legacy row pending across deed transfer and classifies the buyer state', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addDeed(seller.wallet, 1);
    const future = new Date(Date.now() + 12 * 3_600_000);
    const { mine } = await addFullMine(seller.wallet, base.id, future, 1, 17, true);
    await db.update(mineAccrualStates).set({ fullNotificationCheckAt: null })
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));

    const stale = await classifyMineFullNotificationBootstrap(db, {
      afterDiscovery: async () => {
        await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);
      },
    });
    expect(stale).toMatchObject({ classified: 0, held: 1 });
    const [held] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(held!.fullNotificationBootstrapPending).toBe(true);

    const retried = await classifyMineFullNotificationBootstrap(db);
    expect(retried).toMatchObject({ classified: 1, scheduled: 1, held: 0 });
    const [classified] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(classified!.fullNotificationBootstrapPending).toBe(false);
    expect(classified!.fullNotificationCheckAt).not.toBeNull();
  });

  it('skips reserved Mine row locks without delaying another deed of the same wallet', async () => {
    const fullAt = new Date('2035-02-03T04:05:06.000Z');
    const now = new Date(fullAt.getTime() + NOTIFICATIONS.batchWindowMs);
    const defender = await createTestPlayer(db);
    const attacker = await createTestPlayer(db);
    const reservedBase = await addDeed(defender.wallet, 1);
    const availableBase = await addDeed(defender.wallet, 2);
    const reserved = await addFullMine(defender.wallet, reservedBase.id, fullAt);
    const available = await addFullMine(defender.wallet, availableBase.id, fullAt);
    await addSubscription(defender.wallet, new Date(fullAt.getTime() - 1_000));
    const [raid] = await db.insert(raids).values({
      attackerWallet: attacker.wallet, defenderWallet: defender.wallet,
      defenderBaseId: reservedBase.id,
      seed: 1n, snapshot: { buildings: [] }, armySnapshot: { troops: [] },
      ordersDeadlineAt: new Date(now.getTime() + 60_000), status: 'pending_orders',
    }).returning();

    // An expired raid's restoration can own this building before releasing its
    // base reservation. A notification claim must not wait on that building
    // while holding the reservation row the restoration needs next.
    let releaseBuilding!: () => void;
    let buildingLocked!: () => void;
    let blockerPid = 0;
    const release = new Promise<void>((resolve) => { releaseBuilding = resolve; });
    const locked = new Promise<void>((resolve) => { buildingLocked = resolve; });
    const blocker = db.transaction(async (tx) => {
      const pid = await tx.execute(sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`);
      blockerPid = Number(pid[0]!.pid);
      await tx.select({ id: buildings.id }).from(buildings)
        .where(eq(buildings.id, reserved.mine.id)).for('update');
      buildingLocked();
      await release;
    });
    await locked;
    const claiming = claimDueMineFullGroups(db, now, {
      // Discovery is intentionally non-locking: a reservation can appear
      // between discovery and the authoritative claim transaction.
      afterDiscovery: async () => {
        await db.insert(baseRaidLocks).values({
          baseId: reservedBase.id, raidId: raid!.id,
          expiresAt: new Date(now.getTime() + 60_000),
        });
      },
    });
    let settled = false;
    void claiming.then(() => { settled = true; }, () => { settled = true; });
    let waitedOnReservedBuilding = false;
    try {
      const deadline = Date.now() + 5_000;
      while (!settled && Date.now() < deadline) {
        const [row] = await conn.sql<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
          ) AS blocked
        `;
        if (row?.blocked) { waitedOnReservedBuilding = true; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(settled || waitedOnReservedBuilding).toBe(true);
    } finally {
      releaseBuilding();
      await blocker;
    }
    const result = await claiming;
    expect(waitedOnReservedBuilding).toBe(false);
    expect(result.heldWallets).toBe(1);
    expect(result.groups).toEqual([expect.objectContaining({
      wallet: defender.wallet,
      refs: [{ kind: 'mine_full', refId: mineFullRef(available.mine.id, 0) }],
      payload: mineFullPayload(1, true),
    })]);
    const [reservedState] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, reserved.mine.id));
    expect(reservedState).toMatchObject({
      fullNotificationCycle: 0, fullNotificationCheckAt: fullAt,
    });
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, mineFullRef(reserved.mine.id, 0)),
    ))).toHaveLength(0);
    await db.delete(baseRaidLocks).where(eq(baseRaidLocks.baseId, reservedBase.id));
    expect((await claimDueMineFullGroups(db, now)).groups).toEqual([
      expect.objectContaining({ refs: [{ kind: 'mine_full', refId: mineFullRef(reserved.mine.id, 0) }] }),
    ]);
  });

  it('waits two minutes, aggregates a wallet, and concurrent sweeps deliver once', async () => {
    const fullAt = new Date('2035-01-02T03:04:05.000Z');
    const player = await createTestPlayer(db);
    const base = await addDeed(player.wallet, 1);
    await addDeed(player.wallet, 2);
    const a = await addFullMine(player.wallet, base.id, fullAt, 1);
    const b = await addFullMine(player.wallet, base.id, fullAt, 1);
    await addSubscription(player.wallet, new Date(fullAt.getTime() - 1_000));
    const deliveries: PushPayload[] = [];
    const transport: PushTransport = async (_target, payload) => { deliveries.push(payload); };

    const early = await sweepDueNotifications(
      db, transport, new Date(fullAt.getTime() + NOTIFICATIONS.batchWindowMs - 1),
      { mineFullEnabled: true },
    );
    expect(early).toMatchObject({ claimed: 0, sent: 0 });

    const results = await Promise.all([
      sweepDueNotifications(db, transport,
        new Date(fullAt.getTime() + NOTIFICATIONS.batchWindowMs), { mineFullEnabled: true }),
      sweepDueNotifications(db, transport,
        new Date(fullAt.getTime() + NOTIFICATIONS.batchWindowMs), { mineFullEnabled: true }),
    ]);
    expect(results.reduce((sum, row) => sum + row.claimed, 0)).toBe(2);
    expect(results.reduce((sum, row) => sum + row.sent, 0)).toBe(1);
    expect(deliveries).toEqual([mineFullPayload(2, true)]);
    const events = await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.wallet, player.wallet),
    ));
    expect(events.map((event) => event.refId)).toEqual(expect.arrayContaining([
      mineFullRef(a.mine.id, 0), mineFullRef(b.mine.id, 0),
    ]));
    expect(new Set(events.map((event) => event.deliveryId)).size).toBe(1);

    // A fresh worker process sees the same durable claims and cannot replay the push.
    expect(await sweepDueNotifications(db, async () => {
      throw new Error('a restarted worker must not redeliver a claimed Mine cycle');
    }, new Date(fullAt.getTime() + NOTIFICATIONS.batchWindowMs + 1), {
      mineFullEnabled: true,
    })).toMatchObject({ claimed: 0, sent: 0 });
  });

  it('keeps the physical Mine cycle through a deed transfer', async () => {
    const fullAt = new Date(Date.now() - NOTIFICATIONS.batchWindowMs - 1_000);
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addDeed(seller.wallet, 1);
    const { mine, quota } = await addFullMine(seller.wallet, base.id, fullAt, 1, 8);
    const transferStartedAt = new Date();

    await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);

    const [after] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(after!.fullNotificationCycle).toBe(8);
    expect(after!.accruedShards).toBe(BigInt(quota));
    expect(after!.lastAccrualAt.getTime()).toBeGreaterThanOrEqual(transferStartedAt.getTime());
    // A full Mine remains due under the buyer without inventing a new cycle.
    expect(after!.fullNotificationCheckAt).toEqual(after!.lastAccrualAt);
  });

  it('retries under the buyer when ownership changes after candidate discovery', async () => {
    const now = new Date();
    const fullAt = new Date(now.getTime() - NOTIFICATIONS.batchWindowMs - 1_000);
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addDeed(seller.wallet, 1);
    const { mine } = await addFullMine(seller.wallet, base.id, fullAt, 1, 12);
    await addSubscription(buyer.wallet, new Date(fullAt.getTime() - 1_000));

    const staleClaim = await claimDueMineFullGroups(db, now, {
      afterDiscovery: async () => {
        await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);
      },
    });
    expect(staleClaim).toMatchObject({ groups: [], heldWallets: 1 });
    const refId = mineFullRef(mine.id, 12);
    expect(await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, refId),
    ))).toHaveLength(0);
    const [pending] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(pending!.fullNotificationCheckAt).not.toBeNull();

    const retryAt = new Date(
      pending!.fullNotificationCheckAt!.getTime() + NOTIFICATIONS.batchWindowMs,
    );
    const retried = await claimDueMineFullGroups(db, retryAt);
    expect(retried.groups).toEqual([expect.objectContaining({
      wallet: buyer.wallet,
      refs: [{ kind: 'mine_full', refId }],
    })]);
    const [event] = await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, refId),
    ));
    expect(event).toMatchObject({ wallet: buyer.wallet, outcome: null });
    const [claimed] = await db.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, mine.id));
    expect(claimed!.fullNotificationCheckAt).toBeNull();
  });

  it('suppresses pre-consent and stale history, while the source gate off claims nothing', async () => {
    const now = new Date('2035-02-03T04:05:06.000Z');
    const late = await createTestPlayer(db);
    const lateBase = await addDeed(late.wallet, 1);
    const lateAt = new Date(now.getTime() - NOTIFICATIONS.batchWindowMs - 1_000);
    const lateMine = await addFullMine(late.wallet, lateBase.id, lateAt);
    await addSubscription(late.wallet, new Date(lateAt.getTime() + 1));

    const stale = await createTestPlayer(db);
    const staleBase = await addDeed(stale.wallet, 1);
    const staleAt = new Date(now.getTime() - NOTIFICATIONS.sweepLookbackMs - 1);
    const staleMine = await addFullMine(stale.wallet, staleBase.id, staleAt);
    await addSubscription(stale.wallet, new Date(staleAt.getTime() - 1_000));

    let calls = 0;
    expect(await sweepDueNotifications(db, async () => { calls++; }, now))
      .toMatchObject({ claimed: 0, sent: 0 });
    expect(await db.select().from(pushEvents).where(eq(pushEvents.kind, 'mine_full')))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ refId: mineFullRef(lateMine.mine.id, 0) }),
      ]));

    expect(await sweepDueNotifications(db, async () => { calls++; }, now,
      { mineFullEnabled: true })).toMatchObject({ claimed: 0, sent: 0 });
    expect(calls).toBe(0);
    for (const refId of [mineFullRef(lateMine.mine.id, 0), mineFullRef(staleMine.mine.id, 0)]) {
      expect((await db.select().from(pushEvents).where(and(
        eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, refId),
      )))[0]).toMatchObject({ outcome: 'suppressed', sentAt: null, deliveryId: null });
    }
  });

  it('orders attack, Mine, mail, then build and charges the shared wallet cap', async () => {
    const now = new Date('2035-03-04T05:06:07.000Z');
    const due = new Date(now.getTime() - NOTIFICATIONS.batchWindowMs - 1_000);
    const victim = await createTestPlayer(db);
    const attacker = await createTestPlayer(db);
    const victimBase = await addDeed(victim.wallet, 1);
    const attackerBase = await addDeed(attacker.wallet, 1);
    await addFullMine(victim.wallet, victimBase.id, due);
    await addSubscription(victim.wallet, new Date(due.getTime() - 1_000));
    await db.insert(raids).values({
      attackerWallet: attacker.wallet, attackerBaseId: attackerBase.id,
      defenderWallet: victim.wallet, defenderBaseId: victimBase.id,
      seed: 1n, snapshot: { buildings: [] }, armySnapshot: { troops: [] },
      ordersDeadlineAt: due, status: 'resolved', resolvedAt: due,
    });
    await db.insert(mailMessages).values({
      recipientWallet: victim.wallet, senderKind: 'system', kind: 'info',
      dedupeKey: `mine-priority:${randomUUID()}`, subject: 'Priority mail', body: 'Later.', createdAt: due,
    });
    await db.insert(builderJobs).values({
      playerWallet: victim.wallet, baseId: victimBase.id, kind: 'build',
      startedAt: new Date(due.getTime() - 1_000), finishesAt: due,
    });
    const order: string[] = [];
    await sweepDueNotifications(db, async (_target, payload) => { order.push(payload.kind); }, now,
      { mineFullEnabled: true });
    expect(order).toEqual(['raided', 'mine_full', 'mail', 'build']);

    const capped = await createTestPlayer(db);
    const cappedBase = await addDeed(capped.wallet, 1);
    const cappedMine = await addFullMine(capped.wallet, cappedBase.id, due);
    await addSubscription(capped.wallet, new Date(due.getTime() - 1_000));
    await db.insert(pushEvents).values(Array.from({ length: NOTIFICATIONS.perWalletHourlyCap }, () => ({
      kind: 'mail', refId: randomUUID(), wallet: capped.wallet,
      createdAt: due, sentAt: due, deliveryId: randomUUID(), outcome: 'sent',
    })));
    await sweepDueNotifications(db, async () => { throw new Error('capped push must not send'); }, now,
      { mineFullEnabled: true });
    expect((await db.select().from(pushEvents).where(and(
      eq(pushEvents.kind, 'mine_full'), eq(pushEvents.refId, mineFullRef(cappedMine.mine.id, 0)),
    )))[0]).toMatchObject({ outcome: 'capped', sentAt: null });
  });
});
