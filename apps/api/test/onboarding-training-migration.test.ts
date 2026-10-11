import { readFileSync } from 'node:fs';
import { QUESTS } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { baseQuestProgress, bases, baseSlots, ledgerTransactions, quests } from '../src/db/schema';
import { ensureQuests, getQuestBoard } from '../src/game/quests';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const migration = readFileSync(new URL('../drizzle/0106_onboarding_training.sql', import.meta.url), 'utf8');
afterAll(async () => { await conn.sql.end(); });

describe.sequential('training-chain compatibility migration', () => {
  it('preserves progressed bases without a payout while new and merely completed Barracks remain claimable', async () => {
    await ensureQuests(db, '2030-01-01');
    const [barracks] = await db.select().from(quests).where(and(eq(quests.scope, 'onboarding'), eq(quests.templateCode, 'first_barracks')));
    const [land] = await db.select().from(quests).where(and(eq(quests.scope, 'onboarding'), eq(quests.templateCode, 'first_land')));
    const [troops] = await db.select().from(quests).where(and(eq(quests.scope, 'onboarding'), eq(quests.templateCode, 'first_troops')));
    const p = await createTestPlayer(db);
    const baseRows = await db.insert(bases).values([
      { ownerWallet: p.wallet, status: 'active' }, // claimed barracks
      { ownerWallet: p.wallet, status: 'active' }, // completed only
      { ownerWallet: p.wallet, status: 'active', landPaidAt: new Date() },
      { ownerWallet: p.wallet, status: 'active' }, // later quest progress
      { ownerWallet: p.wallet, status: 'active' }, // genuinely new
    ]).returning();
    await db.insert(baseSlots).values(baseRows.map((base, index) => ({ wallet: p.wallet, baseId: base.id, slot: index + 1 })));
    await db.insert(baseQuestProgress).values([
      { baseId: baseRows[0]!.id, questId: barracks!.id, progress: 1, completedAt: new Date(), claimedAt: new Date() },
      { baseId: baseRows[1]!.id, questId: barracks!.id, progress: 1, completedAt: new Date() },
      { baseId: baseRows[3]!.id, questId: land!.id, progress: 1, completedAt: new Date() },
    ]);
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions);
    for (const statement of migration.split('--> statement-breakpoint')) await db.execute(sql.raw(statement));
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions);
    expect(after).toEqual(before);
    const target = QUESTS.onboardingTemplates.find((q) => q.id === 'first_troops')!;
    expect(troops).toMatchObject({ target: target.target, rewardKeep: BigInt(target.rewardShards) });
    for (const index of [0, 2, 3]) {
      const [progress] = await db.select().from(baseQuestProgress).where(and(eq(baseQuestProgress.baseId, baseRows[index]!.id), eq(baseQuestProgress.questId, troops!.id)));
      expect(progress!.progress).toBe(target.target);
      expect(progress!.completedAt).not.toBeNull();
      expect(progress!.claimedAt).not.toBeNull();
    }
    for (const index of [1, 4]) {
      const board = await getQuestBoard(db, p.wallet, new Date(), baseRows[index]!.id);
      expect(board.quests.find((q) => q.templateCode === 'first_troops')).toMatchObject({ progress: 0, completed: false, claimed: false });
    }
    // Reapplying the data operation cannot create rewards or duplicate rows.
    const first = await db.select().from(baseQuestProgress).where(eq(baseQuestProgress.questId, troops!.id)).orderBy(baseQuestProgress.id);
    for (const statement of migration.split('--> statement-breakpoint')) await db.execute(sql.raw(statement));
    expect(await db.select().from(baseQuestProgress).where(eq(baseQuestProgress.questId, troops!.id)).orderBy(baseQuestProgress.id)).toEqual(first);
  });
});
