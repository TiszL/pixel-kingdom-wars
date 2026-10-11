/** Real owner capability through authenticated HTTP; no live chain or relay. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {matchAdvancedExpeditionEnvelope} from '@shardkeep/shared/advancedExpeditionApi';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {buildApp,type AppDeps} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import {TEST_CONFIG} from './helpers';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,bank:Awaited<ReturnType<typeof createMiningTermFixture>>,now:Date,cookies:Record<string,string>;
const apps:FastifyInstance[]=[];
beforeEach(async()=>{
 // 2026-10-10: 0256/0279 refuse a settlement cutoff later than Postgres clock_timestamp(), which no test can fake, so this
 // calendar sits in the real past (the 790271776 convention) and the berth and Lodge complete an hour before it.
 now=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);
 f=await vehicleBurnDatabase('survey_balloon',1,{},{completedAt:new Date(+now-3600000)});f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const lodge=randomUUID();await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${lodge},${f.actor},${f.baseId},'lodge',8,2)`;
 await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${lodge},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
 await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},'rough_prism',1000,0)`;
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);
 const [session]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(+now+SESSION_TTL_SEC*1000)}).returning();cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,session!.id)};
},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function provider(online=true){const {createAdvancedExpeditionWorkflow}=await import('../src/game/advancedExpeditionWorkflow');return createAdvancedExpeditionWorkflow(f.conn.db,online?{term:{connect:bank.connect,policy:bank.policy}}:{});}
async function open(capability?:Awaited<ReturnType<typeof provider>>){vi.stubEnv('MULTI_BASE_ENABLED','false');const app=await buildApp(TEST_CONFIG,f.conn.db,{advancedExpeditionWorkflowProvider:capability} as AppDeps);apps.push(app);await app.ready();for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');return app;}
const command=()=>({idempotencyKey:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1});
const post=(app:FastifyInstance,url:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url,cookies,payload});
it('requires authentication and holds an absent private capability',async()=>{
 const app=await open(),url='/advanced-expeditions/by-key/'+randomUUID();expect((await app.inject({url})).statusCode).toBe(401);
 const result=await app.inject({url,cookies});expect(result.statusCode,result.body).toBe(503);expect(result.headers['cache-control']).toBe('private, no-store');
});
it('saves actual dispatch before response, leaves elapsed history unsettled, and collects once while paused',async()=>{
 // A normal provider certifies only newly committed departure with201; original JSON is unchanged.
 const app=await open(await provider()),input=command(),response=await post(app,'/advanced-expeditions',input);expect(response.statusCode,response.body).toBe(201);
 const saved=matchAdvancedExpeditionEnvelope(response.json(),f.actor,input);expect(saved.status).toBe('accepted');if(saved.status!=='accepted')throw Error('Expected accepted');
 const reopened=f.conn.reopen();try{expect(await reopened.sql`select id from advanced_expeditions where id=${input.idempotencyKey}`).toHaveLength(1);}finally{await reopened.sql.end();}
 now=new Date(saved.receipt.returnsAt);vi.setSystemTime(now);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
 const offline=await open(await provider(false));vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
 const history=await offline.inject({url:'/advanced-expeditions/by-key/'+input.idempotencyKey,cookies});expect(history.statusCode,history.body).toBe(200);expect(history.json().return).toBeNull();expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
 for(let n=0;n<2;n++)expect((await post(offline,'/advanced-expeditions/collect',{baseId:f.baseId})).statusCode).toBe(200);
 const final=matchAdvancedExpeditionEnvelope((await offline.inject({url:'/advanced-expeditions/by-key/'+input.idempotencyKey,cookies})).json(),f.actor,input);expect(final.return).toMatchObject({completedTotal:'1'});
 expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(1);expect((await post(offline,'/advanced-expeditions',input)).json()).toEqual(final);
 const receipt=JSON.stringify(final);for(const hidden of ['custodyWallet','homeEvidence','accessEvidence','finality','rawStock','reserveId','consumeId'])expect(receipt).not.toContain(hidden);
});
it('returns identical unknown history for foreign and absent keys without reading private sources',async()=>{
 const app=await open(await provider()),input=command();expect((await post(app,'/advanced-expeditions',input)).statusCode).toBe(201);
 const other=Keypair.generate().publicKey.toBase58();await f.conn.sql`insert into players(wallet) values(${other})`;const [s]=await f.conn.db.insert(sessions).values({wallet:other,expiresAt:new Date(+now+SESSION_TTL_SEC*1000)}).returning();const foreign={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,other,s!.id)};
 const results=[];for(const id of [input.idempotencyKey,randomUUID()]){const response=await app.inject({url:'/advanced-expeditions/by-key/'+id,cookies:foreign});expect(response.statusCode,response.body).toBe(200);results.push({...response.json(),idempotencyKey:'ignored'});}expect(results[0]).toEqual(results[1]);
 expect((await app.inject({method:'POST',url:'/advanced-expeditions/collect',cookies:foreign,payload:{baseId:f.baseId}})).statusCode).toBe(404);
});
it('rejects extra caller authority, malformed requests and changed original bodies',async()=>{
 const app=await open(await provider()),input=command();for(const extra of [{wallet:f.actor},{term:{}},{family:'survey_balloon'},{proof:{}}])expect((await post(app,'/advanced-expeditions',{...input,...extra})).statusCode).toBe(400);
 expect((await post(app,'/advanced-expeditions',input)).statusCode).toBe(201);expect((await post(app,'/advanced-expeditions',{...input,routeId:'long_survey'})).statusCode).toBe(409);
 expect((await post(app,'/advanced-expeditions/collect',{baseId:f.baseId,cutoff:'2100-01-01T00:00:00.000Z'})).statusCode).toBe(400);
 expect((await post(app,'/advanced-expeditions',{...input,routeId:'x'.repeat(5000)})).statusCode).toBe(413);
 expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(1);
});
