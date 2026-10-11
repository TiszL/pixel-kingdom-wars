import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {captureMiningSeekerEnrollment,readMiningSeekerEnrollmentChallenge,readMiningSeekerEnrollmentInterval,validateMiningSeekerEnrollmentChallenge,validateMiningSeekerEnrollmentIntervalEvidence} from '../src/mining/seekerMiningEnrollment';
import {withSeekerMiningEnrollmentFixture as fixture} from './fixtures/seekerMiningEnrollment';
import {ADMIN_DATABASE_URL} from './db-url';
type F=Parameters<Parameters<typeof fixture>[0]>[0];
const challenge=(f:F)=>readMiningSeekerEnrollmentChallenge(f.conn.db,{wallet:f.wallet});
async function prepared(f:F){await f.clock('2020-01-01T12:00:00Z');await f.link();await captureMiningSeekerEnrollment(f.conn.db,f.wallet);const c=await challenge(f);await f.close();return c;}
const read=async(f:F,id?:string)=>readMiningSeekerEnrollmentInterval(f.conn.db,{wallet:f.wallet,day:'2020-01-02',enrollmentId:id??(await challenge(f)).enrollment.id});
describe('prospective committed Seeker enrollment without bonus authority',()=>{
 it.each([false,true])('admits the current identity prospectively; precoverage birth=%s never becomes fabricated history',preCoverageBirth=>fixture(async f=>{
  const c=await prepared(f),p=await read(f);expect(c.enrollment.player.created_at).toBe('2020-01-01T01:00:00.000000Z');expect(p.events.filter(e=>e.sourceTable==='players')).toHaveLength(preCoverageBirth?0:1);
  expect(p).toMatchObject({version:1,enrollmentId:c.enrollment.id,enrollment:{nonce:c.enrollment.nonce},bonusAuthorized:false,eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false,historicalChainOwnership:'unknown'});
  expect(c.memo).toBe('SHARDKEEP:MINING:SEEKER:ENROLLMENT:v1:'+c.enrollment.nonce);expect(Object.isFrozen(p.enrollment.link)).toBe(true);expect(validateMiningSeekerEnrollmentIntervalEvidence(JSON.parse(JSON.stringify(p)))).toEqual(p);expect(validateMiningSeekerEnrollmentChallenge(c)).toEqual(c);
  await f.conn.sql`update players set seeker_verified=false where wallet=${f.wallet}`;await f.conn.sql`update seeker_links set last_checked_at=now() where wallet=${f.wallet}`;
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await read(f)).toEqual(p);await expect(captureMiningSeekerEnrollment(f.conn.db,f.wallet)).rejects.toMatchObject({code:'DISABLED'});
 },{preCoverageBirth}),30_000);
 it('derives nonce, snapshot, global frontier and source seal, retaining original on same-frontier retry',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00.123456Z');await f.link();const forged=randomUUID();
  await f.conn.sql`insert into mining_seeker_enrollments(id,wallet,nonce,observed_at,event_frontier,coverage_started_at,recorded_history_started_at,birth_event_floor,source_seal,player,link) values(${forged},${f.wallet},${'0'.repeat(64)},'1900-01-01',999999,'1900-01-01','1900-01-01',999999,${'0'.repeat(64)},'{}','{}')`;
  const c=await challenge(f);expect(c.enrollment.id).not.toBe(forged);expect(c.enrollment.nonce).not.toBe('0'.repeat(64));expect(c.enrollment.observedAt).toBe('2020-01-01T12:00:00.123456Z');
  const [state]=await f.conn.sql`select (select max(id)::text from mining_free_cohort_events) frontier,encode(sha256(convert_to(record::text,'UTF8')),'hex') seal from mining_seeker_enrollment_contract`;expect(c.enrollment.eventFrontier).toBe(state!.frontier);expect(c.enrollment.sourceSeal).toBe(state!.seal);
  await f.close();await captureMiningSeekerEnrollment(f.conn.db,f.wallet);expect(await challenge(f)).toEqual(c);expect(await f.conn.sql`select id from mining_seeker_enrollments`).toHaveLength(1);
 }),30_000);
 it.each(['backdated','after-end','out-back','identity'] as const)('rejects all %s post-frontier changes even when the current endpoint matches',kind=>fixture(async f=>{
  const c=await prepared(f);await f.clock(kind==='backdated'?'2020-01-01T11:00:00Z':kind==='after-end'?'2020-01-03T12:00:00Z':'2020-01-02T12:00:00Z');
  if(kind==='out-back'){await f.conn.sql`delete from seeker_links where wallet=${f.wallet}`;await f.link();}
  else if(kind==='identity'){await f.conn.sql`update players set created_at='2020-01-01T02:00:00Z' where wallet=${f.wallet}`;await f.conn.sql`update players set created_at='2020-01-01T01:00:00Z' where wallet=${f.wallet}`;}
  else{await f.conn.sql`update seeker_links set revoked_at=now() where wallet=${f.wallet}`;await f.conn.sql`update seeker_links set revoked_at=null where wallet=${f.wallet}`;}
  await f.close();await expect(read(f,c.enrollment.id)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await captureMiningSeekerEnrollment(f.conn.db,f.wallet);const next=await challenge(f);expect(next.enrollment.id).not.toBe(c.enrollment.id);expect(next.enrollment.nonce).not.toBe(c.enrollment.nonce);expect(await f.conn.sql`select id from mining_seeker_enrollments`).toHaveLength(2);
 }),30_000);
 it('preserves permanent mint identity despite a deleted conflicting claim or current revoked unique claim',()=>fixture(async f=>{
  await f.clock('2020-01-01T02:00:00Z');await f.link(f.buyer);await f.conn.sql`update seeker_links set revoked_at=now() where wallet=${f.buyer}`;await expect(f.link()).rejects.toMatchObject({code:'23505'});await f.conn.sql`delete from seeker_links where wallet=${f.buyer}`;await f.link();await expect(captureMiningSeekerEnrollment(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),30_000);
 it('requires a committed post-capture challenge; pending writer is BUSY then source mutation invalidates only old interval',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`insert into mining_seeker_enrollments(wallet) values(${f.wallet})`;ready();await gate;});
  try{await started;await expect(f.conn.sql.begin(tx=>tx`lock table public.seeker_links in row exclusive mode nowait`)).rejects.toMatchObject({code:'55P03'});await expect(challenge(f)).rejects.toMatchObject({code:'BUSY'});await expect(captureMiningSeekerEnrollment(f.conn.db,f.wallet)).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  const c=await challenge(f);await f.close();expect((await read(f)).enrollment.id).toBe(c.enrollment.id);
  let mutationReady!:()=>void,releaseMutation!:()=>void;const mutationStarted=new Promise<void>(r=>{mutationReady=r}),mutationGate=new Promise<void>(r=>{releaseMutation=r});
  const mutation=f.conn.sql.begin(async tx=>{await tx`update seeker_links set revoked_at=now() where wallet=${f.wallet}`;await tx`update seeker_links set revoked_at=null where wallet=${f.wallet}`;mutationReady();await mutationGate;});
  try{await mutationStarted;await expect(read(f,c.enrollment.id)).rejects.toMatchObject({code:'BUSY'});await expect(captureMiningSeekerEnrollment(f.conn.db,f.wallet)).rejects.toMatchObject({code:'BUSY'});}finally{releaseMutation();await mutation;}
  await expect(read(f,c.enrollment.id)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),30_000);
 it('rejects stale isolation and own uncommitted source writes including released savepoints',()=>fixture(async f=>{
  await f.clock('2020-01-01T12:00:00Z');await f.link();
  for(const isolation of ['repeatable read','serializable'])await expect(f.conn.sql.begin('isolation level '+isolation,tx=>tx`insert into mining_seeker_enrollments(wallet) values(${f.wallet})`)).rejects.toThrow('MINING_SEEKER_ENROLLMENT_READ_COMMITTED_REQUIRED');
  for(const released of [false,true])await expect(f.conn.sql.begin(async tx=>{await tx`savepoint source`;await tx`update seeker_links set last_checked_at=now() where wallet=${f.wallet}`;if(released)await tx`release savepoint source`;await tx`insert into mining_seeker_enrollments(wallet) values(${f.wallet})`;})).rejects.toThrow('MINING_SEEKER_ENROLLMENT_REQUIRES_FRESH_TRANSACTION');
  await expect(f.conn.db.transaction(tx=>captureMiningSeekerEnrollment(tx as unknown as Db,f.wallet))).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(f.conn.db.transaction(tx=>readMiningSeekerEnrollmentChallenge(tx as unknown as Db,{wallet:f.wallet}))).rejects.toMatchObject({code:'INVALID_INPUT'});expect(await f.conn.sql`select id from mining_seeker_enrollments`).toHaveLength(0);
 }),30_000);
 it.each(['clock','capture-body','disabled-guard','unique-index'] as const)('refuses changed %s source authority instead of trusting names',kind=>fixture(async f=>{
  await prepared(f);
  if(kind==='clock')await f.conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '2020-01-04'::timestamptz $$`);
  if(kind==='capture-body')await f.conn.sql.unsafe(`create or replace function public.shardkeep_capture_mining_free() returns trigger language plpgsql as $$ begin return new;end $$`);
  if(kind==='disabled-guard')await f.conn.sql`alter table mining_free_cohort_events disable trigger mining_free_cohort_events_no_truncate`;
  if(kind==='unique-index')await f.conn.sql`drop index seeker_links_sgt_mint_uq`;
  await expect(challenge(f)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});await expect(captureMiningSeekerEnrollment(f.conn.db,f.wallet)).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);
 it('requires an earlier committed baseline, closed day, exact identity and false authority flags',()=>fixture(async f=>{
  const c=await prepared(f),p=await read(f);await expect(readMiningSeekerEnrollmentInterval(f.conn.db,{wallet:f.wallet,day:'2020-01-01',enrollmentId:c.enrollment.id})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await expect(readMiningSeekerEnrollmentChallenge(f.conn.db,{wallet:f.buyer,enrollmentId:c.enrollment.id})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});await f.clock('2020-01-02T12:00:00Z');await expect(read(f)).rejects.toMatchObject({code:'DAY_OPEN'});
  for(const mutate of [(v:typeof p)=>{v.enrollment.sourceSeal='x';},(v:typeof p)=>{v.enrollmentId=randomUUID();},(v:typeof p)=>{v.enrollment.eventFrontier='0';},(v:typeof p)=>{v.link.sgtMint=f.key();},(v:typeof p)=>{Object.assign(v,{bonusAuthorized:true});}]){const copy=structuredClone(p);mutate(copy);expect(()=>validateMiningSeekerEnrollmentIntervalEvidence(copy)).toThrow();}
  expect(()=>validateMiningSeekerEnrollmentChallenge({...c,memo:'SHARDKEEP:MINING:SEEKER:COVERAGE:v1:'+c.enrollment.nonce})).toThrow();
 }),30_000);
 it('keeps enrollment and seal owner-only immutable under broad grants and temporary trigger forgery',()=>fixture(async f=>{
  await prepared(f);const role='seeker_enroll_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{await f.conn.sql.unsafe(`grant connect on database ${f.name} to ${role};grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+f.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});await expect(runtime.sql`select * from mining_seeker_enrollments`).rejects.toMatchObject({code:'42501'});
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role};grant all on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
   await expect(readMiningSeekerEnrollmentChallenge(runtime.db,{wallet:f.wallet})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
   await expect(runtime.sql`insert into mining_seeker_enrollments(wallet) values(${f.wallet})`).rejects.toThrow('MINING_SEEKER_ENROLLMENT_IMMUTABLE');
   for(const client of [runtime.sql,f.conn.sql])for(const table of ['mining_seeker_enrollments','mining_seeker_enrollment_contract'])for(const command of [`delete from ${table}`,`truncate ${table}`,`update ${table} set ${table.endsWith('contract')?'record=record':'nonce=nonce'}`])await expect(client.unsafe(command)).rejects.toThrow(/MINING_SEEKER_ENROLLMENT_(?:SEAL_)?IMMUTABLE/);
   await expect(runtime.sql.begin(async tx=>{await tx`create temporary table fake(wallet text)`;await tx`create trigger mining_seeker_enrollments_immutable before insert on fake for each row execute function public.shardkeep_mining_seeker_enrollment_guard()`;await tx`insert into fake values(${f.wallet})`;})).rejects.toThrow('MINING_SEEKER_ENROLLMENT_IMMUTABLE');
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});
