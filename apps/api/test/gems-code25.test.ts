/**
 * Installed-client matrix (E2-GEMS-CONTRACT §6; D-152).
 *
 * WHY: code 25 is installed on real Seekers and sends NO currency header; a
 * code-26 client sends `x-pkw-currency: GEMS`. Both talk to the same sink
 * sites, so each site must (a) charge exactly the currency the client can name
 * in its consent dialog, (b) leave the other balance untouched, (c) fail with
 * the typed 422 that client's funds sheet understands, and (d) write receipts
 * both clients can recover. These cases go through the real HTTP hook (the
 * AsyncLocalStorage carrier) where a route exists, and through the service
 * with an explicit context where the settlement path is a service call.
 */
import { randomUUID } from 'node:crypto';
import { BUFFS, BuildingType, HEROES, HERO_LEVELING, ITEMS, MINING } from '@shardkeep/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import {
  accounts, bases, baseSlots, baseTrainingQueue, baseTroopResearch, buildings, builderJobs, heroLevels, ledgerEntries, ledgerTransactions, playerItems, players, pveCamps, raidCommands, raids, sessions, shields, trainingQueue, troopResearch,
} from '../src/db/schema';
import { playerActionEvents } from '../src/db/playtestActivitySchema';
import * as simulationRunner from '../src/game/raidSimulationRunner';
import { completeDueJobs, ensureStartingBase, placeBuilding, upgradeBuilding } from '../src/game/base';
import { completeDueTraining, researchSpeedup, researchTroop } from '../src/game/army';
import { withClientCurrency, withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { heroLedgerKey } from '../src/game/heroReceipt';
import { acceptLiveRaidCommand, refundUnstartedLiveBuffs } from '../src/game/liveRaids';
import { createPveRaid, createRaid, getPendingRaidResumes, recoverDueStartedLiveRaids, submitOrders } from '../src/game/raids';
import { rewardShards, spendGameCurrency } from '../src/game/spend';
import { makeCampSnapshot } from '../src/game/world';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, createTestValley, fundTestKeep, randomWallet, TEST_CONFIG } from './helpers';
import { trainSpeedup, trainTroop } from './training-consent';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;
const k = () => randomUUID();
const future = (min: number): Date => new Date(Date.now() + min * 60_000);
const ENV = ['GEMS_ENABLED', 'FREE_ONBOARDING', 'MULTI_BASE_ENABLED', 'HERO_RECRUITMENT_ENABLED'] as const;
const prior: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
beforeAll(async () => {
  for (const key of ENV) prior[key] = process.env[key];
  process.env['GEMS_ENABLED'] = 'true';
  process.env['FREE_ONBOARDING'] = 'true';
  process.env['MULTI_BASE_ENABLED'] = 'false';
  process.env['HERO_RECRUITMENT_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  for (const key of ENV) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  await conn.sql.end();
});

const keepOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;
const gemsOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_gems')).balance;
async function txnByKey(key: string) {
  const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key));
  return txn;
}
async function shapeOf(txnId: string) {
  const rows = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txnId));
  return rows.map((r) => `${r.kind}:${r.delta}`).sort();
}
const GEMS_SHAPE = (n: bigint) => [`gems_sink:${n}`, `player_gems:${-n}`].sort();
const KEEP_SHAPE = (n: bigint) => [`emission_pool:${n}`, `player_keep:${-n}`].sort();

/** A free-tier player with a base, `keep` custodial KEEP and `gems` Gems, signed in. */
async function player(keep: bigint, gems: bigint) {
  const { wallet } = await createTestPlayer(db);
  await ensureStartingBase(db, wallet);
  if (keep + gems > 0n) await fundTestKeep(db, wallet, keep + gems, 'test.fund', k());
  if (gems > 0n) await convertKeepToGems(db, wallet, gems, k());
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  return { wallet, cookies };
}
const gemsHeader = { 'x-pkw-currency': 'GEMS' };
type Json = Record<string, unknown> & { error?: { code?: string } };

/** A reviewed Gem price may not silently become a KEEP charge after another
 * command spends the Gems. All affected domain writes must roll back with it. */
