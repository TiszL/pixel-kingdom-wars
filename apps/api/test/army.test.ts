import { trainSpeedup, trainTroop } from './training-consent';
/**
 * Army speedups (⚡ FINISH: research + whole-training-queue) — real KEEP sinks,
 * so the money checklist applies: priced ONLY by the shared speedupCostKeep
 * from server-side remaining time, charged player_keep → emission_pool in one
 * transaction with the completion, idempotent, and every edge refuses WITHOUT
 * charging.
 */
import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { BuildingType, ECONOMY, speedupCostKeep, TRAINING_CANCELLATION, TROOP_LEVELING, TROOPS } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  army, buildings, ledgerEntries, ledgerTransactions, players, questProgress,
  quests, trainingQueue, troopResearch, troopUnlocks,
} from '../src/db/schema';
import {
  cancelTraining, completeDueTraining, getArmyState, researchSpeedup,
  researchTroop, quoteTraining,
} from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, InsufficientFundsError } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `army-test-${++key}-${Math.random().toString(36).slice(2)}`;

/** Player with a starting base, funds, and a COMPLETED Forge (inserted with no
 *  build job, which is how completedBuildingsOf counts a building as built). */
async function freshPlayer({ keep = 100_000n, shards = 100_000n, forgeLevel = 2 } = {}) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  if (keep > 0n) await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  if (shards > 0n) await rewardShards(db, p.wallet, shards, 'test.fund.shards', k());
  await db.insert(buildings).values({ playerWallet: p.wallet, type: BuildingType.Forge, level: forgeLevel, tx: 11, ty: 8 });
  return p;
}

/** freshPlayer + a COMPLETED Barracks and Camp so trainTroop admission passes
 *  (the starting base is Keep-only; inserted with no build job like the Forge). */
async function armyPlayer(opts: { keep?: bigint; campLevel?: number } = {}) {
  const p = await freshPlayer({ keep: opts.keep ?? 100_000n });
  await db.insert(buildings).values([
    { playerWallet: p.wallet, type: BuildingType.Barracks, level: 5, tx: 14, ty: 8 },
    { playerWallet: p.wallet, type: BuildingType.Camp, level: opts.campLevel ?? 3, tx: 17, ty: 8 },
  ]);
  return p;
}

const pendingQueue = async (wallet: string) =>
  db.select().from(trainingQueue).where(and(
    eq(trainingQueue.playerWallet, wallet),
    isNull(trainingQueue.completedAt),
  )).orderBy(trainingQueue.finishesAt);

const keepBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
const shardBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;

const dailyQuestProgress = async (wallet: string, day: string, templateCode: string) => {
  const [row] = await db.select({ progress: questProgress.progress })
    .from(questProgress)
    .innerJoin(quests, eq(quests.id, questProgress.questId))
    .where(and(
      eq(questProgress.playerWallet, wallet),
      eq(quests.scope, 'daily'),
      eq(quests.activeOn, day),
      eq(quests.templateCode, templateCode),
    ));
  return row?.progress ?? 0;
};

const activeResearch = async (wallet: string) => {
  const [r] = await db.select().from(troopResearch).where(and(
    eq(troopResearch.playerWallet, wallet),
    sql`${troopResearch.researchingToLevel} IS NOT NULL`,
  ));
  return r;
};

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  await conn.sql.end();
});

