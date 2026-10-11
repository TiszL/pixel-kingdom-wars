/** Actual installed Core vehicle and signed term fixture; no fabricated uses. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {randomUUID} from 'node:crypto';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PHASE_E_VEHICLES,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {advancedExpeditionPreview} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {dispatchAdvancedExpedition,readAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {settleDueAdvancedExpeditions,readAdvancedExpeditionReturn} from '../src/game/advancedExpeditionReturns';
import {sql} from 'drizzle-orm';
import {readFileSync} from 'node:fs';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {advancedExpeditions,advancedExpeditionInflight} from '../src/game/advancedExpeditionSchema';
import {players,deedOwnershipObservations} from '../src/db/schema';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {prefetchExpeditionRealmAccessReader} from '../src/game/expeditionRealmAccess';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {SEAL_BOUND_100_TRIP_MS} from './sealLatencyBudgets';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>;
let now:Date,bank:Awaited<ReturnType<typeof createMiningTermFixture>>;
beforeEach(async ctx=>{now=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);f=await vehicleBurnDatabase(ctx.task.name.includes('two supplies')?'expedition_barge':'survey_balloon',1,{}, {completedAt:new Date(+now-3600000)});f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const lodge=randomUUID();await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${lodge},${f.actor},${f.baseId},'lodge',5,5)`;await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${lodge},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 for(const resource of ['rough_prism','heartwood_logs','crown_iron_ore'])await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},${resource},1000,0)`;
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');
},120_000);
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
const command=()=>({id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:f.identity.family==='expedition_barge'?'long_survey':'coastal_survey',policyVersion:1});
const authority=()=>({baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}});
async function dispatch(input=command()){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);vi.setSystemTime(now);const reader=await prefetchExpeditionTermReader(bank.connect,bank.policy);return dispatchAdvancedExpedition(f.conn.db,f.actor,input,authority(),{reader,clock:()=>now});}
async function termReader(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);return prefetchExpeditionTermReader(bank.connect,bank.policy);}
async function emptyAdmission(){expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_expedition_inflight`).toHaveLength(0);expect(await f.conn.sql`select * from resource_stock_operations`).toHaveLength(0);}
async function paidReader(options:{expired?:boolean;wrongWallet?:boolean;absent?:boolean}={}){
 const a=await createSeekerRealmAccessFixture(),wallet=options.wrongWallet?Keypair.generate().publicKey:new PublicKey(f.actor),realm=0,expiry=BigInt(+now/1000)+(options.expired?0n:60n);
 const BN=a.accessModel.expires_at.constructor as new(v:string)=>typeof a.accessModel.expires_at;const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),wallet.toBuffer(),Buffer.of(realm)],a.programId);
 Object.assign(a.accessModel,{wallet,realm,bump,expires_at:new BN(String(expiry))});a.rows[3]!.address=address;await a.encode('access');a.rows[4]!.data.writeBigInt64LE(BigInt(+now/1000),32);if(options.absent)a.rows[3]=null;
 bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:a.genesis,programId:a.programId});
 const access=await prefetchExpeditionRealmAccessReader(()=>a.rpc,a.trust,{wallet:wallet.toBase58(),realm},{clock:()=>now});return {...access,bank:a,expiry};
}
const settle=(at:Date)=>f.conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,at));
describe('advanced expedition receipts',()=>{
 it('begins with no flight or completed use for an actual installed vehicle',async()=>{
  expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(0);
  expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
 });
 it('atomically consumes provisions, freezes actual term output and increments use only on the due conserved return',async()=>{
  const before=await f.conn.sql`select available,reserved from resource_stocks where base_id=${f.baseId} and resource_id='rough_prism'`,trip=await dispatch();expect(trip.completedBefore).toBe(0n);expect(await readAdvancedExpeditionReturn(f.conn.db,trip.id)).toBeNull();
  const profile=advancedExpeditionPreview({family:f.identity.family,tier:f.identity.tier,homeRealmId:'crownlands',routeId:'coastal_survey'});expect(trip.gross).toBe(BigInt(profile.grossQuantity));expect((await f.conn.sql`select available,reserved from resource_stocks where base_id=${f.baseId} and resource_id='rough_prism'`)[0]).toEqual({available:String(BigInt(before[0]!.available)-BigInt(profile.supplies[0]!.quantity)),reserved:'0'});
  expect(await settle(new Date(+trip.returnsAt-1))).toHaveLength(0);const [receipt]=await settle(trip.returnsAt);expect(receipt!.receipt.completedTotal).toBe(1n);expect(receipt!.entries.reduce((n,e)=>n+e.delta,0n)).toBe(0n);expect(await settle(new Date(+trip.returnsAt+1000))).toHaveLength(0);expect(await f.conn.sql`select * from advanced_expedition_inflight`).toHaveLength(0);
 });
 it('replays an original dispatch while paused without providers and rejects simultaneous second departures',async()=>{
  const input=command(),trip=await dispatch(input);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');expect(await dispatchAdvancedExpedition(f.conn.db,f.actor,input,authority())).toEqual(trip);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');await expect(dispatch()).rejects.toMatchObject({code:'ADVANCED_INFLIGHT'});expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(1);
 });
 it('rolls back both of two supplies and original source graph if one provision is missing',async()=>{
  await f.conn.sql`update resource_stocks set available=0 where base_id=${f.baseId} and resource_id='heartwood_logs'`;const before=await f.conn.sql`select * from resource_stocks order by resource_id`;await expect(dispatch()).rejects.toMatchObject({code:'INSUFFICIENT_RAW_STOCK'});expect(await f.conn.sql`select * from resource_stocks order by resource_id`).toEqual(before);expect(await f.conn.sql`select * from resource_stock_operations`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(0);
 });
 it('retains paused returns without consulting current term readers or double-crediting concurrent settlement',async()=>{
  const trip=await dispatch();vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const values=await Promise.all([settle(trip.returnsAt),settle(trip.returnsAt)]);expect(values.flat()).toHaveLength(1);expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(1);expect(await readAdvancedExpedition(f.conn.db,trip.id)).toEqual(trip);
 });
 it('enforces the100 completed-return allowance without charging elapsed time or rejected departures',async()=>{
  for(let n=0;n<PHASE_E_VEHICLES.completedUsesPerInstall;n++){const trip=await dispatch();expect(trip.completedBefore).toBe(BigInt(n));now=trip.returnsAt;vi.setSystemTime(now);const [proof]=await settle(now);expect(proof!.receipt.completedTotal).toBe(BigInt(n+1));}
  await expect(dispatch()).rejects.toMatchObject({code:'ADVANCED_EXHAUSTED'});expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(PHASE_E_VEHICLES.completedUsesPerInstall);
 },SEAL_BOUND_100_TRIP_MS);
 it('pins authentic foreign-realm access at departure and preserves its expired original evidence on return',async()=>{
  const access=await paidReader(),trip=await dispatchAdvancedExpedition(f.conn.db,f.actor,{...command(),routeId:'paid_frostveil'},authority(),{reader:await termReader(),readCoverage:access.readCoverage,clock:()=>now});
  expect(trip.accessEvidence).toMatchObject({wallet:f.actor,realm:0,expiresAt:String(access.expiry)});expect(+trip.returnsAt).toBeGreaterThan(Number(access.expiry)*1000);
  access.bank.rpc.getGenesisHash=async()=>{throw Error('No return provider');};vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const [proof]=await settle(trip.returnsAt);expect(proof!.expedition).toEqual(trip);expect(proof!.receipt.completedTotal).toBe(1n);
 });
 it.each(['missing','absent','expired','wrongWallet'] as const)('rejects %s paid authority without consuming provisions or persisting admission',async kind=>{
  const access=kind==='missing'?null:await paidReader({[kind]:true});await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,{...command(),routeId:'paid_frostveil'},authority(),{reader:await termReader(),clock:()=>now,...access?{readCoverage:access.readCoverage}:{}})).rejects.toMatchObject({code:kind==='missing'?'UNAVAILABLE':kind==='absent'?'NO_COVERAGE':kind==='expired'?'EXPIRED':'SOURCE'});await emptyAdmission();
 });
 it('returns to the actual transferred stable base custody while preserving seller history and paused replay',async()=>{
  const input=command(),trip=await dispatch(input),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
  await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});await f.conn.db.insert(players).values({wallet:buyer});
  await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:+now});
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const reopened=f.conn.reopen();try{const [proof]=await reopened.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,trip.returnsAt));expect(proof!.receipt.custodyWallet).toBe(buyer);expect(proof!.expedition.actorWallet).toBe(f.actor);expect(proof!.expedition.installationId).toBe(f.reservation.id);expect(await dispatchAdvancedExpedition(reopened.db,f.actor,input,authority())).toEqual(trip);expect(await readAdvancedExpeditionReturn(reopened.db,trip.id)).toEqual(proof);}finally{await reopened.sql.end();}
 });
 it('serializes concurrent first departures into one committed trip and one provision charge',async()=>{
  const readers=await Promise.all([termReader(),termReader()]);const results=await Promise.allSettled(readers.map(reader=>dispatchAdvancedExpedition(f.conn.db,f.actor,command(),authority(),{reader,clock:()=>now})));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(1);expect(await f.conn.sql`select * from resource_stock_operations where kind='consume'`).toHaveLength(1);
 });
 it.each(['stale','paused'] as const)('rechecks %s admission after a real term-source lock wait and rolls back home, term and provisions',async kind=>{
  const reader=await termReader(),probe=await termReader(),observation=await probe.readOperatingTerm(now.toISOString());if(!observation)throw Error('fixture term');const source=observation.snapshot.source,scope=JSON.stringify([source.genesisHash,source.programId,source.auctionConfig]);
  let ready!:()=>void,release!:()=>void,pid=0;const start=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r),holder=f.conn.sql.begin(async tx=>{await tx`select pg_advisory_xact_lock(hashtextextended(${`expedition-term:${scope}`},0))`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});
  let pending:Promise<unknown>|undefined;try{await start;pending=dispatchAdvancedExpedition(f.conn.db,f.actor,command(),authority(),{reader,clock:()=>now}).then(value=>({value}),error=>({error}));await expect.poll(async()=>(await f.conn.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%') waiting`)[0]!.waiting).toBe(true);
   if(kind==='stale'){now=new Date(+now+PHASE_E_SEEKER_AUCTION.observationMaxAgeMs+1);vi.setSystemTime(now);}else vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');release();const result=await pending;expect(result).toHaveProperty('error');if(kind==='paused')expect(result).toMatchObject({error:{code:'ADVANCED_DISABLED'}});else expect(String((result as {error:unknown}).error)).toContain('stale');await emptyAdmission();expect(await f.conn.sql`select * from expedition_term_snapshots`).toHaveLength(0);expect(await f.conn.sql`select * from expedition_free_homes`).toHaveLength(0);
  }finally{release();await holder;await pending;}
 });
 it.each(['pause','authority'] as const)('rolls back after final %s changes following actual provision consumption',async kind=>{
  let reached=false;const context={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);const [row]=await args[0].execute<{n:string}>(sql`select count(*)::text n from advanced_expedition_supplies`);if(row!.n==='1'){reached=true;if(kind==='pause')vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');else throw Error('Final current authority held');}}};
  await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,command(),context,{reader:await termReader(),clock:()=>now})).rejects.toThrow(kind==='pause'?'Advanced departures paused':'Final current authority held');expect(reached).toBe(true);await emptyAdmission();
 });
 it('cannot replace strict parent gates through a trusted additional admission callback',async()=>{
  vi.stubEnv('MULTI_BASE_ENABLED','false');await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,command(),authority(),{assertAdmission:()=>{},reader:await termReader(),clock:()=>now})).rejects.toMatchObject({code:'ADVANCED_DISABLED'});await emptyAdmission();
 });
 it('requires a top-level dispatch boundary and rejects stale-isolation writes even after a real committed trip',async()=>{
  await expect(f.conn.db.transaction(tx=>dispatchAdvancedExpedition(tx as unknown as Db,f.actor,command(),authority()))).rejects.toThrow('top-level');const trip=await dispatch();await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select * from advanced_expeditions`;await tx`insert into advanced_expedition_returns(expedition_id,custody_wallet,returned_at) values(${trip.id},${f.actor},${trip.returnsAt.toISOString()})`;})).rejects.toThrow('ADVANCED_READ_COMMITTED');expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);
 });
 it('rejects forged completion, early return and a partial conserved graph without consuming an actual inflight source',async()=>{
  const trip=await dispatch();await expect(f.conn.sql`delete from advanced_expedition_inflight where expedition_id=${trip.id}`).rejects.toThrow('ADVANCED_RETURN_REQUIRED');await expect(f.conn.sql`insert into advanced_expedition_returns(expedition_id,custody_wallet,returned_at,completed_total) values(${trip.id},${f.actor},${trip.returnsAt.toISOString()},99)`).rejects.toThrow('ADVANCED_RETURN');await expect(f.conn.sql`insert into advanced_expedition_returns(expedition_id,custody_wallet,returned_at) values(${trip.id},${f.actor},${new Date(+trip.returnsAt-1).toISOString()})`).rejects.toThrow('ADVANCED_RETURN');
  await expect(f.conn.sql.begin(async tx=>{const [r]=await tx`insert into advanced_expedition_returns(expedition_id,custody_wallet,returned_at) values(${trip.id},${f.actor},${trip.returnsAt.toISOString()}) returning id`;await tx`insert into advanced_expedition_entries(return_id,bucket,delta) values(${r!.id},'issued',${String(-trip.gross)})`;await tx`delete from advanced_expedition_inflight where expedition_id=${trip.id}`;})).rejects.toThrow('ADVANCED_ENTRIES_INCOMPLETE');expect(await f.conn.sql`select * from advanced_expedition_returns`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_expedition_inflight`).toHaveLength(1);expect(await settle(trip.returnsAt)).toHaveLength(1);
 });
 it('requires the complete real provision graph for a new trip and retains immutable source history on repeated migrations',async()=>{
  const trip=await dispatch();await settle(trip.returnsAt);await expect(f.conn.db.transaction(async tx=>{const id=randomUUID();await tx.insert(advancedExpeditions).values({...trip,id,completedBefore:1n});await tx.insert(advancedExpeditionInflight).values({installationId:trip.installationId,baseId:trip.baseId,expeditionId:id});})).rejects.toSatisfy((error:Error & {cause?:Error})=>(error.cause??error).message.includes('ADVANCED_SUPPLIES_INCOMPLETE'));expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(1);
  const before=await readAdvancedExpeditionReturn(f.conn.db,trip.id);for(const table of ['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies']){await expect(f.conn.sql.unsafe(`truncate ${table} cascade`)).rejects.toThrow('ADVANCED_IMMUTABLE');if(table!=='advanced_expedition_inflight'){await expect(f.conn.sql.unsafe(`delete from ${table}`)).rejects.toThrow('ADVANCED_IMMUTABLE');}}await expect(f.conn.sql`update advanced_expeditions set gross=gross`).rejects.toThrow('ADVANCED_IMMUTABLE');
  for(let n=0;n<2;n++)await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../drizzle/0209_advanced_expeditions.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});expect(await readAdvancedExpeditionReturn(f.conn.db,trip.id)).toEqual(before);
 });
 it('denies a real runtime role with accidental broad grants and refuses copied trigger authority',async()=>{
  const role='advanced_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{const [database]=await f.conn.sql`select current_database() name`;const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());await expect(runtime.sql`select * from advanced_expeditions`).rejects.toMatchObject({code:'42501'});await f.conn.sql.unsafe(`grant all on advanced_expeditions,advanced_expedition_inflight,advanced_expedition_returns,advanced_expedition_entries,advanced_expedition_supplies to ${role};grant execute on function shardkeep_advanced_expedition_guard() to ${role};grant create,usage on schema public to ${role}`);
   await expect(dispatchAdvancedExpedition(runtime.db,f.actor,command(),authority())).rejects.toMatchObject({code:'ADVANCED_OWNER'});await expect(runtime.sql`insert into advanced_expedition_returns(expedition_id,custody_wallet,returned_at) values(${randomUUID()},${f.actor},${now.toISOString()})`).rejects.toMatchObject({code:'42501'});await expect(runtime.sql`truncate advanced_expedition_entries`).rejects.toMatchObject({code:'42501'});
   await runtime.sql.unsafe('create table fake_advanced(like advanced_expedition_returns including defaults);create trigger advanced_expedition_returns_guard before insert on fake_advanced for each row execute function public.shardkeep_advanced_expedition_guard()');await expect(runtime.sql`insert into fake_advanced(expedition_id,custody_wallet,returned_at) values(${randomUUID()},${f.actor},${now.toISOString()})`).rejects.toThrow('ADVANCED_TRIGGER_IDENTITY');await emptyAdmission();
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });

 it('rechecks actual current custody after a transfer following source prefetch and before departure locks',async()=>{
  const reader=await termReader(),mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();await registerOwnedDeed(f.conn.db,f.actor,mint);await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});await f.conn.db.insert(players).values({wallet:buyer});await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:+now});
  await expect(dispatchAdvancedExpedition(f.conn.db,f.actor,command(),authority(),{reader,clock:()=>now})).rejects.toMatchObject({code:'BASE_NOT_OWNED'});await emptyAdmission();
 });
 it('replays concurrent identical departure keys without a second provision charge',async()=>{
  const input=command(),readers=await Promise.all([termReader(),termReader()]);const trips=await Promise.all(readers.map(reader=>dispatchAdvancedExpedition(f.conn.db,f.actor,input,authority(),{reader,clock:()=>now})));expect(trips[0]).toEqual(trips[1]);expect(await f.conn.sql`select * from advanced_expeditions`).toHaveLength(1);expect(await f.conn.sql`select * from resource_stock_operations where kind='consume'`).toHaveLength(1);
 });

});
