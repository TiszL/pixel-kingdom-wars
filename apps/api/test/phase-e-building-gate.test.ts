/** Dark types must not become playable through crafted construction requests.
 * Seeded accepted facilities below prove pause/recovery only, not SIM admission. */
import { randomUUID } from 'node:crypto';
import { BuildingType, PHASE_E_BUILDINGS } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, bases, baseSlots, baseQuestProgress, builderJobs, buildings, ledgerTransactions,
  players, questProgress } from '../src/db/schema';
import { builderJobFinishCostKeep, cancelUpgrade, completeDueJobs, moveBuilding, placeBuilding,
  speedupJob, upgradeBuilding } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { builderJobPaidQuote, getBuilderJobSpeedupReceipt } from '../src/game/builderJobSpeedupReceipt';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { claimRect } from '../src/game/footprints';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb(), db = conn.db;
const now = new Date('2026-09-22T10:00:00.000Z'), claim = claimRect(0);
beforeAll(() => bootstrapSystemAccounts(db));
afterAll(() => conn.sql.end());
beforeEach(() => { vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false'); vi.stubEnv('GEMS_ENABLED', 'false'); });
afterEach(() => vi.unstubAllEnvs());

async function fixture(stable: boolean) {
  vi.stubEnv('MULTI_BASE_ENABLED', String(stable));
  const { wallet, keepAccountId } = await createTestPlayer(db);
  await db.update(players).set({ keepLevel: 5, builders: 3 }).where(eq(players.wallet, wallet));
  await fundTestKeep(db, wallet, 100_000n, 'test.phase-e.gate.keep', randomUUID());
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, keepLevel: 5, builders: 3 }).returning();
    baseId = base!.id;
    await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
    await rewardBaseShards(db, baseId, 100_000n, 'test.phase-e.gate.shards', randomUUID());
  } else await rewardShards(db, wallet, 100_000n, 'test.phase-e.gate.shards', randomUUID());
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  const put = async (type: BuildingType, offset = 0) => (await db.insert(buildings).values({
    playerWallet: wallet, baseId, type, level: 1, tx: claim.min + offset, ty: claim.min,
  }).returning())[0]!;
  const shards = () => baseId ? getBaseShardBalance(db, baseId)
    : getOrCreatePlayerAccount(db, wallet, 'player_shards').then(a => a.balance);
  return { wallet, baseId, context, put, shards, keepAccountId,
    upgrade: (id: string, key = randomUUID(), at = now) => upgradeBuilding(db, wallet, id, key, at, {}, baseId, context),
    place: (type: BuildingType) => placeBuilding(db, wallet, type, claim.min + 6, claim.min,
      randomUUID(), now, baseId, context),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const row = async (id: string) => (await db.select().from(buildings).where(eq(buildings.id, id)))[0]!;
const job = async (id: string) => (await db.select().from(builderJobs).where(eq(builderJobs.id, id)))[0]!;
async function state(f: Fixture) {
  return Promise.all([
    f.shards(), db.select().from(players).where(eq(players.wallet, f.wallet)),
    db.select().from(buildings).where(eq(buildings.playerWallet, f.wallet)).orderBy(buildings.id),
    db.select().from(builderJobs).where(eq(builderJobs.playerWallet, f.wallet)).orderBy(builderJobs.id),
    db.select().from(questProgress).where(eq(questProgress.playerWallet, f.wallet)).orderBy(questProgress.questId),
    f.baseId ? db.select().from(baseQuestProgress).where(eq(baseQuestProgress.baseId, f.baseId)).orderBy(baseQuestProgress.questId) : [],
  ]);
}
const disabled = { statusCode: 503, code: 'PHASE_E_DISABLED' };

for (const stable of [false, true]) describe(`Phase E construction pause (${stable ? 'stable base' : 'legacy wallet'})`, () => {
  it.each(PHASE_E_BUILDINGS.types)('%s refuses new starts without committing even unrelated due jobs', async type => {
    const f = await fixture(stable), facility = await f.put(type as BuildingType);
    const old = await f.put(BuildingType.Vault, 3);
    await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId, buildingId: old.id,
      kind: 'upgrade', startedAt: new Date(now.getTime() - 60_000), finishesAt: now });
    const before = await state(f), key = randomUUID();
    // Missing and explicitly false must both close the actual service entry.
    for (const flag of [undefined, 'false']) {
      vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', flag);
      await expect(f.place(type as BuildingType)).rejects.toMatchObject(disabled);
      await expect(f.upgrade(facility.id, key)).rejects.toMatchObject(disabled);
      expect(await state(f)).toEqual(before);
      expect(await db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `upg:${f.wallet}:${key}`))).toEqual([]);
    }
  });

  it('preserves original upgrade replay, move, cancellation/refund and natural completion while paused', async () => {
    const f = await fixture(stable), facility = await f.put(BuildingType.Workshop), key = randomUUID();
    const before = await f.shards();
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const accepted = await f.upgrade(facility.id, key);
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false');
    const charged = await f.shards(); expect(charged).toBeLessThan(before);
    expect(await f.upgrade(facility.id, key)).toMatchObject({ duplicate: true, job: { id: accepted.job!.id } });
    expect(await f.shards()).toBe(charged);
    const other = await f.put(BuildingType.Lodge, 3);
    await expect(f.upgrade(other.id, key)).rejects.toMatchObject({ statusCode: 409 });
    await moveBuilding(db, f.wallet, facility.id, claim.min, claim.min + 3, f.baseId, f.context);
    const cancelKey = randomUUID();
    await cancelUpgrade(db, f.wallet, accepted.job!.id, cancelKey, now, f.baseId, f.context);
    expect(await f.shards()).toBe(before);
    expect(await f.upgrade(facility.id, key)).toMatchObject({ duplicate: true, job: null });
    expect(await cancelUpgrade(db, f.wallet, accepted.job!.id, cancelKey, now, f.baseId, f.context)).toMatchObject({ replayed: true });
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const next = await f.upgrade(facility.id);
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false');
    const due = (await job(next.job!.id)).finishesAt;
    await completeDueJobs(db, f.wallet, due, f.baseId);
    expect((await row(facility.id)).level).toBe(2);
    await expect(f.upgrade(facility.id, randomUUID(), due)).rejects.toMatchObject(disabled);
  });

  it('preserves free build completion and paid speedup receipt recovery while paused', async () => {
    const f = await fixture(stable), facility = await f.put(BuildingType.Harvester);
    const [construction] = await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId,
      buildingId: facility.id, kind: 'build', startedAt: now, finishesAt: new Date(now.getTime() + 60_000) }).returning();
    expect(await speedupJob(db, f.wallet, construction!.id, randomUUID(), now, f.baseId, f.context)).toEqual({ cost: 0n });
    expect((await job(construction!.id)).completedAt).toEqual(now);
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const accepted = await f.upgrade(facility.id), original = await job(accepted.job!.id);
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false');
    const consent = builderJobPaidQuote(original, builderJobFinishCostKeep(original, now))!, key = randomUUID();
    const finish = () => withClientCurrencyContext({ currency: 'KEEP', expectedCurrency: 'KEEP' }, () =>
      speedupJob(db, f.wallet, original.id, key, now, f.baseId, f.context, consent));
    const lookup = { jobId: original.id, baseId: f.baseId ?? null, idempotencyKey: key };
    const before = (await db.select().from(accounts).where(eq(accounts.id, f.keepAccountId)))[0]!.balance;
    expect((await finish()).cost).toBe(BigInt(consent.maxCostKeep));
    const proof = await getBuilderJobSpeedupReceipt(db, f.wallet, lookup);
    expect(proof).toMatchObject({ status: 'accepted', result: { jobId: original.id } });
    expect(await finish()).toEqual({ cost: 0n });
    expect(await getBuilderJobSpeedupReceipt(db, f.wallet, lookup)).toEqual(proof);
    expect((await row(facility.id)).level).toBe(2);
    expect((await db.select().from(accounts).where(eq(accounts.id, f.keepAccountId)))[0]!.balance)
      .toBe(before - BigInt(consent.maxCostKeep));
  });

  it('leaves existing non-Phase-E placement and upgrade available', async () => {
    const f = await fixture(stable), vault = await f.place(BuildingType.Vault);
    const [construction] = await db.select().from(builderJobs).where(eq(builderJobs.buildingId, vault.id));
    await completeDueJobs(db, f.wallet, construction!.finishesAt, f.baseId);
    expect((await f.upgrade(vault.id, randomUUID(), construction!.finishesAt)).job).not.toBeNull();
  });
});