const exactGemsHeader = { 'x-pkw-expected-currency': 'GEMS' };
const exactGems = <T>(fn: () => T) => withClientCurrencyContext({ currency: 'KEEP', expectedCurrency: 'GEMS' }, fn);
async function refusedHttp(p: Awaited<ReturnType<typeof player>>, url: string, payload: object, snapshot: () => Promise<unknown>) {
  const before = await snapshot(); const balances = [await keepOf(p.wallet), await gemsOf(p.wallet)];
  const reply = await app.inject({ method: 'POST', url, cookies: p.cookies, headers: exactGemsHeader, payload });
  expect(reply.statusCode, reply.body).toBe(409);
  expect(reply.json()).toMatchObject({ error: { code: 'CURRENCY_CONSENT_CHANGED', expectedCurrency: 'GEMS', reason: 'insufficient_balance' } });
  expect(await snapshot()).toEqual(before);
  expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(balances);
}
async function refusedService(wallet: string, run: () => Promise<unknown>, snapshot: () => Promise<unknown>) {
  const before = await snapshot(); const balances = [await keepOf(wallet), await gemsOf(wallet)];
  await expect(exactGems(run)).rejects.toMatchObject({ statusCode: 409, code: 'CURRENCY_CONSENT_CHANGED', details: { expectedCurrency: 'GEMS', reason: 'insufficient_balance' } });
  expect(await snapshot()).toEqual(before);
  expect([await keepOf(wallet), await gemsOf(wallet)]).toEqual(balances);
}

describe('item purchase (items.ts) over HTTP', () => {
  const price = BigInt(ITEMS.powder_charge.costKeep);
  const buy = (cookies: Record<string, string>, headers?: Record<string, string>) => app.inject({
    method: 'POST', url: '/items/buy', cookies, ...(headers ? { headers } : {}),
    payload: { itemId: 'powder_charge', idempotencyKey: k() },
  });
  const provenance = async (wallet: string) => (await db.select({ v: playerItems.acquiredVia }).from(playerItems)
    .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, 'powder_charge'))))[0]?.v;

  it('code 26 (GEMS header): charges Gems, records shop_gems, leaves KEEP alone', async () => {
    const p = await player(0n, price * 3n);
    const res = await buy(p.cookies, gemsHeader);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ itemId: 'powder_charge', currency: 'GEMS', duplicate: false });
    expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual([0n, price * 2n]);
    expect(await provenance(p.wallet)).toBe('shop_gems');
  });
  it('code 25 (no header): charges custodial KEEP, records shop_keep', async () => {
    const p = await player(price * 3n, 0n);
    const res = await buy(p.cookies);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ currency: 'KEEP' });
    expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual([price * 2n, 0n]);
    expect(await provenance(p.wallet)).toBe('shop_keep');
  });
  it('code 26 with Gems short but KEEP enough: the WHOLE price from KEEP, provenance shop_keep', async () => {
    const p = await player(price * 3n, price - 1n);
    const res = await buy(p.cookies, { 'x-pkw-currency': 'gems' }); // header case-insensitive
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ currency: 'KEEP' });
    expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual([price * 2n, price - 1n]);
    expect(await provenance(p.wallet)).toBe('shop_keep');
  });
  it('a balance change after review refuses the other currency, then a headerless request remains legacy', async () => {
    const p = await player(price * 3n, price);
    const reviewed = await app.inject({ method: 'GET', url: '/balances', cookies: p.cookies });
    expect(reviewed.json()).toMatchObject({ gems: price.toString(), features: { gameCurrency: { version: 1, exactSpendCurrency: 1 } } });
    await exactGems(() => spendGameCurrency(db, p.wallet, price, 'test.other-command', k()));
    await refusedHttp(p, '/items/buy', { itemId: 'powder_charge', idempotencyKey: k() }, () => provenance(p.wallet));
    expect((await buy(p.cookies)).json()).toMatchObject({ currency: 'KEEP' });
    for (const malformed of ['gems', 'GEMS,KEEP', 'SOL']) {
      const bad = await buy(p.cookies, { 'x-pkw-expected-currency': malformed });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: 'INVALID_CURRENCY_CONSENT' } });
    }
    const read = await app.inject({ method: 'GET', url: '/balances', cookies: p.cookies, headers: exactGemsHeader });
    expect(read.statusCode).toBe(400);
  });
  it('concurrent exact GEMS, exact KEEP and headerless HTTP requests keep separate currency contexts', async () => {
    const ps = await Promise.all([player(price * 3n, price * 3n), player(price * 3n, price * 3n), player(price * 3n, price * 3n)]);
    const responses = await Promise.all([
      buy(ps[0]!.cookies, { 'x-pkw-currency': 'KEEP', 'x-pkw-expected-currency': 'GEMS' }),
      buy(ps[1]!.cookies, { 'x-pkw-currency': 'GEMS', 'x-pkw-expected-currency': 'KEEP' }),
      buy(ps[2]!.cookies),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(responses.map((r) => r.json().currency)).toEqual(['GEMS', 'KEEP', 'KEEP']);
    expect(await Promise.all(ps.map(async (p) => [await keepOf(p.wallet), await gemsOf(p.wallet)])))
      .toEqual([[price * 3n, price * 2n], [price * 2n, price * 3n], [price * 2n, price * 3n]]);
  });
  it('neither balance covers: typed 422 in the CLIENT\'s currency, nothing granted', async () => {
    const p = await player(price - 1n, price - 1n);
    const legacy = await buy(p.cookies);
    expect(legacy.statusCode).toBe(422);
    expect((legacy.json() as Json).error?.code).toBe('INSUFFICIENT_KEEP');
    const modern = await buy(p.cookies, gemsHeader);
    expect(modern.statusCode).toBe(422);
    expect((modern.json() as Json).error?.code).toBe('INSUFFICIENT_GEMS');
    expect(await provenance(p.wallet)).toBeUndefined();
    expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual([price - 1n, price - 1n]);
  });
});

