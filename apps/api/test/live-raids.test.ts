/**
 * Live commands are the authoritative battle input, not a spectator-only feed.
 * These tests pin the attack-start boundary (first deploy), retry dedupe,
 * server timestamps, defender hydration, and one-raid-per-base interlock.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BUFFS, BuildingType, LIVE_RAID, RAID_REPLAY_LIMITS, RAID_RULES, type BaseSnapshot, type RaidProtocolVersion } from '@shardkeep/shared';
import { MAX_TICKS, SIM_VERSION, simulateRaid } from '@shardkeep/sim';
import { and, eq, inArray, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import {
  army, baseRaidLocks, bases, baseSlots, ledgerTransactions, players, raidCommands, raidLiveStates, raids, shields,
} from '../src/db/schema';
import {
  acceptLiveRaidCommand,
  acceptLiveRaidCommandReceipt,
  autoStartDueLiveRaids,
  batchOrdersSubmitDeadlineAt,
  closeLiveRaidStream,
  getLiveRaidCommands,
  getRaidClock,
  initializeBatchRaidJournal,
  initializeLiveRaid,
  raidTransactionWallNow,
  raidSimAtWallMs,
  retreatUnstartedLiveRaid,
  retreatLiveRaid,
  setLiveRaidSpeed,
  startLiveRaid,
} from '../src/game/liveRaids';
import {
  assertNoIncompatibleStartedLiveRaids, compensatePendingRaid,
  getPendingRaidResumes, getRaidEnergy, recoverDueStartedLiveRaids, recoverNeverStartedLiveRaids,
  submitOrders,
} from '../src/game/raids';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;

const publicCommandKeys = [
  'acceptedAt', 'clientCommandId', 'kind', 'payload', 'sequence', 'serverOffsetMs',
];

function expectJsonSafePublicCommand(command: unknown): void {
  expect(Object.keys(command as Record<string, unknown>).sort()).toEqual(publicCommandKeys);
  // WHY: insertion commits before Fastify serializes. A leaked bigint database
  // id turns a successful deploy into a 500, so the client retries troops that
  // the server has already accepted.
  expect(() => JSON.stringify({ command })).not.toThrow();
}

afterAll(async () => { await conn.sql.end(); });

async function liveFixture(
  t0 = new Date('2026-08-12T12:00:00.000Z'), highlanderCount = 2,
  protocolVersion: RaidProtocolVersion = 1,
) {
  const attacker = await createTestPlayer(db);
  const defender = await createTestPlayer(db);
  await fundTestKeep(db, attacker.wallet, 1_000n, 'test.live_keep', randomUUID());
  const [attackerBase, defenderBase] = await db.insert(bases).values([
    { ownerWallet: attacker.wallet, status: 'active', keepLevel: 5 },
    { ownerWallet: defender.wallet, status: 'active', keepLevel: 5 },
  ]).returning();
  // Stable raid capture (0284/0286) requires the defender's active home slot,
  // as normal base registration supplies; a bare bases row is incomplete.
  await db.insert(baseSlots).values({ wallet: defender.wallet, slot: 1, baseId: defenderBase!.id });
  const [raid] = await db.insert(raids).values({
    idempotencyKey: `live-test-${randomUUID()}`,
    attackerWallet: attacker.wallet,
    attackerBaseId: attackerBase!.id,
    defenderWallet: defender.wallet,
    defenderBaseId: defenderBase!.id,
    seed: 7n,
    snapshot: {
      keepLevel: 5, buildings: [], surplusShards: 0, claimMin: 8, claimMax: 22,
    },
    armySnapshot: {
      counts: { highlander: highlanderCount },
      levels: { highlander: 1 },
      heroes: ['vex'],
      attackerKeepLevel: 5,
    },
    simVersion: SIM_VERSION,
    ordersDeadlineAt: new Date(t0.getTime() + 120_000),
    // Production cannot create a raid in the future. Keep the explicit battle
    // clock/deadline used by these tests while satisfying stable-capture time.
    createdAt: sql`LEAST(${t0.toISOString()}::timestamptz, clock_timestamp())`,
  }).returning();
  await initializeLiveRaid(
    db, raid!.id, defenderBase!.id, raid!.ordersDeadlineAt, t0, protocolVersion,
  );
  return { attacker, defender, attackerBase: attackerBase!, defenderBase: defenderBase!, raid: raid!, t0 };
}

/** A D-099 batch journal: the legacy PvP shape (no deeds on either side), the
 * one every journal rule must hold for since PvE/campaign only add a base. */
async function batchFixture(
  t0 = new Date('2026-09-02T12:00:00.000Z'), highlanderCount = 2,
  protocolVersion: RaidProtocolVersion = 1,
  destructible = false,
) {
  const attacker = await createTestPlayer(db);
  await fundTestKeep(db, attacker.wallet, 1_000n, 'test.batch_keep', randomUUID());
  await db.insert(army).values({
    playerWallet: attacker.wallet, troop: 'highlander', count: highlanderCount,
  });
  const [raid] = await db.insert(raids).values({
    idempotencyKey: `batch-test-${randomUUID()}`,
    attackerWallet: attacker.wallet,
    seed: 7n,
    snapshot: {
      keepLevel: 5,
      buildings: destructible
        ? [{ id: 'keep', type: 'keep', level: 5, tx: 14, ty: 14 }]
        : [],
      surplusShards: 0, claimMin: 8, claimMax: 22,
    },
    armySnapshot: {
      counts: { highlander: highlanderCount },
      levels: { highlander: 1 },
      heroes: ['vex'],
      attackerKeepLevel: 5,
    },
    simVersion: SIM_VERSION,
    ordersDeadlineAt: new Date(t0.getTime() + 120_000),
    createdAt: t0,
  }).returning();
  await initializeBatchRaidJournal(db, raid!.id, t0, protocolVersion);
  return { attacker, raid: raid!, t0 };
}

const drop = (tx: number, ty: number, tMs?: number) => ({
  kind: 'deploy' as const,
  payload: { troop: 'highlander' as const, tx, ty, ...(tMs === undefined ? {} : { tMs }) },
});

