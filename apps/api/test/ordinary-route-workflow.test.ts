/** D183 named routes use real installed capacity and the same earned-stock,
 * finalized term/access, conserved return and actor history as accepted v1. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {createVehicleClient} from '../src/game/vehicleClient';
import {createAdvancedExpeditionWorkflow,type AdvancedExpeditionWorkflowDependencies} from '../src/game/advancedExpeditionWorkflow';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import {TEST_CONFIG} from './helpers';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,bank:Awaited<ReturnType<typeof createMiningTermFixture>>,now:Date,cookies:Record<string,string>;
const apps:FastifyInstance[]=[],flags=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'];
beforeEach(async ctx=>{
 // 2026-10-10 (K-night-LG1): 0256/0279 refuse a return-settlement cutoff later than Postgres clock_timestamp(), which no
 // test can fake, so the 2035 calendar got ADVANCED_RETURN_CLOCK (500) on collect. Like cluster B (bfe18be25) this calendar
 // sits in the real past: 01:00 UTC three days ago, the old hour of day; the berth and Lodge complete an hour before it.
 now=new Date(Math.floor(Date.now()/86400000-3)*86400000+3600000);
 f=await vehicleBurnDatabase('survey_balloon',ctx.task.name.includes('tier4')?4:1,{},{completedAt:new Date(+now-3600000)});f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const lodge=randomUUID();await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${lodge},${f.actor},${f.baseId},'lodge',8,2)`;
 await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${lodge},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
 await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},'rough_prism',1000,0)`;
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});sync();
 const [s]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(+now+SESSION_TTL_SEC*1000)}).returning();cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,s!.id)};
},120000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120000);
function sync(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);}
function clock(at:string){now=new Date(at);vi.setSystemTime(now);sync();}
async function open(deps:AdvancedExpeditionWorkflowDependencies={term:{connect:bank.connect,get policy(){return bank.policy;}}}){
 const expedition=createAdvancedExpeditionWorkflow(f.conn.db,deps),client=createVehicleClient(f.conn.db,{expeditions:deps});vi.stubEnv('MULTI_BASE_ENABLED','false');
 const app=await buildApp(TEST_CONFIG,f.conn.db,{advancedExpeditionWorkflowProvider:expedition,vehicleClientProvider:client});apps.push(app);await app.ready();for(const name of flags)vi.stubEnv(name,'true');return app;
}
const command=(routeId='mintwake-1',policyVersion=2)=>({idempotencyKey:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId,policyVersion});
const post=(app:FastifyInstance,path:string,body:Record<string,unknown>)=>app.inject({method:'POST',url:path,cookies,payload:body});
const depart=(app:FastifyInstance,body:Record<string,unknown>=command())=>post(app,'/advanced-expeditions',body);
const routes=(app:FastifyInstance,query='')=>app.inject({url:'/vehicles/client/routes?baseId='+f.baseId+query,cookies});
async function noAdmission(){expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(0);expect(await f.conn.sql`select * from resource_stock_operations`).toHaveLength(0);expect(await f.conn.sql`select * from expedition_term_snapshots`).toHaveLength(0);}
async function paid(kind='valid'){
 const a=await createSeekerRealmAccessFixture(),wallet=new PublicKey(f.actor),realm=kind==='wrong-realm'?1:0,expiry=BigInt(+now/1000)+(kind==='expired'?0n:60n),BN=a.accessModel.expires_at.constructor as new(v:string)=>typeof a.accessModel.expires_at;
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),wallet.toBuffer(),Buffer.of(realm)],a.programId);Object.assign(a.accessModel,{wallet,realm,bump,expires_at:new BN(String(expiry))});a.rows[3]!.address=address;await a.encode('access');a.rows[4]!.data.writeBigInt64LE(BigInt(+now/1000),32);
 if(kind!=='cross-source')bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:a.genesis,programId:a.programId});sync();if(kind==='failed')a.rpc.getGenesisHash=async()=>{throw Error('Paid source offline');};return a;
}
// 2026-10-10 (K-night-LG1): since 86856e28a a POST that creates a departure answers 201 (with
// x-pkw-journey-created) and an idempotent replay of the same key answers 200; both carry the same envelope.
it('opts into named HOME routes while omitted query and fresh v1 departures keep their original contract',async()=>{
 const app=await open();const legacy=await routes(app);expect(legacy.statusCode,legacy.body).toBe(200);expect(legacy.json().items[0].previews.every((v:{policyVersion:number})=>v.policyVersion===1)).toBe(true);
 const named=await routes(app,'&policyVersion=2');expect(named.statusCode,named.body).toBe(200);expect(named.json().items[0].previews).toHaveLength(8);expect(named.json().items[0].previews.filter((v:{accessRequirement:string})=>v.accessRequirement==='home')).toMatchObject([{routeId:'mintwake-1',realmId:'crownlands'}]);
 const old=command('coastal_survey',1),legacyTrip=await depart(app,old);expect(legacyTrip.statusCode,legacyTrip.body).toBe(201);clock(legacyTrip.json().receipt.returnsAt);expect((await post(app,'/advanced-expeditions/collect',{baseId:f.baseId})).json().returned).toBe(1);
 const input=command(),response=await depart(app,input);expect(response.statusCode,response.body).toBe(201);const receipt=response.json().receipt;expect(receipt.route).toMatchObject({policyVersion:2,routeId:'mintwake-1',accessRequirement:'home'});clock(receipt.returnsAt);
 const offline=await open({});vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');expect((await offline.inject({url:'/advanced-expeditions/by-key/'+input.idempotencyKey,cookies})).json().return).toBeNull();expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId})).json().returned).toBe(1);expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId})).json().returned).toBe(0);
 const replayed=await depart(offline,input);expect(replayed.statusCode,replayed.body).toBe(200);const restored=replayed.json();expect(restored.receipt).toEqual(receipt);expect(restored.return.completedTotal).toBe('2');expect((await depart(offline,old)).json().receipt.route.policyVersion).toBe(1);
});
it('publishes all32 tier4 named previews but does not turn previewed foreign routes into permit authority',async()=>{
 const app=await open(),result=await routes(app,'&policyVersion=2');expect(result.statusCode,result.body).toBe(200);const previews=result.json().items[0].previews;expect(previews).toHaveLength(32);expect(new Set(previews.map((p:{routeId:string})=>p.routeId)).size).toBe(32);expect(previews.filter((p:{accessRequirement:string})=>p.accessRequirement==='home')).toHaveLength(4);
 const denied=await depart(app,command('aurora-1'));expect(denied.statusCode,denied.body).toBe(503);await noAdmission();
 for(const suffix of ['&policyVersion=02','&policyVersion=3','&policyVersion=2&realmId=frostveil'])expect((await routes(app,suffix)).statusCode).toBe(400);
});
it('rejects tier escalation, unknown IDs and policy substitution before provision or term writes',async()=>{
 const app=await open();for(const input of [command('mintwake-2'),command('mintwake-99'),command('mintwake-1',1),command('coastal_survey',2),command('mintwake-1',3)]){const r=await depart(app,input);expect(r.statusCode,r.body).toBeGreaterThanOrEqual(400);await noAdmission();}
 expect((await depart(app,{...command(),realmId:'crownlands'})).statusCode).toBe(400);await noAdmission();
});
it('binds named foreign route to actual paid realm and retains taxed return after permit expiry while providers are offline',async()=>{
 const a=await paid(),app=await open({term:{connect:bank.connect,policy:bank.policy},access:{connect:()=>a.rpc,trust:a.trust}}),input=command('aurora-1'),r=await depart(app,input);expect(r.statusCode,r.body).toBe(201);const receipt=r.json().receipt;expect(receipt.route).toMatchObject({realmId:'frostveil',accessRequirement:'paid_realm'});expect((await f.conn.sql`select access_evidence from advanced_expeditions`)[0]!.access_evidence).toMatchObject({wallet:f.actor,realm:0});clock(receipt.returnsAt);expect(+now).toBeGreaterThan(Number(a.accessModel.expires_at.toString())*1000);
 const offline=await open({});vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId})).json().returned).toBe(1);const replayed=await depart(offline,input);expect(replayed.statusCode,replayed.body).toBe(200);expect(replayed.json().receipt).toEqual(receipt);
 const [sum]=await f.conn.sql`select sum(delta)::text n from advanced_expedition_entries`;expect(sum!.n).toBe('0');expect(BigInt(receipt.route.netQuantity)+BigInt(receipt.route.islandPoolQuantity)).toBe(BigInt(receipt.route.grossQuantity));
});
it.each(['failed','expired','cross-source','wrong-realm'])('holds named foreign %s source without silently granting HOME rights',async kind=>{
 const a=await paid(kind),app=await open({term:{connect:bank.connect,policy:bank.policy},access:{connect:()=>a.rpc,trust:a.trust}}),r=await depart(app,command('aurora-1'));expect(r.statusCode,r.body).toBeGreaterThanOrEqual(400);await noAdmission();
});
it('rolls back tier4 grade provisions atomically when higher-grade stock is insufficient',async()=>{
 const app=await open(),preview=(await routes(app,'&policyVersion=2')).json().items[0].previews.find((p:{routeId:string})=>p.routeId==='mintwake-4');expect(preview).toBeDefined();await f.conn.sql`update resource_stocks set available=${String(BigInt(preview.supplies[0].quantity)-1n)} where base_id=${f.baseId} and resource_id='rough_prism'`;const before=await f.conn.sql`select * from resource_stocks`;
 const r=await depart(app,command('mintwake-4'));expect(r.statusCode,r.body).toBe(422);expect(r.json().error.code).toBe('INSUFFICIENT_RAW_STOCK');expect(await f.conn.sql`select * from resource_stocks`).toEqual(before);await noAdmission();
});
it('rechecks HOME after source prefetch so a newly paid unminted base cannot depart using the earlier free classification',async()=>{
 const genesis=bank.rpc.getGenesisHash;let changed=false;
 bank.rpc.getGenesisHash=async()=>{if(!changed){await f.conn.sql`update bases set land_paid_at=${now.toISOString()}::timestamptz where id=${f.baseId}`;changed=true;}return genesis();};
 await open();const workflow=createAdvancedExpeditionWorkflow(f.conn.db,{term:{connect:bank.connect,policy:bank.policy}});
 await expect(workflow.dispatch(f.actor,command())).rejects.toMatchObject({statusCode:409,code:'EXPEDITION_HOME_UNAVAILABLE'});expect(changed).toBe(true);await noAdmission();expect(await f.conn.sql`select * from expedition_free_homes`).toHaveLength(0);
});
// QA 2026-10-06: the owner's war camp (paid land, deed not minted) answered GET /vehicles/client/routes with 503 and the
// Berth showed a refresh error. A base with no authoritative HOME is a designed state: the read lists the fleet with no
// route to start, and only the server's departure gate refuses, so the client never invents or hides a route itself.
it('answers a paid unminted base with no startable route instead of a held 503, and departure still refuses',async()=>{
 const app=await open();await f.conn.sql`update bases set land_paid_at=${now.toISOString()}::timestamptz where id=${f.baseId}`;
 for(const query of ['','&policyVersion=2']){const r=await routes(app,query);expect(r.statusCode,r.body).toBe(200);expect(r.json()).toEqual({version:1,wallet:f.actor,baseId:f.baseId,items:[{installationId:f.reservation.id,previews:[]}]});}
 const denied=await depart(app);expect(denied.statusCode,denied.body).toBe(409);expect(denied.json().error.code).toBe('EXPEDITION_HOME_UNAVAILABLE');await noAdmission();
});
