/** A native confirmation selects one observed research and a maximum charge.
 * Another session may legally change it between GET and POST; the old consent
 * must never buy the next level or cancel/finish its replacement. */
import { randomUUID } from 'node:crypto';
import { BuildingType, speedupCostKeep, TROOP_LEVELING } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, buildings, troopResearch } from '../src/db/schema';
import { cancelResearch, completeDueTraining, getArmyState, researchSpeedup, researchTroop } from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { rewardShards } from '../src/game/spend';
import { ResearchEpisodeConsentSchema, ResearchFinishConsentSchema, ResearchStartConsentSchema } from '../src/game/researchConsent';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const previousMode = process.env['MULTI_BASE_ENABLED'];
const now = new Date('2026-09-06T10:00:00.000Z');
const key = () => `consent-${randomUUID()}`;
const shardCost = BigInt(TROOP_LEVELING.researchCostKeep[0]!);
const finishCost = BigInt(speedupCostKeep(TROOP_LEVELING.researchTimeSec[0]!));
const keep = async (wallet: string) => (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => {
  if (previousMode === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = previousMode;
  await conn.sql.end();
});

async function fixture(stable: boolean) {
  const { wallet } = await createTestPlayer(db);
  await fundTestKeep(db, wallet, 10_000_000n, 'test.consent.keep', key());
  let context: StableBaseMutationContext | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({
      ownerWallet: wallet, status: 'active', keepLevel: 8,
      deedAssetId: key(), landPaidAt: now,
    }).returning();
    await db.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id });
    context = { baseId: base!.id, assertAuthority: async () => {} };
    await rewardBaseShards(db, base!.id, 100_000n, 'test.consent.shards', key());
  } else {
    await ensureStartingBase(db, wallet);
    await rewardShards(db, wallet, 100_000n, 'test.consent.shards', key());
  }
  await db.insert(buildings).values({
    playerWallet: wallet, baseId: context?.baseId, type: BuildingType.Forge, level: 3, tx: 11, ty: 8,
  });
  const state = () => getArmyState(db, wallet, now, context?.baseId);
  const shards = async () => context
    ? getBaseShardBalance(db, context.baseId)
    : (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
  const episode = async () => {
    const army = await state();
    const row = army.research[0]!;
    return { currentLevel: army.levels.giant, toLevel: row.toLevel!, finishesAt: row.finishesAt!.toISOString(), episodeId: row.episodeId };
  };
  return { wallet, context, state, shards, episode };
}

for (const stable of [false, true]) {
  describe.sequential(`research consent (${stable ? 'stable deed' : 'legacy wallet'})`, () => {
    beforeEach(() => { process.env['MULTI_BASE_ENABLED'] = String(stable); });

    it('rejects a stale level after another session finished, without buying the next level', async () => {
      const f = await fixture(stable);
      const confirmed = { currentLevel: 1, maxCostShards: shardCost.toString() };
      await researchTroop(db, f.wallet, 'giant', key(), now, f.context, confirmed);
      await researchSpeedup(db, f.wallet, 'giant', key(), now, f.context);
      const balance = await f.shards();
      await expect(researchTroop(db, f.wallet, 'giant', key(), now, f.context, confirmed))
        .rejects.toMatchObject({ statusCode: 409, code: 'RESEARCH_CONSENT_STALE' });
      expect(await f.shards()).toBe(balance);
      expect((await f.state()).research).toEqual([]);
      expect((await f.state()).levels.giant).toBe(2);
    });

    it('enforces the SHARDS ceiling before any start debit and advertises guarded support', async () => {
      const f = await fixture(stable);
      const balance = await f.shards();
      await expect(researchTroop(db, f.wallet, 'giant', key(), now, f.context, {
        currentLevel: 1, maxCostShards: (shardCost - 1n).toString(),
      })).rejects.toMatchObject({ statusCode: 409, code: 'RESEARCH_PRICE_CHANGED' });
      expect(await f.shards()).toBe(balance);
      expect((await f.state()).research).toEqual([]);
      expect((await f.state()).features.researchConsent).toEqual({ version: 1 });
    });

    it('refuses first-attempt FINISH and CANCEL against a same-troop, same-deadline replacement', async () => {
      const f = await fixture(stable);
      await researchTroop(db, f.wallet, 'giant', key(), now, f.context);
      const old = await f.episode();
      await cancelResearch(db, f.wallet, 'giant', key(), now, f.context);
      // Even identical timestamps cannot substitute for the debit-bound episode.
      await researchTroop(db, f.wallet, 'giant', key(), now, f.context);
      const replacement = await f.episode();
      expect(replacement.finishesAt).toBe(old.finishesAt);
      expect(replacement.episodeId).not.toBe(old.episodeId);
      const shards = await f.shards();
      const balance = await keep(f.wallet);
      await expect(researchSpeedup(db, f.wallet, 'giant', key(), now, f.context, {
        ...old, maxCostKeep: finishCost.toString(),
      })).rejects.toMatchObject({ statusCode: 409, code: 'RESEARCH_CONSENT_STALE' });
      await expect(cancelResearch(db, f.wallet, 'giant', key(), now, f.context, old))
        .rejects.toMatchObject({ statusCode: 409, code: 'RESEARCH_CONSENT_STALE' });
      expect(await f.episode()).toEqual(replacement);
      expect(await f.shards()).toBe(shards);
      expect(await keep(f.wallet)).toBe(balance);
      // The exact current confirmation remains usable and refunds once.
      const cancelKey = key();
      await cancelResearch(db, f.wallet, 'giant', cancelKey, now, f.context, replacement);
      expect((await cancelResearch(db, f.wallet, 'giant', cancelKey, now, f.context, replacement)).replayed).toBe(true);
      expect(await f.shards()).toBe(shards + shardCost);
    });

    it('enforces KEEP ceiling before finishing and charges canonical cost on consented success', async () => {
      const f = await fixture(stable);
      await researchTroop(db, f.wallet, 'giant', key(), now, f.context);
      const episode = await f.episode();
      const before = await keep(f.wallet);
      await expect(researchSpeedup(db, f.wallet, 'giant', key(), now, f.context, {
        ...episode, maxCostKeep: (finishCost - 1n).toString(),
      })).rejects.toMatchObject({ statusCode: 409, code: 'RESEARCH_PRICE_CHANGED' });
      expect(await keep(f.wallet)).toBe(before);
      expect(await f.episode()).toEqual(episode);
      const finished = await researchSpeedup(db, f.wallet, 'giant', key(), now, f.context, {
        ...episode, maxCostKeep: finishCost.toString(),
      });
      expect(finished.cost).toBe(finishCost);
      expect(await keep(f.wallet)).toBe(before - finishCost);
      expect((await f.state()).levels.giant).toBe(2);
    });

    if (stable) it('rejects a valid confirmation from another wallet before any charge', async () => {
      const f = await fixture(true);
      const attacker = await createTestPlayer(db);
      await researchTroop(db, f.wallet, 'giant', key(), now, f.context);
      const episode = await f.episode();
      await expect(researchSpeedup(db, attacker.wallet, 'giant', key(), now, f.context, {
        ...episode, maxCostKeep: finishCost.toString(),
      })).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
      expect(await f.episode()).toEqual(episode);
    });
  });
}

