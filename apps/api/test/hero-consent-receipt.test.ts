/** A confirmation must not purchase the next level/injury after another session
 * changes the roster. Recovery of an uncertain payment reads only its own ledger. */
import { randomUUID } from 'node:crypto';
import { HEROES, HERO_LEVELING, speedupCostKeep } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, baseHeroProgress, buildings, heroLevels, ledgerTransactions, sessions } from '../src/db/schema';
import { HeroRecoveryConsentSchema, HeroUpgradeConsentSchema } from '../src/game/heroConsent';
import { getHeroRecoveryReceipt, getHeroUpgradeReceipt, heroLedgerKey } from '../src/game/heroReceipt';
import { listHeroes, speedupHeroRecovery, upgradeHero } from '../src/game/heroes';
import { transferStableBase } from '../src/game/baseOwnership';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const originalMode = process.env['MULTI_BASE_ENABLED'];
const at = new Date('2026-09-12T00:00:00.000Z');
const until = new Date(at.getTime() + 125_000);
const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
const finishCost = BigInt(speedupCostKeep(125));
const upgradeConsent = { expectedLevel: 1, maxCostKeep: cost.toString() };
const recoveryConsent = { recoveryUntil: until.toISOString(), maxCostKeep: finishCost.toString() };
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => {
  if (originalMode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMode;
  await conn.sql.end();
});
async function fixture(stable: boolean) {
  process.env['MULTI_BASE_ENABLED'] = String(stable);
  const { wallet } = await createTestPlayer(db); const asset = randomWallet();
  await fundTestKeep(db, wallet, cost * 100n, 'test.hero.consent', randomUUID());
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, deedAssetId: asset, keepLevel: 8, landPaidAt: at }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  }
  const [altar] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type: HEROES.vex.altar, level: 1, tx: 12, ty: 12 }).returning();
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  const identity = { hero: 'vex' as const, idempotencyKey: randomUUID(), ...(baseId ? { baseId } : {}) };
  const set = async (level: number, recoveryUntil: Date | null) => {
    if (baseId) await db.insert(baseHeroProgress).values({ baseId, hero: 'vex', level, recoveryUntil }).onConflictDoUpdate({ target: [baseHeroProgress.baseId, baseHeroProgress.hero], set: { level, recoveryUntil } });
    else await db.insert(heroLevels).values({ playerWallet: wallet, hero: 'vex', level, recoveryUntil }).onConflictDoUpdate({ target: [heroLevels.playerWallet, heroLevels.hero], set: { level, recoveryUntil } });
  };
  const state = async () => baseId ? (await db.select().from(baseHeroProgress).where(eq(baseHeroProgress.baseId, baseId)))[0]
    : (await db.select().from(heroLevels).where(and(eq(heroLevels.playerWallet, wallet), eq(heroLevels.hero, 'vex'))))[0];
  const balance = async () => (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
  return { wallet, asset, baseId, context, identity, altar: altar!.id, set, state, balance,
    upgrade: (key = identity.idempotencyKey, consent = upgradeConsent) => upgradeHero(db, wallet, 'vex', key, at, context, consent),
    recover: (key = identity.idempotencyKey, consent = recoveryConsent) => speedupHeroRecovery(db, wallet, 'vex', key, at, context, consent),
  };
}

