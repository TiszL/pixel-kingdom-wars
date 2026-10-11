import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {describe,it,expect,vi} from 'vitest';
import {captureExistingMiningWallet,readExistingMiningWalletBaseline,lookupExistingMiningWalletBaseline,readExistingMiningWalletInterval,readExistingMiningWalletIntervalInTransaction,replayExistingMiningWalletInterval} from '../src/mining/existingMiningWallet';
import {readExistingMiningWalletActivity,readMiningWalletActivity} from '../src/mining/walletActivity';
import {withExistingMiningWalletFixture as fixture,resealExistingMiningWalletFixtureClock} from './fixtures/existingMiningWallet';
const request=(f:{wallet:string},id:string,day='2020-01-04')=>({wallet:f.wallet,baselineId:id,day});
describe('explicit existing-wallet baseline and complete original activity',()=>{
 it('commits a unique present identity with unknown nonzero opening Gems and next-day eligibility',()=>fixture(async f=>{
  const b=await f.capture();await f.close();
  expect(b).toMatchObject({wallet:f.wallet,firstEligibleDay:'2020-01-04',firstActivityDay:'2020-01-01',player:{wallet:f.wallet,createdAt:'2019-12-01T00:00:00.000000Z'}});
  expect(await f.conn.sql`select id from mining_free_cohort_events where wallet=${f.wallet} and source_table='players'`).toHaveLength(0);
  expect((await f.conn.sql`select balance::text balance from accounts where id=${f.gems.id}`)[0]).toEqual({balance:'50'});
  expect(await lookupExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet,day:'2020-01-03'})).toBeNull();
  expect(await lookupExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet,day:'2020-01-04'})).toBe(b.id);
  const interval=await readExistingMiningWalletInterval(f.conn.db,request(f,b.id));
  expect(interval).toMatchObject({historicalBirth:'unknown',openingGems:'unknown',identityEvents:[],eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false});
  expect(interval.baseline).not.toHaveProperty('birthEventId');expect(replayExistingMiningWalletInterval(interval)).toEqual(interval);
  await captureExistingMiningWallet(f.conn.db,f.wallet);expect(await readExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet})).toEqual(b);
  expect(await f.conn.sql`select id from mining_existing_wallet_baselines`).toHaveLength(1);
  await expect(resealExistingMiningWalletFixtureClock(f.conn)).rejects.toThrow('empty disposable');
 }));
 it('preserves every original covered XP award and intervening empty day before baseline',()=>fixture(async f=>{
  const a=await f.raid('2020-01-01');await f.seal('2020-01-01');await f.seal('2020-01-02');
  const b=await f.capture();const c=await f.raid('2020-01-04');await f.seal('2020-01-03');await f.seal('2020-01-04');await f.close();
  const value=await readExistingMiningWalletActivity(f.conn.db,{...request(f,b.id),policyVersion:1});
  expect(value.recordedXp).toBe(200);expect(value.qualifiedRaids.map(r=>r.raidId)).toEqual([a.id,c.id]);
  expect(value.days.map(d=>[d.day,d.awardedXp])).toEqual([['2020-01-01',100],['2020-01-02',0],['2020-01-03',0],['2020-01-04',100]]);
  expect(value.experienceCoverage.fromDay).toBe('2020-01-01');expect(value.identity).toMatchObject({kind:'committed-existing-wallet',baselineId:b.id,interval:{baseline:b}});
  await expect(readMiningWalletActivity(f.conn.db,{wallet:f.wallet,day:'2020-01-04',policyVersion:1})).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await readExistingMiningWalletActivity(f.conn.db,{...request(f,b.id),policyVersion:1})).toEqual(value);
 }));
 it('holds a missing empty day or XP journal instead of resetting history at baseline',()=>fixture(async f=>{
  await f.raid('2020-01-01');await f.seal('2020-01-01');const b=await f.capture();await f.seal('2020-01-03');await f.seal('2020-01-04');await f.close();
  const input={...request(f,b.id),policyVersion:1};
  await expect(readExistingMiningWalletActivity(f.conn.db,input)).rejects.toMatchObject({code:'DAY_COVERAGE_UNAVAILABLE'});
  expect(await f.conn.sql`select day from mining_wallet_experience_days where day='2020-01-02'`).toHaveLength(0);
  await f.activity('2020-01-02');await expect(readExistingMiningWalletActivity(f.conn.db,input)).rejects.toMatchObject({code:'DAY_COVERAGE_UNAVAILABLE'});
  await f.seal('2020-01-02');expect((await readExistingMiningWalletActivity(f.conn.db,input)).recordedXp).toBe(100);
 }));
 it('retains microseconds, excludes partial coverage and does not promote an enrollment-day fragment',()=>fixture(async f=>{
  const b=await f.capture('2020-01-03T00:00:00.000001Z');expect(b.firstActivityDay).toBe('2020-01-02');expect(b.firstEligibleDay).toBe('2020-01-04');await f.close();
  await expect(readExistingMiningWalletInterval(f.conn.db,request(f,b.id,'2020-01-03'))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  const v=await f.conn.db.transaction(async tx=>{await tx.execute(sql`set local timezone='Asia/Tbilisi'`);return readExistingMiningWalletIntervalInTransaction(tx,request(f,b.id));});
  expect(v.baseline.observedAt).toBe('2020-01-03T00:00:00.000001Z');expect(v.baseline.activityCoverageStartedAt).toBe('2020-01-01T00:00:00.000001Z');
  await f.clock('2020-01-04T23:59:59.999999Z');await expect(readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'DAY_OPEN'});
 },{activityCoverageAt:'2020-01-01T00:00:00.000001Z'}));
 it('holds identity out-and-back mutations even when their observations are backdated before the baseline',()=>fixture(async f=>{
  const b=await f.capture();await f.clock('2020-01-02T00:00:00Z');
  await f.conn.sql`update players set created_at='2019-12-02T00:00:00Z' where wallet=${f.wallet}`;
  await f.conn.sql`update players set created_at='2019-12-01T00:00:00Z' where wallet=${f.wallet}`;await f.close();
  await expect(readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await expect(lookupExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet,day:'2020-01-04'})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await expect(captureExistingMiningWallet(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  expect(await f.conn.sql`select id from mining_existing_wallet_baselines`).toHaveLength(1);
 }));
 it('refuses changed current identity, coverage, canonical function and disabled capture sources',()=>fixture(async f=>{
  const b=await f.capture();await f.close();
  for(const statement of [
   `update players set created_at='2019-11-01T00:00:00Z' where wallet='${f.wallet}'`,
   `update playtest_activity_coverage set started_at='2020-01-02T00:00:00Z' where key='authoritative-v1'`,
   'alter table public.ledger_entries disable trigger ledger_entries_mining_gems_flow_capture',
   'alter table public.mining_gems_flow_events enable row level security',
   'alter table public.mining_free_cohort_events force row level security',
   'create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select clock_timestamp() $$',
  ])await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await readExistingMiningWalletIntervalInTransaction(tx,request(f,b.id));throw Error('must refuse');})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  expect((await readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).baseline).toEqual(b);
 }));
 it('never converts a missing current coverage marker into an absent private baseline',()=>fixture(async f=>{
  const b=await f.capture();await f.close();await f.conn.sql`delete from playtest_activity_coverage where key='authoritative-v1'`;
  await expect(readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await expect(lookupExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet,day:'2020-01-04'})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }));
 it('requires fresh read-committed owner capture and immutable private rows',()=>fixture(async f=>{
  await f.clock('2020-01-03T12:00:00Z');
  await expect(f.conn.sql.begin(async tx=>{await tx`set transaction isolation level repeatable read`;await tx`insert into mining_existing_wallet_baselines(wallet) values(${f.wallet})`;})).rejects.toThrow('READ_COMMITTED');
  await expect(f.conn.sql.begin(async tx=>{await tx`update players set created_at=created_at where wallet=${f.wallet}`;await tx`insert into mining_existing_wallet_baselines(wallet) values(${f.wallet})`;})).rejects.toThrow('FRESH_TRANSACTION');
  await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql`insert into mining_existing_wallet_baselines(wallet) values(${f.wallet})`);const [row]=await tx.execute<{id:string}>(sql`select id from mining_existing_wallet_baselines where wallet=${f.wallet}`);await readExistingMiningWalletIntervalInTransaction(tx,request(f,row!.id));})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  expect(await f.conn.sql`select id from mining_existing_wallet_baselines`).toHaveLength(0);
  const b=await f.capture();await f.close();
  // 2026-10-10 (CI 37503885235): 0277 (zero-opening Gems) references baselines from mining_gems_zero_openings, and
  // PostgreSQL refuses a plain TRUNCATE of a referenced table in its foreign-key preflight, before any BEFORE
  // TRUNCATE trigger. Keep that refusal, and truncate WITH the dependent witness table so the immutability
  // trigger itself is still reached (same rule as the Gems flow source-retention case).
  await expect(f.conn.sql.unsafe('truncate mining_existing_wallet_baselines')).rejects.toThrow(/cannot truncate a table referenced in a foreign key constraint/);
  for(const stmt of ['delete from mining_existing_wallet_baselines','truncate mining_existing_wallet_baselines cascade','update mining_existing_wallet_baselines set first_eligible_day=first_eligible_day-1','delete from mining_existing_wallet_contract','truncate mining_existing_wallet_contract'])await expect(f.conn.sql.unsafe(stmt)).rejects.toThrow(/IMMUTABLE/);
  const role='baseline_'+randomUUID().replaceAll('-','');await f.conn.sql.unsafe(`create role ${role}`);
  try{await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_existing_wallet_baselines(wallet) values(${f.wallet})`;})).rejects.toMatchObject({code:'42501'});}finally{await f.conn.sql.unsafe(`drop role ${role}`);}
  expect((await readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).baseline).toEqual(b);
 }));
 it('fences a concurrent source writer before sampling and capture blocks a subsequent writer',()=>fixture(async f=>{
  const b=await f.capture();await f.close();let ready!:()=>void,release!:()=>void;const begun=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
  const writing=f.conn.sql.begin(async tx=>{await tx`lock table accounts in row exclusive mode`;ready();await gate;});
  try{await begun;await expect(readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'BUSY'});await expect(captureExistingMiningWallet(f.conn.db,f.wallet)).rejects.toMatchObject({code:'BUSY'});}finally{release();await writing;}
  await f.conn.db.transaction(async tx=>{await readExistingMiningWalletIntervalInTransaction(tx,request(f,b.id));await expect(f.conn.sql.begin(t=>t`lock table players in row exclusive mode nowait`)).rejects.toMatchObject({code:'55P03'});});
 }));
 it('rejects caller-supplied authority, copied evidence grafts and clock regression without changing baseline',()=>fixture(async f=>{
  const b=await f.capture();await f.close();const value=await readExistingMiningWalletInterval(f.conn.db,request(f,b.id));
  for(const change of [(v:typeof value)=>{v.wallet=f.buyer;},(v:typeof value)=>{v.baselineId=randomUUID();},(v:typeof value)=>{v.baseline.firstActivityDay='2020-01-04';},(v:typeof value)=>{v.day='2020-01-03';},(v:typeof value)=>{(v as unknown as {openingGems:string}).openingGems='0';},(v:typeof value)=>{(v.baseline.player as unknown as Record<string,unknown>).birthEventId='1';}]){const v=structuredClone(value);change(v);expect(()=>replayExistingMiningWalletInterval(v)).toThrow();}
  await expect(readExistingMiningWalletInterval(f.conn.db,{...request(f,b.id),openingGems:0})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await f.clock('2020-01-02T00:00:00Z');await expect(captureExistingMiningWallet(f.conn.db,f.wallet)).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});await expect(readExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  await f.close();expect((await readExistingMiningWalletInterval(f.conn.db,request(f,b.id))).baseline).toEqual(b);
 }));
});