describe('build speed-up (base.ts speedupJob) over HTTP', () => {
  it('charges the header currency and writes the sink metadata with `currency`', async () => {
    for (const [currency, keep, gems] of [['GEMS', 0n, 1_000_000n], ['KEEP', 1_000_000n, 0n]] as const) {
      const p = await player(keep, gems);
      // Every L1 construction finishes free (owner 2026-09-05), so the priced
      // job is the L2 UPGRADE of a completed barracks.
      const barracks = await placeBuilding(db, p.wallet, BuildingType.Barracks, 17, 17, k());
      await completeDueJobs(db, p.wallet, future(120));
      await rewardShards(db, p.wallet, 1_000_000n, 'test.fund.shards', k());
      await db.update(players).set({ keepLevel: 10 }).where(eq(players.wallet, p.wallet)); // L2 is Keep-gated
      await upgradeBuilding(db, p.wallet, barracks.id, k(), future(121));
      const [job] = await db.select().from(builderJobs)
        .where(and(eq(builderJobs.playerWallet, p.wallet), isNull(builderJobs.completedAt)));
      expect(job?.kind).toBe('upgrade');
      const key = k();
      if (currency === 'KEEP') await refusedHttp(p, `/base/jobs/${job!.id}/speedup`, { idempotencyKey: key },
        () => db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)));
      const res = await app.inject({
        method: 'POST', url: `/base/jobs/${job!.id}/speedup`, cookies: p.cookies,
        ...(currency === 'GEMS' ? { headers: gemsHeader } : {}), payload: { idempotencyKey: key },
      });
      expect(res.statusCode, currency).toBe(200);
      const cost = BigInt((res.json() as { cost: string }).cost);
      expect(cost).toBeGreaterThan(0n);
      const txn = (await txnByKey(`speedup:${p.wallet}:${key}`))!;
      expect(txn.type).toBe('build.speedup');
      expect(txn.metadata).toMatchObject({ currency, jobId: job!.id });
      expect(await shapeOf(txn.id)).toEqual(currency === 'GEMS' ? GEMS_SHAPE(cost) : KEEP_SHAPE(cost));
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(currency === 'GEMS' ? [0n, gems - cost] : [keep - cost, 0n]);
    }
  });
});

describe('extra Mine (build.mine) and its construction receipt', () => {
  it('a Gems-paid mine recovers with funding.currency GEMS; a KEEP-paid one with KEEP', async () => {
    for (const currency of ['GEMS', 'KEEP'] as const) {
      const p = await player(currency === 'KEEP' ? 1_000_000n : 0n, currency === 'GEMS' ? 1_000_000n : 0n);
      await db.insert(buildings).values({ playerWallet: p.wallet, type: BuildingType.Mine, level: 1, tx: 11, ty: 8 });
      const key = k();
      if (currency === 'KEEP') await refusedService(p.wallet,
        () => placeBuilding(db, p.wallet, BuildingType.Mine, 17, 14, key),
        () => db.select().from(buildings).where(eq(buildings.playerWallet, p.wallet)));
      await withClientCurrency(currency === 'GEMS' ? 'GEMS' : undefined,
        () => placeBuilding(db, p.wallet, BuildingType.Mine, 17, 14, key));
      const txn = (await txnByKey(`build:${p.wallet}:${key}`))!;
      expect(txn.type).toBe('build.mine');
      const price = BigInt(MINING.MINE_BUILD_KEEP[1]!);
      expect(await shapeOf(txn.id)).toEqual(currency === 'GEMS' ? GEMS_SHAPE(price) : KEEP_SHAPE(price));
      const receipt = await app.inject({
        method: 'GET', url: `/base/buildings/receipt?idempotencyKey=${key}&type=mine&tx=17&ty=14`, cookies: p.cookies,
      });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toMatchObject({ status: 'accepted', receiptId: txn.id, funding: { currency, amount: price.toString() } });
    }
  });
});

async function stampLand(wallet: string): Promise<void> {
  const paidAt = new Date();
  await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
  await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, wallet));
}

