/** The first army can finish without KEEP, once per wallet, without changing
 * purchases, quest claims, or the exact-queue consent boundary. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BuildingType, type TrainingFinishAllConsent } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseArmy, baseQuestProgress, baseTransfers, bases, baseSlots, buildings, ledgerTransactions, quests } from '../src/db/schema';
import { onboardingTrainingFinishes, onboardingTrainingWallets } from '../src/db/onboardingTrainingSchema';
import { cancelTraining, getArmyState, quoteTraining, trainBatch, trainSpeedup } from '../src/game/army';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { getOnboardingStep, claimQuest, progressQuestBatch } from '../src/game/quests';
import { transferStableBase } from '../src/game/baseOwnership';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
const at = new Date('2026-09-08T17:00:00.000Z');
const later = (ms: number) => new Date(at.getTime() + ms);
const prior = process.env['MULTI_BASE_ENABLED'];
beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => { if (prior === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = prior; await conn.sql.end(); });

async function fixture(wallet?: string, slot = 1) {
  wallet ??= (await createTestPlayer(db)).wallet;
  const asset = `tutorial-free-${randomUUID()}`;
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, deedAssetId: asset, deedMintAssetId: asset,
    status: 'active', keepLevel: 1, landPaidAt: at }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  await db.insert(buildings).values([
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Keep, level: 1, tx: 14, ty: 14 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Barracks, level: 1, tx: 8, ty: 8 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Camp, level: 1, tx: 18, ty: 8 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Mine, level: 1, tx: 4, ty: 4 },
  ]);
  await rewardBaseShards(db, base!.id, 10_000n, 'test.free-training', randomUUID());
  const ctx = { baseId: base!.id, assertAuthority: async () => {} };
  for (const code of ['first_camp', 'first_mine', 'first_barracks']) {
    const step = await getOnboardingStep(db, wallet, base!.id);
    expect(step?.templateCode).toBe(code);
    await claimQuest(db, wallet, step!.questId, at, ctx);
  }
  return { wallet, base: base!, ctx };
}
async function buy(f: Awaited<ReturnType<typeof fixture>>, count = 3, now = at) {
  const quote = await quoteTraining(db, f.wallet, [{ troop: 'bowman', count }], now, f.ctx);
  return trainBatch(db, f.wallet, quote.queueable, quote.costShards, randomUUID(), now, f.ctx, quote.consent);
}
async function offer(f: Awaited<ReturnType<typeof fixture>>, now = at) {
  const state = await getArmyState(db, f.wallet, now, f.base.id);
  expect(state.freeFinishAllOffer?.offer).toBe('first_troops');
  return state.freeFinishAllOffer!.consent;
}
const finish = (f: Awaited<ReturnType<typeof fixture>>, consent: TrainingFinishAllConsent, key = randomUUID(), now = at) =>
  trainSpeedup(db, f.wallet, key, now, f.ctx, consent, 'first_troops');

describe.sequential('one free first-army queue finish', () => {
  it('finishes the whole quote at zero KEEP, preserves manual claim and records no ledger transaction', async () => {
    const f = await fixture(); await buy(f, 10); const consent = await offer(f);
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions);
    const result = await finish(f, consent);
    expect(result).toEqual({ cost: 0n, completed: [{ troop: 'bowman', count: 10 }] });
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions)).toEqual(before);
    const state = await getArmyState(db, f.wallet, at, f.base.id);
    expect(state.counts.bowman).toBe(10); expect(state.queue).toEqual([]); expect(state.freeFinishAllOffer).toBeNull();
    expect(state.freeFinishAllReceipt?.completed).toEqual(result.completed);
    expect(await getOnboardingStep(db, f.wallet, f.base.id)).toMatchObject({ templateCode: 'first_troops', progress: 10, completed: false, claimed: false });
    await buy(f, 10);
    const second = await getArmyState(db, f.wallet, later(90_000), f.base.id);
    expect(second.counts.bowman).toBe(20);
    expect(await getOnboardingStep(db, f.wallet, f.base.id)).toMatchObject({ templateCode: 'first_troops', completed: true, claimed: false });
  });
  it('replays a lost response even after queue completion; reused identity cannot target a different queue', async () => {
    const f = await fixture(); await buy(f); const consent = await offer(f), key = randomUUID();
    const result = await finish(f, consent, key);
    expect(await finish(f, consent, key, later(3000))).toEqual(result);
    await buy(f, 2); const state = await getArmyState(db, f.wallet, at, f.base.id);
    await expect(finish(f, { ...state.finishAllQuote, maxCostKeep: '0' }, key)).rejects.toMatchObject({ code: 'TRAINING_FREE_FINISH_MISMATCH' });
    await expect(finish(f, consent)).rejects.toMatchObject({ code: 'TRAINING_FREE_FINISH_UNAVAILABLE' });
    expect((await getArmyState(db, f.wallet, at, f.base.id)).queue).toHaveLength(2);
    expect(await db.select().from(onboardingTrainingFinishes).where(eq(onboardingTrainingFinishes.wallet, f.wallet))).toHaveLength(1);
  });
  it('concurrent identical requests credit once; different keys cannot grant a second use', async () => {
    const f = await fixture(); await buy(f); const consent = await offer(f), key = randomUUID();
    const results = await Promise.all([finish(f, consent, key), finish(f, consent, key)]);
    expect(results[0]).toEqual(results[1]);
    expect((await getArmyState(db, f.wallet, at, f.base.id)).counts.bowman).toBe(3);
  });
  it('sibling deeds competing for the gift cannot consume it twice', async () => {
    const f = await fixture(), g = await fixture(f.wallet, 2);
    await buy(f); await buy(g);
    const a = await offer(f), b = await offer(g);
    const outcomes = await Promise.allSettled([finish(f, a), finish(g, b)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'TRAINING_FREE_FINISH_UNAVAILABLE' } });
    const states = await Promise.all([getArmyState(db, f.wallet, at, f.base.id), getArmyState(db, f.wallet, at, g.base.id)]);
    expect(states.reduce((n, state) => n + state.counts.bowman, 0)).toBe(3);
    expect(states.reduce((n, state) => n + state.queue.length, 0)).toBe(3);
  });
  it('retains historical actor holds while new transfer audits record the post-lock custody boundary', async () => {
    const f = await fixture();
    const [q] = await db.select().from(quests).where(eq(quests.templateCode, 'first_troops'));
    const buyer = await createTestPlayer(db);
    let locked!: () => void, release!: () => void, blockerPid = 0;
    const baseLocked = new Promise<void>((resolve) => { locked = resolve; });
    const finishAllowed = new Promise<void>((resolve) => { release = resolve; });
    const completion = db.transaction(async (tx) => {
      await tx.select().from(bases).where(eq(bases.id, f.base.id)).for('update');
      const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`);
      blockerPid = rows[0]!.pid; locked(); await finishAllowed;
      const times = await tx.execute<{ at: Date }>(sql`select clock_timestamp() at`);
      const completedAt = new Date(times[0]!.at);
      await tx.insert(baseQuestProgress).values({ baseId: f.base.id, questId: q!.id, progress: q!.target, completedAt });
      return completedAt;
    });
    await baseLocked;
    const [started] = await db.execute<{ at: Date }>(sql`select clock_timestamp() at`);
    const transferStartedAt = new Date(started!.at);
    const transfer = transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where ${blockerPid}=any(pg_blocking_pids(pid))) waiting`);
        if (rows[0]!.waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally { release(); }
    const outcomes = await Promise.allSettled([completion, transfer]);
    expect(waiting).toBe(true);
    expect(outcomes.map((outcome) => outcome.status), outcomes.map((outcome) => outcome.status === 'rejected' ? `${String(outcome.reason)} / ${String(outcome.reason?.cause)} / ${String(outcome.reason?.cause?.code)}` : '').join(' ')).toEqual(['fulfilled', 'fulfilled']);
    const completedAt = (outcomes[0] as PromiseFulfilledResult<Date>).value;
    const transfers = await db.execute<{ created_at: Date }>(sql`select created_at from base_transfers where deed_asset_id=${f.base.deedAssetId}`);
    expect(new Date(transfers[0]!.created_at).getTime()).toBeGreaterThanOrEqual(completedAt.getTime());
    // Explicitly model the pre-fix transaction-start audit clock on this unique,
    // unretained historical fixture. New custody timestamps must not recreate it.
    await db.update(baseTransfers).set({ createdAt: transferStartedAt }).where(eq(baseTransfers.deedAssetId, f.base.deedAssetId!));
    expect(transferStartedAt.getTime()).toBeLessThan(completedAt.getTime());
    // Remove only the new trigger's fixture latch to model the historical
    // database before 0116; timestamps falsely suggest the buyer completed.
    await db.delete(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, f.wallet));
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions);
    const migration = readFileSync(new URL('../drizzle/0116_onboarding_training_finish.sql', import.meta.url), 'utf8');
    const backfills = migration.split('--> statement-breakpoint').filter((part) => part.includes('SELECT completed.wallet') || part.includes('WITH uncertain AS'));
    for (const statement of backfills) await db.execute(sql.raw(statement));
    for (const statement of backfills) await db.execute(sql.raw(statement));
    for (const wallet of [f.wallet, buyer.wallet]) {
      const [latch] = await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, wallet));
      expect(latch?.completedAt).toBeNull();
      expect(latch?.reviewEvidence).toEqual([expect.objectContaining({ baseId: f.base.id, questId: q!.id,
        reason: 'historical-completion-owner-unresolved', transfers: [expect.objectContaining({ fromWallet: f.wallet, toWallet: buyer.wallet })] })]);
    }
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(ledgerTransactions)).toEqual(before);
    const fresh = await fixture(f.wallet); await buy(fresh);
    const state = await getArmyState(db, fresh.wallet, at, fresh.base.id);
    expect(state.freeFinishAllReviewRequired).toBe(true); expect(state.freeFinishAllOffer).toBeNull();
    await expect(finish(fresh, { ...state.finishAllQuote, maxCostKeep: '0' })).rejects.toMatchObject({ code: 'TRAINING_FREE_FINISH_REVIEW_REQUIRED' });
    expect((await getArmyState(db, fresh.wallet, later(27_000), fresh.base.id)).counts.bowman).toBe(3);

  });
  it('keeps independently proven completions latched without a historical review hold', async () => {
    const f = await fixture();
    const [q] = await db.select().from(quests).where(eq(quests.templateCode, 'first_troops'));
    await db.insert(baseQuestProgress).values({ baseId: f.base.id, questId: q!.id, progress: q!.target, completedAt: at });
    await db.delete(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, f.wallet));
    const migration = readFileSync(new URL('../drizzle/0116_onboarding_training_finish.sql', import.meta.url), 'utf8');
    const backfills = migration.split('--> statement-breakpoint').filter((part) => part.includes('SELECT completed.wallet') || part.includes('WITH uncertain AS'));
    for (const statement of backfills) await db.execute(sql.raw(statement));
    const [proven] = await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, f.wallet));
    expect(proven).toMatchObject({ completedAt: at, reviewEvidence: null });
    const buyer = await createTestPlayer(db);
    await transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    for (const statement of backfills) await db.execute(sql.raw(statement));
    expect((await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, f.wallet)))[0])
      .toEqual(proven);
  });
  it('records canonical completion and its actor before allowing a real conveyance to commit', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db);
    const [q] = await db.select().from(quests).where(eq(quests.templateCode, 'first_troops'));
    await db.insert(baseQuestProgress).values({ baseId: f.base.id, questId: q!.id, progress: 1 });
    let recorded!: () => void, release!: () => void, completionPid = 0;
    const captured = new Promise<void>((resolve) => { recorded = resolve; });
    const mayCommit = new Promise<void>((resolve) => { release = resolve; });
    const completion = db.transaction(async (tx) => {
      const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`); completionPid = rows[0]!.pid;
      await progressQuestBatch(tx, f.wallet, [['first_troops', 20]], at, f.base.id);
      recorded(); await mayCommit;
    });
    await captured;
    const transfer = transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where ${completionPid}=any(pg_blocking_pids(pid))) waiting`);
        if (rows[0]!.waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally { release(); }
    await Promise.all([completion, transfer]);
    expect(waiting, 'conveyance must wait until canonical completion and actor evidence commit together').toBe(true);
    expect((await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, f.wallet)))[0]?.completedAt).not.toBeNull();
    expect(await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, buyer.wallet))).toEqual([]);
  });
  it('refuses a stale owner completion after conveyance rather than assigning it to the buyer', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db);
    await transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    await expect(progressQuestBatch(db, f.wallet, [['first_troops', 20]], at, f.base.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect(await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, buyer.wallet))).toEqual([]);
  });
  it('new troops and cancellation require fresh review and never spend KEEP or consume the gift', async () => {
    const f = await fixture(); const batch = await buy(f); const original = await offer(f);
    await buy(f, 1);
    await expect(finish(f, original)).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    const changed = await offer(f);
    await cancelTraining(db, f.wallet, batch.queue[0]!.id, randomUUID(), later(1000), f.ctx);
    await expect(finish(f, changed, randomUUID(), later(1000))).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    expect(await db.select().from(onboardingTrainingFinishes).where(eq(onboardingTrainingFinishes.wallet, f.wallet))).toEqual([]);
    await finish(f, await offer(f, later(1000)), randomUUID(), later(1000));
  });
  it('natural completion removes elapsed rows, while a fully elapsed queue consumes nothing', async () => {
    const f = await fixture(); await buy(f); const consent = await offer(f);
    const result = await finish(f, consent, randomUUID(), later(9000));
    expect(result.completed).toEqual([{ troop: 'bowman', count: 2 }]);
    expect((await getArmyState(db, f.wallet, later(9000), f.base.id)).counts.bowman).toBe(3);
    const g = await fixture(); await buy(g); const expired = await offer(g);
    await expect(finish(g, expired, randomUUID(), later(27_000))).rejects.toMatchObject({ statusCode: 404 });
    expect(await db.select().from(onboardingTrainingFinishes).where(eq(onboardingTrainingFinishes.wallet, g.wallet))).toEqual([]);
  });
  it('completed players get no retrospective gift on a new deed, even after selling the completed one', async () => {
    const f = await fixture();
    const [q] = await db.select().from(quests).where(eq(quests.templateCode, 'first_troops'));
    await db.insert(baseQuestProgress).values({ baseId: f.base.id, questId: q!.id, progress: q!.target, completedAt: at });
    expect((await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, f.wallet)))[0]?.completedAt).toEqual(at);
    const buyer = await createTestPlayer(db);
    await transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    const g = await fixture(f.wallet); await buy(g);
    const state = await getArmyState(db, g.wallet, at, g.base.id);
    expect(state.freeFinishAllOffer).toBeNull();
    await expect(finish(g, { ...state.finishAllQuote, maxCostKeep: '0' })).rejects.toMatchObject({ code: 'TRAINING_FREE_FINISH_UNAVAILABLE' });
    expect((await db.select().from(baseArmy).where(eq(baseArmy.baseId, g.base.id)))).toEqual([]);
  });
});
