/** An uncertain FINISH must recover the original payment, even after research or
 * ownership changes; a current level or a ledger key alone is never proof. */
import { randomUUID } from 'node:crypto';
import { BuildingType, speedupCostKeep, TROOP_LEVELING } from '@shardkeep/shared';
import { researchSpeedupReceiptPath, type ResearchSpeedupIntent } from '@shardkeep/shared/researchSpeedup';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, baseTroopResearch, buildings, ledgerTransactions, sessions, troopResearch } from '../src/db/schema';
import { getArmyState, researchSpeedup, researchTroop } from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { getResearchSpeedupReceipt, researchSpeedupLedgerKey } from '../src/game/researchReceipt';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';
const conn = connectTestDb(); const db = conn.db;
const now = new Date('2026-09-21T10:00:00.000Z');
const cost = BigInt(speedupCostKeep(TROOP_LEVELING.researchTimeSec[0]!));
const env = ['MULTI_BASE_ENABLED', 'GEMS_ENABLED', 'FREE_ONBOARDING'] as const;
const old = Object.fromEntries(env.map(k => [k, process.env[k]]));
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { for (const k of env) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } await conn.sql.end(); });
async function fixture(stable: boolean, currency: 'KEEP' | 'GEMS' = 'KEEP') {
  process.env['MULTI_BASE_ENABLED'] = String(stable); process.env['GEMS_ENABLED'] = 'true';
  const { wallet } = await createTestPlayer(db);
  await fundTestKeep(db, wallet, 10_000_000n, 'test.research.keep', randomUUID());
  if (currency === 'GEMS') await convertKeepToGems(db, wallet, cost * 3n, randomUUID());
  let baseId: string | undefined;
  if (stable) {
    const [base] = await db.insert(bases).values({ ownerWallet: wallet, keepLevel: 8, deedAssetId: randomUUID(), landPaidAt: now }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
    await rewardBaseShards(db, baseId, 100_000n, 'test.research.shards', randomUUID());
  } else { await ensureStartingBase(db, wallet); await rewardShards(db, wallet, 100_000n, 'test.research.shards', randomUUID()); }
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Forge, level: 3, tx: 11, ty: 8 });
  await researchTroop(db, wallet, 'giant', randomUUID(), now, context);
  const state = (at = now) => getArmyState(db, wallet, at, baseId);
  const row = (await state()).research[0]!;
  const consent = { currentLevel: 1, toLevel: 2, finishesAt: row.finishesAt!.toISOString(), episodeId: row.episodeId, maxCostKeep: cost.toString() };
  const request: ResearchSpeedupIntent = { troop: 'giant', baseId: baseId ?? null, idempotencyKey: randomUUID(), expectedCurrency: currency, ...consent };
  const balances = async () => Promise.all(['player_keep', 'player_gems'].map(async kind => (await getOrCreatePlayerAccount(db, wallet, kind as 'player_keep' | 'player_gems')).balance));
  const finish = (changes: Partial<ResearchSpeedupIntent> = {}, at = now) => {
    const r = { ...request, ...changes }; const { troop, idempotencyKey, expectedCurrency, baseId: _base, ...c } = r;
    return withClientCurrencyContext({ currency: undefined, expectedCurrency }, () => researchSpeedup(db, wallet, troop, idempotencyKey, at, context, c));
  };
  return { wallet, context, request, consent, state, finish, balances };
}
for (const stable of [false, true]) describe(`historical research receipts (${stable ? 'deed' : 'legacy scope'})`, () => {
  it('quotes the original episode using server time and charges within that exact review', async () => {
    const f = await fixture(stable, 'GEMS');
    expect((await f.state()).research[0]!.finishQuote).toEqual(f.consent);
    const remaining = TROOP_LEVELING.researchTimeSec[0]! / 2;
    const later = new Date(now.getTime() + remaining * 1000);
    const quote = (await f.state(later)).research[0]!.finishQuote!;
    expect(quote).toEqual({ ...f.consent, maxCostKeep: String(speedupCostKeep(remaining)) });
    expect(BigInt(quote.maxCostKeep)).toBeLessThan(BigInt(f.consent.maxCostKeep));
    const result = await f.finish({ maxCostKeep: quote.maxCostKeep }, later);
    expect(result.cost).toBe(BigInt(quote.maxCostKeep));
    expect(await getResearchSpeedupReceipt(db, f.wallet, { ...f.request, ...quote }))
      .toMatchObject({ status: 'accepted', funding: { currency: 'GEMS', amount: quote.maxCostKeep } });
  });
  it('offers no paid quote for an untimed row or research already completed for free', async () => {
    const f = await fixture(stable); const before = await f.balances();
    if (stable) await db.update(baseTroopResearch).set({ finishesAt: null }).where(eq(baseTroopResearch.baseId, f.context!.baseId));
    else await db.update(troopResearch).set({ finishesAt: null }).where(eq(troopResearch.playerWallet, f.wallet));
    expect((await f.state()).research[0]!.finishQuote).toBeNull();
    const finish = new Date(f.consent.finishesAt);
    if (stable) await db.update(baseTroopResearch).set({ finishesAt: finish }).where(eq(baseTroopResearch.baseId, f.context!.baseId));
    else await db.update(troopResearch).set({ finishesAt: finish }).where(eq(troopResearch.playerWallet, f.wallet));
    const completed = await f.state(finish);
    expect(completed.research).toEqual([]); expect(completed.levels.giant).toBe(2);
    expect(await f.balances()).toEqual(before);
    expect((await getResearchSpeedupReceipt(db, f.wallet, f.request)).status).toBe('unknown');
  });
  it.each(['KEEP', 'GEMS'] as const)('proves exact %s once, then survives a newer episode, pause and sale', async currency => {
    const f = await fixture(stable, currency); const before = await f.balances();
    const results = await Promise.all([f.finish(), f.finish()]);
    expect(results.map(r => r.cost).sort()).toEqual([0n, cost].sort());
    expect((await f.state()).levels.giant).toBe(2);
    expect((await f.state()).features.researchSpeedupReceipts).toEqual({ version: 1 });
    const proof = await getResearchSpeedupReceipt(db, f.wallet, f.request);
    expect(proof).toMatchObject({ status: 'accepted', request: f.request, funding: { currency, amount: cost.toString() }, result: { troop: 'giant', fromLevel: 1, toLevel: 2 } });
    await researchTroop(db, f.wallet, 'giant', randomUUID(), now, f.context);
    const replacement = (await f.state()).research;
    if (stable) {
      const buyer = await createTestPlayer(db);
      await db.delete(baseSlots).where(eq(baseSlots.baseId, f.context!.baseId));
      await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.context!.baseId));
    }
    process.env['GEMS_ENABLED'] = 'false';
    expect(await getResearchSpeedupReceipt(db, f.wallet, f.request)).toEqual(proof);
    expect(await f.finish()).toEqual({ cost: 0n, troop: 'giant', toLevel: 2 });
    const after = await f.balances(); expect(after[currency === 'KEEP' ? 0 : 1]).toBe(before[currency === 'KEEP' ? 0 : 1]! - cost);
    expect(after[currency === 'KEEP' ? 1 : 0]).toBe(before[currency === 'KEEP' ? 1 : 0]);
    if (!stable) expect((await f.state()).research).toEqual(replacement);
  });
  it('does not recover another wallet, key, troop, base, level, deadline, debit episode, ceiling or currency', async () => {
    const f = await fixture(stable); await f.finish(); const buyer = await createTestPlayer(db);
    expect((await getResearchSpeedupReceipt(db, buyer.wallet, f.request)).status).toBe('unknown');
    for (const change of [{ idempotencyKey: randomUUID() }, { troop: 'bowman' as const }, { baseId: randomUUID() },
      { currentLevel: 2, toLevel: 3 }, { finishesAt: new Date(now.getTime() + 1).toISOString() },
      { episodeId: randomUUID() }, { maxCostKeep: (cost + 1n).toString() }, { expectedCurrency: 'GEMS' as const }]) {
      expect((await getResearchSpeedupReceipt(db, f.wallet, { ...f.request, ...change })).status).toBe('unknown');
    }
    await expect(f.finish({ expectedCurrency: 'GEMS' })).rejects.toMatchObject({ code: 'RESEARCH_RECEIPT_INVALID' });
    await expect(f.finish({ maxCostKeep: (cost + 1n).toString() })).rejects.toMatchObject({ code: 'RESEARCH_RECEIPT_INVALID' });
  });
  it('keeps natural expiry and changed price as no-charge refusals with unknown receipts', async () => {
    const f = await fixture(stable); const before = await f.balances();
    await expect(f.finish({ maxCostKeep: (cost - 1n).toString() })).rejects.toMatchObject({ code: 'RESEARCH_PRICE_CHANGED' });
    await expect(f.finish({}, new Date(f.consent.finishesAt))).rejects.toMatchObject({ code: 'RESEARCH_CONSENT_STALE' });
    expect(await f.balances()).toEqual(before);
    expect((await getResearchSpeedupReceipt(db, f.wallet, f.request)).status).toBe('unknown');
  });
  it('does not spend KEEP when the reviewed Gems balance is missing', async () => {
    const f = await fixture(stable); const before = await f.balances(); const research = (await f.state()).research;
    await expect(f.finish({ expectedCurrency: 'GEMS' })).rejects.toMatchObject({ code: 'CURRENCY_CONSENT_CHANGED' });
    expect(await f.balances()).toEqual(before); expect((await f.state()).research).toEqual(research);
  });
});
it('does not invent exact proof for old consent-free ledger history', async () => {
  const f = await fixture(false);
  await researchSpeedup(db, f.wallet, 'giant', f.request.idempotencyKey, now);
  expect((await getResearchSpeedupReceipt(db, f.wallet, f.request)).status).toBe('unknown');
  await expect(f.finish()).rejects.toMatchObject({ code: 'RESEARCH_RECEIPT_INVALID' });
});
it('fails closed on plausible metadata with the wrong sink or original terms', async () => {
  const f = await fixture(false); const sys = await bootstrapSystemAccounts(db);
  const debit = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
  for (const variant of ['wrong-sink', 'wrong-request', 'malformed'] as const) {
    const request = { ...f.request, idempotencyKey: randomUUID() };
    await postTransaction(db, { idempotencyKey: researchSpeedupLedgerKey(f.wallet, request.idempotencyKey), type: 'research.speedup',
      entries: [{ account: debit.id, delta: -cost }, { account: variant === 'wrong-sink' ? sys.league_pool : sys.emission_pool, delta: cost }],
      metadata: { wallet: f.wallet, recycled: true, troop: 'giant', toLevel: 2, remSec: TROOP_LEVELING.researchTimeSec[0],
        researchSpeedup: variant === 'malformed' ? { version: 1 } : { version: 1, request: variant === 'wrong-request' ? { ...request, episodeId: randomUUID() } : request } } });
    expect((await getResearchSpeedupReceipt(db, f.wallet, request)).status).toBe('unknown');
  }
});
it('GET uses private authentication, rejects scope injection, and never mutates paused history', async () => {
  const f = await fixture(false, 'GEMS'); await f.finish();
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  process.env['GEMS_ENABLED'] = 'false'; process.env['FREE_ONBOARDING'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
  const app = await buildApp(TEST_CONFIG, db); const url = researchSpeedupReceiptPath(f.request);
  // Changing the read mode after boot exercises recovery without attempting the
  // unrelated deployment census/observer activation ceremony in this fixture.
  process.env['MULTI_BASE_ENABLED'] = 'true';
  const before = await db.select().from(accounts); const txns = await db.select().from(ledgerTransactions);
  try {
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const reply = await app.inject({ method: 'GET', url, cookies });
    expect(reply.statusCode, reply.body).toBe(200); expect(reply.json().status).toBe('accepted');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: `${url}&wallet=${f.wallet}`, cookies })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: url.replace('currentLevel=1', 'currentLevel=oops'), cookies })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url, cookies, headers: { 'x-pkw-expected-currency': 'GEMS' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/army/research/speedup', cookies, headers: { 'x-pkw-expected-currency': 'gems' }, payload: {} })).statusCode).toBe(400);
    expect(await db.select().from(accounts)).toEqual(before); expect(await db.select().from(ledgerTransactions)).toEqual(txns);
  } finally { await app.close(); }
});