describe('live buff command (liveRaids.ts) and its refund', () => {
  it('charges the context currency inside the command transaction and refunds the SAME currency', async () => {
    const cost = BigInt(BUFFS.warhorn.costKeep);
    for (const currency of ['GEMS', 'KEEP'] as const) {
      const p = await player(currency === 'KEEP' ? cost * 2n : 0n, currency === 'GEMS' ? cost * 2n : 0n);
      await stampLand(p.wallet);
      const valley = await createTestValley(db, { name: `gems-live ${k()}`, createdAt: new Date('2000-01-04T00:00:00Z') });
      const [camp] = await db.insert(pveCamps).values({
        valleyId: valley.id, x: 0, y: 0, tier: 1, snapshot: makeCampSnapshot(1), lootKeep: 0n,
      }).returning();
      const raid = await createPveRaid(db, p.wallet, camp!.id, k());
      const commandKey = `buff-${k()}`;
      if (currency === 'KEEP') await refusedService(p.wallet,
        () => acceptLiveRaidCommand(db, p.wallet, raid.id, commandKey, { kind: 'buff', payload: { buff: 'warhorn' } }),
        async () => ({ raid: await db.select().from(raids).where(eq(raids.id, raid.id)), commands: await db.select().from(raidCommands).where(eq(raidCommands.raidId, raid.id)) }));
      await withClientCurrency(currency === 'GEMS' ? 'GEMS' : undefined, () => acceptLiveRaidCommand(
        db, p.wallet, raid.id, commandKey, { kind: 'buff', payload: { buff: 'warhorn' } },
      ));
      const charged = (await txnByKey(`raid:${raid.id}:live-buff:warhorn`))!;
      expect(charged.type).toBe('raid.buffs');
      expect(charged.metadata).toMatchObject({ currency, buff: 'warhorn', live: true, wallet: p.wallet });
      expect(await shapeOf(charged.id)).toEqual(currency === 'GEMS' ? GEMS_SHAPE(cost) : KEEP_SHAPE(cost));
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(currency === 'GEMS' ? [0n, cost] : [cost, 0n]);

      expect(await refundUnstartedLiveBuffs(db, raid.id, p.wallet)).toBe(1);
      const refund = (await txnByKey(`raid:${raid.id}:live-buff-refund:warhorn`))!;
      expect(refund.type).toBe('raid.buffs.system_refund');
      expect(refund.metadata).toMatchObject({ currency, refundOf: charged.id });
      expect(await shapeOf(refund.id)).toEqual(currency === 'GEMS'
        ? [`gems_sink:${-cost}`, `player_gems:${cost}`].sort() : [`emission_pool:${-cost}`, `player_keep:${cost}`].sort());
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(currency === 'GEMS' ? [0n, cost * 2n] : [cost * 2n, 0n]);
      // Retryable: a second sweep posts nothing new.
      expect(await refundUnstartedLiveBuffs(db, raid.id, p.wallet)).toBe(1);
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(currency === 'GEMS' ? [0n, cost * 2n] : [cost * 2n, 0n]);
    }
  });
});