describe.sequential('live raid command protocol', () => {
  it('acknowledges all four committed deploys over JSON and hydrates the same public stream', async () => {
    const now = new Date();
    const f = await liveFixture(now, 4);
    const app = Fastify({ logger: false });
    app.post('/command', async (req) => {
      const body = req.body as { clientCommandId: string; tx: number };
      return {
        command: await acceptLiveRaidCommand(
          db, f.attacker.wallet, f.raid.id, body.clientCommandId,
          { kind: 'deploy', payload: { troop: 'highlander', tx: body.tx, ty: 1 } },
        ),
      };
    });
    app.get('/live', async () => getLiveRaidCommands(db, f.attacker.wallet, f.raid.id));
    try {
      for (let i = 0; i < 4; i++) {
        const response = await app.inject({
          method: 'POST', url: '/command', payload: { clientCommandId: `wire-${i}`, tx: i + 1 },
        });
        expect(response.statusCode).toBe(200);
        expectJsonSafePublicCommand(response.json().command);
        if (i === 0) {
          const exactRetry = await app.inject({
            method: 'POST', url: '/command', payload: { clientCommandId: 'wire-0', tx: 1 },
          });
          expect(exactRetry.statusCode).toBe(200);
          expect(exactRetry.json()).toEqual(response.json());
          expectJsonSafePublicCommand(exactRetry.json().command);
        }
      }
      const exhausted = await app.inject({
        method: 'POST', url: '/command', payload: { clientCommandId: 'wire-4', tx: 5 },
      });
      expect(exhausted.statusCode).toBe(422);
      expect(exhausted.json().message).toMatch(/not enough highlander/);

      const live = await app.inject({ method: 'GET', url: '/live' });
      expect(live.statusCode).toBe(200);
      expect(live.json().commands).toHaveLength(4);
      live.json().commands.forEach(expectJsonSafePublicCommand);
    } finally {
      await app.close();
    }
  });

  it('releases a reservation that never crosses the first-deploy boundary', async () => {
    const f = await liveFixture();
    const beforeKeep = (await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance;
    const stagedBuff = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'abandoned-buff',
      { kind: 'buff', payload: { buff: 'warhorn' } }, f.t0,
    );
    expect(stagedBuff).toMatchObject({ sequence: 0, serverOffsetMs: 0 });
    expect((await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance)
      .toBe(beforeKeep - BigInt(BUFFS.warhorn.costKeep));
    const recovered = await recoverNeverStartedLiveRaids(
      db, new Date(f.t0.getTime() + 30_001), f.defenderBase.id,
    );
    expect(recovered).toEqual({ released: 1, raced: 0 });
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.baseId, f.defenderBase.id))).toHaveLength(0);
    const [expired] = await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id));
    expect(expired?.status).toBe('expired');
    expect((await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance)
      .toBe(beforeKeep);
  });

  it('starts only on first deploy, breaks only the attacking deed shield, and hydrates defender', async () => {
    const f = await liveFixture(undefined, 2, 2);
    await db.insert(shields).values({
      playerWallet: f.attacker.wallet,
      baseId: f.attackerBase.id,
      source: 'loss',
      expiresAt: new Date(f.t0.getTime() + 3_600_000),
    });
    const stagedBuff = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'buff-before-start',
      { kind: 'buff', payload: { buff: 'warhorn' } }, f.t0,
    );
    expect(stagedBuff).toMatchObject({ sequence: 0, serverOffsetMs: 0 });
    expect(await db.select().from(shields)
      .where(eq(shields.baseId, f.attackerBase.id))).toHaveLength(1);
    expect((await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id)))[0]).toMatchObject({
      armedAt: null, startedAt: null, lastSequence: 0,
    });

    const deployedAt = new Date(f.t0.getTime() + 1_250);
    const accepted = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'deploy-1',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 2 } }, deployedAt,
    );
    expect(accepted).toMatchObject({ sequence: 1, serverOffsetMs: 0 });
    expectJsonSafePublicCommand(accepted);
    expect(await db.select().from(shields)
      .where(eq(shields.baseId, f.attackerBase.id))).toHaveLength(0);
    const [live] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    expect(live).toMatchObject({ startedAt: deployedAt, lastSequence: 1 });
    expect(live!.battleEndsAt!.getTime() - deployedAt.getTime()).toBe(90_000);
    const [lock] = await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.baseId, f.defenderBase.id));
    expect(lock!.state).toBe('live');

    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'buff-1',
      { kind: 'buff', payload: { buff: 'swiftboots' } },
      new Date(deployedAt.getTime() + 750),
    )).rejects.toMatchObject({ code: 'RAID_BUFF_ALREADY_STARTED' });
    expect(await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'buff-before-start',
      { kind: 'buff', payload: { buff: 'warhorn' } },
      new Date(deployedAt.getTime() + 80_000),
    )).toEqual(stagedBuff);
    const view = await getLiveRaidCommands(db, f.defender.wallet, f.raid.id, -1);
    expect(view).toMatchObject({
      protocolVersion: 2,
      seed: 7,
      simVersion: SIM_VERSION,
      status: 'pending_orders',
      snapshot: f.raid.snapshot,
      armySnapshot: f.raid.armySnapshot,
    });
    expect(view.commands.map((command) => ({
      sequence: command.sequence, kind: command.kind, t: command.serverOffsetMs,
    }))).toEqual([
      { sequence: 0, kind: 'buff', t: 0 },
      { sequence: 1, kind: 'deploy', t: 0 },
    ]);
    view.commands.forEach(expectJsonSafePublicCommand);
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it('deduplicates exact retries, rejects id reuse and enforces the frozen roster', async () => {
    const f = await liveFixture();
    const command = { kind: 'deploy' as const, payload: { troop: 'highlander' as const, tx: 1, ty: 1 } };
    const first = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'same-command', command, f.t0,
    );
    const retry = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'same-command', command, new Date(f.t0.getTime() + 500),
    );
    expectJsonSafePublicCommand(first);
    expectJsonSafePublicCommand(retry);
    expect(retry.sequence).toBe(first.sequence);
    expect(retry.serverOffsetMs).toBe(first.serverOffsetMs);
    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'same-command',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 2, ty: 1 } }, f.t0,
    )).rejects.toMatchObject({ code: 'RAID_COMMAND_MISMATCH' });
    await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'second-unit',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 2, ty: 1 } }, f.t0,
    );
    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'third-unit',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 3, ty: 1 } }, f.t0,
    )).rejects.toThrow(/not enough highlander/);
  });

  it('closes into server-stamped deterministic orders and refuses later commands', async () => {
    const f = await liveFixture();
    await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'deploy-vex',
      { kind: 'hero', payload: { hero: 'vex', tx: 4, ty: 5 } }, f.t0,
    );
    await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'rally',
      { kind: 'rally', payload: { tx: 6, ty: 7 } }, new Date(f.t0.getTime() + 2_000),
    );
    const orders = await closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(f.t0.getTime() + 3_000),
    );
    expect(orders).toMatchObject({
      deploys: [],
      heroDeploys: [{ hero: 'vex', tx: 4, ty: 5, tMs: 0 }],
      rally: { tx: 6, ty: 7, tMs: 2_000 },
      idempotencyKey: `live-finish:${f.raid.id}`,
    });
    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'too-late',
      { kind: 'buff', payload: { buff: 'swiftboots' } }, new Date(f.t0.getTime() + 4_000),
    )).rejects.toThrow(/closed/);
  });

  it('keeps participant history immutable but never lets a former owner command the buyer deed', async () => {
    const f = await liveFixture();
    const buyer = await createTestPlayer(db);
    // This represents an externally observed conveyance that older code could
    // apply while a raid was pending. Normal service transfers are now refused
    // until terminal, but the command boundary must remain safe for such rows.
    await db.update(bases).set({ ownerWallet: buyer.wallet })
      .where(eq(bases.id, f.attackerBase.id));

    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'seller-after-sale',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } }, f.t0,
    )).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    await expect(closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, f.t0))
      .rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    // The buyer owns the deed, not the historical attacker identity, so it may
    // watch inherited history but cannot impersonate that participant either.
    await expect(acceptLiveRaidCommand(
      db, buyer.wallet, f.raid.id, 'buyer-impersonation',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } }, f.t0,
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serializes the authority check with a transfer before appending a command', async () => {
    const f = await liveFixture();
    const buyer = await createTestPlayer(db);
    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const transfer = db.transaction(async (tx) => {
      await tx.select({ id: bases.id }).from(bases)
        .where(eq(bases.id, f.attackerBase.id)).for('update');
      locked();
      await mayCommit;
      await tx.update(bases).set({ ownerWallet: buyer.wallet })
        .where(eq(bases.id, f.attackerBase.id));
    });
    await hasLock;
    let commandSettled = false;
    const command = acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'transfer-race-command',
      { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } }, f.t0,
    ).finally(() => { commandSettled = true; });
    // Without SELECT ... FOR UPDATE on the attacking base this command commits
    // while the transfer transaction holds the ownership row.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commandSettled).toBe(false);
    release();
    await transfer;
    await expect(command).rejects.toMatchObject({ code: 'DEED_OWNERSHIP_CHANGED' });
    expect(await db.select().from(raidCommands).where(and(
      eq(raidCommands.raidId, f.raid.id),
      eq(raidCommands.clientCommandId, 'transfer-race-command'),
    ))).toHaveLength(0);
  });

  it('revalidates defender ownership inside the locked private-stream read', async () => {
    const f = await liveFixture(new Date());
    await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'start-for-defender-transfer', drop(1, 1), f.t0,
    );
    const buyer = await createTestPlayer(db);
    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const transfer = db.transaction(async (tx) => {
      await tx.select({ id: bases.id }).from(bases)
        .where(eq(bases.id, f.defenderBase.id)).for('update');
      locked();
      await mayCommit;
      await tx.update(bases).set({ ownerWallet: buyer.wallet })
        .where(eq(bases.id, f.defenderBase.id));
    });
    await hasLock;
    let readSettled = false;
    const read = getLiveRaidCommands(db, f.defender.wallet, f.raid.id)
      .finally(() => { readSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readSettled).toBe(false);
    release();
    await transfer;
    await expect(read).rejects.toMatchObject({ statusCode: 404 });
  });

  it('allows only one concurrent raid reservation against a defender deed', async () => {
    const f = await liveFixture();
    const other = await createTestPlayer(db);
    const [otherBase] = await db.insert(bases).values({
      ownerWallet: other.wallet, status: 'active', keepLevel: 1,
    }).returning();
    const [otherRaid] = await db.insert(raids).values({
      attackerWallet: other.wallet,
      attackerBaseId: otherBase!.id,
      defenderWallet: f.defender.wallet,
      defenderBaseId: f.defenderBase.id,
      seed: 8n,
      snapshot: {},
      armySnapshot: {},
      simVersion: SIM_VERSION,
      ordersDeadlineAt: new Date(f.t0.getTime() + 120_000),
    }).returning();
    await expect(initializeLiveRaid(
      db, otherRaid!.id, f.defenderBase.id, otherRaid!.ordersDeadlineAt, f.t0,
    )).rejects.toMatchObject({ code: 'BASE_ALREADY_UNDER_RAID' });
  });
});