describe('SIM6 dark roster admission', () => {
  it('defaults the expand/activate gate off across reads, training and research without any debit', async () => {
    const previous = process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    try {
      const { wallet } = await armyPlayer();
      expect((await getArmyState(db, wallet)).features.darkAttackerRoster).toEqual({
        enabled: false, code: 'coming_soon', message: 'COMING SOON',
      });
      const before = await shardBalance(wallet);
      for (const troop of ['gloamfang', 'hexbarrow', 'direwyvern'] as const) {
        await expect(trainTroop(db, wallet, troop, k())).rejects
          .toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
        await expect(researchTroop(db, wallet, troop, k())).rejects
          .toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
      }
      expect(await shardBalance(wallet)).toBe(before);
      expect(await pendingQueue(wallet)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
      else process.env['DARK_ATTACKER_ROSTER_ENABLED'] = previous;
    }
  });

  it('when explicitly activated, enforces the ELITE ITEM gate before debit then queues exact cost/duration', async () => {
    // REWRITTEN 2026-08-16 (D-058): the owner replaced the dark troops'
    // requiresKeepLevel gates with unlock-ITEM gates ("dragon only can be
    // dropped from gold forge, same for wyvern and rest of other way unlocked
    // troops"). The rule this pins: without a troop_unlocks row training
    // refuses BEFORE any debit; with one it queues at exact cost/duration.
    const previous = process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'true';
    try {
    for (const troop of ['gloamfang', 'hexbarrow', 'direwyvern'] as const) {
      const { wallet } = await armyPlayer();
      const stats = TROOPS[troop];
      const before = await shardBalance(wallet);
      await expect(trainTroop(db, wallet, troop, k())).rejects
        .toMatchObject({ statusCode: 422, code: 'TROOP_ITEM_LOCKED' });
      expect(await shardBalance(wallet)).toBe(before);
      expect(await pendingQueue(wallet)).toHaveLength(0);

      await db.insert(troopUnlocks).values({ playerWallet: wallet, troop, source: 'item' });
      const now = new Date();
      const queued = await trainTroop(db, wallet, troop, k(), now);
      expect(await shardBalance(wallet)).toBe(before - BigInt(stats.costKeep));
      expect(queued.finishesAt.getTime() - now.getTime()).toBe(stats.trainSec * 1_000);
    }
    } finally {
      if (previous === undefined) delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
      else process.env['DARK_ATTACKER_ROSTER_ENABLED'] = previous;
    }
  });

  it('rejects every spawn-only/defender-only actor from both training and research without writing rows', async () => {
    const { wallet } = await armyPlayer();
    const before = await shardBalance(wallet);
    for (const troop of ['barrowling', 'wyrmling'] as const) {
      await expect(trainTroop(db, wallet, troop, k())).rejects.toThrow(/spawn-only|defender-only/);
      await expect(researchTroop(db, wallet, troop, k())).rejects.toThrow(/spawn-only|defender-only/);
    }
    expect(await shardBalance(wallet)).toBe(before);
    expect(await pendingQueue(wallet)).toHaveLength(0);
    expect(await db.select().from(troopResearch).where(eq(troopResearch.playerWallet, wallet)))
      .toHaveLength(0);
  });

  it('serializes distinct training keys so concurrent calls cannot overfill camps or overcharge', async () => {
    const { wallet } = await armyPlayer({ campLevel: 1 }); // 20 points
    const before = await shardBalance(wallet);
    const now = new Date();
    const quote = await quoteTraining(db, wallet, [{ troop: 'giant', count: 1 }], now);
    const raced = await Promise.allSettled(Array.from({ length: 4 }, () =>
      trainTroop(db, wallet, 'giant', k(), now, undefined, quote.consent, quote.costShards)));
    // One accepted purchase changes the lane; the other clients must reconfirm.
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((r) => r.status === 'rejected')).toHaveLength(3);
    await trainTroop(db, wallet, 'giant', k(), now); // fresh consent: 14/20 points
    await expect(trainTroop(db, wallet, 'giant', k(), now)).rejects.toThrow(/camp/i);
    expect(await pendingQueue(wallet)).toHaveLength(2);
    expect(before - await shardBalance(wallet)).toBe(BigInt(TROOPS.giant.costKeep * 2));
  });

  it('serializes the one-research lane and charges exactly one concurrent request', async () => {
    const { wallet } = await freshPlayer({ forgeLevel: 2 });
    const before = await shardBalance(wallet);
    const raced = await Promise.allSettled([
      researchTroop(db, wallet, 'giant', k()),
      researchTroop(db, wallet, 'bowman', k()),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await db.select().from(troopResearch).where(and(
      eq(troopResearch.playerWallet, wallet),
      sql`${troopResearch.researchingToLevel} IS NOT NULL`,
    ))).toHaveLength(1);
    expect(before - await shardBalance(wallet))
      .toBe(BigInt(TROOP_LEVELING.researchCostKeep[0]!));
  });

  it('gate rollback rejects paid dark training/research speedups before KEEP debit', async () => {
    const previous = process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'true';
    try {
      // D-058: dark troops are now item-gated — seed the consumed-writ unlock
      // rows the way /items/use would have written them.
      const training = await armyPlayer({ campLevel: 3 });
      await db.insert(troopUnlocks).values({ playerWallet: training.wallet, troop: 'hexbarrow', source: 'item' });
      await trainTroop(db, training.wallet, 'hexbarrow', k());
      const research = await freshPlayer({ forgeLevel: 2 });
      await db.insert(troopUnlocks).values({ playerWallet: research.wallet, troop: 'gloamfang', source: 'item' });
      await researchTroop(db, research.wallet, 'gloamfang', k());

      process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'false';
      const trainingKeep = await keepBalance(training.wallet);
      const researchKeep = await keepBalance(research.wallet);
      await expect(trainSpeedup(db, training.wallet, k())).rejects
        .toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
      await expect(researchSpeedup(db, research.wallet, 'gloamfang', k())).rejects
        .toMatchObject({ statusCode: 409, code: 'TROOP_ROSTER_INACTIVE' });
      expect(await keepBalance(training.wallet)).toBe(trainingKeep);
      expect(await keepBalance(research.wallet)).toBe(researchKeep);
      expect(await pendingQueue(training.wallet)).toHaveLength(1);
      expect((await activeResearch(research.wallet))?.researchingToLevel).toBe(2);
    } finally {
      if (previous === undefined) delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
      else process.env['DARK_ATTACKER_ROSTER_ENABLED'] = previous;
    }
  });
});

describe('refundable v2 troop training', () => {
  it('enforces the durable wallet budget, leaves a rejected row untouched, and permits replay at cap', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const first = await trainTroop(db, wallet, 'bowman', k(), now);
    const second = await trainTroop(db, wallet, 'bowman', k(), now);
    const afterDebits = await shardBalance(wallet);
    const day = now.toISOString().slice(0, 10);
    await db.update(players).set({
      trainingCancelDay: day,
      trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
    }).where(eq(players.wallet, wallet));

    const cancelKey = k();
    await cancelTraining(db, wallet, first.id, cancelKey, now);
    const afterOne = await shardBalance(wallet);
    const ledgerAfterOne = await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.type, 'army.train.cancel'),
    );
    await expect(cancelTraining(db, wallet, second.id, k(), now)).rejects
      .toMatchObject({ statusCode: 429, code: 'TRAINING_CANCEL_RATE_LIMITED' });

    expect(await shardBalance(wallet)).toBe(afterOne);
    expect(afterOne).toBe(afterDebits + BigInt(TROOPS.bowman.costKeep));
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.type, 'army.train.cancel'),
    )).toHaveLength(ledgerAfterOne.length);
    expect((await db.select().from(trainingQueue).where(eq(trainingQueue.id, second.id)))[0])
      .toMatchObject({ completedAt: null, cancelledAt: null, refundLedgerTxnId: null });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({ trainingCancelDay: day, trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay });

    await expect(cancelTraining(db, wallet, first.id, cancelKey, now)).resolves
      .toMatchObject({ replayed: true });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0]!.trainingCancelCount)
      .toBe(TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay);
  });

  it('serializes two cancellations at the final wallet allowance', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const first = await trainTroop(db, wallet, 'bowman', k(), now);
    const second = await trainTroop(db, wallet, 'bowman', k(), now);
    const afterDebits = await shardBalance(wallet);
    await db.update(players).set({
      trainingCancelDay: '2026-09-01',
      trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
    }).where(eq(players.wallet, wallet));

    const raced = await Promise.allSettled([
      cancelTraining(db, wallet, first.id, k(), now),
      cancelTraining(db, wallet, second.id, k(), now),
    ]);
    expect(raced.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect(raced.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: { statusCode: 429, code: 'TRAINING_CANCEL_RATE_LIMITED' },
    });
    expect(await shardBalance(wallet)).toBe(afterDebits + BigInt(TROOPS.bowman.costKeep));
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0]!.trainingCancelCount)
      .toBe(TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay);
  });

  it('starts a fresh counter on the next UTC day', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-02T00:00:00.000Z');
    const queued = await trainTroop(db, wallet, 'bowman', k(), now);
    await db.update(players).set({
      trainingCancelDay: '2026-09-01',
      trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay,
    }).where(eq(players.wallet, wallet));

    await expect(cancelTraining(db, wallet, queued.id, k(), now)).resolves
      .toMatchObject({ replayed: false });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({ trainingCancelDay: '2026-09-02', trainingCancelCount: 1 });
  });

  it('links the exact debit, exposes the quote, and compensates it exactly once', async () => {
    const { wallet } = await armyPlayer();
    const before = await shardBalance(wallet);
    const now = new Date('2026-09-01T10:00:00.000Z');
    const queued = await trainTroop(db, wallet, 'bowman', k(), now);
    const afterTrain = await shardBalance(wallet);
    expect(before - afterTrain).toBe(BigInt(TROOPS.bowman.costKeep));

    const state = await getArmyState(db, wallet, now);
    expect(state.queue).toEqual([expect.objectContaining({
      id: queued.id, troop: 'bowman', canCancel: true,
      refundShards: String(TROOPS.bowman.costKeep),
    })]);
    const [row] = await db.select().from(trainingQueue).where(eq(trainingQueue.id, queued.id));
    const [debit] = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, row!.debitLedgerTxnId!));
    expect(debit).toMatchObject({
      type: 'army.train',
      metadata: expect.objectContaining({
        queueId: queued.id, troop: 'bowman', costShards: TROOPS.bowman.costKeep, economyVersion: 2,
      }),
    });

    const cancelKey = k();
    const first = await cancelTraining(db, wallet, queued.id, cancelKey, now);
    expect(first).toMatchObject({
      id: queued.id, troop: 'bowman', refundShards: String(TROOPS.bowman.costKeep), replayed: false,
    });
    expect(await shardBalance(wallet)).toBe(before);
    const replay = await cancelTraining(db, wallet, queued.id, cancelKey, now);
    expect(replay.replayed).toBe(true);
    expect(await shardBalance(wallet)).toBe(before);
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.idempotencyKey, `army-train-cancel:${queued.id}`),
    )).toHaveLength(1);
    const [terminal] = await db.select().from(trainingQueue).where(eq(trainingQueue.id, queued.id));
    expect(terminal).toMatchObject({ economyVersion: 2, cancelledAt: now, completedAt: now, questCreditedAt: null });
    await expect(db.update(trainingQueue).set({ questCreditedAt: now })
      .where(eq(trainingQueue.id, queued.id))).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'training_queue_state_ck' },
    });

    const [refundTxn] = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, terminal!.refundLedgerTxnId!));
    const originalMetadata = refundTxn!.metadata;
    const beforeMalformedReplay = await shardBalance(wallet);
    try {
      await db.update(ledgerTransactions).set({
        metadata: { ...(originalMetadata as Record<string, unknown>), queueId: randomUUID() },
      }).where(eq(ledgerTransactions.id, refundTxn!.id));
      await expect(cancelTraining(db, wallet, queued.id, cancelKey, now)).rejects
        .toMatchObject({ code: 'TRAINING_REFUND_INVALID' });
      expect(await shardBalance(wallet)).toBe(beforeMalformedReplay);
      expect(await db.select().from(ledgerTransactions).where(
        eq(ledgerTransactions.idempotencyKey, `army-train-cancel:${queued.id}`),
      )).toHaveLength(1);
    } finally {
      await db.update(ledgerTransactions).set({ metadata: originalMetadata })
        .where(eq(ledgerTransactions.id, refundTxn!.id));
    }
  });

  it('serializes cancel versus cancel and frees exactly one unit of queue/camp reservation', async () => {
    const { wallet } = await armyPlayer({ campLevel: 1 });
    const now = new Date('2026-09-01T10:00:00.000Z');
    const queued = await trainTroop(db, wallet, 'giant', k(), now);
    const afterDebit = await shardBalance(wallet);
    const raced = await Promise.allSettled([
      cancelTraining(db, wallet, queued.id, k(), now),
      cancelTraining(db, wallet, queued.id, k(), now),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await shardBalance(wallet)).toBe(afterDebit + BigInt(TROOPS.giant.costKeep));
    const state = await getArmyState(db, wallet, now);
    expect(state.queue).toHaveLength(0);
    expect(state.queuedPts).toBe(0);
  });

  it('rolls the refund ledger and balance back if the terminal queue update fails', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const queued = await trainTroop(db, wallet, 'bowman', k(), now);
    const afterDebit = await shardBalance(wallet);
    const quotaBefore = (await db.select().from(players).where(eq(players.wallet, wallet)))[0]!;
    await conn.sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_training_cancel_terminal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL THEN
          RAISE EXCEPTION 'forced terminal update failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await conn.sql.unsafe(`
      CREATE TRIGGER test_fail_training_cancel_terminal_trigger
      BEFORE UPDATE OF cancelled_at ON training_queue
      FOR EACH ROW EXECUTE FUNCTION test_fail_training_cancel_terminal()
    `);
    try {
      await expect(cancelTraining(db, wallet, queued.id, k(), now)).rejects
        .toMatchObject({ cause: { message: 'forced terminal update failure' } });
      expect(await shardBalance(wallet)).toBe(afterDebit);
      expect(await db.select().from(ledgerTransactions).where(
        eq(ledgerTransactions.idempotencyKey, `army-train-cancel:${queued.id}`),
      )).toHaveLength(0);
      expect((await db.select().from(trainingQueue)
        .where(eq(trainingQueue.id, queued.id)))[0]).toMatchObject({
        completedAt: null, cancelledAt: null, refundLedgerTxnId: null,
      });
      expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
        .toMatchObject({
          trainingCancelDay: quotaBefore.trainingCancelDay,
          trainingCancelCount: quotaBefore.trainingCancelCount,
        });
    } finally {
      await conn.sql.unsafe('DROP TRIGGER IF EXISTS test_fail_training_cancel_terminal_trigger ON training_queue');
      await conn.sql.unsafe('DROP FUNCTION IF EXISTS test_fail_training_cancel_terminal()');
    }
  });

  it('rolls the quota and queue back when the refund ledger post fails', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const queued = await trainTroop(db, wallet, 'bowman', k(), now);
    const afterDebit = await shardBalance(wallet);
    const quotaBefore = (await db.select().from(players).where(eq(players.wallet, wallet)))[0]!;
    await conn.sql.unsafe(`
      CREATE OR REPLACE FUNCTION test_fail_training_cancel_refund() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type = 'army.train.cancel' THEN
          RAISE EXCEPTION 'forced refund post failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await conn.sql.unsafe(`
      CREATE TRIGGER test_fail_training_cancel_refund_trigger
      BEFORE INSERT ON ledger_transactions
      FOR EACH ROW EXECUTE FUNCTION test_fail_training_cancel_refund()
    `);
    try {
      await expect(cancelTraining(db, wallet, queued.id, k(), now)).rejects
        .toMatchObject({ cause: { message: 'forced refund post failure' } });
      expect(await shardBalance(wallet)).toBe(afterDebit);
      expect((await db.select().from(trainingQueue)
        .where(eq(trainingQueue.id, queued.id)))[0]).toMatchObject({
        completedAt: null, cancelledAt: null, refundLedgerTxnId: null,
      });
      expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
        .toMatchObject({
          trainingCancelDay: quotaBefore.trainingCancelDay,
          trainingCancelCount: quotaBefore.trainingCancelCount,
        });
    } finally {
      await conn.sql.unsafe('DROP TRIGGER IF EXISTS test_fail_training_cancel_refund_trigger ON ledger_transactions');
      await conn.sql.unsafe('DROP FUNCTION IF EXISTS test_fail_training_cancel_refund()');
    }
  });

  it('rejects v1 rows and malformed receipt metadata without inventing a refund', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const [legacy] = await db.insert(trainingQueue).values({
      playerWallet: wallet, troop: 'bowman', startedAt: now,
      finishesAt: new Date(now.getTime() + 60_000),
    }).returning();
    expect(legacy).toMatchObject({ economyVersion: 1 });
    expect(legacy!.questCreditedAt).toBeInstanceOf(Date);
    const beforeLegacy = await shardBalance(wallet);
    await expect(cancelTraining(db, wallet, legacy!.id, k(), now)).rejects
      .toMatchObject({ code: 'TRAINING_NOT_REFUNDABLE' });
    expect(await shardBalance(wallet)).toBe(beforeLegacy);

    const queued = await trainTroop(db, wallet, 'highlander', k(), now);
    const [row] = await db.select().from(trainingQueue).where(eq(trainingQueue.id, queued.id));
    await expect(db.update(trainingQueue).set({ questCreditedAt: now })
      .where(eq(trainingQueue.id, queued.id))).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'training_queue_state_ck' },
    });
    await db.update(ledgerTransactions).set({
      metadata: { wallet, troop: 'highlander', queueId: '00000000-0000-4000-8000-000000000000', costShards: TROOPS.highlander.costKeep, economyVersion: 2 },
    }).where(eq(ledgerTransactions.id, row!.debitLedgerTxnId!));
    const beforeMalformed = await shardBalance(wallet);
    const quotaBeforeMalformed = (await db.select().from(players)
      .where(eq(players.wallet, wallet)))[0]!;
    await expect(cancelTraining(db, wallet, queued.id, k(), now)).rejects
      .toMatchObject({ code: 'TRAINING_RECEIPT_INVALID' });
    expect(await shardBalance(wallet)).toBe(beforeMalformed);
    expect((await db.select().from(trainingQueue).where(eq(trainingQueue.id, queued.id)))[0]!.completedAt).toBeNull();
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({
        trainingCancelDay: quotaBeforeMalformed.trainingCancelDay,
        trainingCancelCount: quotaBeforeMalformed.trainingCancelCount,
      });
  });

  it('refuses reuse of one client key for another row in the same wallet', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const first = await trainTroop(db, wallet, 'bowman', k(), now);
    const second = await trainTroop(db, wallet, 'bowman', k(), now);
    const cancelKey = k();
    await cancelTraining(db, wallet, first.id, cancelKey, now);
    const before = await shardBalance(wallet);
    await expect(cancelTraining(db, wallet, second.id, cancelKey, now)).rejects
      .toMatchObject({ code: 'TRAINING_CANCEL_KEY_REUSED' });
    expect(await shardBalance(wallet)).toBe(before);
  });

  it('reconciles an old-binary v2 completion once and never credits a cancelled row', async () => {
    const { wallet } = await armyPlayer();
    const t0 = new Date('2026-09-01T10:00:00.000Z');
    const queued = await trainTroop(db, wallet, 'bowman', k(), t0);
    // Simulate rollback to an old binary: it knows only completed_at + army.
    await db.update(trainingQueue).set({ completedAt: new Date(t0.getTime() + 1_000) })
      .where(eq(trainingQueue.id, queued.id));
    await db.insert(army).values({ playerWallet: wallet, troop: 'bowman', count: 1 })
      .onConflictDoUpdate({
        target: [army.playerWallet, army.troop],
        set: { count: sql`${army.count} + 1` },
      });
    const firstRead = new Date(t0.getTime() + 2_000);
    await getArmyState(db, wallet, firstRead);
    const [reconciled] = await db.select().from(trainingQueue).where(eq(trainingQueue.id, queued.id));
    expect(reconciled!.questCreditedAt).toEqual(firstRead);
    await getArmyState(db, wallet, new Date(t0.getTime() + 3_000));
    expect((await db.select().from(trainingQueue).where(eq(trainingQueue.id, queued.id)))[0]!.questCreditedAt)
      .toEqual(firstRead);

    const cancelled = await trainTroop(db, wallet, 'bowman', k(), t0);
    await cancelTraining(db, wallet, cancelled.id, k(), t0);
    await getArmyState(db, wallet, new Date(t0.getTime() + 4_000));
    expect((await db.select().from(trainingQueue).where(eq(trainingQueue.id, cancelled.id)))[0]!.questCreditedAt)
      .toBeNull();

    const future = await trainTroop(db, wallet, 'bowman', k(), t0);
    // Simulate a rolling migration that taught PostgreSQL/new code one enum
    // member before this rollback binary learned its stats.
    await conn.sql.unsafe("ALTER TYPE troop_type ADD VALUE IF NOT EXISTS 'future_v3_troop'");
    await conn.sql.unsafe(
      'UPDATE training_queue SET troop = $1, completed_at = $2 WHERE id = $3',
      ['future_v3_troop', new Date(t0.getTime() + 1_000).toISOString(), future.id],
    );
    await conn.sql.unsafe(
      'INSERT INTO army (player_wallet, troop, count) VALUES ($1, $2, 1)',
      [wallet, 'future_v3_troop'],
    );
    const rollbackRead = await getArmyState(db, wallet, new Date(t0.getTime() + 5_000));
    expect(rollbackRead.unsupportedTroops).toContain('future_v3_troop');
    expect((await db.select().from(trainingQueue).where(eq(trainingQueue.id, future.id)))[0]!.questCreditedAt)
      .toBeNull();
  });

  it('attributes lazy natural completion to finishesAt across a UTC day boundary', async () => {
    const { wallet } = await armyPlayer();
    const readyAt = new Date('2026-09-01T23:59:30.000Z');
    const queuedAt = new Date(readyAt.getTime() - TROOPS.bowman.trainSec * 1_000);
    await trainTroop(db, wallet, 'bowman', k(), queuedAt);

    await getArmyState(db, wallet, new Date('2026-09-02T00:01:00.000Z'));

    expect(await dailyQuestProgress(wallet, '2026-09-01', 'train_5_troops')).toBe(1);
    expect(await dailyQuestProgress(wallet, '2026-09-02', 'train_5_troops')).toBe(0);
  });

  it('attributes a paid early finish to its actual speed-up day', async () => {
    const { wallet } = await armyPlayer();
    const queuedAt = new Date('2026-09-01T23:59:55.000Z');
    const spedUpAt = new Date('2026-09-01T23:59:57.000Z');
    const queued = await trainTroop(db, wallet, 'bowman', k(), queuedAt);
    expect(queued.finishesAt.toISOString().slice(0, 10)).toBe('2026-09-02');

    await trainSpeedup(db, wallet, k(), spedUpAt);

    expect(await dailyQuestProgress(wallet, '2026-09-01', 'train_5_troops')).toBe(1);
    expect(await dailyQuestProgress(wallet, '2026-09-02', 'train_5_troops')).toBe(0);
  });

  it('serializes cancellation against paid completion with one terminal economy result', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const beforeShards = await shardBalance(wallet);
    const beforeKeep = await keepBalance(wallet);
    const queued = await trainTroop(db, wallet, 'bowman', k(), now);
    const raced = await Promise.allSettled([
      cancelTraining(db, wallet, queued.id, k(), now),
      trainSpeedup(db, wallet, k(), now),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const state = await getArmyState(db, wallet, now);
    const cancelled = state.counts.bowman === 0;
    expect(state.queue).toHaveLength(0);
    expect(await shardBalance(wallet)).toBe(cancelled
      ? beforeShards
      : beforeShards - BigInt(TROOPS.bowman.costKeep));
    expect(await keepBalance(wallet)).toBe(cancelled
      ? beforeKeep
      : beforeKeep - BigInt(speedupCostKeep(TROOPS.bowman.trainSec)));
  });

  it('settles a naturally due row before cancellation and never refunds the completed troop', async () => {
    const { wallet } = await armyPlayer();
    const queuedAt = new Date('2026-09-01T10:00:00.000Z');
    const before = await shardBalance(wallet);
    const queued = await trainTroop(db, wallet, 'bowman', k(), queuedAt);
    const raced = await Promise.allSettled([
      cancelTraining(db, wallet, queued.id, k(), queued.finishesAt),
      completeDueTraining(db, wallet, queued.finishesAt),
    ]);
    expect(raced[0]).toMatchObject({ status: 'rejected', reason: { code: 'TRAINING_NOT_ACTIVE' } });
    expect(raced[1]).toMatchObject({ status: 'fulfilled' });
    expect(await shardBalance(wallet)).toBe(before - BigInt(TROOPS.bowman.costKeep));
    expect((await getArmyState(db, wallet, queued.finishesAt)).counts.bowman).toBe(1);
    expect(await db.select().from(ledgerTransactions).where(
      eq(ledgerTransactions.idempotencyKey, `army-train-cancel:${queued.id}`),
    )).toHaveLength(0);
  });

  it('requires fresh consent when cancellation removes the quoted tail before lock acquisition', async () => {
    const { wallet } = await armyPlayer();
    const now = new Date('2026-09-01T10:00:00.000Z');
    const beforeShards = await shardBalance(wallet);
    const beforeKeep = await keepBalance(wallet);
    await trainTroop(db, wallet, 'plunderer', k(), now);
    const tail = await trainTroop(db, wallet, 'giant', k(), now);

    const consent = (await getArmyState(db, wallet, now)).finishAllQuote;
    // Pause the second outer transaction call: #1 is the lazy-completion
    // reconciliation; #2 is the paid speed-up. With the old implementation,
    // the queue/tail had already been read before #2. The fixed implementation
    // reads only inside #2, after this cancellation finishes.
    let transactionCalls = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredPaidTransaction = new Promise<void>((resolve) => { entered = resolve; });
    const releasePaidTransaction = new Promise<void>((resolve) => { release = resolve; });
    const gatedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: unknown[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) {
              entered();
              await releasePaidTransaction;
            }
            return (target.transaction as (...inner: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof db;
    const speeding = trainSpeedup(gatedDb, wallet, k(), now, undefined, consent);
    await enteredPaidTransaction;
    try {
      await cancelTraining(db, wallet, tail.id, k(), now);
    } finally {
      release();
    }
    await expect(speeding).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    expect(await keepBalance(wallet)).toBe(beforeKeep);
    const speedup = await trainSpeedup(db, wallet, k(), now); // explicit refreshed confirmation

    const state = await getArmyState(db, wallet, now);
    expect(speedup.cost).toBe(BigInt(speedupCostKeep(TROOPS.plunderer.trainSec)));
    expect(state.counts).toMatchObject({ plunderer: 1, giant: 0 });
    expect(await shardBalance(wallet)).toBe(beforeShards - BigInt(TROOPS.plunderer.costKeep));
    expect(await keepBalance(wallet)).toBe(beforeKeep - speedup.cost);
    expect(state.queue).toHaveLength(0);
  });
});

describe('researchSpeedup — the money checklist', () => {
  it('charges the SHARED super-linear cost from remaining time, player_keep → emission_pool, and the level lands immediately', async () => {
    const { wallet } = await freshPlayer();
    await researchTroop(db, wallet, 'giant', k()); // L1→2, legal under Forge L2

    const now = new Date();
    const row = (await activeResearch(wallet))!;
    const remSec = Math.max(0, Math.ceil((row.finishesAt!.getTime() - now.getTime()) / 1000));
    // MUTATION CHECK (cost call): at ~2h remaining the quadratic term is non-zero,
    // so a linear-only local formula computes a DIFFERENT number — replacing the
    // shared helper with `u × rate` inside researchSpeedup fails the delta below.
    const linearOnly = Math.ceil(remSec / ECONOMY.speedupGranularitySec) * ECONOMY.speedupKeepPer30Sec;
    expect(speedupCostKeep(remSec)).not.toBe(linearOnly);

    const before = await keepBalance(wallet);
    const myKey = k();
    const res = await researchSpeedup(db, wallet, 'giant', myKey, now);
    expect(res).toEqual({ cost: BigInt(speedupCostKeep(remSec)), troop: 'giant', toLevel: 2 });
    expect(before - await keepBalance(wallet)).toBe(res.cost);

    // The exact double entry: debit the player, credit emission_pool 100% — KEEP
    // RECYCLES, never burns (ECONOMY.md §4b). Keyed to OUR namespaced txn so the
    // shared test DB cannot race this assertion.
    const [txn] = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `rspeedup:${wallet}:${myKey}`));
    expect(txn?.type).toBe('research.speedup');
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, txn!.id));
    const sys = await bootstrapSystemAccounts(db);
    const playerAcct = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.accountId === playerAcct.id)?.delta).toBe(-res.cost);
    expect(entries.find((e) => e.accountId === sys.emission_pool)?.delta).toBe(res.cost);

    // Completion is visible on the very next read — no lazy wait.
    const state = await getArmyState(db, wallet, now);
    expect(state.levels.giant).toBe(2);
    expect(state.research).toHaveLength(0);
  });

  it('no active research → clean 404, never a charge, and never STARTS one', async () => {
    // WHY: speedup may only COMPLETE a research that researchTroop legally
    // created — it must not be a second door past the Forge/one-at-a-time gates.
    const { wallet } = await freshPlayer();
    const before = await keepBalance(wallet);
    await expect(researchSpeedup(db, wallet, 'giant', k())).rejects.toThrow(/no research in progress/);
    expect(await keepBalance(wallet)).toBe(before);
    expect((await getArmyState(db, wallet)).levels.giant).toBe(1); // nothing minted
  });

  it('troop mismatch → 409, no charge, the running research untouched', async () => {
    // WHY the troop param exists at all (concurrentResearch=1 makes it redundant):
    // the price is remaining-time-shaped, so completing a DIFFERENT row than the
    // one the client labelled could charge far more than the player agreed to.
    const { wallet } = await freshPlayer();
    await researchTroop(db, wallet, 'giant', k());
    const rowBefore = (await activeResearch(wallet))!;
    const before = await keepBalance(wallet);
    await expect(researchSpeedup(db, wallet, 'bowman', k())).rejects.toThrow(/no longer active/);
    expect(await keepBalance(wallet)).toBe(before);
    const rowAfter = (await activeResearch(wallet))!;
    expect(rowAfter.researchingToLevel).toBe(2);
    expect(rowAfter.finishesAt!.getTime()).toBe(rowBefore.finishesAt!.getTime());
  });

  it('insufficient KEEP → InsufficientFundsError surfaces, research untouched, no partial charge', async () => {
    const { wallet } = await freshPlayer({ keep: 0n }); // shards fund the research itself
    await researchTroop(db, wallet, 'giant', k());
    const rowBefore = (await activeResearch(wallet))!;
    await expect(researchSpeedup(db, wallet, 'giant', k())).rejects.toThrow(InsufficientFundsError);
    // The one-transaction shape (E3): a failed charge leaves NOTHING half-done.
    expect(await keepBalance(wallet)).toBe(0n);
    const rowAfter = (await activeResearch(wallet))!;
    expect(rowAfter.researchingToLevel).toBe(2);
    expect(rowAfter.finishesAt!.getTime()).toBe(rowBefore.finishesAt!.getTime());
    expect((await getArmyState(db, wallet)).levels.giant).toBe(1);
  });

  it('a replayed idempotency key charges ONCE and can never instant-finish a LATER research for free', async () => {
    // MUTATION CHECK (idempotency): remove the `posted.duplicate` 409 gate in
    // researchSpeedup and the replay below completes the →3 research for free —
    // the levels/`research` asserts fail.
    const { wallet } = await freshPlayer({ forgeLevel: 3 });
    const sharedKey = k();
    await researchTroop(db, wallet, 'giant', k()); // →2
    await researchSpeedup(db, wallet, 'giant', sharedKey); // pays once
    const afterFirst = await keepBalance(wallet);

    // Straight replay after completion: nothing active → clean 4xx, no charge.
    await expect(researchSpeedup(db, wallet, 'giant', sharedKey)).rejects.toThrow(/no research in progress/);
    expect(await keepBalance(wallet)).toBe(afterFirst);

    // The attack the duplicate gate blocks (security review 2026-07-24 #5):
    // start the NEXT research, replay the already-PAID key. The ledger posts
    // nothing (duplicate), so the completion must not happen either.
    await researchTroop(db, wallet, 'giant', k()); // →3, legal under Forge L3
    await expect(researchSpeedup(db, wallet, 'giant', sharedKey)).rejects.toThrow(/duplicate speedup/);
    // researchTroop charges SHARDS, so KEEP still shows exactly ONE speedup charge.
    expect(await keepBalance(wallet)).toBe(afterFirst);
    const state = await getArmyState(db, wallet);
    expect(state.levels.giant).toBe(2); // →3 NOT granted for free
    expect(state.research).toHaveLength(1); // still running, untouched
  });

  it('a research already past its finish time free-completes (lazy rule) — never a paid completion', async () => {
    // Pinned behaviour: army mutations settle due work first (the module-wide
    // completeDueTraining convention), so a due row costs NOTHING — the analogue
    // of speedupJob's no-charge refusal of an already-completed job.
    const { wallet } = await freshPlayer();
    await researchTroop(db, wallet, 'giant', k());
    const row = (await activeResearch(wallet))!;
    const later = new Date(row.finishesAt!.getTime() + 1_000);
    const before = await keepBalance(wallet);
    await expect(researchSpeedup(db, wallet, 'giant', k(), later)).rejects.toThrow(/no research in progress/);
    expect(await keepBalance(wallet)).toBe(before); // the elapsed timer is free
    expect((await getArmyState(db, wallet, later)).levels.giant).toBe(2); // and the level landed
  });

  it('cannot bypass the Forge gate: when →next is refused by the Forge, speedup has nothing to complete', async () => {
    const { wallet } = await freshPlayer({ forgeLevel: 2 });
    await researchTroop(db, wallet, 'giant', k());
    await researchSpeedup(db, wallet, 'giant', k()); // giant hits L2, the Forge cap
    await expect(researchTroop(db, wallet, 'giant', k())).rejects.toThrow(/requires Forge level 3/);
    await expect(researchSpeedup(db, wallet, 'giant', k())).rejects.toThrow(/no research in progress/);
    expect((await getArmyState(db, wallet)).levels.giant).toBe(2); // capped, not 3
  });
});

describe('trainSpeedup — the money checklist (whole-queue ⚡ FINISH, owner F1)', () => {
  it('charges the SHARED super-linear cost of the LAST row\'s remaining time and the whole queue lands at once', async () => {
    const { wallet } = await armyPlayer();
    const t0 = new Date();
    const first = await trainTroop(db, wallet, 'plunderer', k(), t0);
    const second = await trainTroop(db, wallet, 'plunderer', k(), t0);
    const last = await trainTroop(db, wallet, 'giant', k(), t0);
    // Grandfathered concurrent promises retain their original price curve.
    for (const [id, seconds] of [[first.id, 60], [second.id, 60], [last.id, 300]] as const) {
      await db.update(trainingQueue).set({ scheduleVersion: 1, startedAt: t0, finishesAt: new Date(t0.getTime() + seconds * 1000) })
        .where(eq(trainingQueue.id, id));
    }

    // MUTATION CHECKS (cost call): the constants make these three mutants
    // distinguishable at 300s remaining, so the exact-cost assert below kills
    // (a) a linear-only local formula, (b) pricing off the HEAD row, and
    // (c) pricing off the SUM of per-row remainders instead of the last finish.
    const linearOnly = Math.ceil(300 / ECONOMY.speedupGranularitySec) * ECONOMY.speedupKeepPer30Sec;
    expect(speedupCostKeep(300)).not.toBe(linearOnly);
    expect(speedupCostKeep(300)).not.toBe(speedupCostKeep(60));       // head row
    expect(speedupCostKeep(300)).not.toBe(speedupCostKeep(60 + 60 + 300)); // sum of rows

    const before = await keepBalance(wallet);
    const myKey = k();
    const res = await trainSpeedup(db, wallet, myKey, t0);
    expect(res.cost).toBe(BigInt(speedupCostKeep(300)));
    expect(res.completed).toEqual([{ troop: 'plunderer', count: 2 }, { troop: 'giant', count: 1 }]);
    expect(before - await keepBalance(wallet)).toBe(res.cost);

    // The exact double entry: debit the player, credit emission_pool 100% — KEEP
    // RECYCLES, never burns (ECONOMY.md §4b). Keyed to OUR namespaced txn so the
    // shared test DB cannot race this assertion.
    const [txn] = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `tspeedup:${wallet}:${myKey}`));
    expect(txn?.type).toBe('train.speedup');
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, txn!.id));
    const sys = await bootstrapSystemAccounts(db);
    const playerAcct = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.accountId === playerAcct.id)?.delta).toBe(-res.cost);
    expect(entries.find((e) => e.accountId === sys.emission_pool)?.delta).toBe(res.cost);

    // Completion is visible on the very next read — no lazy wait, queue empty.
    const state = await getArmyState(db, wallet, t0);
    expect(state.counts.plunderer).toBe(2);
    expect(state.counts.giant).toBe(1);
    expect(state.queue).toHaveLength(0);
    expect(await pendingQueue(wallet)).toHaveLength(0);
  });

  it('empty queue → clean 404, never a charge, and never mints a troop', async () => {
    // WHY: speedup may only COMPLETE rows trainTroop legally queued (and paid
    // Shards for) — it must not be a second door past the admission gates.
    const { wallet } = await armyPlayer();
    const before = await keepBalance(wallet);
    await expect(trainSpeedup(db, wallet, k())).rejects.toThrow(/nothing is training/);
    expect(await keepBalance(wallet)).toBe(before);
    expect((await getArmyState(db, wallet)).rosterPts).toBe(0);
  });

  it('insufficient KEEP → InsufficientFundsError surfaces, queue untouched, no partial completion', async () => {
    const { wallet } = await armyPlayer({ keep: 0n }); // Shards fund the training itself
    const t0 = new Date();
    await trainTroop(db, wallet, 'giant', k(), t0);
    const [rowBefore] = await pendingQueue(wallet);
    await expect(trainSpeedup(db, wallet, k(), t0)).rejects.toThrow(InsufficientFundsError);
    // The one-transaction shape (E3): a failed charge leaves NOTHING half-done.
    expect(await keepBalance(wallet)).toBe(0n);
    const [rowAfter] = await pendingQueue(wallet);
    expect(rowAfter!.completedAt).toBeNull();
    expect(rowAfter!.finishesAt.getTime()).toBe(rowBefore!.finishesAt.getTime());
    expect((await getArmyState(db, wallet, t0)).counts.giant).toBe(0);
  });

  it('a replayed idempotency key charges ONCE and can never instant-finish a LATER queue for free', async () => {
    // MUTATION CHECK (idempotency): remove the `posted.duplicate` 409 gate in
    // trainSpeedup and the replay below completes the troll queue for free —
    // the counts/queue asserts fail.
    const { wallet } = await armyPlayer();
    const sharedKey = k();
    const t0 = new Date();
    await trainTroop(db, wallet, 'giant', k(), t0);
    await trainSpeedup(db, wallet, sharedKey, t0); // pays once
    const afterFirst = await keepBalance(wallet);

    // Straight replay after completion: nothing queued → clean 4xx, no charge.
    await expect(trainSpeedup(db, wallet, sharedKey, t0)).rejects.toThrow(/nothing is training/);
    expect(await keepBalance(wallet)).toBe(afterFirst);

    // The attack the duplicate gate blocks (security review 2026-07-24 #5):
    // queue MORE troops, replay the already-PAID key. The ledger posts nothing
    // (duplicate), so the completion must not happen either.
    await trainTroop(db, wallet, 'troll', k(), t0);
    await expect(trainSpeedup(db, wallet, sharedKey, t0)).rejects.toThrow(/duplicate speedup/);
    // trainTroop charges SHARDS, so KEEP still shows exactly ONE speedup charge.
    expect(await keepBalance(wallet)).toBe(afterFirst);
    const state = await getArmyState(db, wallet, t0);
    expect(state.counts.giant).toBe(1);
    expect(state.counts.troll).toBe(0); // NOT granted for free
    expect(state.queue).toHaveLength(1); // still training, untouched
  });

  it('due rows free-complete first (lazy rule) and only the still-running tail is priced', async () => {
    // Pinned behaviour: army mutations settle due work first (the module-wide
    // completeDueTraining convention), so an elapsed row costs NOTHING and is
    // absent from `completed` — the paid list is only what the charge finished.
    const { wallet } = await armyPlayer();
    const t0 = new Date();
    await trainTroop(db, wallet, 'plunderer', k(), t0); // 6s, completes before purchase
    await trainTroop(db, wallet, 'giant', k(), t0); // next 30s in the same lane
    const elapsed = TROOPS.plunderer.trainSec * 2;
    const remaining = TROOPS.plunderer.trainSec + TROOPS.giant.trainSec - elapsed;
    const later = new Date(t0.getTime() + elapsed * 1000);
    const before = await keepBalance(wallet);
    const res = await trainSpeedup(db, wallet, k(), later);
    expect(res.cost).toBe(BigInt(speedupCostKeep(remaining))); // giant's tail ONLY
    expect(res.completed).toEqual([{ troop: 'giant', count: 1 }]);
    expect(before - await keepBalance(wallet)).toBe(res.cost);
    const state = await getArmyState(db, wallet, later);
    expect(state.counts.plunderer).toBe(1); // landed FREE
    expect(state.counts.giant).toBe(1);     // landed paid
    expect(state.queue).toHaveLength(0);
  });

  it('a queue already past its finish free-completes entirely — clean 404, never a paid completion', async () => {
    const { wallet } = await armyPlayer();
    const t0 = new Date();
    await trainTroop(db, wallet, 'plunderer', k(), t0);
    const later = new Date(t0.getTime() + 61_000);
    const before = await keepBalance(wallet);
    await expect(trainSpeedup(db, wallet, k(), later)).rejects.toThrow(/nothing is training/);
    expect(await keepBalance(wallet)).toBe(before); // the elapsed timer is free
    expect((await getArmyState(db, wallet, later)).counts.plunderer).toBe(1); // and the troop landed
  });

  it('completion NEVER re-checks camp capacity — the paid path inherits natural completion\'s rule exactly', async () => {
    // READ-FIRST pin (owner F1 decision): natural completion
    // (completeDueTraining) credits the camp UNCONDITIONALLY — capacity is
    // reserved at ENQUEUE (trainTroop's queued+held gate) and never re-checked
    // at completion. So when a once-legal queue exceeds TODAY's capacity (camps
    // change out from under it), BOTH paths must still credit every row. If an
    // overflow rule is ever added to one path, this test forces both to move.
    const { wallet } = await armyPlayer({ campLevel: 1 }); // camp cap 20 pts
    const t0 = new Date();
    const past = new Date(t0.getTime() - 1_000);
    const future = new Date(t0.getTime() + 300_000);
    await db.insert(trainingQueue).values([ // 4 giants = 28 pts > the 20-pt camp
      { playerWallet: wallet, troop: 'giant', startedAt: past, finishesAt: past },
      { playerWallet: wallet, troop: 'giant', startedAt: past, finishesAt: past },
      { playerWallet: wallet, troop: 'giant', startedAt: past, finishesAt: future },
      { playerWallet: wallet, troop: 'giant', startedAt: past, finishesAt: future },
    ]);
    const res = await trainSpeedup(db, wallet, k(), t0);
    // Natural half: the two due rows landed via the FREE lazy rule; paid half:
    // the speedup landed the rest — past capacity, exactly as natural would.
    expect(res.completed).toEqual([{ troop: 'giant', count: 2 }]);
    const state = await getArmyState(db, wallet, t0);
    expect(state.counts.giant).toBe(4);
    expect(state.rosterPts).toBe(4 * TROOPS.giant.pts);
    expect(state.rosterPts).toBeGreaterThan(state.campCapacityPts); // overfull — by design
  });
});

describe('POST /army/research/speedup (route)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let wallet: string;

  beforeAll(async () => {
    app = await buildApp(TEST_CONFIG, db);
    await app.ready();
    const secretKey = utils.randomSecretKey();
    wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    const { message } = ch.json() as { message: string };
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    // The route sits behind requireEntryPaid; the on-chain credit is out of scope.
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, wallet));
    await ensureStartingBase(db, wallet);
    await fundTestKeep(db, wallet, 100_000n, 'test.fund', k());
    await rewardShards(db, wallet, 100_000n, 'test.fund.shards', k());
    await db.insert(buildings).values({ playerWallet: wallet, type: BuildingType.Forge, level: 2, tx: 11, ty: 8 });
  });
  afterAll(async () => {
    await app.close();
  });

  it('the price is the SERVER\'s: a client-supplied cost field is ignored and the shared cost is charged', async () => {
    await researchTroop(db, wallet, 'giant', k());
    const before = await keepBalance(wallet);
    const res = await app.inject({
      method: 'POST', url: '/army/research/speedup',
      cookies: { [SESSION_COOKIE]: cookie },
      // `cost` is NOT part of TrainBody — zod strips it; were the server ever to
      // trust it, the 1-KEEP charge below would betray it.
      payload: { troop: 'giant', idempotencyKey: k(), cost: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cost: string; troop: string; toLevel: number };
    expect(body.troop).toBe('giant');
    expect(body.toLevel).toBe(2);
    // The route computes `now` itself, so pin a RANGE off the shared helper: the
    // full L1→2 research (researchTimeSec[0]) minus up to 2 min of test runtime.
    // Both bounds are hundreds of KEEP — nowhere near the client's "1".
    const full = TROOP_LEVELING.researchTimeSec[0]!;
    expect(BigInt(body.cost)).toBeLessThanOrEqual(BigInt(speedupCostKeep(full)));
    expect(BigInt(body.cost)).toBeGreaterThanOrEqual(BigInt(speedupCostKeep(full - 2)));
    // And the ledger charged exactly what the route reported.
    expect(before - await keepBalance(wallet)).toBe(BigInt(body.cost));
    expect((await getArmyState(db, wallet)).levels.giant).toBe(2);
  });
});

describe('POST /army/train/speedup (route)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let wallet: string;

  beforeAll(async () => {
    app = await buildApp(TEST_CONFIG, db);
    await app.ready();
    const secretKey = utils.randomSecretKey();
    wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    const { message } = ch.json() as { message: string };
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    // The route sits behind requireEntryPaid; the on-chain credit is out of scope.
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, wallet));
    await ensureStartingBase(db, wallet);
    await fundTestKeep(db, wallet, 100_000n, 'test.fund', k());
    await rewardShards(db, wallet, 100_000n, 'test.fund.shards', k());
    await db.insert(buildings).values([
      { playerWallet: wallet, type: BuildingType.Barracks, level: 5, tx: 14, ty: 8 },
      { playerWallet: wallet, type: BuildingType.Camp, level: 3, tx: 17, ty: 8 },
    ]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('the price is the SERVER\'s: client-supplied cost/troop fields are ignored and the shared cost is charged', async () => {
    await trainTroop(db, wallet, 'giant', k());
    const consent = (await getArmyState(db, wallet)).finishAllQuote;
    const before = await keepBalance(wallet);
    const res = await app.inject({
      method: 'POST', url: '/army/train/speedup',
      cookies: { [SESSION_COOKIE]: cookie },
      // Neither `cost` nor `troop` is part of KeyBody — zod strips them; were
      // the server ever to trust `cost`, the 1-KEEP charge below would betray it.
      payload: { idempotencyKey: k(), cost: 1, troop: 'giant', consent },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cost: string; completed: Array<{ troop: string; count: number }> };
    expect(body.completed).toEqual([{ troop: 'giant', count: 1 }]);
    // The route computes `now` itself, so pin a RANGE off the shared helper: the
    // full giant trainSec minus bounded route latency, never the client's "1".
    const full = TROOPS.giant.trainSec;
    expect(BigInt(body.cost)).toBeLessThanOrEqual(BigInt(speedupCostKeep(full)));
    expect(BigInt(body.cost)).toBeGreaterThanOrEqual(BigInt(speedupCostKeep(full - 2)));
    // And the ledger charged exactly what the route reported.
    expect(before - await keepBalance(wallet)).toBe(BigInt(body.cost));
    expect((await getArmyState(db, wallet)).counts.giant).toBe(1);
  });

  it('cancels the exact queued UUID and returns the authoritative refund receipt', async () => {
    const before = await shardBalance(wallet);
    const queued = await trainTroop(db, wallet, 'bowman', k());
    const idempotencyKey = k();
    const res = await app.inject({
      method: 'POST', url: `/army/train/${queued.id}/cancel`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { idempotencyKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: queued.id,
      troop: 'bowman',
      refundShards: String(TROOPS.bowman.costKeep),
      replayed: false,
    });
    expect(await shardBalance(wallet)).toBe(before);

    const replay = await app.inject({
      method: 'POST', url: `/army/train/${queued.id}/cancel`,
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { idempotencyKey },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: queued.id, replayed: true });
  });
});