it('requires complete consent and bounded decimal strings, while omission stays optional for web', () => {
  const episode = { currentLevel: 1, toLevel: 2, finishesAt: now.toISOString(), episodeId: null };
  expect(ResearchEpisodeConsentSchema.parse(episode)).toEqual(episode);
  expect(ResearchStartConsentSchema.optional().parse(undefined)).toBeUndefined();
  expect(ResearchEpisodeConsentSchema.safeParse({ ...episode, episodeId: undefined }).success).toBe(false);
  expect(ResearchFinishConsentSchema.safeParse(episode).success).toBe(false);
  for (const invalid of ['-1', '01', '1.0', '1e9', '9'.repeat(33), 1]) {
    expect(ResearchStartConsentSchema.safeParse({ currentLevel: 1, maxCostShards: invalid }).success).toBe(false);
  }
  expect(ResearchStartConsentSchema.safeParse({ currentLevel: TROOP_LEVELING.maxLevel + 1, maxCostShards: '0' }).success).toBe(false);
});


it.each([false, true])('does not land a restarted legacy episode from an old unlocked completion read (same deadline: %s)', async (sameDeadline) => {
  process.env['MULTI_BASE_ENABLED'] = 'false';
  const f = await fixture(false);
  await researchTroop(db, f.wallet, 'giant', key(), now);
  const old = await f.episode();
  const observedDue = new Date(Date.parse(old.finishesAt) + 1);
  const restartAt = sameDeadline ? now : new Date(Date.parse(old.finishesAt) - 1);
  const originalTransaction = db.transaction.bind(db);
  let calls = 0;
  let replacementId: string | null = null;
  // completeDueTraining first reconciles training quests under the wallet lock;
  // its next transaction claims the research row already read outside that lock.
  // Interleave canonical cancel/start at that exact boundary, as requests that
  // arrived just before the old deadline but won the lock before completion.
  const intercepted = vi.spyOn(db, 'transaction').mockImplementation(async (...args) => {
    calls += 1;
    if (calls === 2) {
      intercepted.mockRestore();
      await cancelResearch(db, f.wallet, 'giant', key(), restartAt);
      await researchTroop(db, f.wallet, 'giant', key(), restartAt);
      replacementId = (await getArmyState(db, f.wallet, restartAt)).research[0]!.episodeId;
    }
    return originalTransaction(...args);
  });
  try { await completeDueTraining(db, f.wallet, observedDue); }
  finally { intercepted.mockRestore(); }
  expect(calls).toBe(2);
  expect(replacementId).not.toBe(old.episodeId);
  const [row] = await db.select().from(troopResearch).where(and(
    eq(troopResearch.playerWallet, f.wallet), eq(troopResearch.troop, 'giant'),
  ));
  expect(row).toMatchObject({ level: 1, researchingToLevel: 2, debitLedgerTxnId: replacementId });
  expect(row!.finishesAt!.getTime()).toBe(restartAt.getTime() + TROOP_LEVELING.researchTimeSec[0]! * 1000);
  // A fresh observation of the replacement still completes it normally.
  expect((await getArmyState(db, f.wallet, new Date(row!.finishesAt!.getTime() + 1))).levels.giant).toBe(2);
});