it('rechecks admission after lock waits while preserving work completed before the pause', async () => {
  const f = await fixture(true), facility = await f.put(BuildingType.Market), before = await state(f);
  vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
  f.context!.assertAuthority = async () => { vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false'); };
  await expect(f.place(BuildingType.Berth)).rejects.toMatchObject(disabled);
  expect(await state(f)).toEqual(before);
  const old = await f.put(BuildingType.Vault, 3);
  const [acceptedJob] = await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId,
    buildingId: old.id, kind: 'upgrade', startedAt: new Date(now.getTime() - 60_000), finishesAt: now }).returning();
  const shardsBefore = await f.shards(), key = randomUUID();
  vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
  let calls = 0;
  f.context!.assertAuthority = async () => { if (++calls === 2) vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false'); };
  await expect(f.upgrade(facility.id, key)).rejects.toMatchObject(disabled);
  expect(calls).toBe(2);
  // The enabled preflight legitimately committed an already accepted job.
  // Pausing at the second lock refuses only the new upgrade, not that history.
  expect((await row(old.id)).level).toBe(2);
  expect((await job(acceptedJob!.id)).completedAt).toEqual(now);
  expect(await row(facility.id)).toEqual(facility);
  expect(await f.shards()).toBe(shardsBefore);
  expect(await db.select({ id: builderJobs.id }).from(builderJobs)
    .where(eq(builderJobs.playerWallet, f.wallet))).toEqual([{ id: acceptedJob!.id }]);
  expect(await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, `upg:${f.wallet}:${key}`))).toEqual([]);
});