describe('raid settlement buffs (raids.ts submitOrders)', () => {
  /** Landowner with barracks, camp and a trained army (raids.test.ts shape). */
  async function warlord(keep: bigint, gems: bigint) {
    const p = await player(0n, 0n);
    await stampLand(p.wallet);
    await rewardShards(db, p.wallet, 1_000_000n, 'test.fund.shards', k());
    if (keep > 0n) await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
    if (gems > 0n) { await fundTestKeep(db, p.wallet, gems, 'test.fund', k()); await convertKeepToGems(db, p.wallet, gems, k()); }
    await placeBuilding(db, p.wallet, BuildingType.Barracks, 17, 17, k());
    await completeDueJobs(db, p.wallet, future(120));
    await placeBuilding(db, p.wallet, BuildingType.Camp, 19, 19, k());
    await completeDueJobs(db, p.wallet, future(240));
    let t = 300;
    for (let i = 0; i < 4; i++) {
      await trainTroop(db, p.wallet, 'highlander' as never, k(), future(t));
      t += 10;
      await completeDueTraining(db, p.wallet, future(t));
    }
    return p;
  }
  async function victim() {
    const p = await player(0n, 0n);
    await stampLand(p.wallet);
    await rewardShards(db, p.wallet, 20_000n, 'test.fund.shards', k());
    return p;
  }
  const deploys = [
    { troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 },
    { troop: 'highlander' as const, tx: 6, ty: 15, tMs: 0 },
    { troop: 'highlander' as const, tx: 14, ty: 6, tMs: 200 },
  ];
  const warhorn = BigInt(BUFFS.warhorn.costKeep);

  it.each([
    { client: 'GEMS', charged: 'GEMS', gemsEnough: true },
    { client: 'KEEP', charged: 'KEEP', gemsEnough: true },
    { client: 'GEMS', charged: 'KEEP', gemsEnough: false },
  ] as const)('worker recovery preserves the prepaid $charged buff for a $client client', async ({ client, charged, gemsEnough }) => {
    const keep = warhorn * 2n;
    const gems = gemsEnough ? warhorn * 2n : warhorn - 1n;
    const att = await warlord(keep, gems);
    const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    const commandId = k();
    const payload = { clientCommandId: commandId, command: { kind: 'buff', payload: { buff: 'warhorn' } } };
    const accepted = await app.inject({ method: 'POST', url: `/raids/${raid.id}/commands`,
      cookies: att.cookies, ...(client === 'GEMS' ? { headers: gemsHeader } : {}), payload });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const txn = (await txnByKey(`raid:${raid.id}:live-buff:warhorn`))!;
    expect(await shapeOf(txn.id)).toEqual(charged === 'GEMS' ? GEMS_SHAPE(warhorn) : KEEP_SHAPE(warhorn));
    // A reconnect may use a different client. Its retry must adopt the charge.
    const replay = await app.inject({ method: 'POST', url: `/raids/${raid.id}/commands`,
      cookies: att.cookies, headers: { 'x-pkw-currency': client === 'GEMS' ? 'KEEP' : 'GEMS' }, payload });
    expect(replay.statusCode, replay.body).toBe(200);
    const deployed = await app.inject({ method: 'POST', url: `/raids/${raid.id}/commands`, cookies: att.cookies,
      payload: { clientCommandId: k(), command: { kind: 'deploy', payload: { troop: 'highlander', tx: 6, ty: 14, tMs: 0 } } } });
    expect(deployed.statusCode, deployed.body).toBe(200);
    const expected = charged === 'GEMS' ? [keep, gems - warhorn] : [keep - warhorn, gems];
    expect([await keepOf(att.wallet), await gemsOf(att.wallet)]).toEqual(expected);
    // Process loss also loses the request context. Disabling new Gems spends
    // must not make the worker debit KEEP or refund a started, paid command.
    process.env['GEMS_ENABLED'] = 'false';
    try {
      const afterOutage = new Date(Date.now() + 200_000);
      await withClientCurrency(undefined, () => getPendingRaidResumes(db, att.wallet, afterOutage));
      expect(await exactGems(() => recoverDueStartedLiveRaids(db, afterOutage, undefined, raid.id)))
        .toEqual({ resolved: 1, raced: 0 });
      expect(await exactGems(() => recoverDueStartedLiveRaids(db, afterOutage, undefined, raid.id)))
        .toEqual({ resolved: 0, raced: 0 });
      expect(await txnByKey(`raid:${raid.id}:buffs`)).toBeUndefined();
      expect([await keepOf(att.wallet), await gemsOf(att.wallet)]).toEqual(expected);
      expect((await db.select({ status: raids.status }).from(raids).where(eq(raids.id, raid.id)))[0]!.status).toBe('resolved');
    } finally {
      process.env['GEMS_ENABLED'] = 'true';
    }
  });

  it('charges Gems for a Gems-aware client and KEEP for a legacy one, never both', async () => {
    for (const currency of ['GEMS', 'KEEP'] as const) {
      const att = await warlord(currency === 'KEEP' ? warhorn * 2n : 0n, currency === 'GEMS' ? warhorn * 2n : 0n);
      const def = await victim();
      const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
      if (currency === 'KEEP') await refusedService(att.wallet,
        () => submitOrders(db, att.wallet, raid.id, { deploys, buffs: { warhorn: true }, idempotencyKey: k() }),
        () => db.select().from(raids).where(eq(raids.id, raid.id)));
      const { result } = await withClientCurrency(currency === 'GEMS' ? 'GEMS' : undefined,
        () => submitOrders(db, att.wallet, raid.id, { deploys, buffs: { warhorn: true }, idempotencyKey: k() }));
      expect(result.stars).toBeGreaterThanOrEqual(0);
      const txn = (await txnByKey(`raid:${raid.id}:buffs`))!;
      expect(txn.type).toBe('raid.buffs');
      expect(txn.metadata).toMatchObject({ currency, raidId: raid.id, wallet: att.wallet });
      expect(await shapeOf(txn.id)).toEqual(currency === 'GEMS' ? GEMS_SHAPE(warhorn) : KEEP_SHAPE(warhorn));
      expect([await keepOf(att.wallet), await gemsOf(att.wallet)]).toEqual(currency === 'GEMS' ? [0n, warhorn] : [warhorn, 0n]);
    }
  });

  it('a balance race during simulation rolls back exact acceptance, activity and shield; a concurrent retry pays once', async () => {
    const att = await warlord(warhorn * 2n, warhorn); const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await db.insert(shields).values({ playerWallet: att.wallet, source: 'loss', expiresAt: future(120) });
    const snapshot = async () => ({
      raid: await db.select().from(raids).where(eq(raids.id, raid.id)),
      shields: await db.select().from(shields).where(eq(shields.playerWallet, att.wallet)),
      activity: await db.select().from(playerActionEvents).where(eq(playerActionEvents.wallet, att.wallet)),
    });
    const before = await snapshot(); const original = simulationRunner.claimRaidSimulationPermit;
    const spy = vi.spyOn(simulationRunner, 'claimRaidSimulationPermit').mockImplementationOnce(() => {
      const permit = original();
      return { ...permit, run: async (input) => {
        // Another accepted command consumes the reviewed Gems AFTER preflight.
        await exactGems(() => spendGameCurrency(db, att.wallet, warhorn, 'test.racing-command', k()));
        return permit.run(input);
      } };
    });
    const finish = () => submitOrders(db, att.wallet, raid.id, { deploys, buffs: { warhorn: true }, idempotencyKey: k() });
    try {
      await expect(exactGems(finish)).rejects.toMatchObject({ statusCode: 409, code: 'CURRENCY_CONSENT_CHANGED' });
    } finally { spy.mockRestore(); }
    expect(await snapshot()).toEqual(before);
    expect(await txnByKey(`raid:${raid.id}:buffs`)).toBeUndefined();
    expect([await keepOf(att.wallet), await gemsOf(att.wallet)]).toEqual([warhorn * 2n, 0n]);
    await convertKeepToGems(db, att.wallet, warhorn, k());
    const retries = await Promise.allSettled([exactGems(finish), exactGems(finish)]);
    expect(retries.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await txnByKey(`raid:${raid.id}:buffs`))!.metadata).toMatchObject({ currency: 'GEMS' });
    expect([await keepOf(att.wallet), await gemsOf(att.wallet)]).toEqual([warhorn, 0n]);
    const after = await snapshot();
    expect(after.raid[0]).toMatchObject({ status: 'resolved', bulkDeploymentAcceptedAt: expect.any(Date) });
    expect(after.shields).toHaveLength(0);
    expect(after.activity.length).toBeGreaterThan(before.activity.length);
  });

  it('refuses a buffed submit with a typed 422 in the client\'s currency and leaves the raid retryable', async () => {
    const att = await warlord(0n, 0n);
    const def = await victim();
    const raid = await createRaid(db, att.wallet, { defenderWallet: def.wallet, idempotencyKey: k() });
    await expect(withClientCurrency('GEMS', () => submitOrders(db, att.wallet, raid.id, { deploys, buffs: { warhorn: true }, idempotencyKey: k() })))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_GEMS' });
    await expect(withClientCurrency(undefined, () => submitOrders(db, att.wallet, raid.id, { deploys, buffs: { warhorn: true }, idempotencyKey: k() })))
      .rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_KEEP' });
    expect((await db.select({ status: raids.status }).from(raids).where(eq(raids.id, raid.id)))[0]!.status).toBe('pending_orders');
    const { result } = await withClientCurrency(undefined, () => submitOrders(db, att.wallet, raid.id, { deploys, idempotencyKey: k() }));
    expect(result.stars).toBeGreaterThanOrEqual(0);
  });
});