for (const stable of [false, true]) describe(`hero consent and receipts (${stable ? 'stable' : 'legacy'})`, () => {
  it('fences a stale level and the maximum KEEP charge before any debit', async () => {
    const f = await fixture(stable); const balance = await f.balance();
    await expect(f.upgrade(randomUUID(), { ...upgradeConsent, maxCostKeep: (cost - 1n).toString() }))
      .rejects.toMatchObject({ code: 'HERO_PRICE_CHANGED' });
    expect(await f.balance()).toBe(balance);
    await f.upgrade();
    await expect(f.upgrade(randomUUID())).rejects.toMatchObject({ code: 'HERO_CONSENT_STALE' });
    expect(await f.balance()).toBe(balance - cost); expect((await f.state())!.level).toBe(2);
    expect((await listHeroes(db, f.wallet, at, f.baseId)).features).toEqual({ heroConsent: { version: 1 }, heroReceipts: { version: 1 } });
  });
  it('serializes concurrent confirmed purchases to one level and one debit', async () => {
    const f = await fixture(stable); const balance = await f.balance();
    const results = await Promise.allSettled([f.upgrade(randomUUID()), f.upgrade(randomUUID())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await f.balance()).toBe(balance - cost); expect((await f.state())!.level).toBe(2);
  });
  it('retires a matching paid upgrade before current max-level and removed-altar checks', async () => {
    const f = await fixture(stable); await f.upgrade();
    await f.set(HERO_LEVELING.maxLevel, null); await db.delete(buildings).where(eq(buildings.id, f.altar));
    const balance = await f.balance();
    expect(await f.upgrade()).toMatchObject({ level: 2, spentKeep: '0', duplicate: true });
    expect(await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent })).toMatchObject({
      version: 1, status: 'accepted', wallet: f.wallet, baseId: f.baseId ?? null,
      funding: { currency: 'KEEP', amount: cost.toString() }, result: { fromLevel: 1, toLevel: 2 },
    });
    expect(await f.balance()).toBe(balance); expect((await f.state())!.level).toBe(HERO_LEVELING.maxLevel);
  });
  it('refuses another injury or excessive price and keeps the exact episode intact', async () => {
    const f = await fixture(stable); await f.set(1, until); const balance = await f.balance();
    await expect(f.recover(randomUUID(), { ...recoveryConsent, maxCostKeep: (finishCost - 1n).toString() }))
      .rejects.toMatchObject({ code: 'HERO_PRICE_CHANGED' });
    await f.set(1, new Date(until.getTime() + 1));
    await expect(f.recover()).rejects.toMatchObject({ code: 'HERO_CONSENT_STALE' });
    expect(await f.balance()).toBe(balance); expect((await f.state())!.recoveryUntil!.getTime()).toBe(until.getTime() + 1);
  });
  it('gives a typed no-debit refusal when the reviewed injury expires before the locked price time', async () => {
    const f = await fixture(stable); await f.set(1, until); const balance = await f.balance();
    await expect(speedupHeroRecovery(db, f.wallet, 'vex', f.identity.idempotencyKey, until, f.context, recoveryConsent))
      .rejects.toMatchObject({ statusCode: 409, code: 'HERO_NOT_RECOVERING' });
    expect(await f.balance()).toBe(balance);
    expect((await f.state())!.recoveryUntil).toEqual(until);
    expect((await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent })).status).toBe('unknown');
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
      heroLedgerKey('recovery', f.wallet, 'vex', f.identity.idempotencyKey, f.baseId)))).toHaveLength(0);
  });
  it('gives a typed no-debit refusal if the altar is removed after review', async () => {
    const f = await fixture(stable); const balance = await f.balance(); await db.delete(buildings).where(eq(buildings.id, f.altar));
    await expect(f.upgrade()).rejects.toMatchObject({ statusCode: 422, code: 'HERO_NOT_RECRUITED' });
    expect(await f.balance()).toBe(balance);
    expect((await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent })).status).toBe('unknown');
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
      heroLedgerKey('upgrade', f.wallet, 'vex', f.identity.idempotencyKey, f.baseId)))).toHaveLength(0);
  });
  it('reads the original paid recovery after a new injury without completing that injury', async () => {
    const f = await fixture(stable); await f.set(1, until); await f.recover();
    const receipt = await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent });
    expect(receipt).toMatchObject({ status: 'accepted', funding: { currency: 'KEEP', amount: finishCost.toString() }, result: { recoveryUntil: until.toISOString() } });
    const injury = new Date(until.getTime() + 125_000); await f.set(1, injury); const balance = await f.balance();
    await expect(f.recover()).rejects.toMatchObject({ statusCode: 409 });
    await expect(speedupHeroRecovery(db, f.wallet, 'vex', f.identity.idempotencyKey, at, f.context)).rejects.toMatchObject({ statusCode: 409 });
    expect(await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent })).toEqual(receipt);
    expect((await f.state())!.recoveryUntil).toEqual(injury); expect(await f.balance()).toBe(balance);
  });
  it('never substitutes another key, wallet, base, hero, level, episode, or price ceiling', async () => {
    const f = await fixture(stable); await f.upgrade(); await f.set(2, until); await f.recover();
    const other = await createTestPlayer(db);
    for (const identity of [{ ...f.identity, idempotencyKey: randomUUID() }, { ...f.identity, baseId: randomUUID() },
      { ...f.identity, hero: 'theodor' as const }, ...(stable ? [{ ...f.identity, baseId: undefined }] : [])]) {
      expect((await getHeroUpgradeReceipt(db, f.wallet, { ...identity, ...upgradeConsent })).status).toBe('unknown');
      expect((await getHeroRecoveryReceipt(db, f.wallet, { ...identity, ...recoveryConsent })).status).toBe('unknown');
    }
    expect((await getHeroUpgradeReceipt(db, other.wallet, { ...f.identity, ...upgradeConsent })).status).toBe('unknown');
    expect((await getHeroRecoveryReceipt(db, other.wallet, { ...f.identity, ...recoveryConsent })).status).toBe('unknown');
    expect((await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent, expectedLevel: 2 })).status).toBe('unknown');
    expect((await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent, maxCostKeep: '0' })).status).toBe('unknown');
    expect((await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent, recoveryUntil: at.toISOString() })).status).toBe('unknown');
    expect((await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent, maxCostKeep: '0' })).status).toBe('unknown');
  });
  it('never infers payment from natural recovery or from a rolled-back debit', async () => {
    const f = await fixture(stable); await f.set(1, at);
    expect((await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent })).status).toBe('unknown');
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((work, config) => transaction(async (tx) => { await work(tx); throw new Error('test rollback'); }, config));
    try { await expect(f.upgrade()).rejects.toThrow('test rollback'); } finally { spy.mockRestore(); }
    expect((await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent })).status).toBe('unknown');
    expect((await f.state())!.level).toBe(1);
  });
});

