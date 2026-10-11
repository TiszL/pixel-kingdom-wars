import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction } from '../src/ledger';
import { grantGems,fundGemsRewardBudget } from '../src/game/gemsGrants';
import { evaluateInitialFreeMiningScore } from '../src/mining/initialFreeScore';
import { withInitialFreeMiningFixture as fixture } from './fixtures/initialFreeMining';

describe('initial-free score from completed server evidence',()=>{
 it('scores fourteen distinct paid days with qualified PvE, growing wallet XP and completed facilities',async()=>fixture(async f=>{
  const expected=[];
  for(let d=1;d<=14;d++){
   const day=`2020-01-${String(d).padStart(2,'0')}`;const r=await f.reserve(day);
   for(let raid=0;raid<3;raid++)await f.battle(day,false,`${day}T12:0${raid}:00Z`);
   expected.push({day,r});
  }
  await f.clock(null);await f.collect('2019-12-31');
  const results=[];
  for(let i=0;i<expected.length;i++){
   const {day,r}=expected[i]!;await f.collect(day);const result=await f.evaluate(day);results.push(result);
   expect(result).toMatchObject({wallet:f.wallet,baseId:f.baseId,day,policyVersion:1,eligibleUnits:1,
    reason:'qualified',recordedXp:(i+1)*300,activityBps:10000,usefulChainBps:0,
    progressionBps:833,baseMultiplierBps:3124,retentionBps:10000,reservationIds:[r.receipt.id],allocationReady:false,publicationAuthorized:false});
   const xp=Math.floor((i+1)*300*10000/4200),walletScore=Math.floor((20000+xp)/4);
   expect(result.walletScoreBps).toBe(walletScore);expect(result.baseScoreBps).toBe(Math.floor(walletScore*3124/10000));
   expect(result.weight).toBe(String(result.baseScoreBps));
  }
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  for(let i=0;i<expected.length;i++)expect(await f.evaluate(expected[i]!.day)).toEqual(results[i]);
  expect((await f.conn.sql`select count(*)::int n from mining_ingot_releases`)[0]!.n).toBe(0);
  expect((await f.conn.sql`select sum(points)::int xp from mining_wallet_experience_awards`)[0]!.xp).toBe(4200);
 }),60_000);
 it('refuses missing XP days, unknown coverage and caller-supplied score or eligibility',async()=>fixture(async f=>{
  await f.reserve('2020-01-02');await f.battle('2020-01-02');await f.clock(null);await f.collect('2020-01-02');
  await expect(f.evaluate('2020-01-02')).rejects.toMatchObject({code:'XP_COVERAGE_UNAVAILABLE'});
  for(const extra of [{score:10000},{eligible:true},{now:'2020-01-03'},{wallet:'1'.repeat(10000)}])await expect(evaluateInitialFreeMiningScore(f.conn.db,{wallet:f.wallet,day:'2020-01-02',policyVersion:1,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await f.collect('2019-12-31');await f.collect('2020-01-01');expect((await f.evaluate('2020-01-02')).reason).toBe('qualified');
 }),30_000);
 it('keeps resource contribution and current qualified play mandatory even after XP has been earned',async()=>fixture(async f=>{
  await f.battle('2020-01-01');await f.reserve('2020-01-02');await f.clock(null);
  await f.collect('2019-12-31');await f.collect('2020-01-01');await f.collect('2020-01-02');
  expect(await f.evaluate('2020-01-01')).toMatchObject({reason:'no_contribution',eligibleUnits:0,weight:'0'});
  expect(await f.evaluate('2020-01-02')).toMatchObject({reason:'no_qualified_activity',eligibleUnits:0,weight:'0',recordedXp:100});
 }),30_000);
 it('does not count unfinished first construction or backdate later completion',async()=>fixture(async f=>{
  const [forge]=await f.conn.sql`select id from buildings where base_id=${f.baseId} and type='goldforge'`;
  await f.clock('2020-01-01T08:00:00Z');const job=randomUUID();await f.conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${job},${f.wallet},${f.baseId},${forge!.id},'build','2020-01-01T08:00:00Z','2020-01-01T09:00:00Z')`;
  await f.reserve('2020-01-01');await f.battle('2020-01-01');await f.clock(null);await f.collect('2019-12-31');await f.collect('2020-01-01');
  const result=await f.evaluate('2020-01-01');expect(result).toMatchObject({reason:'development_required',eligibleUnits:0,weight:'0'});
  await f.clock('2020-01-02T12:00:00Z');await f.conn.sql`update builder_jobs set completed_at='2020-01-02T12:00:00Z' where id=${job}`;
  await f.clock(null);expect(await f.evaluate('2020-01-01')).toEqual(result);
 }),30_000);
 it('retains the last qualified score for48 hours then decays without paying idle days',async()=>fixture(async f=>{
  await f.battle('2020-01-01');await f.clock(null);await f.collect('2019-12-31');
  const results=[];
  for(let day=1;day<=9;day++){const key=`2020-01-${String(day).padStart(2,'0')}`;await f.collect(key);results.push(await f.evaluate(key));}
  expect(results[0]!.retentionBps).toBe(10000);expect(results[1]!.retentionBps).toBe(10000);
  expect(results[2]!.retentionBps).toBe(9000);expect(results[3]!.retentionBps).toBe(7000);
  expect(results[4]!.retentionBps).toBe(5000);expect(results[7]!.retentionBps).toBe(0);
  for(const r of results.slice(1)){expect(r.activityBps).toBe(3333);expect(r.reason).toBe('no_qualified_activity');expect(r.weight).toBe('0');}
 }),60_000);

 it('refreshes retention from a fourth qualified victory even though the daily XP cap is exhausted',async()=>fixture(async f=>{
  for(const hour of ['00','01','02','23'])await f.battle('2020-01-01',false,`2020-01-01T${hour}:00:00Z`);
  await f.clock(null);for(const day of ['2019-12-31','2020-01-01','2020-01-02','2020-01-03'])await f.collect(day);
  expect(await f.evaluate('2020-01-03')).toMatchObject({recordedXp:300,activityBps:10000,retentionBps:9916,reason:'no_qualified_activity',weight:'0'});
 }),30_000);
 it('names the first full XP day and excludes a partial source-coverage birth day without backfill',async()=>fixture(async f=>{
  await f.battle('2020-01-01');await f.clock(null);await f.collect('2020-01-01');
  expect(await f.evaluate('2020-01-01')).toMatchObject({recordedXp:100,experienceCoverage:{fromDay:'2020-01-01',throughDay:'2020-01-01',partialBirthDayExcluded:true}});
 },{sourceCoverageAt:'2019-12-31T06:00:00Z',birthAt:'2019-12-31T12:00:00Z'}),30_000);

 it('excludes E3a late credits and refuses unknown origins after source deletion without rewriting an earlier day',async()=>fixture(async f=>{
  for(const day of ['2020-01-01','2020-01-02','2020-01-03']){await f.reserve(day);await f.battle(day);}
  await f.clock(null);for(const day of ['2019-12-31','2020-01-01','2020-01-02','2020-01-03'])await f.collect(day);
  const original=await f.evaluate('2020-01-01');expect(original.reason).toBe('qualified');
  const sys=await bootstrapSystemAccounts(f.conn.db),gems=await getOrCreatePlayerAccount(f.conn.db,f.wallet,'player_gems'),keep=await getOrCreatePlayerAccount(f.conn.db,f.wallet,'player_keep');
  await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.score.keep',entries:[{account:sys.keep_genesis,delta:-20n},{account:keep.id,delta:20n}]});
  const mint=(type:string)=>postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type,metadata:{wallet:f.wallet,reason:'keep_conversion',gems:'10'},entries:[
   {account:keep.id,delta:-10n},{account:sys.emission_pool,delta:10n},{account:sys.gems_mint,delta:-10n},{account:gems.id,delta:10n},
  ]});
  await f.clock('2020-01-02T18:00:00Z');const late=await mint('gems.late_credit');await f.clock(null);
  const excluded=await f.evaluate('2020-01-02');expect(excluded).toMatchObject({reason:'cohort_invalid',eligibleUnits:0,usefulChainBps:null,weight:'0'});
  // Owner edit with plain DELETEs and no trigger paused (0302, K-night-E1, made them real);
  // the stronger 0161 rule still refuses removing the origin transaction while its positive Gems entry exists.
  await expect(f.conn.sql`delete from ledger_transactions where id=${late.transaction.id}`).rejects.toThrow('MINING_FREE_ATTRIBUTION_IMMUTABLE');
  await f.conn.sql.begin(async tx=>{await tx`delete from ledger_entries where txn_id=${late.transaction.id}`;await tx`delete from ledger_transactions where id=${late.transaction.id}`;});
  expect(await f.evaluate('2020-01-02')).toEqual(excluded);expect(await f.evaluate('2020-01-01')).toEqual(original);
  await f.clock('2020-01-03T18:00:00Z');const unknown=await mint('future.credit');await f.conn.sql.begin(tx=>tx`delete from ledger_entries where txn_id=${unknown.transaction.id}`);
  await f.clock(null);await expect(f.evaluate('2020-01-03')).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }),30_000);
 it('allows a canonically backed welcome grant while keeping it out of the useful-chain score',async()=>fixture(async f=>{
  const sys=await bootstrapSystemAccounts(f.conn.db);await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.score.budget',entries:[{account:sys.keep_genesis,delta:-10n},{account:sys.emission_pool,delta:10n}]});
  await fundGemsRewardBudget(f.conn.db,10n,randomUUID());await grantGems(f.conn.db,{wallet:f.wallet,gems:10n,reason:'welcome'});
  await f.reserve('2020-01-01');await f.battle('2020-01-01');await f.clock(null);await f.collect('2019-12-31');await f.collect('2020-01-01');
  expect(await f.evaluate('2020-01-01')).toMatchObject({reason:'qualified',usefulChainBps:0,eligibleUnits:1,gemsOriginIds:[expect.any(String)]});
 }),30_000);

});