/** Both balances are funded in preference cases: a test with only one funded
 * account could pass even if the HTTP currency header were ignored entirely.
 * The shortfall keeps one Gem to prove fallback never takes a partial debit. */
const remainingSinkClients = [
  { client: 'legacy', charged: 'KEEP', keep: 1_000_000n, gems: 1_000_000n },
  { client: 'GEMS', charged: 'GEMS', keep: 1_000_000n, gems: 1_000_000n },
  { client: 'GEMS shortfall', charged: 'KEEP', keep: 1_000_000n, gems: 1n },
] as const;
const clientHeaders = (client: string) => client === 'legacy' ? {} : gemsHeader;
const oppositeHeaders = (charged: string) => ({ 'x-pkw-currency': charged === 'GEMS' ? 'KEEP' : 'GEMS' });
const afterCharge = (keep: bigint, gems: bigint, charged: string, cost: bigint) =>
  charged === 'GEMS' ? [keep, gems - cost] : [keep - cost, gems];

describe('hero recruitment currency over HTTP and saved command recovery', () => {
  it.each(remainingSinkClients)('$client pays $charged once; later client preference cannot change the receipt', async ({ client, charged, keep, gems }) => {
    const p = await player(keep, gems);
    await db.update(players).set({ keepLevel: HEROES.vex.unlockKeepLevel, builders: 2 }).where(eq(players.wallet, p.wallet));
    const request = { idempotencyKey: k(), baseId: null, type: HEROES.vex.altar,
      tx: 17, ty: 17, heroContractOnly: false, maxCostKeep: String(HEROES.vex.recruitCostKeep) };
    if (client === 'GEMS shortfall') await refusedHttp(p, '/heroes/recruit/v1', request,
      () => db.select().from(buildings).where(eq(buildings.playerWallet, p.wallet)));
    const accepted = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: p.cookies,
      headers: clientHeaders(client), payload: request });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const receipt = accepted.json() as { funding: { kind: string; amount: string; ledgerTransactionId: string } };
    const cost = BigInt(HEROES.vex.recruitCostKeep);
    expect(receipt.funding).toMatchObject({ kind: charged === 'GEMS' ? 'gems' : 'keep', amount: cost.toString() });
    expect(await shapeOf(receipt.funding.ledgerTransactionId)).toEqual(charged === 'GEMS' ? GEMS_SHAPE(cost) : KEEP_SHAPE(cost));
    const expected = afterCharge(keep, gems, charged, cost);
    expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(expected);

    const replay = await app.inject({ method: 'POST', url: '/heroes/recruit/v1', cookies: p.cookies,
      headers: oppositeHeaders(charged), payload: request });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(receipt);
    const recovered = await app.inject({ method: 'GET', url: `/heroes/recruit/v1/${request.idempotencyKey}`, cookies: p.cookies });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({ receipt });
    expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(expected);
    expect(await db.select({ id: buildings.id }).from(buildings)
      .where(and(eq(buildings.playerWallet, p.wallet), eq(buildings.type, HEROES.vex.altar)))).toHaveLength(1);
  });
});

