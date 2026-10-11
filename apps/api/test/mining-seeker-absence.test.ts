/** Committed-marker Seeker ABSENCE source: a player whose identity coverage and captured
 * birth precede a later Seeker-link marker, with no linked SGT, is proven "never linked
 * before the day's end" from the owner-committed marker, the original captured birth and
 * the complete journal. Zero authority: no bonus, eligibility, allocation or publication
 * is granted here; root composes it into manifests 13/14 later. Local synthetic clocks
 * over a disposable loopback DB; no live source, provider or SBF run. */
import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi,afterEach} from 'vitest';
import {type Db} from '../src/db/client';
import {readMiningSeekerAbsenceInterval,validateMiningSeekerAbsenceIntervalEvidence,type MiningSeekerAbsenceIntervalEvidence} from '../src/mining/seekerMiningAbsence';
import {readMiningSeekerLinkHistory} from '../src/mining/seekerLinkHistory';
import {captureMiningSeekerEnrollment} from '../src/mining/seekerMiningEnrollment';
import {withSeekerMiningAbsenceFixture as fixture,ABSENCE_WORLD as W} from './fixtures/seekerMiningAbsence';
afterEach(()=>vi.unstubAllEnvs());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;
const clone=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Json;

describe('committed-marker Seeker absence interval (zero authority)',()=>{
 it('admits the coverage-order unlinked identity prospectively where the legacy gate and enrollment cannot',()=>fixture(async f=>{
  await f.close();
  const p=await f.read();
  expect(p).toMatchObject({version:1,purpose:'seeker_absence_interval',wallet:f.wallet,day:W.day,startsAt:'2020-01-02T00:00:00.000Z',endsAt:'2020-01-03T00:00:00.000Z',
   marker:{startedAt:'2020-01-01T02:00:00.000000Z',coverageStartedAt:'2020-01-01T00:00:00.000000Z'},birth:{wallet:f.wallet,createdAt:'2020-01-01T01:00:00.000000Z',observedAt:'2020-01-01T01:00:00.000000Z'},
   player:{wallet:f.wallet,created_at:'2020-01-01T01:00:00.000000Z'},link:null,bonusAuthorized:false,eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false});
  expect(p.marker.sourceSeal).toMatch(/^[0-9a-f]{64}$/);expect(p.observedAt).toBe('2020-01-04T00:00:00.000000Z');
  // The captured birth is the original journal INSERT, committed BEFORE the marker's floor: the exact case the legacy gate refuses.
  expect(BigInt(p.birth.eventId)<=BigInt(p.marker.birthEventFloor)).toBe(true);
  expect(p.events.map(e=>[e.sourceTable,e.operation])).toEqual([['players','INSERT']]);expect(p.events[0]!.id).toBe(p.birth.eventId);
  const [state]=await f.conn.sql`select encode(sha256(convert_to(record::text,'UTF8')),'hex') seal from mining_seeker_enrollment_contract where singleton`;expect(p.marker.sourceSeal).toBe(state!.seal);
  await expect(readMiningSeekerLinkHistory(f.conn.db,f.request)).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
  await expect(captureMiningSeekerEnrollment(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  // Pure providerless replay of the retained bytes; frozen; readable while paused.
  expect(Object.isFrozen(p)&&Object.isFrozen(p.marker)&&Object.isFrozen(p.events)).toBe(true);
  expect(validateMiningSeekerAbsenceIntervalEvidence(clone(p))).toEqual(p);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await f.read()).toEqual(p);
 }),30_000);

 it.each([['precoverage',{preCoverageBirth:true}],['post-marker',{beforeMarkerBirth:false}]] as const)('%s birth: a precoverage identity never masquerades; a post-marker birth reads too',async(kind,options)=>fixture(async f=>{
  await f.close();
  if(kind==='precoverage')await expect(f.read()).rejects.toMatchObject({name:'MiningSeekerAbsenceError',code:'IDENTITY_COVERAGE_UNAVAILABLE'});
  else{const p=await f.read();expect(BigInt(p.birth.eventId)>BigInt(p.marker.birthEventFloor)).toBe(true);expect(p.link).toBeNull();}
 },{birthAt:W.birthAt,...options}),30_000);

 it.each(['active','revoked','deleted','in-day','pre-marker'] as const)('refuses any link before the end of the day: %s',kind=>fixture(async f=>{
  if(kind==='pre-marker'){await f.clock('2020-01-01T01:30:00Z');await f.link();await f.clock(W.markerAt);await f.initialize();}
  else{await f.clock(kind==='in-day'?'2020-01-02T12:00:00Z':'2020-01-01T03:00:00Z');await f.link();
   if(kind==='revoked'){await f.clock('2020-01-01T04:00:00Z');await f.revoke();}
   if(kind==='deleted'){await f.clock('2020-01-01T04:00:00Z');await f.unlink();}}
  await f.close();
  await expect(f.read()).rejects.toMatchObject({name:'MiningSeekerAbsenceError',code:'COVERAGE_UNAVAILABLE'});
 },{marker:kind!=='pre-marker'}),30_000);

 it('admits only an exact post-day chain that starts from no link and matches the live row',()=>fixture(async f=>{
  await f.clock('2020-01-03T10:00:00Z');await f.link();
  await f.close();
  const linked=await f.read();expect(linked.link).toBeNull();
  expect(linked.events.map(e=>[e.sourceTable,e.operation])).toEqual([['players','INSERT'],['seeker_links','INSERT']]);
  expect(linked.events[1]).toMatchObject({beforeState:null,afterState:{wallet:f.wallet,seeker_wallet:f.seekerWallet,sgt_mint:f.sgtMint,revoked_at:null},observedAt:'2020-01-03T10:00:00.000000Z'});
  // The day of the link and every later day refuse: the link existed before their end.
  await expect(f.read('2020-01-03')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await f.clock('2020-01-03T11:00:00Z');await f.revoke();await f.close();
  const revoked=await f.read();expect(revoked.events.map(e=>e.operation)).toEqual(['INSERT','INSERT','UPDATE']);
  await f.clock('2020-01-03T12:00:00Z');await f.unlink();await f.close();
  const deleted=await f.read();expect(deleted.events.map(e=>e.operation)).toEqual(['INSERT','INSERT','UPDATE','DELETE']);
  // A live row that the recorded chain does not explain refuses (journal capture bypassed); the barrier itself stays valid.
  await f.conn.sql`alter table seeker_links disable trigger seeker_links_mining_free_capture`;
  try{await f.link();}finally{await f.conn.sql`alter table seeker_links enable trigger seeker_links_mining_free_capture`;}
  await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  expect((await f.read(W.day,f.buyer)).link).toBeNull();
  // Retained bytes still replay purely, but a chain that does not start from no link, is reordered, or claims a pre-end event refuses.
  expect(validateMiningSeekerAbsenceIntervalEvidence(clone(deleted))).toEqual(deleted);
  for(const [reason,mutate] of [
   ['chain starts from an existing link',(v:Json)=>{v.events.splice(1,1);}],
   ['reordered chain',(v:Json)=>{[v.events[1],v.events[2]]=[v.events[2],v.events[1]];}],
   ['duplicated event',(v:Json)=>{v.events.push({...v.events[3]});}],
   ['pre-end claim',(v:Json)=>{v.events[1].observedAt='2020-01-02T23:59:59.999999Z';}],
   ['link claimed at end',(v:Json)=>{v.link={wallet:f.wallet,seekerWallet:f.seekerWallet,sgtMint:f.sgtMint,revokedAt:null};}],
   ['chain moved to another wallet',(v:Json)=>{v.events[2].afterState.wallet=f.buyer;}],
   ['recorded time stepping back inside the chain',(v:Json)=>{v.events[3].observedAt='2020-01-03T10:30:00.000000Z';}],
   ['committed floor covering the first link event',(v:Json)=>{v.marker.birthEventFloor=v.events[1].id;}],
  ] as const){const copy=clone(deleted);mutate(copy);expect(()=>validateMiningSeekerAbsenceIntervalEvidence(copy),reason).toThrow();}
 }),30_000);

 it('binds the committed floor: a forward-clocked link before the marker is never a later first link',()=>fixture(async f=>{
  // Link journaled BEFORE the marker with a clock stepped past the day's end, then the marker committed at a regressed clock.
  await f.clock('2020-01-03T10:00:00Z');await f.link();
  await f.clock(W.markerAt);await f.initialize();await f.close();
  const [floor]=await f.conn.sql`select birth_event_floor::text floor from mining_seeker_link_coverage where id`;
  const [event]=await f.conn.sql`select id::text id from mining_free_cohort_events where wallet=${f.wallet} and source_table='seeker_links'`;
  expect(BigInt(event!.id)<=BigInt(floor!.floor)).toBe(true);
  await expect(f.read('2020-01-02')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await expect(f.read('2020-01-03')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 },{marker:false}),30_000);

 it('refuses a post-day claim that commit order contradicts (clock stepped forward, then back)',()=>fixture(async f=>{
  // The wallet's link is journaled with a post-day time, but a later-committed journal row still carries a pre-end time.
  await f.clock('2020-01-03T10:00:00Z');await f.link();
  await f.clock('2020-01-02T12:00:00Z');await f.link(f.buyer,f.key(),f.key());
  await f.close();
  await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }),30_000);

 it('refuses identity mutation before or after the day, even when restored, and a re-created identity',()=>fixture(async f=>{
  await f.clock('2020-01-01T05:00:00Z');await f.conn.sql`update players set created_at='2020-01-01T01:30:00Z' where wallet=${f.wallet}`;
  await f.conn.sql`update players set created_at=${W.birthAt} where wallet=${f.wallet}`;
  await f.close();await expect(f.read()).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await f.clock('2020-01-01T06:00:00Z');await f.conn.sql`delete from players where wallet=${f.buyer}`;await f.conn.sql`insert into players(wallet,created_at) values(${f.buyer},${W.birthAt})`;
  await f.close();await expect(f.read(W.day,f.buyer)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }),30_000);

 it('requires a marker strictly before the day and a closed day; the following day qualifies',()=>fixture(async f=>{
  await f.clock('2020-01-02T12:00:00Z');await expect(f.read()).rejects.toMatchObject({code:'DAY_OPEN'});
  await f.close();
  await expect(f.read('2020-01-02')).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  expect((await f.read('2020-01-03')).marker.startedAt).toBe('2020-01-02T12:00:00.000000Z');
 },{markerAt:'2020-01-02T12:00:00Z'}),30_000);

 it('fails closed on every forged or foreign replay field',()=>fixture(async f=>{
  await f.close();const p=await f.read();
  const cases:[string,(v:Json)=>void][]=[
   ['foreign wallet',v=>{v.wallet=f.buyer;v.birth.wallet=f.buyer;v.player.wallet=f.buyer;}],
   ['wrong day',v=>{v.day='2020-01-03';}],
   ['day before the marker',v=>{v.day='2020-01-01';v.startsAt='2020-01-01T00:00:00.000Z';v.endsAt='2020-01-02T00:00:00.000Z';}],
   ['open day claimed',v=>{v.observedAt='2020-01-02T12:00:00.000000Z';}],
   ['marker after the day',v=>{v.marker.startedAt='2020-01-02T12:00:00.000000Z';}],
   ['precoverage birth claimed',v=>{v.birth.createdAt='2019-12-31T00:00:00.000000Z';v.player.created_at='2019-12-31T00:00:00.000000Z';v.events[0].afterState.created_at='2019-12-31T00:00:00.000000Z';}],
   ['birth not matching the live player',v=>{v.player.created_at='2020-01-01T01:00:01.000000Z';}],
   ['birth not matching its event',v=>{v.birth.eventId=String(BigInt(v.birth.eventId)+1n);}],
   ['second identity event',v=>{v.events.push({...v.events[0],id:String(BigInt(v.events[0].id)+1n),operation:'UPDATE',beforeState:v.events[0].afterState});}],
   ['injected pre-day link',v=>{v.events.push({id:String(BigInt(v.events[0].id)+1n),wallet:f.wallet,observedAt:'2020-01-01T03:00:00.000000Z',sourceTable:'seeker_links',sourceId:f.wallet,operation:'INSERT',beforeState:null,afterState:{wallet:f.wallet,seeker_wallet:f.seekerWallet,sgt_mint:f.sgtMint,revoked_at:null}});}],
   ['link non-null',v=>{v.link={wallet:f.wallet,seekerWallet:f.seekerWallet,sgtMint:f.sgtMint,revokedAt:null};}],
   ['recorded truncate statement for the wallet',v=>{v.events.push({id:String(BigInt(v.events[0].id)+1n),wallet:f.wallet,observedAt:'2020-01-01T01:30:00.000000Z',sourceTable:'seeker_links',sourceId:'truncate',operation:'TRUNCATE',beforeState:null,afterState:null});}],
   ['authority claimed',v=>{v.bonusAuthorized=true;}],
   ['eligibility claimed',v=>{v.eligibilityAuthorized=true;}],
   ['extra key',v=>{v.identity={birthEventId:'1'};}],
   ['seal malformed',v=>{v.marker.sourceSeal='x';}],
   ['floor malformed',v=>{v.marker.birthEventFloor='-1';}],
   ['purpose changed',v=>{v.purpose='seeker_enrollment_interval';}],
   ['version changed',v=>{v.version=2;}],
  ];
  for(const [reason,mutate] of cases){const copy=clone(p);mutate(copy);expect(()=>validateMiningSeekerAbsenceIntervalEvidence(copy),reason).toThrow();}
  await expect(readMiningSeekerAbsenceInterval(f.conn.db,{wallet:'not-a-key',day:W.day})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(readMiningSeekerAbsenceInterval(f.conn.db,{wallet:f.wallet,day:W.day,bonusBps:1} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.conn.db.transaction(tx=>readMiningSeekerAbsenceInterval(tx as unknown as Db,{wallet:f.wallet,day:W.day}))).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.read(W.day,f.key())).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
 }),30_000);

 it('is BUSY behind a pending source writer and refuses changed source authority',()=>fixture(async f=>{
  await f.close();
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{ready=r}),gate=new Promise<void>(r=>{release=r});
  const writer=f.conn.sql.begin(async tx=>{await tx`lock table public.seeker_links in row exclusive mode`;ready();await gate;});
  try{await started;await expect(f.read()).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  expect((await f.read()).link).toBeNull();
  // Row security on any locked source relation is refused even though the sealed contract still validates.
  for(const table of ['seeker_links','mining_free_cohort_events','players']){
   await f.conn.sql.unsafe(`alter table public.${table} enable row level security`);
   await expect(f.read(),table+' rls').rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
   await f.conn.sql.unsafe(`alter table public.${table} force row level security`);
   await expect(f.read(),table+' force rls').rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
   await f.conn.sql.unsafe(`alter table public.${table} no force row level security;alter table public.${table} disable row level security`);
   expect((await f.read()).link,table+' restored').toBeNull();
  }
  await f.conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '2020-01-04'::timestamptz $$`);
  await expect(f.read()).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);

 it('refuses inheritance children of the source relations (unguarded rows could pose as journal, birth or marker)',()=>fixture(async f=>{
  await f.close();expect((await f.read()).link).toBeNull();
  for(const table of ['mining_free_cohort_events','players','mining_seeker_link_coverage']){
   await f.conn.sql.unsafe(`create table public.absence_child () inherits (public.${table})`);
   await expect(f.read(),table+' child').rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
   await f.conn.sql.unsafe(`drop table public.absence_child`);
   // PostgreSQL may keep relhassubclass set after the child is dropped; that errs toward refusing.
   const [flag]=await f.conn.sql`select relhassubclass from pg_class where oid=${'public.'+table}::regclass`;
   if(!flag!.relhassubclass)expect((await f.read()).link,table+' restored').toBeNull();
  }
 }),30_000);

 it('a pre-marker TRUNCATE removes rows but never the recorded link: the wallet still refuses',()=>fixture(async f=>{
  await f.clock('2020-01-01T01:30:00Z');await f.link();
  await f.clock('2020-01-01T01:45:00Z');await f.conn.sql`truncate seeker_links`;
  await f.clock(W.markerAt);await f.initialize();await f.close();
  expect(await f.conn.sql`select wallet from seeker_links`).toHaveLength(0);
  const [journal]=await f.conn.sql`select count(*)::int n from mining_free_cohort_events where wallet=${f.wallet} and source_table='seeker_links' and operation='INSERT'`;expect(journal!.n).toBe(1);
  await expect(f.read()).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await expect(f.conn.sql`truncate seeker_links`).rejects.toThrow('MINING_SEEKER_LINK_HISTORY_RETAINED');
 },{marker:false}),30_000);

 it('reads the shape the frozen interface promises and nothing more',()=>fixture(async f=>{
  await f.close();const p:MiningSeekerAbsenceIntervalEvidence=await f.read();
  expect(Object.keys(p).sort()).toEqual(['allocationAuthorized','birth','bonusAuthorized','day','eligibilityAuthorized','endsAt','events','link','marker','observedAt','player','publicationAuthorized','purpose','startsAt','version','wallet']);
  expect(Object.keys(p.marker).sort()).toEqual(['birthEventFloor','coverageStartedAt','sourceSeal','startedAt']);
  expect(Object.keys(p.birth).sort()).toEqual(['createdAt','eventId','observedAt','wallet']);
  expect(randomUUID()).not.toBe(p.birth.eventId);
 }),30_000);
});
