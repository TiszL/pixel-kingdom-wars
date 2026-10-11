/**
 * Returning-player repair for the quest-driven onboarding chain.
 *
 * The chain arrived after production players had already built, landed and
 * raided. Reads must recover those durable facts without treating placement as
 * build completion, crossing a base boundary, claiming a reward, or paying the
 * ledger. Stable history follows base_id through a deed transfer; legacy mode
 * remains wallet-keyed.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  baseQuestProgress,
  bases,
  baseSlots,
  builderJobs,
  buildings,
  players,
  questProgress,
  quests,
  raids,
} from '../src/db/schema';
import { completeDueJobs } from '../src/game/base';
import { getOnboardingStep, getQuestBoard } from '../src/game/quests';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

afterAll(async () => { await conn.sql.end(); });

async function stableBase(wallet: string, slot: number, landed = false) {
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    status: 'active',
    ...(landed ? { landPaidAt: new Date('2026-08-01T00:00:00.000Z') } : {}),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  return base!;
}

async function resolvedRaid(wallet: string, baseId?: string) {
  await db.insert(raids).values({
    idempotencyKey: randomUUID(),
    attackerWallet: wallet,
    ...(baseId ? { attackerBaseId: baseId } : {}),
    campaignStage: 1,
    seed: 1n,
    snapshot: {},
    armySnapshot: {},
    ordersDeadlineAt: new Date('2026-08-01T00:01:00.000Z'),
    status: 'resolved',
    result: { stars: 1 },
    resolvedAt: new Date('2026-08-01T00:00:30.000Z'),
  });
}

function onboardingRows(board: Awaited<ReturnType<typeof getQuestBoard>>) {
  return board.quests.filter((row) => row.scope === 'onboarding');
}

describe.sequential('authoritative onboarding fact reconciliation', () => {
  it('repairs legacy wallet history before both reads, idempotently, without claiming or paying', async () => {
    const player = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date('2026-08-01T00:00:00.000Z') })
      .where(eq(players.wallet, player.wallet));
    await db.insert(buildings).values([
      { playerWallet: player.wallet, type: 'camp', level: 1, tx: 7, ty: 7 },
      { playerWallet: player.wallet, type: 'mine', level: 1, tx: 10, ty: 7 },
      { playerWallet: player.wallet, type: 'barracks', level: 1, tx: 13, ty: 7 },
    ]);
    await resolvedRaid(player.wallet);
    const shardAccount = await getOrCreatePlayerAccount(db, player.wallet, 'player_shards');
    expect(shardAccount.balance).toBe(0n);

    // The narrow tutorial read performs reconciliation before choosing the live
    // step, so the first historical building is immediately complete.
    const first = await getOnboardingStep(db, player.wallet);
    expect(first).toMatchObject({ templateCode: 'first_camp', progress: 1, completed: true, claimed: false });

    // The board read has the same repair boundary and sees every durable fact.
    const board = onboardingRows(await getQuestBoard(db, player.wallet));
    expect(board).toHaveLength(6);
    expect(board.filter((row) => row.templateCode !== 'first_troops').every((row) => row.progress === 1 && row.completed && !row.claimed)).toBe(true);

    const before = await db.select({
      id: questProgress.id,
      progress: questProgress.progress,
      completedAt: questProgress.completedAt,
      claimedAt: questProgress.claimedAt,
    }).from(questProgress).innerJoin(quests, eq(quests.id, questProgress.questId)).where(and(
      eq(questProgress.playerWallet, player.wallet),
      eq(quests.scope, 'onboarding'),
    ));
    expect(before).toHaveLength(5);
    expect(before.every((row) => row.claimedAt == null)).toBe(true);

    // Cold-start retries neither create more rows nor move completed_at.
    await getQuestBoard(db, player.wallet);
    await getOnboardingStep(db, player.wallet);
    const after = await db.select({
      id: questProgress.id,
      progress: questProgress.progress,
      completedAt: questProgress.completedAt,
      claimedAt: questProgress.claimedAt,
    }).from(questProgress).innerJoin(quests, eq(quests.id, questProgress.questId)).where(and(
      eq(questProgress.playerWallet, player.wallet),
      eq(quests.scope, 'onboarding'),
    ));
    expect(after).toEqual(before);
    expect((await getOrCreatePlayerAccount(db, player.wallet, 'player_shards')).balance).toBe(0n);
  });

  it('does not mistake a placed building for a completed build and accepts real completeDueJobs', async () => {
    const player = await createTestPlayer(db);
    const base = await stableBase(player.wallet, 1);
    const [camp] = await db.insert(buildings).values({
      playerWallet: player.wallet,
      baseId: base.id,
      type: 'camp',
      level: 1,
      tx: 7,
      ty: 7,
    }).returning();
    const finishesAt = new Date('2030-01-01T00:01:00.000Z');
    await db.insert(builderJobs).values({
      playerWallet: player.wallet,
      baseId: base.id,
      kind: 'build',
      buildingId: camp!.id,
      startedAt: new Date('2030-01-01T00:00:00.000Z'),
      finishesAt,
    });
    await db.insert(raids).values({
      idempotencyKey: randomUUID(),
      attackerWallet: player.wallet,
      attackerBaseId: base.id,
      campaignStage: 1,
      seed: 2n,
      snapshot: {},
      armySnapshot: {},
      ordersDeadlineAt: new Date('2030-01-01T00:00:10.000Z'),
      status: 'resolved',
      result: { stars: 0 },
      resolvedAt: new Date('2030-01-01T00:00:20.000Z'),
    });

    expect(await getOnboardingStep(db, player.wallet, base.id))
      .toMatchObject({ templateCode: 'first_camp', progress: 0, completed: false });
    expect(onboardingRows(await getQuestBoard(
      db, player.wallet, new Date('2030-01-01T00:00:30.000Z'), base.id,
    )).find((row) => row.templateCode === 'first_camp'))
      .toMatchObject({ progress: 0, completed: false });
    expect(onboardingRows(await getQuestBoard(
      db, player.wallet, new Date('2030-01-01T00:00:30.000Z'), base.id,
    )).find((row) => row.templateCode === 'first_raid'))
      .toMatchObject({ progress: 0, completed: false });

    await completeDueJobs(db, player.wallet, new Date(finishesAt.getTime() + 1), base.id);
    expect(await getOnboardingStep(db, player.wallet, base.id))
      .toMatchObject({ templateCode: 'first_camp', progress: 1, completed: true, claimed: false });
  });

  it('isolates stable facts by base and carries unreconciled history through a deed transfer', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const factual = await stableBase(seller.wallet, 1, true);
    const empty = await stableBase(seller.wallet, 2);
    await db.insert(buildings).values([
      { playerWallet: seller.wallet, baseId: factual.id, type: 'camp', level: 1, tx: 7, ty: 7 },
      { playerWallet: seller.wallet, baseId: factual.id, type: 'mine', level: 1, tx: 10, ty: 7 },
      { playerWallet: seller.wallet, baseId: factual.id, type: 'barracks', level: 1, tx: 13, ty: 7 },
    ]);
    await resolvedRaid(seller.wallet, factual.id);

    // Facts on a sibling deed cannot repair this deed's chain.
    const isolated = onboardingRows(await getQuestBoard(db, seller.wallet, new Date(), empty.id));
    expect(isolated.every((row) => row.progress === 0 && !row.completed)).toBe(true);

    // Model the stable transfer boundary: only the ownership root and active
    // slot move. Historical child wallet shadows remain the seller, while their
    // authoritative base_id is unchanged.
    await db.delete(baseSlots).where(eq(baseSlots.baseId, factual.id));
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, factual.id));
    await db.insert(baseSlots).values({ wallet: buyer.wallet, slot: 1, baseId: factual.id });

    await expect(getOnboardingStep(db, seller.wallet, factual.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const conveyed = onboardingRows(await getQuestBoard(db, buyer.wallet, new Date(), factual.id));
    expect(conveyed).toHaveLength(6);
    expect(conveyed.filter((row) => row.templateCode !== 'first_troops').every((row) => row.progress === 1 && row.completed && !row.claimed)).toBe(true);
    expect(await db.select().from(baseQuestProgress).where(eq(baseQuestProgress.baseId, empty.id)))
      .toHaveLength(0);
  });

  it('refuses a direct foreign-base tutorial read', async () => {
    const owner = await createTestPlayer(db);
    const stranger = await createTestPlayer(db);
    const base = await stableBase(owner.wallet, 1);

    await expect(getOnboardingStep(db, stranger.wallet, base.id))
      .rejects.toMatchObject({ statusCode: 404, code: 'BASE_NOT_OWNED' });
    await expect(getQuestBoard(db, stranger.wallet, new Date(), base.id))
      .rejects.toMatchObject({ statusCode: 404, code: 'BASE_NOT_OWNED' });
  });
});
