/** Mounted HTTP and durable SQL with real finalized-reader semantics over
 * fixture account/transaction bytes. No live RPC or source authority is mocked. */
import { randomUUID } from 'node:crypto';
import { Keypair, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, buildings, mineAccrualStates, sessions } from '../src/db/schema';
import {MINE_DAY_MS} from '../src/game/baseMining';
import {DAILY_CACHE} from '@shardkeep/shared';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import { createTestPlayer, TEST_CONFIG } from './helpers';

const conn = resourceClaimsDatabase(), db = conn.db, now = new Date('2035-01-01T01:00:00.000Z');
const servers: FastifyInstance[] = [];
let bank: Awaited<ReturnType<typeof createMiningTermFixture>>;
const connect = vi.fn((signal: AbortSignal) => bank.connect(signal));
const deedReader = vi.fn(async () => { throw Error('Fixture deed reader is unavailable'); });
beforeAll(async () => {
  await conn.setup();
  bank = await createMiningTermFixture({ day: '2035-01-01', genesisHash: Keypair.generate().publicKey, programId: Keypair.generate().publicKey });
  bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now / 1000), 32);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.stubEnv('FREE_ONBOARDING', 'true');
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  connect.mockClear(); deedReader.mockClear();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(app => app.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
afterAll(() => conn.close());
async function open(provider = true) {
  const previous = process.env['MULTI_BASE_ENABLED']; process.env['MULTI_BASE_ENABLED'] = 'false';
  try {
    const app = await buildApp(TEST_CONFIG, db, {
      ...(provider ? { starterExpeditionProvider: { policy: bank.policy, connect } } : {}),
      market: { finalizedDeedReader: deedReader, deedCollection: Keypair.generate().publicKey.toBase58() },
    });
    servers.push(app); await app.ready(); return app;
  } finally {
    if (previous === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = previous;
  }
}
async function cookie(wallet: string) {
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(+now + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}
async function fixture() {
  const player = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: player.wallet, status: 'active', keepLevel: 1 }).returning();
  await db.insert(baseSlots).values({ wallet: player.wallet, slot: 1, baseId: base!.id });
  const [mine] = await db.insert(buildings).values({ playerWallet: player.wallet, baseId: base!.id, type: 'mine', level: 1, tx: 1, ty: 1 }).returning();
  await db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: now, accruedShards: 0n });
  return { wallet: player.wallet, base: base!, mine: mine!, request: { idempotencyKey: randomUUID(), baseId: base!.id }, cookies: await cookie(player.wallet) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (app: FastifyInstance, f: Fixture, payload: object = {baseId:f.base.id}) => app.inject({method:'POST',url:'/mine/claim',cookies:f.cookies,payload});
const rows = (f:Fixture)=>conn.sql`select * from shards_cache_sources where base_id=${f.base.id}`;
const gross=BigInt(DAILY_CACHE.firstWeekStepShards);

describe.sequential('mounted daily cache original earning',()=>{
 it('authenticates and preserves server-owned earning authority even when extra client amounts and term are supplied',async()=>{
  const f=await fixture(),app=await open();
  expect((await app.inject({method:'POST',url:'/mine/claim',payload:{baseId:f.base.id}})).statusCode).toBe(401);
  const response=await post(app,f,{baseId:f.base.id,wallet:Keypair.generate().publicKey.toBase58(),gross:'999999',term:{},earnedAt:'2100-01-01T00:00:00.000Z'});
  expect(response.statusCode,response.body).toBe(200);expect(response.json()).toEqual({amount:gross.toString(),streakDays:1,everCompletedWeek1:false});
  expect(await rows(f)).toHaveLength(0);expect(connect).not.toHaveBeenCalled();
  const entries=await conn.sql`select a.kind,e.delta::text from ledger_entries e join accounts a on a.id=e.account_id join ledger_transactions t on t.id=e.txn_id where t.idempotency_key=${`cache.claim:${f.base.id}:${now.toISOString().slice(0,10)}`} order by a.kind::text`;
  expect(entries).toEqual([{kind:'base_shards',delta:gross.toString()},{kind:'shard_genesis',delta:(-gross).toString()}]);
 });
 it('does not grant a second earning after a lost reply and providerless restart',async()=>{
  const f=await fixture(),app=await open();expect((await post(app,f)).statusCode).toBe(200);
  expect((await post(app,f)).statusCode).toBe(422);expect(await rows(f)).toHaveLength(0);
  const restarted=await open(false);vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.setSystemTime(new Date(+now+MINE_DAY_MS));
  expect((await post(restarted,f)).statusCode).toBe(200);expect(await rows(f)).toHaveLength(0);
  expect(await conn.sql`select balance::text from accounts where kind='base_shards' and base_id=${f.base.id}`).toEqual([{balance:(3n*gross).toString()}]);
 });
 it('pays without a finalized provider but refuses a foreign destination',async()=>{
  const f=await fixture(),app=await open(false);expect((await post(app,f)).statusCode).toBe(200);expect(await rows(f)).toHaveLength(0);expect(connect).not.toHaveBeenCalled();
  const foreign=await fixture();expect((await post(app,f,{baseId:foreign.base.id})).statusCode).toBe(404);expect(await rows(foreign)).toHaveLength(0);
  expect(await conn.sql`select base_id from base_streaks where base_id=${f.base.id}`).toHaveLength(1);
 });
 it('checks active custody even though exempt rewards do not read a term',async()=>{
  const f=await fixture(),app=await open();await db.update(bases).set({status:'inactive'}).where(eq(bases.id,f.base.id));
  expect((await post(app,f)).statusCode).toBe(404);expect(connect).not.toHaveBeenCalled();expect(await rows(f)).toHaveLength(0);
 });
 it('keeps never-admitted flag-off cache behavior and never opens a term provider',async()=>{
  const f=await fixture(),app=await open();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const response=await post(app,f);expect(response.statusCode,response.body).toBe(200);expect(response.json().amount).toBe(gross.toString());expect(await rows(f)).toHaveLength(0);expect(connect).not.toHaveBeenCalled();
 });
});
