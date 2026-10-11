import { installResourceMiningV3Cutover } from '../src/mining/resourceMiningPolicy';
/** Real auth, service and SQL paths. Opening resources/facilities and transfer
 * fixtures are explicit; this suite does not claim source earning or chain proof. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { PHASE_E_MINING_CONTRIBUTION_V2 as POLICY,PHASE_E_MINING_SCORE_POLICY as SCORE } from '@shardkeep/shared';
import { MINING_CONTRIBUTION_RESOURCE_IDS,miningResourceUnitValue } from '@shardkeep/shared/miningContribution';
import { MiningContributionEnvelopeSchema,MiningContributionViewSchema,type MiningContributionRequest } from '@shardkeep/shared/miningContributionApi';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { buildApp } from '../src/app';
import { createMiningContributionProvider } from '../src/game/miningContributionRoutes';
import { issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC } from '../src/auth/session';
import { phaseEMiningEnabled } from '../src/config';
import type { DbTx } from '../src/db/client';
import { bases,baseSlots,buildings,craftingStocks,resourceStocks,sessions } from '../src/db/schema';
import { rewardBaseShards,getBaseShardBalance } from '../src/game/baseEconomy';
import { reserveRawStock } from '../src/game/resourceStock';
import { abortMiningContributions } from '../src/game/miningContributions';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb,createTestPlayer,TEST_CONFIG } from './helpers';

const conn=connectTestDb(),db=conn.db;let app:FastifyInstance,dayNumber=0;
const reader=vi.fn(async()=>{throw Error('No external RPC in this fixture');});
beforeAll(async()=>{
 const old=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';
 try{await bootstrapSystemAccounts(db);const market={finalizedDeedReader:reader,deedCollection:Keypair.generate().publicKey.toBase58()};
  app=await buildApp(TEST_CONFIG,db,{market,miningContributionProvider:createMiningContributionProvider(db,{market})});await app.ready();}
 finally{if(old===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=old;}
});
beforeEach(()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');reader.mockClear();
 // Each test owns its server UTC epoch; an all-epoch abort cannot affect a later test.
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(Date.UTC(2040,0,1+dayNumber++)));});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await app.close();await conn.sql.end();});
async function fixture(wallet?:string,slot=1){
 wallet??=(await createTestPlayer(db)).wallet;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,keepLevel:SCORE.requiredLevel.keep}).returning(),baseId=base!.id;
 await db.insert(baseSlots).values({wallet,baseId,slot});
 for(const [i,type] of (['keep','workshop','goldforge'] as const).entries())await db.insert(buildings).values({baseId,playerWallet:wallet,type,level:SCORE.requiredLevel[type],tx:10+i*4,ty:10});
 await db.insert(resourceStocks).values({baseId,resourceId:'heartwood_logs',available:100n});
 await db.insert(craftingStocks).values({baseId,itemId:'frostglass',available:30n});
 await rewardBaseShards(db,baseId,30_000n,'test.mining.routes',randomUUID());
 const [session]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
 const request:MiningContributionRequest={idempotencyKey:randomUUID(),baseId,policyVersion:2,expectedDay:new Date().toISOString().slice(0,10),lines:[{resourceId:'heartwood_logs',quantity:'2'}]};
 return {wallet,baseId,cookies,request,authority:{baseId,assertAuthority:async(tx:DbTx,actor:string,id:string)=>{await assertFreshLockedBaseAuthority(tx,actor,id);}}};
}
type F=Awaited<ReturnType<typeof fixture>>;
const post=(f:F,body:object=f.request)=>app.inject({method:'POST',url:'/mining/contributions',cookies:f.cookies,payload:body});
const get=(f:F,url=`/mining/contributions?baseId=${f.baseId}`)=>app.inject({method:'GET',url,cookies:f.cookies});
const receipt=(f:F,key=f.request.idempotencyKey)=>get(f,`/mining/contributions/by-key/${key}`);
const rows=(f:F)=>conn.sql`select * from mining_contribution_receipts where actor_wallet=${f.wallet}`;
describe('authenticated ordinary resource mining',()=>{
 it('defaults off and authenticates every mounted route before flags or body parsing',async()=>{
  expect(phaseEMiningEnabled({})).toBe(false);vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  for(const options of [{method:'GET' as const,url:'/mining/contributions'},{method:'POST' as const,url:'/mining/contributions',payload:{}},
   {method:'GET' as const,url:`/mining/contributions/by-key/${randomUUID()}`}]){
   const response=await app.inject(options);expect(response.statusCode).toBe(401);expect(response.headers['cache-control']).toBe('private, no-store');
  }
 });
 it('returns exactly twenty authoritative available balances and excludes other custody buckets',async()=>{
  const f=await fixture();await reserveRawStock(db,f.wallet,{baseId:f.baseId,resourceId:'heartwood_logs',quantity:7n,operationId:randomUUID()},f.authority);
  expect((await post(f)).statusCode).toBe(201);
  const response=await get(f),view=MiningContributionViewSchema.parse(response.json());expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(view.resources.map(r=>r.resourceId)).toEqual([...MINING_CONTRIBUTION_RESOURCE_IDS]);
  expect(view.resources.find(r=>r.resourceId==='heartwood_logs')!.available).toBe('91');
  expect(view.resources.find(r=>r.resourceId==='frostglass')!.available).toBe('30');
  expect(view.resources.find(r=>r.resourceId==='forge_ingot')!.available).toBe('0');
  expect(view.resources.find(r=>r.resourceId==='crystal_fragment')!.available).toBe('0');
  for(const r of view.resources)expect(r.unitValue).toBe(String(miningResourceUnitValue(r.resourceId,POLICY.version)));
  const used=2n*miningResourceUnitValue('heartwood_logs',2);
  expect(view).toMatchObject({wallet:f.wallet,baseId:f.baseId,pool:'free',developmentReady:true,acceptingContributions:true,committedValue:String(used),remainingValue:String(BigInt(POLICY.freeValuePerWalletDay)-used)});
  const unavailable=await post(f,{...f.request,idempotencyKey:randomUUID(),lines:[{resourceId:'heartwood_logs',quantity:'92'}]});
  expect(unavailable.statusCode).toBe(422);expect(unavailable.json().error.code).toBe('INSUFFICIENT_MINING_RESOURCES');
 });
 it('rejects missing scope, caller authority/prices, duplicate resources and invalid keys before custody',async()=>{
  const f=await fixture();
  for(const body of [{...f.request,baseId:undefined},{...f.request,actorWallet:f.wallet},{...f.request,unitValue:'1'},
   {...f.request,lines:[...f.request.lines,...f.request.lines]},{...f.request,idempotencyKey:'replace-me'}])expect((await post(f,body)).statusCode).toBe(400);
  expect((await get(f,'/mining/contributions')).statusCode).toBe(400);expect(await rows(f)).toHaveLength(0);
 });
 it('recovers exact originals after pause and transfer without reading current deed RPC',async()=>{
  const f=await fixture(),buyer=await createTestPlayer(db),accepted=MiningContributionEnvelopeSchema.parse((await post(f)).json());
  await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,deedAssetId:Keypair.generate().publicKey.toBase58()}).where(eq(bases.id,f.baseId));await tx.insert(baseSlots).values({wallet:buyer.wallet,baseId:f.baseId,slot:1});});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');
  const replay=await post(f),recovered=await receipt(f);expect(replay.statusCode).toBe(200);expect(recovered.statusCode).toBe(200);
  expect(replay.json().receipt).toEqual(accepted.receipt);expect(recovered.json().receipt).toEqual(accepted.receipt);
  expect((await post(f,{...f.request,idempotencyKey:randomUUID()})).statusCode).toBe(503);expect(reader).not.toHaveBeenCalled();
  expect(await rows(f)).toHaveLength(1);
 });
 it('maps changed original requests to409 and concurrent same keys debit exactly once',async()=>{
  const f=await fixture(),answers=await Promise.all([post(f),post(f)]);
  for(const r of answers)expect([200,201]).toContain(r.statusCode);
  expect(answers[0]!.json().receipt).toEqual(answers[1]!.json().receipt);expect(await rows(f)).toHaveLength(1);
  for(const change of [{baseId:randomUUID()},{expectedDay:'2020-01-01'},{lines:[{resourceId:'heartwood_logs',quantity:'3'}]}]){
   const r=await post(f,{...f.request,...change});expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
  }
 });
 it('keeps foreign and missing originals indistinguishable and rejects foreign current views',async()=>{
  const f=await fixture(),other=await fixture();await post(f);
  for(const key of [f.request.idempotencyKey,randomUUID()])expect((await receipt(other,key)).json()).toMatchObject({wallet:other.wallet,status:'unknown',receipt:null,settlement:null});
  const foreign=await get(other,`/mining/contributions?baseId=${f.baseId}`),missing=await get(other,`/mining/contributions?baseId=${randomUUID()}`);
  expect(foreign.statusCode).toBe(404);expect(foreign.json()).toEqual(missing.json());expect(foreign.body).not.toContain(f.wallet);
  const conflict=await post(other,{...other.request,idempotencyKey:f.request.idempotencyKey});expect(conflict.statusCode).toBe(409);expect(conflict.json().error.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
 });
 it('uses the server day and rejects stale consent or missing facilities before moving stock',async()=>{
  const f=await fixture(),stale=await post(f,{...f.request,expectedDay:'2020-01-01'});expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('MINING_DAY_CHANGED');
  await db.delete(buildings).where(eq(buildings.baseId,f.baseId));
  expect((await get(f)).json().developmentReady).toBe(false);
  const noFacility=await post(f);expect(noFacility.statusCode).toBe(422);expect(noFacility.json().error.code).toBe('DEVELOPMENT_REQUIRED');expect(await rows(f)).toHaveLength(0);
 });
 it('shares the free value cap across bases and preserves it after returning an original basket',async()=>{
  const f=await fixture(),other=await fixture(f.wallet,2),body={...f.request,lines:[{resourceId:'shards',quantity:String(POLICY.freeValuePerWalletDay)}]};
  const accepted=MiningContributionEnvelopeSchema.parse((await post(f,body)).json());expect(accepted.status).toBe('accepted');
  const excess=await post(other,{...other.request,lines:[{resourceId:'shards',quantity:'1'}]});expect(excess.statusCode).toBe(422);expect(excess.json().error.code).toBe('MINING_FREE_CAP_EXCEEDED');
  await abortMiningContributions(db,{epochId:accepted.receipt!.epochId,decisionKey:randomUUID(),reason:'route-original-return'});
  const returned=MiningContributionEnvelopeSchema.parse((await receipt(f)).json());expect(returned.settlement?.outcome).toBe('returned');
  expect((await get(other)).json().remainingValue).toBe('0');expect(await getBaseShardBalance(db,f.baseId)).toBe(30_000n);
 });
 it('rolls an unavailable mixed basket back and never spends pending or unearned inventory',async()=>{
  const f=await fixture(),before=await getBaseShardBalance(db,f.baseId);
  for(const resourceId of ['forge_ingot','crystal_fragment','thornsilk'] as const){
   const response=await post(f,{...f.request,idempotencyKey:randomUUID(),lines:[{resourceId:'shards',quantity:'1'},{resourceId,quantity:'1'}]});
   expect(response.statusCode).toBe(422);expect(response.json().error.code).toBe('INSUFFICIENT_MINING_RESOURCES');
  }
  expect(await getBaseShardBalance(db,f.baseId)).toBe(before);expect(await rows(f)).toHaveLength(0);
 });
 it('requires current finalized deed authority before displaying stock or creating a new commitment',async()=>{
  const f=await fixture(),asset=Keypair.generate().publicKey.toBase58();
  await db.update(bases).set({deedAssetId:asset,deedMintAssetId:asset,landPaidAt:new Date()}).where(eq(bases.id,f.baseId));
  for(const response of [await get(f),await post(f)]){expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe('DEED_AUTHORITY_UNAVAILABLE');}
  expect(reader).toHaveBeenCalled();expect(await rows(f)).toHaveLength(0);
 });
});

it('treats catalogue3 as capability, refuses old discovery after cutover and replays accepted policy2 before pause',async()=>{
 vi.setSystemTime(new Date('2050-06-01T12:00:00Z'));const f=await fixture();
 const initial=await get(f,`/mining/contributions?baseId=${f.baseId}&catalogueVersion=3`);
 expect(initial.statusCode).toBe(200);expect(initial.json().policyVersion).toBe(2);expect(initial.json().resources).toHaveLength(20);
 const accepted=await post(f);expect(accepted.statusCode).toBe(201);
 await installResourceMiningV3Cutover(db,'2050-06-02');vi.setSystemTime(new Date('2050-06-02T12:00:00Z'));
 const old=await get(f);expect(old.statusCode).toBe(409);expect(old.json().error.code).toBe('MINING_POLICY_REVIEW_REQUIRED');
 const supported=await get(f,`/mining/contributions?baseId=${f.baseId}&catalogueVersion=3`);
 expect(supported.statusCode).toBe(200);expect(supported.json().policyVersion).toBe(3);expect(supported.json().resources).toHaveLength(22);
 const stale=await post(f,{...f.request,idempotencyKey:randomUUID(),expectedDay:'2050-06-02'});
 expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('MINING_POLICY_REVIEW_REQUIRED');
 const fresh=await post(f,{...f.request,idempotencyKey:randomUUID(),expectedDay:'2050-06-02',policyVersion:3});expect(fresh.statusCode).toBe(201);
 vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');
 const replay=await post(f);expect(replay.statusCode).toBe(200);expect(replay.json().receipt).toEqual(accepted.json().receipt);
 expect((await receipt(f)).json().receipt).toEqual(accepted.json().receipt);expect(await rows(f)).toHaveLength(2);
});
