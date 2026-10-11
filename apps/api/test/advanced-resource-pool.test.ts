import {readFileSync} from 'node:fs';
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions,deedOwnershipObservations} from '../src/db/schema';
import {TEST_CONFIG} from './helpers';
import {createResourceTaxFixture} from './fixtures/seekerResourceClaims';
import {registerOwnedDeed} from '../src/game/baseOwnership';
import {installStarterFleet} from '../src/game/starterFleet';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import * as sourceClaims from '../src/game/seekerResourceClaims';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import * as baseAuthority from '../src/game/baseOwnership';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {settleDueAdvancedExpeditions} from '../src/game/advancedExpeditionReturns';
import {claimSeekerResourceTax,readCompleteSeekerResourcePool} from '../src/game/seekerResourceClaims';
import {createSeekerResourceClaimProvider} from '../src/game/seekerResourceClaimProvider';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,now:Date,bank:Awaited<ReturnType<typeof createMiningTermFixture>>;
beforeEach(async()=>{
 // 2026-10-10: 0256/0279 refuse a settlement cutoff later than Postgres clock_timestamp(), which no test can fake, so this
 // calendar sits in the real past (the 790271776 convention) and the berth and Lodge complete an hour before it.
 now=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);
 f=await vehicleBurnDatabase('survey_balloon',1,{},{completedAt:new Date(+now-3600000)});f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const id=randomUUID();await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${id},${f.actor},${f.baseId},'lodge',5,5)`;
 await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${id},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_SEEKER_ENABLED'])vi.stubEnv(flag,'true');
 bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey,winners:[0,1,2,3].map(spotId=>({spotId,wallet:new PublicKey(f.actor)}))});
 await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},'rough_prism',1000,0)`;
},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function dispatch(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);const reader=await prefetchExpeditionTermReader(bank.connect,bank.policy);return dispatchAdvancedExpedition(f.conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1},{baseId:f.baseId,assertAuthority:async(...a:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...a);}},{reader,clock:()=>now});}
async function returned(){const trip=await dispatch();now=trip.returnsAt;vi.setSystemTime(now);await f.conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,now));return trip;}
const command=(trip:Awaited<ReturnType<typeof dispatch>>,spotId=0)=>({idempotencyKey:randomUUID(),baseId:f.baseId,termId:trip.termId,resourceId:trip.resourceId,spotId});
it('pays only complete returns to original spots, retains dust and increments later shares',async()=>{
 const trip=await dispatch(),provider=createSeekerResourceClaimProvider(f.conn.db);expect(await readCompleteSeekerResourcePool(f.conn.db,trip.termId,trip.termHash,trip.resourceId)).toBe(0n);
 now=trip.returnsAt;vi.setSystemTime(now);await f.conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,now));
 const receipts=await Promise.all([0,1,2,3].map(i=>provider.claim(f.actor,command(trip,i))));expect(receipts.reduce((n,r)=>n+BigInt(r.quantity),0n)).toBe(trip.tax-trip.tax%4n);
 const next=await returned();const additional=await provider.claim(f.actor,command(trip));expect(BigInt(additional.cumulativeTotal)).toBe((trip.tax+next.tax)/4n);
 const view=await provider.entitlements(f.actor,{});expect(view.status).toBe('available');expect(view.rows.find(r=>r.spotId===0&&r.resourceId===trip.resourceId)?.claimedTotal).toBe(additional.cumulativeTotal);
 const saved=command(trip,1),receipt=await provider.claim(f.actor,saved);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');expect(await createSeekerResourceClaimProvider(f.conn.db).claim(f.actor,saved)).toEqual(receipt);expect(await provider.history(f.actor,saved.idempotencyKey)).toEqual(receipt);
});
it.each(['orphan','entry','supply','hash'])('holds %s evidence rather than reporting an empty or partial pool',async kind=>{
 const trip=kind==='orphan'?await dispatch():await returned();await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;if(kind==='orphan')await tx`delete from advanced_expedition_inflight`;if(kind==='entry')await tx`delete from advanced_expedition_entries where bucket='issued'`;if(kind==='supply')await tx`delete from resource_stock_entries`;if(kind==='hash')await tx`update advanced_expeditions set term_hash=repeat('0',64)`;});
 await expect(readCompleteSeekerResourcePool(f.conn.db,trip.termId,trip.termHash,trip.resourceId)).rejects.toThrow();expect((await createSeekerResourceClaimProvider(f.conn.db).entitlements(f.actor,{})).status).toBe('unavailable');expect(await f.conn.sql`select * from seeker_resource_claims`).toHaveLength(0);
});
it('bounds oversized saved source evidence before historical decoding',async()=>{const trip=await returned();await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update advanced_expeditions set home_evidence=jsonb_build_object('oversized',repeat('x',9*1024*1024))`;});await expect(readCompleteSeekerResourcePool(f.conn.db,trip.termId,trip.termHash,trip.resourceId)).rejects.toMatchObject({code:'SEEKER_RESOURCE_SOURCE_BOUNDS'});});

it.each(['authority','pause'])('rechecks final %s after all source reads and rolls back new delivery',async kind=>{
 const trip=await returned();let calls=0;
 await expect(claimSeekerResourceTax(f.conn.db,f.actor,command(trip),{baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{
  await assertFreshLockedBaseAuthority(...args);calls++;if(calls===2){if(kind==='pause')vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');else throw Error('Final authority held');}
 }})).rejects.toThrow(kind==='pause'?'paused':'Final authority held');
 expect(calls).toBe(2);expect(await f.conn.sql`select * from seeker_resource_claims`).toHaveLength(0);
});
it('never lets an additional admission callback replace the strict production gate',async()=>{
 const trip=await returned();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await expect(claimSeekerResourceTax(f.conn.db,f.actor,command(trip),{baseId:f.baseId,assertAuthority:async()=>{}},{assertAdmission:()=>{}})).rejects.toMatchObject({code:'PHASE_E_DISABLED'});expect(await f.conn.sql`select * from seeker_resource_claims`).toHaveLength(0);
});
it('gives an actual restricted login only a boolean header probe while the closed owner capability can claim',async()=>{
 const trip=await returned(),role='pool_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  const [database]=await f.conn.sql`select current_database() name`;const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select on starter_expeditions,starter_expedition_returns,harvester_sources,harvester_events to ${role}`);
  await expect(runtime.sql`select * from advanced_expeditions`).rejects.toMatchObject({code:'42501'});
  expect(await readCompleteSeekerResourcePool(runtime.db,trip.termId,trip.termHash,'heartwood_logs')).toBe(0n);
  await expect(readCompleteSeekerResourcePool(runtime.db,trip.termId,trip.termHash,trip.resourceId)).rejects.toMatchObject({code:'SEEKER_RESOURCE_EVIDENCE'});
  expect((await runtime.sql`select shardkeep_has_advanced_resource_sources(${trip.termId}::uuid,${trip.resourceId}) present`)[0]!.present).toBe(true);
  await expect(createSeekerResourceClaimProvider(runtime.db).entitlements(f.actor,{})).rejects.toMatchObject({code:'SEEKER_RESOURCE_OWNER'});
  expect((await createSeekerResourceClaimProvider(f.conn.db).claim(f.actor,command(trip))).quantity).toBe((trip.tax/4n).toString());
  await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`delete from advanced_expedition_entries`;await tx`delete from advanced_expedition_returns`;await tx`update advanced_expeditions set term_hash=repeat('0',64)`;});
  expect((await runtime.sql`select shardkeep_has_advanced_resource_sources(${trip.termId}::uuid,${trip.resourceId}) present`)[0]!.present).toBe(true);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});