it('keeps original seller receipt access after a real transfer and never grants it to the buyer', async () => {
  const f = await fixture(true); await f.upgrade(); await f.set(2, until); await f.recover();
  const buyer = await createTestPlayer(db);
  const up = await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent });
  const recovery = await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent });
  await transferStableBase(db, f.baseId!, f.wallet, buyer.wallet, f.asset);
  expect(await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent })).toEqual(up);
  expect(await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent })).toEqual(recovery);
  expect((await getHeroUpgradeReceipt(db, buyer.wallet, { ...f.identity, ...upgradeConsent })).status).toBe('unknown');
  expect((await getHeroRecoveryReceipt(db, buyer.wallet, { ...f.identity, ...recoveryConsent })).status).toBe('unknown');
});

it('preserves old recovery records but will not invent their missing episode', async () => {
  const f = await fixture(false); await f.set(1, until); await f.recover();
  const ledgerKey = heroLedgerKey('recovery', f.wallet, 'vex', f.identity.idempotencyKey);
  await db.update(ledgerTransactions).set({ metadata: { wallet: f.wallet, hero: 'vex', recycled: true, remainingSec: 125 } }).where(eq(ledgerTransactions.idempotencyKey, ledgerKey));
  expect((await getHeroRecoveryReceipt(db, f.wallet, { ...f.identity, ...recoveryConsent })).status).toBe('unknown');
  expect(await speedupHeroRecovery(db, f.wallet, 'vex', f.identity.idempotencyKey, at)).toMatchObject({ duplicate: true, spentKeep: '0' });
  await expect(f.recover()).rejects.toMatchObject({ statusCode: 409 });
});