/**
 * D-099 "raids finish without the client": a batch raid journals each order as
 * it is placed so the worker can settle the raid when the client never posts
 * its final list. The journal shares the live stream's table, dedupe and
 * close path. V1 keeps client offsets; V2 stages pre-ATTACK input at zero and
 * then follows the same authoritative piecewise clock as live PvP.
 */
describe.sequential('batch raid journal (D-099)', () => {
  it('refunds a buff-only journal exactly once when the ordinary batch expiry claims it', async () => {
    const f = await batchFixture();
    const before = (await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance;
    await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'expiring-buff',
      { kind: 'buff', payload: { buff: 'warhorn' } }, f.t0,
    );
    expect((await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance)
      .toBe(before - BigInt(BUFFS.warhorn.costKeep));

    const afterDeadline = new Date(batchOrdersSubmitDeadlineAt(f.raid.ordersDeadlineAt).getTime() + 1);
    await getRaidEnergy(db, f.attacker.wallet, afterDeadline);
    expect((await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id)))[0]?.status).toBe('expired');
    expect((await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance)
      .toBe(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey,
      `raid:${f.raid.id}:live-buff-refund:warhorn`,
    ))).toHaveLength(1);

    // WHY: expiry can be reached from several energy reads. The conditional
    // raid claim and refund ledger key must make every later sweep a no-op.
    await getRaidEnergy(db, f.attacker.wallet, new Date(afterDeadline.getTime() + 1));
    expect((await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance)
      .toBe(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey,
      `raid:${f.raid.id}:live-buff-refund:warhorn`,
    ))).toHaveLength(1);
  });

  it('journals client-stamped orders without a defender deed, a lock or a shield break', async () => {
    const f = await batchFixture();
    await db.insert(shields).values({
      playerWallet: f.attacker.wallet,
      source: 'loss',
      expiresAt: new Date(f.t0.getTime() + 3_600_000),
    });
    // WHY: timeless SIM13 buffs are staged before the first unit. A modifier
    // alone is still not an attack and is refunded if the journal expires.
    const stagedBuff = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'buff-first',
      { kind: 'buff', payload: { buff: 'warhorn' } }, f.t0,
    );
    expect(stagedBuff).toMatchObject({ sequence: 0, serverOffsetMs: 0 });
    expect((await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id)))[0]).toMatchObject({
      armedAt: null, startedAt: null, lastSequence: 0,
    });

    const first = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'drop-1', drop(1, 2, 0), new Date(f.t0.getTime() + 12_000),
    );
    // WHY: the client owns the batch battle clock, so the stamp IS its offset —
    // not the 12 s that passed on the server — or the worker's replay would
    // land every unit somewhere else than the fight the player watched.
    expect(first).toMatchObject({ sequence: 1, serverOffsetMs: 0 });
    expectJsonSafePublicCommand(first);
    const [live] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    // The journal opens at creation and closes on the batch POST deadline, so
    // the worker never settles a raid its client could still legally post.
    expect(live).toMatchObject({ mode: 'batch', startedAt: f.t0, lastSequence: 1 });
    expect(live!.battleEndsAt).toEqual(batchOrdersSubmitDeadlineAt(f.raid.ordersDeadlineAt));
    expect(live!.battleEndsAt!.getTime() - f.t0.getTime()).toBe(130_000);
    // Nothing is reserved and nothing is attacked yet: no defender lock, and the
    // shield breaks at settlement exactly as the whole-list POST always did.
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, f.raid.id))).toHaveLength(0);
    expect(await db.select().from(shields)
      .where(eq(shields.playerWallet, f.attacker.wallet))).toHaveLength(1);

    const second = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'drop-2', drop(2, 2, 5_000), new Date(f.t0.getTime() + 60_000),
    );
    expect(second).toMatchObject({ sequence: 2, serverOffsetMs: 5_000 });
    // An exact retry is the same accepted row, never a second unit.
    const retry = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'drop-2', drop(2, 2, 5_000), new Date(f.t0.getTime() + 61_000),
    );
    expect(retry).toEqual(second);
    const [after] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    // The clock is stamped once; later orders only advance the cursor.
    expect(after).toMatchObject({ startedAt: f.t0, battleEndsAt: live!.battleEndsAt, lastSequence: 2 });
    const orders = await closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(f.t0.getTime() + 70_000),
    );
    expect(orders).toMatchObject({
      deploys: [
        { troop: 'highlander', tx: 1, ty: 2, tMs: 0 },
        { troop: 'highlander', tx: 2, ty: 2, tMs: 5_000 },
      ],
      buffs: { warhorn: true },
      idempotencyKey: `live-finish:${f.raid.id}`,
    });
  });

  it('accepts a batch-journal reserve stamped after a wall-clock gap and closes at the TRUE clock end (D-106)', async () => {
    // WHY (ferdblabla 2026-09-04, "when those troops died it immediate end
    // the raid"): a client that keeps the field open after its first wave
    // died journals the next unit at its real battle offset long after the
    // last accepted row, and posts FINISH only at the true clock end — ATTACK
    // at the latest deploy second (+30 s) + 90 s clock + the 1 s verdict tail
    // = +121 s. A gap with nobody alive is not a closed stream: the journal
    // must accept that row and that close inside the 130 s batch tail.
    const f = await batchFixture();
    const first = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'wave-1', drop(1, 2, 0), new Date(f.t0.getTime() + 20_000),
    );
    expect(first).toMatchObject({ sequence: 0, serverOffsetMs: 0 });
    const reserve = await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'wave-2', drop(2, 2, 60_000), new Date(f.t0.getTime() + 90_000),
    );
    expect(reserve).toMatchObject({ sequence: 1, serverOffsetMs: 60_000 });
    const trueEndWallMs = (RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec) * 1_000 + 1_000;
    expect(trueEndWallMs).toBeLessThan(
      (RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec + RAID_RULES.batchOrdersGraceSec) * 1_000,
    );
    const orders = await closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(f.t0.getTime() + trueEndWallMs),
    );
    expect(orders).toMatchObject({
      deploys: [
        { troop: 'highlander', tx: 1, ty: 2, tMs: 0 },
        { troop: 'highlander', tx: 2, ty: 2, tMs: 60_000 },
      ],
      idempotencyKey: `live-finish:${f.raid.id}`,
    });
  });

  it('preserves v1 clients that journal selected buffs after prebattle units at ATTACK', async () => {
    const f = await batchFixture();
    const before = (await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance;
    await acceptLiveRaidCommand(db, f.attacker.wallet, f.raid.id, 'legacy-unit',
      drop(1, 1, 0), new Date(f.t0.getTime() + 1_000));
    const body = { kind: 'buff' as const, payload: { buff: 'warhorn' as const } };
    const receipt = await acceptLiveRaidCommand(db, f.attacker.wallet, f.raid.id,
      'legacy-buff-at-attack', body, new Date(f.t0.getTime() + 5_000));
    expect(await acceptLiveRaidCommand(db, f.attacker.wallet, f.raid.id,
      'legacy-buff-at-attack', body, new Date(f.t0.getTime() + 6_000))).toEqual(receipt);
    expect((await getOrCreatePlayerAccount(db, f.attacker.wallet, 'player_keep')).balance)
      .toBe(before - BigInt(BUFFS.warhorn.costKeep));
    expect(await closeLiveRaidStream(db, f.attacker.wallet, f.raid.id,
      new Date(f.t0.getTime() + 7_000))).toMatchObject({
      deploys: [{ troop: 'highlander', tx: 1, ty: 1, tMs: 0 }],
      buffs: { warhorn: true },
    });
    expect((await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id)))[0]!.commandProtocolVersion).toBe(1);
  });

  it('bounds the client offset to the battle and refuses it on a live stream', async () => {
    // WHY: a journaled offset is replayed verbatim by the simulator, so the
    // server must fence it to a legal deploy time; and a live stream must never
    // let a client backdate a unit — its server stamp is the only clock there.
    const f = await batchFixture();
    for (const tMs of [-1, RAID_RULES.battleDurationSec * 1_000 + 1, 1.5]) {
      await expect(acceptLiveRaidCommand(
        db, f.attacker.wallet, f.raid.id, `bad-${tMs}`, drop(1, 1, tMs), f.t0,
      )).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'no-offset', drop(1, 1), f.t0,
    )).rejects.toThrow(/battle offset/);
    expect(await db.select().from(raidCommands)
      .where(eq(raidCommands.raidId, f.raid.id))).toHaveLength(0);
    const [untouched] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    expect(untouched?.startedAt).toBeNull();

    const live = await liveFixture();
    await expect(acceptLiveRaidCommand(
      db, live.attacker.wallet, live.raid.id, 'stamped', drop(1, 1, 0), live.t0,
    )).rejects.toThrow(/stamped by the server/);
  });

  it('refuses journal writes after the batch deadline and leaves an empty journal to the ordinary expiry', async () => {
    const f = await batchFixture();
    // WHY: the 30 s first-deploy sweep releases live RESERVATIONS. An empty
    // batch journal reserved nothing — it keeps the whole deploy window plus
    // tail and expires/refunds through expireStaleRaids exactly as today.
    await recoverNeverStartedLiveRaids(db, new Date(f.t0.getTime() + 30_001));
    expect((await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id)))[0]!.status).toBe('pending_orders');

    const deadline = batchOrdersSubmitDeadlineAt(f.raid.ordersDeadlineAt);
    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'too-late-first', drop(1, 1, 0), deadline,
    )).rejects.toThrow(/battle clock has ended/);
    const [stillEmpty] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    expect(stillEmpty?.startedAt).toBeNull();

    await acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'in-time', drop(1, 1, 0), new Date(deadline.getTime() - 1),
    );
    await expect(acceptLiveRaidCommand(
      db, f.attacker.wallet, f.raid.id, 'too-late', drop(2, 2, 1_000), deadline,
    )).rejects.toThrow(/battle clock has ended/);
  });

  it('stores the journal mode with a live default and rejects any other mode', async () => {
    // WHY: migration 0099 adds the column to rows that predate it; every one of
    // those is a stable PvP stream, so the default must read as 'live'.
    const live = await liveFixture();
    expect((await db.select({ mode: raidLiveStates.mode }).from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, live.raid.id)))[0]!.mode).toBe('live');
    const batch = await batchFixture();
    expect((await db.select({ mode: raidLiveStates.mode }).from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, batch.raid.id)))[0]!.mode).toBe('batch');
    await expect(db.update(raidLiveStates).set({ mode: 'replay' })
      .where(eq(raidLiveStates.raidId, batch.raid.id)))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'raid_live_states_mode_ck' } });
  });
});

