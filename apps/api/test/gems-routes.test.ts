/**
 * The /gems/* route family and its neighbours (E2-GEMS-CONTRACT §2; D-152).
 *
 * WHY: installed clients recover interrupted money operations ONLY through
 * definitive status codes and receipt routes (MoneyOp: 400/401/403/404/409/
 * 422/429). Every code here is therefore pinned, the dark gate must answer
 * 503 only AFTER authentication (never a flag oracle), `/forge/convert` must
 * retire with 409 (a code-25 client would loop on 410/423), and `/balances`
 * must swap `features.conversionReceipts` for `features.gems` so a code-25
 * `validate` step refuses the retired rail before any request is sent.
 */
import { randomUUID } from 'node:crypto';
import { GEMS } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { fundGemsRewardBudget, grantGems } from '../src/game/gemsGrants';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;
const priorFlag = process.env['GEMS_ENABLED'];
const priorMulti = process.env['MULTI_BASE_ENABLED'];
beforeAll(async () => {
  process.env['GEMS_ENABLED'] = 'true';
  process.env['MULTI_BASE_ENABLED'] = 'false';
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (priorFlag === undefined) delete process.env['GEMS_ENABLED']; else process.env['GEMS_ENABLED'] = priorFlag;
  if (priorMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = priorMulti;
  await conn.sql.end();
});

async function signedIn(keep = 0n) {
  const { wallet } = await createTestPlayer(db);
  if (keep > 0n) await fundTestKeep(db, wallet, keep, 'test.fund', randomUUID());
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  return { wallet, cookies };
}
type Json = Record<string, unknown> & { error?: { code?: string; message?: string } };
const post = (url: string, cookies: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url, cookies, payload: payload as Record<string, unknown> });
const get = (url: string, cookies?: Record<string, string>) => app.inject({ method: 'GET', url, ...(cookies ? { cookies } : {}) });
const gemsOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_gems')).balance;
const keepOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;
const withFlag = async <T>(value: string | undefined, fn: () => Promise<T>) => {
  const prev = process.env['GEMS_ENABLED'];
  if (value === undefined) delete process.env['GEMS_ENABLED']; else process.env['GEMS_ENABLED'] = value;
  try { return await fn(); } finally { if (prev === undefined) delete process.env['GEMS_ENABLED']; else process.env['GEMS_ENABLED'] = prev; }
};

