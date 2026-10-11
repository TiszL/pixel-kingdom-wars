/** K-157: a last GET is not debit consent. The winning ledger post must bind
 * its output to the reviewed terms; historical receipts win before new rules. */
import { randomUUID } from 'node:crypto';
import { GEMS, GEMS_TASKS, type GemsTaskSpec } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { ledgerTransactions, sessions } from '../src/db/schema';
import { convertKeepToGems } from '../src/game/gems';
import { fundGemsRewardBudget, grantKey } from '../src/game/gemsGrants';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), db = conn.db;
let app: FastifyInstance;
const priorFlag = process.env['GEMS_ENABLED'], priorMulti = process.env['MULTI_BASE_ENABLED'];
const tasks = GEMS_TASKS as Record<string, GemsTaskSpec>;
const task = 'k157-consent-fixture';
const rates = GEMS as { gemsPerKeep: number; shardsPerGem: number; minConvertKeep: number };
beforeAll(async () => {
  process.env['GEMS_ENABLED'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'false';
  await bootstrapSystemAccounts(db); await fundGemsRewardBudget(db, 100n, randomUUID());
  app = await buildApp(TEST_CONFIG, db); await app.ready();
});
afterAll(async () => {
  delete tasks[task]; await app.close(); await conn.sql.end();
  if (priorFlag === undefined) delete process.env['GEMS_ENABLED']; else process.env['GEMS_ENABLED'] = priorFlag;
  if (priorMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = priorMulti;
});
async function signedIn(keep = 30n) {
  const { wallet } = await createTestPlayer(db);
  if (keep > 0n) await fundTestKeep(db, wallet, keep, 'test.fund', randomUUID());
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { wallet, cookies: { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) } };
}
const balance = async (wallet: string, kind: 'player_keep' | 'player_gems' | 'player_shards') =>
  (await getOrCreatePlayerAccount(db, wallet, kind)).balance;
const post = (path: string, cookies: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: path, cookies, payload: payload as object });
const get = (path: string, cookies: Record<string, string>) => app.inject({ method: 'GET', url: path, cookies });
const posted = async (key: string) => db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key));