describe.sequential('authoritative raid clock protocol v2', () => {
  it('treats an armed V2 batch as irreversible before ATTACK for rollout fencing', async () => {
    const f = await batchFixture(undefined, 2, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'armed-before-start', drop(1, 1),
      new Date(f.t0.getTime() + 1_000),
    );
    const [armed] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    expect(armed).toMatchObject({ commandProtocolVersion: 2, startedAt: null });
    expect(armed?.armedAt).not.toBeNull();

    await expect(assertNoIncompatibleStartedLiveRaids(db, SIM_VERSION + 1))
      .rejects.toThrow(/started unresolved raid/);
    await expect(compensatePendingRaid(db, f.raid, false)).resolves.toBe(false);
    expect((await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id)))[0]?.status).toBe('pending_orders');
  });

  it('never lets a V2 batch fall back to a client-authored whole-list submission', async () => {
    const t0 = new Date('2026-09-04T09:30:00.000Z');
    const f = await batchFixture(t0, 2, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'canonical-unit', drop(1, 1),
      new Date(t0.getTime() + 1_000),
    );
    await expect(submitOrders(db, f.attacker.wallet, f.raid.id, {
      deploys: [{ troop: 'highlander', tx: 9, ty: 9, tMs: 89_000 }],
      idempotencyKey: 'forged-whole-list',
    }, new Date(t0.getTime() + 2_000))).rejects.toMatchObject({
      code: 'RAID_LIVE_STREAM_REQUIRED',
    });
    expect(await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id))).toEqual([{ status: 'pending_orders' }]);
    expect(await db.select({ count: army.count }).from(army)
      .where(eq(army.playerWallet, f.attacker.wallet))).toEqual([{ count: 2 }]);
  });

  it('samples production command time after the clock-row lock', async () => {
    const f = await liveFixture(new Date(), 1, 2);
    let locked!: () => void;
    let release!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select({ raidId: raidLiveStates.raidId }).from(raidLiveStates)
        .where(eq(raidLiveStates.raidId, f.raid.id)).for('update');
      locked();
      await mayCommit;
      return raidTransactionWallNow(tx);
    });
    await hasLock;
    const accepted = acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'after-lock', drop(1, 1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const releasedAt = await blocker;
    expect((await accepted).command.acceptedAt.getTime())
      .toBeGreaterThanOrEqual(releasedAt.getTime());
  });

  it.each([1, 2] as const)('closes a proven full destruction at its actual tick on a %sx clock, without waiting for the horn', async (rate) => {
    // The reported Stage 6 finished combat at 44s but waited for a 90s horn.
    // Keep the real simulator here: neither a future prediction nor a client
    // percentage may close the journal before that destruction actually happens.
    const t0 = new Date('2026-09-05T12:00:00.000Z');
    const f = await batchFixture(t0, 3, 2, true);
    const snapshot = { ...(f.raid.snapshot as BaseSnapshot), buildings: [
      { id: 'keep', type: BuildingType.Keep, level: 1, tx: 8, ty: 8 },
    ] };
    await db.update(raids).set({ snapshot }).where(eq(raids.id, f.raid.id));
    await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'unit', drop(7, 8), t0);
    await startLiveRaid(db, f.attacker.wallet, f.raid.id, 'start', 0, t0);
    if (rate === 2) await setLiveRaidSpeed(db, f.attacker.wallet, f.raid.id, 'fast', 1, 2, true, t0);
    const expected = simulateRaid(snapshot, {
      deploys: [{ troop: 'highlander', tx: 7, ty: 8, tMs: 0 }],
    }, 7, { troopLevels: { highlander: 1 } });
    const endMs = expected.ticks * (RAID_RULES.battleDurationSec * 1_000 / MAX_TICKS);
    expect(expected.destructionPct).toBe(100);
    expect(endMs).toBeGreaterThan(0);
    expect(endMs).toBeLessThan(RAID_RULES.battleDurationSec * 1_000);
    await expect(closeLiveRaidStream(db, f.attacker.wallet, f.raid.id,
      new Date(t0.getTime() + Math.ceil(endMs / rate) - 1)))
      .rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
    const now = new Date(t0.getTime() + Math.ceil(endMs / rate));
    const closed = await Promise.all([
      closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, now),
      closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, now, true),
    ]);
    expect(closed[0]).toEqual(closed[1]);
    expect(closed[0]!.deploys).toHaveLength(1); // unused reserves are not orders
    await expect(acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id,
      'too-late', drop(7, 9), now)).rejects.toThrow();
    const resolutions = await Promise.allSettled(closed.map((orders) =>
      submitOrders(db, f.attacker.wallet, f.raid.id, orders, now, true)));
    const successes = resolutions.filter((result) => result.status === 'fulfilled');
    expect(successes).toHaveLength(1);
    const settled = successes[0]!.value;
    expect(settled.result.destructionPct).toBe(100);
    await expect(submitOrders(db, f.attacker.wallet, f.raid.id, closed[1]!, now, true))
      .rejects.toThrow(/already resolved/); // existing retry contract: recover archived verdict
    const [resolved] = await db.select().from(raids).where(eq(raids.id, f.raid.id));
    expect(resolved!.result).toEqual(settled.result);
    const [troops] = await db.select().from(army).where(eq(army.playerWallet, f.attacker.wallet));
    expect(troops!.count).toBe(2); // API/worker retry never consumes the reserves
  });

  it('retains heavy proof admission after NOT_DUE and reuses a successful proof without a second cooldown or SIM', async () => {
    const t0 = new Date('2026-09-05T12:00:00.000Z');
    const count = RAID_REPLAY_LIMITS.heavySimulationAboveActors + 1;
    const f = await batchFixture(t0, count + 1, 2, true);
    const snapshot: BaseSnapshot = { ...(f.raid.snapshot as BaseSnapshot), buildings: [
      { id: 'keep', type: BuildingType.Keep, level: 1, tx: 8, ty: 8 },
    ] };
    await db.update(raids).set({ snapshot }).where(eq(raids.id, f.raid.id));
    for (let i = 0; i < count; i++) {
      await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, `unit-${i}`, drop(7, 8), t0);
    }
    await startLiveRaid(db, f.attacker.wallet, f.raid.id, 'start', 0, t0);
    await expect(closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 1)))
      .rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
    const [admitted] = await db.select().from(players).where(eq(players.wallet, f.attacker.wallet));
    expect(admitted!.raidSimulationAdmittedAt).toBeInstanceOf(Date);
    await expect(closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 10_000)))
      .rejects.toMatchObject({ code: 'RAID_SIMULATION_COOLDOWN' });
    const [live] = await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id));
    expect(live!.streamClosedAt).toBeNull();
    // Advance only the durable CPU cooldown, never the canonical battle clock.
    await db.update(players).set({ raidSimulationAdmittedAt: new Date(
      Date.now() - (RAID_REPLAY_LIMITS.simulationWalletCooldownSec + 1) * 1_000,
    ) }).where(eq(players.wallet, f.attacker.wallet));
    const closed = await closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 10_000));
    const [proofAdmission] = await db.select().from(players).where(eq(players.wallet, f.attacker.wallet));
    const settled = await submitOrders(db, f.attacker.wallet, f.raid.id, closed, new Date(t0.getTime() + 10_000), true);
    expect(settled.result.destructionPct).toBe(100);
    const [after] = await db.select().from(players).where(eq(players.wallet, f.attacker.wallet));
    expect(after!.raidSimulationAdmittedAt).toEqual(proofAdmission!.raidSimulationAdmittedAt);
    const [reserve] = await db.select().from(army).where(eq(army.playerWallet, f.attacker.wallet));
    expect(reserve!.count).toBe(1);
  });

  it('keeps a defeated partial stream open for reserves without changing commands or inventory', async () => {
    const t0 = new Date('2026-09-05T12:00:00.000Z');
    const f = await batchFixture(t0, 3, 2, true);
    const snapshot = { ...(f.raid.snapshot as BaseSnapshot), buildings: [
      { id: 'keep', type: BuildingType.Keep, level: 20, tx: 14, ty: 14 },
      { id: 'tower', type: BuildingType.ArcherTower, level: 20, tx: 8, ty: 8 },
    ] };
    await db.update(raids).set({ snapshot }).where(eq(raids.id, f.raid.id));
    await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'unit', drop(7, 8), t0);
    await startLiveRaid(db, f.attacker.wallet, f.raid.id, 'start', 0, t0);
    const outcome = simulateRaid(snapshot, { deploys: [
      { troop: 'highlander', tx: 7, ty: 8, tMs: 0 },
    ] }, 7, { troopLevels: { highlander: 1 } });
    expect(outcome.destructionPct).toBeLessThan(100);
    expect(outcome.ticks).toBeLessThan(MAX_TICKS / 2);
    const before = await db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id));
    await expect(closeLiveRaidStream(db, f.attacker.wallet, f.raid.id,
      new Date(t0.getTime() + RAID_RULES.battleDurationSec * 1_000 / 2)))
      .rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
    const [live] = await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id));
    expect(live!.streamClosedAt).toBeNull();
    expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id))).toEqual(before);
    const [remaining] = await db.select().from(army).where(eq(army.playerWallet, f.attacker.wallet));
    expect(remaining!.count).toBe(3);
    await expect(acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id,
      'reserve', drop(7, 9), new Date(t0.getTime() + 46_000))).resolves.toBeDefined();
  });

  it('does not let a forward process clock make production recovery settle early', async () => {
    const future = new Date(Date.now() + (RAID_RULES.deployWindowSec - 10) * 1_000);
    const f = await liveFixture(future, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'future-start', drop(1, 1), future,
    );
    await expect(closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, undefined, true,
    )).rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
  });

  it('keeps database anchor constraints pinned to the shared battle duration', () => {
    const maxMs = RAID_RULES.battleDurationSec * 1_000;
    const schema = readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8');
    const migration = readFileSync(
      new URL('../drizzle/0102_live_raid_clock.sql', import.meta.url), 'utf8',
    );
    for (const source of [schema, migration]) {
      expect(source).toContain(`BETWEEN 0 AND ${maxMs}`);
    }
  });

  it('uses a clamped integer clock at both anchor boundaries', () => {
    expect(raidSimAtWallMs(999, 1_000, 12_345, 2)).toBe(12_345);
    expect(raidSimAtWallMs(1_001, 1_000, 12_345, 2)).toBe(12_347);
    expect(raidSimAtWallMs(100_000, 1_000, 89_999, 2)).toBe(90_000);
  });

  it('starts stable PvP on its first unit and preserves time across 1x -> 2x -> 1x', async () => {
    const t0 = new Date(Date.now() + (RAID_RULES.deployWindowSec - 10) * 1_000);
    const f = await liveFixture(t0, 2, 2);
    const first = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'first', drop(1, 1), new Date(t0.getTime() + 1_000),
    );
    expect(first.clock).toMatchObject({ protocolVersion: 2, revision: 1, rate: 1, simNowMs: 0 });

    await expect(setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'disabled-fast', 1, 2, false,
      new Date(t0.getTime() + 10_000),
    )).rejects.toMatchObject({ code: 'LIVE_RAID_V2_DISABLED' });

    const fast = await setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'fast', 1, 2, true,
      new Date(t0.getTime() + 11_000),
    );
    expect(fast.clock).toMatchObject({ revision: 2, rate: 2, anchorSimMs: 10_000 });
    expect(fast.clock.battleEndsAt?.getTime()).toBe(t0.getTime() + 51_000);

    const normal = await setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'normal', 2, 1, false,
      new Date(t0.getTime() + 16_000),
    );
    expect(normal.clock).toMatchObject({ revision: 3, rate: 1, anchorSimMs: 20_000 });
    expect(normal.clock.battleEndsAt?.getTime()).toBe(t0.getTime() + 86_000);
    const [lock] = await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, f.raid.id));
    expect(lock!.expiresAt.getTime()).toBe(
      normal.clock.battleEndsAt!.getTime() + LIVE_RAID.recoveryGraceSec * 1_000,
    );

    const same = await setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'same', 3, 1, false,
      new Date(t0.getTime() + 17_000),
    );
    expect(same.clock.revision).toBe(3);
    await expect(setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'stale', 2, 1, false,
      new Date(t0.getTime() + 18_000),
    )).rejects.toMatchObject({ code: 'RAID_CLOCK_STALE', clock: { revision: 3 } });

    // WHY: a lost response is replayed before current CAS/deadline checks.
    expect(await setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'fast', 1, 2, false,
      new Date(t0.getTime() + 200_000),
    )).toEqual(fast);
    await expect(setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'fast', 999, 1, false,
      new Date(t0.getTime() + 200_000),
    )).rejects.toMatchObject({ code: 'RAID_COMMAND_MISMATCH' });
    await expect(closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 52_000), true,
    )).rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
  });

  it('serializes two speed writers with clock-revision compare-and-swap', async () => {
    const t0 = new Date(Date.now() + (RAID_RULES.deployWindowSec - 10) * 1_000);
    const f = await liveFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'unit', drop(1, 1), t0,
    );
    const wallNow = new Date(t0.getTime() + 10_000);
    const raced = await Promise.allSettled([
      setLiveRaidSpeed(
        db, f.attacker.wallet, f.raid.id, 'tab-a-fast', 1, 2, true, wallNow,
      ),
      setLiveRaidSpeed(
        db, f.attacker.wallet, f.raid.id, 'tab-b-fast', 1, 2, true, wallNow,
      ),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = raced.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected', reason: { code: 'RAID_CLOCK_STALE', clock: { revision: 2 } },
    });
    const [state] = await db.select({
      revision: raidLiveStates.clockRevision, rate: raidLiveStates.clockRate,
    }).from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id));
    expect(state).toEqual({ revision: 2, rate: 2 });
    expect(await db.select({ kind: raidCommands.kind }).from(raidCommands).where(and(
      eq(raidCommands.raidId, f.raid.id), eq(raidCommands.kind, 'speed'),
    ))).toHaveLength(1);
  });

  it('serializes a boundary speed change against worker close without early settlement', async () => {
    const t0 = new Date(Date.now() + (RAID_RULES.deployWindowSec - 10) * 1_000);
    const f = await liveFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'unit', drop(1, 1), t0,
    );
    const boundary = new Date(t0.getTime() + 89_000);
    const raced = await Promise.allSettled([
      setLiveRaidSpeed(
        db, f.attacker.wallet, f.raid.id, 'boundary-fast', 1, 2, true, boundary,
      ),
      closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, boundary, true),
    ]);
    // At 89s the unmodified clock is not due. If speed wins the row lock the
    // close may immediately become due at its new 89.5s deadline; otherwise it
    // must fail closed and a later worker pass settles it.
    expect(raced.some((result) => result.status === 'fulfilled')).toBe(true);
    const orders = await closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 90_000), true,
    );
    expect(orders.deploys).toEqual([{ troop: 'highlander', tx: 1, ty: 1, tMs: 0 }]);
    await expect(setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'after-close', 2, 1, false,
      new Date(t0.getTime() + 90_000),
    )).rejects.toThrow(/closed|ended/);
  });

  it('serializes finish against retreat and consumes the army exactly once', async () => {
    const t0 = new Date('2026-09-04T10:40:00.000Z');
    const f = await batchFixture(t0, 1, 2, true);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'unit', drop(1, 1), t0,
    );
    await startLiveRaid(db, f.attacker.wallet, f.raid.id, 'attack', 0, t0);
    const terminalWall = new Date(t0.getTime() + RAID_RULES.battleDurationSec * 1_000);
    const [finish, retreat] = await Promise.allSettled([
      closeLiveRaidStream(db, f.attacker.wallet, f.raid.id, terminalWall),
      retreatUnstartedLiveRaid(
        db, f.attacker.wallet, f.raid.id, 'terminal-retreat', terminalWall,
      ),
    ]);
    expect(finish.status).toBe('fulfilled');
    expect(retreat).toMatchObject({
      status: 'rejected',
      reason: { code: expect.stringMatching(/^(?:RAID_STREAM_CLOSED|RAID_CLOCK_ENDED)$/) },
    });
    const orders = finish.status === 'fulfilled' ? finish.value : undefined;
    expect(orders).toBeDefined();
    expect(orders!.retreated).toBeUndefined();
    const settled = await submitOrders(
      db, f.attacker.wallet, f.raid.id, orders!, terminalWall,
      true, false, false,
    );
    expect(settled.result.retreated).not.toBe(true);
    await expect(submitOrders(
      db, f.attacker.wallet, f.raid.id, orders!, terminalWall,
      true, false, false,
    )).rejects.toThrow(/already resolved/);
    expect(await db.select({ count: army.count }).from(army)
      .where(eq(army.playerWallet, f.attacker.wallet))).toEqual([{ count: 0 }]);
    expect(await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id))).toEqual([{ status: 'resolved' }]);
  });

  it('stages every batch-mode unit at t=0, starts explicitly, and excludes controls from SIM orders', async () => {
    const t0 = new Date('2026-09-04T11:00:00.000Z');
    const f = await batchFixture(t0, 2, 2);
    const staged = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage', drop(1, 1), new Date(t0.getTime() + 5_000),
    );
    expect(staged.command.serverOffsetMs).toBe(0);
    expect(staged.clock).toMatchObject({ revision: 0, rate: 1, anchorWallAt: null });
    await expect(acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'scaled-client-time', drop(2, 2, 1),
      new Date(t0.getTime() + 6_000),
    )).rejects.toThrow(/stamped by the server/);

    const started = await startLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'attack', 0, new Date(t0.getTime() + 10_000),
    );
    expect(started.clock).toMatchObject({ revision: 1, rate: 1, anchorSimMs: 0 });
    await expect(closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 11_000),
    )).rejects.toMatchObject({ code: 'RAID_CLOCK_NOT_DUE' });
    const orders = await closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 100_000),
    );
    expect(orders.deploys).toEqual([{ troop: 'highlander', tx: 1, ty: 1, tMs: 0 }]);
  });

  it('server-stamps V2 batch input from the piecewise clock after ATTACK, including at 2x', async () => {
    const t0 = new Date('2026-09-04T11:30:00.000Z');
    const f = await batchFixture(t0, 2, 2);
    const stagedBuff = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage-buff',
      { kind: 'buff', payload: { buff: 'warhorn' } }, new Date(t0.getTime() + 5_000),
    );
    const staged = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage-unit', drop(1, 1),
      new Date(t0.getTime() + 6_000),
    );
    expect(staged.command.serverOffsetMs).toBe(0);
    expect(stagedBuff.command.serverOffsetMs).toBe(0);

    await startLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'attack', 0, new Date(t0.getTime() + 10_000),
    );
    await setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'speed-2x', 1, 2, true,
      new Date(t0.getTime() + 20_000),
    );
    const deployed = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'live-unit', drop(2, 2),
      new Date(t0.getTime() + 25_000),
    );
    const hero = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'live-hero',
      { kind: 'hero', payload: { hero: 'vex', tx: 3, ty: 3 } },
      new Date(t0.getTime() + 26_000),
    );
    const rally = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'live-rally',
      { kind: 'rally', payload: { tx: 4, ty: 4 } },
      new Date(t0.getTime() + 27_000),
    );
    await expect(acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'live-buff',
      { kind: 'buff', payload: { buff: 'swiftboots' } },
      new Date(t0.getTime() + 28_000),
    )).rejects.toMatchObject({ code: 'RAID_BUFF_ALREADY_STARTED' });
    expect([
      deployed.command.serverOffsetMs,
      hero.command.serverOffsetMs,
      rally.command.serverOffsetMs,
    ]).toEqual([20_000, 22_000, 24_000]);

    const orders = await closeLiveRaidStream(
      db, f.attacker.wallet, f.raid.id, new Date(t0.getTime() + 60_000),
    );
    expect(orders).toEqual({
      deploys: [
        { troop: 'highlander', tx: 1, ty: 1, tMs: 0 },
        { troop: 'highlander', tx: 2, ty: 2, tMs: 20_000 },
      ],
      heroDeploys: [{ hero: 'vex', tx: 3, ty: 3, tMs: 22_000 }],
      rally: { tx: 4, ty: 4, tMs: 24_000 },
      buffs: { warhorn: true },
      idempotencyKey: `live-finish:${f.raid.id}`,
    });
  });

  it('keeps identical V1 and V2 SIM input byte-for-byte outcome compatible', async () => {
    const t0 = new Date('2026-09-04T11:40:00.000Z');
    const legacy = await batchFixture(t0, 1, 1, true);
    const current = await batchFixture(t0, 1, 2, true);
    const deploy = { troop: 'highlander' as const, tx: 1, ty: 1, tMs: 0 };
    await submitOrders(db, legacy.attacker.wallet, legacy.raid.id, {
      deploys: [deploy], idempotencyKey: 'v1-parity',
    }, new Date(t0.getTime() + 90_000));
    await acceptLiveRaidCommandReceipt(
      db, current.attacker.wallet, current.raid.id, 'v2-unit', drop(1, 1), t0,
    );
    await startLiveRaid(db, current.attacker.wallet, current.raid.id, 'v2-attack', 0, t0);
    const currentOrders = await closeLiveRaidStream(
      db, current.attacker.wallet, current.raid.id,
      new Date(t0.getTime() + RAID_RULES.battleDurationSec * 1_000),
    );
    await submitOrders(
      db, current.attacker.wallet, current.raid.id, currentOrders,
      new Date(t0.getTime() + RAID_RULES.battleDurationSec * 1_000), true,
    );
    const settled = await db.select({
      id: raids.id, orders: raids.orders, events: raids.events, result: raids.result,
    // Both IDs are explicit so unrelated fixtures cannot mask parity.
    }).from(raids).where(inArray(raids.id, [legacy.raid.id, current.raid.id]));
    const legacyRow = settled.find((row) => row.id === legacy.raid.id)!;
    const currentRow = settled.find((row) => row.id === current.raid.id)!;
    const canonicalOrders = (value: unknown) => {
      const { idempotencyKey: _idempotencyKey, ...rest } = value as Record<string, unknown>;
      return rest;
    };
    expect(canonicalOrders(currentRow.orders)).toEqual(canonicalOrders(legacyRow.orders));
    expect(currentRow.events).toEqual(legacyRow.events);
    expect(currentRow.result).toEqual(legacyRow.result);
    expect(await db.select({ count: army.count }).from(army).where(and(
      inArray(army.playerWallet, [legacy.attacker.wallet, current.attacker.wallet]),
      eq(army.troop, 'highlander'),
    )).orderBy(army.playerWallet)).toEqual([{ count: 0 }, { count: 0 }]);
  });

  it('stamps the catch-up playhead after an automatic start and rejects the exact end boundary', async () => {
    const t0 = new Date('2026-09-04T11:45:00.000Z');
    const f = await batchFixture(t0, 2, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage', drop(1, 1),
      new Date(t0.getTime() + 1_000),
    );
    const caughtUp = await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'after-cutoff', drop(2, 2),
      new Date(t0.getTime() + 45_000),
    );
    expect(caughtUp.clock).toMatchObject({ revision: 1, rate: 1, simNowMs: 15_000 });
    expect(caughtUp.command.serverOffsetMs).toBe(15_000);

    await expect(acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'at-end',
      { kind: 'rally', payload: { tx: 4, ty: 4 } },
      new Date(t0.getTime() + 120_000),
    )).rejects.toThrow(/battle clock has ended/);
  });

  it('reserves the system command namespace and isolates a poisoned recovery candidate', async () => {
    const t0 = new Date('2026-09-04T11:50:00.000Z');
    await db.update(raids).set({ status: 'expired' }).where(eq(raids.status, 'pending_orders'));
    const poisoned = await batchFixture(t0, 1, 2);
    const healthy = await batchFixture(new Date(t0.getTime() + 1), 1, 2);
    await expect(acceptLiveRaidCommandReceipt(
      db, poisoned.attacker.wallet, poisoned.raid.id, 'system:auto-start', drop(1, 1), t0,
    )).rejects.toThrow(/invalid client command id/);
    await acceptLiveRaidCommandReceipt(
      db, poisoned.attacker.wallet, poisoned.raid.id, 'stage-poisoned', drop(1, 1), t0,
    );
    await acceptLiveRaidCommandReceipt(
      db, healthy.attacker.wallet, healthy.raid.id, 'stage-healthy', drop(1, 1),
      new Date(t0.getTime() + 1),
    );
    // Simulate the only possible poison source: a row written before the
    // reserved namespace was enforced. Its unique ID/sequence may block this
    // candidate, but must never abort recovery of later raids.
    await db.insert(raidCommands).values({
      raidId: poisoned.raid.id,
      sequence: 1,
      clientCommandId: 'system:auto-start',
      kind: 'deploy',
      payload: { troop: 'highlander', tx: 1, ty: 1 },
      serverOffsetMs: 0,
      payloadHash: 'pre-rollout-poison',
      acceptedAt: t0,
    });
    expect(await autoStartDueLiveRaids(
      db, new Date(t0.getTime() + 45_000),
    )).toEqual({ started: 1, raced: 1 });
    const live = await getLiveRaidCommands(
      db, healthy.attacker.wallet, healthy.raid.id, -1, new Date(t0.getTime() + 45_000),
    );
    expect(live.startedAt).not.toBeNull();
  });

  it('auto-starts an armed batch at the fixed 30-second cutoff, not worker observation time', async () => {
    const t0 = new Date('2026-09-04T12:00:00.000Z');
    const f = await batchFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage', drop(1, 1), new Date(t0.getTime() + 1_000),
    );
    await expect(retreatUnstartedLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'stage', new Date(t0.getTime() + 1_500),
    )).rejects.toMatchObject({ code: 'RAID_COMMAND_MISMATCH' });
    await autoStartDueLiveRaids(db, new Date(t0.getTime() + 45_000), f.raid.id);
    const state = await getLiveRaidCommands(
      db, f.attacker.wallet, f.raid.id, -1, new Date(t0.getTime() + 45_000),
    );
    expect(state.clock.anchorWallAt?.getTime()).toBe(t0.getTime() + 30_000);
    expect(state.clock.simNowMs).toBe(15_000);
    expect(state.commands.map((command) => command.kind)).toEqual(['deploy', 'start']);
  });

  it('commits cutoff auto-start before returning its stale clock to ATTACK', async () => {
    const t0 = new Date('2026-09-04T12:15:00.000Z');
    const f = await batchFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'staged', drop(1, 1),
      new Date(t0.getTime() + 1_000),
    );
    await expect(startLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'late-attack', 0,
      new Date(t0.getTime() + 45_000),
    )).rejects.toMatchObject({
      code: 'RAID_CLOCK_STALE',
      clock: { revision: 1, simNowMs: 15_000 },
    });
    const [live] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    expect(live).toMatchObject({ clockRevision: 1, startedAt: expect.any(Date) });
    expect(await db.select({ kind: raidCommands.kind }).from(raidCommands).where(and(
      eq(raidCommands.raidId, f.raid.id), eq(raidCommands.clientCommandId, 'system:auto-start'),
    ))).toEqual([{ kind: 'start' }]);
  });

  it('cannot use the pre-start retreat shortcut after the automatic-start cutoff', async () => {
    const t0 = new Date('2026-09-04T12:20:00.000Z');
    const f = await batchFixture(t0, 1, 2, true);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'staged-unit', drop(1, 1),
      new Date(t0.getTime() + 1_000),
    );
    // WHY: process suspension can delay both the worker and GET /live. Retreat
    // must still persist the immutable t0+30 start before deciding economics.
    const retreat = await retreatUnstartedLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'late-retreat',
      new Date(t0.getTime() + 30_001),
    );
    expect(retreat).toMatchObject({ retreated: true, terminal: false });
    expect(retreat.orders).toMatchObject({ retreated: true });
    expect(await db.select({ kind: raidCommands.kind }).from(raidCommands)
      .where(eq(raidCommands.raidId, f.raid.id)).orderBy(raidCommands.sequence))
      .toEqual([{ kind: 'deploy' }, { kind: 'start' }, { kind: 'retreat' }]);
    const { result } = await submitOrders(
      db, f.attacker.wallet, f.raid.id, retreat.orders!,
      new Date(t0.getTime() + 30_001), true, false, true,
    );
    expect(result).toMatchObject({
      stars: 0, destructionPct: 0, lootShards: 0, retreated: true,
    });
    expect(await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id))).toEqual([{ status: 'resolved' }]);
  });

  it('never expiry-refunds an armed V2 batch after a process-length outage', async () => {
    const t0 = new Date('2026-09-04T12:30:00.000Z');
    const f = await batchFixture(t0, 1, 2, true);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage-before-kill', drop(1, 1),
      new Date(t0.getTime() + 1_000),
    );
    // This is beyond the old batch abandonment deadline (120s + 10s tail).
    // Pending reconciliation must auto-start at t0+30 rather than refund it.
    const [pending] = await getPendingRaidResumes(
      db, f.attacker.wallet, new Date(t0.getTime() + 200_000),
    );
    expect(pending).toMatchObject({
      id: f.raid.id,
      live: { clock: { anchorSimMs: 0, simNowMs: 90_000 }, startedAt: expect.any(Date) },
    });
    expect(await recoverDueStartedLiveRaids(
      db, new Date(t0.getTime() + 200_000), undefined, f.raid.id,
    )).toEqual({ resolved: 1, raced: 0 });
    expect(await db.select({ status: raids.status }).from(raids)
      .where(eq(raids.id, f.raid.id))).toEqual([{ status: 'resolved' }]);
    expect(await db.select({ count: army.count }).from(army)
      .where(eq(army.playerWallet, f.attacker.wallet))).toEqual([{ count: 0 }]);
  });

  it.each(['terminal', 'closed'] as const)('never auto-starts an armed %s raid on a later clock read', async (state) => {
    const t0 = new Date('2026-09-04T12:50:00.000Z');
    const f = await batchFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage', drop(1, 1), t0,
    );
    if (state === 'terminal') {
      await retreatUnstartedLiveRaid(db, f.attacker.wallet, f.raid.id, 'retreat',
        new Date(t0.getTime() + 1_000));
    } else {
      await db.update(raidLiveStates).set({ streamClosedAt: new Date(t0.getTime() + 1_000) })
        .where(eq(raidLiveStates.raidId, f.raid.id));
    }
    const [before] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    const commandsBefore = await db.select().from(raidCommands)
      .where(eq(raidCommands.raidId, f.raid.id));
    const later = new Date(t0.getTime() + 200_000);
    // Participant refresh is a read: it cannot revive a retired clock or add
    // an automatic start after an accepted retreat/closed command stream.
    expect((await getRaidClock(db, f.raid.id, later)).live).toEqual(before);
    expect(await autoStartDueLiveRaids(db, later, f.raid.id)).toEqual({ started: 0, raced: 0 });
    expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id)))
      .toEqual(commandsBefore);
  });

  it('accepts a terminal pre-start retreat exactly once without refunding into simulation', async () => {
    const t0 = new Date('2026-09-04T13:00:00.000Z');
    const f = await batchFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, f.attacker.wallet, f.raid.id, 'stage', drop(1, 1), new Date(t0.getTime() + 1_000),
    );
    const receipt = await retreatUnstartedLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'retreat', new Date(t0.getTime() + 2_000),
    );
    expect(receipt).toMatchObject({
      retreated: true, terminal: true, result: { stars: 0, lootShards: 0 },
    });
    expect(await retreatUnstartedLiveRaid(
      db, f.attacker.wallet, f.raid.id, 'retreat', new Date(t0.getTime() + 100_000),
    )).toEqual(receipt);
    const [resolved] = await db.select().from(raids).where(eq(raids.id, f.raid.id));
    expect(resolved).toMatchObject({
      status: 'resolved',
      orders: {
        deploys: [{ troop: 'highlander', tx: 1, ty: 1, tMs: 0 }],
        retreated: true,
      },
    });

    const reserved = await liveFixture(new Date(t0.getTime() + 500_000), 1, 2);
    await retreatUnstartedLiveRaid(
      db, reserved.attacker.wallet, reserved.raid.id, 'back-before-deploy', reserved.t0,
    );
    expect(await db.select().from(baseRaidLocks)
      .where(eq(baseRaidLocks.raidId, reserved.raid.id))).toHaveLength(0);

    const started = await batchFixture(new Date(t0.getTime() + 1_000_000), 1, 2);
    await acceptLiveRaidCommandReceipt(
      db, started.attacker.wallet, started.raid.id, 'unit', drop(1, 1), started.t0,
    );
    await startLiveRaid(db, started.attacker.wallet, started.raid.id, 'attack', 0, started.t0);
    const startedRetreat = await retreatUnstartedLiveRaid(
      db, started.attacker.wallet, started.raid.id, 'retreat', started.t0,
    );
    expect(startedRetreat).toMatchObject({ retreated: true, terminal: false });
    expect(startedRetreat.orders).toMatchObject({ retreated: true });
  });

  it('keeps legacy rows readable at 1x and refuses v2 clock controls', async () => {
    const f = await liveFixture(new Date('2026-09-04T14:00:00.000Z'));
    await acceptLiveRaidCommand(db, f.attacker.wallet, f.raid.id, 'unit', drop(1, 1), f.t0);
    const state = await getLiveRaidCommands(db, f.attacker.wallet, f.raid.id, -1, f.t0);
    expect(state.clock).toMatchObject({ protocolVersion: 1, revision: 0, rate: 1, simNowMs: 0 });
    const [legacy] = await db.select().from(raidLiveStates)
      .where(eq(raidLiveStates.raidId, f.raid.id));
    expect(legacy).toMatchObject({ clockRevision: 0, clockRate: 1, clockAnchorWallAt: null });
    await expect(db.update(raidLiveStates).set({ clockRate: 3 })
      .where(eq(raidLiveStates.raidId, f.raid.id)))
      .rejects.toMatchObject({ cause: { constraint_name: 'raid_live_states_clock_v2_range_ck' } });
    await expect(db.update(raidLiveStates).set({ clockAnchorWallAt: f.t0 })
      .where(eq(raidLiveStates.raidId, f.raid.id)))
      .rejects.toMatchObject({ cause: { constraint_name: 'raid_live_states_clock_v2_pair_ck' } });
    await expect(setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'speed', 0, 2, true, f.t0,
    )).rejects.toMatchObject({ code: 'RAID_PROTOCOL_MISMATCH' });
  });

  it('returns every current-SIM pending attacker raid even without a hero reservation', async () => {
    const t0 = new Date(Date.now() + 60_000);
    const f = await batchFixture(t0, 1, 2);
    const pending = await getPendingRaidResumes(db, f.attacker.wallet, t0);
    expect(pending).toContainEqual(expect.objectContaining({
      id: f.raid.id,
      heroReserved: false,
      raidProtocolVersion: 2,
      live: expect.objectContaining({ clock: expect.objectContaining({ protocolVersion: 2 }) }),
    }));
  });

  it('caps actual speed transitions while same-rate receipts consume no revision', async () => {
    const t0 = new Date(Date.now() + (RAID_RULES.deployWindowSec - 10) * 1_000);
    const f = await liveFixture(t0, 1, 2);
    await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'unit', drop(1, 1), t0);
    await db.insert(raidCommands).values(Array.from({ length: LIVE_RAID.speedChangeLimit }, (_, i) => ({
      raidId: f.raid.id,
      sequence: i + 1,
      clientCommandId: `prior-speed-${i}`,
      kind: 'speed',
      payload: { expectedClockRevision: i, rate: i % 2 === 0 ? 2 : 1, _changed: true },
      serverOffsetMs: i,
      payloadHash: `test-${i}`,
      acceptedAt: new Date(t0.getTime() + i),
    })));
    await db.update(raidLiveStates).set({ lastSequence: LIVE_RAID.speedChangeLimit })
      .where(eq(raidLiveStates.raidId, f.raid.id));
    await expect(setLiveRaidSpeed(
      db, f.attacker.wallet, f.raid.id, 'one-too-many', 1, 2, true,
      new Date(t0.getTime() + 1_000),
    )).rejects.toMatchObject({ code: 'RAID_SPEED_LIMIT' });
  });
});