describe('gating', () => {
  it('recovers accepted debits and a historical task after a pause without admitting new operations', async () => {
    const { wallet, cookies } = await signedIn(20n);
    const other = await signedIn();
    const conversionKey = randomUUID();
    const shardsKey = randomUUID();
    const taskKey = randomUUID();
    expect((await post('/gems/from-keep', cookies, { keep: '10', idempotencyKey: conversionKey })).statusCode).toBe(201);
    expect((await post('/gems/to-shards', cookies, { gems: '3', idempotencyKey: shardsKey })).statusCode).toBe(201);
    // A retired task's receipt must survive independently of today's empty
    // catalogue; seed the same backed historical posting, not an active task.
    await fundGemsRewardBudget(db, 2n, randomUUID());
    await grantGems(db, { wallet, gems: 2n, reason: 'task', ref: 'retired-fixture', metadata: { idempotencyKey: taskKey } });
    const urls = [
      `/gems/from-keep/by-key/${conversionKey}`,
      `/gems/from-keep/receipt?idempotencyKey=${conversionKey}&keep=10`,
      `/gems/to-shards/receipt?idempotencyKey=${shardsKey}&gems=3`,
      `/gems/tasks/retired-fixture/claim/by-key/${taskKey}`,
    ];
    const before = await Promise.all(urls.map(async (url) => (await get(url, cookies)).json() as Json));
    await withFlag('false', async () => {
      for (const [index, url] of urls.entries()) {
        const recovered = await get(url, cookies);
        expect(recovered.statusCode).toBe(200);
        expect(recovered.headers['cache-control']).toBe('private, no-store');
        const proof = recovered.json() as Json;
        expect(proof).toMatchObject({ status: 'accepted' });
        // Envelopes carry a fresh serverNow; the immutable receipt is exact.
        expect(proof['receipt'] ?? proof).toEqual(before[index]!['receipt'] ?? before[index]);
        expect((await get(url)).statusCode).toBe(401);
        expect((await get(url, other.cookies)).json()).toMatchObject({ status: 'unknown' });
      }
      expect((await post('/gems/from-keep', cookies, { keep: '1', idempotencyKey: randomUUID() })).statusCode).toBe(503);
      expect((await post('/gems/to-shards', cookies, { gems: '1', idempotencyKey: randomUUID() })).statusCode).toBe(503);
      expect((await post('/gems/tasks/retired-fixture/claim', cookies, { idempotencyKey: randomUUID() })).statusCode).toBe(503);
      expect([await keepOf(wallet), await gemsOf(wallet)]).toEqual([10n, 9n]);
    });
  });

  it('authenticates BEFORE the dark gate: anonymous → 401, flag off → 503 PHASE_E_DISABLED, flag on → 200', async () => {
    const { cookies } = await signedIn();
    expect((await get('/gems')).statusCode).toBe(401);
    await withFlag(undefined, async () => {
      const off = await get('/gems', cookies);
      expect(off.statusCode).toBe(503);
      expect((off.json() as Json).error?.code).toBe('PHASE_E_DISABLED');
      expect((await post('/gems/from-keep', cookies, { keep: '1', idempotencyKey: randomUUID() })).statusCode).toBe(503);
    });
    const on = await get('/gems', cookies);
    expect(on.statusCode).toBe(200);
    expect(on.headers['cache-control']).toBe('private, no-store');
    expect(on.json()).toMatchObject({
      features: { gems: { version: 1, receipts: 1 } }, gems: '0', tasks: [], sources: ['ledger-keep'],
      minConvertKeep: GEMS.minConvertKeep, maxConvertKeepPerTx: GEMS.maxConvertKeepPerTx,
      gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem,
    });
  });

  it('/balances advertises exact consent in both modes; Gems replaces conversionReceipts only while on', async () => {
    const { cookies } = await signedIn(3n);
    const on = (await get('/balances', cookies)).json() as Json;
    expect(on).toMatchObject({ keep: '3', gems: '0', gemsRate: { gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem },
      features: { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } } });
    expect((on['features'] as Json)).not.toHaveProperty('conversionReceipts');
    await withFlag(undefined, async () => {
      const off = (await get('/balances', cookies)).json() as Json;
      expect(off).not.toHaveProperty('gems');
      expect(off).not.toHaveProperty('gemsRate');
      expect(off['features']).toMatchObject({ gameCurrency: { version: 1, exactSpendCurrency: 1 }, conversionReceipts: { version: 1 } });
      expect(off['features']).not.toHaveProperty('gems');
    });
  });

  it('/forge/convert answers 409 KEEP_CONVERSION_RETIRED (definitive) while on, and still converts while off', async () => {
    const { wallet, cookies } = await signedIn(4n);
    const on = await post('/forge/convert', cookies, { keep: '2', idempotencyKey: randomUUID() });
    expect(on.statusCode).toBe(409);
    expect((on.json() as Json).error?.code).toBe('KEEP_CONVERSION_RETIRED');
    expect(await keepOf(wallet)).toBe(4n);
    await withFlag(undefined, async () => {
      expect((await post('/forge/convert', cookies, { keep: '2', idempotencyKey: randomUUID() })).statusCode).toBe(201);
      expect(await keepOf(wallet)).toBe(2n);
    });
  });
});