describe('hero level and recovery currencies over HTTP', () => {
  for (const action of ['upgrade', 'recovery'] as const) {
    it.each(remainingSinkClients)(`${action}: $client pays $charged and exact recovery keeps that currency`, async ({ client, charged, keep, gems }) => {
      const p = await player(keep, gems);
      await db.insert(buildings).values({ playerWallet: p.wallet, type: HEROES.vex.altar, level: 1, tx: 17, ty: 17 });
      const recoveryUntil = future(120);
      await db.insert(heroLevels).values({ playerWallet: p.wallet, hero: 'vex', level: 1,
        ...(action === 'recovery' ? { recoveryUntil } : {}) });
      const consent = action === 'upgrade'
        ? { expectedLevel: 1, maxCostKeep: String(HERO_LEVELING.upgradeCostKeep.vex[0]!) }
        : { recoveryUntil: recoveryUntil.toISOString(), maxCostKeep: keep.toString() };
      const idempotencyKey = k();
      const path = `/heroes/vex/${action === 'upgrade' ? 'upgrade' : 'recovery/speedup'}`;
      const request = { idempotencyKey, consent };
      if (client === 'GEMS shortfall') await refusedHttp(p, path, request,
        () => db.select().from(heroLevels).where(eq(heroLevels.playerWallet, p.wallet)));
      const accepted = await app.inject({ method: 'POST', url: path, cookies: p.cookies,
        headers: clientHeaders(client), payload: request });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const result = accepted.json() as { spentKeep: string; duplicate: boolean };
      const cost = BigInt(result.spentKeep);
      expect(cost).toBeGreaterThan(1n);
      expect(result.duplicate).toBe(false);
      if (action === 'upgrade') expect(cost).toBe(BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!));
      const txn = (await txnByKey(heroLedgerKey(action, p.wallet, 'vex', idempotencyKey)))!;
      expect(txn.type).toBe(action === 'upgrade' ? 'hero.upgrade' : 'hero.recovery.speedup');
      expect(txn.metadata).toMatchObject({ currency: charged });
      expect(await shapeOf(txn.id)).toEqual(charged === 'GEMS' ? GEMS_SHAPE(cost) : KEEP_SHAPE(cost));
      const expected = afterCharge(keep, gems, charged, cost);
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(expected);

      const replay = await app.inject({ method: 'POST', url: path, cookies: p.cookies,
        headers: oppositeHeaders(charged), payload: request });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ duplicate: true, spentKeep: '0' });
      const query = new URLSearchParams(Object.entries({ idempotencyKey, ...consent }).map(([key, value]) => [key, String(value)]));
      const recovered = await app.inject({ method: 'GET', url: `${path}/receipt?${query}`, cookies: p.cookies,
        headers: oppositeHeaders(charged) });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json()).toMatchObject({ status: 'accepted', funding: { currency: charged, amount: cost.toString() } });
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(expected);
      const [hero] = await db.select().from(heroLevels).where(and(eq(heroLevels.playerWallet, p.wallet), eq(heroLevels.hero, 'vex')));
      expect(hero).toMatchObject(action === 'upgrade' ? { level: 2 } : { recoveryUntil: null });
    });
  }
});

