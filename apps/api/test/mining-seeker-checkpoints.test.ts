import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {captureMiningSeekerCheckpoint,readMiningSeekerCheckpointInterval,validateMiningSeekerCheckpointIntervalEvidence,initializeMiningSeekerCoverageChallenge,readMiningSeekerCoverageChallenge,validateMiningSeekerCoverageChallenge} from '../src/mining/seekerCheckpointHistory';
import {withSeekerLinkHistoryFixture as fixture} from './fixtures/seekerLinkHistory';
import {ADMIN_DATABASE_URL} from './db-url';
type F=Parameters<Parameters<typeof fixture>[0]>[0];
async function prepared(f:F){await f.clock('2020-01-01T12:00:00.000001Z');await f.link();await f.clock('2020-01-01T23:59:59.999999Z');await captureMiningSeekerCheckpoint(f.conn.db,f.wallet);await f.close();}
const read=(f:F)=>readMiningSeekerCheckpointInterval(f.conn.db,f.request);
const rows=(f:F)=>f.conn.sql`select to_jsonb(c) value from mining_seeker_checkpoints c order by observed_at,event_frontier`;
describe('committed Seeker link checkpoints without chain or bonus authority',()=>{
 it('replays a closed microsecond-boundary interval, preserving the original event floor and paused read without current badge authority',()=>fixture(async f=>{
  await prepared(f);const saved=await read(f);expect(saved).toMatchObject({wallet:f.wallet,day:f.request.day,coverageStartedAt:'2020-01-01T00:00:00.000000Z',recordedHistoryStartedAt:'2020-01-01T00:00:00.000000Z',birthEventFloor:'0',checkpoint:{observedAt:'2020-01-01T23:59:59.999999Z'},link:{wallet:f.wallet,seekerWallet:f.seekerWallet,sgtMint:f.sgtMint,revokedAt:null},uniqueMintSinceCoverage:true,historicalChainOwnership:'unknown',bonusAuthorized:false,eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false});
  expect(saved.events).toHaveLength(2);expect(Object.isFrozen(saved.checkpoint.link)).toBe(true);expect(validateMiningSeekerCheckpointIntervalEvidence(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  await f.conn.sql`update players set seeker_verified=false where wallet=${f.wallet}`;await f.conn.sql`update seeker_links set verified_at=now(),last_checked_at=now() where wallet=${f.wallet}`;
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await read(f)).toEqual(saved);await expect(captureMiningSeekerCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'DISABLED'});
 }),30_000);
 it('derives birth, link, clock and global frontier instead of accepting caller snapshot fields',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();await f.clock('2020-01-01T13:00:00.123456Z');const forged=randomUUID();
  await f.conn.sql`insert into mining_seeker_checkpoints(id,wallet,observed_at,event_frontier,coverage_started_at,recorded_history_started_at,birth_event_floor,birth,link) values(${forged},${f.wallet},'1900-01-01',9223372036854775807,'1900-01-01','1900-01-01',9223372036854775807,'{}','{}')`;
  await f.close();const saved=await read(f);expect(saved.checkpoint.id).not.toBe(forged);expect(saved.checkpoint).toMatchObject({observedAt:'2020-01-01T13:00:00.123456Z',birth:{wallet:f.wallet,created_at:'2020-01-01T01:00:00.000000Z'},link:{sgt_mint:f.sgtMint}});
  const [frontier]=await f.conn.sql`select max(id)::text id from mining_free_cohort_events`;expect(saved.checkpoint.eventFrontier).toBe(frontier!.id);
 }),30_000);
 it('retains the first unchanged checkpoint across retries and raw migration replay',()=>fixture(async f=>{
  await prepared(f);const original=await rows(f),saved=await read(f);await captureMiningSeekerCheckpoint(f.conn.db,f.wallet);expect(await rows(f)).toEqual(original);
  for(let repeat=0;repeat<2;repeat++)for(const statement of readFileSync(new URL('../drizzle/0258_mining_seeker_checkpoints.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await f.conn.sql.unsafe(statement);
  expect(await rows(f)).toEqual(original);expect(await read(f)).toEqual(saved);
 }),30_000);
 it.each(['revoke-revive','delete-recreate','out-back','after-end','backdated'] as const)('refuses %s after the frontier even when endpoint or apparent interval matches',kind=>fixture(async f=>{
  await prepared(f);await f.clock(kind==='backdated'?'2020-01-01T12:00:00Z':kind==='after-end'?'2020-01-03T12:00:00Z':'2020-01-02T12:00:00Z');
  await f.conn.sql.begin(async tx=>{
   if(kind==='delete-recreate'){await tx`delete from seeker_links where wallet=${f.wallet}`;await tx`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.wallet},${f.seekerWallet},${f.sgtMint})`;}
   else if(kind==='out-back'){await tx`update seeker_links set wallet=${f.buyer} where wallet=${f.wallet}`;await tx`update seeker_links set wallet=${f.wallet} where wallet=${f.buyer}`;}
   else{await tx`update seeker_links set revoked_at=now() where wallet=${f.wallet}`;await tx`update seeker_links set revoked_at=null where wallet=${f.wallet}`;}
  });await f.close();await expect(read(f)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),30_000);
 it('rejects source changes in a transaction spanning midnight and returns BUSY until that writer commits',()=>fixture(async f=>{
  await prepared(f);await f.clock('2020-01-01T23:59:59.999999Z');let ready!:()=>void,release!:()=>void;const begun=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`delete from seeker_links where wallet=${f.wallet}`;await tx`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.wallet},${f.seekerWallet},${f.sgtMint})`;ready();await gate;});
  try{await begun;await f.close();await expect(read(f)).rejects.toMatchObject({code:'BUSY'});await expect(captureMiningSeekerCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  await expect(read(f)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),30_000);
 it('requires a committed pre-interval checkpoint, closed day and a top-level caller',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();await f.close();await expect(read(f)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await f.clock('2020-01-02T00:00:00Z');await captureMiningSeekerCheckpoint(f.conn.db,f.wallet);await f.close();await expect(read(f)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await f.clock('2020-01-02T12:00:00Z');await expect(read(f)).rejects.toMatchObject({code:'DAY_OPEN'});
  await expect(f.conn.db.transaction(tx=>captureMiningSeekerCheckpoint(tx as unknown as Db,f.wallet))).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.conn.db.transaction(tx=>readMiningSeekerCheckpointInterval(tx as unknown as Db,f.request))).rejects.toMatchObject({code:'INVALID_INPUT'});
  for(const extra of [{day:'2020-02-30'},{bonusAuthorized:true},{wallet:'x'},{now:new Date()}])await expect(readMiningSeekerCheckpointInterval(f.conn.db,{...f.request,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
 }),30_000);
 it('rejects own uncommitted source writes including released savepoints and display-only writes',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();
  for(const releaseSavepoint of [false,true])await expect(f.conn.sql.begin(async tx=>{await tx`savepoint source`;await tx`update seeker_links set last_checked_at=now() where wallet=${f.wallet}`;if(releaseSavepoint)await tx`release savepoint source`;await tx`insert into mining_seeker_checkpoints(wallet) values(${f.wallet})`;})).rejects.toThrow('MINING_SEEKER_CHECKPOINT_REQUIRES_FRESH_TRANSACTION');
  expect(await rows(f)).toHaveLength(0);await captureMiningSeekerCheckpoint(f.conn.db,f.wallet);expect(await rows(f)).toHaveLength(1);
 }),30_000);
 it.each(['uncaptured','pre-marker'] as const)('rejects %s player birth instead of backfilling identity',kind=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();await expect(captureMiningSeekerCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});expect(await rows(f)).toHaveLength(0);
 },kind==='uncaptured'?{preCoverageBirth:true}:{beforeMarkerBirth:true,markerAt:'2020-01-01T01:00:00Z'}),30_000);
 it('requires the explicit original coverage marker and exact enabled capture/immutability bindings',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();await expect(captureMiningSeekerCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 },{marker:false}),30_000);
 it.each(['seeker_links_mining_free_capture','mining_free_cohort_events_immutable','mining_seeker_checkpoints_immutable'] as const)('rejects disabled source guard %s on capture or closed read',trigger=>fixture(async f=>{
  await prepared(f);const table=trigger==='seeker_links_mining_free_capture'?'seeker_links':trigger==='mining_free_cohort_events_immutable'?'mining_free_cohort_events':'mining_seeker_checkpoints';
  await f.conn.sql.unsafe(`alter table ${table} disable trigger ${trigger}`);await expect(read(f)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  if(table!=='mining_seeker_checkpoints')await expect(captureMiningSeekerCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);
 it('refuses stale snapshot transactions and clock regression without rewriting a checkpoint',()=>fixture(async f=>{
  await prepared(f);const original=await rows(f);for(const isolation of ['repeatable read','serializable'])await expect(f.conn.sql.begin('isolation level '+isolation,tx=>tx`insert into mining_seeker_checkpoints(wallet) values(${f.wallet})`)).rejects.toThrow('MINING_SEEKER_CHECKPOINT_READ_COMMITTED_REQUIRED');
  await f.clock('2020-01-01T01:00:00Z');await expect(captureMiningSeekerCheckpoint(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});expect(await rows(f)).toEqual(original);
 }),30_000);
 it('rejects prior cross-wallet reuse of the claimed mint even after deletion',()=>fixture(async f=>{
  await f.clock('2020-01-01T02:00:00Z');await f.link(f.buyer);await f.conn.sql`delete from seeker_links where wallet=${f.buyer}`;await prepared(f);await expect(read(f)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),30_000);
 it('allows the same Seeker wallet with a different historical mint and same-gamewallet address updates before capture',()=>fixture(async f=>{
  await f.clock('2020-01-01T02:00:00Z');await f.link(f.buyer,f.key(),f.seekerWallet);await f.conn.sql`delete from seeker_links where wallet=${f.buyer}`;
  await f.link(f.wallet,f.sgtMint,f.key());await f.conn.sql`update seeker_links set seeker_wallet=${f.seekerWallet} where wallet=${f.wallet}`;
  await f.clock('2020-01-01T23:59:59.999999Z');await captureMiningSeekerCheckpoint(f.conn.db,f.wallet);await f.close();expect(await read(f)).toMatchObject({uniqueMintSinceCoverage:true,link:{sgtMint:f.sgtMint,seekerWallet:f.seekerWallet}});
 }),30_000);
 it('bounds retained event rows before decoding and does not silently truncate source history',()=>fixture(async f=>{
  await prepared(f);await f.conn.sql.unsafe(`do $$ begin for n in 1..5000 loop update seeker_links set revoked_at=now() where wallet='${f.wallet}';update seeker_links set revoked_at=null where wallet='${f.wallet}';end loop;end $$`);
  await expect(read(f)).rejects.toMatchObject({code:'TOO_LARGE'});
 }),60_000);
 it('strictly replays identities, all source fields, chronology and false authority flags',()=>fixture(async f=>{
  await prepared(f);const original=await read(f);
  const mutations=[(v:typeof original)=>{v.checkpoint.eventFrontier='0';},(v:typeof original)=>{v.events=[];},(v:typeof original)=>{v.coverageStartedAt='2020-01-01T02:00:00.000000Z';},(v:typeof original)=>{v.events[1]!.id='999999';},(v:typeof original)=>{v.events[1]!.observedAt='2020-01-01T00:30:00.000000Z';},(v:typeof original)=>{v.link.seekerWallet=f.key();},(v:typeof original)=>{Object.assign(v,{bonusAuthorized:true});},(v:typeof original)=>{Object.assign(v.events[0]!.afterState!,{invented:true});}];
  for(const mutate of mutations){const copy=structuredClone(original);mutate(copy);expect(()=>validateMiningSeekerCheckpointIntervalEvidence(copy)).toThrow();}expect(validateMiningSeekerCheckpointIntervalEvidence(original)).toEqual(original);
 }),30_000);
 it('keeps checkpoint writes private and immutable under accidental broad grants or a forged temporary trigger',()=>fixture(async f=>{
  await prepared(f);const original=await rows(f),role='seeker_checkpoint_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{await f.conn.sql.unsafe(`grant connect on database ${f.name} to ${role};grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+f.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
   expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);await expect(runtime.sql`select * from mining_seeker_checkpoints`).rejects.toMatchObject({code:'42501'});
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role};grant all on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
   for(const command of [`insert into mining_seeker_checkpoints(wallet) values('${f.wallet}')`,'update mining_seeker_checkpoints set observed_at=observed_at','delete from mining_seeker_checkpoints','truncate mining_seeker_checkpoints'])await expect(runtime.sql.unsafe(command)).rejects.toThrow('MINING_SEEKER_CHECKPOINT_IMMUTABLE');
   await expect(runtime.sql.begin(async tx=>{await tx`create temporary table fake(wallet text)`;await tx`create trigger mining_seeker_checkpoints_immutable before insert on fake for each row execute function public.shardkeep_mining_seeker_checkpoint_guard()`;await tx`insert into fake values(${f.wallet})`;})).rejects.toThrow('MINING_SEEKER_CHECKPOINT_IMMUTABLE');
   for(const command of ['update mining_seeker_checkpoints set observed_at=observed_at','delete from mining_seeker_checkpoints','truncate mining_seeker_checkpoints'])await expect(f.conn.sql.unsafe(command)).rejects.toThrow('MINING_SEEKER_CHECKPOINT_IMMUTABLE');
   expect(await rows(f)).toEqual(original);
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});

describe('causal coverage challenge generated after the committed marker',()=>{
 it('starts empty and generates a one-time unpredictable nonce instead of caller input, binding original coverage',()=>fixture(async f=>{
  expect(await f.conn.sql`select * from mining_seeker_coverage_challenges`).toHaveLength(0);await expect(readMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await f.clock('2020-01-01T03:00:00.123456Z');await f.conn.sql`insert into mining_seeker_coverage_challenges(id,nonce,created_at,coverage_started_at,recorded_history_started_at,birth_event_floor) values(false,${'0'.repeat(64)},'1900-01-01','1900-01-01','1900-01-01',999999)`;
  const proof=await readMiningSeekerCoverageChallenge(f.conn.db);expect(proof).toMatchObject({version:1,purpose:'seeker_coverage_challenge',coverageStartedAt:'2020-01-01T00:00:00.000000Z',recordedHistoryStartedAt:'2020-01-01T00:00:00.000000Z',birthEventFloor:'0',createdAt:'2020-01-01T03:00:00.123456Z'});expect(proof.nonce).toMatch(/^[0-9a-f]{64}$/);expect(proof.nonce).not.toBe('0'.repeat(64));expect(proof.memo).toBe('SHARDKEEP:MINING:SEEKER:COVERAGE:v1:'+proof.nonce);
  await f.close();await initializeMiningSeekerCoverageChallenge(f.conn.db);expect(await readMiningSeekerCoverageChallenge(f.conn.db)).toEqual(proof);expect(await f.conn.sql`select id from mining_seeker_coverage_challenges`).toHaveLength(1);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await readMiningSeekerCoverageChallenge(f.conn.db)).toEqual(proof);await expect(initializeMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'DISABLED'});
 }),30_000);
 it('requires a committed original marker and rejects direct same-transaction marker insertion even after a released savepoint',()=>fixture(async f=>{
  await expect(initializeMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  for(const releaseSavepoint of [false,true])await expect(f.conn.sql.begin(async tx=>{await tx`savepoint marker`;await tx`insert into mining_seeker_link_coverage(id) values(true)`;if(releaseSavepoint)await tx`release savepoint marker`;await tx`insert into mining_seeker_coverage_challenges(id) values(true)`;})).rejects.toThrow('MINING_SEEKER_CHECKPOINT_REQUIRES_FRESH_TRANSACTION');
  expect(await f.conn.sql`select * from mining_seeker_link_coverage`).toHaveLength(0);expect(await f.conn.sql`select * from mining_seeker_coverage_challenges`).toHaveLength(0);
  await f.initialize();await initializeMiningSeekerCoverageChallenge(f.conn.db);expect((await readMiningSeekerCoverageChallenge(f.conn.db)).nonce).toMatch(/^[0-9a-f]{64}$/);
 },{marker:false}),30_000);
 it('rejects outer caller transactions and stale isolation rather than exposing an uncommitted challenge',()=>fixture(async f=>{
  await expect(f.conn.db.transaction(tx=>initializeMiningSeekerCoverageChallenge(tx as unknown as Db))).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.conn.db.transaction(tx=>readMiningSeekerCoverageChallenge(tx as unknown as Db))).rejects.toMatchObject({code:'INVALID_INPUT'});
  for(const isolation of ['repeatable read','serializable'])await expect(f.conn.sql.begin('isolation level '+isolation,tx=>tx`insert into mining_seeker_coverage_challenges(id) values(true)`)).rejects.toThrow('MINING_SEEKER_CHECKPOINT_READ_COMMITTED_REQUIRED');
  expect(await f.conn.sql`select * from mining_seeker_coverage_challenges`).toHaveLength(0);
 }),30_000);
 it('refuses a pending uncommitted challenge and exposes the same original only after its transaction commits',()=>fixture(async f=>{
  let ready!:()=>void,release!:()=>void;const begun=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});let generated='';
  const writer=f.conn.sql.begin(async tx=>{const [row]=await tx`insert into mining_seeker_coverage_challenges(id) values(true) returning nonce`;generated=row!.nonce;ready();await gate;});
  try{await begun;await expect(readMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'BUSY'});await expect(initializeMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  expect((await readMiningSeekerCoverageChallenge(f.conn.db)).nonce).toBe(generated);
 }),30_000);
 it.each(['disable','drop'] as const)('refuses %s challenge guards instead of trusting an unprotected nonce',kind=>fixture(async f=>{
  await initializeMiningSeekerCoverageChallenge(f.conn.db);
  await f.conn.sql.unsafe(kind==='disable'?'alter table mining_seeker_coverage_challenges disable trigger mining_seeker_coverage_challenges_no_truncate':'drop trigger mining_seeker_coverage_challenges_no_truncate on mining_seeker_coverage_challenges');
  await expect(readMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});await expect(initializeMiningSeekerCoverageChallenge(f.conn.db)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);
 it('retains the exact challenge through migration replay and validates strict payload and marker bindings',()=>fixture(async f=>{
  await initializeMiningSeekerCoverageChallenge(f.conn.db);const proof=await readMiningSeekerCoverageChallenge(f.conn.db);
  for(const statement of readFileSync(new URL('../drizzle/0258_mining_seeker_checkpoints.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await f.conn.sql.unsafe(statement);
  expect(await readMiningSeekerCoverageChallenge(f.conn.db)).toEqual(proof);expect(validateMiningSeekerCoverageChallenge(proof)).toEqual(proof);expect(Object.isFrozen(proof)).toBe(true);
  for(const extra of [{memo:'SHARDKEEP:MINING:SEEKER:COVERAGE:v1:'+'0'.repeat(64)},{nonce:'x'.repeat(64)},{coverageStartedAt:'2020-01-02T00:00:00.000000Z'},{recordedHistoryStartedAt:'2020-01-02T00:00:00.000000Z'},{bonusAuthorized:true},{birthEventFloor:'-1'}])expect(()=>validateMiningSeekerCoverageChallenge({...proof,...extra})).toThrow();
 }),30_000);
 it('keeps challenge mutation private and immutable despite broad grants and rejects forged temporary trigger invocation',()=>fixture(async f=>{
  await initializeMiningSeekerCoverageChallenge(f.conn.db);const original=await readMiningSeekerCoverageChallenge(f.conn.db),role='seeker_challenge_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{await f.conn.sql.unsafe(`grant connect on database ${f.name} to ${role};grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+f.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
   await expect(runtime.sql`select * from mining_seeker_coverage_challenges`).rejects.toMatchObject({code:'42501'});
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role};grant all on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
   await expect(readMiningSeekerCoverageChallenge(runtime.db)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});await expect(initializeMiningSeekerCoverageChallenge(runtime.db)).rejects.toMatchObject({cause:{message:'MINING_SEEKER_CHECKPOINT_CHALLENGE_IMMUTABLE'}});
   for(const client of [runtime.sql,f.conn.sql])for(const command of ['update mining_seeker_coverage_challenges set nonce=nonce','delete from mining_seeker_coverage_challenges','truncate mining_seeker_coverage_challenges'])await expect(client.unsafe(command)).rejects.toThrow('MINING_SEEKER_CHECKPOINT_CHALLENGE_IMMUTABLE');
   await expect(runtime.sql.begin(async tx=>{await tx`create temporary table fake(id boolean)`;await tx`create trigger mining_seeker_coverage_challenges_immutable before insert on fake for each row execute function public.shardkeep_mining_seeker_challenge_guard()`;await tx`insert into fake values(true)`;})).rejects.toThrow('MINING_SEEKER_CHECKPOINT_CHALLENGE_IMMUTABLE');
   expect(await readMiningSeekerCoverageChallenge(f.conn.db)).toEqual(original);
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});