describe('POST /gems/from-keep', () => {
  it('201 on first post, 200 replay, 409 on an amount mismatch, receipts by key and by query', async () => {
    const { wallet, cookies } = await signedIn(50n);
    const key = randomUUID();
    const first = await post('/gems/from-keep', cookies, { keep: '20', idempotencyKey: key });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ keep: '20', gems: '20', rate: GEMS.gemsPerKeep, duplicate: false, serverNow: expect.any(String) });
    const receiptId = (first.json() as Json)['receiptId'];
    const replay = await post('/gems/from-keep', cookies, { keep: '20', idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ receiptId, duplicate: true });
    const mismatch = await post('/gems/from-keep', cookies, { keep: '21', idempotencyKey: key });
    expect(mismatch.statusCode).toBe(409);
    expect((mismatch.json() as Json).error?.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    expect([await keepOf(wallet), await gemsOf(wallet)]).toEqual([30n, 20n]);

    const byKey = await get(`/gems/from-keep/by-key/${key}`, cookies);
    expect(byKey.statusCode).toBe(200);
    expect(byKey.headers['cache-control']).toBe('private, no-store');
    expect(byKey.json()).toMatchObject({ wallet, idempotencyKey: key, status: 'accepted',
      receipt: { version: 1, status: 'accepted', receiptId, request: { idempotencyKey: key, keep: '20' },
        funding: { currency: 'KEEP', amount: '20' }, result: { gems: '20', rate: GEMS.gemsPerKeep } } });
    const unknown = await get(`/gems/from-keep/by-key/${randomUUID()}`, cookies);
    expect(unknown.json()).toMatchObject({ status: 'unknown', receipt: null });
    const query = await get(`/gems/from-keep/receipt?idempotencyKey=${key}&keep=20`, cookies);
    expect(query.json()).toMatchObject({ status: 'accepted', receiptId });
    expect((await get(`/gems/from-keep/receipt?idempotencyKey=${key}&keep=19`, cookies)).json()).toMatchObject({ status: 'unknown' });
    // Another wallet never resolves this receipt.
    const other = await signedIn();
    expect((await get(`/gems/from-keep/by-key/${key}`, other.cookies)).json()).toMatchObject({ status: 'unknown' });
  });

  it('422 codes: below minimum, above maximum, insufficient custodial KEEP; 400 on a malformed body', async () => {
    const { wallet, cookies } = await signedIn(5n);
    const cases: Array<[unknown, number, string | undefined]> = [
      [{ keep: '0', idempotencyKey: randomUUID() }, 400, undefined],
      [{ keep: String(GEMS.maxConvertKeepPerTx + 1), idempotencyKey: randomUUID() }, 422, 'GEMS_PURCHASE_ABOVE_MAXIMUM'],
      [{ keep: '6', idempotencyKey: randomUUID() }, 422, 'INSUFFICIENT_KEEP'],
      [{ keep: '1', idempotencyKey: 'short' }, 400, undefined],
    ];
    for (const [payload, status, code] of cases) {
      const res = await post('/gems/from-keep', cookies, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
      if (code) expect((res.json() as Json).error?.code).toBe(code);
    }
    expect([await keepOf(wallet), await gemsOf(wallet)]).toEqual([5n, 0n]);
  });
});

describe('POST /gems/to-shards', () => {
  it('converts at the LOCKED rate into the wallet SHARDS pool, with a receipt; 422 INSUFFICIENT_GEMS otherwise', async () => {
    const { wallet, cookies } = await signedIn(30n);
    await post('/gems/from-keep', cookies, { keep: '30', idempotencyKey: randomUUID() });
    const key = randomUUID();
    const res = await post('/gems/to-shards', cookies, { gems: '12', idempotencyKey: key });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ gems: '12', shards: String(12 * GEMS.shardsPerGem), rate: GEMS.shardsPerGem, duplicate: false });
    expect(await gemsOf(wallet)).toBe(18n);
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance).toBeGreaterThanOrEqual(12n);
    const receipt = await get(`/gems/to-shards/receipt?idempotencyKey=${key}&gems=12`, cookies);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ status: 'accepted', wallet, baseId: null,
      funding: { currency: 'GEMS', amount: '12' }, result: { shards: '12', rate: GEMS.shardsPerGem } });
    expect((await get(`/gems/to-shards/receipt?idempotencyKey=${key}&gems=11`, cookies)).json()).toMatchObject({ status: 'unknown' });
    const short = await post('/gems/to-shards', cookies, { gems: '19', idempotencyKey: randomUUID() });
    expect(short.statusCode).toBe(422);
    expect((short.json() as Json).error?.code).toBe('INSUFFICIENT_GEMS');
    expect(await gemsOf(wallet)).toBe(18n);
  });
});

describe('tasks', () => {
  it('lists the (empty at launch) catalogue and refuses an unknown task with 404 TASK_UNKNOWN', async () => {
    const { wallet, cookies } = await signedIn();
    const list = await get('/gems/tasks', cookies);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    const claim = await post('/gems/tasks/no-such-task/claim', cookies, { idempotencyKey: randomUUID() });
    expect(claim.statusCode).toBe(404);
    expect((claim.json() as Json).error?.code).toBe('TASK_UNKNOWN');
    expect((await post('/gems/tasks/Bad%20Id/claim', cookies, { idempotencyKey: randomUUID() })).statusCode).toBe(400);
    expect((await get(`/gems/tasks/no-such-task/claim/by-key/${randomUUID()}`, cookies)).json()).toMatchObject({ status: 'unknown', receipt: null });
    expect(await gemsOf(wallet)).toBe(0n);
  });
});