it('rejects malformed exact POST consent as400 before any debit or completion', async () => {
  const f = await fixture(false); process.env['FREE_ONBOARDING'] = 'true';
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const app = await buildApp(TEST_CONFIG, db); const before = await f.balances(); const research = (await f.state()).research;
  try {
    for (const consent of [{ ...f.consent, maxCostKeep: '0' }, { ...f.consent, maxCostKeep: '9223372036854775808' }, { ...f.consent, toLevel: 3 }]) {
      const reply = await app.inject({ method: 'POST', url: '/army/research/speedup', cookies,
        headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: { troop: 'giant', idempotencyKey: f.request.idempotencyKey, consent } });
      expect(reply.statusCode, reply.body).toBe(400);
    }
    expect(await f.balances()).toEqual(before); expect((await f.state()).research).toEqual(research);
    expect((await getResearchSpeedupReceipt(db, f.wallet, f.request)).status).toBe('unknown');
    await f.finish(); const acceptedBalances = await f.balances();
    const acceptedRows = await db.select().from(ledgerTransactions);
    const replay = await app.inject({ method: 'POST', url: '/army/research/speedup', cookies,
      headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: { troop: 'giant', idempotencyKey: f.request.idempotencyKey, consent: f.consent } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ cost: '0', troop: 'giant', toLevel: 2 });
    expect(await f.balances()).toEqual(acceptedBalances);
    expect(await db.select().from(ledgerTransactions)).toEqual(acceptedRows);
  } finally { await app.close(); }
});