it('refuses a paused fresh capability claim before any deed prefetch',async()=>{const trip=await returned(),prefetch=vi.spyOn(baseAuthority,'requireFreshBaseAuthority');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await expect(createSeekerResourceClaimProvider(f.conn.db).claim(f.actor,command(trip))).rejects.toMatchObject({code:'PHASE_E_DISABLED'});expect(prefetch).not.toHaveBeenCalled();});

async function destination(){const id=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet) values(${id},${f.actor})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.actor},2,${id})`;return id;}
it('refuses an actual concurrent completion after the pool read and retries without locking the producer base',async()=>{
 const first=await returned(),next=await dispatch(),baseId=await destination(),input={...command(first),baseId};let checks=0,completed=false;
 const authority={baseId,assertAuthority:async(...a:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...a);if(++checks===2){await f.conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,next.returnsAt));completed=true;}}};
 await expect(claimSeekerResourceTax(f.conn.db,f.actor,input,authority)).rejects.toMatchObject({code:'SEEKER_RESOURCE_SOURCE_CHANGED'});expect(completed).toBe(true);expect(baseId).not.toBe(f.baseId);
 expect(await f.conn.sql`select * from seeker_resource_claims`).toHaveLength(0);expect(await f.conn.sql`select * from resource_stocks where base_id=${baseId}`).toHaveLength(0);
 const receipt=await claimSeekerResourceTax(f.conn.db,f.actor,input,authority);expect(BigInt(receipt.quantity)).toBe((first.tax+next.tax)/4n);expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(2);
});
it.each(['expiry','pause'])('holds a fresh claim after a real pool advisory-lock wait and %s',async kind=>{
 const trip=await returned();
 if(kind==='expiry'){const mint=Keypair.generate().publicKey.toBase58();await registerOwnedDeed(f.conn.db,f.actor,mint);await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});}
 let ready!:()=>void,release!:()=>void,pid=0;const start=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r),holder=f.conn.sql.begin(async tx=>{await tx`select pg_advisory_xact_lock(hashtextextended(${`seeker-resource:${trip.termId}:${trip.resourceId}`},0))`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});
 let pending:Promise<unknown>|undefined;
 try{await start;pending=createSeekerResourceClaimProvider(f.conn.db).claim(f.actor,command(trip)).then(value=>({value}),error=>({error}));
  await expect.poll(async()=>(await f.conn.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%') waiting`)[0]!.waiting).toBe(true);
  if(kind==='expiry'){now=new Date(+now+BASE_OWNERSHIP.mutationFreshnessMs+1);vi.setSystemTime(now);}else vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  release();const result=await pending;expect(result).toMatchObject({error:{code:kind==='expiry'?'DEED_AUTHORITY_UNAVAILABLE':'PHASE_E_DISABLED'}});expect(await f.conn.sql`select * from seeker_resource_claims`).toHaveLength(0);
 }finally{release();await holder;await pending;}
});
it.each(['supply_bytes','supply_events','raid_bytes','raid_events'])('bounds the entire %s proof graph before decoding',async kind=>{
 const trip=await returned();await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;
  if(kind==='supply_bytes')await tx`update resource_stock_operations set custody_wallet=repeat('x',9*1024*1024)`;
  if(kind==='supply_events'){
   await tx`create temporary table extra_supplies as select gen_random_uuid() r,gen_random_uuid() c,'bound_'||n resource from generate_series(1,3000) n`;
   await tx`insert into resource_stock_operations(id,kind,base_id,resource_id,quantity,custody_wallet) select r,'reserve',${f.baseId},'rough_prism',1,${f.actor} from extra_supplies`;
   await tx`insert into resource_stock_operations(id,kind,base_id,resource_id,quantity,custody_wallet,reservation_id) select c,'consume',${f.baseId},'rough_prism',1,${f.actor},r from extra_supplies`;
   await tx`insert into advanced_expedition_supplies(expedition_id,resource_id,reserve_id,consume_id) select ${trip.id},resource,r,c from extra_supplies`;
   await tx`insert into resource_stock_entries(operation_id,bucket,delta) select r,'available',-1 from extra_supplies union all select r,'reserved',1 from extra_supplies union all select c,'reserved',-1 from extra_supplies union all select c,'consumed',1 from extra_supplies`;
  }
  if(kind==='raid_bytes'||kind==='raid_events')await tx`insert into raw_raid_reservation_debits(raid_id,resource_id,reservation_id,quantity,bucket) select gen_random_uuid(),case when ${kind}='raid_bytes' then repeat('x',2048) else 'rough_prism' end,reserve_id,1,'reserved' from advanced_expedition_supplies cross join generate_series(1,${kind==='raid_events'?20001:5000}) where expedition_id=${trip.id}`;
 });
 // Deliberately malformed operator-corruption fixtures must hit the bound
 // before attempting any historical source or missing-parent decoder.
 await expect(readCompleteSeekerResourcePool(f.conn.db,trip.termId,trip.termHash,trip.resourceId)).rejects.toMatchObject({code:'SEEKER_RESOURCE_SOURCE_BOUNDS'});
 expect((await createSeekerResourceClaimProvider(f.conn.db).entitlements(f.actor,{})).reason).toBe('SOURCE_BOUNDS');expect(await f.conn.sql`select * from seeker_resource_claims`).toHaveLength(0);
});
async function returnedCommonStarter(){
 vi.stubEnv('STARTER_FLEET_ENABLED','true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','true');const berth=randomUUID();
 await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berth},${f.actor},${f.baseId},'berth',9,5)`;await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${berth},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
 const authority={baseId:f.baseId,assertAuthority:async(...a:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...a);}},fleet=await installStarterFleet(f.conn.db,f.actor,berth,authority),p=starterRoutePreview('crownlands','common_elderwood');
 bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);
 const trip=await dispatchStarterExpedition(f.conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,installationId:fleet.installationId,routeId:p.routeId,routeVersion:p.routeCatalogueVersion,rewardVersion:p.rewardTableVersion},authority,{reader:await prefetchExpeditionTermReader(bank.connect,bank.policy),clock:()=>now});now=trip.returnsAt;vi.setSystemTime(now);await f.conn.db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,now));return trip;
}
it('shares a byte budget across distinct valid starter and advanced resource pools on one page',async()=>{
 const advanced=await returned(),starter=await returnedCommonStarter();expect(starter.termId).toBe(advanced.termId);expect(starter.resourceId).not.toBe(advanced.resourceId);
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;for(const table of ['advanced_expeditions','starter_expeditions'])await tx.unsafe(`update ${table} set home_evidence=jsonb_set(home_evidence,'{evidence,provenance}',to_jsonb(repeat('x',4500000)))`);});
 for(const trip of [advanced,starter])expect(await readCompleteSeekerResourcePool(f.conn.db,trip.termId,trip.termHash,trip.resourceId)).toBe(trip.tax);
 const actual=sourceClaims.readCompleteSeekerResourcePool,budgets:unknown[]=[];vi.spyOn(sourceClaims,'readCompleteSeekerResourcePool').mockImplementation(async(...a)=>{budgets.push(a[4]);return actual(...a);});
 expect(await createSeekerResourceClaimProvider(f.conn.db).entitlements(f.actor,{})).toMatchObject({status:'unavailable',reason:'SOURCE_BOUNDS',rows:[]});expect(budgets.length).toBeGreaterThan(1);expect(new Set(budgets).size).toBe(1);
});
it('reapplies0210 twice without changing original source, pool or claim history',async()=>{
 const trip=await returned(),provider=createSeekerResourceClaimProvider(f.conn.db),input=command(trip),receipt=await provider.claim(f.actor,input),before=await f.conn.sql`select to_jsonb(s) row from advanced_expeditions s`;
 const migration=readFileSync(new URL('../drizzle/0210_advanced_expedition_resource_pool.sql',import.meta.url),'utf8');for(let n=0;n<2;n++)await f.conn.sql.begin(async tx=>{for(const statement of migration.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});
 expect(await provider.claim(f.actor,input)).toEqual(receipt);expect(await f.conn.sql`select to_jsonb(s) row from advanced_expeditions s`).toEqual(before);expect(await readCompleteSeekerResourcePool(f.conn.db,trip.termId,trip.termHash,trip.resourceId)).toBe(trip.tax);
});
it('uses authenticated HTTP with an ordinary LOGIN, holds missing capability and preserves unrelated legacy pools',async()=>{
 const trip=await returned(),role='http_pool_'+randomUUID().replaceAll('-',''),password=randomUUID(),legacy=await createResourceTaxFixture(f.conn.db);let runtime:ReturnType<typeof createDb>|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
 const provider=createSeekerResourceClaimProvider(f.conn.db),input=command(trip);
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 async function cookies(wallet:string){const [s]=await f.conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
 async function start(withCapability:boolean){await app?.close();vi.stubEnv('MULTI_BASE_ENABLED','false');try{app=await buildApp(TEST_CONFIG,runtime!.db,withCapability?{seekerResourceClaimProvider:provider}:{});await app.ready();}finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}}
 try{
  const [database]=await f.conn.sql`select current_database() name`;const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  // Explicit old session/game/claim rights. No advanced journal privileges.
  await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select on sessions,players,alpha_access,bases,base_slots,base_raid_locks,deed_ownership_observations,expedition_term_snapshots,starter_expeditions,starter_expedition_returns,starter_expedition_entries,starter_expedition_inflight,harvester_sources,harvester_events,harvester_entries,harvester_source_closures,harvester_custody_stops,seeker_resource_claims,seeker_resource_claim_entries to ${role};grant update on players,bases,base_slots,base_raid_locks,deed_ownership_observations to ${role};grant insert on seeker_resource_claims to ${role}`);
  const auth=await cookies(f.actor),oldAuth=await cookies(legacy.winner.wallet);await start(false);
  expect((await app!.inject({method:'POST',url:'/seeker/resource-claims',payload:input})).statusCode).toBe(401);
  const held=await app!.inject({method:'POST',url:'/seeker/resource-claims',cookies:auth,payload:input});expect(held.statusCode,held.body).toBe(409);expect(held.json().error.code).toBe('SEEKER_RESOURCE_EVIDENCE');
  const unavailable=await app!.inject({url:'/seeker/resource-claims',cookies:auth});expect(unavailable.statusCode,unavailable.body).toBe(200);expect(unavailable.json()).toMatchObject({status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[]});
  const old=await app!.inject({method:'POST',url:'/seeker/resource-claims',cookies:oldAuth,payload:legacy.command()});expect(old.statusCode,old.body).toBe(201);
  for(const table of ['advanced_expeditions','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_inflight','advanced_expedition_supplies'])await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});await start(true);
  const accepted=await app!.inject({method:'POST',url:'/seeker/resource-claims',cookies:auth,payload:input});expect(accepted.statusCode,accepted.body).toBe(201);expect(accepted.headers['cache-control']).toBe('private, no-store');expect(accepted.body).not.toContain('routeSnapshot');
  const view=await app!.inject({url:'/seeker/resource-claims',cookies:auth});expect(view.statusCode,view.body).toBe(200);expect(view.json().status).toBe('available');
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await start(false);
  const replay=await app!.inject({method:'POST',url:'/seeker/resource-claims',cookies:auth,payload:input});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual(accepted.json());
  expect((await app!.inject({url:`/seeker/resource-claims/by-key/${input.idempotencyKey}`,cookies:auth})).json()).toEqual(accepted.json());
 }finally{await app?.close();await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
},120_000);