it('requires balanced KEEP evidence from the original payer to the recycling pool', async () => {
  const f = await fixture(false); const other = await fixture(false); const sys = await bootstrapSystemAccounts(db);
  const payer = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
  const otherPayer = await getOrCreatePlayerAccount(db, other.wallet, 'player_keep');
  const metadata = { wallet: f.wallet, hero: 'vex', recycled: true, from: 1, to: 2 };
  for (const variant of [
    { type: 'hero.upgrade', metadata: { ...metadata, wallet: other.wallet }, payer: payer.id, pool: sys.emission_pool },
    { type: 'hero.upgrade', metadata, payer: otherPayer.id, pool: sys.emission_pool },
    { type: 'hero.upgrade', metadata, payer: payer.id, pool: sys.league_pool },
    { type: 'hero.upgrade', metadata: { ...metadata, to: 3 }, payer: payer.id, pool: sys.emission_pool },
    { type: 'item.buy', metadata, payer: payer.id, pool: sys.emission_pool },
  ]) {
    const request = { ...f.identity, ...upgradeConsent, idempotencyKey: randomUUID() };
    await postTransaction(db, { idempotencyKey: heroLedgerKey('upgrade', f.wallet, 'vex', request.idempotencyKey), type: variant.type, metadata: variant.metadata,
      entries: [{ account: variant.payer, delta: -cost }, { account: variant.pool, delta: cost }] });
    expect((await getHeroUpgradeReceipt(db, f.wallet, request)).status).toBe('unknown');
  }
  await db.insert(ledgerTransactions).values({ idempotencyKey: heroLedgerKey('upgrade', f.wallet, 'vex', f.identity.idempotencyKey), type: 'hero.upgrade', metadata });
  expect((await getHeroUpgradeReceipt(db, f.wallet, { ...f.identity, ...upgradeConsent })).status).toBe('unknown');
  await expect(f.upgrade()).rejects.toMatchObject({ statusCode: 409 });
});

it('authenticates both receipt routes without current land or mutating reads', async () => {
  const f = await fixture(false); await f.upgrade(); await f.set(2, until); await f.recover();
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const app = await buildApp(TEST_CONFIG, db);
  const before = await db.select().from(accounts);
  try {
    for (const [path, consent] of [['upgrade', upgradeConsent], ['recovery/speedup', recoveryConsent]] as const) {
      const url = `/heroes/vex/${path}/receipt?${new URLSearchParams(Object.entries({ idempotencyKey: f.identity.idempotencyKey, ...consent }).map(([k, v]) => [k, String(v)]))}`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const response = await app.inject({ method: 'GET', url, cookies });
      expect(response.statusCode).toBe(200); expect(response.json().status).toBe('accepted');
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await app.inject({ method: 'GET', url: `${url}&wallet=${f.wallet}`, cookies })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url, cookies: { ...cookies, [LOGIN_COOKIE]: 'pending' } })).statusCode).toBe(403);
    }
    expect(await db.select().from(accounts)).toEqual(before);
  } finally { await app.close(); }
});

it('validates complete bounded consent while preserving legacy omission', () => {
  expect(HeroUpgradeConsentSchema.optional().parse(undefined)).toBeUndefined();
  expect(HeroRecoveryConsentSchema.optional().parse(undefined)).toBeUndefined();
  for (const invalid of ['-1', '01', '1.0', '1e9', '9'.repeat(33), 1]) {
    expect(HeroUpgradeConsentSchema.safeParse({ ...upgradeConsent, maxCostKeep: invalid }).success).toBe(false);
    expect(HeroRecoveryConsentSchema.safeParse({ ...recoveryConsent, maxCostKeep: invalid }).success).toBe(false);
  }
  expect(HeroUpgradeConsentSchema.safeParse({ ...upgradeConsent, expectedLevel: HERO_LEVELING.maxLevel + 1 }).success).toBe(false);
  expect(HeroRecoveryConsentSchema.safeParse({ maxCostKeep: '1' }).success).toBe(false);
});
