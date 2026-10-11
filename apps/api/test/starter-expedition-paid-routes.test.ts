/** Authenticated HTTP uses actual finalized-access account bytes and a synthetic
 * operating tax reader. No public RPC, signing, validator or listener. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import type {FastifyInstance} from 'fastify';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {expeditionFreeHomes,sessions,starterExpeditions} from '../src/db/schema';
import * as terms from '../src/game/expeditionTermReader';
import type {StarterExpeditionProvider} from '../src/game/starterExpeditionRoutes';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance,missing:FastifyInstance,bank:Awaited<ReturnType<typeof createSeekerRealmAccessFixture>>;
const connect=vi.fn(()=>bank.rpc),key=new PublicKey('11111111111111111111111111111111');
const provider:StarterExpeditionProvider={policy:{genesisHash:key,programId:key,config:key,round:1n,mint:key,prizeOwner:key,prizeAta:key,stateProvenance:'fresh-reviewed-deployment',deployment:{programDataAddress:key.toBase58(),programDataSha256:'ab'.repeat(32),upgradeAuthority:null}},connect:()=>{throw Error('Synthetic term reader only');}};
beforeAll(async()=>{bank=await createSeekerRealmAccessFixture();app=await buildApp(TEST_CONFIG,db,{starterExpeditionProvider:provider,starterExpeditionAccessProvider:{trust:bank.trust,connect}});missing=await buildApp(TEST_CONFIG,db,{starterExpeditionProvider:provider});await app.ready();await missing.ready();});
beforeEach(()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');connect.mockClear();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});afterAll(async()=>{await app.close();await missing.close();await conn.sql.end();});
async function fixture(){
 const f=await createStarterExpeditionFixture(db,{now:new Date()});bank=await createSeekerRealmAccessFixture();const wallet=new PublicKey(f.wallet),realm=0;
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),wallet.toBuffer(),Buffer.of(realm)],bank.programId),BN=bank.accessModel.expires_at.constructor as new(n:string)=>typeof bank.accessModel.expires_at;
 bank.accessModel.wallet=wallet;bank.accessModel.bump=bump;bank.accessModel.expires_at=new BN(String(Math.floor(Date.now()/1000)+60));bank.rows[3]!.address=address;await bank.encode('access');bank.rows[4]!.data.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);bank.rows[5]=null;
 f.snapshot={...f.snapshot,source:{...f.snapshot.source,genesisHash:bank.genesis.toBase58(),programId:bank.programId.toBase58()}};
 vi.spyOn(terms,'prefetchExpeditionTermReader').mockImplementation(async()=>({readOperatingTerm:async at=>({snapshot:f.snapshot,finality:{commitment:'finalized',contextSlot:'200',observedAt:at}})}));
 const [session]=await db.insert(sessions).values({wallet:f.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 return {...f,request:{idempotencyKey:randomUUID(),baseId:f.baseId,installationId:f.installationId,routeId:'paid_frostveil',routeVersion:3,rewardVersion:2},cookies:{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.wallet,session!.id)}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const view=(f:Fixture,server=app,query=`baseId=${f.baseId}&realm=0`)=>server.inject({url:`/starter-expeditions/paid-route?${query}`,cookies:f.cookies});
const post=(f:Fixture,server=app)=>server.inject({method:'POST',url:'/starter-expeditions',cookies:f.cookies,payload:f.request});
const trips=(f:Fixture)=>db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId,f.baseId));
describe('selected paid starter HTTP',()=>{
 it('authenticates and rejects noncanonical or injected selectors before any access RPC',async()=>{
  const f=await fixture();const noAuth=await app.inject({url:`/starter-expeditions/paid-route?baseId=${f.baseId}&realm=0`});expect(noAuth.statusCode).toBe(401);expect(noAuth.headers['cache-control']).toBe('private, no-store');
  for(const query of [`baseId=${f.baseId}&realm=00`,`baseId=${f.baseId}&realm=8`,`baseId=${f.baseId}&realm=0&wallet=${f.wallet}`,`baseId=${f.baseId}&realm=0&realm=1`,`realm=0`]){const r=await view(f,app,query);expect(r.statusCode).toBe(400);expect(r.headers['cache-control']).toBe('private, no-store');}expect(connect).not.toHaveBeenCalled();
 });
 it('requires explicit owned base before coverage and does not expose foreign wallet observations',async()=>{
  const f=await fixture(),other=await fixture();const r=await view(f,app,`baseId=${other.baseId}&realm=0`);expect(r.statusCode).toBe(404);expect(connect).not.toHaveBeenCalled();expect(r.body).not.toContain(other.wallet);
 });
 it('displays selected economics and current owned coverage during a sales pause without admission writes',async()=>{
  const f=await fixture(),r=await view(f);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.json()).toMatchObject({wallet:f.wallet,baseId:f.baseId,realm:0,authorization:'none',acceptingDepartures:true,route:{routeId:'paid_frostveil',routeCatalogueVersion:3,rewardTableVersion:2},coverage:{status:'covered',expiresAt:bank.accessModel.expires_at.toString()}});
  expect(connect).toHaveBeenCalledOnce();expect(await trips(f)).toEqual([]);expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId,f.baseId))).toEqual([]);
 });
 it('shows source unavailability without claiming absent coverage and leaves historical recovery readable',async()=>{
  const f=await fixture(),r=await view(f,missing);expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({acceptingDepartures:false,coverage:{status:'unavailable'}});expect((await post(f,missing)).statusCode).toBe(503);expect(connect).not.toHaveBeenCalled();expect(await trips(f)).toEqual([]);
 });
 it.each(['absent','expired'] as const)('refuses %s coverage without persisting a departure',async kind=>{
  const f=await fixture();if(kind==='absent')bank.rows[3]=null;else{const BN=bank.accessModel.expires_at.constructor as new(n:string)=>typeof bank.accessModel.expires_at;bank.accessModel.expires_at=new BN(String(Math.floor(Date.now()/1000)));await bank.encode('access');}
  const selected=await view(f);expect(selected.json().coverage).toEqual({status:'blocked',reason:kind==='absent'?'NO_COVERAGE':'EXPIRED'});const r=await post(f);expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe(`EXPEDITION_ACCESS_${kind==='absent'?'NO_COVERAGE':'EXPIRED'}`);expect(await trips(f)).toEqual([]);
 });
 it('dispatches with a new authentic access observation then replays while both providers and starts are unavailable',async()=>{
  const f=await fixture();expect((await view(f)).statusCode).toBe(200);const accepted=await post(f);expect(accepted.statusCode).toBe(201);const original=accepted.json().receipt;expect(original.route.access.observation.wallet).toBe(f.wallet);expect(connect).toHaveBeenCalledTimes(2);
  vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');connect.mockImplementationOnce(()=>{throw Error('secret RPC credential');});const replay=await post(f,missing);expect(replay.statusCode).toBe(200);expect(replay.json().receipt).toEqual(original);expect(connect).toHaveBeenCalledTimes(2);
  const recovered=await missing.inject({url:`/starter-expeditions/by-key/${f.request.idempotencyKey}`,cookies:f.cookies});expect(recovered.json().receipt).toEqual(original);expect(await trips(f)).toHaveLength(1);
 });
 it('maps a failed source to unavailable without leaking provider details or granting new admission',async()=>{
  const f=await fixture();connect.mockImplementation(()=>{throw Error('secret RPC credential');});const r=await view(f);expect(r.statusCode).toBe(200);expect(r.json().coverage).toEqual({status:'unavailable'});expect(r.body).not.toContain('secret');const refused=await post(f);expect(refused.statusCode).toBe(503);expect(refused.body).not.toContain('secret');expect(await trips(f)).toEqual([]);connect.mockImplementation(()=>bank.rpc);
 });
});