describe('research and training finish currencies over HTTP', () => {
  for (const action of ['research', 'training'] as const) {
    it.each(remainingSinkClients)(`${action}: $client pays $charged for one completed episode`, async ({ client, charged, keep, gems }) => {
      const p = await player(keep, gems);
      await rewardShards(db, p.wallet, 1_000_000n, 'test.fund.shards', k());
      await db.insert(buildings).values(action === 'research'
        ? [{ playerWallet: p.wallet, type: BuildingType.Forge, level: 2, tx: 11, ty: 8 }]
        : [{ playerWallet: p.wallet, type: BuildingType.Barracks, level: 5, tx: 14, ty: 8 },
          { playerWallet: p.wallet, type: BuildingType.Camp, level: 3, tx: 17, ty: 8 }]);
      if (action === 'research') await researchTroop(db, p.wallet, 'giant', k());
      else await trainTroop(db, p.wallet, 'giant', k());
      const read = await app.inject({ method: 'GET', url: '/army', cookies: p.cookies });
      expect(read.statusCode, read.body).toBe(200);
      const state = read.json() as { finishAllQuote: unknown };
      const idempotencyKey = k();
      const request = action === 'research' ? { troop: 'giant', idempotencyKey }
        : { idempotencyKey, consent: state.finishAllQuote };
      const path = action === 'research' ? '/army/research/speedup' : '/army/train/speedup';
      if (client === 'GEMS shortfall') await refusedHttp(p, path, request, async () => ({
        research: await db.select().from(troopResearch).where(eq(troopResearch.playerWallet, p.wallet)),
        training: await db.select().from(trainingQueue).where(eq(trainingQueue.playerWallet, p.wallet)),
      }));
      const accepted = await app.inject({ method: 'POST', url: path, cookies: p.cookies,
        headers: clientHeaders(client), payload: request });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const cost = BigInt((accepted.json() as { cost: string }).cost);
      expect(cost).toBeGreaterThan(1n);
      const txn = (await txnByKey(`${action === 'research' ? 'rspeedup' : 'tspeedup'}:${p.wallet}:${idempotencyKey}`))!;
      expect(txn.type).toBe(action === 'research' ? 'research.speedup' : 'train.speedup');
      expect(txn.metadata).toMatchObject({ currency: charged });
      expect(await shapeOf(txn.id)).toEqual(charged === 'GEMS' ? GEMS_SHAPE(cost) : KEEP_SHAPE(cost));
      const expected = afterCharge(keep, gems, charged, cost);
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(expected);
      const finished = await app.inject({ method: 'GET', url: '/army', cookies: p.cookies });
      expect(finished.statusCode, finished.body).toBe(200);
      expect(finished.json()).toMatchObject(action === 'research'
        ? { levels: { giant: 2 }, research: [] } : { counts: { giant: 1 }, queue: [] });

      // These paid finishes have no refund operation or replay-success reply:
      // their completed timer returns404. A changed header must not debit a
      // second currency, finish another episode or duplicate the troop.
      const replay = await app.inject({ method: 'POST', url: path, cookies: p.cookies,
        headers: oppositeHeaders(charged), payload: request });
      expect(replay.statusCode, replay.body).toBe(404);
      expect([await keepOf(p.wallet), await gemsOf(p.wallet)]).toEqual(expected);
      expect(await shapeOf(txn.id)).toEqual(charged === 'GEMS' ? GEMS_SHAPE(cost) : KEEP_SHAPE(cost));
    });
  }
});


describe('stable base army sink branches preserve exact consent', () => {
  it.each(['research', 'training'] as const)('%s refuses Gems shortfall without finishing the base episode or spending KEEP', async (action) => {
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const { wallet } = await createTestPlayer(db); const asset = randomWallet(); const now = new Date();
      await fundTestKeep(db, wallet, 1_000_000n, 'test.fund', k());
      const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel: 8,
        deedAssetId: asset, deedMintAssetId: asset, landPaidAt: now }).returning();
      const baseId = base!.id;
      await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
      await rewardBaseShards(db, baseId, 100_000n, 'test.fund.shards', k());
      await db.insert(buildings).values([
        { playerWallet: wallet, baseId, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
        { playerWallet: wallet, baseId, type: BuildingType.Barracks, level: 5, tx: 8, ty: 8 },
        { playerWallet: wallet, baseId, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
        { playerWallet: wallet, baseId, type: BuildingType.Forge, level: 3, tx: 8, ty: 18 },
      ]);
      const context = { baseId, assertAuthority: async () => {} };
      if (action === 'research') await researchTroop(db, wallet, 'giant', k(), now, context);
      else await trainTroop(db, wallet, 'giant', k(), now, context);
      const key = k();
      const finish = () => action === 'research' ? researchSpeedup(db, wallet, 'giant', key, now, context)
        : trainSpeedup(db, wallet, key, now, context);
      await refusedService(wallet, finish, async () => ({
        research: await db.select().from(baseTroopResearch).where(eq(baseTroopResearch.baseId, baseId)),
        training: await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, baseId)),
      }));
      const finished = await withClientCurrencyContext({ currency: 'GEMS', expectedCurrency: 'KEEP' }, finish);
      expect(BigInt(finished.cost)).toBeGreaterThan(0n);
      expect(await gemsOf(wallet)).toBe(0n);
      expect(await keepOf(wallet)).toBe(1_000_000n - BigInt(finished.cost));
    } finally { process.env['MULTI_BASE_ENABLED'] = 'false'; }
  });
});