describe('pinned simulator admission across a deployment', () => {
  it('rejects every new unit/buff/control before old unarmed state or funds can change', async () => {
    const f = await batchFixture(undefined, 2, 2);
    await db.update(raids).set({ simVersion: SIM_VERSION - 1 }).where(eq(raids.id, f.raid.id));
    const before = await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id));
    const mismatch = { statusCode: 409, code: 'RAID_SIM_VERSION_MISMATCH' };
    await expect(acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'stale-troop', drop(0, 8), f.t0)).rejects.toMatchObject(mismatch);
    await expect(acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'stale-hero', { kind: 'hero', payload: { hero: 'vex', tx: 0, ty: 8 } }, f.t0)).rejects.toMatchObject(mismatch);
    await expect(acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'stale-buff', { kind: 'buff', payload: { buff: 'warhorn' } }, f.t0)).rejects.toMatchObject(mismatch);
    await expect(startLiveRaid(db, f.attacker.wallet, f.raid.id, 'stale-start', 0, f.t0)).rejects.toMatchObject(mismatch);
    await expect(setLiveRaidSpeed(db, f.attacker.wallet, f.raid.id, 'stale-speed', 0, 2, true, f.t0)).rejects.toMatchObject(mismatch);
    await expect(retreatLiveRaid(db, f.attacker.wallet, f.raid.id, 'stale-retreat', f.t0)).rejects.toMatchObject(mismatch);
    expect(await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id))).toEqual(before);
    expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id))).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `raid:${f.raid.id}:live-buff:warhorn`))).toHaveLength(0);
  });
  it('preserves exact accepted receipts and read recovery without auto-starting an incompatible armed raid', async () => {
    const f = await batchFixture(undefined, 2, 2);
    const accepted = await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'original-troop', drop(0, 8), f.t0);
    await db.update(raids).set({ simVersion: SIM_VERSION - 1 }).where(eq(raids.id, f.raid.id));
    const before = await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id));
    const late = new Date(f.t0.getTime() + (RAID_RULES.deployWindowSec + 1) * 1000);
    expect(await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'original-troop', drop(0, 8), late)).toEqual(accepted);
    await expect(startLiveRaid(db, f.attacker.wallet, f.raid.id, 'new-start', accepted.clock.revision, late)).rejects.toMatchObject({ code: 'RAID_SIM_VERSION_MISMATCH' });
    expect((await getLiveRaidCommands(db, f.attacker.wallet, f.raid.id, -1, late)).commands).toEqual([accepted.command]);
    expect((await getRaidClock(db, f.raid.id, late)).live.startedAt).toBeNull();
    expect((await autoStartDueLiveRaids(db, late, f.raid.id)).started).toBe(0);
    expect(await db.select().from(raidLiveStates).where(eq(raidLiveStates.raidId, f.raid.id))).toEqual(before);
    expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id))).toHaveLength(1);
  });
  it('returns an exact lost clock-control receipt after a rollout but refuses fresh speed changes', async () => {
    const f = await batchFixture(undefined, 2, 2);
    const deployed = await acceptLiveRaidCommandReceipt(db, f.attacker.wallet, f.raid.id, 'original-troop', drop(0, 8), f.t0);
    const started = await startLiveRaid(db, f.attacker.wallet, f.raid.id, 'original-start', deployed.clock.revision, f.t0);
    await db.update(raids).set({ simVersion: SIM_VERSION - 1 }).where(eq(raids.id, f.raid.id));
    expect(await startLiveRaid(db, f.attacker.wallet, f.raid.id, 'original-start', deployed.clock.revision, f.t0)).toEqual(started);
    await expect(setLiveRaidSpeed(db, f.attacker.wallet, f.raid.id, 'new-speed', started.clock.revision, 2, true, f.t0)).rejects.toMatchObject({ code: 'RAID_SIM_VERSION_MISMATCH' });
    expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, f.raid.id))).toHaveLength(2);
  });
});
