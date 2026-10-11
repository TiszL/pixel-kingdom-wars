/** Additional Mine acceptance reuses canonical placement and the global build key. */
import { randomUUID } from 'node:crypto';
import { BuildingType, MINING } from '@shardkeep/shared';
import { minePurchaseBody, minePurchaseReceiptPath, type MinePurchaseIntent } from '@shardkeep/shared/minePurchase';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, bases, baseSlots, builderJobs, buildings, players, sessions } from '../src/db/schema';
import { executeMinePurchase, placeBuilding } from '../src/game/base';
import { withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import * as receipts from '../src/game/constructionReceipt';
import * as spending from '../src/game/spend';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';
const conn=connectTestDb(),db=conn.db, now=new Date('2026-09-21T10:00:00.000Z');
const flags=['MULTI_BASE_ENABLED','GEMS_ENABLED','FREE_ONBOARDING'] as const;
const old=Object.fromEntries(flags.map(k=>[k,process.env[k]]));
beforeAll(async()=>{await bootstrapSystemAccounts(db);});
afterAll(async()=>{for(const k of flags){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}await conn.sql.end();});
async function receiptApp() {
  // Startup's global observer census is tested separately. Restore this
  // fixture's scope before injecting requests so real mutation gates still run.
  const stable = process.env['MULTI_BASE_ENABLED'];
  process.env['MULTI_BASE_ENABLED'] = 'false';
  try { return await buildApp(TEST_CONFIG, db); }
  finally {
    if (stable === undefined) delete process.env['MULTI_BASE_ENABLED'];
    else process.env['MULTI_BASE_ENABLED'] = stable;
  }
}
async function fixture(stable:boolean,currency:'KEEP'|'GEMS'='KEEP') {
  process.env['MULTI_BASE_ENABLED']=String(stable);process.env['GEMS_ENABLED']='true';
  const {wallet}=await createTestPlayer(db);await db.update(players).set({keepLevel:5,builders:2}).where(eq(players.wallet,wallet));
  await fundTestKeep(db,wallet,BigInt(MINING.MINE_BUILD_KEEP[2]!)*10n,'test.mine',randomUUID());
  if(currency==='GEMS')await convertKeepToGems(db,wallet,BigInt(MINING.MINE_BUILD_KEEP[2]!)*2n,randomUUID());
  let baseId:string|undefined;
  if(stable){const [b]=await db.insert(bases).values({ownerWallet:wallet,keepLevel:5,builders:2}).returning();baseId=b!.id;await db.insert(baseSlots).values({wallet,baseId,slot:1});}
  const [first]=await db.insert(buildings).values({playerWallet:wallet,baseId,type:'mine',level:1,tx:8,ty:8}).returning();
  const request:MinePurchaseIntent={type:'mine',tx:11,ty:8,baseId:baseId??null,idempotencyKey:randomUUID(),expectedCurrency:currency,
    mineConsent:receipts.additionalMineQuote(1,MINING.MAX_MINES_BY_KEEP[4]!)!};
  const buy=(patch:Partial<MinePurchaseIntent>={})=>{const r={...request,...patch};return withClientCurrencyContext({currency:undefined,expectedCurrency:r.expectedCurrency},()=>executeMinePurchase(db,wallet,r,now));};
  const lookup=()=>receipts.getConstructionReceipt(db,wallet,{type:BuildingType.Mine,tx:request.tx,ty:request.ty,idempotencyKey:request.idempotencyKey,...(baseId?{baseId}:{})});
  const rows=()=>db.select().from(buildings).where(eq(buildings.playerWallet,wallet));
  const balance=()=>db.select().from(accounts).where(eq(accounts.ownerWallet,wallet));
  return {wallet,baseId,first:first!,request,buy,lookup,rows,balance};
}
for(const stable of [false,true])describe(`modern Mine ${stable?'stable':'legacy'} scope`,()=>{
  it.each(['KEEP','GEMS'] as const)('accepts exactly once in %s, replays after sale/deletion/pause without completing later jobs',async currency=>{
    const f=await fixture(stable,currency),before=await f.balance();const [a,b]=await Promise.all([f.buy(),f.buy()]);expect(a).toEqual(b);
    expect(a).toMatchObject({status:'accepted',minePurchase:{wallet:f.wallet,request:f.request,funding:{currency,amount:String(MINING.MINE_BUILD_KEEP[1])}}});
    expect(await f.rows()).toHaveLength(2);const accepted=await f.lookup();expect(accepted).toEqual(a);
    const [later]=await db.insert(builderJobs).values({playerWallet:f.wallet,baseId:f.baseId,kind:'build',buildingId:f.first.id,startedAt:new Date(now.getTime()-2000),finishesAt:new Date(now.getTime()-1000)}).returning();
    const placed=(await f.rows()).find(r=>r.id!==f.first.id)!;
    await db.delete(builderJobs).where(eq(builderJobs.buildingId,placed.id));await db.delete(buildings).where(eq(buildings.id,placed.id));
    if(stable){const other=await createTestPlayer(db);await db.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId!));await db.update(bases).set({ownerWallet:other.wallet}).where(eq(bases.id,f.baseId!));}
    process.env['GEMS_ENABLED']='false';process.env['MULTI_BASE_ENABLED']=String(!stable);
    expect(await f.buy()).toEqual(a);expect(await f.lookup()).toEqual(accepted);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id,later!.id)))[0]!.completedAt).toBeNull();
    const after=await f.balance(),kind=currency==='GEMS'?'player_gems':'player_keep';
    expect(after.find(a=>a.kind===kind)!.balance).toBe(before.find(a=>a.kind===kind)!.balance-BigInt(MINING.MINE_BUILD_KEEP[1]!));
  });
  it('different keys for the same quoted index grant one placement and reject the other without effect',async()=>{
    const f=await fixture(stable);const results=await Promise.allSettled([f.buy(),f.buy({idempotencyKey:randomUUID(),tx:13})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'MINE_PURCHASE_INDEX_CHANGED'}});expect(await f.rows()).toHaveLength(2);
  });
  it.each(['up','down','price','mode'] as const)('rejects changed %s consent without debit or ledger acceptance',async change=>{
    const f=await fixture(stable),before=await f.balance();
    if(change==='up')await db.insert(buildings).values({playerWallet:f.wallet,baseId:f.baseId,type:'mine',level:1,tx:9,ty:8});
    if(change==='down')await db.delete(buildings).where(eq(buildings.id,f.first.id));
    if(change==='mode')process.env['MULTI_BASE_ENABLED']=String(!stable);
    const patch=change==='price'?{mineConsent:{...f.request.mineConsent,maxCostKeep:String(MINING.MINE_BUILD_KEEP[1]!-1)}}:{};
    await expect(f.buy(patch)).rejects.toMatchObject({code:change==='mode'?'MINE_PURCHASE_SCOPE_CHANGED':change==='price'?'MINE_PURCHASE_PRICE_CHANGED':'MINE_PURCHASE_INDEX_CHANGED'});
    expect(await f.balance()).toEqual(before);expect((await f.lookup()).status).toBe('unknown');
  });
  it('permits a lower price within the original ceiling but refuses body/key substitution',async()=>{
    const f=await fixture(stable);const mineConsent={...f.request.mineConsent,maxCostKeep:String(MINING.MINE_BUILD_KEEP[2])};await f.buy({mineConsent});
    for(const patch of [{tx:12},{baseId:randomUUID()},{expectedCurrency:'GEMS' as const},{mineConsent:{...mineConsent,mineIndex:2}}])
      await expect(f.buy({...patch,mineConsent:'mineConsent'in patch?patch.mineConsent:mineConsent})).rejects.toMatchObject({code:'MINE_PURCHASE_RECEIPT_INVALID'});
  });
  it('keeps first-Mine SHARDS and legacy additional-Mine receipts readable but never upgrades old evidence',async()=>{
    const f=await fixture(stable);await db.delete(buildings).where(eq(buildings.id,f.first.id));
    if(stable)await rewardBaseShards(db,f.baseId!,BigInt(MINING.MINE_BUILD_KEEP[0]!)*2n,'test.mine',randomUUID());else await spending.rewardShards(db,f.wallet,BigInt(MINING.MINE_BUILD_KEEP[0]!)*2n,'test.mine',randomUUID());
    await placeBuilding(db,f.wallet,BuildingType.Mine,11,8,f.request.idempotencyKey,now,f.baseId);
    const first=await f.lookup();expect(first).toMatchObject({status:'accepted',funding:{currency:'SHARDS',amount:String(MINING.MINE_BUILD_KEEP[0])}});expect(first).not.toHaveProperty('minePurchase');
    await expect(f.buy()).rejects.toMatchObject({code:'MINE_PURCHASE_RECEIPT_INVALID'});
    const key=randomUUID();await placeBuilding(db,f.wallet,BuildingType.Mine,13,8,key,now,f.baseId);
    const legacy=await receipts.getConstructionReceipt(db,f.wallet,{type:BuildingType.Mine,tx:13,ty:8,idempotencyKey:key,...(f.baseId?{baseId:f.baseId}:{})});
    expect(legacy).toMatchObject({status:'accepted',funding:{currency:'KEEP'}});expect(legacy).not.toHaveProperty('minePurchase');
  });
});
it.each(['debit','insert'] as const)('rolls back the actual %s and every canonical placement effect on failure',async stage=>{
  const f=await fixture(false),before=await f.balance();let observed=false;
  const spend=spending.spendGameCurrency,replay=receipts.replayMinePurchase;
  const mock=stage==='debit'?vi.spyOn(spending,'spendGameCurrency').mockImplementation(async(...args)=>{await spend(...args);observed=true;throw new Error('after real debit');})
    :vi.spyOn(receipts,'replayMinePurchase').mockImplementation(async(...args)=>{const result=await replay(...args);if(result){expect(await args[0].select().from(buildings).where(eq(buildings.playerWallet,f.wallet))).toHaveLength(2);observed=true;throw new Error('after real building and job');}return result;});
  try{await expect(f.buy()).rejects.toThrow();}finally{mock.mockRestore();}
  expect(observed).toBe(true);expect(await f.balance()).toEqual(before);expect(await f.rows()).toHaveLength(1);expect((await f.lookup()).status).toBe('unknown');
  expect(await db.select().from(builderJobs).where(eq(builderJobs.playerWallet,f.wallet))).toEqual([]);
});
it.each(['wrong-sink','wrong-wallet','wrong-index','wrong-currency','old-key'] as const)('cannot turn %s ledger content into a modern Mine proof',async variant=>{
  const f=await fixture(false),sys=await bootstrapSystemAccounts(db),other=await createTestPlayer(db);
  await fundTestKeep(db,other.wallet,BigInt(MINING.MINE_BUILD_KEEP[1]!),'test.mine',randomUUID());
  const payer=await getOrCreatePlayerAccount(db,variant==='wrong-wallet'?other.wallet:f.wallet,'player_keep');
  const metadata={wallet:f.wallet,type:'mine',tx:11,ty:8,mineIndex:variant==='wrong-index'?2:1,recycled:true,
    ...(variant==='old-key'?{}:{minePurchase:{version:1,request:{...f.request,...(variant==='wrong-currency'?{expectedCurrency:'GEMS'}:{})}}})};
  await postTransaction(db,{idempotencyKey:`build:${f.wallet}:${f.request.idempotencyKey}`,type:'build.mine',metadata,
    entries:[{account:payer.id,delta:-BigInt(MINING.MINE_BUILD_KEEP[1]!)},{account:variant==='wrong-sink'?sys.burn:sys.emission_pool,delta:BigInt(MINING.MINE_BUILD_KEEP[1]!)}]});
  const proof=await f.lookup();if(variant==='old-key')expect(proof).toMatchObject({status:'accepted'});else expect(proof.status).toBe('unknown');
  expect(proof).not.toHaveProperty('minePurchase');await expect(f.buy()).rejects.toMatchObject({code:'MINE_PURCHASE_RECEIPT_INVALID'});
});
it.each([{ stable: false, currency: 'KEEP' }, { stable: false, currency: 'GEMS' },
  { stable: true, currency: 'KEEP' }, { stable: true, currency: 'GEMS' }] as const)(
  'fresh HTTP placement honors $currency consent and original proof (stable=$stable)', async ({ stable, currency }) => {
    const f = await fixture(stable, currency); process.env['FREE_ONBOARDING'] = 'true';
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
    const app = await receiptApp(), body = minePurchaseBody(f.request), before = await f.balance();
    try {
      expect((await app.inject({ method: 'POST', url: '/base/buildings', cookies, payload: body })).statusCode).toBe(400);
      expect(await f.balance()).toEqual(before); expect(await f.rows()).toHaveLength(1);
      const accepted = await app.inject({ method: 'POST', url: '/base/buildings', cookies,
        headers: { 'x-pkw-expected-currency': currency }, payload: body });
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(accepted.json()).toMatchObject({ status: 'accepted', minePurchase: { request: f.request,
        funding: { currency, amount: String(MINING.MINE_BUILD_KEEP[1]) } } });
      expect(accepted.headers['cache-control']).toBe('private, no-store');
      const proof = await app.inject({ url: minePurchaseReceiptPath(f.request), cookies });
      expect(proof.statusCode, proof.body).toBe(200); expect(proof.json()).toEqual(accepted.json());
      expect(await f.rows()).toHaveLength(2);
      const kind = currency === 'GEMS' ? 'player_gems' : 'player_keep';
      expect((await f.balance()).find(a => a.kind === kind)!.balance)
        .toBe(before.find(a => a.kind === kind)!.balance - BigInt(MINING.MINE_BUILD_KEEP[1]!));
    } finally { await app.close(); }
  });
