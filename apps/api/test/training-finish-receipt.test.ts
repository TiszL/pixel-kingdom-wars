/** Paid Finish All may recover only its original queue, never consume a later queue. */
import { randomUUID } from 'node:crypto';
import { speedupCostKeep } from '@shardkeep/shared';
import { trainingFinishReceiptPath, type TrainingFinishIntent } from '@shardkeep/shared/trainingFinish';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, baseTrainingQueue, trainingQueue, ledgerTransactions, accounts, sessions } from '../src/db/schema';
import { getArmyState, trainSpeedup } from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { getTrainingFinishReceipt, trainingFinishLedgerKey, trainingFinishResult } from '../src/game/trainingFinishReceipt';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';
const conn = connectTestDb(), db = conn.db;
const now = new Date('2026-09-21T10:00:00.000Z'), later = (s: number) => new Date(now.getTime() + s * 1000);
const env = ['MULTI_BASE_ENABLED', 'GEMS_ENABLED', 'FREE_ONBOARDING'] as const;
const old = Object.fromEntries(env.map(k => [k, process.env[k]]));
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { for (const k of env) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } await conn.sql.end(); });
async function fixture(stable: boolean, currency: 'KEEP' | 'GEMS' = 'KEEP') {
  process.env['MULTI_BASE_ENABLED'] = String(stable); process.env['GEMS_ENABLED'] = 'true';
  const { wallet } = await createTestPlayer(db); await fundTestKeep(db, wallet, 1_000_000n, 'test.training.keep', randomUUID());
  if (currency === 'GEMS') await convertKeepToGems(db, wallet, 10_000n, randomUUID());
  let baseId: string | undefined;
  if (stable) { const [base] = await db.insert(bases).values({ ownerWallet: wallet, keepLevel: 8, deedAssetId: randomUUID(), landPaidAt: now }).returning();
    baseId = base!.id; await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  } else await ensureStartingBase(db, wallet);
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  const add = async (end = 120) => {
    const values = { troop: 'bowman' as const, startedAt: now, finishesAt: later(end) };
    return stable ? (await db.insert(baseTrainingQueue).values({ ...values, baseId: baseId! }).returning())[0]!
      : (await db.insert(trainingQueue).values({ ...values, playerWallet: wallet }).returning())[0]!;
  };
  const rows = [await add(60), await add(120)];
  const state = (at = now) => getArmyState(db, wallet, at, baseId);
  const consent = (await state()).finishAllQuote;
  const request: TrainingFinishIntent = { baseId: baseId ?? null, idempotencyKey: randomUUID(), expectedCurrency: currency, consent };
  const lookup = { baseId: request.baseId, idempotencyKey: request.idempotencyKey };
  const balances = async () => Promise.all(['player_keep', 'player_gems'].map(async kind => (await getOrCreatePlayerAccount(db, wallet, kind as 'player_keep' | 'player_gems')).balance));
  const finish = (change: Partial<TrainingFinishIntent> = {}, at = now) => {
    const r = { ...request, ...change }; return withClientCurrencyContext({ currency: undefined, expectedCurrency: r.expectedCurrency }, () => trainSpeedup(db, wallet, r.idempotencyKey, at, context, r.consent));
  };
  return { wallet, baseId, context, rows, add, state, request, lookup, balances, finish };
}
for (const stable of [false, true]) describe(`immutable training receipt (${stable ? 'deed' : 'legacy'})`, () => {
  it.each(['KEEP', 'GEMS'] as const)('charges %s once and never finishes or quest-credits a replacement queue on replay', async currency => {
    const f = await fixture(stable, currency), before = await f.balances(); const cost = BigInt(f.request.consent.maxCostKeep);
    const results = await Promise.all([f.finish(), f.finish()]);
    expect(results.map(r => r.cost).sort()).toEqual([0n, cost].sort());
    expect((await f.state()).features.trainingFinishReceipts).toEqual({ version: 1 });
    const proof = await getTrainingFinishReceipt(db, f.wallet, f.lookup);
    expect(proof).toMatchObject({ status: 'accepted', request: f.request, funding: { currency, amount: cost.toString() }, result: { completed: [{ troop: 'bowman', count: 2 }] } });
    const next = await f.add(180);
    if (stable) { const buyer = await createTestPlayer(db); await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId!)); await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, f.baseId!)); }
    process.env['GEMS_ENABLED'] = 'false';
    expect(await f.finish({}, later(240))).toEqual({ cost: 0n, completed: [{ troop: 'bowman', count: 2 }] });
    expect(await getTrainingFinishReceipt(db, f.wallet, f.lookup)).toEqual(proof);
    const [saved] = stable ? await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.id, next.id)) : await db.select().from(trainingQueue).where(eq(trainingQueue.id, next.id));
    expect(saved!.completedAt).toBeNull();
    const after = await f.balances(); expect(after[currency === 'KEEP' ? 0 : 1]).toBe(before[currency === 'KEEP' ? 0 : 1]! - cost);
    expect(after[currency === 'KEEP' ? 1 : 0]).toBe(before[currency === 'KEEP' ? 1 : 0]);
  });
  it('excludes naturally completed quoted rows and records the lower actual charge', async () => {
    const f = await fixture(stable, 'GEMS'); const result = await f.finish({}, later(60));
    expect(result).toEqual({ cost: BigInt(speedupCostKeep(60)), completed: [{ troop: 'bowman', count: 1 }] });
    const proof = await getTrainingFinishReceipt(db, f.wallet, f.lookup);
    expect(proof).toMatchObject({ status: 'accepted', request: f.request, funding: { amount: result.cost.toString() }, result: { paidRows: [{ id: f.rows[1]!.id }], completed: result.completed } });
    expect((await f.state(later(60))).counts.bowman).toBe(2);
  });
  it('gives an exact first command typed no-training proof without a debit or paid receipt', async () => {
    const f = await fixture(stable), before = await f.balances();
    await expect(f.finish({}, later(120))).rejects.toMatchObject({ statusCode: 404, code: 'TRAINING_NOT_RUNNING' });
    expect(await f.balances()).toEqual(before);
    expect((await getTrainingFinishReceipt(db, f.wallet, f.lookup)).status).toBe('unknown');
    expect((await f.state(later(120))).counts.bowman).toBe(2);
  });
  it('binds proof to original wallet/base/key and refuses changed replay consent or currency', async () => {
    const f = await fixture(stable); await f.finish(); const other = await createTestPlayer(db);
    for (const [wallet, lookup] of [[other.wallet, f.lookup], [f.wallet, { ...f.lookup, baseId: randomUUID() }], [f.wallet, { ...f.lookup, idempotencyKey: randomUUID() }]] as const)
      expect((await getTrainingFinishReceipt(db, wallet, lookup)).status).toBe('unknown');
    for (const change of [{ expectedCurrency: 'GEMS' as const }, { consent: { ...f.request.consent, maxCostKeep: '9999' } }, { consent: { ...f.request.consent, queue: f.request.consent.queue.slice(1) } }])
      await expect(f.finish(change)).rejects.toMatchObject({ code: 'TRAINING_FINISH_RECEIPT_INVALID' });
  });
  it('refuses new price/queue/currency changes without debit or finishing any row', async () => {
    const f = await fixture(stable), before = await f.balances();
    await expect(f.finish({ consent: { ...f.request.consent, maxCostKeep: '1' } })).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    await expect(f.finish({ expectedCurrency: 'GEMS' })).rejects.toMatchObject({ code: 'CURRENCY_CONSENT_CHANGED' });
    await f.add(180); await expect(f.finish()).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    expect(await f.balances()).toEqual(before); expect((await f.state()).queue).toHaveLength(3);
    expect((await getTrainingFinishReceipt(db, f.wallet, f.lookup)).status).toBe('unknown');
  });
});
it('keeps old paid history unproven and refuses modern collisions without completing later troops', async () => {
  const f = await fixture(false); await trainSpeedup(db, f.wallet, f.request.idempotencyKey, now, undefined, f.request.consent);
  expect((await getTrainingFinishReceipt(db, f.wallet, f.lookup)).status).toBe('unknown');
  await f.add(180); await expect(f.finish()).rejects.toMatchObject({ code: 'TRAINING_FINISH_RECEIPT_INVALID' });
  expect((await f.state()).queue).toHaveLength(1);
});
it('rejects invented metadata whose entries or completed rows do not prove the payment', async () => {
  const f = await fixture(false), sys = await bootstrapSystemAccounts(db); const debit = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
  for (const variant of ['sink', 'ceiling', 'rows', 'natural'] as const) {
    const request = { ...f.request, idempotencyKey: randomUUID() }; const cost = BigInt(request.consent.maxCostKeep);
    const result = trainingFinishResult(f.rows, now);
    await postTransaction(db, { idempotencyKey: trainingFinishLedgerKey(f.wallet, request.idempotencyKey), type: 'train.speedup',
      entries: [{ account: debit.id, delta: -(variant === 'ceiling' ? cost + 1n : cost) }, { account: variant === 'sink' ? sys.league_pool : sys.emission_pool, delta: variant === 'ceiling' ? cost + 1n : cost }],
      metadata: { wallet: f.wallet, recycled: true, rows: variant === 'rows' ? 3 : 2, remSec: 120,
        trainingFinish: { version: 1, request, result: variant === 'natural' ? { ...result, completedAt: later(120).toISOString() } : result } } });
    expect((await getTrainingFinishReceipt(db, f.wallet, { baseId: null, idempotencyKey: request.idempotencyKey })).status).toBe('unknown');
  }
});
it('serves authenticated no-store historical proof under pause and rejects scope injection/unsafe POST consent', async () => {
  const f = await fixture(false); process.env['FREE_ONBOARDING'] = 'true';
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const app = await buildApp(TEST_CONFIG, db), url = trainingFinishReceiptPath(f.lookup); const before = await f.balances();
  try {
    for (const change of [{ maxCostKeep: '0' }, { version: '2' }, { maxCostKeep: '9223372036854775808' }]) {
      const reply = await app.inject({ method: 'POST', url: '/army/train/speedup', cookies, headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: { idempotencyKey: f.request.idempotencyKey, consent: { ...f.request.consent, ...change } } });
      expect(reply.statusCode, reply.body).toBe(400);
    }
    const scoped = await app.inject({ method: 'POST', url: '/army/train/speedup', cookies, headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: { idempotencyKey: f.request.idempotencyKey, baseId: randomUUID(), consent: f.request.consent } });
    expect(scoped.statusCode, scoped.body).toBe(409); expect(scoped.json().error.code).toBe('TRAINING_FINISH_SCOPE_CHANGED');
    expect(await f.balances()).toEqual(before);
    const accepted = await app.inject({ method: 'POST', url: '/army/train/speedup', cookies, headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: { idempotencyKey: f.request.idempotencyKey, consent: f.request.consent } });
    // The fixture clock is historic, so no new paid work may be claimed now.
    expect(accepted.statusCode, accepted.body).toBe(404); expect(accepted.json().error.code).toBe('TRAINING_NOT_RUNNING');
    await f.finish();
    process.env['GEMS_ENABLED'] = 'false'; process.env['FREE_ONBOARDING'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'true';
    const savedAccounts = await db.select().from(accounts), savedTransactions = await db.select().from(ledgerTransactions);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const reply = await app.inject({ method: 'GET', url, cookies }); expect(reply.statusCode, reply.body).toBe(200); expect(reply.json().status).toBe('accepted'); expect(reply.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: `${url}&wallet=${f.wallet}`, cookies })).statusCode).toBe(400);
    expect(await db.select().from(accounts)).toEqual(savedAccounts); expect(await db.select().from(ledgerTransactions)).toEqual(savedTransactions);
  } finally { await app.close(); }
});