describe('exact Gems consent', () => {
  it('advertises exact consent only with the enabled Gems capability and feature', async () => {
    const { cookies } = await signedIn();
    expect((await get('/gems', cookies)).json()).toMatchObject({ features: { gems: { exactConsent: 1 } } });
    expect((await get('/native/capabilities', cookies)).json()).toMatchObject({ economy: { gems: { enabled: true, exactConsent: 1 } } });
    try {
      process.env['GEMS_ENABLED'] = 'false';
      expect((await get('/native/capabilities', cookies)).json().economy.gems).not.toHaveProperty('exactConsent');
    } finally { process.env['GEMS_ENABLED'] = 'true'; }
  });

  it('rejects a KEEP conversion repriced after its final GET, with no debit or consumed key', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const overview = (await get('/gems', cookies)).json(); const rate = rates.gemsPerKeep;
    const body = { keep: '10', idempotencyKey: key, expected: { rate: overview.gemsPerKeep, output: String(10 * overview.gemsPerKeep) } };
    try {
      rates.gemsPerKeep = rate + 1;
      const rejected = await post('/gems/from-keep', cookies, body);
      expect(rejected.statusCode).toBe(409); expect(rejected.json()).toMatchObject({ error: { code: 'GEMS_TERMS_CHANGED' } });
      expect([await balance(wallet, 'player_keep'), await balance(wallet, 'player_gems')]).toEqual([30n, 0n]);
      expect(await posted(`gems:from-keep:${wallet}:${key}`)).toEqual([]);
    } finally { rates.gemsPerKeep = rate; }
    expect((await post('/gems/from-keep', cookies, body)).statusCode).toBe(201);
    expect((await get(`/gems/from-keep/by-key/${key}`, cookies)).json()).toMatchObject({
      receipt: { request: body, result: { gems: body.expected.output, rate } } });
  });

  it('rejects a SHARDS conversion repriced after its final GET, preserving both balances and retry key', async () => {
    const { wallet, cookies } = await signedIn(); await convertKeepToGems(db, wallet, 20n, randomUUID());
    const overview = (await get('/gems', cookies)).json(); const rate = rates.shardsPerGem; const key = randomUUID();
    const body = { gems: '5', idempotencyKey: key, expected: { rate: overview.shardsPerGem, output: String(5 * overview.shardsPerGem) } };
    try {
      rates.shardsPerGem = rate + 1;
      const rejected = await post('/gems/to-shards', cookies, body);
      expect(rejected.statusCode).toBe(409); expect(rejected.json()).toMatchObject({ error: { code: 'GEMS_TERMS_CHANGED' } });
      expect([await balance(wallet, 'player_gems'), await balance(wallet, 'player_shards')]).toEqual([20n, 0n]);
      expect(await posted(`gems:to-shards:${wallet}:${key}`)).toEqual([]);
    } finally { rates.shardsPerGem = rate; }
    expect((await post('/gems/to-shards', cookies, body)).statusCode).toBe(201);
    expect((await get(`/gems/to-shards/receipt?idempotencyKey=${key}&gems=5`, cookies)).json()).toMatchObject({ request: body });
  });

  it('rejects a changed task reward before a grant and permits the same saved intent when terms return', async () => {
    const { wallet, cookies } = await signedIn(0n); const key = randomUUID();
    tasks[task] = { title: 'Consent fixture', gems: 5, active: true, oncePerWallet: true };
    const catalogue = (await get('/gems/tasks', cookies)).json() as Array<{ id: string; gems: number }>;
    const body = { idempotencyKey: key, expected: { rate: null, output: String(catalogue.find((t) => t.id === task)!.gems) } };
    try {
      tasks[task] = { title: 'Changed fixture', gems: 6, active: true, oncePerWallet: true };
      const rejected = await post(`/gems/tasks/${task}/claim`, cookies, body);
      expect(rejected.statusCode).toBe(409); expect(rejected.json()).toMatchObject({ error: { code: 'GEMS_TERMS_CHANGED' } });
      expect(await balance(wallet, 'player_gems')).toBe(0n); expect(await posted(grantKey('task', wallet, task))).toEqual([]);
      tasks[task] = { title: 'Original fixture', gems: 5, active: true, oncePerWallet: true };
      expect((await post(`/gems/tasks/${task}/claim`, cookies, body)).statusCode).toBe(201);
      expect((await get(`/gems/tasks/${task}/claim/by-key/${key}`, cookies)).json()).toMatchObject({ receipt: { request: { ...body, taskId: task }, result: { gems: '5' } } });
    } finally { delete tasks[task]; }
  });

  it('replays accepted conversion outputs before changed rates and new conversion bounds', async () => {
    const { wallet, cookies } = await signedIn(); const fromKey = randomUUID(), shardsKey = randomUUID();
    const from = { keep: '10', idempotencyKey: fromKey, expected: { rate: rates.gemsPerKeep, output: '10' } };
    const shards = { gems: '3', idempotencyKey: shardsKey, expected: { rate: rates.shardsPerGem, output: '3' } };
    const first = (await post('/gems/from-keep', cookies, from)).json(); const second = (await post('/gems/to-shards', cookies, shards)).json();
    const previous = { ...rates };
    try {
      rates.gemsPerKeep++; rates.shardsPerGem++; rates.minConvertKeep = 100;
      expect((await post('/gems/from-keep', cookies, from)).json()).toMatchObject({ receiptId: first.receiptId, gems: '10', rate: from.expected.rate, duplicate: true });
      expect((await post('/gems/to-shards', cookies, shards)).json()).toMatchObject({ receiptId: second.receiptId, shards: '3', rate: shards.expected.rate, duplicate: true });
      expect([await balance(wallet, 'player_keep'), await balance(wallet, 'player_gems'), await balance(wallet, 'player_shards')]).toEqual([20n, 7n, 3n]);
    } finally { Object.assign(rates, previous); }
  });

  it('replays an accepted task after reward changes or removal, retaining the once-per-task identity', async () => {
    const { wallet, cookies } = await signedIn(0n); const key = randomUUID();
    tasks[task] = { title: 'Original', gems: 5, active: true, oncePerWallet: true };
    const body = { idempotencyKey: key, expected: { rate: null, output: '5' } };
    try {
      const first = (await post(`/gems/tasks/${task}/claim`, cookies, body)).json();
      tasks[task] = { title: 'Changed', gems: 8, active: true, oncePerWallet: true };
      expect((await post(`/gems/tasks/${task}/claim`, cookies, body)).json()).toMatchObject({ receiptId: first.receiptId, gems: 5, duplicate: true });
      delete tasks[task];
      expect((await post(`/gems/tasks/${task}/claim`, cookies, body)).json()).toMatchObject({ receiptId: first.receiptId, gems: 5, duplicate: true });
      expect((await post(`/gems/tasks/${task}/claim`, cookies, { ...body, idempotencyKey: randomUUID() })).json()).toMatchObject({ error: { code: 'CLAIM_ALREADY_SETTLED' } });
      expect(await balance(wallet, 'player_gems')).toBe(5n);
    } finally { delete tasks[task]; }
  });

  it('retains exact consent as command identity without preventing original GET recovery', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const body = { keep: '5', idempotencyKey: key, expected: { rate: 1, output: '5' } };
    expect((await post('/gems/from-keep', cookies, body)).statusCode).toBe(201);
    for (const payload of [{ keep: '5', idempotencyKey: key }, { ...body, expected: { rate: 2, output: '10' } }]) {
      const response = await post('/gems/from-keep', cookies, payload);
      expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_BODY_MISMATCH' } });
    }
    expect((await get(`/gems/from-keep/by-key/${key}`, cookies)).json()).toMatchObject({ receipt: { request: body } });
    expect(await balance(wallet, 'player_gems')).toBe(5n);
  });

  it('keeps old clients unguarded and old receipts readable for all three operations', async () => {
    const { wallet, cookies } = await signedIn(); const fromKey = randomUUID(), shardsKey = randomUUID(), taskKey = randomUUID();
    tasks[task] = { title: 'Legacy', gems: 2, active: true, oncePerWallet: true };
    try {
      expect((await post('/gems/from-keep', cookies, { keep: '10', idempotencyKey: fromKey })).statusCode).toBe(201);
      expect((await post('/gems/to-shards', cookies, { gems: '4', idempotencyKey: shardsKey })).statusCode).toBe(201);
      expect((await post(`/gems/tasks/${task}/claim`, cookies, { idempotencyKey: taskKey })).statusCode).toBe(201);
      expect((await get(`/gems/from-keep/by-key/${fromKey}`, cookies)).json().receipt.request).not.toHaveProperty('expected');
      expect((await get(`/gems/to-shards/receipt?idempotencyKey=${shardsKey}&gems=4`, cookies)).json().request).not.toHaveProperty('expected');
      expect((await get(`/gems/tasks/${task}/claim/by-key/${taskKey}`, cookies)).json().receipt.request).not.toHaveProperty('expected');
      expect((await post('/gems/from-keep', cookies, { keep: '10', idempotencyKey: fromKey, expected: { rate: 1, output: '10' } })).json()).toMatchObject({ error: { code: 'IDEMPOTENCY_BODY_MISMATCH' } });
      expect(await balance(wallet, 'player_gems')).toBe(8n);
    } finally { delete tasks[task]; }
  });

  it('keeps task claims once-only when two different keys race with the same exact terms', async () => {
    const { wallet, cookies } = await signedIn(0n); tasks[task] = { title: 'Race', gems: 3, active: true, oncePerWallet: true };
    try {
      const results = await Promise.all([randomUUID(), randomUUID()].map((key) => post(`/gems/tasks/${task}/claim`, cookies,
        { idempotencyKey: key, expected: { rate: null, output: '3' } })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await balance(wallet, 'player_gems')).toBe(3n); expect(await posted(grantKey('task', wallet, task))).toHaveLength(1);
    } finally { delete tasks[task]; }
  });

  it.each([{ rate: null, output: '1' }, { rate: '1', output: '1' }, { rate: 0, output: '1' },
    { rate: 1.5, output: '1' }, { rate: Number.MAX_SAFE_INTEGER + 1, output: '1' },
    { rate: 1, output: '01' }, { rate: 1, output: '0' }, { rate: 1, output: '1.0' },
    { rate: 1, output: 1 }, { rate: 1 }, { rate: 1, output: '1', ignored: true }])('rejects malformed conversion consent %j before any posting', async (expected) => {
    const { wallet, cookies } = await signedIn();
    for (const path of ['/gems/from-keep', '/gems/to-shards']) {
      const key = randomUUID();
      expect((await post(path, cookies, { keep: '1', gems: '1', idempotencyKey: key, expected })).statusCode).toBe(400);
    }
    expect([await balance(wallet, 'player_keep'), await balance(wallet, 'player_gems')]).toEqual([30n, 0n]);
  });

  it('requires null task rate and canonical output even before checking an unknown task', async () => {
    const { cookies } = await signedIn();
    for (const expected of [{ rate: 1, output: '1' }, { rate: null, output: '01' }, { rate: null, output: '1', extra: true }]) {
      expect((await post(`/gems/tasks/${task}/claim`, cookies, { idempotencyKey: randomUUID(), expected })).statusCode).toBe(400);
    }
  });
});
