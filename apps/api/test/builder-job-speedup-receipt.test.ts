/** FINISH pays for one original episode; history never completes another job. */
import { randomUUID } from 'node:crypto';
import { OBSTACLES, speedupCostKeep } from '@shardkeep/shared';
import { builderJobSpeedupReceiptPath, type BuilderJobSpeedupIntent } from '@shardkeep/shared/builderJobSpeedup';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, builderJobs, buildings, obstacles, ledgerTransactions, sessions, players, questProgress, baseQuestProgress } from '../src/db/schema';
import { speedupJob, builderJobFinishCostKeep, upgradeBuilding, cancelUpgrade } from '../src/game/base';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { builderJobPaidQuote, builderJobSpeedupLedgerKey, getBuilderJobSpeedupReceipt } from '../src/game/builderJobSpeedupReceipt';
import * as spending from '../src/game/spend';
import * as questService from '../src/game/quests';
import { rewardBaseShards, getBaseShardBalance } from '../src/game/baseEconomy';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';
const conn = connectTestDb(), db = conn.db;
const now = new Date('2026-09-21T10:00:00.000Z'), later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const flags = ['MULTI_BASE_ENABLED', 'GEMS_ENABLED', 'FREE_ONBOARDING'] as const;
const lookup = (r: { jobId: string; baseId: string | null; idempotencyKey: string }) => ({ jobId:r.jobId, baseId:r.baseId, idempotencyKey:r.idempotencyKey });
const original = Object.fromEntries(flags.map(k => [k, process.env[k]]));
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { for (const key of flags) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } await conn.sql.end(); });
async function fixture(stable: boolean, currency: 'KEEP' | 'GEMS' = 'KEEP', kind: 'upgrade' | 'repair' | 'clear_obstacle' | 'build' = 'upgrade') {
  process.env['MULTI_BASE_ENABLED'] = String(stable); process.env['GEMS_ENABLED'] = 'true';
  const { wallet } = await createTestPlayer(db); await fundTestKeep(db, wallet, 100000n, 'test.builder.keep', randomUUID());
  if (currency === 'GEMS') await convertKeepToGems(db, wallet, 10000n, randomUUID());
  let baseId: string | undefined;
  if (stable) { const [base] = await db.insert(bases).values({ ownerWallet: wallet, keepLevel: 5 }).returning(); baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 }); }
  const context = baseId ? { baseId, assertAuthority: async () => {} } : undefined;
  const [building] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type: kind === 'repair' ? 'spiketrap' : 'vault', level: 1, tx: 10, ty: 10, ...(kind === 'repair' ? { trapSpentAt: now } : {}) }).returning();
  const [obstacle] = await db.insert(obstacles).values({ playerWallet: wallet, baseId, spriteKey: OBSTACLES.tiers.small.kinds[0], tx: 12, ty: 12 }).returning();
  const add = async () => (await db.insert(builderJobs).values({ playerWallet: wallet, baseId, kind,
    buildingId: kind === 'clear_obstacle' ? null : building!.id, obstacleId: kind === 'clear_obstacle' ? obstacle!.id : null,
    startedAt: now, finishesAt: later(120) }).returning())[0]!;
  const job = await add();
  const request: BuilderJobSpeedupIntent = { jobId: job.id, baseId: baseId ?? null, idempotencyKey: randomUUID(), expectedCurrency: currency,
    consent: builderJobPaidQuote(job, builderJobFinishCostKeep(job, now))! };
  const balance = async () => Promise.all(['player_keep','player_gems'].map(async kind => (await getOrCreatePlayerAccount(db, wallet, kind as 'player_keep'|'player_gems')).balance));
  const finish = (change: Partial<BuilderJobSpeedupIntent> = {}, at = now) => { const r = { ...request, ...change }; return withClientCurrencyContext({ currency: undefined, expectedCurrency: r.expectedCurrency },
    () => speedupJob(db, wallet, r.jobId, r.idempotencyKey, at, r.baseId ?? undefined, context, r.consent)); };
  return { wallet, baseId, context, building: building!, obstacle: obstacle!, job, request, balance, finish, add };
}
for (const stable of [false, true]) describe(`builder immutable paid proof (${stable ? 'base' : 'legacy mode'})`, () => {
  for (const kind of ['upgrade','repair','clear_obstacle'] as const) it.each(['KEEP','GEMS'] as const)(`${kind} spends %s once, preserves original deadline and replays after sale/pause`, async currency => {
    const f = await fixture(stable, currency, kind), before = await f.balance(); const cost = BigInt(f.request.consent.maxCostKeep);
    expect((await Promise.all([f.finish(),f.finish()])).map(r=>r.cost).sort()).toEqual([0n,cost].sort());
    const proof = await getBuilderJobSpeedupReceipt(db, f.wallet, lookup(f.request));
    expect(proof).toMatchObject({ status:'accepted', request:f.request, funding:{currency,amount:cost.toString()}, result:{ jobId:f.job.id, kind } });
    if (proof.status === 'accepted') expect(Date.parse(proof.result.completedAt)).toBeLessThan(Date.parse(proof.request.consent.finishesAt));
    const [changed] = await db.select().from(buildings).where(eq(buildings.id,f.building.id));
    if(kind==='upgrade') expect(changed!.level).toBe(2);
    if(kind==='repair') expect(changed!.trapSpentAt).toBeNull();
    if(kind==='clear_obstacle') expect((await db.select().from(obstacles).where(eq(obstacles.id,f.obstacle.id)))[0]!.clearedAt).not.toBeNull();
    const replacement = await f.add();
    if(stable) { const other=await createTestPlayer(db); await db.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId!)); await db.update(bases).set({ownerWallet:other.wallet}).where(eq(bases.id,f.baseId!)); }
    process.env['GEMS_ENABLED']='false';
    expect(await f.finish({},later(180))).toEqual({cost:0n}); expect(await getBuilderJobSpeedupReceipt(db,f.wallet,lookup(f.request))).toEqual(proof);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id,replacement.id)))[0]!.completedAt).toBeNull();
    const after=await f.balance(); expect(after[currency==='KEEP'?0:1]).toBe(before[currency==='KEEP'?0:1]! - cost);
    expect(after[currency==='KEEP'?1:0]).toBe(before[currency==='KEEP'?1:0]);
  });
  it('allows only the lower current price and refuses changed target/timer/ceiling or unavailable currency with no effects', async () => {
    const f=await fixture(stable), before=await f.balance();
    for(const change of [{buildingId:randomUUID()}, {startedAt:later(-1).toISOString()}, {finishesAt:later(130).toISOString()}, {maxCostKeep:'1'}])
      await expect(f.finish({consent:{...f.request.consent,...change}})).rejects.toMatchObject({code:'BUILDER_SPEEDUP_QUOTE_CHANGED'});
    await expect(f.finish({expectedCurrency:'GEMS'})).rejects.toMatchObject({code:'CURRENCY_CONSENT_CHANGED'});
    expect(await f.balance()).toEqual(before); expect((await getBuilderJobSpeedupReceipt(db,f.wallet,lookup(f.request))).status).toBe('unknown');
    expect((await f.finish({},later(60))).cost).toBe(BigInt(speedupCostKeep(60)));
  });
  it('natural expiry or prior completion never becomes a paid receipt', async () => {
    const f=await fixture(stable), before=await f.balance();
    await expect(f.finish({},later(120))).rejects.toMatchObject({statusCode:404,code:'BUILDER_JOB_NOT_RUNNING'});
    await db.update(builderJobs).set({completedAt:now}).where(eq(builderJobs.id,f.job.id));
    await expect(f.finish()).rejects.toMatchObject({code:'BUILDER_JOB_NOT_RUNNING'});
    expect(await f.balance()).toEqual(before); expect((await getBuilderJobSpeedupReceipt(db,f.wallet,lookup(f.request))).status).toBe('unknown');
  });
  it('a canonically cancelled and refunded upgrade cannot acquire a paid FINISH acceptance', async () => {
    const f = await fixture(stable);
    // Replace the bare running-job fixture with the real refundable upgrade
    // writer, so cancelUpgrade must prove and invert the original SHARDS debit.
    await db.delete(builderJobs).where(eq(builderJobs.id, f.job.id));
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, f.wallet));
    if (f.baseId) await rewardBaseShards(db, f.baseId, 100000n, 'test.builder.cancel.fund', randomUUID());
    else await spending.rewardShards(db, f.wallet, 100000n, 'test.builder.cancel.fund', randomUUID());
    const started = await upgradeBuilding(db, f.wallet, f.building.id, randomUUID(), now, {}, f.baseId, f.context);
    expect(started.job).not.toBeNull();
    const [job] = await db.select().from(builderJobs).where(eq(builderJobs.id, started.job!.id));
    const request = { ...f.request, jobId: job!.id, consent: builderJobPaidQuote(job!, builderJobFinishCostKeep(job!, now))! };
    const cancelled = await cancelUpgrade(db, f.wallet, job!.id, randomUUID(), now, f.baseId, f.context);
    expect(cancelled.replayed).toBe(false);
    const before = await f.balance();
    const [cancelledJob] = await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id));
    expect(cancelledJob!.cancelledAt).not.toBeNull(); expect(cancelledJob!.refundLedgerTxnId).not.toBeNull();
    await expect(f.finish(request)).rejects.toMatchObject({ statusCode: 404, code: 'BUILDER_JOB_NOT_RUNNING' });
    expect(await f.balance()).toEqual(before);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]).toEqual(cancelledJob);
    expect((await db.select().from(buildings).where(eq(buildings.id, f.building.id)))[0]!.level).toBe(1);
    expect((await getBuilderJobSpeedupReceipt(db, f.wallet, lookup(request))).status).toBe('unknown');
  });
  it('new consent never resolves an omitted base or changes legacy/stable modes', async () => {
    const f = await fixture(stable), before = await f.balance();
    if (stable) await expect(f.finish({ baseId: null })).rejects.toMatchObject({ code: 'BUILDER_SPEEDUP_SCOPE_CHANGED' });
    process.env['MULTI_BASE_ENABLED'] = String(!stable);
    await expect(f.finish()).rejects.toMatchObject({ code: 'BUILDER_SPEEDUP_SCOPE_CHANGED' });
    expect(await f.balance()).toEqual(before);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, f.job.id)))[0]).toEqual(f.job);
    expect((await getBuilderJobSpeedupReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
  });
  it('failure inside completion after claim, target write and reward rolls the entire paid command back', async () => {
    const f = await fixture(stable, 'GEMS', 'clear_obstacle'), before = await f.balance();
    const shards = async () => f.baseId ? getBaseShardBalance(db, f.baseId) : (await getOrCreatePlayerAccount(db, f.wallet, 'player_shards')).balance;
    const beforeShards = await shards();
    const progress = async () => f.baseId ? db.select().from(baseQuestProgress).where(eq(baseQuestProgress.baseId, f.baseId))
      : db.select().from(questProgress).where(eq(questProgress.playerWallet, f.wallet));
    const beforeProgress = await progress(), originalProgress = questService.progressQuestBatch;
    let observedInside = false;
    const mock = vi.spyOn(questService, 'progressQuestBatch').mockImplementation(async (...args) => {
      const [tx, wallet, increments] = args;
      if (wallet !== f.wallet || !increments.some(([kind]) => kind === 'clear_obstacle')) return originalProgress(...args);
      // This hook executes AFTER completeDueJobs claimed the job, tombstoned
      // its obstacle and posted its SHARDS reward. It is not a pre-effect throw.
      expect((await tx.select().from(builderJobs).where(eq(builderJobs.id, f.job.id)))[0]!.completedAt).not.toBeNull();
      expect((await tx.select().from(obstacles).where(eq(obstacles.id, f.obstacle.id)))[0]!.clearedAt).not.toBeNull();
      expect((await getBuilderJobSpeedupReceipt(tx, f.wallet, lookup(f.request))).status).toBe('accepted');
      const reward = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `obstacle-reward:${f.job.id}`));
      expect(reward).toHaveLength(1);
      await originalProgress(...args); observedInside = true;
      throw new Error('injected after actual completion and quest work');
    });
    try { await expect(f.finish()).rejects.toThrow(); } finally { mock.mockRestore(); }
    expect(observedInside).toBe(true); expect(await f.balance()).toEqual(before); expect(await shards()).toBe(beforeShards);
    expect(await progress()).toEqual(beforeProgress);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, f.job.id)))[0]).toEqual(f.job);
    expect((await db.select().from(obstacles).where(eq(obstacles.id, f.obstacle.id)))[0]!.clearedAt).toBeNull();
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `obstacle-reward:${f.job.id}`))).toHaveLength(0);
    expect((await getBuilderJobSpeedupReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
  });
  it('isolates wallet/base/job/key and rejects reused key identity before any new completion', async () => {
    const f=await fixture(stable); await f.finish(); const other=await createTestPlayer(db);
    for(const [wallet,scope] of [[other.wallet,f.request],[f.wallet,{...f.request,baseId:randomUUID()}],[f.wallet,{...f.request,jobId:randomUUID()}]] as const)
      expect((await getBuilderJobSpeedupReceipt(db,wallet,lookup(scope))).status).toBe('unknown');
    for(const change of [{jobId:randomUUID()}, {baseId:randomUUID()}, {expectedCurrency:'GEMS' as const}, {consent:{...f.request.consent,maxCostKeep:'999'}}])
      await expect(f.finish(change)).rejects.toMatchObject({code:'BUILDER_SPEEDUP_RECEIPT_INVALID'});
  });
});
it('free initial construction has no paid quote/debit and still acknowledges repeated finishes', async()=>{
  const f=await fixture(false,'KEEP','build'), before=await f.balance(); expect(f.request.consent).toBeNull();
  expect(await speedupJob(db,f.wallet,f.job.id,'initial-free',now)).toEqual({cost:0n});
  expect(await speedupJob(db,f.wallet,f.job.id,'initial-free',now)).toEqual({cost:0n}); expect(await f.balance()).toEqual(before);
  expect((await getBuilderJobSpeedupReceipt(db,f.wallet,lookup({...f.request,idempotencyKey:'initial-free'}))).status).toBe('unknown');
});
it('legacy paid requests remain unproven and collide safely with new consent', async()=>{
  const f=await fixture(false); await speedupJob(db,f.wallet,f.job.id,f.request.idempotencyKey,now);
  expect((await getBuilderJobSpeedupReceipt(db,f.wallet,lookup(f.request))).status).toBe('unknown');
  await expect(f.finish()).rejects.toMatchObject({code:'BUILDER_SPEEDUP_RECEIPT_INVALID'});
});
it('a failure after ledger posting rolls back debit, claim, target and original proof together', async()=>{
  const f=await fixture(false), before=await f.balance(), originalSpend=spending.spendGameCurrency;
  const mock=vi.spyOn(spending,'spendGameCurrency').mockImplementation(async(...args)=>{await originalSpend(...args);throw new Error('injected after debit');});
  try { await expect(f.finish()).rejects.toThrow(); } finally { mock.mockRestore(); }
  expect(await f.balance()).toEqual(before); expect((await getBuilderJobSpeedupReceipt(db,f.wallet,lookup(f.request))).status).toBe('unknown');
  expect((await db.select().from(builderJobs).where(eq(builderJobs.id,f.job.id)))[0]!.completedAt).toBeNull();
  expect((await db.select().from(buildings).where(eq(buildings.id,f.building.id)))[0]!.level).toBe(1);
});
it('rejects forged ledger shape, wrong sink, over-ceiling and naturally completed metadata', async()=>{
  const f=await fixture(false), sys=await bootstrapSystemAccounts(db), debit=await getOrCreatePlayerAccount(db,f.wallet,'player_keep');
  for(const variant of ['sink','ceiling','deadline','wallet'] as const){
    const request={...f.request,idempotencyKey:randomUUID()}, cost=BigInt(request.consent.maxCostKeep)+(variant==='ceiling'?1n:0n);
    await postTransaction(db,{type:'build.speedup',idempotencyKey:builderJobSpeedupLedgerKey(f.wallet,request.idempotencyKey),entries:[{account:debit.id,delta:-cost},{account:variant==='sink'?sys.league_pool:sys.emission_pool,delta:cost}],
      metadata:{wallet:variant==='wallet'?'wrong':f.wallet,recycled:true,jobId:f.job.id,remSec:120,builderJobSpeedup:{version:1,request,result:{jobId:f.job.id,kind:f.job.kind,buildingId:f.job.buildingId,obstacleId:null,completedAt:(variant==='deadline'?later(120):now).toISOString()}}}});
    expect((await getBuilderJobSpeedupReceipt(db,f.wallet,lookup(request))).status).toBe('unknown');
  }
});
it('HTTP receipt stays private and replay survives missing current ownership; malformed consent cannot write',async()=>{
  const f=await fixture(false); process.env['FREE_ONBOARDING']='true';
  const [session]=await db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)}; const app=await buildApp(TEST_CONFIG,db);
  const url=builderJobSpeedupReceiptPath(lookup(f.request)), endpoint=`/base/jobs/${f.job.id}/speedup`;
  try{
    for(const change of [{version:'1'},{maxCostKeep:'0'},{maxCostKeep:'9223372036854775808'},{kind:'build'}]){
      const r=await app.inject({method:'POST',url:endpoint,cookies,headers:{'x-pkw-expected-currency':'KEEP'},payload:{idempotencyKey:f.request.idempotencyKey,consent:{...f.request.consent,...change}}});expect(r.statusCode,r.body).toBe(400);
    }
    await f.finish(); process.env['MULTI_BASE_ENABLED']='true'; process.env['GEMS_ENABLED']='false';
    const before=await db.select().from(accounts), txns=await db.select().from(ledgerTransactions);
    expect((await app.inject({url})).statusCode).toBe(401);
    const proof=await app.inject({url,cookies});expect(proof.statusCode,proof.body).toBe(200);expect(proof.json().status).toBe('accepted');expect(proof.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject({url:`${url}&wallet=${f.wallet}`,cookies})).statusCode).toBe(400);
    const replay=await app.inject({method:'POST',url:endpoint,cookies,headers:{'x-pkw-expected-currency':'KEEP'},payload:{idempotencyKey:f.request.idempotencyKey,consent:f.request.consent}});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({cost:'0'});
    expect(await db.select().from(accounts)).toEqual(before);expect(await db.select().from(ledgerTransactions)).toEqual(txns);
  }finally{await app.close();}
});

it.each(['upgrade', 'clear_obstacle'] as const)('the %s target cannot disappear while its FK-bound paid job exists', async kind => {
  const f = await fixture(false, 'KEEP', kind), before = await f.balance();
  if (kind === 'upgrade') await expect(db.delete(buildings).where(eq(buildings.id, f.building.id))).rejects.toThrow();
  else await expect(db.delete(obstacles).where(eq(obstacles.id, f.obstacle.id))).rejects.toThrow();
  expect(await f.balance()).toEqual(before);
  expect((await db.select().from(builderJobs).where(eq(builderJobs.id, f.job.id)))[0]).toEqual(f.job);
  expect((await getBuilderJobSpeedupReceipt(db, f.wallet, lookup(f.request))).status).toBe('unknown');
});