it.each([false, true])('modern opt-in cannot bypass fresh land admission or malformed consent (stable=%s)', async stable => {
  const f = await fixture(stable); process.env['FREE_ONBOARDING'] = 'false';
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const app = await receiptApp(), before = await f.balance(), body = minePurchaseBody(f.request);
  try {
    const refused = await app.inject({ method: 'POST', url: '/base/buildings', cookies,
      headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: body });
    expect(refused.statusCode, refused.body).toBe(402); expect(refused.json()).toMatchObject({ error: { code: 'LAND_NOT_OWNED' } });
    for (const mineConsent of [null, {}, { ...f.request.mineConsent, mineIndex: 0 }, { ...f.request.mineConsent, maxCostKeep: '1.5' }]) {
      const malformed = await app.inject({ method: 'POST', url: '/base/buildings', cookies,
        headers: { 'x-pkw-expected-currency': 'KEEP' }, payload: { ...body, mineConsent } });
      expect(malformed.statusCode, malformed.body).toBe(400);
    }
    expect(await f.balance()).toEqual(before); expect(await f.rows()).toHaveLength(1);
    expect((await f.lookup()).status).toBe('unknown');
    expect(await db.select().from(builderJobs).where(eq(builderJobs.playerWallet, f.wallet))).toEqual([]);
  } finally { await app.close(); }
});
it('route replays original private proof after sale and scope pause, while GET rejects wallet/consent injection',async()=>{
  const f=await fixture(true);await f.buy();const [session]=await db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)};
  await db.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId!));process.env['MULTI_BASE_ENABLED']='false';process.env['GEMS_ENABLED']='false';process.env['FREE_ONBOARDING']='false';
  const app=await buildApp(TEST_CONFIG,db);try{
    const response=await app.inject({method:'POST',url:'/base/buildings',cookies,headers:{'x-pkw-expected-currency':'KEEP'},payload:minePurchaseBody(f.request)});
    expect(response.statusCode).toBe(201);expect(response.json()).toMatchObject({status:'accepted',minePurchase:{request:f.request}});expect(response.headers['cache-control']).toBe('private, no-store');
    const url=minePurchaseReceiptPath(f.request);expect((await app.inject({method:'GET',url,cookies})).json()).toMatchObject({status:'accepted',minePurchase:{request:f.request}});
    expect((await app.inject({method:'GET',url:`${url}&wallet=${f.wallet}`,cookies})).statusCode).toBe(400);
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/base/buildings',cookies,headers:{'x-pkw-expected-currency':'KEEP'},payload:{...minePurchaseBody(f.request),idempotencyKey:randomUUID()}})).statusCode).toBe(409);
  }finally{await app.close();}
});
